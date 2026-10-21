import { tradingDay } from "../history/time.js";
import { nyInstant } from "../live/session.js";

// Indicators over OHLCV bars, for the scorecards. The series functions keep
// the semantics of web/lib/indicators.ts (same warm-up trimming, same
// smoothing, population variance for Bollinger), so a chart and a score agree;
// the rest (atr, adx, returns, relativeVolume, rollup) are new. Bars carry
// `time` (daily/web candles) or `ts` (minute_bars, unix seconds).

export type Bar = { time?: number; ts?: number; open: number; high: number; low: number; close: number; volume: number };
export type Point = { time: number; value: number };

const timeOf = (b: Bar, i: number) => b.time ?? b.ts ?? i;

/** The last value of a series, or null when it is empty. */
export function last(points: Point[]): number | null {
  return points.length > 0 ? points[points.length - 1].value : null;
}

export function sma(bars: Bar[], period: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: timeOf(bars[i], i), value: sum / period });
  }
  return out;
}

/** Seeded with the first close, so the first `period - 1` points (not yet settled) are dropped, as on the chart. */
export function ema(bars: Bar[], period: number): Point[] {
  const out: Point[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  bars.forEach((b, i) => {
    prev = prev === null ? b.close : b.close * k + prev * (1 - k);
    out.push({ time: timeOf(b, i), value: prev });
  });
  return out.slice(period - 1);
}

/** Cumulative VWAP from the first bar given (pass one session's bars). */
export function vwap(bars: Bar[]): Point[] {
  const out: Point[] = [];
  let cumPV = 0;
  let cumV = 0;
  bars.forEach((b, i) => {
    cumPV += ((b.high + b.low + b.close) / 3) * b.volume;
    cumV += b.volume;
    if (cumV > 0) out.push({ time: timeOf(b, i), value: cumPV / cumV });
  });
  return out;
}

/** Wilder's RSI. */
export function rsi(bars: Bar[], period = 14): Point[] {
  const out: Point[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out.push({ time: timeOf(bars[i], i), value: 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)) });
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out.push({ time: timeOf(bars[i], i), value: 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)) });
    }
  }
  return out;
}

export function macd(bars: Bar[], fast = 12, slow = 26, signal = 9): { macd: Point[]; signal: Point[]; histogram: Point[] } {
  const emaAll = (period: number): number[] => {
    const k = 2 / (period + 1);
    const vals: number[] = [];
    let prev: number | null = null;
    for (const b of bars) {
      prev = prev === null ? b.close : b.close * k + prev * (1 - k);
      vals.push(prev);
    }
    return vals;
  };
  const fastE = emaAll(fast);
  const slowE = emaAll(slow);
  const macdLine: Point[] = bars.map((b, i) => ({ time: timeOf(b, i), value: fastE[i] - slowE[i] })).slice(slow - 1);
  const k = 2 / (signal + 1);
  let prev: number | null = null;
  const signalLine: Point[] = macdLine.map((p) => {
    prev = prev === null ? p.value : p.value * k + prev * (1 - k);
    return { time: p.time, value: prev };
  });
  const histogram = macdLine.map((p, i) => ({ time: p.time, value: p.value - signalLine[i].value }));
  return { macd: macdLine, signal: signalLine, histogram };
}

export function bollinger(bars: Bar[], period = 20, mult = 2): { upper: Point[]; middle: Point[]; lower: Point[] } {
  const middle = sma(bars, period);
  const upper: Point[] = [];
  const lower: Point[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    const mean = middle[i - period + 1].value;
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (bars[j].close - mean) ** 2;
    const sd = Math.sqrt(ss / period);
    upper.push({ time: timeOf(bars[i], i), value: mean + mult * sd });
    lower.push({ time: timeOf(bars[i], i), value: mean - mult * sd });
  }
  return { upper, middle, lower };
}

function trueRange(bars: Bar[], i: number): number {
  const b = bars[i];
  if (i === 0) return b.high - b.low;
  const pc = bars[i - 1].close;
  return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
}

