import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// The market routes with the live feed off, every provider mocked: which
// source each symbol goes to, the features that need FMP or Alpaca keys, and
// the news, options, search and calendar routes. Nothing reaches the network.

vi.mock("../live/feed.js", () => ({ enabled: () => false, focusOn: vi.fn(), liveQuote: () => null }));
vi.mock("../live/history.js", () => ({ alpacaHistory: vi.fn() }));
vi.mock("../history/universe.js", async (orig) => ({ ...(await orig<object>()), sp500: vi.fn(), nasdaq100: vi.fn() }));
vi.mock("../providers/alpaca.js", async (orig) => ({ ...(await orig<object>()), isConfigured: vi.fn(), snapshots: vi.fn() }));
vi.mock("../providers/alpaca-crypto.js", async (orig) => ({ ...(await orig<object>()), quote: vi.fn(), history: vi.fn(), orderBook: vi.fn() }));
vi.mock("../providers/alpaca-news.js", async (orig) => ({ ...(await orig<object>()), symbolNews: vi.fn(), marketNews: vi.fn() }));
vi.mock("../providers/alpaca-options.js", () => ({ chain: vi.fn() }));
vi.mock("../providers/alpaca-assets.js", () => ({ allAssets: vi.fn(async () => []), search: vi.fn() }));
vi.mock("../providers/sec-reference.js", () => ({ reference: vi.fn(async () => new Map()) }));
vi.mock("../providers/fred.js", () => ({ series: vi.fn(), latest: vi.fn() }));
vi.mock("../providers/ecb.js", () => ({ series: vi.fn(), latest: vi.fn() }));
vi.mock("../providers/stooq.js", () => ({ quote: vi.fn(), history: vi.fn() }));
vi.mock("../providers/calendars.js", () => ({ econEvents: vi.fn() }));
vi.mock("../providers/fmp.js", async (orig) => ({
  ...(await orig<object>()),
  isConfigured: vi.fn(),
  quotes: vi.fn(),
  profiles: vi.fn(async () => new Map()),
  historical: vi.fn(),
  earningsInfo: vi.fn(),
  earnings: vi.fn(),
  economicCalendar: vi.fn(),
}));

// universe.ts pulls in db.ts, which opens real sqlite files under DATA_DIR at import time.
let tmpDir: string;
let marketRouter: typeof import("./market.js").marketRouter;
let alpaca: typeof import("../providers/alpaca.js");
let crypto: typeof import("../providers/alpaca-crypto.js");
let news: typeof import("../providers/alpaca-news.js");
let options: typeof import("../providers/alpaca-options.js");
let assets: typeof import("../providers/alpaca-assets.js");
let fred: typeof import("../providers/fred.js");
let ecb: typeof import("../providers/ecb.js");
let stooq: typeof import("../providers/stooq.js");
let calendars: typeof import("../providers/calendars.js");
let fmp: typeof import("../providers/fmp.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-market-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ marketRouter } = await import("./market.js"));
  alpaca = await import("../providers/alpaca.js");
  crypto = await import("../providers/alpaca-crypto.js");
  news = await import("../providers/alpaca-news.js");
  options = await import("../providers/alpaca-options.js");
  assets = await import("../providers/alpaca-assets.js");
  fred = await import("../providers/fred.js");
  ecb = await import("../providers/ecb.js");
  stooq = await import("../providers/stooq.js");
  calendars = await import("../providers/calendars.js");
  fmp = await import("../providers/fmp.js");
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("no network in tests"))));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (await import("../db.js")).db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  vi.mocked(alpaca.isConfigured).mockReset().mockReturnValue(true);
  vi.mocked(alpaca.snapshots).mockReset().mockResolvedValue({});
  vi.mocked(fmp.isConfigured).mockReset().mockReturnValue(false);
  vi.mocked(fmp.quotes).mockReset().mockResolvedValue(new Map());
  vi.mocked(stooq.quote).mockReset().mockRejectedValue(new Error("stooq down"));
  vi.mocked(stooq.history).mockReset().mockRejectedValue(new Error("stooq down"));
  vi.mocked(crypto.quote).mockReset();
});

