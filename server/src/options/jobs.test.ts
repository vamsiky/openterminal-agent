import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let jobs: typeof import("./jobs.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-options-jobs-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.OPTIONS_STREAM = "0";
  process.env.OPTIONS_SWEEP = "0";
  jobs = await import("./jobs.js");
});

afterAll(async () => {
  jobs.optionsHandle()?.stop();
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.OPTIONS_STREAM;
  delete process.env.OPTIONS_SWEEP;
});

describe("inSweepWindow", () => {
  it("is weekdays 09:30–16:00 New York", () => {
    expect(jobs.inSweepWindow(Date.parse("2026-10-21T13:29:00Z"))).toBe(false);
    expect(jobs.inSweepWindow(Date.parse("2026-10-21T13:30:00Z"))).toBe(true);
    expect(jobs.inSweepWindow(Date.parse("2026-10-21T19:59:00Z"))).toBe(true);
    expect(jobs.inSweepWindow(Date.parse("2026-10-21T20:00:00Z"))).toBe(false);
    expect(jobs.inSweepWindow(Date.parse("2026-10-25T15:00:00Z"))).toBe(false); // Sunday
  });
});

describe("windows follow the market calendar", () => {
  it("skips holidays and ends at the early close", async () => {
    const cal = await import("../providers/alpaca-calendar.js");
    const stream = await import("./opra-stream.js");
    cal.loadCalendarRows(2026, [
      { date: "2026-11-25", open: "09:30", close: "16:00" },
      { date: "2026-11-27", open: "09:30", close: "13:00" },
    ]);
    try {
      expect(jobs.inSweepWindow(Date.parse("2026-11-26T16:00:00Z"))).toBe(false); // Thanksgiving, 11:00 ET
      expect(stream.inStreamWindow(Date.parse("2026-11-26T16:00:00Z"))).toBe(false);
      expect(jobs.inSweepWindow(Date.parse("2026-11-27T17:30:00Z"))).toBe(true); // 12:30 ET
      expect(jobs.inSweepWindow(Date.parse("2026-11-27T18:00:00Z"))).toBe(false); // 13:00 ET close
      expect(stream.inStreamWindow(Date.parse("2026-11-27T18:04:00Z"))).toBe(true);
      expect(stream.inStreamWindow(Date.parse("2026-11-27T18:05:00Z"))).toBe(false);
    } finally {
      cal.resetCalendar();
    }
  });
});

describe("startOptionsJobs", () => {
  it("exposes status and runs a sweep that points the stream at the selection", async () => {
    const h = jobs.startOptionsJobs(
      { underlyings: () => ["AAA"], optionHoldings: () => [], stockHoldings: () => [] },
      {
        prices: async () => new Map([["AAA", 100]]),
        snapshots: async () => ({}),
        hv20: () => null,
        openInterest: async () => new Map<string, number>(),
      }
    );
    expect(h.status()).toMatchObject({ connected: false, subscribed: 0, lastError: null, lastSweep: null, rejectedSymbols: [] });
    const result = await h.sweepNow();
    expect(result?.underlyings).toBe(1);
    expect(h.status().lastSweep).toMatchObject({ underlyings: 1, errors: 0 });
    expect(h.latestOptionMetrics(["AAA"]).size).toBe(1);
    // A second call while one runs is skipped.
    const [a, b] = await Promise.all([h.sweepNow(), h.sweepNow()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(jobs.startOptionsJobs({ underlyings: () => [], optionHoldings: () => [], stockHoldings: () => [] })).toBe(h);
  });
});
