import * as alpaca from "../providers/alpaca.js";
import * as fred from "../providers/fred.js";
import { allWatchlistSymbols } from "../routes/watchlists.js";
import {
  abandonStaleRuns,
  activeSymbols,
  clearSynced,
  finishRun,
  firstDailyDay,
  firstMinuteTs,
  flagMinuteReload,
  heartbeat,
  indexSymbols,
  lastDailyBar,
  lastMinuteTs,
  liveRun,
  markSynced,
  minuteReloads,
  saveIndexMembers,
  saveUniverse,
  settledDailyBar,
  startRun,
  upsertDailyBars,
  upsertMinuteBars,
  type DailyBar,
  type MinuteBar,
} from "./store.js";
import { tradingDay } from "./time.js";
import { alpacaSymbol, CONTEXT_ETFS, nasdaq100, sp500, usListings } from "./universe.js";

export type BarSource = typeof alpaca.stockBars;

const DAILY_BATCH = 100;
const MINUTE_BATCH = 10;
// A stored close that moves by more than this when re-fetched means Alpaca
// re-adjusted the history (a new split), so the symbol is reloaded in full.
const SPLIT_TOLERANCE = 0.005;
// A run that hasn't sent a heartbeat for this long is assumed dead.
const RUN_STALE_MINUTES = 30;

let currentRun: number | null = null;
function beat(): void {
  if (currentRun !== null) heartbeat(currentRun);
}

function yearsAgo(years: number, now: Date): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Run `fn` on each batch. A failed batch is retried one symbol at a time, so
 * one symbol Alpaca rejects doesn't hold back the rest of its batch.
 */
async function eachBatch(
  label: string,
  symbols: string[],
  size: number,
  fn: (batch: string[]) => Promise<void>,
  errors: string[]
): Promise<void> {
  for (const batch of chunk(symbols, size)) {
    try {
      await fn(batch);
    } catch (err) {
      if (batch.length === 1) {
        errors.push(`${label} ${batch[0]}: ${message(err)}`);
        continue;
      }
      for (const s of batch) {
        try {
          await fn([s]);
        } catch (e) {
          errors.push(`${label} ${s}: ${message(e)}`);
        }
      }
    }
  }
}

