import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FmpError,
  FmpNotConfigured,
  earnings,
  earningsCalendar,
  earningsInfo,
  economicCalendar,
  historical,
  isConfigured,
  profiles,
  quotes,
  ratiosTtm,
  resetState,
} from "./fmp.js";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() };
}
function fail(status: number, body = "nope") {
  return { ok: false, status, json: async () => ({}), text: async () => body, headers: new Headers({ "retry-after": "0" }) };
}

describe("fmp provider", () => {
  beforeEach(() => {
    process.env.FMP_API_KEY = "test-key";
    resetState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FMP_API_KEY;
  });

  it("throws FmpNotConfigured from every function when the key is unset", async () => {
    delete process.env.FMP_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(isConfigured()).toBe(false);
    const calls = [
      () => profiles(["AAPL"]),
      () => quotes(["AAPL"]),
      () => historical("AAPL", "2026-01-01", "2026-02-01"),
      () => earningsCalendar("2026-01-01", "2026-02-01"),
      () => earningsInfo(["AAPL"]),
      () => earnings("AAPL"),
      () => economicCalendar("2026-01-01", "2026-02-01"),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(FmpNotConfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps profiles and caches them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ok([{ symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ", sector: "Technology", marketCap: 3e12, beta: 1.2, lastDividend: 1, website: "https://apple.com", isEtf: false }])
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await profiles(["aapl"]);
    expect(first.get("AAPL")).toMatchObject({ name: "Apple Inc.", sector: "Technology", marketCap: 3e12, lastDividend: 1 });
    await profiles(["AAPL"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/stable/profile?symbol=AAPL&apikey=test-key");
  });

  it("maps batch quotes and derives shares outstanding", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ok([{ symbol: "SAP.DE", name: "SAP", price: 200, change: 2, changePercentage: 1.01, dayHigh: 201, dayLow: 198, yearHigh: 250, yearLow: 150, marketCap: 2e11, volume: 1000, timestamp: 1700000000 }])
    );
    vi.stubGlobal("fetch", fetchMock);
    const q = (await quotes(["SAP.DE"])).get("SAP.DE")!;
    expect(q).toMatchObject({ price: 200, changePercent: 1.01, week52High: 250, week52Low: 150, sharesOutstanding: 1e9, pe: null, source: "fmp" });
    await quotes(["SAP.DE"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to single quotes when batch is not on the plan", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.includes("/batch-quote") ? fail(402) : ok([{ symbol: "AAPL", price: 10 }])
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await quotes(["AAPL"])).get("AAPL")?.price).toBe(10);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))[1]).toContain("/quote?symbol=AAPL");
  });

  it("stops asking for batch quotes after the plan refuses it, and skips symbols the plan doesn't cover", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/batch-quote")) return fail(402);
      if (url.includes("symbol=SHOP.TO")) return fail(402, "Premium Query Parameter");
      return ok([{ symbol: new URL(url).searchParams.get("symbol"), price: 10 }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const got = await quotes(["AAPL", "SHOP.TO"]);
    expect(got.get("AAPL")?.price).toBe(10);
    expect(got.has("SHOP.TO")).toBe(false);
    await quotes(["NVDA"]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/batch-quote"))).toHaveLength(1);
    expect(urls.at(-1)).toContain("/quote?symbol=NVDA");
  });

  it("reads average volume and the 52-week range from the profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([{ symbol: "AAPL", companyName: "Apple Inc.", price: 339.5, marketCap: 4.95e12, averageVolume: 49309450, range: "169.21-345.00" }])));
    expect((await profiles(["AAPL"])).get("AAPL")).toMatchObject({ price: 339.5, avgVolume: 49309450, week52Low: 169.21, week52High: 345 });
  });

  it("maps TTM ratios, caches them a day, and omits symbols the plan refuses", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.includes("symbol=SHOP.TO")
        ? fail(402)
        : ok([{ symbol: "NVDA", priceToEarningsRatioTTM: 27.23, netIncomePerShareTTM: 7.97, dividendYieldTTM: 0.0024 }])
    );
    vi.stubGlobal("fetch", fetchMock);
    const got = await ratiosTtm(["NVDA", "SHOP.TO"]);
    expect(got.get("NVDA")).toEqual({ symbol: "NVDA", pe: 27.23, eps: 7.97, dividendYield: 0.0024 });
    expect(got.has("SHOP.TO")).toBe(false);
    await ratiosTtm(["NVDA"]);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("symbol=NVDA"))).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/stable/ratios-ttm?symbol=");
  });

  it("returns historical candles oldest first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ok([
          { date: "2026-01-03", open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
          { date: "2026-01-02", open: 1, high: 2, low: 1, close: 2, volume: 5 },
          { date: "2026-01-01", open: null, high: 2, low: 1, close: 2 },
        ])
      )
    );
    const c = await historical("aapl", "2026-01-01", "2026-01-03");
    expect(c.map((x) => x.close)).toEqual([2, 2.5]);
    expect(c[0].time).toBe(Date.UTC(2026, 0, 2) / 1000);
  });

  it("builds the /calendar shape from each symbol's earnings, not the truncated market-wide calendar", async () => {
    const now = new Date("2026-10-21T12:00:00Z");
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/earnings-calendar")) throw new Error("must not use the 4,000-row calendar");
      if (u.searchParams.get("symbol") === "AAPL")
        return ok([
          { symbol: "AAPL", date: "2027-01-28", epsActual: null, epsEstimated: 2.4 },
          { symbol: "AAPL", date: "2026-11-02", epsActual: null, epsEstimated: 1.99 },
          { symbol: "AAPL", date: "2026-07-30", epsActual: 2.02, epsEstimated: 1.89 },
          { symbol: "AAPL", date: "2026-04-30", epsActual: 2.01, epsEstimated: 1.95 },
        ]);
      if (u.searchParams.get("symbol") === "SHOP.TO") return fail(402);
      return ok([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const info = await earningsInfo(["AAPL", "ZZZ", "SHOP.TO"], now);
    expect(info[0]).toEqual({
      symbol: "AAPL",
      nextEarningsDate: Date.UTC(2026, 10, 2) / 1000,
      lastEarningsDate: Date.UTC(2026, 6, 30) / 1000,
      epsForecast: 1.99,
    });
    expect(info[1]).toEqual({ symbol: "ZZZ", nextEarningsDate: null, lastEarningsDate: null, epsForecast: null });
    expect(info[2]).toMatchObject({ symbol: "SHOP.TO", nextEarningsDate: null });
    await earningsInfo(["AAPL"], now);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("symbol=AAPL"))).toHaveLength(1);
  });

  it("returns reported quarters newest first with a surprise percent", async () => {
    const body = ok([
      { symbol: "AAPL", date: "2026-08-01", epsActual: null, epsEstimated: 1 },
      { symbol: "AAPL", date: "2026-02-01", epsActual: 2.2, epsEstimated: 2, revenueActual: 100, revenueEstimated: 90 },
      { symbol: "AAPL", date: "2026-05-01", epsActual: 1, epsEstimated: 0 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (new URL(url).pathname.endsWith("/income-statement") ? ok([]) : body) as never));
    const rows = await earnings("AAPL");
    expect(rows.map((r) => r.dateReported)).toEqual([Date.UTC(2026, 4, 1) / 1000, Date.UTC(2026, 1, 1) / 1000]);
    expect(rows[0].surprisePercent).toBeNull();
    expect(rows[1]).toMatchObject({ eps: 2.2, consensusForecast: 2, revenue: 100, revenueEstimate: 90 });
    expect(rows[1].surprisePercent).toBeCloseTo(10);
  });

  describe("fiscal quarters and the upcoming report", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 1000;
    const stmt = (date: string, period: string, fiscalYear: string, filingDate: string) => ({ symbol: "NVDA", date, period, fiscalYear, filingDate });
    const stubFetch = (earn: unknown[], income: unknown | (() => unknown)) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (new URL(url).pathname.endsWith("/income-statement")) {
            const r = typeof income === "function" ? (income as () => unknown)() : income;
            return r as never;
          }
          return ok(earn) as never;
        })
      );

    it("matches a report to the statement filed within 5 days of it", async () => {
      stubFetch(
        [{ symbol: "NVDA", date: "2026-08-26", epsActual: 1.1, epsEstimated: 1 }],
        ok([stmt("2026-07-26", "Q2", "2027", "2026-08-26"), stmt("2026-04-26", "Q1", "2027", "2026-05-28")])
      );
      const [row] = await earnings("NVDA", 12, now);
      expect(row).toMatchObject({ fiscalQtrEnd: "2026-07-26", fiscalPeriod: "Q2 FY2027", dateReported: day("2026-08-26") });
      expect(row.upcoming).toBeUndefined();
    });

    it("falls back to the latest period end within 100 days before the report", async () => {
      stubFetch(
        [
          { symbol: "NVDA", date: "2026-08-26", epsActual: 1.1, epsEstimated: 1 },
          { symbol: "NVDA", date: "2026-01-01", epsActual: 1, epsEstimated: 1 },
        ],
        ok([stmt("2026-07-26", "Q2", "2027", "2026-09-30"), stmt("2026-04-26", "Q1", "2027", "2026-09-30")])
      );
      const rows = await earnings("NVDA", 12, now);
      expect(rows[0]).toMatchObject({ fiscalQtrEnd: "2026-07-26", fiscalPeriod: "Q2 FY2027" });
      // Nearest earlier period end is 250 days away: no match.
      expect(rows[1]).toMatchObject({ fiscalQtrEnd: "" });
      expect(rows[1].fiscalPeriod).toBeUndefined();
    });

    it("leaves the fiscal period empty on a 402", async () => {
      stubFetch([{ symbol: "NVDA", date: "2026-08-26", epsActual: 1.1, epsEstimated: 1 }], fail(402));
      const rows = await earnings("NVDA", 12, now);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fiscalQtrEnd: "", eps: 1.1 });
    });

    it("returns the next report first as upcoming, consensus only", async () => {
      stubFetch(
        [
          { symbol: "NVDA", date: "2026-11-18", epsActual: null, epsEstimated: 2.49, revenueEstimated: 108.8e9 },
          { symbol: "NVDA", date: "2026-08-26", epsActual: 1.1, epsEstimated: 1 },
        ],
        ok([stmt("2026-07-26", "Q2", "2027", "2026-08-26")])
      );
      const rows = await earnings("NVDA", 12, now);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        fiscalQtrEnd: "",
        upcoming: true,
        dateReported: day("2026-11-18"),
        eps: null,
        consensusForecast: 2.49,
        surprisePercent: null,
        revenue: null,
        revenueEstimate: 108.8e9,
      });
      expect(rows[1].upcoming).toBeUndefined();
    });

    it("omits the upcoming row when the null-actual date has passed or none exists", async () => {
      stubFetch(
        [
          { symbol: "NVDA", date: "2026-10-01", epsActual: null, epsEstimated: 2 },
          { symbol: "NVDA", date: "2026-08-26", epsActual: 1.1, epsEstimated: 1 },
        ],
        ok([])
      );
      const rows = await earnings("NVDA", 12, now);
      expect(rows.map((r) => r.upcoming)).toEqual([undefined]);
    });
  });

  it("maps the economic calendar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ok([
          { date: "2026-03-02 13:30:00", country: "US", event: "CPI", currency: "USD", previous: 3, estimate: 3.1, actual: null, impact: "High" },
          { date: "2026-03-01 09:00", country: "EU", event: "PMI", impact: "weird" },
          { date: "bad", event: "x" },
        ])
      )
    );
    const events = await economicCalendar("2026-03-01", "2026-03-07");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ title: "PMI", date: "2026-03-01T09:00:00.000Z", impact: "Low" });
    expect(events[1]).toEqual({ title: "CPI", country: "US", date: "2026-03-02T13:30:00.000Z", impact: "High", forecast: "3.1", previous: "3", actual: null, currency: "USD" });
  });

  it("surfaces 401 and 429 as FmpError without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(401, "Invalid API KEY")));
    const err = await profiles(["AAPL"]).catch((e) => e);
    expect(err).toBeInstanceOf(FmpError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain("test-key");

    resetState();
    const fetchMock = vi.fn().mockResolvedValue(fail(429, "limit"));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p = earningsCalendar("2026-01-01", "2026-02-01").catch((e) => e);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(await p).toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("treats a 200 Error Message body as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ "Error Message": "Special Endpoint" })));
    await expect(earningsCalendar("2026-01-01", "2026-02-01")).rejects.toBeInstanceOf(FmpError);
  });
});
