import { describe, expect, it } from "vitest";
import { greeks, impliedVol, midPrice, normCdf, price, riskFreeRate } from "./black-scholes.js";

// Hull, Options, Futures and Other Derivatives: S=42, K=40, r=10%, vol=20%, T=0.5.
const hull = { spot: 42, strike: 40, t: 0.5, rate: 0.1, vol: 0.2 };

describe("black-scholes", () => {
  it("normCdf matches the standard table", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021, 5);
    expect(normCdf(-1)).toBeCloseTo(0.1586553, 5);
  });

  it("prices Hull's example (call 4.76, put 0.81)", () => {
    expect(price({ ...hull, right: "call" })).toBeCloseTo(4.7594, 4);
    expect(price({ ...hull, right: "put" })).toBeCloseTo(0.8086, 4);
  });

  it("prices the 100/100 one-year benchmark", () => {
    const i = { spot: 100, strike: 100, t: 1, rate: 0.05, vol: 0.2 };
    expect(price({ ...i, right: "call" })).toBeCloseTo(10.4506, 4);
    expect(price({ ...i, right: "put" })).toBeCloseTo(5.5735, 4);
  });

  it("prices with a dividend yield (S=930, K=900, r=8%, q=3%, vol=20%, T=2/12)", () => {
    const i = { spot: 930, strike: 900, t: 2 / 12, rate: 0.08, div: 0.03, vol: 0.2 };
    expect(price({ ...i, right: "call" })).toBeCloseTo(51.8, 0);
    // Put-call parity: C - P = S e^-qT - K e^-rT.
    const parity = price({ ...i, right: "call" }) - price({ ...i, right: "put" });
    expect(parity).toBeCloseTo(930 * Math.exp(-0.03 * 2 / 12) - 900 * Math.exp(-0.08 * 2 / 12), 4);
  });

  it("greeks match Hull (delta N(d1)=0.7791 for the example) and the 100/100 benchmark", () => {
    expect(greeks({ ...hull, right: "call" }).delta).toBeCloseTo(0.7791, 4);
    expect(greeks({ ...hull, right: "put" }).delta).toBeCloseTo(0.7791 - 1, 4);
    const i = { spot: 100, strike: 100, t: 1, rate: 0.05, vol: 0.2 };
    const c = greeks({ ...i, right: "call" });
    expect(c.delta).toBeCloseTo(0.6368, 4);
    expect(c.gamma).toBeCloseTo(0.018762, 5);
    expect(c.vega).toBeCloseTo(0.37524, 4); // per vol point
    expect(c.theta).toBeCloseTo(-6.414 / 365, 4); // per day
    expect(greeks({ ...i, right: "put" }).theta).toBeCloseTo(-1.6579 / 365, 4);
  });

  it("recovers the volatility it priced with", () => {
    for (const right of ["call", "put"] as const) {
      for (const vol of [0.05, 0.2, 0.9, 2.5]) {
        const i = { ...hull, right };
        expect(impliedVol(i, price({ ...i, vol }))).toBeCloseTo(vol, 4);
      }
    }
  });

  it("returns null below intrinsic, above the ceiling, or without time", () => {
    const i = { ...hull, right: "call" as const };
    expect(impliedVol(i, 1)).toBeNull(); // intrinsic is ~5.58
    expect(impliedVol(i, 50)).toBeNull();
    expect(impliedVol(i, 0)).toBeNull();
    expect(impliedVol({ ...i, t: 0 }, 5)).toBeNull();
  });

  it("midPrice needs a real two-sided quote", () => {
    expect(midPrice(1, 1.2)).toBeCloseTo(1.1);
    expect(midPrice(0, 1.2)).toBeNull();
    expect(midPrice(null, 1.2)).toBeNull();
    expect(midPrice(2, 1)).toBeNull();
  });

  it("reads RISK_FREE_RATE", () => {
    expect(riskFreeRate(undefined)).toBe(0.04);
    expect(riskFreeRate("0.05")).toBe(0.05);
    expect(riskFreeRate("x")).toBe(0.04);
  });
});
