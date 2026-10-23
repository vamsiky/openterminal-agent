import { describe, expect, it } from "vitest";
import {
  atmStrike, chainStats, daysLeft, defaultExpiry, isItm, joinStrikes, mid, nearestStrikes, spotRowIndex, strikeBand, todayET,
  type OptionRow,
} from "./chain";

const row = (strike: number, over: Partial<OptionRow> = {}): OptionRow => ({
  strike, lastPrice: null, bid: null, ask: null, volume: null, openInterest: null, impliedVolatility: null, inTheMoney: false, ...over,
});

describe("joinStrikes", () => {
  it("joins calls and puts by strike, ascending, keeping one-sided strikes", () => {
    const rows = joinStrikes([row(110), row(100)], [row(100), row(90)]);
    expect(rows.map((r) => r.strike)).toEqual([90, 100, 110]);
    expect(rows[0].call).toBeUndefined();
    expect(rows[1].call && rows[1].put).toBeTruthy();
    expect(rows[2].put).toBeUndefined();
  });
  it("skips rows without a strike", () => {
    expect(joinStrikes([row(100), { ...row(0), strike: null }], [])).toHaveLength(1);
  });
});

describe("expiry helpers", () => {
  it("counts calendar days", () => {
    expect(daysLeft("2026-10-23", "2026-10-23")).toBe(0);
    expect(daysLeft("2026-11-20", "2026-10-23")).toBe(28);
  });
  it("defaults to the nearest expiry after today", () => {
    expect(defaultExpiry(["2026-10-23", "2026-10-30", "2026-11-20"], "2026-10-23")).toBe("2026-10-30");
  });
  it("falls back to the first listed, or null", () => {
    expect(defaultExpiry(["2026-10-23"], "2026-10-23")).toBe("2026-10-23");
    expect(defaultExpiry([], "2026-10-23")).toBeNull();
  });
  it("reads the date in New York", () => {
    expect(todayET(new Date("2026-10-24T02:00:00Z"))).toBe("2026-10-23");
  });
});

describe("strike selection", () => {
  const rows = joinStrikes([90, 95, 100, 105, 110, 130].map((s) => row(s)), []);
  it("finds the ATM strike, the lower one on a tie", () => {
    expect(atmStrike(rows, 101)?.strike).toBe(100);
    expect(atmStrike(rows, 102.5)?.strike).toBe(100);
    expect(atmStrike(rows, null)).toBeNull();
    expect(atmStrike([], 100)).toBeNull();
  });
  it("filters by band, inclusive", () => {
    expect(strikeBand(rows, 100, 0.1).map((r) => r.strike)).toEqual([90, 95, 100, 105, 110]);
    expect(strikeBand(rows, 100, 0.3).map((r) => r.strike)).toEqual([90, 95, 100, 105, 110, 130]);
  });
  it("takes the n nearest strikes, ascending", () => {
    expect(nearestStrikes(rows, 101, 3).map((r) => r.strike)).toEqual([95, 100, 105]);
    expect(nearestStrikes(rows, 101, 50)).toHaveLength(6);
  });
  it("places the spot row before the first strike above spot", () => {
    expect(spotRowIndex(rows, 101)).toBe(3);
    expect(spotRowIndex(rows, 80)).toBe(0);
    expect(spotRowIndex(rows, 500)).toBe(6);
    expect(spotRowIndex(rows, null)).toBe(6);
  });
  it("flags in-the-money sides", () => {
    expect(isItm("call", 95, 100)).toBe(true);
    expect(isItm("call", 105, 100)).toBe(false);
    expect(isItm("put", 105, 100)).toBe(true);
    expect(isItm("put", 100, 100)).toBe(false);
    expect(isItm("call", 95, null)).toBe(false);
  });
});

describe("mid and stats", () => {
  it("needs a live two-sided quote for a mid", () => {
    expect(mid(row(1, { bid: 1, ask: 1.2 }))).toBeCloseTo(1.1);
    expect(mid(row(1, { bid: 0, ask: 0 }))).toBeNull();
    expect(mid(row(1, { bid: null, ask: 1 }))).toBeNull();
    expect(mid(undefined)).toBeNull();
  });
  it("computes straddle, implied move, IV, volumes and put/call ratio", () => {
    const rows = joinStrikes(
      [row(95, { volume: 10 }), row(100, { bid: 2, ask: 2.2, impliedVolatility: 0.3, volume: 100 })],
      [row(95, { volume: 40 }), row(100, { bid: 1.8, ask: 2, impliedVolatility: 0.34, volume: 60 })],
    );
    const s = chainStats(rows, 100.2);
    expect(s.atm).toBe(100);
    expect(s.straddle).toBeCloseTo(4);
    expect(s.impliedMove).toBeCloseTo(4 / 100.2);
    expect(s.atmIv).toBeCloseTo(0.32);
    expect(s.callVolume).toBe(110);
    expect(s.putVolume).toBe(100);
    expect(s.putCallRatio).toBeCloseTo(100 / 110);
  });
  it("returns nulls, not NaN, for an empty or unquoted chain", () => {
    expect(chainStats([], 100)).toEqual({ atm: null, straddle: null, impliedMove: null, atmIv: null, callVolume: 0, putVolume: 0, putCallRatio: null });
    const s = chainStats(joinStrikes([row(100)], [row(100)]), 100);
    expect(s.atm).toBe(100);
    expect(s.straddle).toBeNull();
    expect(s.atmIv).toBeNull();
    expect(s.putCallRatio).toBeNull();
  });
});
