import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /api/research/:symbol over a temp sqlite seeded with bulk rows and mocked
// providers; nothing here calls FMP or Alpaca.

const mocks = vi.hoisted(() => ({
  getQuotes: vi.fn(),
  earnings: vi.fn(),
  historical: vi.fn(),
  quotes: vi.fn(),
  getFloat: vi.fn(),
  getInstitutional: vi.fn(),
  getInsiders: vi.fn(),
  getCongress: vi.fn(),
  pressReleases: vi.fn(),
  transcriptDates: vi.fn(),
  analystEstimates: vi.fn(),
  analysts: vi.fn(),
  statements: vi.fn(),
  companyProfile: vi.fn(),
  sectors: vi.fn(),
  grades: vi.fn(),
}));

vi.mock("../market.js", () => ({ getQuotes: mocks.getQuotes }));
vi.mock("../../providers/fmp.js", () => ({ earnings: mocks.earnings, historical: mocks.historical, quotes: mocks.quotes }));
vi.mock("../../providers/fmp-core.js", async (orig) => ({ ...(await orig<typeof import("../../providers/fmp-core.js")>()), get: mocks.grades }));
vi.mock("../../providers/fmp-ownership.js", () => ({ getFloat: mocks.getFloat, getInstitutional: mocks.getInstitutional, getInsiders: mocks.getInsiders, getCongress: mocks.getCongress }));
vi.mock("../../providers/fmp-content.js", () => ({ pressReleases: mocks.pressReleases, transcriptDates: mocks.transcriptDates }));
vi.mock("../../providers/fmp-fundamentals.js", () => ({ analystEstimates: mocks.analystEstimates, analysts: mocks.analysts, metrics: vi.fn(), valuation: vi.fn(), statements: mocks.statements, peers: vi.fn() }));
vi.mock("../../providers/fmp-market.js", () => ({ companyProfile: mocks.companyProfile, sectors: mocks.sectors }));

const tmpDir = mkdtempSync(join(tmpdir(), "research-summary-"));
let server: Server;
let base: string;
let summary: typeof import("./summary.js");
let db: typeof import("../../db.js").db;
let bulk: typeof import("../../research/bulk-store.js");

