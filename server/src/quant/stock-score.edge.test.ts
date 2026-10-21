import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let ss: typeof import("./stock-score.js");
let weights: typeof import("./weights.js");
let db: typeof import("../db.js").db;

const NOW = new Date("2026-10-21T21:00:00Z"); // 17:00 New York, after the close

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-stockscore-edge-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  ss = await import("./stock-score.js");
  weights = await import("./weights.js");

  const profile = db.prepare(
    `INSERT INTO bulk_profiles (symbol, company_name, exchange, sector, industry, country, price, market_cap, average_volume, is_etf, is_fund, is_adr, is_actively_trading, data, updated_at)
     VALUES (?, ?, 'NASDAQ', ?, 'x', 'US', 100, 1e9, 1e6, 0, 0, 0, 1, '{}', '')`
  );
  const ratios = db.prepare("INSERT INTO bulk_ratios_ttm (symbol, pe, data, updated_at) VALUES (?, ?, '{}', '')");
  const metrics = db.prepare("INSERT INTO bulk_key_metrics_ttm (symbol, roic, data, updated_at) VALUES (?, ?, '{}', '')");
  const addStock = (symbol: string, sector: string, pe: number | null) => {
    profile.run(symbol, symbol, sector);
    if (pe !== null) ratios.run(symbol, pe);
  };

  // Energy: six stocks, P/E 10, 20, 20, 20, 30, 40 (three tied).
  [["E0", 10], ["E1", 20], ["E2", 20], ["E3", 20], ["E4", 30], ["E5", 40]].forEach(([s, pe]) => addStock(s as string, "Energy", pe as number));
  // Materials: four stocks, fewer than the five peers a sector needs, so they rank against everyone.
  [["M0", 10], ["M1", 20], ["M2", 30], ["M3", 40]].forEach(([s, pe]) => addStock(s as string, "Materials", pe as number));
  // Technology: exactly five stocks, which is enough to rank within the sector.
  [["T0", 15], ["T1", 25], ["T2", 35], ["T3", 45], ["T4", 55]].forEach(([s, pe]) => addStock(s as string, "Technology", pe as number));
  // Flat: five stocks with the same P/E.
  for (let i = 0; i < 5; i++) addStock(`F${i}`, "Flat", 10);
  // Bare: a profile with no fundamentals at all.
  addStock("BARE", "Energy", null);

  // Two Energy names with ROIC only: E0 low, E5 high. Only these two carry ROIC.
  metrics.run("E0", 0.05);
  metrics.run("E5", 0.3);

  const bar = db.prepare("INSERT OR REPLACE INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES ('SPY', ?, 400, 400, 400, 400, 1000000)");
  for (let d = 1; d <= 10; d++) bar.run(`2026-10-${String(d + 10).padStart(2, "0")}`);

  ss.runNightlyScorecards(NOW);
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const pe = (s: string) => ss.getStockScorecard(s)!.factors.find((f) => f.key === "pe")!.score;

describe("valuation percentile direction and ties", () => {
  it("gives the cheapest name in its sector 100 and the dearest 0", () => {
    expect(pe("E0")).toBe(100);
    expect(pe("E5")).toBe(0);
    expect(pe("T0")).toBe(100);
    expect(pe("T4")).toBe(0);
  });

  it("gives tied values the same score, the average of their ranks", () => {
    // Energy sample of 6 by -P/E: -40, -30, -20, -20, -20, -10. The three P/E 20s share ranks 2..4 (average 3 of 0..5) = 60.
    expect(pe("E1")).toBe(60);
    expect(pe("E2")).toBe(60);
    expect(pe("E3")).toBe(60);
    expect(pe("E4")).toBe(20);
  });

  it("scores a sector where everyone is tied at the middle", () => {
    for (let i = 0; i < 5; i++) expect(pe(`F${i}`)).toBe(50);
  });

  it("leaves a stock with no P/E unscored on that factor", () => {
    expect(pe("BARE")).toBeNull();
  });
});

