import { db } from "../db.js";
import type { AgentName, Brief, MacroReport, Thesis, ThesisStrategy } from "./contracts.js";

// Tables of the agents: every run, the macro reports, theses and briefs, and
// the analysis queue. Reports keep their body as JSON beside indexed columns.

db.exec(`
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  agent TEXT NOT NULL,
  symbol TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error','skipped')),
  auth TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_day ON agent_runs (day, agent);
CREATE TABLE IF NOT EXISTS macro_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  as_of TEXT NOT NULL,
  session TEXT NOT NULL CHECK (session IN ('pre','post','adhoc')),
  data TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS macro_reports_day ON macro_reports (day, session);
CREATE TABLE IF NOT EXISTS theses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  strategy TEXT NOT NULL,
  contract TEXT,
  day TEXT NOT NULL,
  as_of TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS theses_lookup ON theses (symbol, strategy, id);
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  as_of TEXT NOT NULL,
  markdown TEXT NOT NULL,
  macro_id INTEGER,
  thesis_ids TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS briefs_day ON briefs (day);
CREATE TABLE IF NOT EXISTS case_cache (
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  contract TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  bull TEXT NOT NULL,
  bear TEXT NOT NULL,
  PRIMARY KEY (symbol, strategy, contract)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS agent_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  contract TEXT NOT NULL DEFAULT '',   -- dedupe key part: empty for automatic option items
  item_contract TEXT NOT NULL DEFAULT '', -- the contract to analyse
  idea_id INTEGER,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 1000,
  manual INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','dropped')),
  skipped_day TEXT,
  queued_at TEXT NOT NULL,
  UNIQUE (day, symbol, strategy, contract)
);
CREATE INDEX IF NOT EXISTS agent_queue_status ON agent_queue (status);
`);

try {
  db.exec("ALTER TABLE agent_queue ADD COLUMN item_contract TEXT NOT NULL DEFAULT ''");
} catch {
  // column already there
}
// A killed process leaves its runs marked running.
db.prepare("UPDATE agent_runs SET status = 'error', error = 'abandoned: process stopped', finished_at = ? WHERE status = 'running'").run(new Date().toISOString());
db.prepare("UPDATE agent_queue SET status = 'queued' WHERE status = 'running'").run();

// ---- runs ----

export type RunRow = {
  id: number; day: string; agent: AgentName; symbol: string | null; model: string; status: "running" | "ok" | "error" | "skipped";
  auth: string | null; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  turns: number; durationMs: number; error: string | null; startedAt: string; finishedAt: string | null;
};

