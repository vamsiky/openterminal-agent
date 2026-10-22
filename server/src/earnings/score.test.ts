import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EventStats, Horizon } from "./contracts.js";

const tmp = mkdtempSync(join(tmpdir(), "earn-score-"));
process.env.DATA_DIR = tmp;
const score = await import("./score.js");
const weights = await import("./weights.js");
const { db } = await import("../db.js");
const { earningsDb } = await import("./db.js");

afterAll(() => {
  db.close();
  earningsDb.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const dist = (median: number, winRate: number, n = 10) => ({ n, median, mean: median, p25: median - 2, p75: median + 2, winRate });
const stats = (over: Partial<EventStats> = {}): EventStats => ({
  scope: { symbol: "X", sector: null, capBucket: null }, horizon: "intraday", time: "amc", n: 10, nOptions: 10,
  stock: dist(0.5, 0.6), call: dist(10, 0.6), otmCall: null, callBeta: 6, callAlpha: 1, flatDayCall: -5,
  preDrift: { t0OpenFrom10: dist(0.2, 0.5), rCloseFromPrev: dist(0.3, 0.5) },
  impliedVsRealized: { medianImplied: null, medianRealized: null, ratio: null }, ivRamp: {},
  reactions: { upShare: 0.5, medianAbs: 5, last4: [1, 2, -1, 3] }, ...over,
});
const cand = (over: Partial<import("./score.js").Candidate> = {}): import("./score.js").Candidate => ({
  kind: "event", leg: "atm_call", occ: "X261023C00100000", expiry: "2026-10-23", strike: 100, bid: 2.0, ask: 2.2, iv: 0.6, delta: 0.5, volume: 100, openInterest: 500, ...over,
});
const inputs = (over: Partial<import("./score.js").ScoreInputs> = {}): import("./score.js").ScoreInputs => ({
  symbol: "X", name: "X Corp", sector: "Technology", industry: null, marketCap: 5e9,
  upcoming: { reportDate: "2026-10-22", time: "amc", timeSource: "fmp", fmpConfirmed: true, t0: "2026-10-22", epsEstimate: 1, revenueEstimate: 100, fiscalPeriod: "Q3" },
  horizon: "intraday", asOf: "2026-10-21T20:00:00Z", price: 100,
  tech: { vs20: 2, vs50: 3, vs200: 4, rsi: 60, atrPct: 4, momentum: 80 },
  candidates: [cand()], hasOptions: true, impliedMovePct: 7, eventPremium: 1.2, typicalIv: null,
  own: stats(), pooled: null,
  lastReport: { date: "2026-07-22", epsActual: 1.1, epsEstimate: 1, revenueActual: 101, revenueEstimate: 100, reactionPct: 4 },
  revisions: { eps30d: null, eps90d: null, revenue30d: null },
  analyst: [{ date: "2026-10-20", firm: "F", action: "target raise", priceTarget: 120 }],
  ...over,
});
const pts = (s: import("./contracts.js").EarningsSetup) => Object.fromEntries(s.components.map((c) => [c.key, c.points]));

describe("intraday components", () => {
  const s = score.scoreSetup(inputs());
  const p = pts(s);

  it("tradability: max x (1 - spread/30), -5 under 50 contracts", () => {
    expect(p.tradability).toBeCloseTo(25 * (1 - 9.5238 / 30), 1);
    const low = pts(score.scoreSetup(inputs({ candidates: [cand({ volume: 10 })] })));
    expect(low.tradability).toBeCloseTo(p.tradability - 5, 1);
    expect(pts(score.scoreSetup(inputs({ candidates: [cand({ bid: 1, ask: 2 })] }))).tradability).toBe(0); // 67% wide
  });

  it("history: blended call median mapped -10..+10 plus win rate x 10", () => {
    // blended median (10*10 + 5*0)/15 = 6.67 -> 20 * 16.67/20; blended win (10*.6 + 5*.5)/15 = .567 -> 5.67
    expect(p.history).toBeCloseTo(22.33, 1);
    const pooled = stats({ call: dist(-10, 0.3), stock: dist(0, 0.3) });
    const withPool = pts(score.scoreSetup(inputs({ pooled })));
    expect(withPool.history).toBeCloseTo(13.33 + 5, 1); // median (10*10 + 5*-10)/15 = 3.33, win (10*.6 + 5*.3)/15 = .5
    const none = pts(score.scoreSetup(inputs({ own: null, pooled: null })));
    expect(none.history).toBeCloseTo(10 + 5, 1); // neutral
    expect(s.history.blended.k).toBe(5);
  });

  it("setup: SMA 3/4/3, momentum / 10, RSI penalties", () => {
    expect(p.setup).toBeCloseTo(10 + 8, 1);
    const q = (rsi: number, extra: Partial<import("./score.js").Tech> = {}) => pts(score.scoreSetup(inputs({ tech: { vs20: 2, vs50: 3, vs200: 4, rsi, atrPct: 4, momentum: 80, ...extra } }))).setup;
    expect(q(80)).toBeCloseTo(18 - 5, 1);
    expect(q(90)).toBeCloseTo(18 - 8, 1);
    expect(q(30)).toBeCloseTo(18 - 3, 1);
    expect(q(60, { vs20: -1, vs200: -1 })).toBeCloseTo(4 + 8, 1);
  });

  it("demand: reactions, analyst raise/cut, beat, drift", () => {
    expect(p.demand).toBeCloseTo(4.5 + 3 + 3 + 1.5, 1);
    const d = (over: Partial<import("./score.js").ScoreInputs>) => pts(score.scoreSetup(inputs(over))).demand;
    expect(d({ analyst: [{ date: "2026-10-20", firm: "F", action: "target cut", priceTarget: 90 }] })).toBeCloseTo(4.5 - 2 + 3 + 1.5, 1);
    expect(d({ analyst: [] })).toBeCloseTo(4.5 + 3 + 1.5, 1);
    expect(d({ lastReport: { date: "x", epsActual: 1.1, epsEstimate: 1, revenueActual: 99, revenueEstimate: 100, reactionPct: 1 } })).toBeCloseTo(4.5 + 3 + 1.5 + 1.5, 1);
  });

  it("carry: break-even against half the ATR", () => {
    // leverage 0.5*100/2.1 = 23.8; decay 5; break-even (9.52 + 5)/23.8 = 0.61; target 2 -> 10 * (1 - 0.305)
    expect(p.carry).toBeCloseTo(6.95, 1);
    expect(s.contract!.leverage).toBeCloseTo(23.8, 1);
    expect(s.contract!.breakevenStockMovePct).toBeCloseTo(0.61, 2);
    const wide = pts(score.scoreSetup(inputs({ candidates: [cand({ bid: 1.7, ask: 2.3 })], tech: { vs20: 1, vs50: 1, vs200: 1, rsi: 60, atrPct: 2, momentum: 50 } }))).carry;
    expect(wide).toBe(0);
  });

  it("every component has a reason sentence with numbers and the total is the sum", () => {
    for (const c of s.components) {
      expect(c.reason).toMatch(/\d/);
      expect(c.points).toBeLessThanOrEqual(c.max);
    }
    expect(s.components.map((c) => c.max)).toEqual([25, 30, 20, 15, 10]);
    expect(s.score).toBe(Math.round(s.components.reduce((a, c) => a + c.points, 0)));
    expect(s.weightsVersion).toBe(weights.EARNINGS_WEIGHTS_VERSION);
  });
});

describe("gates and verdict bands", () => {
  const gate = (s: import("./contracts.js").EarningsSetup, key: string) => s.gates.find((g) => g.key === key)!;
  it("passes every gate on the base setup", () => {
    expect(score.scoreSetup(inputs()).gates.every((g) => g.passed)).toBe(true);
  });
  it("each failed gate forces pass whatever the score", () => {
    const cases: Array<[string, Partial<import("./score.js").ScoreInputs>]> = [
      ["spread", { candidates: [cand({ bid: 2.0, ask: 2.5 })] }], // 22%
      ["volume", { candidates: [cand({ volume: 49 })] }],
      ["no_options", { candidates: [], hasOptions: false }],
      ["no_quote", { candidates: [], hasOptions: true }], // options exist but no snapshot in the last 4 days
      ["unconfirmed_time", { upcoming: { ...inputs().upcoming, time: null, timeSource: null } }],
      ["no_quote", { candidates: [cand({ bid: null, ask: null })] }],
    ];
    for (const [key, over] of cases) {
      const s = score.scoreSetup(inputs(over));
      expect(gate(s, key).passed, key).toBe(false);
      expect(s.verdict, key).toBe("pass");
    }
    // The base score is a candidate, so the pass above is the gate's doing.
    expect(score.scoreSetup(inputs()).verdict).toBe("candidate");
    expect(score.scoreSetup(inputs({ candidates: [cand({ volume: 49 })] })).score).toBeGreaterThanOrEqual(70);
  });
  it("no snapshot: no_options only when the name has no options at all, otherwise no_quote", () => {
    const stale = score.scoreSetup(inputs({ candidates: [], hasOptions: true }));
    expect(gate(stale, "no_options").passed).toBe(true);
    expect(gate(stale, "no_quote")).toMatchObject({ passed: false, reason: "No live quote in the last 4 days." });
    const none = score.scoreSetup(inputs({ candidates: [], hasOptions: false }));
    expect(gate(none, "no_options").passed).toBe(false);
  });
  it("analyst actions count only inside the horizon's window (10 days intraday, 30 week and month)", () => {
    const old = [{ date: "2026-10-05", firm: "F", action: "target raise", priceTarget: 120 }]; // 16 days before asOf
    expect(pts(score.scoreSetup(inputs({ analyst: old }))).demand).toBeCloseTo(pts(score.scoreSetup(inputs({ analyst: [] }))).demand, 5);
    expect(score.scoreSetup(inputs({ analyst: old })).analyst).toHaveLength(1); // still listed (30 days), just not scored
    const wk = score.scoreSetup(inputs({ horizon: "week", analyst: old }));
    expect(wk.analyst).toHaveLength(1);
    expect(wk.components[3].reason).toMatch(/raised in 30 days/);
    expect(score.scoreSetup(inputs()).components[3].reason).toMatch(/raised in 10 days/);
  });
  it("bands: 70+ candidate, 55-69 conditional, below pass", () => {
    const weak = { tech: { vs20: 2, vs50: 3, vs200: 4, rsi: 90, atrPct: 4, momentum: 0 } };
    const weaker = { ...weak, own: stats({ call: dist(-10, 0.1), stock: dist(-1, 0.1) }), analyst: [], lastReport: null };
    const seen = [inputs(), inputs(weak), inputs(weaker)].map((i) => score.scoreSetup(i));
    expect(seen.map((s) => s.verdict)).toEqual(["candidate", "conditional", "pass"]);
    for (const s of seen) expect(s.verdict).toBe(s.score >= 70 ? "candidate" : s.score >= 55 ? "conditional" : "pass");
  });
});

describe("contract choice", () => {
  it("picks the lowest-spread call among ATM and OTM in the event expiry", () => {
    const c = score.chooseContract([cand({ strike: 100, bid: 2, ask: 2.4 }), cand({ leg: "otm_call", strike: 105, bid: 1, ask: 1.05 }), cand({ kind: "next", expiry: "2026-11-20", bid: 5, ask: 5.01 })], "intraday", "2026-10-21")!;
    expect(c.strike).toBe(105);
  });
  it("prefers a leg that passes both the spread and volume gates (FLEX 2026-10-22)", () => {
    const atm = cand({ strike: 75, bid: 8.5, ask: 9.1, volume: 1, expiry: "2026-11-20" });
    const up = cand({ leg: "otm_call", strike: 80, bid: 6.1, ask: 6.7, volume: 425, expiry: "2026-11-20" });
    expect(score.chooseContract([atm, up], "week", "2026-10-22")!.strike).toBe(80);
    const s = score.scoreSetup(inputs({ candidates: [atm, up], asOf: "2026-10-22T19:15:00Z" }));
    expect(s.gates.find((g) => g.key === "volume")!.passed).toBe(true);
    expect(s.gates.find((g) => g.key === "spread")!.passed).toBe(true);
  });
  it("falls back to the lowest spread when no leg passes both gates", () => {
    const a = cand({ strike: 75, bid: 8.5, ask: 9.1, volume: 1 });
    const b = cand({ leg: "otm_call", strike: 80, bid: 6.1, ask: 6.7, volume: 10 });
    expect(score.chooseContract([a, b], "intraday", "2026-10-21")!.strike).toBe(75);
    const wide = cand({ strike: 70, bid: 1, ask: 2, volume: 500 });
    expect(score.chooseContract([wide, a], "intraday", "2026-10-21")!.strike).toBe(75);
  });
  it("month takes the first expiry (event or next) 25+ days from entry", () => {
    const list = [cand({ expiry: "2026-10-23" }), cand({ kind: "next", expiry: "2026-11-20", strike: 101 })];
    expect(score.chooseContract(list, "month", "2026-10-21")!.expiry).toBe("2026-11-20");
    expect(score.chooseContract([cand({ expiry: "2026-11-20" }), ...list.slice(1)], "month", "2026-10-21")!.kind).toBe("event");
    // Neither qualifies: fall back to the event expiry.
    expect(score.chooseContract([cand({ expiry: "2026-10-23" }), cand({ kind: "next", expiry: "2026-10-30" })], "month", "2026-10-21")!.expiry).toBe("2026-10-23");
    expect(score.chooseContract(list, "week", "2026-10-21")!.expiry).toBe("2026-10-23");
  });
});

describe("setup reason text", () => {
  const reason = (tech: Partial<import("./score.js").ScoreInputs["tech"]>) => score.scoreSetup(inputs({ tech: { vs20: 2, vs50: 3, vs200: 4, rsi: 60, atrPct: 4, momentum: 80, ...tech } })).components[2].reason;
  it("names the averages above and below", () => {
    expect(reason({})).toMatch(/^Above its 20\/50\/200-day averages \(/);
    expect(reason({ vs50: -1, vs200: -2 })).toMatch(/^Above its 20-day average, below its 50\/200-day averages \(/);
    expect(reason({ vs20: -1, vs50: -1, vs200: -2 })).toMatch(/^Below its 20\/50\/200-day averages \(/);
    expect(reason({ vs200: null })).toMatch(/^Above its 20\/50-day averages \(/);
  });
});

describe("week and month", () => {
  it("weights sum to 100 per horizon", () => {
    for (const h of ["intraday", "week", "month"] as Horizon[]) expect(Object.values(weights.WEIGHTS[h].max).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("demand uses 30-day analyst windows and EPS revisions; carry rewards cheap vol", () => {
    const base = (h: Horizon, over: Partial<import("./score.js").ScoreInputs> = {}) => score.scoreSetup(inputs({ horizon: h, candidates: [cand({ expiry: "2026-11-20" })], own: stats({ stock: { ...dist(1, 0.6), p25: -4, p75: 6 } }), ...over }));
    const up = base("week", { revisions: { eps30d: 5, eps90d: 5, revenue30d: null } });
    const down = base("week", { revisions: { eps30d: -5, eps90d: null, revenue30d: null } });
    expect(pts(up).demand - pts(down).demand).toBeCloseTo(3 + 2 + 3, 1);
    expect(base("month").components.map((c) => c.max)).toEqual([15, 20, 25, 25, 15]);
    const cheap = pts(base("week", { typicalIv: 0.9 })).carry; // iv .6 / .9 = .67x
    const rich = pts(base("week", { typicalIv: 0.4 })).carry; // 1.5x
    expect(cheap - rich).toBeCloseTo(5, 1);
  });
});
