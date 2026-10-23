import { gunzipSync, gzipSync } from "node:zlib";
import { db } from "../db.js";
import { isTradingDay } from "../providers/alpaca-calendar.js";
import { addDays } from "../estimates/store.js";
import type { DefKind } from "../scandef/schema.js";
import { onDefinitionChange } from "../scandef/store.js";
import type { TestResult } from "./result.js";

// Scan Lab's test data: the inputs each pass scored (kept 10 trading days), replay results, and the live shadow.

export const INPUT_TRADING_DAYS = 10;

db.exec(`
CREATE TABLE IF NOT EXISTS scan_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('stock','option')),
  pass_at TEXT NOT NULL,
  day TEXT NOT NULL,
  definition TEXT NOT NULL,
  data BLOB NOT NULL,
  UNIQUE (kind, pass_at)
);
CREATE INDEX IF NOT EXISTS scan_inputs_day ON scan_inputs (kind, day);
CREATE TABLE IF NOT EXISTS scan_test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  def_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  pass_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  live TEXT NOT NULL,
  draft TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_test_results_def ON scan_test_results (def_id, id);
CREATE TABLE IF NOT EXISTS scan_shadow (
  kind TEXT PRIMARY KEY,
  def_id INTEGER NOT NULL,
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_shadow_passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  def_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  live TEXT NOT NULL,
  draft TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_shadow_passes_def ON scan_shadow_passes (def_id, id);
`);

// ---- input snapshots ----

export function saveInput(kind: DefKind, passAt: string, day: string, definition: string, payload: unknown): void {
  db.prepare("INSERT OR REPLACE INTO scan_inputs (kind, pass_at, day, definition, data) VALUES (?, ?, ?, ?, ?)").run(kind, passAt, day, definition, gzipSync(JSON.stringify(payload)));
}

type InputRow = { pass_at: string; definition: string; data: Buffer };

/** A stored pass: the latest, or the one at `passAt`. Null when none. */
export function loadInput<T>(kind: DefKind, source: "latest" | string): { passAt: string; definition: string; payload: T } | null {
  const r = (source === "latest"
    ? db.prepare("SELECT pass_at, definition, data FROM scan_inputs WHERE kind = ? ORDER BY pass_at DESC LIMIT 1").get(kind)
    : db.prepare("SELECT pass_at, definition, data FROM scan_inputs WHERE kind = ? AND pass_at = ?").get(kind, source)) as InputRow | undefined;
  return r ? { passAt: r.pass_at, definition: r.definition, payload: JSON.parse(gunzipSync(r.data).toString()) as T } : null;
}

/** The passes that can be replayed, newest first. */
export function listInputs(kind: DefKind, limit = 200): Array<{ passAt: string; definition: string }> {
  return (db.prepare("SELECT pass_at, definition FROM scan_inputs WHERE kind = ? ORDER BY pass_at DESC LIMIT ?").all(kind, limit) as Array<{ pass_at: string; definition: string }>).map((r) => ({ passAt: r.pass_at, definition: r.definition }));
}

/** Oldest day kept: `today` counts as the first of the last INPUT_TRADING_DAYS trading days. */
export function keepFrom(today: string, tradingDays = INPUT_TRADING_DAYS): string {
  let day = today;
  let n = isTradingDay(day) ? 1 : 0;
  while (n < tradingDays) {
    day = addDays(day, -1);
    if (isTradingDay(day)) n++;
  }
  return day;
}

/** Drops snapshots and shadow passes older than 10 trading days. */
export function pruneInputs(today: string): number {
  const from = keepFrom(today);
  const n = db.prepare("DELETE FROM scan_inputs WHERE day < ?").run(from).changes;
  db.prepare("DELETE FROM scan_shadow_passes WHERE substr(at, 1, 10) < ?").run(from);
  return n;
}

// ---- replay results ----

export type StoredTest = { id: number; defId: number; kind: DefKind; source: "replay"; passAt: string; createdAt: string; live: TestResult; draft: TestResult };
type TestRow = { id: number; def_id: number; kind: DefKind; source: "replay"; pass_at: string; created_at: string; live: string; draft: string };
const toTest = (r: TestRow): StoredTest => ({ id: r.id, defId: r.def_id, kind: r.kind, source: r.source, passAt: r.pass_at, createdAt: r.created_at, live: JSON.parse(r.live), draft: JSON.parse(r.draft) });

