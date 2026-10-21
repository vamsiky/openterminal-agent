import { afterEach, describe, expect, it, vi } from "vitest";
import { quotes } from "./yahoo.js";

const res = (body: unknown, extra: Partial<{ cookie: string; text: string }> = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers(extra.cookie ? { "set-cookie": extra.cookie } : {}),
  json: async () => body,
  text: async () => extra.text ?? "",
});

/** Serves the cookie, the crumb, then the quote payload. */
function mockYahoo(rows: unknown[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("https://fc.yahoo.com")) return res({}, { cookie: "A3=abc; Path=/" });
    if (url.includes("getcrumb")) return res({}, { text: "crumb123" });
    return res({ quoteResponse: { result: rows } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("yahoo quotes extended hours", () => {
  it("maps post- and pre-market fields into extended", async () => {
    const fetchMock = mockYahoo([
      {
        symbol: "AAPL",
        regularMarketPrice: 200,
        regularMarketTime: 1000,
        postMarketPrice: 201,
        postMarketChange: 1,
        postMarketChangePercent: 0.5,
        postMarketTime: 1500,
        preMarketPrice: 199,
        preMarketChange: -1,
        preMarketChangePercent: -0.5,
        preMarketTime: 2000,
      },
    ]);
    const [q] = await quotes(["AAPL"]);
    expect(q.extended?.post).toEqual({ price: 201, change: 1, changePercent: 0.5, time: new Date(1500_000).toISOString(), live: false });
    expect(q.extended?.pre).toMatchObject({ price: 199, change: -1, changePercent: -0.5, live: false });
    expect(q.extended?.overnight).toBeNull();
    const quoteUrl = fetchMock.mock.calls.map((c) => c[0]).find((u) => u.includes("/v7/finance/quote"))!;
    expect(quoteUrl).toContain("symbols=AAPL");
    expect(quoteUrl).toContain("crumb=crumb123");
  });

  it("drops a stale session, and one missing its price or time", async () => {
    mockYahoo([
      { symbol: "A", regularMarketTime: 1000, postMarketPrice: 5, postMarketTime: 1000, preMarketPrice: 4, preMarketTime: 900 },
      { symbol: "B", regularMarketTime: 1000, postMarketPrice: 5, preMarketTime: 2000 },
    ]);
    const [a, b] = await quotes(["A", "B"]);
    expect(a.extended).toEqual({ post: null, overnight: null, pre: null });
    expect(b.extended).toEqual({ post: null, overnight: null, pre: null });
  });
});
