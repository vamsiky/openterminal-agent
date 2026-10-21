import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobName } from "./jobs.js";

let tmpDir: string;
let jobs: typeof import("./jobs.js");
let db: typeof import("../db.js").db;

// Wednesday 2026-10-21, New York is on EDT (UTC-4).
const at = (hh: number, mm: number, ss = 0) => new Date(Date.UTC(2026, 9, 21, hh + 4, mm, ss));
const never = () => null;
const started = (m: Partial<Record<JobName, Date>>) => (job: JobName) => m[job]?.getTime() ?? null;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scanjobs-edge-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  jobs = await import("./jobs.js");
});

afterAll(async () => {
  vi.restoreAllMocks();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("session windows", () => {
  it("runs nothing from the session scans before 09:45 or after 16:03", () => {
    const ran = started({ "stock-nightly": at(7, 0, 5), "ideas-screen": at(7, 0, 10) });
    for (const t of [at(9, 0), at(9, 44, 59), at(16, 3, 1)]) {
      expect(jobs.dueJobs(t, ran, () => true)).toEqual([]);
    }
    // After 16:30 the evening nightly is due until it has run.
    const afterClose = started({ "stock-nightly": at(16, 30, 0), "ideas-screen": at(16, 30, 30) });
    expect(jobs.dueJobs(at(18, 0), afterClose, () => true)).toEqual([]);
  });

  it("waits for each job's offset into its slot: stock 20 s, option 90 s", () => {
    const ran = started({ "stock-nightly": at(7, 0, 5), "ideas-screen": at(7, 0, 10) });
    expect(jobs.dueJobs(at(9, 45, 10), ran, () => true)).toEqual([]);
    expect(jobs.dueJobs(at(9, 45, 25), ran, () => true)).toEqual(["stock-intraday"]);
    expect(jobs.dueJobs(at(9, 46, 0), ran, () => true)).toEqual(["stock-intraday"]);
    expect(jobs.dueJobs(at(9, 46, 45), ran, () => true)).toEqual(["stock-intraday", "option-scan"]);
  });

  it("does not run a session scan on a day SPY did not trade, however late in the day", () => {
    const ran = started({ "stock-nightly": at(7, 0, 5), "ideas-screen": at(7, 0, 10) });
    expect(jobs.dueJobs(at(10, 30), ran, () => false)).toEqual([]);
    expect(jobs.dueJobs(at(15, 30), ran, () => false)).toEqual([]);
  });

  it("does not run any job on a weekend, including the nightly", () => {
    const sat = new Date(Date.UTC(2026, 9, 24, 14, 0));
    expect(jobs.dueJobs(sat, never, () => true)).toEqual([]);
    const sun = new Date(Date.UTC(2026, 9, 25, 12, 0));
    expect(jobs.dueJobs(sun, never, () => true)).toEqual([]);
  });

  it("runs the nightly on a weekday holiday, since it reads stored data rather than the session", () => {
    // The nightly is not tied to the session: it runs at 07:00 with or without SPY trading.
    expect(jobs.dueJobs(at(7, 1), never, () => false)).toEqual(["stock-nightly"]);
  });

  it("runs the late nightly once the session is over", () => {
    const ran = started({ "stock-nightly": at(7, 0, 5), "ideas-screen": at(7, 0, 10) });
    expect(jobs.dueJobs(at(16, 30, 1), ran, () => true)).toEqual(["stock-nightly"]);
    expect(jobs.dueJobs(at(16, 30, 1), started({ "stock-nightly": at(16, 30, 0), "ideas-screen": at(16, 30, 30) }), () => true)).toEqual([]);
  });
});

describe("runJob", () => {
  // Runs first: startQuantJobs sets the module's deps, and stop() does not clear them.
  it("refuses the option scan until the options layer is connected", () => {
    expect(jobs.runJob("option-scan", at(11, 0))).toBe(false);
  });

  it("refuses a second run while one is in progress, and the first run still records once", async () => {
    let inner: boolean | null = null;
    const quant = jobs.startQuantJobs({
      optionMetrics: () => {
        // Called from inside the option scan: a re-entrant run must be refused.
        inner = jobs.runJob("ideas-screen", at(10, 0));
        return new Map();
      },
      optionsStatus: () => null,
    });
    try {
      expect(jobs.runJob("option-scan", at(10, 0))).toBe(true);
      expect(inner).toBe(false);
      const rows = db.prepare("SELECT job, status FROM scan_runs WHERE job = 'ideas-screen' AND status = 'ok'").all();
      expect(rows).toEqual([]);
      expect(jobs.lastRuns()["option-scan"]).toMatchObject({ status: "ok" });
    } finally {
      quant?.stop();
    }
  });

  it("records a failed run and releases the guard, so the next run goes ahead", async () => {
    const quant = jobs.startQuantJobs({
      optionMetrics: () => {
        throw new Error("options layer exploded");
      },
      optionsStatus: () => null,
    });
    try {
      expect(jobs.runJob("option-scan", at(10, 5))).toBe(true);
      expect(jobs.lastRuns()["option-scan"]).toMatchObject({ status: "error", error: "options layer exploded" });
      // The guard was released in the finally block, so a following run is not refused.
      expect(jobs.runJob("option-scan", at(10, 10))).toBe(true);
    } finally {
      quant?.stop();
    }
  });

});
