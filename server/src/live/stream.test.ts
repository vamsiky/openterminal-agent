import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The live feed against fake Alpaca streams: subscriptions, live flags,
// first-click snapshots and reconnects. startLiveFeed runs once per module, so
// these tests share one feed and run in order.

let tmpDir: string;
let feed: typeof import("./feed.js");
let alpaca: typeof import("../providers/alpaca.js");
let store: typeof import("../history/store.js");

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
  receive(msgs: unknown[]) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(msgs) }));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  login() {
    this.receive([{ T: "success", msg: "connected" }]);
    this.receive([{ T: "success", msg: "authenticated" }]);
  }
}

const sockets = (path: string) => FakeSocket.all.filter((s) => s.url.endsWith(path));
const latest = (path: string) => sockets(path).at(-1)!;

// Snapshot responses by feed; a function lets a test fail one of them.
let snapshotBody: (feed: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
let snapshotDelayMs = 0;
const fetchMock = vi.fn(async (url: string) => {
  if (snapshotDelayMs > 0) await new Promise((r) => setTimeout(r, snapshotDelayMs));
  const { status, body } = snapshotBody(new URL(url).searchParams.get("feed") ?? "");
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() };
});

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-stream-test-"));
  vi.stubEnv("DATA_DIR", tmpDir);
  vi.stubEnv("ALPACA_API_KEY_ID", "kid");
  vi.stubEnv("ALPACA_API_SECRET_KEY", "secret");
  vi.stubEnv("ALPACA_FEED", "sip");
  vi.stubEnv("LIVE_STREAM", "1");
  vi.stubEnv("LIVE_OVERNIGHT", "1");
  vi.stubEnv("LIVE_ALL_TRADES", "0");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ now: new Date("2026-10-16T14:00:00Z"), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  feed = await import("./feed.js");
  alpaca = await import("../providers/alpaca.js");
  store = await import("../history/store.js");
  feed.startLiveFeed();
  await vi.advanceTimersByTimeAsync(0); // the start-up snapshot sweep
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  store.minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Let focusOn's snapshot requests through the request limiter. */
async function focus(symbols: string[]): Promise<void> {
  alpaca.resetThrottle();
  const done = feed.focusOn(symbols);
  await vi.advanceTimersByTimeAsync(1_000);
  await done;
}

