import { mapWithConcurrency } from "../concurrency.js";
import { db } from "../db.js";
import { tradingDay } from "../history/time.js";
import { regularCloseAt } from "../live/session.js";
import { isTradingDay, sessionClose } from "../providers/alpaca-calendar.js";
import { optionSnapshots, parseOcc, type ChainFilter } from "../providers/alpaca-options.js";
import * as alpaca from "../providers/alpaca.js";
import type { OptionMetrics, OptionPosition } from "../scan/contracts.js";
import { greeks, impliedVol, midPrice, riskFreeRate, yearsToExpiry } from "./black-scholes.js";
import { daysBetween, selectContracts, type ExpiryStrikes, type Pair, type Selection } from "./selection.js";
import { ensureOpenInterest } from "./open-interest.js";
import { ivHistory, ivRank, saveOptionMetrics, upsertIvDay } from "./store.js";

// The 5-minute snapshot sweep: one chain snapshot per underlying (expiries up
// to OPTIONS_SWEEP_MAX_DTE, strikes within OPTIONS_SWEEP_STRIKE_RANGE of the
// price) turned into OptionMetrics, then the stream's contract selection.

export type SweepConfig = {
  maxDte: number;
  strikeRange: number;
  minDte: number;
  streamMax: number;
  concurrency: number;
};

const numEnv = (raw: string | undefined, fallback: number, min = 0): number => {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) && n > min ? n : fallback;
};

export function sweepConfig(env: NodeJS.ProcessEnv = process.env): SweepConfig {
  return {
    maxDte: Math.floor(numEnv(env.OPTIONS_SWEEP_MAX_DTE, 60)),
    strikeRange: numEnv(env.OPTIONS_SWEEP_STRIKE_RANGE, 0.15),
    minDte: Math.floor(numEnv(env.OPTIONS_STREAM_MIN_DTE, 7, -1)),
    streamMax: Math.floor(numEnv(env.OPTIONS_STREAM_MAX, 1000)),
    concurrency: Math.floor(numEnv(env.OPTIONS_SWEEP_CONCURRENCY, 4)),
  };
}