type Res = { statusCode: number; body: any; headers: Record<string, string> };

/** Run the route's handler for `path` (the route pattern) with the given params and query. */
async function call(path: string, req: { params?: Record<string, string>; query?: Record<string, string> } = {}): Promise<Res> {
  const layer = (marketRouter as any).stack.find((l: any) => l.route?.path === path);
  if (!layer) throw new Error(`no route registered for ${path}`);
  const res = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
  };
  const url = path.replace(/:(\w+)/g, (_, k) => req.params?.[k] ?? "");
  await layer.route.stack[0].handle({ params: {}, query: {}, path: url, ...req } as unknown as Request, res as unknown as Response, () => {});
  return res;
}

const bar = (c: number, v = 1_000) => ({ t: "2026-10-20T04:00:00Z", o: c - 1, h: c + 1, l: c - 2, c, v });
const snap = (price: number, prev: number) => ({
  latestTrade: { t: "2026-10-20T15:00:00Z", p: price, s: 1 },
  latestQuote: { t: "2026-10-20T15:00:00Z", bp: price - 0.01, ap: price + 0.01, bs: 1, as: 1 },
  dailyBar: bar(price),
  prevDailyBar: bar(prev),
});
const quote = (symbol: string, price: number, source: string) => ({ symbol, price, source }) as any;

