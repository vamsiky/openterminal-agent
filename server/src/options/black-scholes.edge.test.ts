import { describe, expect, it } from "vitest";
import { greeks, impliedVol, lowerBound, midPrice, price, type BsInput } from "./black-scholes.js";

const RATES = [0, 0.04, 0.1];
const DIVS = [0, 0.03];
const SPOTS = [50, 100, 150];
const STRIKES = [70, 100, 130];
const YEARS = [1 / 365, 0.25, 2];
const VOLS = [0.1, 0.5, 1.2];

describe("put-call parity", () => {
  it("holds across a grid of spot, strike, expiry, vol, rate and dividend: C - P = S e^-qT - K e^-rT", () => {
    let cases = 0;
    for (const spot of SPOTS)
      for (const strike of STRIKES)
        for (const t of YEARS)
          for (const vol of VOLS)
            for (const rate of RATES)
              for (const div of DIVS) {
                const base = { spot, strike, t, vol, rate, div };
                const c = price({ ...base, right: "call" });
                const p = price({ ...base, right: "put" });
                const parity = spot * Math.exp(-div * t) - strike * Math.exp(-rate * t);
                expect(Math.abs(c - p - parity)).toBeLessThan(1e-9);
                cases++;
              }
    expect(cases).toBe(3 * 3 * 3 * 3 * 3 * 2);
  });

  it("keeps every price between its no-arbitrage bounds", () => {
    for (const spot of SPOTS)
      for (const strike of STRIKES)
        for (const vol of VOLS) {
          const base = { spot, strike, t: 0.5, vol, rate: 0.04, div: 0.01 };
          for (const right of ["call", "put"] as const) {
            const v = price({ ...base, right });
            expect(v).toBeGreaterThanOrEqual(lowerBound({ ...base, right }) - 1e-9);
            expect(v).toBeLessThanOrEqual(right === "call" ? spot : strike);
          }
        }
  });
});

describe("implied vol round trip", () => {
  it("recovers the vol to 1e-6 and reprices to within 1e-6 across a grid", () => {
    let solved = 0;
    for (const spot of SPOTS)
      for (const strike of STRIKES)
        for (const t of YEARS)
          for (const vol of VOLS)
            for (const right of ["call", "put"] as const) {
              const input = { right, spot, strike, t, rate: 0.04, div: 0.01 };
              const target = price({ ...input, vol });
              const iv = impliedVol(input, target);
              if (target < 1e-6) continue; // too little premium to pin the vol down
              expect(iv, JSON.stringify(input)).not.toBeNull();
              expect(Math.abs(price({ ...input, vol: iv! }) - target), JSON.stringify({ input, vol })).toBeLessThan(1e-6);
              solved++;
            }
    expect(solved).toBeGreaterThan(100);
  });

  it("recovers a vol of 5 (500%) and a vol of 0.01 for an at-the-money call", () => {
    for (const vol of [0.01, 5]) {
      const input = { right: "call" as const, spot: 100, strike: 100, t: 1, rate: 0.04 };
      const target = price({ ...input, vol });
      expect(impliedVol(input, target)!).toBeCloseTo(vol, 4);
    }
  });
});

describe("deep in and out of the money", () => {
  it("prices a deep ITM call at its discounted intrinsic value, delta near 1", () => {
    const i: BsInput = { right: "call", spot: 200, strike: 100, t: 0.5, rate: 0.04, vol: 0.2 };
    const v = price(i);
    expect(v).toBeCloseTo(200 - 100 * Math.exp(-0.04 * 0.5), 1);
    expect(greeks(i).delta).toBeGreaterThan(0.9999);
    expect(greeks(i).gamma).toBeLessThan(1e-6);
  });

  it("prices a deep OTM call near zero with delta near zero", () => {
    const i: BsInput = { right: "call", spot: 50, strike: 200, t: 0.25, rate: 0.04, vol: 0.2 };
    expect(price(i)).toBeLessThan(1e-12);
    expect(Math.abs(greeks(i).delta)).toBeLessThan(1e-9);
  });

  it("keeps a deep OTM put's price non-negative and its delta in [-1, 0]", () => {
    const i: BsInput = { right: "put", spot: 200, strike: 50, t: 0.25, rate: 0.04, vol: 0.3 };
    expect(price(i)).toBeGreaterThanOrEqual(0);
    const d = greeks(i).delta;
    expect(d).toBeLessThanOrEqual(0);
    expect(d).toBeGreaterThanOrEqual(-1);
  });

  it("solves the implied vol of a deep OTM option priced at a few cents", () => {
    const input = { right: "call" as const, spot: 100, strike: 150, t: 0.1, rate: 0.04 };
    const target = price({ ...input, vol: 0.4 });
    expect(target).toBeGreaterThan(0);
    expect(impliedVol(input, target)!).toBeCloseTo(0.4, 5);
  });
});

describe("near-zero time", () => {
  it("prices one minute to expiry at intrinsic, not NaN", () => {
    const t = 60 / (365 * 86_400); // one minute
    const itm = price({ right: "call", spot: 110, strike: 100, t, rate: 0.04, vol: 0.5 });
    expect(itm).toBeCloseTo(10, 2);
    const otm = price({ right: "call", spot: 90, strike: 100, t, rate: 0.04, vol: 0.5 });
    expect(otm).toBeLessThan(1e-6);
  });

  it("returns finite greeks one minute from expiry", () => {
    const t = 60 / (365 * 86_400);
    for (const right of ["call", "put"] as const) {
      const g = greeks({ right, spot: 101, strike: 100, t, rate: 0.04, vol: 0.5 });
      for (const v of Object.values(g)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("has no implied vol at zero time", () => {
    expect(impliedVol({ right: "call", spot: 110, strike: 100, t: 0, rate: 0.04 }, 10)).toBeNull();
  });
});

describe("implied vol refusals", () => {
  it("is null when the price is below intrinsic, even by a cent", () => {
    const i = { right: "call" as const, spot: 100, strike: 90, t: 1, rate: 0.04 };
    const floor = lowerBound(i);
    expect(impliedVol(i, floor - 0.01)).toBeNull();
    expect(impliedVol(i, floor + 0.01)).not.toBeNull();
  });

  it("is null for a put priced at or above its ceiling, and for a zero or negative price", () => {
    const put = { right: "put" as const, spot: 100, strike: 90, t: 1, rate: 0.04 };
    expect(impliedVol(put, 90 * Math.exp(-0.04))).toBeNull();
    expect(impliedVol(put, 0)).toBeNull();
    expect(impliedVol(put, -1)).toBeNull();
  });
});

describe("midPrice", () => {
  it("is the mid of a locked quote and null for a crossed one", () => {
    expect(midPrice(2, 2)).toBe(2);
    expect(midPrice(2.1, 2)).toBeNull();
    expect(midPrice(0, 1)).toBeNull();
  });
});
