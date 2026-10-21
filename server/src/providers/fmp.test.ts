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

  it("builds the /calendar shape from the earnings calendar", async () => {
    const now = new Date("2026-05-01T12:00:00Z");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const from = new URL(url).searchParams.get("from")!;
        if (from === "2026-05-01") return ok([{ symbol: "AAPL", date: "2026-05-20", epsEstimated: 1.5 }, { symbol: "MSFT", date: "2026-05-02", epsEstimated: 3 }]);
        if (from < "2026-05-01") return ok([{ symbol: "AAPL", date: "2026-02-01", epsActual: 2 }]);
        return ok([]);
      })
    );
    const info = await earningsInfo(["AAPL", "ZZZ"], now);
    expect(info[0]).toEqual({
      symbol: "AAPL",
      nextEarningsDate: Date.UTC(2026, 4, 20) / 1000,
      lastEarningsDate: Date.UTC(2026, 1, 1) / 1000,
      epsForecast: 1.5,
    });
    expect(info[1]).toEqual({ symbol: "ZZZ", nextEarningsDate: null, lastEarningsDate: null, epsForecast: null });
  });

  it("returns reported quarters newest first with a surprise percent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ok([
          { symbol: "AAPL", date: "2026-08-01", epsActual: null, epsEstimated: 1 },
          { symbol: "AAPL", date: "2026-02-01", epsActual: 2.2, epsEstimated: 2, revenueActual: 100, revenueEstimated: 90 },
          { symbol: "AAPL", date: "2026-05-01", epsActual: 1, epsEstimated: 0 },
        ])
      )
    );
    const rows = await earnings("AAPL");
    expect(rows.map((r) => r.dateReported)).toEqual([Date.UTC(2026, 4, 1) / 1000, Date.UTC(2026, 1, 1) / 1000]);
    expect(rows[0].surprisePercent).toBeNull();
    expect(rows[1]).toMatchObject({ eps: 2.2, consensusForecast: 2, revenue: 100, revenueEstimate: 90 });
    expect(rows[1].surprisePercent).toBeCloseTo(10);
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
    const p = earnings("AAPL").catch((e) => e);
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
