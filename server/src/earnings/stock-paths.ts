import { db } from "../db.js";
import { earningsDb } from "./db.js";
import * as alpaca from "../providers/alpaca.js";
import { nyInstant } from "../live/session.js";
import { sessionClose } from "../providers/alpaca-calendar.js";
import type { Anchor } from "./contracts.js";
import { addSessions } from "./sessions.js";

// Stock prices at every anchor around a report. Daily anchors come from
// daily_bars (terminal.db); the two intraday ones (T0:10:00 and T0:15:45) from
// Alpaca's 15-minute SIP bars, fetched as multi-symbol requests per date.

export type Daily = { byDay: Map<string, { open: number; high: number; low: number; close: number; volume: number }> };

/** Every daily bar of a symbol, keyed by day. */
export function loadDaily(symbol: string): Daily {
  const rows = db.prepare("SELECT day, open, high, low, close, volume FROM daily_bars WHERE symbol = ? ORDER BY day").all(symbol) as Array<{ day: string; open: number; high: number; low: number; close: number; volume: number }>;
  return { byDay: new Map(rows.map((r) => [r.day, r])) };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const MIN_HISTORY = 10; // sessions of the 20 needed for a baseline

/** The 20 sessions ending at (and including) `end`, oldest first. */
function window20(end: string): string[] {
  const out = [end];
  for (let i = 1; i < 20; i++) out.unshift(addSessions(out[0], -1));
  return out;
}

export type Reaction = { volumeRatio: number | null; gapRatio: number | null; pass: boolean };

/**
 * How big R was against the 20 sessions before T0: its volume over their median, and its
 * open gap (against the previous session's close) over their average absolute daily move.
 * Null when R has no bar or the baseline is under 10 sessions.
 */
export function reaction(d: Daily, t0: string, r: string): Reaction | null {
  const bar = d.byDay.get(r);
  if (!bar) return null;
  const before = window20(addSessions(t0, -1)); // T0-20 .. T0-1
  const vols = before.map((x) => d.byDay.get(x)?.volume).filter((v): v is number => v !== undefined && v > 0);
  const volumeRatio = vols.length >= MIN_HISTORY ? bar.volume / median(vols) : null;

  const prev = d.byDay.get(addSessions(r, -1));
  const moves: number[] = [];
  const ending = window20(addSessions(r, -1));
  for (let i = 1; i < ending.length; i++) {
    const a = d.byDay.get(ending[i - 1])?.close;
    const b = d.byDay.get(ending[i])?.close;
    if (a && b) moves.push(Math.abs(b / a - 1));
  }
  const avg = moves.length >= MIN_HISTORY ? moves.reduce((x, y) => x + y, 0) / moves.length : null;
  const gapRatio = prev && avg && avg > 0 ? Math.abs(bar.open / prev.close - 1) / avg : null;
  return { volumeRatio, gapRatio, pass: (volumeRatio ?? 0) >= 1.5 || (gapRatio ?? 0) >= 1.5 };
}

/** Average true range over the 14 sessions ending at `end`, as a percent of that day's close. */
export function atr14Pct(d: Daily, end: string): number | null {
  const days = window20(end).slice(-14);
  const trs: number[] = [];
  for (const day of days) {
    const bar = d.byDay.get(day);
    const prev = d.byDay.get(addSessions(day, -1));
    if (!bar || !prev) continue;
    trs.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)));
  }
  const last = d.byDay.get(end)?.close;
  if (trs.length < 10 || !last) return null;
  return (trs.reduce((x, y) => x + y, 0) / trs.length / last) * 100;
}

export type PathRow = Partial<Record<Anchor, number | null>> & { prevClose: number | null; rVolumeRatio: number | null; atr14Pct: number | null };

/** The daily anchors, prevClose, rVolumeRatio and atr14Pct of one report. Intraday anchors are filled in by the caller. */
export function dailyPath(d: Daily, t0: string, r: string): PathRow {
  const close = (day: string) => d.byDay.get(day)?.close ?? null;
  const at = (day: string, n: number) => addSessions(day, n);
  const prevSession = addSessions(r, -1); // T0 for bmo/amc; T0-1 when R is T0 itself (dmh)
  return {
    "T0-20": close(at(t0, -20)),
    "T0-10": close(at(t0, -10)),
    "T0-5": close(at(t0, -5)),
    "T0-2": close(at(t0, -2)),
    "T0-1": close(at(t0, -1)),
    "T0:open": d.byDay.get(t0)?.open ?? null,
    "T0:10:00": null,
    "T0:15:45": null,
    "T0:close": close(t0),
    "R:open": d.byDay.get(r)?.open ?? null,
    "R:close": close(r),
    "R+5": close(at(r, 5)),
    "R+20": close(at(r, 20)),
    prevClose: close(prevSession),
    rVolumeRatio: reaction(d, t0, r)?.volumeRatio ?? null,
    atr14Pct: atr14Pct(d, prevSession),
  };
}

const BAR_MS = 15 * 60_000;
const MAX_STALE_MS = 45 * 60_000;

/**
 * The close of the 15-minute bar ending at `endMs`; if that bar is missing, the last bar
 * ending within 45 minutes before it; else null.
 */
