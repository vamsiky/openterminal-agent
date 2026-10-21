import { db } from "../db.js";
import { nyClock } from "../history/scheduler.js";
import { minuteBars } from "../history/store.js";
import { nyInstant } from "../live/session.js";
import type { QuantDeps } from "../scan/contracts.js";
import { refreshStockIdeas, runStockScreen, updateOptionIdeas } from "./ideas.js";
import { optionScores, runOptionScan } from "./option-score.js";
import { heldSymbols } from "./positions.js";
import { compositeMap, latestScorecardDay, runIntradayStockScan, runNightlyScorecards } from "./stock-score.js";
import { resolveUniverse } from "./universe.js";

// Scheduling for the scans, inside the API process:
//   stock-nightly    07:00 and 16:30 ET on weekdays: scorecards for every US stock
//   ideas-screen     right after each nightly: the stock ideas list
//   stock-intraday   every 15 min in the regular session: live rescoring of the universe
//   option-scan      every 5 min in the regular session: option scorecards and ideas
// The session scans run from 09:45 ET (so a holiday shows up as a SPY with no
// minute bars before the first one) to 16:00. Jobs never overlap: one loop
// runs due jobs one after another, and a run that outlasts its slot simply
// makes the next slot late. SCAN_ENABLED=0 turns it all off.

export type JobName = "stock-nightly" | "stock-intraday" | "option-scan" | "ideas-screen";
export const JOB_NAMES: JobName[] = ["stock-nightly", "stock-intraday", "option-scan", "ideas-screen"];

const TICK_MS = 20_000;
/** The stock scan waits this long into its slot for the minute bars to land; the option scan a bit more, for the sweep. */
const STOCK_OFFSET_MS = 20_000;
const OPTION_OFFSET_MS = 90_000;
const NIGHTLY_SLOTS: Array<[number, number]> = [[7, 0], [16, 30]];

db.exec(`
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  symbols INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS scan_runs_job ON scan_runs (job, id);
`);

export type RunRow = { started_at: string; finished_at: string | null; status: string; symbols: number | null; duration_ms: number | null; error: string | null };

/** The latest run of each job. */
export function lastRuns(): Record<string, RunRow> {
  const out: Record<string, RunRow> = {};
  const stmt = db.prepare("SELECT started_at, finished_at, status, symbols, duration_ms, error FROM scan_runs WHERE job = ? ORDER BY id DESC LIMIT 1");
  for (const job of JOB_NAMES) {
    const r = stmt.get(job) as RunRow | undefined;
    if (r) out[job] = r;
  }
  return out;
}

const lastStart = (job: string): number | null => {
  const r = db.prepare("SELECT started_at FROM scan_runs WHERE job = ? ORDER BY id DESC LIMIT 1").get(job) as { started_at: string } | undefined;
  return r ? Date.parse(r.started_at) : null;
};

/** Holdings first, then the rest of the universe by latest option score, then stock composite, then alphabetically. */
export function universeByPriority(): string[] {
  const universe = resolveUniverse();
  const held = new Set(heldSymbols());
  const options = optionScores();
  const comps = compositeMap(universe);
  const byComposite = (a: string, b: string) => (comps.get(b) ?? -1) - (comps.get(a) ?? -1) || a.localeCompare(b);
  const rest = universe.filter((s) => !held.has(s));
  const withOption = rest.filter((s) => options.has(s)).sort((a, b) => options.get(b)! - options.get(a)! || a.localeCompare(b));
  const without = rest.filter((s) => !options.has(s)).sort(byComposite);
  return [...universe.filter((s) => held.has(s)), ...withOption, ...without];
}

let deps: QuantDeps | null = null;
/** The deps given to startQuantJobs, for the status route. */
export const quantDeps = () => deps;

// ---- schedule (pure) ----

const isWeekday = (weekday: string) => weekday !== "Sat" && weekday !== "Sun";

/**
 * Jobs due at `now`. `started(job)` is when the job last started (epoch ms)
 * and `sessionLive()` says whether SPY traded today (asked only from 09:45,
 * to recognise holidays).
 */
