import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Session logic of the live feed, driven by stream messages and snapshots.
// The week used: Wed 2026-10-14 to Mon 2026-10-19, New York on EDT (UTC-4).

// store.ts opens real sqlite files under DATA_DIR at import time.
let tmpDir: string;
let feed: typeof import("./feed.js");
let store: typeof import("../history/store.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-feed-test-"));
  process.env.DATA_DIR = tmpDir;
  feed = await import("./feed.js");
  store = await import("../history/store.js");
});

afterAll(() => {
  store.minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => feed.resetLiveFeed());
afterEach(() => vi.useRealTimers());

const bar = (t: string, o: number, h: number, l: number, c: number, v = 1000) => ({ t, o, h, l, c, v });
const day = (S: string, date: string, c: number) => feed.applyMessage({ T: "d", S, ...bar(`${date}T04:00:00Z`, c, c, c, c) });
const trade = (S: string, t: string, p: number, c = ["@"]) => feed.applyMessage({ T: "t", S, t, p, s: 100, c });
const quote = (S: string, at: string) => feed.liveQuote(S, S, new Date(at))!;

describe("review regressions", () => {
  it("ignores a snapshot whose day bar is older than the session the stream rolled to", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T13:35:00Z") }); // Fri 09:35
    day("X", "2026-10-15", 100);
    trade("X", "2026-10-16T13:31:00Z", 105); // Friday's first regular trade
    feed.applySnapshot("X", {
      dailyBar: bar("2026-10-15T04:00:00Z", 99, 101, 98, 100),
      prevDailyBar: bar("2026-10-14T04:00:00Z", 90, 91, 89, 90),
    });
    expect(quote("X", "2026-10-16T13:35:00Z")).toMatchObject({ price: 105, previousClose: 100, change: 5 });
  });

  it("ignores an older day bar for a ticker without the trade feed", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T15:00:00Z") });
    day("Y", "2026-10-15", 100);
    feed.applyMessage({ T: "d", S: "Y", ...bar("2026-10-16T04:00:00Z", 101, 110, 101, 110) });
    feed.applyMessage({ T: "d", S: "Y", ...bar("2026-10-15T04:00:00Z", 99, 101, 98, 100.5) }); // late correction of Thursday
    expect(quote("Y", "2026-10-16T15:00:00Z")).toMatchObject({ price: 110, previousClose: 100, change: 10, high: 110 });
  });

  it("dates a day bar's price at the close once the session is over, not when the bar arrived", () => {
    vi.useFakeTimers({ now: new Date("2026-10-17T15:00:00Z") }); // Saturday
    day("Y", "2026-10-16", 110);
    expect(quote("Y", "2026-10-17T15:00:00Z").asOf).toBe("2026-10-16T20:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-19T15:00:00Z")); // Monday 11:00, mid-session
    day("Y", "2026-10-19", 111);
    expect(quote("Y", "2026-10-19T15:00:00Z").asOf).toBe("2026-10-19T15:00:00.000Z");
  });

  it("doesn't let trades that don't set the last sale move the price, high or low", () => {
    day("W", "2026-10-15", 100);
    trade("W", "2026-10-16T15:00:00Z", 101);
    trade("W", "2026-10-16T15:00:01Z", 140, ["W"]); // average price
    trade("W", "2026-10-16T15:00:02Z", 141, ["@", "4"]); // derivatively priced
    trade("W", "2026-10-16T15:00:03Z", 60, ["@", "Z"]); // sold out of sequence
    trade("W", "2026-10-16T15:00:04Z", 150, ["C"]); // cash
    trade("W", "2026-10-16T15:00:05Z", 102, ["@", "T"]); // form T inside regular hours
    expect(quote("W", "2026-10-16T15:00:10Z")).toMatchObject({ price: 101, high: 101, low: 101 });
    expect(feed.liveEntry("W")?.price).toBe(101);
  });

  it("still takes form T and extended-hours out-of-sequence trades as after-hours prices", () => {
    day("W", "2026-10-16", 100);
    trade("W", "2026-10-16T21:00:00Z", 103, ["@", "T"]); // 17:00
    expect(quote("W", "2026-10-16T21:00:05Z").extended.post).toMatchObject({ price: 103, change: 3 });
    trade("W", "2026-10-16T21:01:00Z", 104, ["@", "U"]);
    expect(quote("W", "2026-10-16T21:01:05Z").extended.post).toMatchObject({ price: 104, change: 4 });
  });

  it("counts the closing auction print just after 16:00 as the regular close", () => {
    day("Z", "2026-10-15", 100);
    trade("Z", "2026-10-16T19:59:59.9Z", 105);
    trade("Z", "2026-10-16T20:00:00.050Z", 105.2, ["@", "T"]); // first after-hours trade
    trade("Z", "2026-10-16T20:00:00.020Z", 105.4, ["@", "6", "X"]); // closing cross, reported after it
    trade("Z", "2026-10-16T20:00:01Z", 105.9, ["M"]); // a market center's official close: ignored
    const q = quote("Z", "2026-10-16T20:00:30Z");
    expect(q).toMatchObject({ price: 105.4, high: 105.4, marketState: "POST" });
    expect(q.extended.post!.price).toBe(105.2);
    expect(q.extended.post!.change).toBeCloseTo(-0.2, 9);
    expect(feed.liveEntry("Z")?.price).toBe(105.2); // the latest trade, for intraday charts

    // A day bar without the auction doesn't replace it, and it's Monday's previous close.
    day("Z", "2026-10-16", 105);
    expect(quote("Z", "2026-10-16T20:05:00Z").price).toBe(105.4);
    day("Z", "2026-10-19", 106);
    expect(quote("Z", "2026-10-19T15:00:00Z").previousClose).toBe(105.4);
  });

  it("orders trade times as instants, not strings", () => {
    day("N", "2026-10-15", 100);
    trade("N", "2026-10-16T15:00:00Z", 99);
    trade("N", "2026-10-16T15:00:00.5Z", 101); // "…00.5Z" sorts before "…00Z" as a string
    expect(quote("N", "2026-10-16T15:00:05Z").price).toBe(101);
    trade("N", "2026-10-16T15:00:00.123456789Z", 98); // older, with nanoseconds
    expect(quote("N", "2026-10-16T15:00:05Z").price).toBe(101);
  });

  it("ignores a late regular trade from a session before the one known", () => {
    day("L", "2026-10-15", 100);
    trade("L", "2026-10-16T15:00:00Z", 101);
    trade("L", "2026-10-15T19:00:00Z", 50); // Thursday, reported late
    expect(quote("L", "2026-10-16T15:00:05Z")).toMatchObject({ price: 101, previousClose: 100, low: 101 });
  });
});

