import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxRequestsPerMinute, resetThrottle, stockBars, stockBarsPage } from "./alpaca.js";

function mockPages(pages: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of pages) fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, headers: new Headers() });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("alpaca provider", () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY_ID = "key-id";
    process.env.ALPACA_API_SECRET_KEY = "secret";
    process.env.ALPACA_MAX_REQ_PER_MIN = "60000";
    resetThrottle();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
    delete process.env.ALPACA_MAX_REQ_PER_MIN;
  });

  it("only ever calls the market-data host, never the trading API", () => {
    const source = readFileSync(new URL("./alpaca.ts", import.meta.url), "utf8");
    const hosts = [...source.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    expect(new Set(hosts)).toEqual(new Set(["data.alpaca.markets"]));
    expect(source).not.toMatch(/\/v2\/orders|\/v2\/positions|\/v2\/account/);
  });

  it("sends the keys as headers and split-adjusted SIP parameters", async () => {
    const fetchMock = mockPages([{ bars: { AAPL: [] }, next_page_token: null }]);
    await stockBarsPage({ symbols: ["AAPL", "MSFT"], timeframe: "1Day", start: "2024-01-01" });
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url as string);
    expect(u.origin).toBe("https://data.alpaca.markets");
    expect(u.pathname).toBe("/v2/stocks/bars");
    expect(u.searchParams.get("symbols")).toBe("AAPL,MSFT");
    expect(u.searchParams.get("adjustment")).toBe("split");
    expect(u.searchParams.get("feed")).toBe("sip");
    expect((init as RequestInit).headers).toMatchObject({ "APCA-API-KEY-ID": "key-id", "APCA-API-SECRET-KEY": "secret" });
  });

  it("follows next_page_token until the last page", async () => {
    const bar = { t: "2024-01-02T05:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 };
    const fetchMock = mockPages([
      { bars: { AAPL: [bar] }, next_page_token: "p2" },
      { bars: { AAPL: [bar] }, next_page_token: null },
    ]);
    const pages = [];
    for await (const page of stockBars({ symbols: ["AAPL"], timeframe: "1Day", start: "2024-01-01" })) pages.push(page);
    expect(pages).toHaveLength(2);
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("page_token")).toBe("p2");
  });

  it("refuses to run without keys", async () => {
    delete process.env.ALPACA_API_KEY_ID;
    await expect(stockBarsPage({ symbols: ["AAPL"], timeframe: "1Day", start: "2024-01-01" })).rejects.toThrow(/ALPACA_API_KEY_ID/);
  });
});

describe("alpaca request budget", () => {
  it("falls back to the default for blank or invalid settings", () => {
    expect(maxRequestsPerMinute(undefined)).toBe(180);
    expect(maxRequestsPerMinute("")).toBe(180);
    expect(maxRequestsPerMinute("10k")).toBe(180);
    expect(maxRequestsPerMinute("0")).toBe(180);
    expect(maxRequestsPerMinute(" 1000 ")).toBe(1000);
  });
});
