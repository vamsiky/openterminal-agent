import { mapWithConcurrency } from "../concurrency.js";
import { db } from "../db.js";
import { tradingDay } from "../history/time.js";
import { ensureCalendar, isTradingDay, sessionClose } from "../providers/alpaca-calendar.js";
import { optionDailyBars, type OptionDayBar } from "../providers/alpaca-options.js";
import { impliedVol, riskFreeRate } from "./black-scholes.js";
import { buildOcc, daysBetween } from "./selection.js";
import { upsertBackfillDays, type IvDay } from "./store.js";
import { constantMaturityIv, historicalVol, type Term } from "./sweep.js";

// Backfill of iv_history from Alpaca's historical option bars, so IV rank
// works from the first day instead of after 20 live days.
//
// For each of the last 252 trading days of an underlying: the two monthly
// expiries around 30 days out, the call and put near the day's close, each
// contract's daily close turned into an IV with Black-Scholes, the legs
// averaged per expiry and interpolated to 30 days the way the live iv30 is.
//
// Alpaca can't list the strikes that existed back then, so candidate strikes
// are tried on the usual strike grids for the price level and the contract
// that has a bar and sits nearest the close is used. Bars are fetched in
// batches of symbols that are needed in the same stretch of days, which keeps
// each response small.

export const BACKFILL_DAYS = 252;
export const MIN_LEGS = 2;
const BATCH_SYMBOLS = 200;

export type DayClose = { day: string; close: number };

/** The third Friday of a month, or the trading day before it when that Friday is a holiday. */
export function monthlyExpiry(year: number, month: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((5 - first + 7) % 7) + 14;
  let d = Date.UTC(year, month - 1, day);
  while (!isTradingDay(new Date(d).toISOString().slice(0, 10))) d -= 86_400_000;
  return new Date(d).toISOString().slice(0, 10);
}

/** The monthly expiries around 30 days out: the latest at 3–30 days, and the earliest at 30 or more. */
export function bracketExpiries(day: string): string[] {
  const [y, m] = day.split("-").map(Number);
  let lo: string | undefined;
  let hi: string | undefined;
  for (let k = 0; k < 4; k++) {
    const month0 = m - 1 + k;
    const e = monthlyExpiry(y + Math.floor(month0 / 12), (month0 % 12) + 1);
    const dte = daysBetween(day, e);
    if (dte >= 3 && dte <= 30) lo = e;
    if (dte >= 30 && !hi) hi = e;
  }
  return [...new Set([lo, hi].filter((e): e is string => !!e))];
}

/** Strike increments in use at a price level, finest first. */
function increments(price: number): number[] {
  if (price < 25) return [0.5, 1, 2.5];
  if (price < 200) return [1, 2.5, 5];
  if (price < 500) return [1, 2.5, 5, 10];
  return [1, 5, 10];
}

/** Strikes to try around a price: the multiples of each increment just below and above it. */
export function candidateStrikes(price: number): number[] {
  const out = new Set<number>();
  for (const inc of increments(price)) {
    const below = Math.floor(price / inc) * inc;
    out.add(Math.round(below * 1000) / 1000);
    out.add(Math.round((below + inc) * 1000) / 1000);
  }
  return [...out].filter((s) => s > 0).sort((a, b) => Math.abs(a - price) - Math.abs(b - price));
}

export type BarLookup = (occ: string, day: string) => Pick<OptionDayBar, "c" | "v"> | undefined;

export type DayIv = { iv30: number | null; legs: number };

/**
 * IV30 for one day from the contracts' daily closes. Per expiry the strike
 * nearest the close that has both legs traded is used (else the nearest with
 * one leg); a leg counts only with volume. Fewer than MIN_LEGS legs in all
 * gives null.
 */
export function dayIv(root: string, day: string, spot: number, expiries: string[], bar: BarLookup, rate = riskFreeRate()): DayIv {
  const terms: Term[] = [];
  let legs = 0;
  const strikes = candidateStrikes(spot);
  const now = sessionClose(day);
  for (const expiry of expiries) {
    let pick: Array<{ right: "call" | "put"; strike: number; c: number }> = [];
    for (const strike of strikes) {
      const found = (["call", "put"] as const).flatMap((right) => {
        const b = bar(buildOcc(root, expiry, right, strike), day);
        return b && b.v > 0 && b.c > 0 ? [{ right, strike, c: b.c }] : [];
      });
      if (found.length === 2) {
        pick = found;
        break;
      }
      if (found.length === 1 && pick.length === 0) pick = found;
    }
    const t = Math.max(sessionClose(expiry) - now, 60_000) / (365 * 86_400_000);
    const ivs = pick.flatMap((p) => impliedVol({ right: p.right, spot, strike: p.strike, t, rate }, p.c) ?? []);
    if (ivs.length > 0) {
      legs += ivs.length;
      terms.push({ days: daysBetween(day, expiry), iv: ivs.reduce((a, b) => a + b, 0) / ivs.length });
    }
  }
  return { iv30: legs >= MIN_LEGS ? constantMaturityIv(terms, 30) : null, legs };
}

export type BackfillDeps = {
  /** Daily closes, oldest first; defaults to daily_bars. */
  closes?: (symbol: string) => DayClose[];
  bars?: (symbols: string[], start: string, end: string, stats: { requests: number }) => Promise<Record<string, OptionDayBar[]>>;
  /** Today, New York date; days from today on are left to the live sweep. */
  today?: string;
  concurrency?: number;
  days?: number;
  /** Awaited before each request; lets the caller hold the backfill while a sweep runs. */
  pause?: () => Promise<void>;
  aborted?: () => boolean;
  write?: (rows: IvDay[]) => void;
};

