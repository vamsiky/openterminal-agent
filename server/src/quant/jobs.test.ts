import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobName } from "./jobs.js";

let tmpDir: string;
let jobs: typeof import("./jobs.js");
let db: typeof import("../db.js").db;

// Wednesday 2026-10-21, New York is on EDT (UTC-4).
const at = (hh: number, mm: number, ss = 0) => new Date(Date.UTC(2026, 9, 21, hh + 4, mm, ss));
const ran = (m: Partial<Record<JobName, Date>>) => (job: JobName) => m[job]?.getTime() ?? null;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scanjobs-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  jobs = await import("./jobs.js");
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("dueJobs", () => {
  it("runs the nightly scorecards at 07:00 and 16:30 New York, then the screen", () => {
    expect(jobs.dueJobs(at(6, 59), ran({}))).toEqual([]);
    expect(jobs.dueJobs(at(7, 1), ran({}))).toEqual(["stock-nightly"]);
    expect(jobs.dueJobs(at(7, 2), ran({ "stock-nightly": at(7, 1) }))).toEqual(["ideas-screen"]);
    expect(jobs.dueJobs(at(7, 3), ran({ "stock-nightly": at(7, 1), "ideas-screen": at(7, 2) }))).toEqual([]);
    // The 07:00 run does not satisfy the 16:30 slot.
    expect(jobs.dueJobs(at(16, 31), ran({ "stock-nightly": at(7, 1), "ideas-screen": at(7, 2) }))).toEqual(["stock-nightly"]);
  });

  it("catches up a missed nightly after a restart", () => {
    expect(jobs.dueJobs(at(11, 0), ran({ "stock-nightly": new Date(Date.UTC(2026, 9, 20, 21)) }))).toContain("stock-nightly");
  });

  it("skips weekends", () => {
    const sat = new Date(Date.UTC(2026, 9, 24, 15));
    expect(jobs.dueJobs(sat, ran({}))).toEqual([]);
  });

  it("runs the option scan every 5 minutes and the stock scan every 15, from 09:35", () => {
    const base = { "stock-nightly": at(7, 1), "ideas-screen": at(7, 2) };
    expect(jobs.dueJobs(at(9, 34), ran(base))).toEqual([]);
    expect(jobs.dueJobs(at(9, 35, 5), ran(base))).toEqual([]); // still inside the offset
    expect(jobs.dueJobs(at(9, 36, 40), ran(base))).toEqual(["option-scan"]); // the 15-minute slot is 09:45
    expect(jobs.dueJobs(at(9, 46, 40), ran(base))).toEqual(["stock-intraday", "option-scan"]);
    const after = { ...base, "stock-intraday": at(9, 46, 40), "option-scan": at(9, 46, 41) };
    expect(jobs.dueJobs(at(9, 50, 5), ran(after))).toEqual([]);
    expect(jobs.dueJobs(at(9, 51, 40), ran(after))).toEqual(["option-scan"]);
    expect(jobs.dueJobs(at(10, 1, 40), ran({ ...after, "option-scan": at(9, 56, 41) }))).toEqual(["stock-intraday", "option-scan"]);
  });

  it("does not scan on a holiday, and respects the close", () => {
    const base = { "stock-nightly": at(7, 1), "ideas-screen": at(7, 2) };
    expect(jobs.dueJobs(at(10, 30), ran(base), () => false)).toEqual([]);
    expect(jobs.dueJobs(at(16, 20), ran(base))).toEqual([]);
    expect(jobs.dueJobs(at(16, 1, 40), ran(base))).toEqual(["stock-intraday", "option-scan"]); // the 16:00 slot
    // Early close at 13:00: the 13:00 slot is the last.
    const early = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 17);
    expect(jobs.dueJobs(at(13, 1, 40), ran(base), () => true, early)).toEqual(["stock-intraday", "option-scan"]);
    expect(jobs.dueJobs(at(13, 20), ran(base), () => true, early)).toEqual([]);
  });
});

describe("runJob", () => {
  it("records runs, refuses the option scan without deps and reports the last run per job", () => {
    expect(jobs.runJob("option-scan")).toBe(false);
    expect(jobs.runJob("stock-nightly", at(8, 0))).toBe(true); // empty tables: scores nothing
    const runs = jobs.lastRuns();
    expect(runs["stock-nightly"]).toMatchObject({ status: "ok", symbols: 0 });
    expect(runs["stock-nightly"].finished_at).not.toBeNull();
    expect(runs["option-scan"]).toBeUndefined();
  });
});

describe("universeByPriority", () => {
  it("puts holdings first, then option score, then composite, then alphabetical", async () => {
    const pos = await import("./positions.js");
    db.prepare("INSERT INTO watchlists (id, name) VALUES (1, 'L')").run();
    const add = db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (1, ?, 0)");
    for (const s of ["AAA", "BBB", "CCC", "DDD", "EEE", "HELD"]) add.run(s);
    pos.importPositions("symbol,quantity\nHELD,10");
    db.prepare("INSERT INTO option_scorecards (underlying, as_of, score, data) VALUES ('CCC', 'x', 60, '{}'), ('BBB', 'x', 80, '{}')").run();
    db.prepare("INSERT INTO scorecards (day, symbol, composite, groups, coverage, weights_version) VALUES ('2026-10-21', 'EEE', 70, '{}', 1, 'v'), ('2026-10-21', 'DDD', 50, '{}', 1, 'v')").run();
    expect(jobs.universeByPriority()).toEqual(["HELD", "BBB", "CCC", "EEE", "DDD", "AAA"]);
  });
});
