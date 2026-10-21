import type { Request, Response } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "../providers/types.js";

// GET /quotes with the live feed on: prices come from the (mocked) feed, and
// name and fundamentals from FMP (or the listings + SEC without a key) in the
// background. Every source is mocked; nothing here reaches the network or the
// database.

vi.mock("../live/feed.js", () => ({
  enabled: () => true,
  focusOn: vi.fn(async () => {}),
  liveQuote: (_alpaca: string, symbol: string) => ({ symbol, name: null, price: 100, change: 1, source: "alpaca", live: true }),
}));
vi.mock("../live/history.js", () => ({ alpacaHistory: vi.fn() }));
vi.mock("../history/universe.js", () => ({ alpacaSymbol: (s: string) => s, isForeignSymbol: () => false, sp500: vi.fn(), nasdaq100: vi.fn() }));
vi.mock("../providers/fmp.js", async (orig) => ({ ...(await orig<object>()), isConfigured: vi.fn(), quotes: vi.fn(), profiles: vi.fn(), ratiosTtm: vi.fn() }));
vi.mock("../providers/alpaca-assets.js", () => ({ allAssets: vi.fn(), search: vi.fn() }));
vi.mock("../providers/sec-reference.js", () => ({ reference: vi.fn() }));
vi.mock("../providers/stooq.js", async (orig) => ({ ...(await orig<object>()), quote: vi.fn() }));

const { marketRouter } = await import("./market.js");
const fmp = await import("../providers/fmp.js");
const assets = await import("../providers/alpaca-assets.js");
const sec = await import("../providers/sec-reference.js");
const stooq = await import("../providers/stooq.js");

const fmpQuotes = vi.mocked(fmp.quotes);
const fmpProfiles = vi.mocked(fmp.profiles);
const fmpRatios = vi.mocked(fmp.ratiosTtm);

function fmpProfile(symbol: string, name: string): fmp.Profile {
  return { symbol, name, price: 99, marketCap: 99_000, exchange: null, week52High: 120, week52Low: 80, avgVolume: 5_000 } as fmp.Profile;
}

/** GET /quotes?symbols=…, answered by the route's handler. */
async function getQuotes(symbols: string[]): Promise<Quote[]> {
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
  // FMP is keyed and fails unless a test says otherwise.
  vi.mocked(fmp.isConfigured).mockReset().mockReturnValue(true);
  fmpQuotes.mockReset().mockRejectedValue(new Error("fmp 429"));
  fmpProfiles.mockReset().mockRejectedValue(new Error("fmp 429"));
  fmpRatios.mockReset().mockRejectedValue(new Error("fmp 429"));
  vi.mocked(assets.allAssets).mockReset().mockResolvedValue([]);
  vi.mocked(sec.reference).mockReset().mockResolvedValue(new Map());
  vi.mocked(stooq.quote).mockReset().mockRejectedValue(new Error("stooq down"));
});

describe("static fields of live quotes", () => {
  it("backs off a ticker every source fails for: 5 minutes, then 10", async () => {
    await getQuotes(["FAIL1"]);
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await getQuotes(["FAIL1"]);
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000); // 5 minutes after the failure
    await getQuotes(["FAIL1"]);
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await getQuotes(["FAIL1"]);
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000); // 10 minutes after the second failure
    await getQuotes(["FAIL1"]);
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(3);
  });

  it("backs off a ticker the sources return nothing for", async () => {
    fmpProfiles.mockResolvedValue(new Map());
    fmpRatios.mockResolvedValue(new Map());
    const [q] = await getQuotes(["EMPTY1"]);
    expect(q).toMatchObject({ symbol: "EMPTY1", price: 100, source: "alpaca" });
    await settle();
    await getQuotes(["EMPTY1"]);
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(1);
  });

  it("asks for the stale tickers of one request in one batch, and once while it's out", async () => {
    let answer!: (quotes: Map<string, fmp.Profile>) => void;
    fmpProfiles.mockReturnValue(new Promise((r) => (answer = r)));
    fmpRatios.mockResolvedValue(new Map(["B1", "B2", "B3"].map((s) => [s, { symbol: s, pe: 20, eps: 5, dividendYield: 0.01 }])));

    // The quote doesn't wait for the fields.
    const first = await getQuotes(["B1", "B2", "B3"]);
    expect(first.map((q) => [q.symbol, q.name])).toEqual([["B1", null], ["B2", null], ["B3", null]]);
    await getQuotes(["B1", "B2", "B3"]); // an overlapping poll
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(1);
    expect(fmpProfiles).toHaveBeenCalledWith(["B1", "B2", "B3"]);

    expect(fmpRatios).toHaveBeenCalledWith(["B1", "B2", "B3"]);

    answer(new Map([["B1", fmpProfile("B1", "One")], ["B2", fmpProfile("B2", "Two")], ["B3", fmpProfile("B3", "Three")]]));
    await settle();
    const next = await getQuotes(["B1", "B2", "B3"]);
    expect(next.map((q) => [q.name, q.price, q.pe])).toEqual([["One", 100, 20], ["Two", 100, 20], ["Three", 100, 20]]);
    // Shares come from the profile (99,000 / 99), so market cap follows the live price.
    expect(next[0]).toMatchObject({ eps: 5, dividendYield: 0.01, week52High: 120, week52Low: 80, avgVolume: 5_000, sharesOutstanding: 1_000, marketCap: 100_000 });
    expect(fmpProfiles).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good fields while a refresh is failing", async () => {
    fmpProfiles.mockResolvedValue(new Map([["KEEP1", fmpProfile("KEEP1", "Keep Corp")]]));
    fmpRatios.mockResolvedValue(new Map());
    await getQuotes(["KEEP1"]);
    await settle();

    await vi.advanceTimersByTimeAsync(3_600_000 + 1); // the hourly refresh is due
    fmpProfiles.mockReset().mockRejectedValue(new Error("fmp 429"));
    fmpRatios.mockReset().mockRejectedValue(new Error("fmp 429"));
    await getQuotes(["KEEP1"]);
    await settle();
    expect(fmpProfiles).toHaveBeenCalledTimes(1);
    const [q] = await getQuotes(["KEEP1"]);
    await settle();
    expect(q).toMatchObject({ name: "Keep Corp", price: 100 });
    expect(fmpProfiles).toHaveBeenCalledTimes(1); // backing off, not asking again
  });

  it("without FMP, takes the name from the listings and market cap from SEC shares × the live price", async () => {
    vi.mocked(fmp.isConfigured).mockReturnValue(false);
    vi.mocked(assets.allAssets).mockResolvedValue([{ symbol: "SECCO", name: "Sec Co. - Common Stock", exchange: "Nasdaq", type: "stock" }]);
    vi.mocked(sec.reference).mockResolvedValue(new Map([["SECCO", { symbol: "SECCO", name: "SEC CO", sharesOutstanding: 1_000 } as any]]));
    await getQuotes(["SECCO"]);
    await settle();
    const [q] = await getQuotes(["SECCO"]);
    expect(q).toMatchObject({ name: "Sec Co.", exchange: "Nasdaq", sharesOutstanding: 1_000, marketCap: 100_000 });
    expect(fmpProfiles).not.toHaveBeenCalled();
  });
});