export function dailyCloses(symbol: string, limit: number): DayClose[] {
  const rows = db.prepare("SELECT day, close FROM daily_bars WHERE symbol = ? ORDER BY day DESC LIMIT ?").all(symbol, limit) as DayClose[];
  return rows.reverse();
}

export type BackfillResult = { symbol: string; rows: number; days: number; contracts: number; requests: number; ms: number };

export async function backfillUnderlying(symbol: string, deps: BackfillDeps = {}): Promise<BackfillResult> {
  const started = Date.now();
  const stats = { requests: 0 };
  const nDays = deps.days ?? BACKFILL_DAYS;
  const today = deps.today ?? tradingDay(Date.now() / 1000);
  const all = (deps.closes ?? ((s) => dailyCloses(s, nDays + 40)))(symbol);
  const targets = all.filter((c) => c.day < today && isTradingDay(c.day)).slice(-nDays);
  if (targets.length === 0) return { symbol, rows: 0, days: 0, contracts: 0, requests: 0, ms: 0 };

  // The calendar tells holiday monthly expiries; load the years involved.
  for (const y of new Set(targets.map((t) => Number(t.day.slice(0, 4))).concat(Number(targets[targets.length - 1].day.slice(0, 4)) + 1))) await ensureCalendar(y);

  // Every contract worth asking about, and the first and last day it is needed.
  const plan = targets.map((t) => ({ ...t, expiries: bracketExpiries(t.day) }));
  const needed = new Map<string, { first: string; last: string }>();
  for (const p of plan) {
    for (const expiry of p.expiries) {
      for (const strike of candidateStrikes(p.close)) {
        for (const right of ["call", "put"] as const) {
          const occ = buildOcc(symbol, expiry, right, strike);
          const n = needed.get(occ);
          if (!n) needed.set(occ, { first: p.day, last: p.day });
          else if (p.day > n.last) n.last = p.day;
          else if (p.day < n.first) n.first = p.day;
        }
      }
    }
  }
  const wanted = new Set(plan.map((p) => p.day));
  const symbols = [...needed.keys()].sort((a, b) => needed.get(a)!.first.localeCompare(needed.get(b)!.first));
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += BATCH_SYMBOLS) chunks.push(symbols.slice(i, i + BATCH_SYMBOLS));

  const store = new Map<string, Map<string, OptionDayBar>>();
  const fetchBars = deps.bars ?? ((s, a, b, st) => optionDailyBars(s, a, b, st));
  await mapWithConcurrency(chunks, deps.concurrency ?? 2, async (chunk) => {
    if (deps.aborted?.()) return;
    await deps.pause?.();
    const start = chunk.reduce((m, o) => (needed.get(o)!.first < m ? needed.get(o)!.first : m), "9999-12-31");
    const last = chunk.reduce((m, o) => (needed.get(o)!.last > m ? needed.get(o)!.last : m), "0000-01-01");
    const end = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const got = await fetchBars(chunk, start, end, stats);
    for (const [occ, bars] of Object.entries(got)) {
      const m = new Map<string, OptionDayBar>();
      for (const b of bars) {
        const d = b.t.slice(0, 10);
        if (wanted.has(d)) m.set(d, b);
      }
      store.set(occ, m);
    }
  });

  const rows: IvDay[] = [];
  const closes = all.map((c) => c.close);
  const index = new Map(all.map((c, i) => [c.day, i]));
  for (const p of plan) {
    const { iv30 } = dayIv(symbol, p.day, p.close, p.expiries, (occ, d) => store.get(occ)?.get(d));
    if (iv30 === null) continue;
    const i = index.get(p.day)!;
    rows.push({ symbol, day: p.day, iv30, atmIv: null, hv20: historicalVol(closes.slice(0, i + 1)) });
  }
  (deps.write ?? upsertBackfillDays)(rows);
  return { symbol, rows: rows.length, days: plan.length, contracts: symbols.length, requests: stats.requests, ms: Date.now() - started };
}

export type BackfillStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  current: string | null;
  rows: number;
  requests: number;
  errors: Array<{ symbol: string; message: string }>;
};

/** Backfill several underlyings one after another, yielding to the event loop between them. */
export async function backfillMany(symbols: string[], deps: BackfillDeps, status: BackfillStatus): Promise<void> {
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, total: symbols.length, done: 0, current: null, rows: 0, requests: 0, errors: [] });
  try {
    for (const s of symbols) {
      if (deps.aborted?.()) break;
      status.current = s;
      try {
        const r = await backfillUnderlying(s, deps);
        status.rows += r.rows;
        status.requests += r.requests;
        console.log(`[options] iv backfill ${s}: ${r.rows}/${r.days} days, ${r.requests} requests, ${r.ms} ms`);
      } catch (err) {
        status.errors.push({ symbol: s, message: err instanceof Error ? err.message : String(err) });
      }
      status.done++;
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    status.running = false;
    status.current = null;
    status.finishedAt = new Date().toISOString();
  }
}

export const newBackfillStatus = (): BackfillStatus => ({ running: false, startedAt: null, finishedAt: null, total: 0, done: 0, current: null, rows: 0, requests: 0, errors: [] });
