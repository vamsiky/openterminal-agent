import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End to end: bulk tables and daily bars seeded in a temp DATA_DIR, then the nightly scorecards and the
// ideas screen run through the real job runner, and the answers are read back through the real routers.
//
// Design: 30 letter-only tickers in three sectors (Technology TKA–TKJ, Healthcare HCA–HCJ, Energy ENA–ENJ).
// Within a sector, every fundamental improves with the letter (A worst, J best), and the price trend is steady
// and monotone in the letter, so the ranking has no noise to fight. Expected results follow from that:
//   - J is the leader of each sector, I is second, and A and B are the weakest.
//   - NTW is held but not on a watchlist, so it is in the universe and can be an idea.
//   - OUT is strong but on no watchlist and not held, so it is scored but never an idea.
//   - THN has one fundamental (P/E), so its coverage is below the 60% minimum and it is not an idea.
//   - 7203.T is a Tokyo listing, so it is not in the universe at all.

const NOW = new Date("2026-10-21T21:00:00Z"); // 17:00 New York
const DAYS = 300;
const TICKERS = { Technology: "TK", Healthcare: "HC", Energy: "EN" } as const;
const LETTERS = "ABCDEFGHIJ";

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;

const dayOffset = (i: number) => new Date(Date.parse("2026-10-21T00:00:00Z") - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);