const AT = "2026-10-21T10:30:00.000Z";
const NOW = new Date("2026-10-21T15:00:00Z");

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.DATA_DIR = tmpDir;
  bulk = await import("../../research/bulk-store.js");
  ({ db } = await import("../../db.js"));
  summary = await import("./summary.js");
  const app = express();
  app.use("/api/research", summary.router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
});
afterAll(() => {
  vi.useRealTimers();
  server.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const ds = (name: string) => bulk.DATASETS.find((d) => d.name === name)!;

function seed() {
  const profile = (symbol: string, marketCap: number) => ({
    symbol, price: 100, marketCap, beta: 1.2, companyName: `${symbol} Inc.`, exchange: "NASDAQ", sector: "Technology", industry: "Software", isEtf: false, isFund: false, isActivelyTrading: true, isAdr: false,
  });
  bulk.upsertRows(ds("profile"), [profile("AAA", 3e12), profile("BBB", 2e11), profile("CCC", 5e10)], AT);
  bulk.upsertRows(ds("ratios-ttm"), [{ symbol: "AAA", priceToEarningsRatioTTM: 30, priceToSalesRatioTTM: 8 }], AT);
  bulk.upsertRows(ds("key-metrics-ttm"), [{ symbol: "AAA", evToEBITDATTM: 22, freeCashFlowYieldTTM: 0.03 }], AT);
  bulk.upsertRows(ds("dcf"), [{ symbol: "AAA", date: "2026-10-20", dcf: 125, "Stock Price": 100 }], AT);
  bulk.upsertRows(ds("peers"), [{ symbol: "AAA", peers: "BBB,CCC,ZZZ" }], AT);
  bulk.upsertRows(ds("upgrades-downgrades-consensus"), [{ symbol: "AAA", strongBuy: 2, buy: 5, hold: 3, sell: 1, strongSell: 0, consensus: "Buy" }], AT);
  bulk.upsertRows(ds("price-target-summary"), [{ symbol: "AAA", lastQuarterCount: 4, lastQuarterAvgPriceTarget: 120, lastYearCount: 9, lastYearAvgPriceTarget: 110 }], AT);
  bulk.upsertRows(ds("rating"), [{ symbol: "AAA", date: "2026-10-20", rating: "A-" }], AT);
  const quarters = [
    ["2026-09-30", "Q3", 2026, 130, 1.3], ["2026-06-30", "Q2", 2026, 120, 1.2], ["2026-03-31", "Q1", 2026, 110, 1.1], ["2025-12-31", "Q4", 2025, 105, 1.05],
    ["2025-09-30", "Q3", 2025, 100, 1.0], ["2025-06-30", "Q2", 2025, 100, 1.0], ["2025-03-31", "Q1", 2025, 90, 0.9], ["2024-12-31", "Q4", 2024, 80, 0],
  ] as const;
  bulk.upsertRows(ds("income-statement"), quarters.map(([date, period, fiscalYear, revenue, epsDiluted]) => ({ symbol: "AAA", date, period, fiscalYear: String(fiscalYear), reportedCurrency: "USD", revenue, netIncome: 1, epsDiluted })), AT);
}

function happyMocks() {
  mocks.getQuotes.mockResolvedValue([{ symbol: "AAA", price: 110, change: 1, changePercent: 0.9, previousClose: 109, open: 109, high: 111, low: 108, volume: 5, avgVolume: 6, marketCap: 3e12, week52High: 120, week52Low: 80, currency: "USD", marketState: "REGULAR", time: 1, source: "alpaca", asOf: "x", extended: { post: { price: 111 } } }]);
  mocks.earnings.mockResolvedValue([
    { fiscalQtrEnd: "", upcoming: true, dateReported: Date.parse("2026-10-29") / 1000, eps: null, consensusForecast: 1.4, surprisePercent: null, revenue: null, revenueEstimate: 140 },
    { fiscalQtrEnd: "2026-06-30", fiscalPeriod: "Q2 FY2026", dateReported: Date.parse("2026-07-29") / 1000, eps: 1.2, consensusForecast: 1.1, surprisePercent: 9.0909, revenue: 120, revenueEstimate: 118 },
  ]);
  mocks.historical.mockResolvedValue([
    { time: Date.parse("2026-07-28") / 1000, close: 100 },
    { time: Date.parse("2026-07-29") / 1000, close: 100 },
    { time: Date.parse("2026-07-30") / 1000, close: 105 },
  ]);
  mocks.quotes.mockResolvedValue(new Map([["BBB", { changePercent: 1 }], ["CCC", { changePercent: -0.5 }]]));
  mocks.getFloat.mockResolvedValue({ floatShares: 90, outstandingShares: 100, freeFloat: 90 });
  mocks.getInstitutional.mockResolvedValue({ year: 2026, quarter: 2, summary: { date: "2026-06-30", investorsHolding: 10, investorsHoldingChange: 1, ownershipPercent: 70, ownershipPercentChange: 2 }, holders: [] });
  mocks.getInsiders.mockResolvedValue({
    trades: [
      { transactionDate: "2026-10-07", transactionType: "S-Sale", securitiesTransacted: 100, price: 10 },
      { transactionDate: "2026-09-20", transactionType: "P-Purchase", securitiesTransacted: 50, price: 10 },
      { transactionDate: "2026-09-10", transactionType: "A-Award", securitiesTransacted: 999, price: 0 },
      { transactionDate: "2026-03-01", transactionType: "S-Sale", securitiesTransacted: 5000, price: 10 },
    ],
    statistics: [],
  });
  mocks.getCongress.mockResolvedValue([
    { chamber: "house", firstName: "A", lastName: "B", type: "Purchase", amount: "$1,001 - $15,000", transactionDate: "2026-09-23", disclosureDate: "2026-10-09", disclosureLagDays: 16 },
    { chamber: "senate", firstName: "C", lastName: "D", type: "Sale (Partial)", amount: "$1,001 - $15,000", transactionDate: "2026-01-02", disclosureDate: "2026-02-01", disclosureLagDays: 30 },
  ]);
  mocks.pressReleases.mockResolvedValue([{ publishedDate: "2026-10-20 08:00:00", title: "AAA does a thing", publisher: "PR", text: "long" }]);
  mocks.transcriptDates.mockResolvedValue([{ fiscalYear: 2026, quarter: 2, date: "2026-07-29" }]);
  mocks.analystEstimates.mockImplementation(async (_s: string, period: string) => ({
    data:
      period === "quarter"
        ? [{ date: "2026-06-30", epsAvg: 1.1 }, { date: "2026-09-30", epsAvg: 1.4, epsLow: 1.3, epsHigh: 1.5 }, { date: "2026-12-31", epsAvg: 1.5 }, { date: "2027-03-31", epsAvg: 1.6 }]
        : [{ date: "2026-12-31", epsAvg: 5.5 }, { date: "2027-12-31", epsAvg: 6.5 }, { date: "2028-12-31", epsAvg: 7.5 }],
    asOf: new Date(),
  }));
  mocks.grades.mockResolvedValue([{ symbol: "AAA", date: "2026-10-19", gradingCompany: "X", previousGrade: "Hold", newGrade: "Buy", action: "upgrade" }]);
  mocks.sectors.mockResolvedValue({ date: "2026-10-20", rows: [{ sector: "Technology", averageChange: 0.7, pe: 28 }] });
}

beforeEach(() => {
  for (const d of bulk.DATASETS) db.exec(`DELETE FROM ${d.table}`);
  for (const m of Object.values(mocks)) m.mockReset();
  seed();
  happyMocks();
});

describe("GET /api/research/:symbol", () => {
  it("assembles every section in the envelope", async () => {
    const res = await fetch(`${base}/aaa`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ symbol: "AAA", dataset: "summary", source: "fmp" });
    expect(new Date(body.asOf).getTime()).toBeGreaterThan(0);
    const d = body.data;
    expect(Object.keys(d)).toEqual(["quote", "profile", "valuation", "growth", "earnings", "estimates", "analysts", "ownership", "recent", "context", "links"]);
    for (const k of Object.keys(d).filter((k) => k !== "links")) expect(d[k], k).not.toHaveProperty("error");

    expect(d.quote).toMatchObject({ price: 110, extended: { post: { price: 111 } } });
    expect(d.profile).toMatchObject({ sector: "Technology", marketCap: 3e12, floatShares: 90, source: "bulk" });
    expect(d.valuation).toMatchObject({ pe: 30, evToEbitda: 22, priceToSales: 8, fcfYield: 0.03, dcf: 125, price: 110, dcfVsPricePercent: 13.64 });
    expect(d.growth.quarters).toHaveLength(4);
    expect(d.growth.quarters[0]).toMatchObject({ date: "2026-09-30", revenueYoYPercent: 30, epsDilutedYoYPercent: 30 });
    expect(d.growth.quarters[3]).toMatchObject({ date: "2025-12-31", revenueYoYPercent: 31.25, epsDilutedYoYPercent: null });
    expect(d.earnings.last).toMatchObject({ date: "2026-07-29", epsActual: 1.2, epsEstimate: 1.1, epsSurprisePercent: 9.09, dayAfterChangePercent: 5 });
    expect(d.earnings.next).toMatchObject({ date: "2026-10-29", epsEstimate: 1.4, timing: null });
    expect(d.estimates.quarters.map((r: any) => r.date)).toEqual(["2026-09-30", "2026-12-31"]);
    expect(d.estimates.fiscalYears.map((r: any) => r.date)).toEqual(["2026-12-31", "2027-12-31"]);
    expect(d.analysts).toMatchObject({ consensus: { consensus: "Buy" }, rating: { rating: "A-", overallScore: 4 }, priceTarget: { lastQuarterAvg: 120, upsidePercent: 9.09 }, source: "bulk" });
    expect(d.analysts.recentGrades).toEqual([{ date: "2026-10-19", gradingCompany: "X", previousGrade: "Hold", newGrade: "Buy", action: "upgrade" }]);
    expect(d.ownership.institutional).toMatchObject({ year: 2026, quarter: 2, ownershipPercent: 70 });
    expect(d.ownership.insiders).toMatchObject({ buys: { transactions: 1, shares: 50, value: 500 }, sells: { transactions: 1, shares: 100, value: 1000 }, netValue: -500 });
    expect(d.ownership.congress).toMatchObject({ purchases: 1, sales: 0 });
    expect(d.recent.pressReleases).toEqual([{ publishedDate: "2026-10-20 08:00:00", title: "AAA does a thing", publisher: "PR" }]);
    expect(d.recent.latestTranscript).toMatchObject({ date: "2026-07-29" });
    expect(d.context).toMatchObject({ sector: { averageChangePercent: 0.7 }, peersAverageChangePercent: 0.25 });
    expect(d.context.peers.map((p: any) => p.symbol)).toEqual(["BBB", "CCC"]);
    expect(d.links.profile).toBe("/api/research/AAA/profile");
  });

  it("returns { error } for the one section that fails and the rest as usual", async () => {
    mocks.earnings.mockRejectedValue(new Error("fmp 500 earnings"));
    const d = (await (await fetch(`${base}/AAA`)).json()).data;
    expect(d.earnings).toEqual({ error: "fmp 500 earnings" });
    expect(d.quote.price).toBe(110);
    expect(d.valuation.pe).toBe(30);
    expect(d.ownership.institutional).toHaveProperty("year");
    // estimates fall back to the stored statements for "already reported"
    expect(d.estimates.quarters.map((r: any) => r.date)).toEqual(["2026-12-31", "2027-03-31"]);
  });

  it("reads the quarters from FMP when the bulk statements lag the latest report", async () => {
    mocks.earnings.mockResolvedValue([{ fiscalQtrEnd: "2026-12-31", dateReported: Date.parse("2027-01-29") / 1000, eps: 1, consensusForecast: 1, surprisePercent: 0, revenue: 1, revenueEstimate: 1 }]);
    mocks.statements.mockResolvedValue({ data: [{ date: "2026-12-31", revenue: 200, epsDiluted: 2 }, { date: "2025-12-31", revenue: 100, epsDiluted: 1 }], asOf: new Date() });
    const d = (await (await fetch(`${base}/AAA`)).json()).data;
    expect(d.growth.source).toBe("fmp");
    expect(d.growth.quarters[0]).toMatchObject({ date: "2026-12-31", revenueYoYPercent: 100, epsDilutedYoYPercent: 100 });
    mocks.statements.mockRejectedValue(new Error("fmp 502"));
    expect((await (await fetch(`${base}/AAA`)).json()).data.growth).toMatchObject({ source: expect.stringContaining("bulk") });
  });

  it("reports a failing part of ownership without failing the section", async () => {
    mocks.getInsiders.mockRejectedValue(new Error("fmp 502"));
    const d = (await (await fetch(`${base}/AAA`)).json()).data;
    expect(d.ownership.insiders).toEqual({ error: "fmp 502" });
    expect(d.ownership.congress.purchases).toBe(1);
  });

  it("falls back to FMP when the symbol is not in the bulk tables", async () => {
    mocks.getQuotes.mockResolvedValue([{ symbol: "NEW", price: 5 }]);
    mocks.companyProfile.mockResolvedValue({ profile: { companyName: "New Co", exchange: "NYSE", sector: "Energy", industry: "Oil", marketCap: 1e9, beta: 1 } });
    const d = (await (await fetch(`${base}/NEW`)).json()).data;
    expect(d.profile).toMatchObject({ name: "New Co", sector: "Energy", source: "fmp" });
    expect(d.valuation).toHaveProperty("error"); // mocked metrics returns nothing usable
  });

  it("rejects reserved words and foreign symbols with 400", async () => {
    for (const s of ["market", "SCREEN", "datasets", "SAP.DE"]) {
      const res = await fetch(`${base}/${s}`);
      expect(res.status, s).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(mocks.getQuotes).not.toHaveBeenCalled();
  });
});

describe("buildSummary deadline", () => {
  it("turns a section still running at the cap into { error } and returns the rest", async () => {
    mocks.pressReleases.mockReturnValue(new Promise(() => {}));
    const d = await summary.buildSummary("AAA", { deadlineMs: 80, now: NOW });
    expect(d.recent).toEqual({ error: "timed out after 80 ms" });
    expect(d.quote).toHaveProperty("price", 110);
    expect(d.profile).toHaveProperty("sector", "Technology");
  });
});
