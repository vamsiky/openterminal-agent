import { describe, expect, it } from "vitest";
import { adx, atr, bollinger, ema, last, macd, periodReturn, relativeVolume, returns, rollup, rsi, sma, vwap, type Bar } from "./indicators.js";

const closes = (...c: number[]): Bar[] => c.map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 1 }));
const values = (p: Array<{ value: number }>) => p.map((x) => x.value);

describe("series ported from the chart", () => {
  it("sma drops the warm-up", () => {
    expect(values(sma(closes(1, 2, 3, 4, 5), 3))).toEqual([2, 3, 4]);
    expect(sma(closes(1, 2, 3, 4, 5), 3)[0].time).toBe(2);
  });

  it("ema is seeded with the first close and trimmed", () => {
    // k = 0.5: 1, 1.5, 2.25, 3.125, 4.0625
    expect(values(ema(closes(1, 2, 3, 4, 5), 3))).toEqual([2.25, 3.125, 4.0625]);
  });

  it("rsi uses Wilder smoothing", () => {
    const r = values(rsi(closes(10, 11, 10, 12), 2));
    expect(r[0]).toBeCloseTo(50, 9);
    expect(r[1]).toBeCloseTo(100 - 100 / 6, 9); // avgGain 1.25, avgLoss 0.25
    // No losses: the chart's version caps RS at 100, so RSI reads 99.01, not 100. Kept so scores match the chart.
    expect(values(rsi(closes(1, 2, 3, 4), 2))[0]).toBeCloseTo(100 - 100 / 101, 9);
  });

  it("bollinger uses the population deviation", () => {
    const b = bollinger(closes(1, 2, 3), 3);
    const sd = Math.sqrt(2 / 3);
    expect(values(b.middle)).toEqual([2]);
    expect(b.upper[0].value).toBeCloseTo(2 + 2 * sd, 9);
    expect(b.lower[0].value).toBeCloseTo(2 - 2 * sd, 9);
  });

  it("macd lines start at the slow period", () => {
    const m = macd(closes(...Array.from({ length: 40 }, (_, i) => 100 + i)));
    expect(m.macd).toHaveLength(40 - 25);
    expect(m.histogram[3].value).toBeCloseTo(m.macd[3].value - m.signal[3].value, 12);
  });

  it("vwap weights the typical price by volume", () => {
    const bars: Bar[] = [
      { time: 0, open: 10, high: 12, low: 8, close: 10, volume: 100 }, // typical 10
      { time: 1, open: 10, high: 16, low: 10, close: 13, volume: 300 }, // typical 13
    ];
    expect(values(vwap(bars))).toEqual([10, (10 * 100 + 13 * 300) / 400]);
  });
});

describe("new indicators", () => {
  it("atr is the Wilder average of the true range", () => {
    const bars: Bar[] = [
      { time: 0, open: 9, high: 10, low: 8, close: 9, volume: 1 }, // TR 2
      { time: 1, open: 9, high: 11, low: 9, close: 10, volume: 1 }, // TR 2
      { time: 2, open: 10, high: 12, low: 10, close: 11, volume: 1 }, // TR 2
      { time: 3, open: 12, high: 14, low: 11, close: 13, volume: 1 }, // TR 3
    ];
    const a = values(atr(bars, 3));
    expect(a[0]).toBe(2);
    expect(a[1]).toBeCloseTo((2 * 2 + 3) / 3, 12);
  });

  it("adx of a steady uptrend is 100 with DI+ at 100 / 1.5", () => {
    // each bar: high i+1, low i, close i+0.5 -> TR 1.5, +DM 1, -DM 0
    const bars: Bar[] = Array.from({ length: 10 }, (_, i) => ({ time: i, open: i, high: i + 1, low: i, close: i + 0.5, volume: 1 }));
    const r = adx(bars, 3);
    expect(r.plusDi[0].value).toBeCloseTo(100 / 1.5, 9);
    expect(r.minusDi[0].value).toBe(0);
    expect(r.adx[0].time).toBe(5); // first at index 2 * 3 - 1
    expect(values(r.adx).every((v) => Math.abs(v - 100) < 1e-9)).toBe(true);
  });

  it("returns and periodReturn", () => {
    const r = values(returns(closes(100, 110, 99), 1));
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(r[1]).toBeCloseTo(-0.1, 12);
    expect(periodReturn([100, 105, 120], 2)).toBeCloseTo(0.2, 12);
    expect(periodReturn([100, 105], 2)).toBeNull();
    expect(last([])).toBeNull();
  });

  it("relativeVolume compares with the mean of the previous bars", () => {
    const bars = [10, 10, 10, 30, 5].map((volume, i) => ({ time: i, open: 1, high: 1, low: 1, close: 1, volume }));
    const r = values(relativeVolume(bars, 3));
    expect(r[0]).toBe(3);
    expect(r[1]).toBeCloseTo(5 / (50 / 3), 12);
  });
});

describe("rollup", () => {
  // 2026-10-21 is EDT: 09:30 New York is 13:30 UTC.
  const open = Date.UTC(2026, 9, 21, 13, 30) / 1000;
  const m = (minute: number, price: number, volume = 10): Bar => ({ ts: open + minute * 60, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume });

  it("buckets from the session open and aggregates OHLCV", () => {
    const out = rollup([m(0, 100), m(1, 101), m(59, 102), m(60, 103), m(124, 104)], 60);
    expect(out.map((b) => b.ts)).toEqual([open, open + 3600, open + 7200]);
    expect(out[0]).toMatchObject({ open: 100, high: 103, low: 99, close: 102.5, volume: 30 });
    expect(out[1]).toMatchObject({ open: 103, close: 103.5, volume: 10 });
  });

  it("aligns 15-minute buckets to the open, not the clock hour", () => {
    const out = rollup([m(14, 100), m(15, 101), m(29, 102)], 15);
    expect(out.map((b) => (b.ts! - open) / 60)).toEqual([0, 15]);
  });

  it("drops pre-market and after-hours bars and handles several days", () => {
    const pre = { ...m(-30, 99) };
    const after = { ...m(390, 99) }; // 16:00 is outside
    const nextDay = { ...m(0, 105), ts: open + 86_400 };
    const out = rollup([pre, m(0, 100), after, nextDay], 5);
    expect(out.map((b) => b.ts)).toEqual([open, open + 86_400]);
  });
});