describe("live stream", () => {
  it("connects to the consolidated tape and the overnight feed", () => {
    latest("v2/sip").login();
    latest("v1beta1/boats").login();
    expect(latest("v2/sip").sent[0]).toEqual({ action: "auth", key: "kid", secret: "secret" });
    expect(latest("v2/sip").sent[1]).toMatchObject({ action: "subscribe", bars: ["*"], updatedBars: ["*"], dailyBars: ["*"] });
    expect(latest("v1beta1/boats").sent[1]).toEqual({ action: "subscribe", bars: ["*"], updatedBars: ["*"] });
    expect(feed.status()).toMatchObject({ connected: true, overnight: { enabled: true, connected: true } });
  });

  it("subscribes a focused ticker's trades and quotes, and only its trades overnight", async () => {
    await focus(["TSLA"]);
    const sip = latest("v2/sip").sent.find((m) => m.action === "subscribe" && m.trades?.includes("TSLA"));
    const boats = latest("v1beta1/boats").sent.find((m) => m.action === "subscribe" && m.trades?.includes("TSLA"));
    expect(sip.quotes).toContain("TSLA");
    expect(boats.quotes).toEqual([]);
    expect(feed.isRealtime("TSLA")).toBe(true);
    expect(feed.overnightRealtime("TSLA")).toBe(true);
  });

  it("marks prices live only while their own session is on", () => {
    const sip = latest("v2/sip");
    sip.receive([{ T: "d", S: "TSLA", ...{ t: "2026-10-15T04:00:00Z", o: 240, h: 241, l: 239, c: 240, v: 1 } }]);
    sip.receive([{ T: "t", S: "TSLA", p: 250, s: 1, t: "2026-10-16T14:00:00Z", c: ["@"] }]);
    expect(feed.liveQuote("TSLA", "TSLA", new Date("2026-10-16T14:00:05Z"))).toMatchObject({ price: 250, live: true, marketState: "REGULAR" });

    sip.receive([{ T: "t", S: "TSLA", p: 252, s: 1, t: "2026-10-16T21:00:00Z", c: ["@", "T"] }]); // 17:00
    const post = feed.liveQuote("TSLA", "TSLA", new Date("2026-10-16T21:00:05Z"))!;
    expect(post).toMatchObject({ price: 250, live: false, marketState: "POST" });
    expect(post.extended.post).toMatchObject({ price: 252, live: true });

    // Once the session is over, its last price stays but isn't live.
    const sat = feed.liveQuote("TSLA", "TSLA", new Date("2026-10-17T15:00:00Z"))!;
    expect(sat).toMatchObject({ live: false, marketState: "CLOSED" });
    expect(sat.extended.post).toMatchObject({ price: 252, live: false });

    // A ticker nobody has open is never live.
    sip.receive([{ T: "d", S: "IBM", ...{ t: "2026-10-16T04:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1 } }]);
    expect(feed.liveQuote("IBM", "IBM", new Date("2026-10-16T14:00:05Z"))).toMatchObject({ live: false });
  });

  it("marks the overnight price live from the Blue Ocean trade feed", () => {
    latest("v1beta1/boats").receive([{ T: "t", S: "TSLA", p: 255, s: 1, t: "2026-10-19T01:00:00Z", c: ["@", "I"] }]); // Sun 21:00
    const q = feed.liveQuote("TSLA", "TSLA", new Date("2026-10-19T01:00:05Z"))!;
    expect(q).toMatchObject({ marketState: "OVERNIGHT", live: false });
    expect(q.extended.overnight).toMatchObject({ price: 255, live: true });
  });

  it("ignores minute bars in the extended sessions for tickers on the trade feed", () => {
    const before = feed.liveEntry("TSLA")!.post;
    latest("v2/sip").receive([{ T: "b", S: "TSLA", t: "2026-10-16T22:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    expect(feed.liveEntry("TSLA")!.post).toEqual(before);
  });
});

describe("first-click snapshots", () => {
  it("asks Alpaca once about a ticker it had nothing for, then again after ten minutes", async () => {
    fetchMock.mockClear();
    await focus(["NEWCO"]);
    const feeds = fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("feed"));
    expect(feeds.sort()).toEqual(["boats", "sip"]);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("symbols")).toBe("NEWCO");

    fetchMock.mockClear();
    await focus(["NEWCO"]);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    fetchMock.mockClear();
    await focus(["NEWCO"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the consolidated snapshot when the overnight one fails", async () => {
    snapshotBody = (f) =>
      f === "boats"
        ? { status: 403, body: { message: "forbidden" } }
        : { status: 200, body: { ABC: { dailyBar: { t: "2026-10-16T04:00:00Z", o: 9, h: 11, l: 9, c: 10, v: 5 }, latestTrade: { t: "2026-10-16T14:20:00Z", p: 10, s: 1 } } } };
    await focus(["ABC"]);
    expect(feed.liveQuote("ABC")).toMatchObject({ price: 10, source: "alpaca" });
  });

  it("backs off for ten minutes when the snapshot request fails", async () => {
    snapshotBody = () => ({ status: 500, body: { message: "boom" } });
    fetchMock.mockClear();
    await focus(["DOWN1", "DOWN2"]);
    expect(feed.status().lastError).toMatch(/^snapshot: alpaca 500/);
    fetchMock.mockClear();
    await focus(["DOWN2"]);
    expect(fetchMock).not.toHaveBeenCalled();
    snapshotBody = () => ({ status: 200, body: {} });
  });

  it("shares one request between overlapping calls for the same ticker", async () => {
    snapshotDelayMs = 500;
    fetchMock.mockClear();
    alpaca.resetThrottle();
    const both = Promise.all([feed.focusOn(["DUP"]), feed.focusOn(["DUP", "DUP"])]);
    await vi.advanceTimersByTimeAsync(1_000);
    await both;
    expect(fetchMock).toHaveBeenCalledTimes(2); // the tape and the overnight feed, once each
    snapshotDelayMs = 0;
  });

  it("answers within the wait bound when the snapshot is slow, and applies it when it lands", async () => {
    snapshotDelayMs = 5_000;
    snapshotBody = (f) =>
      f === "boats" ? { status: 200, body: {} } : { status: 200, body: { SLOW: { dailyBar: { t: "2026-10-16T04:00:00Z", o: 9, h: 11, l: 9, c: 10, v: 5 } } } };
    fetchMock.mockClear();
    alpaca.resetThrottle();
    let answered = false;
    const first = feed.focusOn(["SLOW"]).then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(feed.SNAPSHOT_WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(feed.liveQuote("SLOW")).toBeNull();

    // A poll while it's still out waits again, without asking again.
    let polled = false;
    const poll = feed.focusOn(["SLOW"]).then(() => (polled = true));
    await vi.advanceTimersByTimeAsync(feed.SNAPSHOT_WAIT_MS);
    await poll;
    expect(polled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(feed.liveQuote("SLOW")).toMatchObject({ price: 10, source: "alpaca" });
    snapshotDelayMs = 0;
    snapshotBody = () => ({ status: 200, body: {} });
  });
});

describe("subscriptions over time", () => {
  it("drops a ticker nobody has asked about for ten minutes", async () => {
    await focus(["GONE"]);
    expect(feed.isRealtime("GONE")).toBe(true);
    const sent = latest("v2/sip").sent.length;
    const sentNight = latest("v1beta1/boats").sent.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 30_000); // past the focus TTL and a resubscribe tick
    const drop = latest("v2/sip").sent.slice(sent).find((m) => m.action === "unsubscribe");
    expect(drop).toMatchObject({ trades: expect.arrayContaining(["GONE"]), quotes: expect.arrayContaining(["GONE"]) });
    const dropNight = latest("v1beta1/boats").sent.slice(sentNight).find((m) => m.action === "unsubscribe");
    expect(dropNight).toMatchObject({ trades: expect.arrayContaining(["GONE"]), quotes: [] });
    expect(feed.isRealtime("GONE")).toBe(false);
  });
});

describe("reconnecting", () => {
  it("stops retrying a feed the account isn't entitled to (409)", async () => {
    const night = latest("v1beta1/boats");
    const count = sockets("v1beta1/boats").length;
    night.receive([{ T: "error", code: 409, msg: "insufficient subscription" }]);
    night.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets("v1beta1/boats")).toHaveLength(count);
    expect(feed.status().overnight).toMatchObject({ connected: false, lastError: "stream error 409: insufficient subscription" });
  });

  it("retries other errors with a doubling delay (406 connection limit)", async () => {
    const count = sockets("v2/sip").length;
    latest("v2/sip").receive([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
    latest("v2/sip").close();
    expect(feed.status().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets("v2/sip")).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets("v2/sip")).toHaveLength(count + 1);

    latest("v2/sip").close(); // fails again before authenticating: wait 2s this time
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets("v2/sip")).toHaveLength(count + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets("v2/sip")).toHaveLength(count + 2);

    latest("v2/sip").login(); // success resets the delay and resubscribes
    expect(feed.status().connected).toBe(true);
    expect(latest("v2/sip").sent.some((m) => m.action === "subscribe" && m.trades?.includes("SPY"))).toBe(true); // a context ETF
    latest("v2/sip").close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets("v2/sip")).toHaveLength(count + 3);
  });
});