/** Wilder's average true range: the first value is the mean of the first `period` true ranges. */
export function atr(bars: Bar[], period = 14): Point[] {
  const out: Point[] = [];
  let prev = 0;
  for (let i = 0; i < bars.length; i++) {
    const tr = trueRange(bars, i);
    if (i < period - 1) prev += tr;
    else if (i === period - 1) {
      prev = (prev + tr) / period;
      out.push({ time: timeOf(bars[i], i), value: prev });
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out.push({ time: timeOf(bars[i], i), value: prev });
    }
  }
  return out;
}

/** Wilder's ADX with the directional indicators; the first ADX is at bar index `2 * period - 1`. */
export function adx(bars: Bar[], period = 14): { adx: Point[]; plusDi: Point[]; minusDi: Point[] } {
  const out = { adx: [] as Point[], plusDi: [] as Point[], minusDi: [] as Point[] };
  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  let adxPrev = 0;
  let dxSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const tr = trueRange(bars, i);
    if (i <= period) {
      smTr += tr;
      smPlus += plus;
      smMinus += minus;
      if (i < period) continue;
    } else {
      smTr = smTr - smTr / period + tr;
      smPlus = smPlus - smPlus / period + plus;
      smMinus = smMinus - smMinus / period + minus;
    }
    const pdi = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const mdi = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    const time = timeOf(bars[i], i);
    out.plusDi.push({ time, value: pdi });
    out.minusDi.push({ time, value: mdi });
    const n = out.plusDi.length; // DX values so far
    if (n < period) dxSum += dx;
    else if (n === period) {
      adxPrev = (dxSum + dx) / period;
      out.adx.push({ time, value: adxPrev });
    } else {
      adxPrev = (adxPrev * (period - 1) + dx) / period;
      out.adx.push({ time, value: adxPrev });
    }
  }
  return out;
}

/** `n`-bar simple returns (0.02 = +2%), one per bar from the nth on. */
export function returns(bars: Bar[], n = 1): Point[] {
  const out: Point[] = [];
  for (let i = n; i < bars.length; i++) {
    if (bars[i - n].close > 0) out.push({ time: timeOf(bars[i], i), value: bars[i].close / bars[i - n].close - 1 });
  }
  return out;
}

/** Return over the last `n` values (closes, oldest first), or null with too little history. */
export function periodReturn(closes: number[], n: number): number | null {
  const then = closes[closes.length - 1 - n];
  const now = closes[closes.length - 1];
  return then > 0 && now !== undefined ? now / then - 1 : null;
}

/** Each bar's volume over the mean of the `lookback` bars before it. */
export function relativeVolume(bars: Bar[], lookback = 20): Point[] {
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= lookback) {
      const mean = sum / lookback;
      if (mean > 0) out.push({ time: timeOf(bars[i], i), value: bars[i].volume / mean });
      sum -= bars[i - lookback].volume;
    }
    sum += bars[i].volume;
  }
  return out;
}

const SESSION_SECONDS = 390 * 60;

/**
 * Minute bars (`ts` = bar start, unix seconds, oldest first) combined into
 * `minutes`-minute bars whose edges start at each day's 09:30 New York open
 * (60 minutes: 09:30, 10:30, ... 15:30). Bars outside the regular session are
 * dropped; the last bucket may be partial. The result's `ts` is the bucket start.
 */
export function rollup(minuteBars: Bar[], minutes: number): Bar[] {
  const size = minutes * 60;
  const out: Bar[] = [];
  let open = 0; // unix seconds of the cached day's 09:30
  let cur: Bar | null = null;
  let curStart = -1;
  for (const m of minuteBars) {
    const ts = m.ts ?? m.time ?? 0;
    if (ts < open || ts >= open + SESSION_SECONDS) {
      open = nyInstant(tradingDay(ts), 9, 30) / 1000;
      if (ts < open || ts >= open + SESSION_SECONDS) continue;
    }
    const start = open + Math.floor((ts - open) / size) * size;
    if (cur && start === curStart) {
      cur.high = Math.max(cur.high, m.high);
      cur.low = Math.min(cur.low, m.low);
      cur.close = m.close;
      cur.volume += m.volume;
    } else {
      cur = { ts: start, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume };
      curStart = start;
      out.push(cur);
    }
  }
  return out;
}
