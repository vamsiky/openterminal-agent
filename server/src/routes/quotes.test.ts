import type { Request, Response } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// GET /quotes with the live feed on: prices come from the (mocked) feed, and
// name and fundamentals from the web sources in the background. Every web
// source is mocked; nothing here reaches the network or the database.

vi.mock("../live/feed.js", () => ({
  enabled: () => true,
  focusOn: vi.fn(async () => {}),
  liveQuote: (_alpaca: string, symbol: string) => ({ symbol, name: null, price: 100, change: 1, source: "alpaca", live: true }),
}));
vi.mock("../live/history.js", () => ({ alpacaHistory: vi.fn() }));
vi.mock("../history/universe.js", () => ({ alpacaSymbol: (s: string) => s }));
vi.mock("../providers/nasdaq.js", async (orig) => ({ ...(await orig<object>()), quote: vi.fn() }));
vi.mock("../providers/yahoo.js", async (orig) => ({ ...(await orig<object>()), quotes: vi.fn(), quoteFromChart: vi.fn() }));
vi.mock("../providers/stooq.js", async (orig) => ({ ...(await orig<object>()), quote: vi.fn() }));
vi.mock("../providers/tradingview.js", async (orig) => ({ ...(await orig<object>()), scanFundamentals: vi.fn() }));

const { marketRouter } = await import("./market.js");
const nasdaq = await import("../providers/nasdaq.js");
const yahoo = await import("../providers/yahoo.js");
const stooq = await import("../providers/stooq.js");
const { staleSet } = await import("../cache.js");

const yahooQuotes = vi.mocked(yahoo.quotes);

function webQuote(symbol: string, name: string): yahoo.Quote {
  return { symbol, name, price: 99, exchange: null, pe: 20 } as yahoo.Quote;
}

/** GET /quotes?symbols=…, answered by the route's handler. */
async function getQuotes(symbols: string[]): Promise<yahoo.Quote[]> {
  const layer = (marketRouter as any).stack.find((l: any) => l.route?.path === "/quotes");
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await layer.route.stack[0].handle({ query: { symbols: symbols.join(",") }, path: "/quotes" } as unknown as Request, res as unknown as Response, () => {});
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0];
}

/** Let the background refresh finish. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("no network in tests"))));
  vi.useFakeTimers({ now: new Date("2026-10-16T15:00:00Z"), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // Every source fails unless a test says otherwise.
  vi.mocked(nasdaq.quote).mockReset().mockRejectedValue(new Error("nasdaq down"));
  yahooQuotes.mockReset().mockRejectedValue(new Error("yahoo 429"));
  vi.mocked(yahoo.quoteFromChart).mockReset().mockRejectedValue(new Error("yahoo 429"));
  vi.mocked(stooq.quote).mockReset().mockRejectedValue(new Error("stooq down"));
});

describe("static fields of live quotes", () => {
  it("backs off a ticker every web source fails for: 5 minutes, then 10", async () => {
    await getQuotes(["FAIL1"]);
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await getQuotes(["FAIL1"]);
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000); // 5 minutes after the failure
    await getQuotes(["FAIL1"]);
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await getQuotes(["FAIL1"]);
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000); // 10 minutes after the second failure
    await getQuotes(["FAIL1"]);
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(3);
  });

  it("backs off a ticker the web sources return nothing for", async () => {
    yahooQuotes.mockResolvedValue([]);
    const [q] = await getQuotes(["EMPTY1"]);
    expect(q).toMatchObject({ symbol: "EMPTY1", price: 100, source: "alpaca" });
    await settle();
    await getQuotes(["EMPTY1"]);
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(1);
  });

  it("asks for the stale tickers of one request in one batch, and once while it's out", async () => {
    let answer!: (quotes: yahoo.Quote[]) => void;
    yahooQuotes.mockReturnValue(new Promise((r) => (answer = r)));

    // The quote doesn't wait for the fields.
    const first = await getQuotes(["B1", "B2", "B3"]);
    expect(first.map((q) => [q.symbol, q.name])).toEqual([["B1", null], ["B2", null], ["B3", null]]);
    await getQuotes(["B1", "B2", "B3"]); // an overlapping poll
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(1);
    expect(yahooQuotes).toHaveBeenCalledWith(["B1", "B2", "B3"]);

    answer([webQuote("B1", "One"), webQuote("B2", "Two"), webQuote("B3", "Three")]);
    await settle();
    const next = await getQuotes(["B1", "B2", "B3"]);
    expect(next.map((q) => [q.name, q.price, q.pe])).toEqual([["One", 100, 20], ["Two", 100, 20], ["Three", 100, 20]]);
    expect(yahooQuotes).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good fields while a refresh is failing", async () => {
    yahooQuotes.mockResolvedValue([webQuote("KEEP1", "Keep Corp")]);
    await getQuotes(["KEEP1"]);
    await settle();

    await vi.advanceTimersByTimeAsync(3_600_000 + 1); // the hourly refresh is due
    // Push KEEP1's last-known quote out of the stale cache, so the refresh really fails.
    for (let i = 0; i < 1_000; i++) staleSet(`filler:${i}`, null);
    yahooQuotes.mockReset().mockRejectedValue(new Error("yahoo 429"));
    await getQuotes(["KEEP1"]);
    await settle();
    expect(yahooQuotes).toHaveBeenCalledTimes(1);
    const [q] = await getQuotes(["KEEP1"]);
    await settle();
    expect(q).toMatchObject({ name: "Keep Corp", price: 100 });
    expect(yahooQuotes).toHaveBeenCalledTimes(1); // backing off, not asking again
  });
});
