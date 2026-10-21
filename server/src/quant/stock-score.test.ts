import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let ss: typeof import("./stock-score.js");
let db: typeof import("../db.js").db;

const DAY = "2026-10-21";
const NOW = new Date("2026-10-21T21:00:00Z"); // 17:00 New York

function bars(symbol: string, n: number, price: (i: number) => number) {
  const insert = db.prepare("INSERT OR REPLACE INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const day = new Date(Date.parse(`${DAY}T00:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      const p = price(i);
      insert.run(symbol, day, p, p, p, p, 1_000_000);
    }
  })();
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-stockscore-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  ss = await import("./stock-score.js");

  const profile = db.prepare(
    `INSERT INTO bulk_profiles (symbol, company_name, exchange, sector, industry, country, price, market_cap, average_volume, is_etf, is_fund, is_adr, is_actively_trading, data, updated_at)
     VALUES (?, ?, 'NASDAQ', ?, 'x', 'US', 100, 1e9, 1e6, 0, 0, 0, 1, '{}', '')`
  );
  const ratios = db.prepare("INSERT INTO bulk_ratios_ttm (symbol, pe, gross_margin, data, updated_at) VALUES (?, ?, ?, '{}', '')");
  const metrics = db.prepare("INSERT INTO bulk_key_metrics_ttm (symbol, roic, net_debt_to_ebitda, data, updated_at) VALUES (?, ?, ?, '{}', '')");
  // Eight Technology stocks: P/E 10..80 and one loss maker (-5); ROIC rises with the number, leverage too.
  const pes = [10, 20, 30, 40, 50, 60, 70, -5];
  pes.forEach((pe, i) => {
    const s = `T${i}`;
    profile.run(s, s, "Technology");
    ratios.run(s, pe, 0.3 + i * 0.05);
    metrics.run(s, 0.05 * (i + 1), i);
  });
  // A sector too small to rank against itself (2 peers) falls back to the whole market.
  for (const [s, pe] of [["U0", 12], ["U1", 90]] as const) {
    profile.run(s, s, "Utilities");
    ratios.run(s, pe, 0.5);
  }
  // Momentum: T0 trends up strongly for 300 days, T1 is flat. SPY flat.
  bars("T0", 300, (i) => 50 + i * 0.5);
  bars("T1", 300, () => 100);
  bars("SPY", 300, () => 400);
  bars("XLK", 300, () => 200);
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("percentile", () => {
  it("is rank-based with average ranks for ties", () => {
    expect(ss.percentile([1, 2, 3, 4, 5], 3)).toBe(50);
    expect(ss.percentile([1, 2, 3, 4, 5], 1)).toBe(0);
    expect(ss.percentile([1, 2, 3, 4, 5], 5)).toBe(100);
    expect(ss.percentile([1, 1, 1, 5], 1)).toBeCloseTo((1 / 3) * 100, 9); // average rank 1 of 0..3
    expect(ss.percentile([7], 7)).toBe(50);
    expect(ss.percentile([1, 2, 3], 10)).toBe(100);
  });
});

