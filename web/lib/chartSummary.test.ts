import { describe, expect, it } from "vitest";
import type { Candle } from "./api";
import { barWhen, etDay, extremeLabel, extremes, firstDayOf, markerFilter, nearEdge, fmtMove, rangeSummary, readout, sessionVwap, sliceMonths, spansYears } from "./chartSummary";

const utc = (iso: string) => Date.parse(iso) / 1000;
const c = (iso: string, o: number, h: number, l: number, cl: number, volume = 100): Candle => ({ time: utc(iso), open: o, high: h, low: l, close: cl, volume });

// Oct 20-21, 2026 are in EDT (UTC-4): 09:30 ET = 13:30Z.
const intraday: Candle[] = [
  c("2026-10-20T12:00:00Z", 99, 101, 98, 100), // 08:00 ET pre-market
  c("2026-10-20T13:30:00Z", 100, 110, 99, 105),
  c("2026-10-20T19:45:00Z", 105, 106, 104, 104),
  c("2026-10-20T20:30:00Z", 104, 130, 103, 104), // 16:30 ET after hours spike
  c("2026-10-21T13:30:00Z", 104, 108, 90, 95),
  c("2026-10-21T14:00:00Z", 95, 96, 94, 95.5),
];

describe("time labels", () => {
  it("labels intraday bars in New York time and daily bars by their UTC day", () => {
    expect(barWhen(utc("2026-10-21T16:30:00Z"), true)).toBe("Oct 21, 2026 · 12:30 ET");
    expect(barWhen(utc("2026-10-21T00:00:00Z"), false)).toBe("Oct 21, 2026");
    expect(etDay(utc("2026-10-21T02:00:00Z"))).toBe("2026-10-20");
  });
  it("detects ranges that cross a year", () => {
    expect(spansYears([c("2025-12-31T00:00:00Z", 1, 1, 1, 1), c("2026-01-02T00:00:00Z", 1, 1, 1, 1)], false)).toBe(true);
    expect(spansYears(intraday, true)).toBe(false);
  });
});

describe("rangeSummary", () => {
  it("5D uses the official daily numbers where stored and the regular session otherwise", () => {
    const daily = [{ day: "2026-10-20", open: 100.5, high: 111, low: 98.5, close: 104.5, volume: 1 }];
    const s = rangeSummary(intraday, "5D", daily, utc("2026-10-21T18:00:00Z"))!;
    expect(s.open).toBe(100.5);
    expect(s.close).toBe(95.5); // Oct 21 has no daily bar yet: last regular candle
    expect(s.high).toBe(111); // not the 130 after-hours print
    expect(s.low).toBe(90);
    expect(s.change).toBeCloseTo(-5);
    expect(s.pct).toBeCloseTo((-5 / 100.5) * 100);
    expect(s.openWhen).toBe("Oct 20");
    expect(s.closeWhen).toBe("Oct 21");
    expect(s.label).toBe("5D");
  });
  it("1D says Today, with open and close times", () => {
    const one = intraday.slice(4);
    const s = rangeSummary(one, "1D", [], utc("2026-10-21T18:00:00Z"))!;
    expect(s.label).toBe("Today");
    expect(s.openWhen).toBe("09:30");
    expect(s.closeWhen).toBe("now");
    expect(s.open).toBe(104);
    expect(s.close).toBe(95.5);
    expect(rangeSummary(one, "1D", [], utc("2026-10-21T21:00:00Z"))!.closeWhen).toBe("16:00");
    expect(rangeSummary(one, "1D", [], utc("2026-10-22T14:00:00Z"))!.label).toBe("1D");
  });
  it("longer ranges use the candles and drop the year within one year", () => {
    const d = [c("2026-01-05T00:00:00Z", 10, 12, 9, 11), c("2026-03-05T00:00:00Z", 11, 15, 10, 14)];
    const s = rangeSummary(d, "6M")!;
    expect([s.open, s.close, s.high, s.low]).toEqual([10, 14, 15, 9]);
    expect(s.openWhen).toBe("Jan 5");
    const y = rangeSummary([c("2025-12-30T00:00:00Z", 1, 1, 1, 1), c("2026-01-05T00:00:00Z", 1, 2, 1, 2)], "1Y")!;
    expect(y.openWhen).toBe("Dec 30, 2025");
  });
  it("1M takes its numbers from the official daily bars, not the hourly candles", () => {
    const daily = [
      { day: "2026-10-20", open: 100.5, high: 111, low: 98.5, close: 104.5, volume: 1 },
      { day: "2026-10-21", open: 104, high: 108.5, low: 92, close: 96, volume: 1 },
    ];
    const s = rangeSummary(intraday, "1M", daily, utc("2026-10-22T18:00:00Z"))!;
    expect([s.open, s.close, s.high, s.low]).toEqual([100.5, 96, 111, 92]);
    expect(firstDayOf(intraday, "1M")).toBe("2026-10-20");
  });
  it("6M and longer use daily bars over the range, with candles for days not stored yet", () => {
    const candles = [c("2026-01-05T00:00:00Z", 10, 12, 9, 11), c("2026-03-05T00:00:00Z", 11, 15, 10, 14), c("2026-03-06T00:00:00Z", 14, 16, 13, 15)];
    const daily = [
      { day: "2026-01-04", open: 1, high: 99, low: 0.5, close: 1, volume: 1 }, // before the range
      { day: "2026-01-05", open: 10.5, high: 12.5, low: 9.5, close: 11, volume: 1 },
      { day: "2026-03-05", open: 11, high: 15, low: 8, close: 14, volume: 1 },
    ];
    const s = rangeSummary(candles, "6M", daily)!;
    expect([s.open, s.close, s.high, s.low]).toEqual([10.5, 15, 16, 8]);
    expect(s.closeWhen).toBe("Mar 6");
    expect(firstDayOf(candles, "6M")).toBe("2026-01-05");
  });
  it("returns null for no candles", () => {
    expect(rangeSummary([], "1M")).toBeNull();
  });
});