describe("quote routing", () => {
  it("prices a US stock from an Alpaca snapshot", async () => {
    vi.mocked(alpaca.snapshots).mockResolvedValue({ AAPL: snap(110, 100) });
    const { body } = await call("/quotes", { query: { symbols: "AAPL" } });
    expect(alpaca.snapshots).toHaveBeenCalledWith(["AAPL"]);
    expect(body).toEqual([expect.objectContaining({ symbol: "AAPL", price: 110, change: 10, changePercent: 10, previousClose: 100, source: "alpaca" })]);
  });

  it("sends BTC and -USD pairs to Alpaca crypto, but bare UNI to the stock feed", async () => {
    vi.mocked(crypto.quote).mockImplementation(async (s) => quote(s, 1, "alpaca"));
    vi.mocked(alpaca.snapshots).mockResolvedValue({ UNI: snap(5, 5) });
    const { body } = await call("/quotes", { query: { symbols: "BTC,SOL-USD,UNI" } });
    expect(vi.mocked(crypto.quote).mock.calls.map((c) => c[0])).toEqual(["BTC", "SOL-USD"]);
    expect(alpaca.snapshots).toHaveBeenCalledWith(["UNI"]);
    expect(body.map((q: any) => q.symbol)).toEqual(["BTC", "SOL-USD", "UNI"]);
  });

  it("serves ^VIX from FRED", async () => {
    vi.mocked(fred.series).mockResolvedValue([{ date: "2026-10-16", value: 20 }, { date: "2026-10-19", value: 22 }]);
    const { body } = await call("/quotes", { query: { symbols: "^VIX" } });
    expect(fred.series).toHaveBeenCalledWith("VIXCLS", 5);
    expect(body).toEqual([expect.objectContaining({ symbol: "^VIX", price: 22, change: 2, source: "fred" })]);
  });

  it("crosses ECB reference rates for FX pairs", async () => {
    const perEur: Record<string, number[]> = { USD: [1.1, 1.0], JPY: [165, 160] };
    vi.mocked(ecb.series).mockImplementation(async (_flow, key) => {
      const ccy = key.split(".")[1];
      return perEur[ccy].map((value, i) => ({ date: `2026-10-1${i + 5}`, value }));
    });
    const { body } = await call("/quotes", { query: { symbols: "EURUSD=X,USDJPY=X" } });
    expect(body[0]).toMatchObject({ symbol: "EURUSD=X", price: 1.0, previousClose: 1.1, source: "ecb" });
    expect(body[1]).toMatchObject({ symbol: "USDJPY=X", price: 160, previousClose: 150, source: "ecb" });
  });

  it("prices a US OTC name from FMP when keyed", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    vi.mocked(fmp.quotes).mockResolvedValue(new Map([["PRYMY", { symbol: "PRYMY", price: 30, name: "Prysmian" } as any]]));
    const { body } = await call("/quotes", { query: { symbols: "PRYMY" } });
    expect(stooq.quote).not.toHaveBeenCalled();
    expect(body).toEqual([expect.objectContaining({ symbol: "PRYMY", price: 30, name: "Prysmian", source: "fmp", marketCap: null })]);
  });

  it("falls back to Stooq for a US OTC name without FMP", async () => {
    vi.mocked(stooq.quote).mockResolvedValue(quote("IESVF", 25, "stooq"));
    const { body } = await call("/quotes", { query: { symbols: "IESVF" } });
    expect(fmp.quotes).not.toHaveBeenCalled();
    expect(body).toEqual([expect.objectContaining({ symbol: "IESVF", price: 25, source: "stooq" })]);
  });

  it("makes no provider call for foreign symbols and leaves them out", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    vi.mocked(alpaca.isConfigured).mockReturnValue(true);
    vi.mocked(alpaca.snapshots).mockResolvedValue({ FRGN: snap(200, 190) });
    const { body } = await call("/quotes", { query: { symbols: "FRGN,0700.HK,SHOP.TO,2330.TW,SAP.DE" } });
    expect(body.map((q: { symbol: string }) => q.symbol)).toEqual(["FRGN"]);
    expect(alpaca.snapshots).toHaveBeenCalledWith(["FRGN"]);
    expect(fmp.quotes).not.toHaveBeenCalledWith(expect.arrayContaining(["0700.HK"]));
    expect(stooq.quote).not.toHaveBeenCalled();

    const only = await call("/quotes", { query: { symbols: "7203.T,BHP.AX" } });
    expect(only.body).toEqual([]);
    expect(stooq.quote).not.toHaveBeenCalled();
    expect(alpaca.snapshots).toHaveBeenCalledTimes(1);
  });

  it("stops asking for a symbol no source answers for 10 minutes, then tries again", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    vi.mocked(stooq.quote).mockRejectedValue(new Error("stooq timeout"));
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      expect((await call("/quotes", { query: { symbols: "NOPEY" } })).body).toHaveProperty("error");
      await call("/quotes", { query: { symbols: "NOPEY" } });
      expect(fmp.quotes).toHaveBeenCalledTimes(1);
      expect(stooq.quote).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(t0 + 10 * 60_000 + 1);
      await call("/quotes", { query: { symbols: "NOPEY" } });
      expect(stooq.quote).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("falls through Alpaca to Stooq for a US stock Alpaca doesn't answer", async () => {
    vi.mocked(alpaca.isConfigured).mockReturnValue(false);
    vi.mocked(stooq.quote).mockResolvedValue(quote("MSFT", 400, "stooq"));
    const { body } = await call("/quotes", { query: { symbols: "MSFT" } });
    expect(alpaca.snapshots).not.toHaveBeenCalled();
    expect(body).toEqual([expect.objectContaining({ symbol: "MSFT", price: 400 })]);
  });
});

describe("history routing", () => {
  const candles = [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 }];

  it("sends crypto to Alpaca crypto bars", async () => {
    vi.mocked(crypto.history).mockResolvedValue(candles);
    const { body } = await call("/history/:symbol", { params: { symbol: "ETH-USD" }, query: { range: "1M" } });
    expect(crypto.history).toHaveBeenCalledWith("ETH-USD", "1M");
    expect(body).toEqual(candles);
  });

  it("uses FMP for a US OTC name when keyed, Stooq without", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    vi.mocked(fmp.historical).mockResolvedValue(candles);
    expect((await call("/history/:symbol", { params: { symbol: "PRYMY" }, query: { range: "1Y" } })).body).toEqual(candles);
    expect(fmp.historical).toHaveBeenCalledWith("PRYMY", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));

    vi.mocked(fmp.isConfigured).mockReturnValue(false);
    vi.mocked(stooq.history).mockResolvedValue(candles);
    expect((await call("/history/:symbol", { params: { symbol: "FANUY" }, query: { range: "1Y" } })).body).toEqual(candles);
    expect(stooq.history).toHaveBeenCalledWith("FANUY");
  });

  it("answers 400 for a foreign symbol without asking any provider", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    vi.mocked(alpaca.isConfigured).mockReturnValue(true);
    vi.mocked(fmp.historical).mockClear();
    vi.mocked(stooq.history).mockClear();
    for (const symbol of ["7203.T", "SAP.DE", "0700.HK"]) {
      const res = await call("/history/:symbol", { params: { symbol }, query: { range: "1M" } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "US-listed symbols only" });
    }
    expect(fmp.historical).not.toHaveBeenCalled();
    expect(stooq.history).not.toHaveBeenCalled();
  });
});