export function saveReplay(defId: number, kind: DefKind, passAt: string, live: TestResult, draft: TestResult): StoredTest {
  const createdAt = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO scan_test_results (def_id, kind, source, pass_at, created_at, live, draft) VALUES (?, ?, 'replay', ?, ?, ?, ?)").run(defId, kind, passAt, createdAt, JSON.stringify(live), JSON.stringify(draft)).lastInsertRowid);
  return { id, defId, kind, source: "replay", passAt, createdAt, live, draft };
}

export function latestReplay(defId: number): StoredTest | null {
  const r = db.prepare("SELECT * FROM scan_test_results WHERE def_id = ? ORDER BY id DESC LIMIT 1").get(defId) as TestRow | undefined;
  return r ? toTest(r) : null;
}

export const replayCount = (defId: number): number => (db.prepare("SELECT COUNT(*) AS n FROM scan_test_results WHERE def_id = ?").get(defId) as { n: number }).n;

// ---- live shadow ----

export type ShadowPass = { at: string; live: TestResult; draft: TestResult };
export type ShadowView = { on: boolean; startedAt: string | null; count: number; /** Newest first. */ passes: ShadowPass[] };

/** The def being shadowed for a kind, or null. */
export function shadowing(kind: DefKind): { defId: number; startedAt: string } | null {
  const r = db.prepare("SELECT def_id, started_at FROM scan_shadow WHERE kind = ?").get(kind) as { def_id: number; started_at: string } | undefined;
  return r ? { defId: r.def_id, startedAt: r.started_at } : null;
}

/** Starts shadowing a draft; any other shadow of the kind stops (at most one per kind). */
export function startShadow(kind: DefKind, defId: number): void {
  db.prepare("INSERT OR REPLACE INTO scan_shadow (kind, def_id, started_at) VALUES (?, ?, ?)").run(kind, defId, new Date().toISOString());
}

export function stopShadow(kind: DefKind): void {
  db.prepare("DELETE FROM scan_shadow WHERE kind = ?").run(kind);
}

export function addShadowPass(defId: number, kind: DefKind, pass: ShadowPass): void {
  db.prepare("INSERT INTO scan_shadow_passes (def_id, kind, at, live, draft) VALUES (?, ?, ?, ?, ?)").run(defId, kind, pass.at, JSON.stringify(pass.live), JSON.stringify(pass.draft));
}

export function shadowView(defId: number, kind: DefKind, limit = 50): ShadowView {
  const s = shadowing(kind);
  const on = s?.defId === defId;
  const rows = db.prepare("SELECT at, live, draft FROM scan_shadow_passes WHERE def_id = ? ORDER BY id DESC LIMIT ?").all(defId, limit) as Array<{ at: string; live: string; draft: string }>;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM scan_shadow_passes WHERE def_id = ?").get(defId) as { n: number }).n;
  return { on, startedAt: on ? s!.startedAt : null, count, passes: rows.map((r) => ({ at: r.at, live: JSON.parse(r.live), draft: JSON.parse(r.draft) })) };
}

/** A shadow pass: the newest, or the one at `at`. */
export function shadowPass(defId: number, at?: string): ShadowPass | null {
  const r = (at
    ? db.prepare("SELECT at, live, draft FROM scan_shadow_passes WHERE def_id = ? AND at = ? ORDER BY id DESC LIMIT 1").get(defId, at)
    : db.prepare("SELECT at, live, draft FROM scan_shadow_passes WHERE def_id = ? ORDER BY id DESC LIMIT 1").get(defId)) as { at: string; live: string; draft: string } | undefined;
  return r ? { at: r.at, live: JSON.parse(r.live), draft: JSON.parse(r.draft) } : null;
}

// A shadow stops when its draft is replaced, discarded or a definition is promoted or rolled back.
onDefinitionChange((e) => stopShadow(e.kind));