export type ParsedContract = {
  occ: string;
  expiry: string;
  right: "call" | "put";
  strike: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Turn raw snapshots into contracts with our own IV and delta from the quote mid (Alpaca's IV only appears with a fresh quote). */
export function parseSnapshots(snaps: Record<string, any>, price: number, nowMs: number, rate = riskFreeRate(), openInterest?: Map<string, number>): ParsedContract[] {
  const out: ParsedContract[] = [];
  for (const [occ, snap] of Object.entries(snaps)) {
    const p = parseOcc(occ);
    if (!p) continue;
    const bid = num(snap?.latestQuote?.bp);
    const ask = num(snap?.latestQuote?.ap);
    const mid = midPrice(bid, ask);
    const t = yearsToExpiry(p.expiry, nowMs, regularCloseAt);
    const base = { right: p.type, spot: price, strike: p.strike, t, rate };
    let iv = mid === null ? null : impliedVol(base, mid);
    iv ??= num(snap?.impliedVolatility);
    const delta = iv === null ? num(snap?.greeks?.delta) : greeks({ ...base, vol: iv }).delta;
    out.push({
      occ, expiry: p.expiry, right: p.type, strike: p.strike, bid, ask, mid,
      volume: num(snap?.dailyBar?.v), openInterest: openInterest?.get(occ) ?? num(snap?.openInterest), iv, delta,
    });
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** ATM implied vol for one expiry: each strike's call/put IV averaged, then interpolated across the two strikes around the price. */
export function atmIv(contracts: ParsedContract[], price: number): number | null {
  const byStrike = new Map<number, number[]>();
  for (const c of contracts) if (c.iv !== null) byStrike.set(c.strike, [...(byStrike.get(c.strike) ?? []), c.iv]);
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (strikes.length === 0) return null;
  const ivAt = (k: number) => mean(byStrike.get(k)!);
  const below = [...strikes].reverse().find((k) => k <= price);
  const above = strikes.find((k) => k >= price);
  if (below === undefined) return ivAt(above!);
  if (above === undefined || above === below) return ivAt(below);
  const w = (price - below) / (above - below);
  return ivAt(below) * (1 - w) + ivAt(above) * w;
}

export type Term = { days: number; iv: number };

/**
 * Constant-maturity IV at `targetDays`, interpolating total variance (iv² · T)
 * linearly between the expiries on either side. With one side only, that
 * expiry's IV is held flat. Null with no terms.
 */
export function constantMaturityIv(terms: Term[], targetDays: number): number | null {
  const sorted = [...terms].sort((a, b) => a.days - b.days);
  const lo = [...sorted].reverse().find((t) => t.days <= targetDays);
  const hi = sorted.find((t) => t.days >= targetDays);
  if (lo && hi && lo.days !== hi.days) {
    const w = (targetDays - lo.days) / (hi.days - lo.days);
    const variance = (1 - w) * lo.iv ** 2 * lo.days + w * hi.iv ** 2 * hi.days;
    return Math.sqrt(variance / targetDays);
  }
  return (lo ?? hi)?.iv ?? null;
}

/** Realised vol: stdev of daily log returns of the last `n` closes, annualised. */
export function historicalVol(closes: number[], n = 20): number | null {
  const c = closes.slice(-(n + 1));
  if (c.length < n + 1) return null;
  const r = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const m = mean(r);
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}

export function hv20FromDailyBars(symbol: string): number | null {
  const rows = db.prepare("SELECT close FROM daily_bars WHERE symbol = ? ORDER BY day DESC LIMIT 21").all(symbol) as Array<{ close: number }>;
  return historicalVol(rows.map((r) => r.close).reverse());
}

export const UNUSUAL_MIN_VOLUME = 500;
export const UNUSUAL_RATIO = 2;
/** Contracts expiring sooner than this many calendar days (0DTE, 1DTE) are skipped: their open interest means little next to intraday volume. */
export const UNUSUAL_MIN_DTE = 2;
/** Open interest under this makes the ratio meaningless. */
export const UNUSUAL_MIN_OI = 100;

/**
 * Contracts trading at least twice their open interest and at least 500 lots.
 * Open interest comes from the contract reference data (open-interest.ts);
 * a contract without it is never flagged. Highest volume/OI ratio first, top 10.
 */
export function unusualContracts(contracts: ParsedContract[], today: string): OptionMetrics["unusual"] {
  return contracts
    .filter((c) => daysBetween(today, c.expiry) >= UNUSUAL_MIN_DTE)
    .filter((c) => (c.volume ?? 0) >= UNUSUAL_MIN_VOLUME && c.openInterest !== null && c.openInterest >= UNUSUAL_MIN_OI && c.volume! >= UNUSUAL_RATIO * c.openInterest)
    .sort((a, b) => b.volume! / b.openInterest! - a.volume! / a.openInterest!)
    .slice(0, 10)
    .map((c) => ({ occ: c.occ, volume: c.volume!, openInterest: c.openInterest, ratio: c.volume! / c.openInterest! }));
}

export type MetricsInput = {
  underlying: string;
  price: number | null;
  contracts: ParsedContract[];
  pair: Pair | null;
  nowMs: number;
  hv20: number | null;
  /** Prior days' iv30, oldest first, today excluded. */
  history: Array<number | null>;
  /** The stream's latest quote for a contract; used when under LIVE_QUOTE_MAX_AGE_MS old. */
  live?: (occ: string) => LiveContractQuote | null;
};

export type LiveContractQuote = { bid: number | null; ask: number | null; delta: number | null; at: number };
export const LIVE_QUOTE_MAX_AGE_MS = 2 * 60_000;

export function buildMetrics(i: MetricsInput): OptionMetrics {
  const { price, contracts, pair } = i;
  const nyToday = tradingDay(i.nowMs / 1000);

  const byExpiry = new Map<string, ParsedContract[]>();
  for (const c of contracts) byExpiry.set(c.expiry, [...(byExpiry.get(c.expiry) ?? []), c]);

  // Expiries under 3 days out are too noisy for the term structure.
  const terms: Term[] = [];
  if (price !== null) {
    for (const [expiry, list] of byExpiry) {
      const days = daysBetween(nyToday, expiry);
      const iv = atmIv(list, price);
      if (days >= 3 && iv !== null) terms.push({ days, iv });
    }
  }
  const iv30 = constantMaturityIv(terms, 30);

  const pairList = pair ? byExpiry.get(pair.expiry) ?? [] : [];
  const front = price !== null && pair ? atmIv(pairList, price) : null;
  // ATM IV at the expiry nearest 60 days, less the streamed pair's expiry, in vol points.
  let slope: number | null = null;
  if (price !== null && pair && front !== null) {
    const far = [...byExpiry.keys()].sort((a, b) => Math.abs(daysBetween(nyToday, a) - 60) - Math.abs(daysBetween(nyToday, b) - 60))[0];
    const farIv = far && far !== pair.expiry ? atmIv(byExpiry.get(far)!, price) : null;
    slope = farIv !== null ? (farIv - front) * 100 : null;
  }
  const call = pair ? pairList.find((c) => c.occ === pair.call) : undefined;
  const put = pair ? pairList.find((c) => c.occ === pair.put) : undefined;
  const straddle = call?.mid != null && put?.mid != null ? call.mid + put.mid : null;

  let callVol = 0;
  let putVol = 0;
  for (const c of contracts) {
    if (c.right === "call") callVol += c.volume ?? 0;
    else putVol += c.volume ?? 0;
  }

  const rank = ivRank(iv30, i.history);
  const quote = (c: ParsedContract | undefined) => {
    const live = c && i.live?.(c.occ);
    if (live && i.nowMs - live.at < LIVE_QUOTE_MAX_AGE_MS) return { bid: live.bid, ask: live.ask, delta: live.delta };
    return c ? { bid: c.bid, ask: c.ask, delta: c.delta } : null;
  };
  return {
    underlying: i.underlying,
    asOf: new Date(i.nowMs).toISOString(),
    price,
    atmExpiry: pair?.expiry ?? null,
    atmCall: pair?.call ?? null,
    atmPut: pair?.put ?? null,
    atmIv: front,
    iv30,
    ivRank: rank.ivRank,
    ivPercentile: rank.ivPercentile,
    ivHistoryDays: rank.days,
    hv20: i.hv20,
    impliedMovePct: straddle !== null && price ? (straddle / price) * 100 : null,
    termSlope: slope,
    putCallVolumeRatio: callVol > 0 ? putVol / callVol : null,
    unusual: unusualContracts(contracts, nyToday),
    atmCallQuote: quote(call),
    atmPutQuote: quote(put),
  };
}

export type SweepDeps = {
  underlyings: () => string[];
  holdings: () => OptionPosition[];
  /** Latest underlying prices. */
  prices?: (symbols: string[]) => Promise<Map<string, number>>;
  snapshots?: (underlying: string, filter: ChainFilter, stats: { requests: number }) => Promise<Record<string, any>>;
  hv20?: (symbol: string) => number | null;
  /** Today's open interest for the underlyings (cached per day); defaults to Alpaca's contract data. */
  openInterest?: (underlyings: string[], day: string, expiryMax: string, stats: { requests: number }) => Promise<Map<string, number>>;
  live?: (occ: string) => LiveContractQuote | null;
  now?: () => number;
  /** The last selection's pairs, for strike hysteresis. */
  previous?: () => Map<string, Pair>;
  config?: SweepConfig;
};

export type SweepResult = {
  startedAt: string;
  durationMs: number;
  underlyings: number;
  metrics: OptionMetrics[];
  selection: Selection;
  errors: Array<{ symbol: string; message: string }>;
  /** HTTP requests made (stock price snapshots plus option snapshot pages). */
  requests: number;
  prices: Map<string, number>;
};

async function stockPrices(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < symbols.length; i += 500) {
    const snaps = await alpaca.snapshots(symbols.slice(i, i + 500));
    for (const [s, snap] of Object.entries(snaps)) {
      const p = num(snap?.latestTrade?.p) ?? num(snap?.dailyBar?.c);
      if (p !== null) out.set(s, p);
    }
  }
  return out;
}

/** After 15:55 ET the sweep's iv30 is recorded as the day's value (later sweeps overwrite it). */
export function recordsIvDay(nowMs: number): boolean {
  const day = tradingDay(nowMs / 1000);
  const close = sessionClose(day);
  return isTradingDay(day) && nowMs >= close - 5 * 60_000 && nowMs <= close + 10 * 60_000;
}

export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const cfg = deps.config ?? sweepConfig();
  const now = deps.now ?? Date.now;
  const started = now();
  const holdings = deps.holdings();
  // deps.underlyings() arrives in priority order (holdings first); keep it.
  const underlyings = [...new Set(deps.underlyings())];
  const day = tradingDay(started / 1000);
  const errors: SweepResult["errors"] = [];

  const prices = await (deps.prices ?? stockPrices)(underlyings);
  const stats = { requests: Math.ceil(underlyings.length / 500) };
  const fetchSnaps = deps.snapshots ?? ((u, f, st) => optionSnapshots(u, f, undefined, st));
  const expiryMax = new Date(Date.parse(`${day}T00:00:00Z`) + cfg.maxDte * 86_400_000).toISOString().slice(0, 10);

  let oi = new Map<string, number>();
  try {
    oi = await (deps.openInterest ?? ((u, d, e, st) => ensureOpenInterest(u, d, e, st, started)))(underlyings, day, expiryMax, stats);
  } catch (err) {
    errors.push({ symbol: "open-interest", message: err instanceof Error ? err.message : String(err) });
  }

  const parsed = new Map<string, ParsedContract[]>();
  await mapWithConcurrency(underlyings.filter((u) => prices.has(u)), cfg.concurrency, async (u) => {
    const price = prices.get(u)!;
    try {
      const snaps = await fetchSnaps(u, {
        expiryMin: day, expiryMax,
        strikeMin: price * (1 - cfg.strikeRange), strikeMax: price * (1 + cfg.strikeRange),
      }, stats);
      parsed.set(u, parseSnapshots(snaps, price, started, undefined, oi));
    } catch (err) {
      errors.push({ symbol: u, message: err instanceof Error ? err.message : String(err) });
    }
  });

  const chains = new Map<string, ExpiryStrikes[]>();
  for (const [u, list] of parsed) {
    const byExpiry = new Map<string, Set<number>>();
    for (const c of list) byExpiry.set(c.expiry, (byExpiry.get(c.expiry) ?? new Set()).add(c.strike));
    chains.set(u, [...byExpiry].map(([expiry, s]) => ({ expiry, strikes: [...s] })));
  }
  const selection = selectContracts({
    underlyings, prices, chains, holdings, cap: cfg.streamMax, minDte: cfg.minDte, today: day, previous: deps.previous?.(),
  });

  const metrics: OptionMetrics[] = [];
  const hv = deps.hv20 ?? hv20FromDailyBars;
  for (const [u, contracts] of parsed) {
    const history = ivHistory(u, 252).filter((r) => r.day < day).map((r) => r.iv30);
    const m = buildMetrics({ underlying: u, price: prices.get(u) ?? null, contracts, pair: selection.pairs.get(u) ?? null, nowMs: started, hv20: hv(u), history, live: deps.live });
    saveOptionMetrics(m);
    if (recordsIvDay(started) && (m.iv30 !== null || m.atmIv !== null)) upsertIvDay({ symbol: u, day, iv30: m.iv30, atmIv: m.atmIv, hv20: m.hv20 });
    metrics.push(m);
  }
  return { startedAt: new Date(started).toISOString(), durationMs: now() - started, underlyings: underlyings.length, metrics, selection, errors, requests: stats.requests, prices };
}