export function dueJobs(now: Date, started: (job: JobName) => number | null, sessionLive: () => boolean): JobName[] {
  const ny = nyClock(now);
  if (!isWeekday(ny.weekday)) return [];
  const t = now.getTime();
  const due: JobName[] = [];

  const slots = NIGHTLY_SLOTS.map(([h, m]) => nyInstant(ny.date, h, m)).filter((s) => s <= t);
  const slot = slots[slots.length - 1];
  if (slot !== undefined && (started("stock-nightly") ?? 0) < slot) due.push("stock-nightly");
  // The screen follows its nightly: due when the nightly of this slot has run but the screen has not.
  if (slot !== undefined && (started("stock-nightly") ?? 0) >= slot && (started("ideas-screen") ?? 0) < slot) due.push("ideas-screen");

  const open = nyInstant(ny.date, 9, 45);
  const close = nyInstant(ny.date, 16, 0);
  if (t >= open && t <= close + 3 * 60_000) {
    const slotOf = (min: number) => open + Math.floor((Math.min(t, close) - open) / (min * 60_000)) * min * 60_000;
    const stockSlot = slotOf(15);
    const optionSlot = slotOf(5);
    const stockDue = t >= stockSlot + STOCK_OFFSET_MS && (started("stock-intraday") ?? 0) < stockSlot;
    const optionDue = t >= optionSlot + OPTION_OFFSET_MS && (started("option-scan") ?? 0) < optionSlot;
    if ((stockDue || optionDue) && sessionLive()) {
      if (stockDue) due.push("stock-intraday");
      if (optionDue) due.push("option-scan");
    }
  }
  return due;
}

const sessionCache = { day: "", live: false };

/** SPY has minute bars from today's session. Cached once true; re-asked each tick until then. */
function spyTradedToday(now: Date): boolean {
  const day = nyClock(now).date;
  if (sessionCache.day === day && sessionCache.live) return true;
  const open = nyInstant(day, 9, 30) / 1000;
  const live = minuteBars("SPY", open, open + 6.5 * 3600, 1).length > 0;
  sessionCache.day = day;
  sessionCache.live = live;
  return live;
}

// ---- running ----

function record<T extends { symbols?: number; scored?: number }>(job: JobName, fn: () => T): T | null {
  const started = Date.now();
  const id = Number(db.prepare("INSERT INTO scan_runs (job, started_at) VALUES (?, ?)").run(job, new Date(started).toISOString()).lastInsertRowid);
  try {
    const r = fn();
    db.prepare("UPDATE scan_runs SET finished_at = ?, status = 'ok', symbols = ?, duration_ms = ? WHERE id = ?").run(
      new Date().toISOString(), r.symbols ?? r.scored ?? null, Date.now() - started, id
    );
    return r;
  } catch (err) {
    console.error(`[scan] ${job} failed:`, err);
    db.prepare("UPDATE scan_runs SET finished_at = ?, status = 'error', error = ?, duration_ms = ? WHERE id = ?").run(
      new Date().toISOString(), err instanceof Error ? err.message : String(err), Date.now() - started, id
    );
    return null;
  }
}

let running = false;

/** Runs one job now (also the route behind forced scans). Returns false when another run is in progress or the job can't run. */
export function runJob(job: JobName, now = new Date()): boolean {
  if (running) return false;
  if (job === "option-scan" && !deps) return false;
  running = true;
  try {
    switch (job) {
      case "stock-nightly":
        record(job, () => {
          const r = runNightlyScorecards(now);
          return { symbols: r.scored };
        });
        break;
      case "ideas-screen":
        record(job, () => {
          const universe = resolveUniverse();
          runStockScreen(universe, now);
          return { symbols: universe.length };
        });
        break;
      case "stock-intraday":
        record(job, () => {
          const universe = resolveUniverse();
          const r = runIntradayStockScan(universe, now);
          refreshStockIdeas(now);
          return { symbols: r.scored };
        });
        break;
      case "option-scan":
        record(job, () => {
          const universe = universeByPriority();
          const r = runOptionScan(universe, deps!.optionMetrics, now);
          updateOptionIdeas(now);
          return { symbols: r.scored };
        });
        break;
    }
  } finally {
    running = false;
  }
  return true;
}

export function startQuantJobs(d: QuantDeps): { stop: () => void } | null {
  if (process.env.SCAN_ENABLED === "0") {
    console.log("[scan] SCAN_ENABLED=0; scans disabled.");
    return null;
  }
  deps = d;
  // A killed process leaves its run marked running.
  db.prepare("UPDATE scan_runs SET status = 'error', error = 'abandoned: process stopped', finished_at = ? WHERE status = 'running'").run(new Date().toISOString());

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = new Date();
      // A fresh install has no scorecards: build them once without waiting for 07:00.
      const jobs: JobName[] = latestScorecardDay() === null && lastStart("stock-nightly") === null ? ["stock-nightly", "ideas-screen"] : dueJobs(now, (j) => lastStart(j), () => spyTradedToday(now));
      for (const job of jobs) {
        runJob(job, now);
        await new Promise((r) => setImmediate(r));
      }
    } catch (err) {
      console.error("[scan] tick failed:", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  setTimeout(() => void tick(), 15_000).unref();
  console.log("[scan] jobs enabled: nightly scorecards 07:00 and 16:30 ET, stock scan every 15 min and option scan every 5 min in the session");
  return { stop: () => clearInterval(timer) };
}

