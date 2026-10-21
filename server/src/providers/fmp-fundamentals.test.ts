import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetState } from "./fmp-core.js";
import { analysts, analystEstimates, growth, inRange, metrics, peers, scores, segments, statements, valuation } from "./fmp-fundamentals.js";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() });
const bad = (status: number) => ({ ok: false, status, json: async () => ({}), text: async () => "Premium", headers: new Headers() });

/** Stubs fetch with a body per stable-API path; anything unlisted is an empty array. */
function stub(routes: Record<string, unknown>) {
  const mock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace("/stable/", "");
    const body = routes[path];
    if (typeof body === "number") return bad(body);
    return ok(body ?? []);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const callUrl = (mock: ReturnType<typeof stub>, i = 0) => new URL(mock.mock.calls[i][0] as string);

beforeEach(() => {
  process.env.FMP_API_KEY = "test-key";
  process.env.FMP_MAX_REQ_PER_MIN = "100000";
  resetState();
});
afterEach(() => vi.unstubAllGlobals());

describe("statements", () => {
  it("trims grades and monthly grades to limit after the date filter", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ symbol: "A", date: `2026-09-${String(30 - i).padStart(2, "0")}` }));
    stub({ grades: many, "grades-historical": many });
    const { data } = await analysts("A", 5, { from: "2026-09-10" });
    expect(data.grades.map((g) => g.date)).toEqual(["2026-09-30", "2026-09-29", "2026-09-28", "2026-09-27", "2026-09-26"]);
    expect(data.gradesHistorical).toHaveLength(5);
  });

  it("asks for the period endpoint and filters by date", async () => {
    const mock = stub({ "income-statement": [{ date: "2026-06-27", filingDate: "2026-07-31", revenue: 2 }, { date: "2026-03-28", revenue: 1 }] });
    const r = await statements("BRK.B", "income", "quarter", 8, { from: "2026-05-01" });
    expect(r.data).toEqual([{ date: "2026-06-27", filingDate: "2026-07-31", revenue: 2 }]);
    const url = callUrl(mock);
    expect(url.searchParams.get("symbol")).toBe("BRK-B");
    expect(url.searchParams.get("period")).toBe("quarter");
    expect(url.searchParams.get("limit")).toBe("8");
  });

  it("uses the -ttm endpoints without a period", async () => {
    const mock = stub({ "cash-flow-statement-ttm": [{ date: "2026-06-27", freeCashFlow: 5 }] });
    const r = await statements("AAPL", "cashflow", "ttm", 2, {});
    expect(r.data).toHaveLength(1);
    const url = callUrl(mock);
    expect(url.pathname).toBe("/stable/cash-flow-statement-ttm");
    expect(url.searchParams.has("period")).toBe(false);
  });

  it("caches the call", async () => {
    const mock = stub({ "balance-sheet-statement": [{ date: "2026-06-27" }] });
    await statements("AAPL", "balance", "annual", 4, {});
    await statements("AAPL", "balance", "annual", 4, {});
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("metrics", () => {
  it("joins key-metrics and ratios per date, newest first, keeping shared names apart", async () => {
    stub({
      "key-metrics": [{ symbol: "A", date: "2026-06-27", fiscalYear: "2026", period: "Q3", reportedCurrency: "USD", currentRatio: 1, marketCap: 9 }],
      ratios: [
        { symbol: "A", date: "2026-06-27", fiscalYear: "2026", period: "Q3", reportedCurrency: "USD", currentRatio: 1.1, netProfitMargin: 0.2 },
        { symbol: "A", date: "2026-03-28", fiscalYear: "2026", period: "Q2", reportedCurrency: "USD", netProfitMargin: 0.1 },
      ],
    });
    const { data } = await metrics("A", "quarter", 8, {});
    expect(data[0]).toEqual({
      symbol: "A", date: "2026-06-27", fiscalYear: "2026", period: "Q3", reportedCurrency: "USD",
      keyMetrics: { currentRatio: 1, marketCap: 9 },
      ratios: { currentRatio: 1.1, netProfitMargin: 0.2 },
    });
    expect(data[1]).toMatchObject({ date: "2026-03-28", keyMetrics: null, ratios: { netProfitMargin: 0.1 } });
  });

  it("returns one TTM row with the suffixed fields", async () => {
    stub({ "key-metrics-ttm": [{ symbol: "A", marketCap: 9, evToSalesTTM: 3 }], "ratios-ttm": [{ symbol: "A", netProfitMarginTTM: 0.2 }] });
    const { data } = await metrics("A", "ttm", 8, {});
    expect(data).toEqual([{ symbol: "A", period: "TTM", keyMetrics: { marketCap: 9, evToSalesTTM: 3 }, ratios: { netProfitMarginTTM: 0.2 } }]);
  });

  it("returns nothing for an unknown symbol", async () => {
    stub({});
    expect((await metrics("ZZZZ", "ttm", 8, {})).data).toEqual([]);
    expect((await metrics("ZZZZ", "annual", 8, {})).data).toEqual([]);
  });
});

describe("growth, scores, segments", () => {
  it("groups the four growth datasets", async () => {
    stub({ "income-statement-growth": [{ date: "d", growthRevenue: 0.1 }], "financial-growth": [{ date: "d", revenueGrowth: 0.1 }] });
    const { data } = await growth("A", "annual", 4, {});
    expect(data.income).toHaveLength(1);
    expect(data.financial).toHaveLength(1);
    expect(data.balance).toEqual([]);
    expect(data.cashflow).toEqual([]);
  });

  it("unwraps the single scores row and keeps enterprise values", async () => {
    const mock = stub({ "financial-scores": [{ symbol: "A", altmanZScore: 3, piotroskiScore: 7 }], "enterprise-values": [{ date: "d", enterpriseValue: 1 }] });
    const { data } = await scores("A", 4);
    expect(data.scores).toMatchObject({ altmanZScore: 3, piotroskiScore: 7 });
    expect(data.enterpriseValues).toHaveLength(1);
    expect(mock.mock.calls.map((c) => new URL(c[0] as string)).find((u) => u.pathname.endsWith("enterprise-values"))?.searchParams.get("period")).toBe("quarter");
    stub({});
    resetState();
    expect((await scores("ZZ", 4)).data.scores).toBeNull();
  });

  it("limits each segmentation list", async () => {
    stub({ "revenue-product-segmentation": [{ date: "3", data: { a: 1 } }, { date: "2", data: {} }], "revenue-geographic-segmentation": [{ date: "3", data: {} }] });
    const { data } = await segments("A", "annual", 1, {});
    expect(data.product).toEqual([{ date: "3", data: { a: 1 } }]);
    expect(data.geographic).toHaveLength(1);
  });
});

describe("analystEstimates", () => {
  const rows = [{ date: "2028-09-27" }, { date: "2026-12-27" }, { date: "2026-09-27" }, { date: "2026-06-27" }, { date: "2026-03-28" }, { date: "2020-01-01" }];

  it("starts at the nearest period that may still be unreported, oldest first", async () => {
    const mock = stub({ "analyst-estimates": rows });
    const r = await analystEstimates("A", "quarter", 3, {}, "2026-10-21");
    expect(r.data.map((x) => x.date)).toEqual(["2026-09-27", "2026-12-27", "2028-09-27"]);
    expect(callUrl(mock).searchParams.get("limit")).toBe("100");
  });

  it("lets from/to override the default start", async () => {
    stub({ "analyst-estimates": rows });
    const r = await analystEstimates("A", "quarter", 8, { from: "2026-01-01", to: "2026-12-31" }, "2026-10-21");
    expect(r.data.map((x) => x.date)).toEqual(["2026-03-28", "2026-06-27", "2026-09-27", "2026-12-27"]);
  });
});

describe("analysts", () => {
  it("parses the publishers string and groups every dataset", async () => {
    stub({
      "price-target-summary": [{ symbol: "A", lastMonthCount: 3, publishers: '["Benzinga","MarketWatch"]' }],
      "price-target-consensus": [{ symbol: "A", targetConsensus: 340 }],
      "price-target-news": [{ symbol: "A", publishedDate: "2026-10-20T10:43:18.000Z", priceTarget: 283 }],
      grades: [{ symbol: "A", date: "2026-10-20", action: "downgrade" }],
      "grades-consensus": [{ symbol: "A", consensus: "Buy" }],
      "grades-historical": [{ symbol: "A", date: "2026-10-01" }],
      "ratings-snapshot": [{ symbol: "A", rating: "B" }],
    });
    const { data } = await analysts("A", 20, {});
    expect(data.priceTargetSummary?.publishers).toEqual(["Benzinga", "MarketWatch"]);
    expect(data.priceTargetConsensus?.targetConsensus).toBe(340);
    expect(data.priceTargets[0].priceTarget).toBe(283);
    expect(data.grades).toHaveLength(1);
    expect(data.gradesConsensus?.consensus).toBe("Buy");
    expect(data.gradesHistorical).toHaveLength(1);
    expect(data.ratingsSnapshot?.rating).toBe("B");
  });

  it("reads a dataset the plan lacks as absent, but still fails on server errors", async () => {
    stub({ "price-target-summary": 402, grades: [{ date: "2026-10-20" }] });
    const { data } = await analysts("A", 20, {});
    expect(data.priceTargetSummary).toBeNull();
    expect(data.grades).toHaveLength(1);
    resetState();
    stub({ grades: 500 });
    await expect(analysts("A", 20, {})).rejects.toMatchObject({ status: 500 });
  });

  it("filters price targets by their publishedDate", async () => {
    stub({ "price-target-news": [{ publishedDate: "2026-10-20T10:00:00.000Z" }, { publishedDate: "2026-01-02T10:00:00.000Z" }] });
    const { data } = await analysts("A", 20, { from: "2026-06-01" });
    expect(data.priceTargets).toHaveLength(1);
  });
});

describe("valuation and peers", () => {
  it("returns both DCFs, null when absent", async () => {
    stub({ "discounted-cash-flow": [{ symbol: "A", dcf: 135, "Stock Price": 339 }] });
    const { data } = await valuation("A");
    expect(data.dcf).toMatchObject({ dcf: 135, "Stock Price": 339 });
    expect(data.leveredDcf).toBeNull();
  });

  it("drops foreign peers", async () => {
    stub({ "stock-peers": [{ symbol: "MSFT", price: 1, mktCap: 2 }, { symbol: "002241.SZ", price: 1, mktCap: 2 }, { symbol: "SAP.DE" }] });
    expect((await peers("AAPL")).data.map((p) => p.symbol)).toEqual(["MSFT"]);
  });
});

describe("inRange", () => {
  it("is inclusive and keeps undated rows", () => {
    const rows = [{ date: "2026-01-01" }, { date: "2026-02-01" }, {}];
    expect(inRange(rows, { from: "2026-01-01", to: "2026-01-31" })).toEqual([{ date: "2026-01-01" }, {}]);
  });
});