describe("features that need FMP_API_KEY", () => {
  it("answers 503 with the feature when the key is unset", async () => {
    const cal = await call("/calendar", { query: { symbols: "AAPL" } });
    expect(cal.statusCode).toBe(503);
    expect(cal.body).toEqual({ error: "needs FMP_API_KEY", feature: "/calendar" });
    const hist = await call("/earnings-history/:symbol", { params: { symbol: "AAPL" } });
    expect(hist.statusCode).toBe(503);
    expect(hist.body).toEqual({ error: "needs FMP_API_KEY", feature: "/earnings-history/AAPL" });
    expect(fmp.earningsInfo).not.toHaveBeenCalled();
  });

  it("adds the day-after move to reported quarters and skips the upcoming row", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    const d = (n: number) => Date.UTC(2026, 7, n) / 1000;
    const bar = (n: number, close: number) => ({ time: d(n), open: close, high: close, low: close, close, volume: 0 });
    vi.mocked(alpaca.isConfigured).mockReturnValue(true);
    vi.mocked((await import("../live/history.js")).alpacaHistory).mockResolvedValue([bar(20, 100), bar(26, 100), bar(27, 110)]);
    const row = { fiscalQtrEnd: "", surprisePercent: null, revenue: null, revenueEstimate: null };
    vi.mocked(fmp.earnings).mockResolvedValue([
      { ...row, upcoming: true, dateReported: d(27), eps: null, consensusForecast: 2.49 },
      { ...row, fiscalQtrEnd: "2026-07-26", fiscalPeriod: "Q2 FY2027", dateReported: d(26), eps: 1.1, consensusForecast: 1 },
    ]);
    const { body } = await call("/earnings-history/:symbol", { params: { symbol: "FISC" } });
    expect(body).toEqual([
      expect.objectContaining({ upcoming: true, dayAfterChangePercent: null }),
      expect.objectContaining({ fiscalPeriod: "Q2 FY2027", dayAfterChangePercent: expect.closeTo(10) }),
    ]);
  });

  it("serves the earnings calendar from FMP when keyed", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    const rows = [{ symbol: "NVDA", nextEarningsDate: 1, lastEarningsDate: 0, epsForecast: 1.2 }];
    vi.mocked(fmp.earningsInfo).mockResolvedValue(rows);
    const { statusCode, body } = await call("/calendar", { query: { symbols: "NVDA" } });
    expect(statusCode).toBe(200);
    expect(body).toEqual(rows);
  });
});

describe("news", () => {
  const item = { id: 1, headline: "Chip news", summary: "", url: "https://example.com/a", source: "benzinga", author: "", symbols: ["NVDA"], createdAt: "2026-10-20T12:00:00Z", updatedAt: "" };

  it("serves per-symbol and market headlines from Alpaca News", async () => {
    vi.mocked(news.symbolNews).mockResolvedValue([item]);
    vi.mocked(news.marketNews).mockResolvedValue([{ ...item, headline: "Market news" }]);
    const one = await call("/news", { query: { symbol: "nvda" } });
    expect(news.symbolNews).toHaveBeenCalledWith("NVDA", 40);
    expect(one.body).toEqual([{ title: "Chip news", link: "https://example.com/a", publisher: "Benzinga", publishedAt: "2026-10-20T12:00:00.000Z", symbol: "NVDA" }]);
    const top = await call("/news");
    expect(top.body).toEqual([expect.objectContaining({ title: "Market news", symbol: null })]);
  });

  it("answers 503 without Alpaca keys", async () => {
    vi.mocked(alpaca.isConfigured).mockReturnValue(false);
    const { statusCode, body } = await call("/news", { query: { symbol: "AMD" } });
    expect(statusCode).toBe(503);
    expect(body).toEqual({ error: "needs Alpaca API keys", feature: "/news" });
  });
});

