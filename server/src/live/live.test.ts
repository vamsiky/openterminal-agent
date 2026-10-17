import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// store.ts opens real sqlite files under DATA_DIR at import time.
let tmpDir: string;
let feed: typeof import("./feed.js");
let history: typeof import("./history.js");
let store: typeof import("../history/store.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-live-test-"));
  process.env.DATA_DIR = tmpDir;
  feed = await import("./feed.js");
  history = await import("./history.js");
  store = await import("../history/store.js");
});

afterAll(() => {
  store.minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => feed.resetLiveFeed());

const bar = (t: string, o: number, h: number, l: number, c: number, v = 1000) => ({ t, o, h, l, c, v });

describe("live feed", () => {
  it("builds a quote from a snapshot, then moves with each trade", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T15:00:00Z") });
    feed.applySnapshot("NVDA", {
      latestTrade: { t: "2026-10-16T14:59:59Z", p: 180, s: 100 },
      latestQuote: { t: "2026-10-16T14:59:59Z", bp: 179.99, ap: 180.01, bs: 2, as: 3 },
      dailyBar: bar("2026-10-16T04:00:00Z", 176, 181, 175, 180, 5e6),
      prevDailyBar: bar("2026-10-15T04:00:00Z", 170, 177, 169, 175),
    });
    expect(feed.liveQuote("NVDA")).toMatchObject({ price: 180, previousClose: 175, change: 5, open: 176, high: 181, bid: 179.99, source: "alpaca" });

    feed.applyMessage({ T: "t", S: "NVDA", p: 182, s: 10, t: "2026-10-16T15:00:01Z", c: ["@"] });
    feed.applyMessage({ T: "t", S: "NVDA", p: 150, s: 5, t: "2026-10-16T15:00:02Z", c: ["@", "I"] }); // odd lot: ignored
    feed.applyMessage({ T: "t", S: "NVDA", p: 170, s: 5, t: "2026-10-16T15:00:00Z", c: ["@"] }); // older: ignored
    const q = feed.liveQuote("NVDA", "NVDA")!;
    expect(q.price).toBe(182);
    expect(q.high).toBe(182);
    expect(q.asOf).toBe("2026-10-16T15:00:01Z");
    vi.useRealTimers();
  });

  it("uses yesterday's close as the previous close before the open", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z") }); // 08:00 New York
    feed.applySnapshot("AMD", {
      latestTrade: { t: "2026-10-16T11:59:00Z", p: 101, s: 10 },
      dailyBar: bar("2026-10-15T04:00:00Z", 95, 100, 94, 99),
      prevDailyBar: bar("2026-10-14T04:00:00Z", 90, 96, 89, 95),
    });
    expect(feed.liveQuote("AMD")).toMatchObject({ price: 101, previousClose: 99, change: 2 });
    vi.useRealTimers();
  });

  it("rolls the previous close over when a new session's day bar arrives", () => {
    feed.applyMessage({ T: "d", S: "SPY", ...bar("2026-10-15T04:00:00Z", 500, 505, 498, 503) });
    feed.applyMessage({ T: "d", S: "SPY", ...bar("2026-10-16T04:00:00Z", 504, 506, 503, 505) });
    expect(feed.liveQuote("SPY")).toMatchObject({ previousClose: 503, open: 504, price: 505 });
  });

  it("returns null for tickers it knows nothing about, and maps the requested symbol", () => {
    expect(feed.liveQuote("NOPE")).toBeNull();
    feed.applyMessage({ T: "d", S: "BRK.B", ...bar("2026-10-16T04:00:00Z", 480, 485, 479, 484) });
    expect(feed.liveQuote("BRK.B", "BRK-B")?.symbol).toBe("BRK-B");
  });
});

describe("alpaca candles", () => {
  it("serves daily ranges from stored bars and ends with today's live bar", async () => {
    store.upsertDailyBars([
      { symbol: "QQQ", day: "2026-10-14", open: 1, high: 2, low: 1, close: 2, volume: 10, vwap: null, trades: null },
      { symbol: "QQQ", day: "2026-10-15", open: 2, high: 3, low: 2, close: 3, volume: 10, vwap: null, trades: null },
    ]);
    feed.applyMessage({ T: "d", S: "QQQ", ...bar("2026-10-16T04:00:00Z", 3, 5, 3, 4.5) });
    const candles = await history.alpacaHistory("QQQ", "6M", new Date("2026-10-16T18:00:00Z"));
    expect(candles?.map((c) => c.close)).toEqual([2, 3, 4.5]);
    expect(candles?.at(-1)?.time).toBe(Date.parse("2026-10-16T00:00:00Z") / 1000);
  });

  it("returns null when nothing is stored, so the web sources are used", async () => {
    expect(await history.alpacaHistory("ZZZZ", "1Y")).toBeNull();
  });

  it("groups daily candles into weeks and months", () => {
    const d = (day: string, c: number) => ({ time: Date.parse(`${day}T00:00:00Z`) / 1000, open: c, high: c, low: c, close: c, volume: 1 });
    const weeks = history.aggregate([d("2026-10-12", 1), d("2026-10-14", 3), d("2026-10-19", 2)], "week");
    expect(weeks.map((w) => [w.open, w.close, w.high, w.volume])).toEqual([[1, 3, 3, 2], [2, 2, 2, 1]]);
    expect(history.aggregate([d("2026-09-30", 1), d("2026-10-01", 2)], "month")).toHaveLength(2);
  });
});

describe("live stream", () => {
  it("authenticates, subscribes to bars for everything and trades for focused tickers", async () => {
    process.env.ALPACA_API_KEY_ID = "kid";
    process.env.ALPACA_API_SECRET_KEY = "secret";
    const sockets: FakeSocket[] = [];
    class FakeSocket extends EventTarget {
      sent: any[] = [];
      constructor(public url: string) {
        super();
        sockets.push(this);
      }
      send(data: string) {
        this.sent.push(JSON.parse(data));
      }
      receive(msgs: unknown[]) {
        this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(msgs) }));
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), headers: new Headers() }));

    feed.startLiveFeed();
    const ws = sockets[0];
    expect(ws.url).toBe("wss://stream.data.alpaca.markets/v2/sip");
    ws.receive([{ T: "success", msg: "connected" }]);
    expect(ws.sent[0]).toEqual({ action: "auth", key: "kid", secret: "secret" });
    ws.receive([{ T: "success", msg: "authenticated" }]);
    expect(ws.sent[1]).toMatchObject({ action: "subscribe", bars: ["*"], dailyBars: ["*"] });
    expect(feed.status().connected).toBe(true);

    await feed.focusOn(["TSLA"]);
    await new Promise((r) => setTimeout(r, 250));
    const sub = ws.sent.find((m) => m.action === "subscribe" && m.trades?.includes("TSLA"));
    expect(sub).toMatchObject({ trades: expect.arrayContaining(["TSLA"]), quotes: expect.arrayContaining(["TSLA"]) });

    ws.receive([{ T: "t", S: "TSLA", p: 250, s: 1, t: "2026-10-16T15:00:00Z", c: ["@"] }]);
    expect(feed.liveQuote("TSLA")).toMatchObject({ price: 250, live: true });

    vi.unstubAllGlobals();
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
  });
});
