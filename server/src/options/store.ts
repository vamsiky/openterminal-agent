import { db } from "../db.js";
import { minuteDb } from "../history/store.js";
import type { OptionMetrics } from "../scan/contracts.js";

// Storage for the options data layer.
// - option_minute_bars: one row per streamed contract per minute, in the
//   minute-bar file (it grows like minute_bars; pruned daily).
// - iv_history: one row per underlying per trading day, the base for IV rank.
// - option_metrics: the latest OptionMetrics per underlying (JSON).

minuteDb.exec(`
CREATE TABLE IF NOT EXISTS option_minute_bars (
  occ TEXT NOT NULL,
  ts INTEGER NOT NULL,
  bid REAL,
  ask REAL,
  mid REAL,
  last REAL,
  volume REAL,
  iv REAL,
  delta REAL,
  PRIMARY KEY (occ, ts)
) WITHOUT ROWID;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS iv_history (
  symbol TEXT NOT NULL,
  day TEXT NOT NULL,
  iv30 REAL,
  atm_iv REAL,
  hv20 REAL,
  PRIMARY KEY (symbol, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS option_metrics (
  symbol TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  metrics TEXT NOT NULL
);
`);

export type OptionBar = {
  occ: string;
  ts: number; // unix seconds, minute start
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  volume: number | null;
  iv: number | null;
  delta: number | null;
};

const upsertBarStmt = minuteDb.prepare(`
INSERT INTO option_minute_bars (occ, ts, bid, ask, mid, last, volume, iv, delta)
VALUES (@occ, @ts, @bid, @ask, @mid, @last, @volume, @iv, @delta)
ON CONFLICT(occ, ts) DO UPDATE SET
  bid = excluded.bid, ask = excluded.ask, mid = excluded.mid, last = excluded.last,
  volume = excluded.volume, iv = excluded.iv, delta = excluded.delta
`);
export const upsertOptionBars = minuteDb.transaction((bars: OptionBar[]) => {
  for (const b of bars) upsertBarStmt.run(b);
});

export function optionBars(occ: string, fromTs: number, toTs: number, limit = 20_000): OptionBar[] {
  return minuteDb
    .prepare("SELECT * FROM option_minute_bars WHERE occ = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?")
    .all(occ, fromTs, toTs, limit) as OptionBar[];
}

export function retentionDays(raw = process.env.OPTION_BARS_RETENTION_DAYS): number {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 90;
}

/** Delete option minute bars older than the retention window; returns rows removed. */
export function pruneOptionBars(nowMs = Date.now(), days = retentionDays()): number {
  const cutoff = Math.floor(nowMs / 1000) - days * 86_400;
  return minuteDb.prepare("DELETE FROM option_minute_bars WHERE ts < ?").run(cutoff).changes;
}

// ---- IV history ----

export type IvDay = { symbol: string; day: string; iv30: number | null; atmIv: number | null; hv20: number | null };

const upsertIvStmt = db.prepare(`
INSERT INTO iv_history (symbol, day, iv30, atm_iv, hv20) VALUES (@symbol, @day, @iv30, @atmIv, @hv20)
ON CONFLICT(symbol, day) DO UPDATE SET iv30 = excluded.iv30, atm_iv = excluded.atm_iv, hv20 = excluded.hv20
`);
export function upsertIvDay(row: IvDay): void {
  upsertIvStmt.run(row);
}

/** The latest `days` rows, oldest first. */
export function ivHistory(symbol: string, days = 252): IvDay[] {
  const rows = db
    .prepare("SELECT symbol, day, iv30, atm_iv AS atmIv, hv20 FROM iv_history WHERE symbol = ? ORDER BY day DESC LIMIT ?")
    .all(symbol, days) as IvDay[];
  return rows.reverse();
}

export const MIN_RANK_DAYS = 20;
export const RANK_WINDOW = 252;

export type IvRank = { ivRank: number | null; ivPercentile: number | null; days: number };

/**
 * IV rank (min-max position of `current` in the window) and IV percentile
 * (share of the window's days strictly below it). The window is the last
 * RANK_WINDOW rows: `prior` days plus today's `current`. `days` counts the
 * rows used; both measures are null under MIN_RANK_DAYS rows or without a
 * current value.
 */
export function ivRank(current: number | null, prior: Array<number | null>): IvRank {
  if (current === null) return { ivRank: null, ivPercentile: null, days: prior.filter((v) => v !== null).length };
  const values = [...prior.filter((v): v is number => v !== null).slice(-(RANK_WINDOW - 1)), current];
  if (values.length < MIN_RANK_DAYS) return { ivRank: null, ivPercentile: null, days: values.length };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return {
    ivRank: hi > lo ? ((current - lo) / (hi - lo)) * 100 : 50,
    ivPercentile: (values.filter((v) => v < current).length / values.length) * 100,
    days: values.length,
  };
}

// ---- latest metrics ----

const saveMetricsStmt = db.prepare(`
INSERT INTO option_metrics (symbol, as_of, metrics) VALUES (?, ?, ?)
ON CONFLICT(symbol) DO UPDATE SET as_of = excluded.as_of, metrics = excluded.metrics
`);
export function saveOptionMetrics(m: OptionMetrics): void {
  saveMetricsStmt.run(m.underlying, m.asOf, JSON.stringify(m));
}

export function latestOptionMetrics(symbols: string[]): Map<string, OptionMetrics> {
  const out = new Map<string, OptionMetrics>();
  const get = db.prepare("SELECT metrics FROM option_metrics WHERE symbol = ?");
  for (const s of symbols) {
    const row = get.get(s) as { metrics: string } | undefined;
    if (row) out.set(s, JSON.parse(row.metrics) as OptionMetrics);
  }
  return out;
}