describe("sector with fewer than five peers", () => {
  it("ranks against every US stock with a P/E, not its four sector peers", () => {
    // All P/Es: 10 x7 (E0, M0, F0-F4 ... counting ties), 15, 20 x4, 25, 30 x2, 35, 40 x2, 45, 55 = 20 values.
    // Ranked by -P/E, P/E 10 spans indices 13..19, so (13 + 20 - 1) / 2 = 16 of 19 = 84.2.
    // Ranked within the four Materials alone it would be 100 for the cheapest.
    // Stored scores keep four significant digits (round() in stock-score.ts), hence the tolerance.
    expect(pe("M0")).toBeCloseTo((16 / 19) * 100, 1);
    expect(pe("M1")).toBeCloseTo((9.5 / 19) * 100, 1);
    expect(pe("M2")).toBeCloseTo((5.5 / 19) * 100, 1);
    expect(pe("M3")).toBeCloseTo((2.5 / 19) * 100, 1);
  });

  it("uses the sector once it has five peers", () => {
    // Technology sample of five by -P/E: -35, -25, -15 ... T0 (P/E 15) is the cheapest of its five: 100; T1 (P/E 25) has four below it: 75.
    expect(pe("T0")).toBe(100);
    expect(pe("T1")).toBe(75);
  });
});

describe("composite and coverage", () => {
  it("counts factors with data over all 26 factors", () => {
    // Two factors (P/E and ROIC) out of 26; stored to three significant digits.
    expect(ss.getStockScorecard("E0")!.coverage).toBeCloseTo(2 / 26, 3);
    expect(ss.getStockScorecard("F0")!.coverage).toBeCloseTo(1 / 26, 3);
  });

  it("re-normalises the composite over the groups that have a score", () => {
    const e0 = ss.getStockScorecard("E0")!;
    expect(e0.groups.valuation).toBe(100);
    // ROIC is the lowest of the two that carry it, so the quality group is 0.
    expect(e0.groups.quality).toBe(0);
    expect(e0.groups.momentum).toBeNull();
    // (100 x 0.20 + 0 x 0.20) / 0.40 = 50, not 100 x 0.2 + 0 x 0.2.
    expect(e0.composite).toBeCloseTo(50, 6);
    expect(e0.composite).toBeCloseTo(weights.composite(e0.groups)!, 6);
  });

  it("is null, with zero coverage, for a stock with no data", () => {
    const bare = ss.getStockScorecard("BARE")!;
    expect(bare.composite).toBeNull();
    expect(bare.coverage).toBe(0);
    expect(bare.groups.valuation).toBeNull();
  });

  it("keeps a stock below the coverage minimum and one with no composite out of the top list", () => {
    expect(ss.topNightly(["E0", "E5", "F0", "BARE"], 0.5, 10)).toEqual([]);
    // E0 (valuation 100, quality 0), E5 (valuation 0, quality 100) and F0 (valuation 50) all compose to 50, so they order by symbol.
    expect(ss.topNightly(["E0", "E5", "F0", "BARE"], 0, 10).map((c) => c.symbol)).toEqual(["E0", "E5", "F0"]);
  });
});

describe("weights", () => {
  it("averages only the groups with a score, weighted, and is null when none has one", () => {
    expect(weights.composite({ valuation: 80, quality: null, growth: null, earnings: null, analysts: null, momentum: 20 })).toBeCloseTo((80 * 0.2 + 20 * 0.2) / 0.4, 9);
    expect(weights.composite({ valuation: null, quality: null, growth: null, earnings: null, analysts: null, momentum: null })).toBeNull();
    expect(weights.composite({ valuation: 100, quality: 100, growth: 100, earnings: 100, analysts: 100, momentum: 100 })).toBeCloseTo(100, 9);
  });

  it("falls back to the stock-v1 weights for an unknown version", () => {
    expect(weights.weightsFor("stock-v9")).toBe(weights.STOCK_WEIGHTS);
  });
});