export function barClose(bars: alpaca.Bar[], endMs: number): number | null {
  let best: { end: number; c: number } | null = null;
  for (const b of bars) {
    const end = Date.parse(b.t) + BAR_MS;
    if (end <= endMs && endMs - end <= MAX_STALE_MS && (!best || end > best.end)) best = { end, c: b.c };
  }
  return best?.c ?? null;
}

/** Epoch ms of 10:00 and 15:45 New York on a day. */
export const anchorTimes = (day: string) => ({ ten: nyInstant(day, 10, 0), late: nyInstant(day, 15, 45) });

const CHUNK = 100;
const FETCH_WORKERS = 8;

/**
 * 15-minute bars for the given (symbol, T0) pairs, one multi-symbol request per date (several
 * when over 100 symbols or the pages run long). Returns `symbol|T0` → the two intraday anchors.
 */
export async function fetchIntraday(pairs: Array<{ symbol: string; t0: string }>): Promise<Map<string, { ten: number | null; late: number | null }>> {
  const byDate = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!byDate.has(p.t0)) byDate.set(p.t0, new Set());
    byDate.get(p.t0)!.add(p.symbol);
  }
  const out = new Map<string, { ten: number | null; late: number | null }>();
  // One job per (date, chunk of 100 symbols); a few run at once (the shared throttle still caps the rate).
  const jobs: Array<{ t0: string; list: string[] }> = [];
  for (const [t0, symbols] of byDate) {
    const list = [...symbols];
    for (let i = 0; i < list.length; i += CHUNK) jobs.push({ t0, list: list.slice(i, i + CHUNK) });
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_WORKERS, jobs.length) }, async () => {
      while (next < jobs.length) {
        const { t0, list } = jobs[next++];
        const { ten, late } = anchorTimes(t0);
        // Bars from 09:30 to the 16:00 close (early-close days simply end sooner).
        const start = new Date(nyInstant(t0, 9, 30)).toISOString();
        const end = new Date(Math.max(sessionClose(t0), late)).toISOString();
        const got = new Map<string, alpaca.Bar[]>();
        for await (const page of alpaca.stockBars({ symbols: list, timeframe: "15Min", start, end })) {
          for (const [sym, bars] of Object.entries(page)) got.set(sym, [...(got.get(sym) ?? []), ...bars]);
        }
        for (const sym of list) {
          const bars = got.get(sym) ?? [];
          out.set(`${sym}|${t0}`, { ten: barClose(bars, ten), late: barClose(bars, late) });
        }
      }
    })
  );
  return out;
}

const COLUMNS: Array<[keyof PathRow, string]> = [
  ["T0-20", "t0_m20"], ["T0-10", "t0_m10"], ["T0-5", "t0_m5"], ["T0-2", "t0_m2"], ["T0-1", "t0_m1"],
  ["T0:open", "t0_open"], ["T0:10:00", "t0_1000"], ["T0:15:45", "t0_1545"], ["T0:close", "t0_close"],
  ["R:open", "r_open"], ["R:close", "r_close"], ["R+5", "r_p5"], ["R+20", "r_p20"],
  ["prevClose", "prev_close"], ["rVolumeRatio", "r_volume_ratio"], ["atr14Pct", "atr14_pct"],
];

const upsert = earningsDb.prepare(
  `INSERT INTO stock_paths (symbol, report_date, ${COLUMNS.map((c) => c[1]).join(", ")}, updated_at)
   VALUES (@symbol, @report_date, ${COLUMNS.map((c) => "@" + c[1]).join(", ")}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   ON CONFLICT (symbol, report_date) DO UPDATE SET ${COLUMNS.map((c) => `${c[1]} = excluded.${c[1]}`).join(", ")}, updated_at = excluded.updated_at`
);

export function storePath(symbol: string, reportDate: string, path: PathRow): void {
  const row: Record<string, unknown> = { symbol, report_date: reportDate };
  for (const [key, col] of COLUMNS) row[col] = path[key] ?? null;
  upsert.run(row);
}

export type PendingEvent = { symbol: string; reportDate: string; t0: string; r: string };

/**
 * Computes and stores the stock paths of the given events (confirmed or not: the
 * confirmation flag filters them later). Events whose R:close is missing are skipped
 * when R is under 10 days old (the daily bars may not have landed yet).
 */
export async function buildStockPaths(events: PendingEvent[], today: string): Promise<{ stored: number; skipped: number }> {
  const dailyCache = new Map<string, Daily>();
  const daily = (s: string) => dailyCache.get(s) ?? (dailyCache.set(s, loadDaily(s)), dailyCache.get(s)!);
  const paths = events.map((e) => ({ e, path: dailyPath(daily(e.symbol), e.t0, e.r) }));
  const intraday = await fetchIntraday(paths.filter((p) => p.path["T0:close"] !== null).map((p) => ({ symbol: p.e.symbol, t0: p.e.t0 })));
  let stored = 0;
  let skipped = 0;
  const write = earningsDb.transaction(() => {
    for (const { e, path } of paths) {
      const recent = e.r >= addSessions(today, -7);
      if (path["R:close"] === null && recent) {
        skipped++;
        continue;
      }
      const i = intraday.get(`${e.symbol}|${e.t0}`);
      path["T0:10:00"] = i?.ten ?? null;
      path["T0:15:45"] = i?.late ?? null;
      storePath(e.symbol, e.reportDate, path);
      stored++;
    }
  });
  write();
  return { stored, skipped };
}
