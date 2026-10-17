import * as alpaca from "../providers/alpaca.js";
import * as fred from "../providers/fred.js";
import { allWatchlistSymbols } from "../routes/watchlists.js";
import { db } from "../db.js";
import {
  activeSymbols,
  clearSynced,
  deleteDailyHistory,
  deleteMinuteHistory,
  finishRun,
  indexSymbols,
  lastDailyBar,
  lastMinuteTs,
  markSynced,
  saveIndexMembers,
  saveUniverse,
  startRun,
  upsertDailyBars,
  upsertMinuteBars,
  type DailyBar,
  type MinuteBar,
} from "./store.js";
import { tradingDay } from "./time.js";
import { CONTEXT_ETFS, nasdaq100, sp500, usListings } from "./universe.js";

export type BarSource = typeof alpaca.stockBars;

const DAILY_BATCH = 100;
const MINUTE_BATCH = 10;
// A stored close that moves by more than this when re-fetched means Alpaca
// re-adjusted the history (a new split), so the symbol is reloaded in full.
const SPLIT_TOLERANCE = 0.005;

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

export type SyncResult = { symbols: number; bars: number; resplit: string[]; errors: string[] };

/**
 * Bring daily bars up to date. New symbols get `years` of history; known ones
 * re-fetch from their last stored day, which also catches splits: if that
 * overlapping day's close changed, the symbol's history is reloaded.
 */
