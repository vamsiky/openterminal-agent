import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The calendar is mocked: Wednesday 2026-10-21 trades 09:30–16:00, Thursday 2026-10-22 is a holiday,
// 2026-10-23 is an early close at 13:00, and weekends are closed. This file's own module instance, so the mock stays here.
vi.mock("../providers/alpaca-calendar.js", () => {
  const HOLIDAYS = new Set(["2026-10-22"]);
  const EARLY = new Set(["2026-10-23"]);
  const isTradingDay = (day: string) => {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6 && !HOLIDAYS.has(day);
  };
  // New York is UTC-4 in October (EDT).
  const sessionOpen = (day: string) => Date.parse(`${day}T13:30:00Z`);
  const sessionClose = (day: string) => Date.parse(EARLY.has(day) ? `${day}T17:00:00Z` : `${day}T20:00:00Z`);
  return {
    isTradingDay,
    sessionOpen,
    sessionClose,
    ensureCalendar: async () => true,
    holidays: () => [...HOLIDAYS],
    loadCalendarRows: () => {},
    resetCalendar: () => {},
  };
});

let tmpDir: string;
let jobs: typeof import("./jobs.js");
let sweep: typeof import("./sweep.js");
type Deferred = { resolve: (v: unknown) => void; promise: Promise<unknown> };

const emptySweep = () => ({
  startedAt: new Date().toISOString(),
  durationMs: 1,
  underlyings: 1,
  metrics: [],
  selection: { contracts: [], pairs: new Map(), skipped: [], heldDropped: 0 },
  errors: [],
  requests: 1,
  prices: new Map([["AAA", 100]]),
});

const deps = { underlyings: () => ["AAA"], optionHoldings: () => [], stockHoldings: () => [] };

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-options-jobs-edge-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.OPTIONS_STREAM = "0"; // no websocket in tests
  process.env.ALPACA_API_KEY_ID = "test-key";
  process.env.ALPACA_API_SECRET_KEY = "test-secret";
  delete process.env.OPTIONS_SWEEP;
  sweep = await import("./sweep.js");
  jobs = await import("./jobs.js");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jobs.optionsHandle()?.stop();
  vi.useRealTimers();
});

afterAll(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.OPTIONS_STREAM;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
});

/** Starts the jobs with fake clocks and a sweep that stays pending until the test resolves it. */
function startWithSlowSweep(now: string) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(now));
  const pending: Deferred[] = [];
  const runSweep = vi.spyOn(sweep, "runSweep").mockImplementation(() => {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => (resolve = r));
    pending.push({ resolve, promise });
    return promise as never;
  });
  const handle = jobs.startOptionsJobs(deps);
  return { handle, runSweep, pending };
}

describe("the 5-minute tick", () => {
  it("skips the next tick while a slow sweep is still running, then sweeps again once it finishes", async () => {
    // 10:00 New York on a trading day.
    const { handle, runSweep, pending } = startWithSlowSweep("2026-10-21T14:00:00Z");
    await vi.advanceTimersByTimeAsync(0); // the calendar promise settles and the first tick runs
    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(handle.status().sweeping).toBe(true);

    // Five minutes of ticks (every 15 s) go by while the sweep hangs: none starts another.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runSweep).toHaveBeenCalledTimes(1);

    // The sweep finishes at 10:05; the next tick after that runs the following sweep.
    pending[0].resolve(emptySweep());
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.status().sweeping).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runSweep).toHaveBeenCalledTimes(2);
  });

  it("sweeps every five minutes while each sweep finishes in time", async () => {
    const { handle, runSweep, pending } = startWithSlowSweep("2026-10-21T14:00:00Z");
    await vi.advanceTimersByTimeAsync(0);
    pending[0].resolve(emptySweep());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runSweep.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(handle.status().lastSweep).toMatchObject({ underlyings: 1, errors: 0 });
  });

  it("does not sweep on a holiday, at weekends, before the open or after the close", async () => {
    for (const now of ["2026-10-22T14:00:00Z", "2026-10-24T14:00:00Z", "2026-10-21T13:00:00Z", "2026-10-21T20:30:00Z"]) {
      const { handle, runSweep } = startWithSlowSweep(now);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(runSweep, now).not.toHaveBeenCalled();
      handle.stop();
      vi.useRealTimers();
    }
  });

  it("does not sweep after the early close", async () => {
    // 2026-10-23 closes at 13:00 New York (17:00 UTC); 13:10 is after it.
    const { handle, runSweep } = startWithSlowSweep("2026-10-23T17:10:00Z");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runSweep).not.toHaveBeenCalled();
    handle.stop();
  });

  it("sweeps up to the early close", async () => {
    const { handle, runSweep } = startWithSlowSweep("2026-10-23T16:30:00Z"); // 12:30 New York
    await vi.advanceTimersByTimeAsync(0);
    expect(runSweep).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
