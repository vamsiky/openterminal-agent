import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bar } from "../providers/alpaca.js";

// store.ts opens real sqlite files under DATA_DIR at import time.
let tmpDir: string;
let sync: typeof import("./sync.js");
let store: typeof import("./store.js");
let watchlists: typeof import("../routes/watchlists.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-history-test-"));
  process.env.DATA_DIR = tmpDir;
  sync = await import("./sync.js");
  store = await import("./store.js");
  watchlists = await import("../routes/watchlists.js");
});

afterAll(() => {
  store.minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const day = (date: string, close: number): Bar => ({ t: `${date}T04:00:00Z`, o: close, h: close, l: close, c: close, v: 1000, vw: close, n: 10 });

/** A fake Alpaca: serves `data` from `start` on, one page per symbol, and records each request. */
function fakeSource(data: Record<string, Bar[]>) {
  const calls: Array<{ symbols: string[]; start: string; timeframe: string }> = [];
  const source = async function* (opts: { symbols: string[]; start: string; timeframe: string }) {
    calls.push({ symbols: opts.symbols, start: opts.start, timeframe: opts.timeframe });
    for (const s of opts.symbols) {
      const bars = (data[s] ?? []).filter((b) => b.t >= opts.start);
      yield { [s]: bars };
    }
  } as any;
  return { source, calls };
}

describe("daily history sync", () => {
  it("backfills new symbols, then resumes from the second-newest stored day", async () => {
    const data = { AAA: [day("2026-10-13", 10), day("2026-10-14", 11)] };
    const first = fakeSource(data);
    const r1 = await sync.syncDaily(["AAA"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: first.source });
    expect(r1.bars).toBe(2);
    expect(first.calls[0].start).toBe("2025-10-15");
    expect(store.lastDailyBar("AAA")).toMatchObject({ day: "2026-10-14", close: 11 });

    data.AAA.push(day("2026-10-15", 12));
    const second = fakeSource(data);
    await sync.syncDaily(["AAA"], { years: 1, now: new Date("2026-10-16T00:00:00Z"), source: second.source });
    expect(second.calls[0].start).toBe("2026-10-13");
    expect(store.dailyBars("AAA", "2026-01-01", "2026-12-31").map((b) => b.close)).toEqual([10, 11, 12]);
  });

  it("reloads a symbol's history when a split re-adjusts past closes", async () => {
    const before = fakeSource({ SPL: [day("2026-10-13", 200), day("2026-10-14", 210)] });
    await sync.syncDaily(["SPL"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: before.source });

    // A 2-for-1 split: Alpaca now reports every earlier close halved.
    const after = fakeSource({ SPL: [day("2026-10-13", 100), day("2026-10-14", 105), day("2026-10-15", 104)] });
    const r = await sync.syncDaily(["SPL"], { years: 1, now: new Date("2026-10-16T00:00:00Z"), source: after.source });
    expect(r.resplit).toEqual(["SPL"]);
    expect(store.dailyBars("SPL", "2026-01-01", "2026-12-31").map((b) => b.close)).toEqual([100, 105, 104]);
    expect(store.minuteReloads()).toContain("SPL");
  });

  it("keeps the old bars when the split reload fails", async () => {
    const before = fakeSource({ KEEP: [day("2026-10-13", 50), day("2026-10-14", 52)] });
    await sync.syncDaily(["KEEP"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: before.source });

    let calls = 0;
    const flaky = async function* (opts: { symbols: string[]; start: string }) {
      if (++calls > 1) throw new Error("alpaca 503");
      yield { KEEP: [day("2026-10-13", 25), day("2026-10-14", 26)].filter((b) => b.t >= opts.start) };
    } as any;
    const r = await sync.syncDaily(["KEEP"], { years: 1, now: new Date("2026-10-16T00:00:00Z"), source: flaky });
    expect(r.errors[0]).toContain("daily KEEP: split reload failed, old bars kept: alpaca 503");
    expect(store.dailyBars("KEEP", "2026-01-01", "2026-12-31").map((b) => b.close)).toEqual([50, 52]);
  });

  it("retries a failed batch one symbol at a time", async () => {
    const good = fakeSource({ GOOD: [day("2026-10-14", 5)] });
    const picky = async function* (opts: { symbols: string[]; start: string; timeframe: string }) {
      if (opts.symbols.includes("BAD")) throw new Error("alpaca 400 invalid symbol");
      yield* good.source(opts);
    } as any;
    const r = await sync.syncDaily(["BAD", "GOOD"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: picky });
    expect(r.errors).toEqual(["daily BAD: alpaca 400 invalid symbol"]);
    expect(store.lastDailyBar("GOOD")?.close).toBe(5);
    expect(store.listIssues({ symbol: "BAD" })).toEqual([
      expect.objectContaining({ job: "daily", kind: "error", reason: "alpaca 400 invalid symbol" }),
    ]);
  });

  it("records symbols Alpaca returns no bars for", async () => {
    const empty = fakeSource({});
    const r = await sync.syncDaily(["GHOST"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: empty.source });
    expect(r.errors).toEqual([]);
    const [issue] = store.listIssues({ symbol: "GHOST" });
    expect(issue).toMatchObject({ kind: "no_bars", job: "daily" });
    expect(issue.reason).toContain("unknown symbol");
  });
});

describe("minute history sync", () => {
  it("stores minute bars and resumes from the New York day of the last bar", async () => {
    const bar = (t: string, c: number): Bar => ({ t, o: c, h: c, l: c, c, v: 5 });
    const data = { MIN: [bar("2026-10-14T13:30:00Z", 1), bar("2026-10-14T13:31:00Z", 2)] };
    const first = fakeSource(data);
    const r = await sync.syncMinute(["MIN"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: first.source });
    expect(r.bars).toBe(2);

    const second = fakeSource(data);
    await sync.syncMinute(["MIN"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: second.source });
    expect(second.calls[0].start).toBe("2026-10-14T05:00:00.000Z");
    expect(store.minuteBars("MIN", 0, 2e9)).toHaveLength(2);
  });
});

describe("minute reload after a split", () => {
  it("re-downloads the stored minute range for a flagged symbol, even after a daily-only run", async () => {
    const bar = (t: string, c: number): Bar => ({ t, o: c, h: c, l: c, c, v: 5 });
    const old = fakeSource({ RSP: [bar("2026-09-01T13:30:00Z", 200), bar("2026-10-14T13:30:00Z", 210)] });
    await sync.syncMinute(["RSP"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: old.source });

    store.flagMinuteReload("RSP");
    const adjusted = fakeSource({ RSP: [bar("2026-09-01T13:30:00Z", 100), bar("2026-10-14T13:30:00Z", 105)] });
    const r = await sync.syncMinute(["RSP"], { years: 1, now: new Date("2026-10-16T00:00:00Z"), source: adjusted.source });
    expect(adjusted.calls[0].start).toBe("2026-09-01T13:30:00.000Z");
    expect(r.resplit).toEqual(["RSP"]);
    expect(store.minuteBars("RSP", 0, 2e9).map((b) => b.close)).toEqual([100, 105]);
    expect(store.minuteReloads()).not.toContain("RSP");
  });
});

describe("run bookkeeping", () => {
  it("closes out a run whose process stopped sending heartbeats", () => {
    const id = store.startRun("all");
    expect(store.liveRun(30)?.id).toBe(id);
    store.abandonStaleRuns(0); // every run counts as stale
    expect(store.liveRun(30)).toBeUndefined();
  });
});

describe("universes", () => {
  it("keeps watchlist symbols and context ETFs at minute resolution", () => {
    watchlists.setWatchlist("default", ["NVDA", "TSLA", "BRK-B", "^GSPC", "EURUSD=X", "BTC-USD", "0700.HK"]);
    const minute = sync.minuteUniverse();
    expect(minute).toEqual(expect.arrayContaining(["NVDA", "TSLA", "BRK.B", "SPY", "QQQ", "XLK"]));
    expect(minute.filter((s) => /[\^=]|-|HK/.test(s))).toEqual([]);
    expect(sync.unsupportedWatchlistSymbols()).toEqual(["0700.HK", "BTC-USD", "EURUSD=X", "^GSPC"].sort());
    expect(sync.dailyUniverse()).toEqual(expect.arrayContaining(minute));
  });

  it("marks vanished listings inactive instead of deleting them", () => {
    store.saveUniverse([
      { symbol: "OLD", name: "Old Co", exchange: "NYSE", isEtf: false },
      { symbol: "NEW", name: "New Co", exchange: "Nasdaq", isEtf: false },
    ]);
    store.saveUniverse([{ symbol: "NEW", name: "New Co", exchange: "Nasdaq", isEtf: false }]);
    expect(store.activeSymbols()).toEqual(["NEW"]);
  });
});

describe("watchlists", () => {
  it("returns null for a list that was never saved, and keeps order", () => {
    expect(watchlists.getWatchlist("never")).toBeNull();
    watchlists.setWatchlist("swing", ["MSFT", "AAPL", "MSFT"]);
    expect(watchlists.getWatchlist("swing")).toEqual(["MSFT", "AAPL"]);
  });

  it("imports a Webull export, replacing same-named lists and keeping the rest", () => {
    watchlists.setWatchlist("To buy", ["OLD"]);
    const csv = [
      "\uFEFFWatchlist,#,Symbol,Name,Exchange",
      'AI,1,CRDO,CREDO TECHNOLOGY GROUP HOLDING,NASDAQ',
      'AI,2,NCNO,"Ncino, Inc.",NASDAQ',
      "Daily Watchlist,1,GETY,GETTY IMAGES HOLDINGS INC,OTCPK",
      "To buy,1,SITM,SITIME CORP,NASDAQ",
      "Crypto,1,BTC,Bitcoin,CCC",
      "Crypto,2,SHIB,Shiba Inu,CCC",
      "Owned,1,VIX,CBOE Market Volatility Index,CBOE",
      "Crypto,3,COIN,\"Coinbase Global, Inc.\",NASDAQ",
      "Bad/name,1,AAPL,Apple Inc,NASDAQ",
      "",
    ].join("\r\n");
    const result = watchlists.importWebull(csv);
    expect(result.saved.map((l) => l.name)).toEqual(["AI", "Daily Watchlist", "To buy", "Crypto", "Owned"]);
    expect(result.skipped).toEqual(["Bad/name"]);
    expect(watchlists.getWatchlist("AI")).toEqual(["CRDO", "NCNO"]);
    expect(watchlists.getWatchlist("To buy")).toEqual(["SITM"]);
    expect(watchlists.getWatchlist("Crypto")).toEqual(["BTC-USD", "SHIB-USD", "COIN"]);
    expect(watchlists.getWatchlist("Owned")).toEqual(["^VIX"]);
    expect(watchlists.getWatchlist("swing")).toEqual(["MSFT", "AAPL"]);
    expect(watchlists.listWatchlists().map((l) => l.name)).toContain("Daily Watchlist");
  });

  it("deletes a list and its symbols", () => {
    watchlists.setWatchlist("gone", ["ZZZ"]);
    watchlists.deleteWatchlist("gone");
    expect(watchlists.getWatchlist("gone")).toBeNull();
    expect(watchlists.allWatchlistSymbols()).not.toContain("ZZZ");
  });

  it("rejects names the web app can't send", () => {
    for (const bad of ["", " AI", "AI ", "a/b", "import", "x".repeat(41)]) expect(watchlists.nameSchema.safeParse(bad).success).toBe(false);
    for (const ok of ["AI", "Daily Watchlist", "Energy-AI", "default"]) expect(watchlists.nameSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects a file that isn't a Webull export", () => {
    expect(() => watchlists.importWebull("Symbol,Qty\nAAPL,1")).toThrow(/Webull/);
  });
});