describe("options, search and the economic calendar", () => {
  it("passes the expiry to the Alpaca chain", async () => {
    const chain = { symbol: "AAPL", underlyingPrice: 1, expirationDates: ["2026-11-20"], selectedDate: "2026-11-20", calls: [], puts: [] };
    vi.mocked(options.chain).mockResolvedValue(chain);
    const { body } = await call("/options/:symbol", { params: { symbol: "aapl" }, query: { expiry: "2026-11-20" } });
    expect(options.chain).toHaveBeenCalledWith("AAPL", { expiry: "2026-11-20" });
    expect(body).toEqual(chain);
  });

  it("searches the listings", async () => {
    const hits = [{ symbol: "AAPL", name: "Apple Inc. - Common Stock", exchange: "Nasdaq", type: "stock" }];
    vi.mocked(assets.search).mockResolvedValue(hits);
    expect((await call("/search", { query: { q: "Apple" } })).body).toEqual(hits);
    expect(assets.search).toHaveBeenCalledWith("Apple");
    expect((await call("/search", { query: { q: " " } })).body).toEqual([]);
  });

  it("fills the official schedule with FMP's numbers when keyed", async () => {
    const cpi = { title: "Consumer Price Index", country: "USD", date: "2026-11-10T13:30:00.000Z", impact: "High" as const, forecast: null, previous: null, actual: null };
    const minutes = { ...cpi, title: "FOMC Minutes", date: "2026-11-18T19:00:00.000Z", impact: "Medium" as const };
    vi.mocked(calendars.econEvents).mockResolvedValue([cpi, minutes]);
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    vi.mocked(fmp.economicCalendar).mockResolvedValue([
      { title: "Inflation Rate YoY", country: "US", date: "2026-11-10T13:30:00.000Z", impact: "High", forecast: "2.9%", previous: "3.0%", actual: null, currency: "USD" },
      { title: "Inflation Rate YoY", country: "EU", date: "2026-11-10T10:00:00.000Z", impact: "High", forecast: "2.0%", previous: "2.1%", actual: null, currency: "EUR" },
    ]);
    const { body } = await call("/econ-calendar");
    const [from, to] = vi.mocked(calendars.econEvents).mock.calls[0];
    expect(Date.parse(to) - Date.parse(from)).toBe(14 * 86_400_000);
    expect(body).toEqual([{ ...cpi, title: "Consumer Price Index: Inflation Rate YoY", forecast: "2.9%", previous: "3.0%" }, minutes]);
  });
});

describe("Europe and crypto order books", () => {
  it("answers market=eu with an empty list and the reason", async () => {
    for (const path of ["/heatmap", "/screener", "/sectors"]) {
      const res = await call(path, { query: { market: "eu" } });
      expect(res.body).toEqual([]);
      expect(res.headers["X-Market-Note"]).toMatch(/TradingView/);
    }
  });

  it("rejects a symbol outside the supported crypto list with 400, before touching any provider", async () => {
    const res = await call("/crypto/orderbook/:symbol", { params: { symbol: "AAA&limit=5000" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "unsupported crypto symbol" });
    expect(crypto.orderBook).not.toHaveBeenCalled();
  });

  it("serves a supported pair (case-insensitive) from Alpaca", async () => {
    vi.mocked(crypto.orderBook).mockResolvedValue({ bids: [["1", "2"]], asks: [] });
    const res = await call("/crypto/orderbook/:symbol", { params: { symbol: "btc" } });
    expect(crypto.orderBook).toHaveBeenCalledWith("BTC");
    expect(res.body).toEqual({ bids: [["1", "2"]], asks: [] });
  });
});
