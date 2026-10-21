import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionMetrics } from "../scan/contracts.js";

let tmpDir: string;
let store: typeof import("./store.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-options-store-test-"));
  process.env.DATA_DIR = tmpDir;
  store = await import("./store.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const bar = (occ: string, ts: number, mid = 1) => ({ occ, ts, bid: mid - 0.05, ask: mid + 0.05, mid, last: mid, volume: 10, iv: 0.3, delta: 0.5 });

describe("option minute bars", () => {
  it("upserts by (occ, ts) and reads a range", () => {
    store.upsertOptionBars([bar("A", 100), bar("A", 160), bar("B", 100)]);
    store.upsertOptionBars([bar("A", 100, 2)]);
    const rows = store.optionBars("A", 0, 1000);
    expect(rows.map((r) => [r.ts, r.mid])).toEqual([[100, 2], [160, 1]]);
    expect(store.optionBars("A", 150, 1000)).toHaveLength(1);
  });

  it("prunes bars older than the retention window", () => {
    const now = Date.now();
    const nowS = Math.floor(now / 1000);
    store.upsertOptionBars([bar("OLD", nowS - 100 * 86_400), bar("NEW", nowS - 86_400)]);
    expect(store.pruneOptionBars(now, 90)).toBeGreaterThanOrEqual(1);
    expect(store.optionBars("OLD", 0, nowS)).toHaveLength(0);
    expect(store.optionBars("NEW", 0, nowS)).toHaveLength(1);
  });

  it("reads the retention env", () => {
    expect(store.retentionDays(undefined)).toBe(90);
    expect(store.retentionDays("30")).toBe(30);
  });
});

describe("iv history and rank", () => {
  it("keeps one row per day and returns the latest window oldest first", () => {
    store.upsertIvDay({ symbol: "X", day: "2026-01-02", iv30: 0.3, atmIv: 0.31, hv20: 0.2 });
    store.upsertIvDay({ symbol: "X", day: "2026-01-02", iv30: 0.35, atmIv: 0.31, hv20: 0.2 });
    store.upsertIvDay({ symbol: "X", day: "2026-01-03", iv30: 0.4, atmIv: null, hv20: null });
    const rows = store.ivHistory("X");
    expect(rows.map((r) => r.iv30)).toEqual([0.35, 0.4]);
    expect(store.ivHistory("X", 1).map((r) => r.day)).toEqual(["2026-01-03"]);
  });

  it("ranks only with at least 20 days of history", () => {
    const hist = Array.from({ length: 19 }, (_, i) => Math.round(20 + i) / 100);
    expect(store.ivRank(0.3, hist)).toEqual({ ivRank: null, ivPercentile: null, days: 19 });
    const full = [...hist, 0.4]; // 0.20 .. 0.40
    const r = store.ivRank(0.3, full);
    expect(r.ivRank).toBeCloseTo(50, 6);
    expect(r.ivPercentile).toBeCloseTo(55, 6); // 11 of 20 values <= 0.30
    expect(store.ivRank(0.5, full).ivRank).toBe(100);
    expect(store.ivRank(null, full).ivRank).toBeNull();
  });
});

describe("option metrics", () => {
  it("replaces the latest per underlying", () => {
    const m = (price: number): OptionMetrics => ({
      underlying: "SPY", asOf: "2026-01-02T15:00:00Z", price, atmExpiry: null, atmCall: null, atmPut: null, atmIv: null, iv30: null,
      ivRank: null, ivPercentile: null, ivHistoryDays: 0, hv20: null, impliedMovePct: null, termSlope: null, putCallVolumeRatio: null,
      unusual: [], atmCallQuote: null, atmPutQuote: null,
    });
    store.saveOptionMetrics(m(500));
    store.saveOptionMetrics(m(501));
    const got = store.latestOptionMetrics(["SPY", "NOPE"]);
    expect(got.size).toBe(1);
    expect(got.get("SPY")?.price).toBe(501);
  });
});
