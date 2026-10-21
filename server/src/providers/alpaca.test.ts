import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxRequestsPerMinute, openStream, parseStream, resetThrottle, snapshots, stockBars, stockBarsPage } from "./alpaca.js";

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

describe("alpaca snapshots", () => {
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
    delete process.env.ALPACA_FEED;
  });

  it("returns {} for no symbols without calling out", async () => {
    const fetchMock = mockPages([]);
    expect(await snapshots([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the symbols on the sip feed, or the one given", async () => {
    const fetchMock = mockPages([{ A: null }, {}]);
    await snapshots(["A", "B"]);
    await snapshots(["A"], "boats");
    expect(fetchMock.mock.calls[0][0]).toBe("https://data.alpaca.markets/v2/stocks/snapshots?symbols=A%2CB&feed=sip");
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("feed")).toBe("boats");
  });

  it("defaults to ALPACA_FEED", async () => {
    process.env.ALPACA_FEED = "iex";
    const fetchMock = mockPages([{}]);
    await snapshots(["A"]);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("feed")).toBe("iex");
  });

  it("treats a null body as no snapshots", async () => {
    mockPages([null]);
    expect(await snapshots(["A"])).toEqual({});
  });
});

describe("alpaca stream", () => {
  class FakeSocket extends EventTarget {
    static all: FakeSocket[] = [];
    sent: any[] = [];
    constructor(public url: string) {
      super();
      FakeSocket.all.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    receive(msgs: unknown) {
      this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(msgs) }));
    }
  }
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    process.env.ALPACA_API_KEY_ID = "kid";
    process.env.ALPACA_API_SECRET_KEY = "secret";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
    delete process.env.ALPACA_FEED;
  });

  it("opens the sip path by default and the given path otherwise", () => {
    openStream();
    openStream("v1beta1/boats");
    expect(FakeSocket.all.map((s) => s.url)).toEqual([
      "wss://stream.data.alpaca.markets/v2/sip",
      "wss://stream.data.alpaca.markets/v1beta1/boats",
    ]);
  });

  it("authenticates only after Alpaca says connected", () => {
    openStream();
    const ws = FakeSocket.all[0];
    expect(ws.sent).toEqual([]);
    ws.receive([{ T: "t", S: "AAPL" }]);
    expect(ws.sent).toEqual([]);
    ws.receive([{ T: "success", msg: "connected" }]);
    expect(ws.sent).toEqual([{ action: "auth", key: "kid", secret: "secret" }]);
  });

  it("throws without keys", () => {
    delete process.env.ALPACA_API_KEY_ID;
    expect(() => openStream()).toThrow(/ALPACA_API_KEY_ID/);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("parses arrays, single objects and buffers; bad JSON gives []", () => {
    expect(parseStream('[{"T":"t"},{"T":"q"}]')).toEqual([{ T: "t" }, { T: "q" }]);
    expect(parseStream('{"T":"error","code":406}')).toEqual([{ T: "error", code: 406 }]);
    const bytes = new TextEncoder().encode('[{"T":"b"}]');
    expect(parseStream(bytes.buffer)).toEqual([{ T: "b" }]);
    expect(parseStream("not json")).toEqual([]);
  });
});
