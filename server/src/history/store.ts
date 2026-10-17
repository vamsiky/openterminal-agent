import Database from "better-sqlite3";
import { join } from "node:path";
import { dataDir, db } from "../db.js";

// Price history for research and swing studies.
//
// - Daily bars for the whole US universe live in the main database
//   (terminal.db): ~20M rows for 10 years of ~8,000 symbols, a couple of GB.
// - Minute bars live in their own file (minute_bars.db) because they are two
//   orders of magnitude bigger, so they can be moved to a larger disk, backed
//   up, or deleted without touching portfolios and watchlists.
//
// Prices are split-adjusted (Alpaca adjustment=split). When a new split
// lands, every earlier bar for that symbol changes; sync.ts detects that and
// re-downloads the symbol's history.

db.exec(`
CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,
  name TEXT,
  exchange TEXT,
  is_etf INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  in_sp500 INTEGER NOT NULL DEFAULT 0,
  in_nasdaq100 INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT (date('now')),
  last_seen TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL,
  day TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  vwap REAL,
  trades INTEGER,
  PRIMARY KEY (symbol, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS history_sync (
  job TEXT NOT NULL,
  symbol TEXT NOT NULL,
  last_bar TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job, symbol)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS history_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  symbols INTEGER NOT NULL DEFAULT 0,
  bars INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  heartbeat_at TEXT
);
`);
// Databases created before heartbeat_at existed.
if (!(db.prepare("PRAGMA table_info(history_runs)").all() as Array<{ name: string }>).some((c) => c.name === "heartbeat_at")) {
  db.exec("ALTER TABLE history_runs ADD COLUMN heartbeat_at TEXT");
}

export const minuteDb = new Database(join(dataDir, "minute_bars.db"));
minuteDb.pragma("journal_mode = WAL");
minuteDb.exec(`
CREATE TABLE IF NOT EXISTS minute_bars (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  vwap REAL,
  trades INTEGER,
  PRIMARY KEY (symbol, ts)
) WITHOUT ROWID;
`);

export type DailyBar = {
  symbol: string;
  day: string; // YYYY-MM-DD, New York trading date
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
  trades: number | null;
};

export type MinuteBar = Omit<DailyBar, "day"> & { ts: number }; // unix seconds, bar start

const upsertDailyStmt = db.prepare(`
INSERT INTO daily_bars (symbol, day, open, high, low, close, volume, vwap, trades)
VALUES (@symbol, @day, @open, @high, @low, @close, @volume, @vwap, @trades)
ON CONFLICT(symbol, day) DO UPDATE SET
  open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
  volume = excluded.volume, vwap = excluded.vwap, trades = excluded.trades
`);
export const upsertDailyBars = db.transaction((bars: DailyBar[]) => {
  for (const b of bars) upsertDailyStmt.run(b);
});

const upsertMinuteStmt = minuteDb.prepare(`
INSERT INTO minute_bars (symbol, ts, open, high, low, close, volume, vwap, trades)
VALUES (@symbol, @ts, @open, @high, @low, @close, @volume, @vwap, @trades)
ON CONFLICT(symbol, ts) DO UPDATE SET
  open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
  volume = excluded.volume, vwap = excluded.vwap, trades = excluded.trades
`);
export const upsertMinuteBars = minuteDb.transaction((bars: MinuteBar[]) => {
  for (const b of bars) upsertMinuteStmt.run(b);
});

export function lastDailyBar(symbol: string): DailyBar | undefined {
  return db
    .prepare("SELECT * FROM daily_bars WHERE symbol = ? ORDER BY day DESC LIMIT 1")
    .get(symbol) as DailyBar | undefined;
}

/** The second-newest daily bar (or the only one): a day whose bar is final. */
export function settledDailyBar(symbol: string): DailyBar | undefined {
  const rows = db
    .prepare("SELECT * FROM daily_bars WHERE symbol = ? ORDER BY day DESC LIMIT 2")
    .all(symbol) as DailyBar[];
  return rows[rows.length - 1];
}

export function firstDailyDay(symbol: string): string | null {
  const row = db.prepare("SELECT MIN(day) AS day FROM daily_bars WHERE symbol = ?").get(symbol) as { day: string | null };
  return row.day;
}

export function lastMinuteTs(symbol: string): number | null {
  const row = minuteDb.prepare("SELECT MAX(ts) AS ts FROM minute_bars WHERE symbol = ?").get(symbol) as { ts: number | null };
  return row.ts;
}

export function firstMinuteTs(symbol: string): number | null {
  const row = minuteDb.prepare("SELECT MIN(ts) AS ts FROM minute_bars WHERE symbol = ?").get(symbol) as { ts: number | null };
  return row.ts;
}

export function dailyBars(symbol: string, from: string, to: string, limit = 20_000): DailyBar[] {
  return db
    .prepare("SELECT * FROM daily_bars WHERE symbol = ? AND day >= ? AND day <= ? ORDER BY day LIMIT ?")
    .all(symbol, from, to, limit) as DailyBar[];
}

export function minuteBars(symbol: string, fromTs: number, toTs: number, limit = 20_000): MinuteBar[] {
  return minuteDb
    .prepare("SELECT * FROM minute_bars WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?")
    .all(symbol, fromTs, toTs, limit) as MinuteBar[];
}

// ---- universe ----

export type SymbolRow = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  isEtf: boolean;
};

/**
 * Replace the active universe with `rows`. Symbols that disappear are marked
 * inactive, never deleted, so their history stays available and studies
 * don't silently drop delisted names (survivorship bias).
 */