/** Seed values for the letter at index g (0 = worst, 9 = best) within a sector. */
function fundamentals(g: number, price: number) {
  return {
    pe: 50 - 4 * g,
    priceToSales: 8 - 0.5 * g,
    grossMargin: 0.3 + 0.03 * g,
    operatingMargin: 0.1 + 0.02 * g,
    currentRatio: 1 + 0.1 * g,
    evToEbitda: 20 - 1.5 * g,
    fcfYield: 0.02 + 0.005 * g,
    roic: 0.05 + 0.02 * g,
    roe: 0.08 + 0.02 * g,
    netDebtToEbitda: 3 - 0.25 * g,
    dcf: price * (1 + 0.02 * g),
    growthRevenue: 0.02 + 0.01 * g,
    growthEps: 0.03 + 0.015 * g,
    surprisePrice: 1 + 0.01 * g,
    targetAvg: price * (1.05 + 0.01 * g),
    strongBuy: g,
    overall: 1 + g / 2,
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scan-e2e-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  const { scanRouter } = await import("../routes/scan.js");
  const { positionsRouter } = await import("../routes/positions.js");

  const insertProfile = db.prepare(
    `INSERT INTO bulk_profiles (symbol, company_name, exchange, sector, industry, country, price, market_cap, average_volume, is_etf, is_fund, is_adr, is_actively_trading, data, updated_at)
     VALUES (?, ?, 'NASDAQ', ?, 'Test', 'US', ?, 1e10, 2000000, 0, 0, 0, 1, '{}', '')`
  );
  const insertRatios = db.prepare("INSERT INTO bulk_ratios_ttm (symbol, pe, price_to_sales, gross_margin, operating_margin, current_ratio, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', '')");
  const insertMetrics = db.prepare("INSERT INTO bulk_key_metrics_ttm (symbol, ev_to_ebitda, fcf_yield, roic, roe, net_debt_to_ebitda, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', '')");
  const insertDcf = db.prepare("INSERT INTO bulk_dcf (symbol, date, dcf, stock_price, data, updated_at) VALUES (?, '2026-10-21', ?, ?, '{}', '')");
  const insertGrowth = db.prepare("INSERT INTO bulk_income_growth (symbol, date, period, growth_revenue, growth_eps, data, updated_at) VALUES (?, '2026-06-30', 'FY', ?, ?, '{}', '')");
  const insertSurprise = db.prepare("INSERT INTO bulk_earnings_surprises (symbol, date, eps_actual, eps_estimated, data, updated_at) VALUES (?, '2026-08-01', ?, 1, '{}', '')");
  const insertTargets = db.prepare("INSERT INTO bulk_price_targets (symbol, last_quarter_count, last_quarter_avg, last_year_count, last_year_avg, data, updated_at) VALUES (?, 5, ?, 0, 0, '{}', '')");
  const insertGrades = db.prepare("INSERT INTO bulk_grades_consensus (symbol, strong_buy, buy, hold, sell, strong_sell, data, updated_at) VALUES (?, ?, 10, 5, 2, 0, '{}', '')");
  const insertRating = db.prepare("INSERT INTO bulk_ratings (symbol, date, rating, overall_score, data, updated_at) VALUES (?, '2026-10-01', 'B', ?, '{}', '')");
  const insertBar = db.prepare("INSERT OR REPLACE INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 1000000)");

  /** Seeds one stock; `drift` is its daily trend, so the price path is linear and the momentum factors are monotone in it. */
  function seed(symbol: string, sector: string, g: number, base: number, { noFundamentals = false, onlyPe = false } = {}) {
    const drift = 0.0004 * (g + 1);
    const closes = Array.from({ length: DAYS }, (_, i) => base * (1 + drift * i));
    const price = closes[DAYS - 1];
    insertProfile.run(symbol, symbol, sector, price);
    closes.forEach((c, i) => insertBar.run(symbol, dayOffset(i), c, c, c, c));
    if (noFundamentals) return;
    const f = fundamentals(g, price);
    insertRatios.run(symbol, f.pe, onlyPe ? null : f.priceToSales, onlyPe ? null : f.grossMargin, onlyPe ? null : f.operatingMargin, onlyPe ? null : f.currentRatio);
    if (onlyPe) return;
    insertMetrics.run(symbol, f.evToEbitda, f.fcfYield, f.roic, f.roe, f.netDebtToEbitda);
    insertDcf.run(symbol, f.dcf, price);
    insertGrowth.run(symbol, f.growthRevenue, f.growthEps);
    insertSurprise.run(symbol, f.surprisePrice);
    insertTargets.run(symbol, f.targetAvg);
    insertGrades.run(symbol, f.strongBuy);
    insertRating.run(symbol, f.overall);
  }

  for (const [sector, prefix] of Object.entries(TICKERS)) {
    for (let g = 0; g < 10; g++) seed(`${prefix}${LETTERS[g]}`, sector, g, 50 + 10 * g);
  }
  seed("NTW", "Utilities", 9, 120); // held, not on a watchlist, strong
  seed("OUT", "Utilities", 9, 120); // strong, but on no list and not held
  seed("THN", "Consumer Defensive", 5, 60, { onlyPe: true }); // one factor: below the coverage minimum
  seed("7203.T", "Consumer Cyclical", 9, 100); // Tokyo listing: never in the universe
  db.prepare("UPDATE bulk_profiles SET exchange = 'JPX' WHERE symbol = '7203.T'").run(); // a real Tokyo profile, outside the US exchanges
  for (const etf of ["XLK", "XLV", "XLE", "XLU"]) {
    const closes = Array.from({ length: DAYS }, () => 100);
    closes.forEach((c, i) => insertBar.run(etf, dayOffset(i), c, c, c, c));
  }
  const spyCloses = Array.from({ length: DAYS }, () => 400);
  spyCloses.forEach((c, i) => insertBar.run("SPY", dayOffset(i), c, c, c, c));

  db.prepare("INSERT INTO watchlists (id, name) VALUES (1, 'Core')").run();
  const item = db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (1, ?, ?)");
  const members = [...Object.values(TICKERS).flatMap((p) => [...LETTERS].map((l) => `${p}${l}`)), "THN", "7203.T", "^VIX"];
  members.forEach((s, i) => item.run(s, i));

  // Next report in 15 days for HCJ, which gives it an earnings reason on the ideas list.
  db.prepare("INSERT INTO earnings_calendar (symbol, report_date, eps_estimate, last_seen_day) VALUES ('HCJ', '2026-11-05', 1.6, '2026-10-21')").run();

  const app = express();
  app.use(express.json());
  app.use("/api/scan", scanRouter);
  app.use("/api/positions", positionsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  const { minuteDb } = await import("../history/store.js");
  db?.close();
  minuteDb.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

describe("end to end: holdings, nightly scorecards, ideas screen", () => {
  it("imports the holdings through the positions route", async () => {
    const csv = "﻿Symbol,Qty,Avg Cost,Date Acquired\r\nNTW,\"300\",80,1/15/2025\r\n\r\nENJ261120C00300000,-1,2.5,2026-09-01\r\n";
    const r = await post("/positions/import", { csv, filename: "webull.csv" });
    expect(r).toEqual({ status: 200, body: { imported: 2 } });
    const list = await get("/positions");
    expect(list.body.positions).toEqual([
      { kind: "stock", symbol: "NTW", quantity: 300, cost: 80, openedAt: "2025-01-15" },
      { kind: "option", occ: "ENJ261120C00300000", underlying: "ENJ", expiry: "2026-11-20", strike: 300, right: "call", quantity: -1, cost: 2.5, openedAt: "2026-09-01" },
    ]);
  });

  it("rejects a bad file and keeps the holdings it had", async () => {
    const r = await post("/positions/import", { csv: "symbol,quantity\nNTW,100\n7203.T,5" });
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([{ line: 3, message: expect.stringMatching(/US-listed/) }]);
    expect((await get("/positions")).body.positions).toHaveLength(2);
  });

  it("runs the nightly scorecards and the ideas screen through the job runner", async () => {
    const { runJob, lastRuns } = await import("../quant/jobs.js");
    expect(runJob("stock-nightly", NOW)).toBe(true);
    expect(runJob("ideas-screen", NOW)).toBe(true);
    const runs = lastRuns();
    expect(runs["stock-nightly"]).toMatchObject({ status: "ok", symbols: 33 }); // every US stock with a profile: 30 letters, NTW, OUT, THN
    expect(runs["ideas-screen"]).toMatchObject({ status: "ok" });
    const status = await get("/scan/status");
    expect(status.body.runs["stock-nightly"].status).toBe("ok");
    expect(status.body.options).toBeNull(); // no options layer in this test
  });

  it("builds the universe from the watchlist plus holdings, without foreign or unlisted names", async () => {
    const u = await get("/scan/universe");
    expect(u.body.symbolCount).toBe(32); // 30 letters, THN and the held NTW
    const symbols = (await get("/scan/universe/symbols")).body.symbols as string[];
    expect(symbols).toContain("NTW");
    expect(symbols).toContain("THN");
    expect(symbols).not.toContain("OUT");
    expect(symbols).not.toContain("7203.T");
    expect(symbols).not.toContain("^VIX");
  });

  it("serves the ideas: 25 of them, ranked by score, with strong names first", async () => {
    const r = await get("/scan/ideas");
    expect(r.status).toBe(200);
    const ideas = r.body.ideas as Array<{ symbol: string; rank: number; score: number; strategy: string; kind: string; reasons: string[]; status: string }>;
    expect(typeof r.body.asOf).toBe("string");
    expect(ideas).toHaveLength(25);
    expect(ideas.map((i) => i.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    for (let i = 1; i < ideas.length; i++) expect(ideas[i].score).toBeLessThanOrEqual(ideas[i - 1].score);
    expect(ideas.every((i) => i.kind === "stock" && i.strategy === "buy" && i.status === "active")).toBe(true);

    const names = ideas.map((i) => i.symbol);
    expect(names).not.toContain("OUT"); // scored, not in the universe
    expect(names).not.toContain("THN"); // coverage 1 of 26
    expect(names).toContain("NTW"); // held, so in the universe

    // The six weakest eligible names drop off the cut of 25: the two worst letters of each sector.
    const eligible = [...Object.values(TICKERS).flatMap((p) => [...LETTERS].map((l) => `${p}${l}`)), "NTW"];
    const dropped = eligible.filter((s) => !names.includes(s)).sort();
    expect(dropped).toEqual(["ENA", "ENB", "HCA", "HCB", "TKA", "TKB"]);

    // Within a sector the better letter ranks higher.
    const rankOf = (s: string) => ideas.findIndex((i) => i.symbol === s);
    for (const p of Object.values(TICKERS)) expect(rankOf(`${p}J`)).toBeLessThan(rankOf(`${p}I`));
  });

  it("explains each idea with its three strongest groups, and an earnings reason when one is near", async () => {
    const ideas = (await get("/scan/ideas?limit=100")).body.ideas as Array<{ symbol: string; reasons: string[] }>;
    const hcj = ideas.find((i) => i.symbol === "HCJ")!;
    expect(hcj.reasons).toHaveLength(4);
    expect(hcj.reasons[0]).toMatch(/^(valuation|quality|growth|earnings|analyst view|momentum) \d+\/100; best: .+, \d+\/100 against sector peers$/);
    expect(hcj.reasons[3]).toBe("reports earnings on 2026-11-05 (in 15 days)");
    const enj = ideas.find((i) => i.symbol === "ENJ")!;
    expect(enj.reasons).toHaveLength(3);
  });

  it("keeps the idea score in step with the scorecard the stock route serves", async () => {
    const ideas = (await get("/scan/ideas?limit=100")).body.ideas as Array<{ symbol: string; score: number }>;
    const card = (await get("/scan/scorecard/ENJ")).body;
    const idea = ideas.find((i) => i.symbol === "ENJ")!;
    expect(Math.abs(idea.score - card.stock.composite)).toBeLessThan(0.05);
    expect(card.stock.sector).toBe("Energy");
    expect(card.stock.weightsVersion).toBe("stock-v2");
    expect(card.stock.groups.valuation).toBeCloseTo(100, 0); // P/E, EV/EBITDA and the rest all rank it first in its sector
    expect(card.stock.factors).toHaveLength(26);
    // Two factors (the EPS revisions) have no data in this seed, so coverage is 24 of 26.
    expect(card.stock.coverage).toBeCloseTo(24 / 26, 2);
    expect(card.stock.factors.find((f: { key: string }) => f.key === "eps_rev_30d")).toMatchObject({ value: null, score: null });
    expect(card.live).toBeNull();
    expect(card.options).toBeNull();
  });

  it("serves a scorecard for a stock that is not an idea, and the coverage of the thin one", async () => {
    const out = (await get("/scan/scorecard/out")).body;
    expect(out.stock.composite).not.toBeNull();
    const thin = (await get("/scan/scorecard/THN")).body;
    // P/E plus six momentum factors (no sector ETF bars for its sector, so no relative strength against it): 7 of 26.
    expect(thin.stock.coverage).toBeCloseTo(7 / 26, 2);
    expect(thin.stock.groups.valuation).toBeCloseTo(thin.stock.factors.find((f: { key: string }) => f.key === "pe").score, 1);
    expect(thin.stock.groups.quality).toBeNull();
  });

  it("answers a bad symbol with 400", async () => {
    expect((await get("/scan/scorecard/bad%20sym")).status).toBe(400);
  });

  it("filters the ideas by kind and limit", async () => {
    expect((await get("/scan/ideas?kind=option")).body.ideas).toEqual([]);
    expect((await get("/scan/ideas?limit=5")).body.ideas).toHaveLength(5);
    expect((await get("/scan/ideas?limit=500")).status).toBe(400);
  });
});
