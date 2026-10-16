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
  it("backfills new symbols, then resumes from the last stored day", async () => {
    const data = { AAA: [day("2026-10-13", 10), day("2026-10-14", 11)] };
    const first = fakeSource(data);
    const r1 = await sync.syncDaily(["AAA"], { years: 1, now: new Date("2026-10-15T00:00:00Z"), source: first.source });
    expect(r1.bars).toBe(2);
    expect(first.calls[0].start).toBe("2025-10-15");
    expect(store.lastDailyBar("AAA")).toMatchObject({ day: "2026-10-14", close: 11 });

    data.AAA.push(day("2026-10-15", 12));
    const second = fakeSource(data);
    await sync.syncDaily(["AAA"], { years: 1, now: new Date("2026-10-16T00:00:00Z"), source: second.source });
    expect(second.calls[0].start).toBe("2026-10-14");
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

describe("universes", () => {
  it("keeps watchlist symbols and context ETFs at minute resolution", () => {
    watchlists.setWatchlist("default", ["NVDA", "TSLA"]);
    const minute = sync.minuteUniverse();
    expect(minute).toEqual(expect.arrayContaining(["NVDA", "TSLA", "SPY", "QQQ", "XLK"]));
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
});
