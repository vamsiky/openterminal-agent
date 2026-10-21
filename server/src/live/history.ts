import * as alpaca from "../providers/alpaca.js";
import type { Candle } from "../providers/types.js";
import { dailyBars } from "../history/store.js";
import { tradingDay } from "../history/time.js";
import { liveEntry } from "./feed.js";

// Chart candles for US stocks and ETFs from Alpaca instead of the free web
// sources: daily ranges from the locally stored history plus today's bar from
// the live feed, intraday ranges from Alpaca's bars API. The last candle
// always carries the latest live price.

const INTRADAY: Record<string, { timeframe: alpaca.Timeframe; lookbackDays: number; sessions: number }> = {
  "1D": { timeframe: "5Min", lookbackDays: 5, sessions: 1 },
  "5D": { timeframe: "15Min", lookbackDays: 9, sessions: 5 },
  "1M": { timeframe: "1Hour", lookbackDays: 31, sessions: Infinity },
};

const DAILY_DAYS: Record<string, number> = { "6M": 183, "1Y": 366, "5Y": 5 * 366, MAX: 100 * 366 };

const dayTime = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

function isoDaysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Group daily candles into weeks (Monday start) or months, keeping first open and last close. */
export function aggregate(candles: Candle[], by: "week" | "month"): Candle[] {
  const out: Candle[] = [];
  let key = "";
  for (const c of candles) {
    const d = new Date(c.time * 1000);
    const k = by === "month"
      ? d.toISOString().slice(0, 7)
      : new Date(c.time * 1000 - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const last = out.at(-1);
    if (k !== key || !last) {
      out.push({ ...c });
      key = k;
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}

/** Move the last candle to the latest live price (and add today's daily candle if it's missing). */
function withLivePrice(candles: Candle[], symbol: string, daily: boolean): Candle[] {
  const e = liveEntry(symbol);
  if (!e || candles.length === 0) return candles;
  const last = candles.at(-1)!;
  if (daily) {
    // Daily candles follow the live day bar, not every after-hours print.
    const close = e.closePrint ?? e.dayClose ?? e.regPrice;
    if (!e.barDay || e.open === null || close === null) return candles;
    const today = { time: dayTime(e.barDay), open: e.open, high: e.high ?? close, low: e.low ?? close, close, volume: e.volume ?? 0 };
    if (today.time > last.time) candles.push(today);
    else if (today.time === last.time) candles[candles.length - 1] = today;
    return candles;
  }
  // Intraday bars include the pre-market and after hours, so they follow every print.
  const tradeAt = e.tradeTime ? Date.parse(e.tradeTime) / 1000 : 0;
  if (e.price !== null && tradeAt >= last.time) {
    last.close = e.price;
    last.high = Math.max(last.high, e.price);
    last.low = Math.min(last.low, e.price);
  }
  return candles;
}

/**
 * Candles for `symbol` (an Alpaca symbol) over `rangeKey`, or null when there
 * is nothing local to serve (the caller then uses the other sources).
 */
export async function alpacaHistory(symbol: string, rangeKey: string, now = new Date()): Promise<Candle[] | null> {
  const intraday = INTRADAY[rangeKey];
  if (intraday) {
    if (!alpaca.isConfigured()) return null;
    const page = await alpaca.stockBarsPage({
      symbols: [symbol], timeframe: intraday.timeframe, start: isoDaysAgo(intraday.lookbackDays, now), limit: 10_000,
    });
    const bars = page.bars[symbol] ?? [];
    if (bars.length === 0) return null;
    const days = [...new Set(bars.map((b) => tradingDay(b.t)))];
    const keep = new Set(days.slice(-intraday.sessions));
    const candles = bars
      .filter((b) => keep.has(tradingDay(b.t)))
      .map((b) => ({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    return withLivePrice(candles, symbol, false);
  }

  const from = rangeKey === "YTD"
    ? `${tradingDay(now.getTime() / 1000).slice(0, 4)}-01-01`
    : isoDaysAgo(DAILY_DAYS[rangeKey] ?? DAILY_DAYS["6M"], now).slice(0, 10);
  const rows = dailyBars(symbol, from, "2999-12-31", 50_000);
  if (rows.length === 0) return null;
  let candles: Candle[] = rows.map((r) => ({ time: dayTime(r.day), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  candles = withLivePrice(candles, symbol, true);
  if (rangeKey === "5Y") return aggregate(candles, "week");
  if (rangeKey === "MAX") return aggregate(candles, "month");
  return candles;
}
