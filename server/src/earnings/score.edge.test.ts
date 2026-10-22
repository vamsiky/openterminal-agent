import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EarningsSetup, EventStats, Horizon } from "./contracts.js";

let tmp: string;
let score: typeof import("./score.js");
let db: typeof import("../db.js").db;
let edb: typeof import("./db.js").earningsDb;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-score-edge-"));
  process.env.DATA_DIR = tmp;
  ({ db } = await import("../db.js"));
  await import("../research/bulk-store.js");
  ({ earningsDb: edb } = await import("./db.js"));
  score = await import("./score.js");
});
afterAll(() => {
  db.close();
  edb.close();
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
type Cand = import("./score.js").Candidate;
const cand = (over: Partial<Cand> = {}): Cand => ({
  kind: "event", leg: "atm_call", occ: "X261023C00100000", expiry: "2026-10-23", strike: 100, bid: 2.0, ask: 2.2, iv: 0.6, delta: 0.5, volume: 100, openInterest: 500, ...over,
});
type Inputs = import("./score.js").ScoreInputs;
const baseInputs = (): Inputs => ({
  symbol: "X", name: "X Corp", sector: "Technology", industry: null, marketCap: 5e9,
  upcoming: { reportDate: "2026-10-22", time: "amc", timeSource: "fmp", fmpConfirmed: true, t0: "2026-10-22", epsEstimate: 1, revenueEstimate: 100, fiscalPeriod: "Q3" },
  horizon: "intraday", asOf: "2026-10-21T20:00:00Z", price: 100,
  tech: { vs20: 2, vs50: 3, vs200: 4, rsi: 60, atrPct: 4, momentum: 80 },
  candidates: [cand()], hasOptions: true, impliedMovePct: 7, eventPremium: 1.2, typicalIv: null,
  own: stats(), pooled: null,
  lastReport: { date: "2026-07-22", epsActual: 1.1, epsEstimate: 1, revenueActual: 101, revenueEstimate: 100, reactionPct: 4 },
  revisions: { eps30d: null, eps90d: null, revenue30d: null },
  analyst: [{ date: "2026-10-20", firm: "F", action: "target raise", priceTarget: 120 }],
});
const inputs = (over: Partial<Inputs> = {}): Inputs => ({ ...baseInputs(), ...over });
const gateKeys = (s: EarningsSetup) => s.gates.filter((g) => !g.passed).map((g) => g.key);
const pts = (s: EarningsSetup) => Object.fromEntries(s.components.map((c) => [c.key, c.points]));

describe("history shrinkage: blended = (n*own + k*pool) / (n + k), k = 5", () => {
  it("n = 1 and n = 10, with a pool and without", () => {
    expect(score.blend(1, 10, 0, 0, 5)).toBeCloseTo(10 / 6, 6); // one own event, pool 0
    expect(score.blend(1, 10, 4, 0, 5)).toBeCloseTo((10 + 5 * 4) / 6, 6);
    expect(score.blend(10, 10, 4, 0, 5)).toBeCloseTo((100 + 20) / 15, 6);
    expect(score.blend(10, 10, null, 0, 5)).toBeCloseTo((100 + 0) / 15, 6); // no pool: shrinks toward the neutral prior 0
  });
  it("n = 0 falls back to the pool entirely, and to nothing without a pool", () => {
    expect(score.blend(0, 10, 4, 0, 5)).toBe(4);
    expect(score.blend(0, null, null, 0.5, 5)).toBeNull();
  });
});

describe("pool fallback: sector x cap, then cap, then all", () => {
  const horizon: Horizon = "intraday";
  const put = (scope: string, n: number, sector: string | null, cap: string | null) =>
    edb.prepare("INSERT OR REPLACE INTO stats (scope_key, horizon, time, json, n) VALUES (?, 'intraday', 'any', ?, ?)").run(
      scope, JSON.stringify(stats({ n, scope: { symbol: null, sector, capBucket: cap as never } })), n
    );
  const profile = (symbol: string, sector: string, cap: number) =>
    db.prepare("INSERT OR REPLACE INTO bulk_profiles (symbol, company_name, sector, industry, market_cap, data, updated_at) VALUES (?, ?, ?, 'i', ?, '{}', 'x')").run(symbol, symbol, sector, cap);
  const row = (symbol: string) => ({
    symbol, report_date: "2026-10-22", time: "amc", time_source: "fmp", t0: "2026-10-22", r: "2026-10-23", fiscal_period: null, eps_estimate: null, revenue_estimate: null, fmp_confirmed_flag: 1,
  }) as never;
  const pooledOf = (symbol: string) => score.gather([row(symbol)], horizon, new Date("2026-10-21T21:00:00Z"))[0].pooled!;

  beforeAll(() => {
    db.exec("DELETE FROM bulk_profiles");
    edb.exec("DELETE FROM stats");
    profile("SEC", "Technology", 5e9); // mid
    profile("CAP", "Energy", 5e9); // mid, a sector with no pool
    profile("NOP", "Energy", 50e6); // micro, no pool at all
  });

  it("uses the sector x cap pool when it has at least 20 events", () => {
    put("pool:Technology:mid", 25, "Technology", "mid");
    put("cap:mid", 300, null, "mid");
    put("all", 900, null, null);
    const p = pooledOf("SEC");
    expect(p.n).toBe(25);
    expect(p.scope).toMatchObject({ sector: "Technology", capBucket: "mid" });
  });

  it("falls back to the cap bucket when the sector pool has fewer than 20 events", () => {
    put("pool:Technology:mid", 5, "Technology", "mid");
    expect(pooledOf("SEC").scope).toMatchObject({ sector: null, capBucket: "mid" });
    expect(pooledOf("SEC").n).toBe(300);
  });

  it("falls back to all events when the cap bucket has no stats", () => {
    edb.prepare("DELETE FROM stats WHERE scope_key LIKE 'cap:%' OR scope_key LIKE 'pool:%'").run(); // no sector pool and no cap stats for CAP
    put("all", 900, null, null);
    expect(pooledOf("CAP").n).toBe(900);
    expect(pooledOf("CAP").scope).toMatchObject({ symbol: null, sector: null, capBucket: null });
  });

  it("a name with no market cap goes straight to all events", () => {
    db.prepare("INSERT OR REPLACE INTO bulk_profiles (symbol, company_name, sector, industry, market_cap, data, updated_at) VALUES ('NOCAP', 'x', 'Technology', 'i', NULL, '{}', 'x')").run();
    expect(pooledOf("NOCAP").n).toBe(900);
  });
});

describe("gates on their own", () => {
  it("a spread of 14.9% passes and 15.1% fails", () => {
    // mid 2.1: spread = (ask - bid) / mid.
    const at = (spreadPct: number) => {
      const mid = 2.1;
      const half = (spreadPct / 100) * mid / 2;
      return score.scoreSetup(inputs({ candidates: [cand({ bid: mid - half, ask: mid + half })] }));
    };
    expect(gateKeys(at(14.9))).toEqual([]);
    expect(gateKeys(at(15.1))).toEqual(["spread"]);
    expect(at(15.1).verdict).toBe("pass");
  });

  it("volume 49 fails and 50 passes, with nothing else failing", () => {
    expect(gateKeys(score.scoreSetup(inputs({ candidates: [cand({ volume: 49 })] })))).toEqual(["volume"]);
    expect(gateKeys(score.scoreSetup(inputs({ candidates: [cand({ volume: 50 })] })))).toEqual([]);
  });

  it("time unknown fails only unconfirmed_time", () => {
    const s = score.scoreSetup(inputs({ upcoming: { ...baseInputs().upcoming, time: null, timeSource: null } }));
    expect(gateKeys(s)).toEqual(["unconfirmed_time"]);
    expect(s.gates.find((g) => g.key === "unconfirmed_time")!.reason).toMatch(/unknown/);
  });

  it("no options at all fails no_options; options listed but no quote fails no_quote, not no_options", () => {
    const none = score.scoreSetup(inputs({ candidates: [], hasOptions: false }));
    expect(none.gates.find((g) => g.key === "no_options")!.passed).toBe(false);
    const stale = score.scoreSetup(inputs({ candidates: [], hasOptions: true }));
    expect(stale.gates.find((g) => g.key === "no_options")!.passed).toBe(true);
    expect(stale.gates.find((g) => g.key === "no_quote")!.passed).toBe(false);
    expect(stale.verdict).toBe("pass");
  });

  it("a contract with no two-sided quote fails no_quote (and the spread gate)", () => {
    const s = score.scoreSetup(inputs({ candidates: [cand({ bid: null, ask: null })] }));
    expect(gateKeys(s)).toEqual(expect.arrayContaining(["no_quote", "spread"]));
    expect(gateKeys(s)).not.toContain("no_options");
  });
});

describe("verdict bands", () => {
  it("55 to 69 is conditional, 70 and up candidate, 54 and under pass; every sampled score follows that rule", () => {
    const seen = new Map<number, EarningsSetup["verdict"]>();
    for (let m = 0; m <= 100; m += 0.25) {
      for (const rsi of [40, 60, 80]) {
        for (const callMedian of [-10, -5, 0, 5, 10]) {
          const s = score.scoreSetup(inputs({ tech: { vs20: 2, vs50: 3, vs200: 4, rsi, atrPct: 4, momentum: m }, own: stats({ call: dist(callMedian, 0.6) }) }));
          expect(s.gates.every((g) => g.passed)).toBe(true);
          const want = s.score >= 70 ? "candidate" : s.score >= 55 ? "conditional" : "pass";
          expect(s.verdict, `score ${s.score}`).toBe(want);
          seen.set(s.score, s.verdict);
        }
      }
    }
    for (const b of [54, 55, 69, 70]) expect(seen.has(b), `a score of exactly ${b} was reached`).toBe(true);
    expect(seen.get(54)).toBe("pass");
    expect(seen.get(55)).toBe("conditional");
    expect(seen.get(69)).toBe("conditional");
    expect(seen.get(70)).toBe("candidate");
  });
});

describe("analyst windows", () => {
  const raise = (date: string) => [{ date, firm: "F", action: "target raise", priceTarget: 120 }];
  const demandOf = (over: Partial<Inputs>) => pts(score.scoreSetup(inputs(over))).demand;

  it("intraday counts actions from 10 days back: 10 days is in, 11 days is out", () => {
    // asOf is 2026-10-21, so the window starts 2026-10-11.
    const none = demandOf({ analyst: [] });
    expect(demandOf({ analyst: raise("2026-10-11") }) - none).toBeCloseTo(3, 6); // analystRaise intraday = 3
    expect(demandOf({ analyst: raise("2026-10-10") }) - none).toBeCloseTo(0, 6);
  });

  it("week and month count 30 days back, and month weights a raise at 6", () => {
    const wk = (a: Inputs["analyst"]) => pts(score.scoreSetup(inputs({ horizon: "week", analyst: a }))).demand;
    const mo = (a: Inputs["analyst"]) => pts(score.scoreSetup(inputs({ horizon: "month", analyst: a }))).demand;
    expect(wk(raise("2026-09-21")) - wk([])).toBeCloseTo(5, 6); // 30 days back: in, weight 5
    expect(wk(raise("2026-09-20")) - wk([])).toBeCloseTo(0, 6);
    expect(mo(raise("2026-09-21")) - mo([])).toBeCloseTo(6, 6);
  });
});

describe("reasons carry their numbers", () => {
  it.each<Horizon>(["intraday", "week", "month"])("every component reason has a number when a contract is chosen (%s)", (h) => {
    const s = score.scoreSetup(inputs({ horizon: h, candidates: [cand({ expiry: "2026-11-20" })], typicalIv: 0.5 }));
    for (const c of s.components) expect(c.reason, c.key).toMatch(/\d/);
  });

  it("the tradability and history reasons quote the spread, volume, median and win rate", () => {
    const s = score.scoreSetup(inputs());
    const trad = s.components.find((c) => c.key === "tradability")!.reason;
    expect(trad).toMatch(/9\.5%/); // (2.2 - 2.0) / 2.1
    expect(trad).toMatch(/100 contracts/);
    const hist = s.components.find((c) => c.key === "history")!.reason;
    expect(hist).toMatch(/10 past intraday calls had a median of \+10\.0%/);
    expect(hist).toMatch(/win rate/);
  });
});