const toDaily = (symbol: string, b: alpaca.Bar): DailyBar => ({
  symbol, day: tradingDay(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? null, trades: b.n ?? null,
});

const toMinute = (symbol: string, b: alpaca.Bar): MinuteBar => ({
  symbol, ts: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? null, trades: b.n ?? null,
});

export type SyncResult = { symbols: number; bars: number; resplit: string[]; errors: string[] };

/**
 * Bring daily bars up to date. New symbols get `years` of history; known ones
 * re-fetch from their second-newest stored day, a bar that is final. If that
 * day's close changed, Alpaca re-adjusted the history for a split, and the
 * symbol's whole stored range is downloaded again and overwritten in place.
 */
export async function syncDaily(
  symbols: string[],
  opts: { years?: number; now?: Date; source?: BarSource } = {}
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? alpaca.stockBars;
  const backfillStart = yearsAgo(opts.years ?? 10, now);
  const result: SyncResult = { symbols: 0, bars: 0, resplit: [], errors: [] };

  const settled = new Map(symbols.map((s) => [s, settledDailyBar(s)]));
  const groups = groupBy(symbols, (s) => settled.get(s)?.day ?? backfillStart);
  const reload = new Set<string>();

  for (const [start, group] of groups) {
    await eachBatch("daily", group, DAILY_BATCH, async (batch) => {
      const seen = new Set<string>();
      for await (const page of source({ symbols: batch, timeframe: "1Day", start })) {
        beat();
        const rows: DailyBar[] = [];
        for (const [symbol, bars] of Object.entries(page)) {
          if (reload.has(symbol)) continue;
          const prev = settled.get(symbol);
          const moved = prev && bars.some((b) => tradingDay(b.t) === prev.day && Math.abs(b.c - prev.close) / prev.close > SPLIT_TOLERANCE);
          if (moved) {
            reload.add(symbol);
            continue;
          }
          for (const b of bars) rows.push(toDaily(symbol, b));
          if (bars.length > 0) seen.add(symbol);
        }
        upsertDailyBars(rows);
        result.bars += rows.length;
      }
      for (const s of seen) {
        if (reload.has(s)) continue;
        const last = lastDailyBar(s);
        if (last) markSynced("daily", s, last.day);
        result.symbols++;
      }
    }, result.errors);
  }

  // Overwrite rather than delete first, so a failed download leaves the old
  // bars in place; the next run sees the same mismatch and tries again.
  for (const symbol of reload) {
    flagMinuteReload(symbol);
    const from = firstDailyDay(symbol) ?? backfillStart;
    try {
      for await (const page of source({ symbols: [symbol], timeframe: "1Day", start: from < backfillStart ? from : backfillStart })) {
        beat();
        const rows = (page[symbol] ?? []).map((b) => toDaily(symbol, b));
        upsertDailyBars(rows);
        result.bars += rows.length;
      }
      const last = lastDailyBar(symbol);
      if (last) markSynced("daily", symbol, last.day);
      result.resplit.push(symbol);
      result.symbols++;
    } catch (err) {
      result.errors.push(`daily reload ${symbol}: ${message(err)}`);
    }
  }
  return result;
}

/**
 * Bring minute bars up to date (regular and extended hours). New symbols get
 * `years` of history. Symbols the daily sync flagged for a split are
 * downloaded again over their whole stored range.
 */
export async function syncMinute(
  symbols: string[],
  opts: { years?: number; now?: Date; source?: BarSource } = {}
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? alpaca.stockBars;
  const backfillStart = `${yearsAgo(opts.years ?? 2, now)}T00:00:00Z`;
  const result: SyncResult = { symbols: 0, bars: 0, resplit: [], errors: [] };
  const pending = new Set(minuteReloads());

  // Resume each symbol from the start of the New York day of its last bar, so
  // a sync that died mid-day refills that day; upserts make the overlap harmless.
  const startFor = (s: string) => {
    if (pending.has(s)) {
      const first = firstMinuteTs(s);
      return first === null ? backfillStart : new Date(first * 1000).toISOString();
    }
    const ts = lastMinuteTs(s);
    return ts === null ? backfillStart : `${tradingDay(ts)}T00:00:00-05:00`;
  };
  const groups = groupBy(symbols, startFor);

  for (const [start, group] of groups) {
    await eachBatch("minute", group, MINUTE_BATCH, async (batch) => {
      for await (const page of source({ symbols: batch, timeframe: "1Min", start: new Date(start).toISOString() })) {
        beat();
        const rows: MinuteBar[] = [];
        for (const [symbol, bars] of Object.entries(page)) for (const b of bars) rows.push(toMinute(symbol, b));
        upsertMinuteBars(rows);
        result.bars += rows.length;
      }
      for (const s of batch) {
        if (pending.has(s)) {
          clearSynced("minute_reload", s);
          result.resplit.push(s);
        }
        const ts = lastMinuteTs(s);
        if (ts !== null) {
          markSynced("minute", s, new Date(ts * 1000).toISOString());
          result.symbols++;
        }
      }
    }, result.errors);
  }
  return result;
}

/** VIX is an index, not a tradable symbol, so its daily close comes from FRED. */
export async function syncVix(years = 10): Promise<number> {
  const points = await fred.series("VIXCLS", years * 262);
  upsertDailyBars(
    points.map((p) => ({ symbol: "^VIX", day: p.date, open: p.value, high: p.value, low: p.value, close: p.value, volume: 0, vwap: null, trades: null }))
  );
  if (points.length > 0) markSynced("daily", "^VIX", points[points.length - 1].date);
  return points.length;
}

export async function refreshUniverse(): Promise<{ listings: number; sp500: number; nasdaq100: number; errors: string[] }> {
  const errors: string[] = [];
  let listings = 0;
  try {
    const rows = await usListings();
    // A truncated download must not mark thousands of symbols inactive: the
    // list may shrink by a few delistings, not by a tenth of the market.
    const known = activeSymbols().length;
    if (rows.length < 5000 || rows.length < known * 0.9) {
      throw new Error(`only ${rows.length} listings returned (${known} active); keeping the current list`);
    }
    saveUniverse(rows);
    listings = rows.length;
  } catch (err) {
    errors.push(`listings: ${err instanceof Error ? err.message : String(err)}`);
  }
  const members = async (name: string, fn: () => Promise<string[]>, column: "in_sp500" | "in_nasdaq100") => {
    try {
      const symbols = await fn();
      saveIndexMembers(column, symbols);
      return symbols.length;
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  };
  return {
    listings,
    sp500: await members("sp500", sp500, "in_sp500"),
    nasdaq100: await members("nasdaq100", nasdaq100, "in_nasdaq100"),
    errors,
  };
}

/**
 * Symbols kept at minute resolution: watchlists, S&P 500, Nasdaq-100, context
 * ETFs. Watchlists hold Yahoo-style tickers, so they are mapped to Alpaca's
 * (BRK-B → BRK.B) and those Alpaca has no stock bars for (^GSPC, EURUSD=X,
 * GC=F, 0700.HK, BTC-USD) are left out.
 */
export function minuteUniverse(): string[] {
  const watched = allWatchlistSymbols().map(alpacaSymbol).filter((s): s is string => s !== null);
  return [...new Set([...watched, ...indexSymbols(), ...CONTEXT_ETFS])].sort();
}

/** Symbols kept at daily resolution: everything active plus the minute set. */
export function dailyUniverse(): string[] {
  return [...new Set([...activeSymbols(), ...minuteUniverse()])].sort();
}

/** Record the current run as stopped (the CLI calls this on Ctrl-C). */
export function interruptRun(reason: string): void {
  if (currentRun === null) return;
  finishRun(currentRun, { status: "error", symbols: 0, bars: 0, error: reason });
  currentRun = null;
}

export type JobName = "universe" | "daily" | "minute" | "all";

/**
 * Run a job with run bookkeeping and a cross-process guard. `minute: false`
 * makes "all" stop after universe + daily (HISTORY_SYNC_MINUTE=0).
 */
export async function runJob(
  job: JobName,
  opts: { dailyYears?: number; minuteYears?: number; minute?: boolean; log?: (msg: string) => void } = {}
): Promise<{ status: "ok" | "partial" | "error" | "skipped"; detail: unknown }> {
  const log = opts.log ?? (() => {});
  // Another process (the CLI or the server's nightly job) may be syncing. A
  // run that stopped sending heartbeats (killed, crashed) is closed out.
  abandonStaleRuns(RUN_STALE_MINUTES);
  if (liveRun(RUN_STALE_MINUTES)) return { status: "skipped", detail: "another history sync is running" };
  const id = startRun(job);
  currentRun = id;
  let symbols = 0;
  let bars = 0;
  let alpacaBars = 0;
  const errors: string[] = [];
  try {
    if (job === "universe" || job === "all") {
      const u = await refreshUniverse();
      log(`universe: ${u.listings} listings, ${u.sp500} S&P 500, ${u.nasdaq100} Nasdaq-100`);
      errors.push(...u.errors);
    }
    if (job === "daily" || job === "all") {
      const list = dailyUniverse();
      log(`daily: syncing ${list.length} symbols`);
      const d = await syncDaily(list, { years: opts.dailyYears });
      symbols += d.symbols;
      bars += d.bars;
      alpacaBars += d.bars;
      errors.push(...d.errors);
      try {
        bars += await syncVix(opts.dailyYears);
      } catch (err) {
        errors.push(`vix: ${err instanceof Error ? err.message : String(err)}`);
      }
      log(`daily: ${d.bars} bars, ${d.resplit.length} re-split`);
    }
    if (job === "minute" || (job === "all" && opts.minute !== false)) {
      const list = minuteUniverse();
      log(`minute: syncing ${list.length} symbols`);
      const m = await syncMinute(list, { years: opts.minuteYears });
      symbols += m.symbols;
      bars += m.bars;
      alpacaBars += m.bars;
      errors.push(...m.errors);
      log(`minute: ${m.bars} bars`);
    }
    // "partial": some steps or symbols failed but Alpaca bars were stored.
    // VIX alone doesn't count: it re-stores the same ~2,600 FRED points daily.
    const status = errors.length === 0 ? "ok" : alpacaBars === 0 ? "error" : "partial";
    finishRun(id, { status, symbols, bars, error: errors.length ? errors.slice(0, 20).join("\n") : undefined });
    for (const e of errors) log(`error: ${e}`);
    return { status, detail: { symbols, bars, errors } };
  } catch (err) {
    finishRun(id, { status: "error", symbols, bars, error: message(err) });
    return { status: "error", detail: message(err) };
  } finally {
    currentRun = null;
  }
}