export function insertRun(r: { day: string; agent: AgentName; symbol: string | null; model: string; status: "running" | "skipped"; error?: string | null; now: Date }): number {
  const iso = r.now.toISOString();
  return Number(
    db
      .prepare("INSERT INTO agent_runs (day, agent, symbol, model, status, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.day, r.agent, r.symbol, r.model, r.status, r.error ?? null, iso, r.status === "skipped" ? iso : null).lastInsertRowid
  );
}

export function finishRun(
  id: number,
  r: { status: "ok" | "error"; auth: string | null; costUsd: number; usage: { input: number; output: number; cacheRead: number; cacheCreation: number }; turns: number; durationMs: number; error: string | null }
): void {
  db.prepare(
    `UPDATE agent_runs SET status = ?, auth = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
       turns = ?, duration_ms = ?, error = ?, finished_at = ? WHERE id = ?`
  ).run(r.status, r.auth, r.costUsd, r.usage.input, r.usage.output, r.usage.cacheRead, r.usage.cacheCreation, r.turns, r.durationMs, r.error, new Date().toISOString(), id);
}

const toRun = (r: any): RunRow => ({
  id: r.id, day: r.day, agent: r.agent, symbol: r.symbol, model: r.model, status: r.status, auth: r.auth, costUsd: r.cost_usd,
  inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens,
  turns: r.turns, durationMs: r.duration_ms, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
});

export const listRuns = (limit: number): RunRow[] => (db.prepare("SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(toRun);

export const spentOn = (day: string): number => (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE day = ?").get(day) as { s: number }).s;
export const spentByAgent = (day: string, agents: AgentName[]): number =>
  (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE day = ? AND agent IN (SELECT value FROM json_each(?))").get(day, JSON.stringify(agents)) as { s: number }).s;
export const runCountOn = (day: string): number => (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE day = ? AND status != 'skipped'").get(day) as { n: number }).n;
export const skippedOn = (day: string): number => (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE day = ? AND status = 'skipped'").get(day) as { n: number }).n;
export const failedRunsOn = (day: string, agent: AgentName): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE day = ? AND agent = ? AND status = 'error'").get(day, agent) as { n: number }).n;
/** Whether the agent has any run row (ok, failed or skipped) for the day. */
export const attemptedOn = (day: string, agent: AgentName): boolean => db.prepare("SELECT 1 FROM agent_runs WHERE day = ? AND agent = ? LIMIT 1").get(day, agent) !== undefined;

// ---- macro ----

type MacroBody = Omit<MacroReport, "id" | "asOf" | "session" | "costUsd">;
const toMacro = (r: any): MacroReport => ({ id: r.id, asOf: r.as_of, session: r.session, costUsd: r.cost_usd, ...(JSON.parse(r.data) as MacroBody) });

export function insertMacro(day: string, session: MacroReport["session"], body: MacroBody, costUsd: number, now = new Date()): MacroReport {
  const id = Number(db.prepare("INSERT INTO macro_reports (day, as_of, session, data, cost_usd) VALUES (?, ?, ?, ?, ?)").run(day, now.toISOString(), session, JSON.stringify(body), costUsd).lastInsertRowid);
  return getMacro(id)!;
}
export const getMacro = (id: number): MacroReport | null => {
  const r = db.prepare("SELECT * FROM macro_reports WHERE id = ?").get(id);
  return r ? toMacro(r) : null;
};
export const latestMacro = (day?: string): MacroReport | null => {
  const r = day ? db.prepare("SELECT * FROM macro_reports WHERE day = ? ORDER BY id DESC LIMIT 1").get(day) : db.prepare("SELECT * FROM macro_reports ORDER BY id DESC LIMIT 1").get();
  return r ? toMacro(r) : null;
};
export const listMacro = (limit: number): MacroReport[] => (db.prepare("SELECT * FROM macro_reports ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(toMacro);
export const hasMacro = (day: string, session: "pre" | "post"): boolean => db.prepare("SELECT 1 FROM macro_reports WHERE day = ? AND session = ?").get(day, session) !== undefined;

// ---- theses ----

type ThesisBody = Omit<Thesis, "id">;
const toThesis = (r: any): Thesis => ({ ...(JSON.parse(r.data) as ThesisBody), id: r.id });

export function insertThesis(day: string, t: ThesisBody): Thesis {
  const id = Number(
    db
      .prepare("INSERT INTO theses (idea_id, symbol, kind, strategy, contract, day, as_of, status, data, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.ideaId, t.symbol, t.kind, t.strategy, t.contract, day, t.asOf, t.status, JSON.stringify(t), t.costUsd).lastInsertRowid
  );
  return getThesis(id)!;
}
export const getThesis = (id: number): Thesis | null => {
  const r = db.prepare("SELECT * FROM theses WHERE id = ?").get(id);
  return r ? toThesis(r) : null;
};
export function listTheses(q: { symbol?: string; strategy?: ThesisStrategy; limit: number }): Thesis[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (q.symbol) { where.push("symbol = ?"); args.push(q.symbol); }
  if (q.strategy) { where.push("strategy = ?"); args.push(q.strategy); }
  args.push(q.limit);
  return (db.prepare(`SELECT * FROM theses ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args) as any[]).map(toThesis);
}
/** Newest thesis for a symbol and strategy whatever the contract (option ideas re-centre as the price moves). */
export const latestThesisForStrategy = (symbol: string, strategy: ThesisStrategy): Thesis | null => {
  const r = db.prepare("SELECT * FROM theses WHERE symbol = ? AND strategy = ? ORDER BY id DESC LIMIT 1").get(symbol, strategy);
  return r ? toThesis(r) : null;
};
/** Newest thesis for a (symbol, strategy, contract); contract null matches stock theses. */
export function latestThesisFor(symbol: string, strategy: ThesisStrategy, contract: string | null): Thesis | null {
  const r = contract
    ? db.prepare("SELECT * FROM theses WHERE symbol = ? AND strategy = ? AND contract = ? ORDER BY id DESC LIMIT 1").get(symbol, strategy, contract)
    : db.prepare("SELECT * FROM theses WHERE symbol = ? AND strategy = ? AND contract IS NULL ORDER BY id DESC LIMIT 1").get(symbol, strategy);
  return r ? toThesis(r) : null;
}
export const latestThesisByIdea = (ideaId: number): Thesis | null => {
  const r = db.prepare("SELECT * FROM theses WHERE idea_id = ? ORDER BY id DESC LIMIT 1").get(ideaId);
  return r ? toThesis(r) : null;
};
export const thesisDay = (id: number): string | null => (db.prepare("SELECT day FROM theses WHERE id = ?").get(id) as { day: string } | undefined)?.day ?? null;

// ---- briefs ----

const toBrief = (r: any): Brief => ({ id: r.id, day: r.day, asOf: r.as_of, markdown: r.markdown, macroId: r.macro_id, thesisIds: JSON.parse(r.thesis_ids), costUsd: r.cost_usd });
export function insertBrief(b: Omit<Brief, "id">): Brief {
  const id = Number(db.prepare("INSERT INTO briefs (day, as_of, markdown, macro_id, thesis_ids, cost_usd) VALUES (?, ?, ?, ?, ?, ?)").run(b.day, b.asOf, b.markdown, b.macroId, JSON.stringify(b.thesisIds), b.costUsd).lastInsertRowid);
  return toBrief(db.prepare("SELECT * FROM briefs WHERE id = ?").get(id));
}
export const latestBrief = (): Brief | null => {
  const r = db.prepare("SELECT * FROM briefs ORDER BY id DESC LIMIT 1").get();
  return r ? toBrief(r) : null;
};
export const listBriefs = (limit: number): Brief[] => (db.prepare("SELECT * FROM briefs ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(toBrief);
export const hasBrief = (day: string): boolean => db.prepare("SELECT 1 FROM briefs WHERE day = ?").get(day) !== undefined;

// ---- bull and bear cases kept when the judge was refused for budget, so it can reuse them within 24 hours ----

export const CASE_REUSE_MS = 24 * 3_600_000;
type CasePair = { bull: import("./contracts.js").Case; bear: import("./contracts.js").Case };
export function saveCases(symbol: string, strategy: ThesisStrategy, contract: string | null, pair: CasePair, now: Date): void {
  db.prepare("INSERT OR REPLACE INTO case_cache (symbol, strategy, contract, created_at, bull, bear) VALUES (?, ?, ?, ?, ?, ?)").run(symbol, strategy, contract ?? "", now.toISOString(), JSON.stringify(pair.bull), JSON.stringify(pair.bear));
}
export function loadCases(symbol: string, strategy: ThesisStrategy, contract: string | null, now: Date): CasePair | null {
  const r = db.prepare("SELECT * FROM case_cache WHERE symbol = ? AND strategy = ? AND contract = ?").get(symbol, strategy, contract ?? "") as { created_at: string; bull: string; bear: string } | undefined;
  if (!r || now.getTime() - Date.parse(r.created_at) > CASE_REUSE_MS) return null;
  return { bull: JSON.parse(r.bull), bear: JSON.parse(r.bear) };
}
export const dropCases = (symbol: string, strategy: ThesisStrategy, contract: string | null): void =>
  void db.prepare("DELETE FROM case_cache WHERE symbol = ? AND strategy = ? AND contract = ?").run(symbol, strategy, contract ?? "");