describe("readout", () => {
  it("changes against the previous bar's close", () => {
    const r = readout(intraday, 5, true)!;
    expect(r.when).toBe("Oct 21, 2026 · 10:00 ET");
    expect(r.change).toBeCloseTo(0.5);
    expect(r.pct).toBeCloseTo((0.5 / 95) * 100);
    expect(readout(intraday, 0, true)!.change).toBe(1); // first bar: against its own open
    expect(readout(intraday, 9, true)).toBeNull();
  });
  it("formats moves with a real minus", () => {
    expect(fmtMove(-0.39, -0.21)).toBe("−0.39 (−0.21%)");
    expect(fmtMove(0.39, 0.21)).toBe("+0.39 (+0.21%)");
  });
});

describe("extremes", () => {
  it("finds the high and low among the visible bars", () => {
    const all = extremes(intraday)!;
    expect(all.high.value).toBe(130);
    expect(all.low.value).toBe(90);
    const view = extremes(intraday, 1, 2.2)!;
    expect(view.high).toMatchObject({ index: 1, value: 110 });
    expect(view.low).toMatchObject({ index: 1, value: 99 });
    expect(extremes(intraday, 4, 2)).toBeNull();
  });
  it("on 1D/5D markers use regular-session bars only, matching the summary", () => {
    const reg = extremes(intraday, 0, 5, markerFilter("5D"))!;
    expect(reg.high).toMatchObject({ index: 1, value: 110 }); // not the 130 after-hours print
    expect(reg.low).toMatchObject({ index: 4, value: 90 });
    expect(extremes(intraday, 0, 3, markerFilter("5D"))!.low.value).toBe(99); // pre-market 98 ignored
    expect(extremes(intraday, 3, 3, markerFilter("5D"))!.high.value).toBe(130); // nothing regular in view: all bars
    expect(markerFilter("6M")).toBeUndefined();
  });
  it("shortens a label near an edge of the visible range", () => {
    expect(nearEdge(2, 0, 100)).toBe(true);
    expect(nearEdge(50, 0, 100)).toBe(false);
    expect(nearEdge(90, 0, 100)).toBe(true);
    expect(nearEdge(15, 0, 100)).toBe(false);
    const e = extremes(intraday, 4, 5)!;
    expect(extremeLabel("H", e.high, true, false, true)).toBe("H 108.00");
  });
  it("labels with value, date and time", () => {
    const e = extremes(intraday, 4, 5)!;
    expect(extremeLabel("H", e.high, true, false)).toBe("H 108.00 · Oct 21 09:30");
    expect(extremeLabel("L", e.low, false, true)).toBe("L 90.00 · Oct 21, 2026");
  });
});

describe("sessionVwap and sliceMonths", () => {
  it("restarts vwap each New York day", () => {
    const v = sessionVwap(intraday);
    const day2First = v.find((p) => p.time === utc("2026-10-21T13:30:00Z"))!;
    expect(day2First.value).toBeCloseTo((108 + 90 + 95) / 3);
  });
  it("keeps three months of history", () => {
    const d = [c("2026-04-01T00:00:00Z", 1, 1, 1, 1), c("2026-07-20T00:00:00Z", 1, 1, 1, 1), c("2026-10-20T00:00:00Z", 1, 1, 1, 1)];
    expect(sliceMonths(d, 3).map((x) => x.time)).toEqual([d[1].time, d[2].time]);
  });
});