describe("sessions around the regular close", () => {
  it("follows a weekend from Friday's close to Monday's pre-market", () => {
    day("NVDA", "2026-10-15", 190);
    day("NVDA", "2026-10-16", 200);
    feed.applyOvernightMessage({ T: "t", S: "NVDA", p: 195, s: 5, t: "2026-10-16T02:00:00Z", c: ["@", "I"] }); // Thu 22:00
    trade("NVDA", "2026-10-16T21:00:00Z", 204, ["@", "T"]); // Fri 17:00

    const sat = quote("NVDA", "2026-10-17T16:00:00Z");
    expect(sat).toMatchObject({ price: 200, previousClose: 190, change: 10, marketState: "CLOSED", live: false });
    expect(sat.extended).toMatchObject({ post: { price: 204, change: 4 }, overnight: null, pre: null });

    feed.applyOvernightMessage({ T: "t", S: "NVDA", p: 207, s: 5, t: "2026-10-19T01:00:00Z", c: ["@"] }); // Sun 21:00
    const sun = quote("NVDA", "2026-10-19T02:00:00Z");
    expect(sun).toMatchObject({ price: 200, marketState: "OVERNIGHT" });
    expect(sun.extended).toMatchObject({ post: { price: 204 }, overnight: { price: 207, change: 7 }, pre: null });

    trade("NVDA", "2026-10-19T12:00:00Z", 198, ["@", "T"]); // Mon 08:00
    const mon = quote("NVDA", "2026-10-19T12:30:00Z");
    expect(mon).toMatchObject({ price: 200, change: 10, marketState: "PRE" });
    expect(mon.extended).toMatchObject({ post: { price: 204, change: 4 }, overnight: { price: 207, change: 7 }, pre: { price: 198, change: -2 } });
  });

  it("hides Thursday night's overnight price on Friday evening", () => {
    day("AMD", "2026-10-15", 100);
    feed.applyOvernightMessage({ T: "t", S: "AMD", p: 103, s: 5, t: "2026-10-16T02:00:00Z", c: ["@"] }); // Thu 22:00
    trade("AMD", "2026-10-16T15:00:00Z", 101);
    day("AMD", "2026-10-16", 102);
    trade("AMD", "2026-10-16T21:00:00Z", 104, ["@", "T"]); // Fri 17:00
    const q = quote("AMD", "2026-10-16T22:00:00Z"); // Fri 18:00
    expect(q).toMatchObject({ price: 102, previousClose: 100, marketState: "POST" });
    expect(q.extended).toMatchObject({ post: { price: 104, change: 2 }, overnight: null, pre: null });
  });

  it("shows yesterday's close in the pre-market until today's session starts", () => {
    day("AMD", "2026-10-14", 95);
    day("AMD", "2026-10-15", 99);
    trade("AMD", "2026-10-16T11:00:00Z", 101, ["@", "T"]); // Fri 07:00
    const q = quote("AMD", "2026-10-16T11:30:00Z");
    expect(q).toMatchObject({ price: 99, previousClose: 95, change: 4, marketState: "PRE", live: false });
    expect(q.extended.pre).toMatchObject({ price: 101, change: 2, live: false });
    expect(q.extended.pre!.changePercent).toBeCloseTo(2.0202, 3);
  });

  it("without a previous session, counts extended prices from 20:00 the day before", () => {
    trade("ONE", "2026-10-15T23:00:00Z", 101, ["@", "T"]); // Thu 19:00
    day("ONE", "2026-10-16", 100);
    trade("ONE", "2026-10-16T12:00:00Z", 99, ["@", "T"]); // Fri 08:00
    const q = quote("ONE", "2026-10-16T15:00:00Z");
    expect(q).toMatchObject({ price: 100, previousClose: null, change: null, changePercent: null });
    expect(q.extended.post).toBeNull();
    expect(q.extended.pre).toMatchObject({ price: 99, change: null, changePercent: null });
  });
});

describe("minute bars for tickers without the trade feed", () => {
  it("follow the pre-market and after hours, stamped at the bar's end", () => {
    day("SMALL", "2026-10-15", 100);
    feed.applyMessage({ T: "b", S: "SMALL", t: "2026-10-16T12:00:00Z", o: 100, h: 101, l: 100, c: 101, v: 10 }); // 08:00
    const q = quote("SMALL", "2026-10-16T12:01:30Z");
    expect(q.extended.pre).toMatchObject({ price: 101, change: 1, time: "2026-10-16T12:01:00.000Z" });
    expect(feed.liveEntry("SMALL")).toMatchObject({ price: 101, tradeTime: "2026-10-16T12:01:00.000Z" });
  });

  it("leave the regular session to the day bar", () => {
    day("SMALL", "2026-10-15", 100);
    feed.applyMessage({ T: "b", S: "SMALL", t: "2026-10-16T14:00:00Z", o: 150, h: 150, l: 150, c: 150, v: 10 }); // 10:00
    expect(feed.liveEntry("SMALL")).toMatchObject({ price: null, regPrice: 100, barDay: "2026-10-15" });
  });
});
