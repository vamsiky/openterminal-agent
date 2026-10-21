import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetState } from "./fmp-core.js";
import * as market from "./fmp-market.js";

type Handler = (url: URL) => unknown;

/** Routes mocked fetch calls by stable-API path. */
function mockFmp(routes: Record<string, Handler | unknown>) {
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url);
      const r = routes[url.pathname.replace("/stable/", "")];
      const body = typeof r === "function" ? (r as Handler)(url) : (r ?? []);
      return { ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() };
    })
  );
  return calls;
}

describe("fmp-market", () => {
  beforeEach(() => {
    process.env.FMP_API_KEY = "test-key";
    process.env.FMP_MAX_REQ_PER_MIN = "100000";
    resetState();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("adds an estimated 180-day lock-up expiry, prospectus and disclosures to IPOs", async () => {
    mockFmp({
      "ipos-calendar": [
        { symbol: "NEWC", date: "2026-05-01", company: "NewCo", actions: "Priced" },
        { symbol: "0700.HK", date: "2026-05-02", company: "Foreign", actions: "Priced" },
      ],
      "ipos-prospectus": [{ symbol: "NEWC", filingDate: "2026-04-20", pricePublicPerShare: 15 }],
      "ipos-disclosure": [{ symbol: "NEWC", filingDate: "2026-04-01", form: "CERT" }, { symbol: "OTHER", filingDate: "2026-04-01" }],
    });
    const out = await market.ipos("2026-05-01", "2026-05-31");
    expect(out).toHaveLength(1);
    expect(out[0].lockupExpiry).toEqual({ date: "2026-10-28", estimated: true, basis: "IPO date + 180 days" });
    expect(out[0].prospectus).toHaveLength(1);
    expect(out[0].disclosures).toEqual([{ symbol: "NEWC", filingDate: "2026-04-01", form: "CERT" }]);
  });

  it("lists priced IPOs expiring soon with performance since the IPO, skipping warrants", async () => {
    const calls = mockFmp({
      "ipos-calendar": [
        { symbol: "AAA", date: "2026-05-01", company: "Alpha Inc", actions: "Priced" },
        { symbol: "AAAW", date: "2026-05-01", company: "Alpha Inc Warrants", actions: "Priced" },
        { symbol: "BBB", date: "2026-04-28", company: "Beta Inc", actions: "Priced" },
        { symbol: "CCC", date: "2026-05-02", company: "Gamma Inc", actions: "Expected" },
      ],
      "ipos-prospectus": [{ symbol: "AAA", pricePublicPerShare: 10 }],
      "batch-quote": [{ symbol: "AAA", price: 15 }, { symbol: "BBB", price: 4 }],
    });
    const out = await market.lockups(14, "2026-10-21");
    expect(out.map((r) => r.symbol)).toEqual(["BBB", "AAA"]);
    expect(out[1]).toMatchObject({ ipoPrice: 10, price: 15, changeSinceIpoPercent: 50 });
    expect(out[0]).toMatchObject({ ipoPrice: null, changeSinceIpoPercent: null });
    const cal = calls.find((u) => u.pathname.endsWith("ipos-calendar"))!;
    expect(cal.searchParams.get("from")).toBe("2026-04-24");
    expect(cal.searchParams.get("to")).toBe("2026-05-08");
  });

  it("drops foreign symbols from split and dividend calendars and sorts ascending", async () => {
    mockFmp({
      "splits-calendar": [{ symbol: "B", date: "2026-11-02" }, { symbol: "0646.HK", date: "2026-11-01" }, { symbol: "A", date: "2026-11-01" }],
      "dividends-calendar": [
        { symbol: "KO", date: "2026-11-05" },
        { symbol: "0A26.L", date: "2026-11-04" },
        { symbol: "BBY.L", date: "2026-11-04" }, // single-letter suffix: foreign in FMP data (US classes use BRK-B)
        { symbol: "AFM.V", date: "2026-11-04" },
        { symbol: "BRK-B", date: "2026-11-06" },
      ],
    });
    expect((await market.splits("2026-11-01", "2026-11-30")).map((r) => r.symbol)).toEqual(["A", "B"]);
    expect((await market.dividends("2026-11-01", "2026-11-30")).map((r) => r.symbol)).toEqual(["KO", "BRK-B"]);
  });

  it("joins sector performance with P/E, best first, and walks back past empty days", async () => {
    const calls = mockFmp({
      "sector-performance-snapshot": (u: URL) => (u.searchParams.get("date") === "2026-10-18" ? [{ sector: "Energy", averageChange: -1 }, { sector: "Tech", averageChange: 2 }] : []),
      "sector-pe-snapshot": [{ sector: "Tech", pe: 30 }],
    });
    const out = await market.sectors("NASDAQ", undefined, "2026-10-20");
    expect(out.date).toBe("2026-10-18");
    expect(out.rows).toEqual([{ sector: "Tech", averageChange: 2, pe: 30 }, { sector: "Energy", averageChange: -1, pe: null }]);
    expect(calls.filter((u) => u.pathname.endsWith("performance-snapshot")).map((u) => u.searchParams.get("date"))).toEqual(["2026-10-20", "2026-10-19", "2026-10-18"]);
  });

  it("merges sector history newest first", async () => {
    const calls = mockFmp({ "historical-sector-performance": [], "historical-sector-pe": [] });
    await market.groupHistory("sector", "Energy", "NYSE", "2026-10-01", undefined, "2026-10-20");
    expect(calls[0].searchParams.get("to")).toBe("2026-10-20");
    mockFmp({
      "historical-sector-performance": [{ date: "2026-10-19", sector: "Energy", averageChange: 1 }, { date: "2026-10-20", sector: "Energy", averageChange: 2 }],
      "historical-sector-pe": [{ date: "2026-10-20", sector: "Energy", pe: 14 }],
    });
    const out = await market.groupHistory("sector", "Energy", "NASDAQ", "2026-10-02", "2026-10-20");
    expect(out.map((r) => [r.date, r.pe])).toEqual([["2026-10-20", 14], ["2026-10-19", null]]);
  });

  it("trims index changes by date and limit, newest first", async () => {
    mockFmp({
      "historical-sp500-constituent": [{ date: "2026-01-02" }, { date: "2026-09-21" }, { date: "2026-10-06" }],
    });
    expect((await market.indexChanges("sp500", "2026-02-01")).map((r) => r.date)).toEqual(["2026-10-06", "2026-09-21"]);
    expect((await market.indexChanges("sp500", undefined, undefined, 1)).map((r) => r.date)).toEqual(["2026-10-06"]);
  });

  it("sorts ETF holdings by weight, sends the dashed symbol, and numbers country weights", async () => {
    const calls = mockFmp({
      "etf/holdings": [{ asset: "A", weightPercentage: 1 }, { asset: "B", weightPercentage: 5 }],
      "etf/info": [{ symbol: "SPY", name: "SPDR", description: "long", sectorsList: [], expenseRatio: 0.09 }],
      "etf/country-weightings": [{ country: "United States", weightPercentage: "97.66%" }],
      "etf/sector-weightings": [{ symbol: "SPY", sector: "Technology", weightPercentage: 38 }],
      "etf/asset-exposure": [{ symbol: "ZWT.TO", weightPercentage: 9 }, { symbol: "AAP3.L", weightPercentage: 30 }, { symbol: "HEMI", weightPercentage: 34294 }, { symbol: "XLK", weightPercentage: 20 }, { symbol: "QQQ", weightPercentage: 8 }],
    });
    expect((await market.etfHoldings("SPY")).map((r) => r.asset)).toEqual(["B", "A"]);
    const exp = await market.etfExposure("SPY");
    expect(exp.info).toEqual({ symbol: "SPY", name: "SPDR", expenseRatio: 0.09 });
    expect(exp.countryWeightings).toEqual([{ country: "United States", weightPercentage: 97.66 }]);
    expect((await market.etfAssetExposure("BRK.B")).map((r) => r.symbol)).toEqual(["XLK", "QQQ"]);
    expect(calls.at(-1)!.searchParams.get("symbol")).toBe("BRK-B");
  });

  it("builds the company profile with executives and the latest employee count", async () => {
    mockFmp({
      profile: [{ symbol: "AAPL", companyName: "Apple Inc." }],
      "key-executives": [{ name: "Tim Cook" }],
      "employee-count": [{ periodOfReport: "2024-09-28", employeeCount: 164000 }, { periodOfReport: "2025-09-27", employeeCount: 166000 }],
    });
    const out = await market.companyProfile("AAPL");
    expect(out.profile).toEqual({ symbol: "AAPL", companyName: "Apple Inc." });
    expect(out.executives).toHaveLength(1);
    expect(out.employeeCount.latest).toBe(166000);
    expect(out.employeeCount.history[0].periodOfReport).toBe("2025-09-27");
  });

  it("returns a null profile and no employee count when FMP has nothing", async () => {
    mockFmp({});
    expect(await market.companyProfile("ZZZZ")).toEqual({ profile: null, executives: [], employeeCount: { latest: null, history: [] } });
  });
});
