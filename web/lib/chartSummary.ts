import { fmt, fmtBig, type Candle } from "./api";
import type { Point } from "./indicators";

// Pure helpers for the chart's range summary line, crosshair readout and high/low markers.
// Intraday candles are labelled in New York time; daily and longer candles carry a UTC-midnight
// timestamp for their trading day, so they are labelled in UTC.

export type DailyBar = { day: string; open: number; high: number; low: number; close: number; volume: number };

export type RangeSummary = {
  label: string;
  change: number;
  pct: number | null;
  open: number;
  close: number;
  high: number;
  low: number;
  openWhen: string;
  closeWhen: string;
};

export type Readout = {
  when: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  pct: number | null;
  volume: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;

const etFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
});

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

export function etParts(ts: number): Parts {
  const p: Record<string, number> = {};
  for (const x of etFormat.formatToParts(new Date(ts * 1000))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute };
}

function utcParts(ts: number): Parts {
  const d = new Date(ts * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (ts: number, intraday: boolean) => (intraday ? etParts(ts) : utcParts(ts));

/** "2026-10-21", the New York date of an intraday timestamp. */
export function etDay(ts: number): string {
  const p = etParts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export const etClock = (ts: number): string => {
  const p = etParts(ts);
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

const etMinutes = (ts: number): number => {
  const p = etParts(ts);
  return p.hour * 60 + p.minute;
};

export const isRegularSession = (ts: number): boolean => {
  const m = etMinutes(ts);
  return m >= REGULAR_OPEN && m < REGULAR_CLOSE;
};

export function fmtDay(ts: number, intraday: boolean, withYear: boolean): string {
  const p = parts(ts, intraday);
  return `${MONTHS[p.month - 1]} ${p.day}${withYear ? `, ${p.year}` : ""}`;
}

/** "Oct 21, 2026 · 12:30 ET" for intraday bars, "Oct 21, 2026" for daily and longer. */
export function barWhen(ts: number, intraday: boolean, withYear = true): string {
  return intraday ? `${fmtDay(ts, true, withYear)} · ${etClock(ts)} ET` : fmtDay(ts, false, withYear);
}

/** True when the candles cross a calendar year, so dates need one. */
export function spansYears(candles: Candle[], intraday: boolean): boolean {
  if (candles.length === 0) return false;
  return parts(candles[0].time, intraday).year !== parts(candles[candles.length - 1].time, intraday).year;
}

export function readout(candles: Candle[], i: number, intraday: boolean): Readout | null {
  const c = candles[i];
  if (!c) return null;
  const base = i > 0 ? candles[i - 1].close : c.open;
  const change = c.close - base;
  return {
    when: barWhen(c.time, intraday),
    open: c.open, high: c.high, low: c.low, close: c.close,
    change, pct: base ? (change / base) * 100 : null,
    volume: c.volume,
  };
}

/** "+0.39 (+0.21%)" */
export function fmtMove(change: number, pct: number | null): string {
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
  const abs = (n: number) => fmt(Math.abs(n));
  return pct === null ? `${sign(change)}${abs(change)}` : `${sign(change)}${abs(change)} (${sign(pct)}${abs(pct)}%)`;
}

export const fmtVolume = (v: number): string => fmtBig(v);

/** Candles grouped by New York trading day, in order. */
function sessions(candles: Candle[]): Array<{ day: string; bars: Candle[] }> {
  const out: Array<{ day: string; bars: Candle[] }> = [];
  for (const c of candles) {
    const day = etDay(c.time);
    const last = out[out.length - 1];
    if (last && last.day === day) last.bars.push(c);
    else out.push({ day, bars: [c] });
  }
  return out;
}

function ohlc(bars: Candle[]) {
  return {
    open: bars[0].open,
    close: bars[bars.length - 1].close,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
  };
}

/** The day's official numbers, or the regular session's own candles while the day's bar isn't stored yet. */
function sessionOhlc(s: { day: string; bars: Candle[] }, daily: DailyBar[] | undefined) {
  const official = daily?.find((d) => d.day === s.day);
  if (official) return { open: official.open, close: official.close, high: official.high, low: official.low };
  const regular = s.bars.filter((b) => isRegularSession(b.time));
  return ohlc(regular.length > 0 ? regular : s.bars);
}

/**
 * The line above the plot. 1D and 5D use the official daily open/close/high/low of the sessions shown
 * (the intraday candles include pre-market and after hours); longer ranges use the candles themselves.
 */
export function rangeSummary(candles: Candle[], range: string, daily?: DailyBar[], now = Date.now() / 1000): RangeSummary | null {
  if (candles.length === 0) return null;
  const intradayRange = range === "1D" || range === "5D";
  const withYear = spansYears(candles, !intradayRange && range === "1M");
  let o: { open: number; close: number; high: number; low: number };
  let openWhen: string;
  let closeWhen: string;
  let label = range;

  if (intradayRange) {
    const ss = sessions(candles);
    const per = ss.map((s) => sessionOhlc(s, daily));
    o = {
      open: per[0].open,
      close: per[per.length - 1].close,
      high: Math.max(...per.map((p) => p.high)),
      low: Math.min(...per.map((p) => p.low)),
    };
    const first = ss[0];
    const last = ss[ss.length - 1];
    const lastBar = last.bars[last.bars.length - 1];
    const over = !(last.day === etDay(now) && etMinutes(now) < REGULAR_CLOSE);
    if (range === "1D") {
      openWhen = "09:30";
      closeWhen = over ? "16:00" : "now";
      if (last.day === etDay(now)) label = "Today";
    } else {
      const y = first.day.slice(0, 4) !== last.day.slice(0, 4);
      openWhen = fmtDay(first.bars[0].time, true, y);
      closeWhen = fmtDay(lastBar.time, true, y);
    }
  } else {
    o = ohlc(candles);
    const intraday = range === "1M";
    openWhen = fmtDay(candles[0].time, intraday, withYear);
    closeWhen = fmtDay(candles[candles.length - 1].time, intraday, withYear);
  }
  const change = o.close - o.open;
  return { label, change, pct: o.open ? (change / o.open) * 100 : null, ...o, openWhen, closeWhen };
}

export type Extreme = { index: number; value: number; time: number };

/** Highest high and lowest low among the bars with index from..to (inclusive, clamped). */
export function extremes(candles: Candle[], from = 0, to = candles.length - 1): { high: Extreme; low: Extreme } | null {
  const a = Math.max(0, Math.round(from));
  const b = Math.min(candles.length - 1, Math.round(to));
  if (candles.length === 0 || a > b) return null;
  let hi = a;
  let lo = a;
  for (let i = a; i <= b; i++) {
    if (candles[i].high > candles[hi].high) hi = i;
    if (candles[i].low < candles[lo].low) lo = i;
  }
  return {
    high: { index: hi, value: candles[hi].high, time: candles[hi].time },
    low: { index: lo, value: candles[lo].low, time: candles[lo].time },
  };
}

/** "H 189.88 · Oct 21 09:30" (intraday, New York time) or "L 161.00 · Oct 20" (daily). */
export function extremeLabel(kind: "H" | "L", e: Extreme, intraday: boolean, withYear: boolean): string {
  const day = fmtDay(e.time, intraday, withYear);
  return `${kind} ${fmt(e.value)} · ${intraday ? `${day} ${etClock(e.time)}` : day}`;
}

/** VWAP that starts over each New York trading day. */
export function sessionVwap(candles: Candle[]): Point[] {
  const out: Point[] = [];
  let day = "";
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const d = etDay(c.time);
    if (d !== day) {
      day = d;
      pv = 0;
      v = 0;
    }
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    v += c.volume;
    if (v > 0) out.push({ time: c.time, value: pv / v });
  }
  return out;
}

/** 3M has no server range: keep the last ~3 calendar months of a 6M history. */
export function sliceMonths(candles: Candle[], months: number): Candle[] {
  if (candles.length === 0) return candles;
  const last = new Date(candles[candles.length - 1].time * 1000);
  last.setUTCMonth(last.getUTCMonth() - months);
  const cutoff = last.getTime() / 1000;
  return candles.filter((c) => c.time >= cutoff);
}
