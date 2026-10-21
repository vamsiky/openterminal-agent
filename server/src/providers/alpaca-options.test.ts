import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetThrottle } from "./alpaca.js";
import { chain, expirations, optionSnapshots, parseOcc } from "./alpaca-options.js";

function route(handler: (u: URL) => unknown) {
  const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => handler(new URL(url)), headers: new Headers() }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const stockSnap = { NVDA: { latestTrade: { t: "t", p: 200, s: 1 }, dailyBar: { c: 199 } } };
const q = (bp: number, ap: number) => ({ bp, ap, bs: 1, as: 1, t: "t" });
const optSnaps = {
  NVDA261023C00195000: {
    latestTrade: { p: 21.7, s: 5, t: "t" }, latestQuote: q(20.5, 22.85), dailyBar: { v: 341 }, prevDailyBar: { c: 23.21 },
    impliedVolatility: 0.52, greeks: { delta: 0.8, gamma: 0.01, theta: -0.3, vega: 0.1, rho: 0.05 },
  },
  NVDA261023C00205000: { latestTrade: { p: 10, s: 1, t: "t" }, latestQuote: q(9.5, 10.5), dailyBar: { v: 12 }, prevDailyBar: { c: 8 } },
  NVDA261023P00195000: { latestQuote: q(1, 1.2) },
  NVDA261030C00200000: { latestQuote: q(12, 13) },
};

describe("alpaca options", () => {
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

  it("parses OCC symbols", () => {
    expect(parseOcc("NVDA261102C00215000")).toEqual({ root: "NVDA", expiry: "2026-11-02", type: "call", strike: 215 });
    expect(parseOcc("SPY261120P00497500")).toEqual({ root: "SPY", expiry: "2026-11-20", type: "put", strike: 497.5 });
    expect(parseOcc("NVDA")).toBeNull();
  });

  it("collects expirations from every page, within a strike window", async () => {
    const fetchMock = route((u) => {
      if (u.pathname === "/v2/stocks/snapshots") return stockSnap;
      return u.searchParams.get("page_token")
        ? { snapshots: { NVDA261030C00200000: {} }, next_page_token: null }
        : { snapshots: { NVDA261023C00195000: {}, NVDA261023P00195000: {} }, next_page_token: "p2" };
    });
    expect(await expirations("nvda")).toEqual(["2026-10-23", "2026-10-30"]);
    const calls = fetchMock.mock.calls.map(([u]) => new URL(u));
    const opt = calls.filter((u) => u.pathname === "/v1beta1/options/snapshots/NVDA");
    expect(opt).toHaveLength(2);
    expect(opt[0].searchParams.get("feed")).toBe("opra");
    expect(opt[0].searchParams.get("strike_price_gte")).toBe("160");
    expect(opt[0].searchParams.get("strike_price_lte")).toBe("240");
  });

  it("builds the chain for the nearest expiry with greeks, IV and null open interest", async () => {
    const fetchMock = route((u) => {
      if (u.pathname === "/v2/stocks/snapshots") return stockSnap;
      const expiry = u.searchParams.get("expiration_date");
      const pick = Object.entries(optSnaps).filter(([k]) => !expiry || parseOcc(k)!.expiry === expiry);
      return { snapshots: Object.fromEntries(pick), next_page_token: null };
    });
    const c = await chain("NVDA");
    expect(c).toMatchObject({ symbol: "NVDA", underlyingPrice: 200, expirationDates: ["2026-10-23", "2026-10-30"], selectedDate: "2026-10-23" });
    expect(c.calls.map((r) => r.strike)).toEqual([195, 205]);
    expect(c.puts.map((r) => r.strike)).toEqual([195]);
    expect(c.calls[0]).toMatchObject({
      contract: "NVDA261023C00195000", lastPrice: 21.7, bid: 20.5, ask: 22.85, volume: 341, openInterest: null,
      impliedVolatility: 0.52, delta: 0.8, gamma: 0.01, theta: -0.3, vega: 0.1, rho: 0.05, inTheMoney: true,
    });
    expect(c.calls[0].change).toBeCloseTo(-1.51, 2);
    expect(c.calls[0].percentChange).toBeCloseTo(-6.5058, 3);
    expect(c.calls[1]).toMatchObject({ inTheMoney: false, impliedVolatility: null, delta: null, change: 2, percentChange: 25 });
    expect(c.puts[0]).toMatchObject({ inTheMoney: false, lastPrice: null, bid: 1, ask: 1.2, change: null, volume: null });
    // the chain request itself is filtered to the selected expiry
    const last = new URL(fetchMock.mock.calls.at(-1)![0] as string);
    expect(last.searchParams.get("expiration_date")).toBe("2026-10-23");
  });

  it("honours a requested expiry and falls back to the nearest for an unknown one", async () => {
    route((u) => {
      if (u.pathname === "/v2/stocks/snapshots") return stockSnap;
      const expiry = u.searchParams.get("expiration_date");
      const pick = Object.entries(optSnaps).filter(([k]) => !expiry || parseOcc(k)!.expiry === expiry);
      return { snapshots: Object.fromEntries(pick), next_page_token: null };
    });
    const later = await chain("NVDA", { expiry: "2026-10-30" });
    expect(later.selectedDate).toBe("2026-10-30");
    expect(later.calls.map((r) => r.contract)).toEqual(["NVDA261030C00200000"]);
    expect((await chain("NVDA", { expiry: "2030-01-01" })).selectedDate).toBe("2026-10-23");
  });

  it("returns an empty chain when the underlying has no options", async () => {
    route((u) => (u.pathname === "/v2/stocks/snapshots" ? stockSnap : { snapshots: {}, next_page_token: null }));
    expect(await chain("ZZZZ")).toMatchObject({ expirationDates: [], selectedDate: null, calls: [], puts: [] });
  });

  it("optionSnapshots passes the expiry range and strike band", async () => {
    const fetchMock = route(() => ({ snapshots: optSnaps, next_page_token: null }));
    const snaps = await optionSnapshots("nvda", { expiryMin: "2026-10-21", expiryMax: "2026-12-20", strikeMin: 170, strikeMax: 230 });
    expect(Object.keys(snaps)).toHaveLength(4);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1beta1/options/snapshots/NVDA");
    expect(url.searchParams.get("expiration_date_gte")).toBe("2026-10-21");
    expect(url.searchParams.get("expiration_date_lte")).toBe("2026-12-20");
    expect(url.searchParams.get("strike_price_gte")).toBe("170");
    expect(url.searchParams.get("feed")).toBe("opra");
  });
});
