import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmp: string;
let stats: typeof import("./stats.js");
let score: typeof import("./score.js");
let edb: typeof import("./db.js").earningsDb;
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-stats-"));
  process.env.DATA_DIR = tmp;
  ({ db } = await import("../db.js"));
  await import("../research/bulk-store.js");
  ({ earningsDb: edb } = await import("./db.js"));
  stats = await import("./stats.js");
  score = await import("./score.js");
});
afterAll(() => {
  db.close();
  edb.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("helpers", () => {
  it("dist: median, quartiles, win rate", () => {
    expect(stats.dist([])).toEqual({ n: 0, median: null, mean: null, p25: null, p75: null, winRate: null });
    expect(stats.dist([-2, 1, 3, 4, 10])).toEqual({ n: 5, median: 3, mean: 3.2, p25: 1, p75: 4, winRate: 0.8 });
  });
  it("ols recovers alpha and beta and refuses degenerate input", () => {
    const xs = [-2, -1, 0.3, 1, 2, 3];
    const fit = stats.ols(xs, xs.map((x) => 3 + 6 * x))!;
    expect(fit.alpha).toBeCloseTo(3);
    expect(fit.beta).toBeCloseTo(6);
    expect(stats.ols([1, 1, 1, 1, 1], [1, 2, 3, 4, 5])).toBeNull();
    expect(stats.ols([1, 2], [1, 2])).toBeNull();
  });
  it("cap buckets follow the contract thresholds", () => {
    expect(["299e6", "300e6", "1.9e9", "2e9", "9.9e9", "10e9", "199e9", "200e9"].map((x) => stats.capBucket(Number(x)))).toEqual(["micro", "small", "small", "mid", "mid", "large", "large", "mega"]);
    expect(stats.capBucket(null)).toBeNull();
  });
  it("shrinkage blends own and pooled with k", () => {
    expect(score.blend(5, 10, 0, 0, 5)).toBe(5); // (5*10 + 5*0) / 10
    expect(score.blend(15, 10, 2, 0, 5)).toBeCloseTo((15 * 10 + 5 * 2) / 20);
    expect(score.blend(0, null, 4, 0, 5)).toBe(4); // no own history: the pool
    expect(score.blend(3, 8, null, 0, 5)).toBeCloseTo((3 * 8) / 8); // no pool: shrinks toward the neutral prior
    expect(score.blend(0, null, null, 0, 5)).toBeNull();
  });
});

const ev = (symbol: string, date: string, over: Record<string, unknown> = {}) => {
  const o = { time: "amc", confirmed: 1, ...over };
  edb.prepare("INSERT OR REPLACE INTO events (symbol, report_date, time, t0, r, confirmed, check_fmp, reason) VALUES (?,?,?,?,?,?,1,'ok')").run(symbol, date, o.time, date, date, o.confirmed);
};
const path = (symbol: string, date: string, v: { s10: number; s1545: number; open?: number; close?: number; prev?: number; rClose?: number }) =>
  edb.prepare("INSERT OR REPLACE INTO stock_paths (symbol, report_date, t0_open, t0_1000, t0_1545, t0_close, r_close, prev_close, t0_m1) VALUES (?,?,?,?,?,?,?,?,?)").run(symbol, date, v.open ?? v.s10, v.s10, v.s1545, v.close ?? v.s1545, v.rClose ?? (v.close ?? v.s1545), v.close ?? v.s1545, v.prev ?? v.s10);
const leg = (symbol: string, date: string, leg: string, o10: number, o1545: number) =>
  edb.prepare("INSERT OR REPLACE INTO option_paths (symbol, report_date, entry, expiry_kind, leg, contract, expiry, strike, spot_at_entry, prices, price_source) VALUES (?,?,'T0:10:00','event',?,'X',?,100,100,?,'trade')").run(symbol, date, leg, date, JSON.stringify({ "T0:10:00": o10, "T0:15:45": o1545 }));

describe("rebuildStats", () => {
  const moves = [2, -1, 0.3, 1, -0.2, 0.5]; // stock % 10:00 -> 15:45
  it("computes EventStats per symbol and pooled scopes from confirmed events only", () => {
    const ins = db.prepare("INSERT OR REPLACE INTO bulk_profiles (symbol, company_name, sector, industry, market_cap, data, updated_at) VALUES (?,?,?,?,?,'{}','x')");
    ins.run("AAA", "A", "Technology", "i", 5e9);
    ins.run("BBB", "B", "Technology", "i", 6e9);
    moves.forEach((x, i) => {
      const d = `2025-0${i + 1}-15`;
      ev("AAA", d);
      // call% = 3 + 6 * stock%, so beta 6, alpha 3; reaction (close -> R close) alternates +10 / -5.
      path("AAA", d, { s10: 100, s1545: 100 * (1 + x / 100), close: 100, prev: i % 2 === 0 ? 99 : 101, rClose: i % 2 === 0 ? 110 : 95 });
      leg("AAA", d, "atm_call", 2, 2 * (1 + (3 + 6 * x) / 100));
      leg("AAA", d, "otm_call", 1, 1 * (1 + (3 + 6 * x) / 100) );
    });
    // BBB: two confirmed, one unconfirmed event with a huge move that must be ignored.
    ev("BBB", "2025-01-15"); path("BBB", "2025-01-15", { s10: 50, s1545: 51 });
    ev("BBB", "2025-02-15", { time: "bmo" }); path("BBB", "2025-02-15", { s10: 50, s1545: 49 });
    ev("BBB", "2025-03-15", { confirmed: 0 }); path("BBB", "2025-03-15", { s10: 50, s1545: 100 });

    const r = stats.rebuildStats();
    expect(r.scopes).toBeGreaterThan(10);

    const a = stats.getStats("sym:AAA", "intraday")!;
    expect(a.scope).toEqual({ symbol: "AAA", sector: "Technology", capBucket: "mid" });
    expect(a.n).toBe(6);
    expect(a.nOptions).toBe(6);
    expect(a.stock.median).toBeCloseTo(0.4, 3); // (0.3 + 0.5) / 2
    expect(a.stock.winRate).toBeCloseTo(0.5, 3);
    expect(a.call!.n).toBe(6);
    expect(a.callBeta).toBeCloseTo(6, 2);
    expect(a.callAlpha).toBeCloseTo(3, 2);
    expect(a.flatDayCall).toBeCloseTo(3 + 6 * 0.3, 2); // median over the three days with |stock| < 0.6
    expect(a.otmCall!.n).toBe(6);
    expect(a.reactions.upShare).toBeCloseTo(0.5, 3);
    expect(a.reactions.last4).toEqual([10, -5, 10, -5]);
    expect(a.reactions.medianAbs).toBeCloseTo(7.5, 3);
    expect(a.preDrift.rCloseFromPrev.n).toBe(6);
    // T0:close against the T0-1 close (99 / 101 alternating), not against stock_paths.prev_close.
    expect(a.preDrift.rCloseFromPrev.winRate).toBeCloseTo(0.5, 3);

    // The unconfirmed event is excluded from every scope.
    const b = stats.getStats("sym:BBB", "intraday")!;
    expect(b.n).toBe(2);
    expect(stats.getStats("sym:BBB", "intraday", "bmo")!.n).toBe(1);
    expect(stats.getStats("sym:BBB", "intraday", "amc")!.n).toBe(1);

    const pool = stats.getStats("pool:Technology:mid", "intraday")!;
    const cap = stats.getStats("cap:mid", "intraday")!;
    const all = stats.getStats("all", "intraday")!;
    expect([pool.n, cap.n, all.n]).toEqual([8, 8, 8]);
    expect(pool.scope).toEqual({ symbol: null, sector: "Technology", capBucket: "mid" });
    expect(pool.reactions.last4).toEqual([]);
    // Horizons without data (no T0-5 / T0-20 closes) store nothing.
    expect(stats.getStats("sym:AAA", "week")).toBeNull();
  });

  it("scope keys are rebuilt idempotently", () => {
    const n = (edb.prepare("SELECT COUNT(*) AS n FROM stats").get() as { n: number }).n;
    stats.rebuildStats();
    expect((edb.prepare("SELECT COUNT(*) AS n FROM stats").get() as { n: number }).n).toBe(n);
  });
});