export const saveUniverse = db.transaction((rows: SymbolRow[]) => {
  const upsert = db.prepare(`
    INSERT INTO symbols (symbol, name, exchange, is_etf, active, last_seen)
    VALUES (?, ?, ?, ?, 1, date('now'))
    ON CONFLICT(symbol) DO UPDATE SET
      name = excluded.name, exchange = excluded.exchange, is_etf = excluded.is_etf,
      active = 1, last_seen = date('now')
  `);
  db.prepare("UPDATE symbols SET active = 0").run();
  for (const r of rows) upsert.run(r.symbol, r.name, r.exchange, r.isEtf ? 1 : 0);
});

/** Set index membership; an empty list leaves the stored membership alone. */
export function saveIndexMembers(column: "in_sp500" | "in_nasdaq100", symbols: string[]): void {
  if (symbols.length === 0) return;
  db.transaction(() => {
    db.prepare(`UPDATE symbols SET ${column} = 0`).run();
    const insert = db.prepare(`INSERT INTO symbols (symbol, ${column}) VALUES (?, 1) ON CONFLICT(symbol) DO UPDATE SET ${column} = 1`);
    for (const s of symbols) insert.run(s);
  })();
}

export function activeSymbols(): string[] {
  return (db.prepare("SELECT symbol FROM symbols WHERE active = 1 ORDER BY symbol").all() as Array<{ symbol: string }>).map(
    (r) => r.symbol
  );
}

export function indexSymbols(): string[] {
  return (
    db.prepare("SELECT symbol FROM symbols WHERE in_sp500 = 1 OR in_nasdaq100 = 1 ORDER BY symbol").all() as Array<{
      symbol: string;
    }>
  ).map((r) => r.symbol);
}

// ---- run bookkeeping ----

export function startRun(job: string): number {
  return Number(db.prepare("INSERT INTO history_runs (job, heartbeat_at) VALUES (?, datetime('now'))").run(job).lastInsertRowid);
}

/** Marks a run as alive; a run whose heartbeat stops is treated as dead. */
export function heartbeat(id: number): void {
  db.prepare("UPDATE history_runs SET heartbeat_at = datetime('now') WHERE id = ?").run(id);
}

/** A run still marked 'running' that has sent a heartbeat in the last `minutes`. */
export function liveRun(minutes: number): { id: number } | undefined {
  return db
    .prepare(
      "SELECT id FROM history_runs WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) > datetime('now', ?) LIMIT 1"
    )
    .get(`-${minutes} minutes`) as { id: number } | undefined;
}

/** Close out runs whose process died without finishing them. */
export function abandonStaleRuns(minutes: number): void {
  db.prepare(
    "UPDATE history_runs SET status = 'error', finished_at = datetime('now'), error = COALESCE(error, 'abandoned: process stopped') WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) <= datetime('now', ?)"
  ).run(`-${minutes} minutes`);
}

export function finishRun(id: number, result: { status: "ok" | "partial" | "error"; symbols: number; bars: number; error?: string }): void {
  db.prepare(
    "UPDATE history_runs SET finished_at = datetime('now'), status = ?, symbols = ?, bars = ?, error = ? WHERE id = ?"
  ).run(result.status, result.symbols, result.bars, result.error ?? null, id);
}

// Failed runs count too: a nightly job that errors waits for the next evening
// instead of retrying every few minutes against a provider that is failing.
export function lastFinishedRun(job: string): { started_at: string; finished_at: string } | undefined {
  return db
    .prepare("SELECT started_at, finished_at FROM history_runs WHERE job = ? AND status != 'running' ORDER BY id DESC LIMIT 1")
    .get(job) as { started_at: string; finished_at: string } | undefined;
}

export function markSynced(job: string, symbol: string, lastBar: string): void {
  db.prepare(
    "INSERT INTO history_sync (job, symbol, last_bar) VALUES (?, ?, ?) ON CONFLICT(job, symbol) DO UPDATE SET last_bar = excluded.last_bar, updated_at = datetime('now')"
  ).run(job, symbol, lastBar);
}

export function clearSynced(job: string, symbol: string): void {
  db.prepare("DELETE FROM history_sync WHERE job = ? AND symbol = ?").run(job, symbol);
}

// A split found by the daily sync means the symbol's minute bars must be
// re-downloaded too. The flag is stored so it survives daily-only runs.
export function flagMinuteReload(symbol: string): void {
  markSynced("minute_reload", symbol, new Date().toISOString());
}

export function minuteReloads(): string[] {
  return (db.prepare("SELECT symbol FROM history_sync WHERE job = 'minute_reload'").all() as Array<{ symbol: string }>).map(
    (r) => r.symbol
  );
}

// Read from the per-symbol sync bookkeeping, not the bar tables: counting
// hundreds of millions of minute rows would take far too long for a status call.
export function historyStatus() {
  const perJob = db
    .prepare("SELECT job, COUNT(*) AS symbols, MIN(last_bar) AS oldestLastBar, MAX(last_bar) AS newestLastBar FROM history_sync GROUP BY job")
    .all();
  const universe = db
    .prepare("SELECT SUM(active) AS active, COUNT(*) AS total, SUM(in_sp500) AS sp500, SUM(in_nasdaq100) AS nasdaq100 FROM symbols")
    .get();
  const runs = db.prepare("SELECT * FROM history_runs ORDER BY id DESC LIMIT 10").all();
  return { universe, jobs: perJob, runs };
}