describe("nightly scorecards", () => {
  it("scores lower P/E higher and a loss maker worst", () => {
    const r = ss.runNightlyScorecards(NOW);
    expect(r.scored).toBe(10);
    const pe = (s: string) => ss.getStockScorecard(s)!.factors.find((f) => f.key === "pe")!;
    expect(pe("T0").score).toBe(100); // cheapest of the sector
    expect(pe("T0").score!).toBeGreaterThan(pe("T1").score!);
    expect(pe("T6").score!).toBeGreaterThan(pe("T7").score!);
    expect(pe("T7").score).toBe(0);
    expect(pe("T7").value).toBe(-5);
  });

  it("treats higher ROIC as better and higher leverage as worse", () => {
    const f = (s: string, k: string) => ss.getStockScorecard(s)!.factors.find((x) => x.key === k)!.score!;
    expect(f("T7", "roic")).toBeGreaterThan(f("T0", "roic"));
    expect(f("T0", "net_debt_to_ebitda")).toBeGreaterThan(f("T7", "net_debt_to_ebitda"));
  });

  it("ranks a small sector against the whole market", () => {
    const u = (s: string) => ss.getStockScorecard(s)!.factors.find((x) => x.key === "pe")!.score!;
    // P/E 12 is the second cheapest of the 9 positive values (10 is cheaper) among 10 ranked values.
    expect(u("U0")).toBeGreaterThan(u("U1"));
    expect(u("U0")).toBeGreaterThan(80);
  });

  it("computes momentum from daily bars and re-normalises missing groups", () => {
    const t0 = ss.getStockScorecard("T0")!;
    const m = (k: string) => t0.factors.find((f) => f.key === k)!;
    expect(m("ret_6m").value).toBeCloseTo((50 + 299 * 0.5) / (50 + 173 * 0.5) - 1, 6);
    expect(m("vs_sma50").value!).toBeGreaterThan(0);
    // Relative strength: 6-month excess over flat SPY, 3-month excess over the flat sector ETF (XLK), both ranked market-wide.
    expect(m("rs_spy").value).toBeCloseTo(m("ret_6m").value!, 9);
    expect(m("rs_sector").value).toBeCloseTo((50 + 299 * 0.5) / (50 + 236 * 0.5) - 1, 6);
    expect(t0.weightsVersion).toBe("stock-v2");
    expect(t0.groups.momentum).not.toBeNull();
    expect(t0.groups.analysts).toBeNull();
    expect(t0.composite).not.toBeNull();
    expect(t0.coverage).toBeGreaterThan(0.3);
    expect(t0.coverage).toBeLessThan(0.6);
    // Only valuation, quality and momentum have data here, re-normalised over their weights.
    const g = t0.groups;
    const expected = (g.valuation! * 0.2 + g.quality! * 0.2 + g.momentum! * 0.2 + (g.growth ?? 0) * 0) / 0.6;
    expect(t0.composite!).toBeCloseTo(expected, 3);
    // T0 outperforms flat T1 on momentum.
    expect(t0.groups.momentum!).toBeGreaterThan(ss.getStockScorecard("T1")!.groups.momentum!);
  });

  it("stores history and fills factor changes against a card ~28 days earlier", () => {
    db.prepare("UPDATE scorecards SET day = '2026-09-23'").run();
    ss.runNightlyScorecards(NOW);
    const t = ss.getStockScorecard("T0")!;
    expect(t.factors.find((f) => f.key === "pe")!.change).toBe(0);
    expect(ss.latestScorecardDay()).toBe(DAY);
    expect(db.prepare("SELECT COUNT(*) AS n FROM scorecards").get()).toEqual({ n: 20 });
  });

  it("drops factor detail from cards older than 45 days but keeps the composite", () => {
    db.prepare("UPDATE scorecards SET day = '2026-08-01' WHERE day = '2026-09-23'").run();
    ss.runNightlyScorecards(NOW);
    const old = db.prepare("SELECT composite, factors FROM scorecards WHERE day = '2026-08-01' AND symbol = 'T0'").get() as { composite: number; factors: string | null };
    expect(old.factors).toBeNull();
    expect(old.composite).not.toBeNull();
  });

  it("answers composite and top queries", () => {
    const m = ss.compositeMap(["T0", "T1", "NOPE"]);
    expect([...m.keys()].sort()).toEqual(["T0", "T1"]);
    const top = ss.topNightly(["T0", "T1", "T2"], 0, 2);
    expect(top).toHaveLength(2);
    expect(top[0].composite!).toBeGreaterThanOrEqual(top[1].composite!);
  });
});

describe("intraday scan", () => {
  it("rescored momentum with the latest bar's price and ranks the universe", () => {
    const r = ss.runIntradayStockScan(["T0", "T1", "ZZZ"], NOW);
    expect(r.scored).toBe(2);
    const a = ss.getLiveScorecard("T0")!;
    const b = ss.getLiveScorecard("T1")!;
    expect(a.rank).toBe(a.composite! > b.composite! ? 1 : 2);
    expect(a.factors.map((f) => f.key)).toContain("price_vs_vwap");
    expect(a.factors.find((f) => f.key === "price_vs_vwap")!.score).toBeNull(); // no minute bars seeded
    expect(ss.getLiveScorecard("ZZZ")).toBeNull();
  });
});
