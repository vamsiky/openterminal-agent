import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetThrottle } from "./alpaca.js";
import { CRYPTO_SYMBOLS, cryptoBars, cryptoSnapshots, history, isCryptoSymbol, latestQuotes, orderBook, orderbook, quote, toPair } from "./alpaca-crypto.js";

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, headers: new Headers() });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const urlOf = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => new URL(fetchMock.mock.calls[i][0] as string);

const snapshot = {
  dailyBar: { t: "2026-10-21T00:00:00Z", o: 82933, h: 83158, l: 82629, c: 82723, v: 0.44 },
  latestQuote: { t: "2026-10-21T04:28:19Z", bp: 82696, ap: 82709, bs: 0.001, as: 0.001 },
  latestTrade: { t: "2026-10-21T04:12:15Z", p: 82669.93, s: 0.00003 },
  prevDailyBar: { t: "2026-10-20T00:00:00Z", o: 81843, h: 83343, l: 81103, c: 82940, v: 1.6 },
};

describe("alpaca crypto", () => {
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

  it("maps app symbols to Alpaca pairs", () => {
    expect(toPair("BTC")).toBe("BTC/USD");
    expect(toPair("eth-usd")).toBe("ETH/USD");
    expect(toPair("SOL/USD")).toBe("SOL/USD");
    expect(toPair("AAPL")).toBeNull();
    expect(toPair("BTC-EUR")).toBeNull();
    expect(isCryptoSymbol("DOGE-USD")).toBe(true);
    expect(CRYPTO_SYMBOLS.has("BTC")).toBe(true);
    expect(CRYPTO_SYMBOLS.has("USDT")).toBe(false);
  });

  it("keys latest quotes by the caller's spelling and skips unsupported symbols", async () => {
    const fetchMock = mockFetch({ quotes: { "BTC/USD": { t: "t", bp: 1, ap: 2, bs: 3, as: 4 } } });
    const out = await latestQuotes(["BTC-USD", "AAPL"]);
    expect(urlOf(fetchMock).pathname).toBe("/v1beta3/crypto/us/latest/quotes");
    expect(urlOf(fetchMock).searchParams.get("symbols")).toBe("BTC/USD");
    expect(out).toEqual({ "BTC-USD": { t: "t", bp: 1, ap: 2, bs: 3, as: 4 } });
  });

  it("makes no request when nothing is a crypto symbol", async () => {
    const fetchMock = mockFetch();
    expect(await cryptoSnapshots(["AAPL"])).toEqual({});
    expect(await latestQuotes(["AAPL"])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows bar pages", async () => {
    const b = (t: string, c: number) => ({ t, o: c, h: c, l: c, c, v: 1 });
    const fetchMock = mockFetch(
      { bars: { "BTC/USD": [b("2026-10-01T00:00:00Z", 1)] }, next_page_token: "abc" },
      { bars: { "BTC/USD": [b("2026-10-02T00:00:00Z", 2)] }, next_page_token: null }
    );
    const bars = await cryptoBars("BTC", { timeframe: "1Day", start: "2026-10-01T00:00:00Z" });
    expect(bars.map((x) => x.c)).toEqual([1, 2]);
    expect(urlOf(fetchMock, 1).searchParams.get("page_token")).toBe("abc");
    await expect(cryptoBars("AAPL", { timeframe: "1Day", start: "2026-10-01" })).rejects.toThrow(/unsupported/);
  });

  it("adapts a snapshot to the binance.quote shape", async () => {
    const fetchMock = mockFetch({ snapshots: { "BTC/USD": snapshot } });
    const q = await quote("btc");
    expect(urlOf(fetchMock).searchParams.get("symbols")).toBe("BTC/USD");
    expect(q).toMatchObject({
      symbol: "BTC", name: "Bitcoin", price: 82669.93, previousClose: 82940, open: 82933, high: 83158, low: 82629,
      volume: 0.44, bid: 82696, ask: 82709, currency: "USD", exchange: "Alpaca", source: "alpaca",
      time: Math.round(Date.parse("2026-10-21T04:12:15Z") / 1000), avgVolume: null, marketCap: null,
    });
    expect(q.change).toBeCloseTo(-270.07, 2);
    expect(q.changePercent).toBeCloseTo(-0.3256, 3);
  });

  it("throws when a snapshot has no price", async () => {
    mockFetch({ snapshots: {} });
    await expect(quote("BTC")).rejects.toThrow(/no price/);
  });

  it("adapts bars to candles with unix-second times and the right timeframe per range", async () => {
    const fetchMock = mockFetch({ bars: { "ETH/USD": [{ t: "2026-10-20T00:00:00Z", o: 1, h: 3, l: 0.5, c: 2, v: 10 }] }, next_page_token: null });
    const now = new Date("2026-10-21T12:00:00Z");
    const candles = await history("ETH-USD", "1Y", now);
    const u = urlOf(fetchMock);
    expect(u.pathname).toBe("/v1beta3/crypto/us/bars");
    expect(u.searchParams.get("timeframe")).toBe("1Day");
    expect(u.searchParams.get("start")).toBe(new Date(now.getTime() - 365 * 86_400_000).toISOString());
    expect(candles).toEqual([{ time: Date.parse("2026-10-20T00:00:00Z") / 1000, open: 1, high: 3, low: 0.5, close: 2, volume: 10 }]);

    mockFetch({ bars: {} });
    await history("ETH", "1D", now);
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("timeframe")).toBe("5Min");
  });

  it("sorts the orderbook best first and adapts to binance string pairs", async () => {
    const body = { orderbooks: { "BTC/USD": { t: "2026-10-21T04:28:48Z", a: [{ p: 102, s: 1 }, { p: 101, s: 2 }, { p: 103, s: 3 }], b: [{ p: 99, s: 4 }, { p: 100, s: 5 }] } } };
    mockFetch(body);
    expect(await orderbook("BTC")).toEqual({
      bids: [{ p: 100, s: 5 }, { p: 99, s: 4 }],
      asks: [{ p: 101, s: 2 }, { p: 102, s: 1 }, { p: 103, s: 3 }],
      time: "2026-10-21T04:28:48Z",
    });
    mockFetch(body);
    expect(await orderBook("BTC-USD", 2)).toEqual({
      bids: [["100", "5"], ["99", "4"]],
      asks: [["101", "2"], ["102", "1"]],
    });
  });

  it("errors when Alpaca returns no book", async () => {
    mockFetch({ orderbooks: {} });
    await expect(orderbook("BTC")).rejects.toThrow(/no orderbook/);
  });
});