export async function syncDaily(
  symbols: string[],
  opts: { years?: number; now?: Date; source?: BarSource } = {}
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? alpaca.stockBars;
  const backfillStart = yearsAgo(opts.years ?? 10, now);
  const result: SyncResult = { symbols: 0, bars: 0, resplit: [], errors: [] };

  const lastBySymbol = new Map(symbols.map((s) => [s, lastDailyBar(s)]));
  const groups = groupBy(symbols, (s) => lastBySymbol.get(s)?.day ?? backfillStart);

  const reload: string[] = [];
  for (const [start, group] of groups) {
    for (const batch of chunk(group, DAILY_BATCH)) {
      try {
        const seen = new Set<string>();
        for await (const page of source({ symbols: batch, timeframe: "1Day", start })) {
          const rows: DailyBar[] = [];
          for (const [symbol, bars] of Object.entries(page)) {
            const prev = lastBySymbol.get(symbol);
            for (const b of bars) {
              const day = tradingDay(b.t);
              if (prev && day === prev.day && Math.abs(b.c - prev.close) / prev.close > SPLIT_TOLERANCE) {
                reload.push(symbol);
                break;
              }
              rows.push({ symbol, day, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? null, trades: b.n ?? null });
            }
            if (bars.length > 0) seen.add(symbol);
          }
          const kept = rows.filter((r) => !reload.includes(r.symbol));
          upsertDailyBars(kept);
          result.bars += kept.length;
        }
        for (const s of seen) {
          if (reload.includes(s)) continue;
          const last = lastDailyBar(s);
          if (last) markSynced("daily", s, last.day);
          result.symbols++;
        }
      } catch (err) {
        result.errors.push(`daily ${batch[0]}..${batch[batch.length - 1]}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  for (const symbol of [...new Set(reload)]) {
    deleteDailyHistory(symbol);
    clearSynced("daily", symbol);
    result.resplit.push(symbol);
    const again = await syncDaily([symbol], { ...opts, now });
    result.bars += again.bars;
    result.errors.push(...again.errors);
  }
  return result;
}

/**
 * Bring minute bars up to date (regular and extended hours). New symbols get
 * `years` of history. Symbols in `reload` (re-split by syncDaily) start over.
 */
export async function syncMinute(
  symbols: string[],
  opts: { years?: number; now?: Date; source?: BarSource; reload?: string[] } = {}
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? alpaca.stockBars;
  const backfillStart = `${yearsAgo(opts.years ?? 2, now)}T00:00:00Z`;
  const result: SyncResult = { symbols: 0, bars: 0, resplit: [], errors: [] };

  for (const s of opts.reload ?? []) {
    if (!symbols.includes(s)) continue;
    deleteMinuteHistory(s);
    clearSynced("minute", s);
  }

  // Resume each symbol from the start of the New York day of its last bar, so
  // a sync that died mid-day refills that day; upserts make the overlap harmless.
  const startFor = (s: string) => {
    const ts = lastMinuteTs(s);
    return ts === null ? backfillStart : `${tradingDay(ts)}T00:00:00-05:00`;
  };
  const groups = groupBy(symbols, startFor);

  for (const [start, group] of groups) {
    for (const batch of chunk(group, MINUTE_BATCH)) {
      try {
        for await (const page of source({ symbols: batch, timeframe: "1Min", start: new Date(start).toISOString() })) {
          const rows: MinuteBar[] = [];
          for (const [symbol, bars] of Object.entries(page)) {
            for (const b of bars) {
              rows.push({
                symbol,
                ts: Math.floor(Date.parse(b.t) / 1000),
                open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? null, trades: b.n ?? null,
              });
            }
          }
          upsertMinuteBars(rows);
          result.bars += rows.length;
        }
        for (const s of batch) {
          const ts = lastMinuteTs(s);
          if (ts !== null) {
            markSynced("minute", s, new Date(ts * 1000).toISOString());
            result.symbols++;
          }
        }
      } catch (err) {
        result.errors.push(`minute ${batch[0]}..${batch[batch.length - 1]}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
    // A truncated download must not mark thousands of symbols inactive.
    if (rows.length < 5000) throw new Error(`only ${rows.length} listings returned`);
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

/** Symbols kept at minute resolution: watchlists, S&P 500, Nasdaq-100, context ETFs. */
export function minuteUniverse(): string[] {
  return [...new Set([...allWatchlistSymbols(), ...indexSymbols(), ...CONTEXT_ETFS])].filter((s) => !s.startsWith("^")).sort();
}

/** Symbols kept at daily resolution: everything active plus the minute set. */
export function dailyUniverse(): string[] {
  return [...new Set([...activeSymbols(), ...minuteUniverse()])].sort();
}

function isRunning(): boolean {
  // Another process (the CLI or the server's nightly job) may be syncing; a
  // run older than 12 hours is assumed dead.
  const row = db
    .prepare("SELECT id FROM history_runs WHERE status = 'running' AND started_at > datetime('now', '-12 hours') LIMIT 1")
    .get();
  return Boolean(row);
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
  if (isRunning()) return { status: "skipped", detail: "another history sync is running" };
  const id = startRun(job);
  let symbols = 0;
  let bars = 0;
  const errors: string[] = [];
  try {
    if (job === "universe" || job === "all") {
      const u = await refreshUniverse();
      log(`universe: ${u.listings} listings, ${u.sp500} S&P 500, ${u.nasdaq100} Nasdaq-100`);
      errors.push(...u.errors);
    }
    let resplit: string[] = [];
    if (job === "daily" || job === "all") {
      const list = dailyUniverse();
      log(`daily: syncing ${list.length} symbols`);
      const d = await syncDaily(list, { years: opts.dailyYears });
      symbols += d.symbols;
      bars += d.bars;
      resplit = d.resplit;
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
      const m = await syncMinute(list, { years: opts.minuteYears, reload: resplit });
      symbols += m.symbols;
      bars += m.bars;
      errors.push(...m.errors);
      log(`minute: ${m.bars} bars`);
    }
    // "partial": some steps or batches failed but others stored bars.
    const status = errors.length === 0 ? "ok" : bars === 0 ? "error" : "partial";
    finishRun(id, { status, symbols, bars, error: errors.length ? errors.slice(0, 20).join("\n") : undefined });
    for (const e of errors) log(`error: ${e}`);
    return { status, detail: { symbols, bars, errors } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishRun(id, { status: "error", symbols, bars, error: message });
    return { status: "error", detail: message };
  }
}
