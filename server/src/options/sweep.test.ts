import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionPosition } from "../scan/contracts.js";

let tmpDir: string;
let sweep: typeof import("./sweep.js");
let bs: typeof import("./black-scholes.js");
let sel: typeof import("./selection.js");
let store: typeof import("./store.js");
let closeAt: (day: string) => number;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-options-sweep-test-"));
  process.env.DATA_DIR = tmpDir;
  sweep = await import("./sweep.js");
  bs = await import("./black-scholes.js");
  sel = await import("./selection.js");
  store = await import("./store.js");
  closeAt = (await import("../live/session.js")).regularCloseAt;
});

afterAll(async () => {
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const NOW = Date.parse("2026-10-21T15:00:00Z"); // 11:00 New York
const strikes = [90, 92.5, 95, 97.5, 100, 102.5, 105, 107.5, 110];

/** Snapshots priced by Black-Scholes at a per-expiry vol, with a 2% wide quote. */
function fakeChain(root: string, price: number, vols: Record<string, number>, volume = 10) {
  const snaps: Record<string, any> = {};
  for (const [expiry, vol] of Object.entries(vols)) {
    const t = bs.yearsToExpiry(expiry, NOW, closeAt);
    for (const right of ["call", "put"] as const) {
      for (const strike of strikes) {
        const mid = bs.price({ right, spot: price, strike, t, rate: bs.riskFreeRate(), vol });
        snaps[sel.buildOcc(root, expiry, right, strike)] = {
          latestQuote: { bp: mid * 0.99, ap: mid * 1.01 },
          dailyBar: { v: volume },
            };
      }
    }
  }
  return snaps;
}

describe("pure helpers", () => {
  it("constantMaturityIv interpolates total variance", () => {
    expect(sweep.constantMaturityIv([{ days: 20, iv: 0.3 }, { days: 40, iv: 0.3 }], 30)).toBeCloseTo(0.3, 10);
    const iv = sweep.constantMaturityIv([{ days: 20, iv: 0.2 }, { days: 40, iv: 0.4 }], 30)!;
    expect(iv).toBeCloseTo(Math.sqrt((0.5 * 0.04 * 20 + 0.5 * 0.16 * 40) / 30), 10);
    expect(sweep.constantMaturityIv([{ days: 50, iv: 0.3 }], 30)).toBe(0.3); // one side: held flat
    expect(sweep.constantMaturityIv([], 30)).toBeNull();
  });

  it("historicalVol annualises the stdev of log returns", () => {
    const flat = Array.from({ length: 21 }, () => 100);
    expect(sweep.historicalVol(flat)).toBe(0);
    expect(sweep.historicalVol([100, 101])).toBeNull();
    const alt = Array.from({ length: 21 }, (_, i) => (i % 2 ? 101 : 100));
    expect(sweep.historicalVol(alt)!).toBeGreaterThan(0.1);
  });

  it("flags unusual volume against open interest, skipping 0DTE and 1DTE, highest ratio first", () => {
    const c = (occ: string, volume: number, openInterest: number | null, expiry = "2026-11-20") =>
      ({ occ, expiry, right: "call", strike: 100, bid: 1, ask: 1, mid: 1, volume, openInterest, iv: 0.3, delta: 0.5 }) as const;
    const out = sweep.unusualContracts(
      [c("A", 900, 400), c("B", 300, 50), c("C", 900, 600), c("D", 5000, null), c("E", 2000, 400), c("F", 9000, 10, "2026-10-21"), c("G", 9000, 10, "2026-10-22"), c("H", 9000, 100, "2026-10-23"), c("I", 9000, 99, "2026-10-23")],
      "2026-10-21"
    );
    expect(out.map((u) => u.occ)).toEqual(["H", "E", "A"]); // 90x, 5x, 2.25x; I has OI under 100
    expect(out[1]).toEqual({ occ: "E", volume: 2000, openInterest: 400, ratio: 5 });
    expect(sweep.UNUSUAL_MIN_DTE).toBe(2);
  });

  it("records the IV day only in the last minutes of the session", () => {
    expect(sweep.recordsIvDay(Date.parse("2026-10-21T19:50:00Z"))).toBe(false); // 15:50 ET
    expect(sweep.recordsIvDay(Date.parse("2026-10-21T19:57:00Z"))).toBe(true);
    expect(sweep.recordsIvDay(Date.parse("2026-10-21T20:30:00Z"))).toBe(false);
  });
});

describe("runSweep", () => {
  const cfg = { maxDte: 60, strikeRange: 0.15, minDte: 7, streamMax: 1000, concurrency: 2 };
  const expiries = ["2026-10-23", "2026-10-30", "2026-11-20", "2026-12-18"];

  it("computes metrics from a Black-Scholes chain and selects the stream pair", async () => {
    // Flat 30% except the 58-day expiry at 36%.
    const vols = { "2026-10-23": 0.3, "2026-10-30": 0.3, "2026-11-20": 0.3, "2026-12-18": 0.36 };
    const seen: Array<{ u: string; f: any }> = [];
    const result = await sweep.runSweep({
      underlyings: () => ["AAA", "BBB"],
      holdings: () => [],
      prices: async () => new Map([["AAA", 100.4], ["BBB", 100]]),
      snapshots: async (u, f) => {
        seen.push({ u, f });
        if (u === "BBB") throw new Error("boom");
        return fakeChain(u, 100.4, vols, 600);
      },
      hv20: () => 0.25,
      // 600 lots traded in the fake chain: AAA ATM call has 250 OI (flagged), the put 400 (not).
      openInterest: async () => new Map([["AAA261030C00100000", 250], ["AAA261030P00100000", 400]]),
      now: () => NOW,
      config: cfg,
    });
    expect(seen[0].f).toMatchObject({ expiryMin: "2026-10-21", expiryMax: "2026-12-20" });
    expect(seen[0].f.strikeMin).toBeCloseTo(85.34, 2);
    expect(result.errors).toEqual([{ symbol: "BBB", message: "boom" }]);
    expect(result.metrics).toHaveLength(1);

    const m = result.metrics[0];
    expect(m.underlying).toBe("AAA");
    expect(m.atmExpiry).toBe("2026-10-30");
    expect(m.atmCall).toBe("AAA261030C00100000");
    expect(m.atmPut).toBe("AAA261030P00100000");
    expect(m.atmIv).toBeCloseTo(0.3, 2);
    expect(m.iv30).toBeCloseTo(0.3, 2);
    expect(m.hv20).toBe(0.25);
    expect(m.termSlope).toBeGreaterThan(3); // the 58-day expiry is 6 vol points over the front
    expect(m.impliedMovePct).toBeGreaterThan(3);
    expect(m.impliedMovePct).toBeLessThan(10);
    expect(m.putCallVolumeRatio).toBeCloseTo(1, 6);
    expect(m.ivRank).toBeNull(); // no history yet
    expect(m.unusual).toEqual([{ occ: "AAA261030C00100000", volume: 600, openInterest: 250, ratio: 2.4 }]);
    expect(result.requests).toBeGreaterThanOrEqual(1);
    expect(m.atmCallQuote?.delta).toBeGreaterThan(0.4);
    expect(m.atmPutQuote?.delta).toBeLessThan(-0.3);
    expect(result.selection.contracts).toEqual(["AAA261030C00100000", "AAA261030P00100000"]);
    expect(store.latestOptionMetrics(["AAA"]).get("AAA")?.atmExpiry).toBe("2026-10-30");
    expect(expiries.length).toBe(4);
  });

  it("keeps the priority order it is given and streams holdings first", async () => {
    const held: OptionPosition = {
      kind: "option", occ: "ZZZ261120C00050000", underlying: "ZZZ", expiry: "2026-11-20", strike: 50, right: "call", quantity: 1, cost: null, openedAt: null,
    };
    const order: string[] = [];
    const result = await sweep.runSweep({
      underlyings: () => ["ZZZ", "AAA"],
      holdings: () => [held],
      prices: async (syms) => { order.push(...syms); return new Map(syms.map((s) => [s, 100])); },
      snapshots: async (u) => fakeChain(u, 100, { "2026-11-20": 0.3 }),
      hv20: () => null,
      openInterest: async () => new Map<string, number>(),
      now: () => NOW,
      config: { ...cfg, streamMax: 3 },
    });
    expect(order).toEqual(["ZZZ", "AAA"]);
    // The held contract takes one of three slots; ZZZ (first in priority) takes the other two, so AAA is skipped.
    expect(result.selection.contracts[0]).toBe("ZZZ261120C00050000");
    expect(result.selection.contracts).toHaveLength(3);
    expect(result.selection.skipped).toEqual(["AAA"]);
  });

  it("prefers the stream's quote when it is fresh", async () => {
    const run = (at: number) =>
      sweep.runSweep({
        underlyings: () => ["LIV"], holdings: () => [], prices: async () => new Map([["LIV", 100]]),
        snapshots: async (u) => fakeChain(u, 100, { "2026-11-20": 0.3 }),
        hv20: () => null,
      openInterest: async () => new Map<string, number>(), now: () => NOW, config: cfg,
        live: () => ({ bid: 1.5, ask: 1.6, delta: 0.99, at }),
      });
    expect((await run(NOW - 30_000)).metrics[0].atmCallQuote).toEqual({ bid: 1.5, ask: 1.6, delta: 0.99 });
    expect((await run(NOW - 5 * 60_000)).metrics[0].atmCallQuote?.delta).toBeLessThan(0.9);
  });

  it("writes iv_history only near the close and ranks against prior days", async () => {
    const close = Date.parse("2026-10-21T19:57:00Z");
    for (let i = 0; i < 25; i++) {
      const d = new Date(Date.parse("2026-09-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      store.upsertIvDay({ symbol: "RNK", day: d, iv30: 0.2 + i * 0.01, atmIv: null, hv20: null });
    }
    const run = (now: number) =>
      sweep.runSweep({
        underlyings: () => ["RNK"], holdings: () => [], prices: async () => new Map([["RNK", 100]]),
        snapshots: async (u) => fakeChain(u, 100, { "2026-11-20": 0.3, "2026-10-30": 0.3, "2026-12-18": 0.3 }),
        hv20: () => null,
      openInterest: async () => new Map<string, number>(), now: () => now, config: cfg,
      });
    const midday = await run(NOW);
    expect(midday.metrics[0].ivHistoryDays).toBe(26); // 25 prior days plus today
    expect(midday.metrics[0].ivRank).toBeCloseTo(((0.3 - 0.2) / (0.44 - 0.2)) * 100, 0);
    expect(store.ivHistory("RNK").some((r) => r.day === "2026-10-21")).toBe(false);
    await run(close);
    expect(store.ivHistory("RNK").some((r) => r.day === "2026-10-21")).toBe(true);
  });
});
