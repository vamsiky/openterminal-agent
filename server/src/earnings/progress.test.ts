import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmp: string;
let edb: typeof import("./db.js").earningsDb;
let p: typeof import("./progress.js");

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-progress-"));
  process.env.DATA_DIR = tmp;
  edb = (await import("./db.js")).earningsDb;
  p = await import("./progress.js");
});
afterAll(() => {
  edb.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});
beforeEach(() => edb.exec("DELETE FROM backfill_progress"));

const rows = (task: string, n: number, status = "done", at = "2020-01-01T00:00:00.000Z") => {
  const ins = edb.prepare("INSERT OR REPLACE INTO backfill_progress (task, symbol, status, updated_at) VALUES (?,?,?,?)");
  for (let i = 0; i < n; i++) ins.run(task, `S${i}`, status, at);
};

describe("backfillState", () => {
  it("is idle with nothing recorded", () => {
    expect(p.backfillState(edb).phase).toBe("idle");
  });

  it("running while a phase has started without its marker, then done when all three markers are newer than the run", () => {
    p.markRunStart(edb, 100);
    p.markPhaseStart(edb, "events", 100);
    expect(p.backfillState(edb).phase).toBe("events");
    p.markPhaseDone(edb, "events");
    p.markPhaseStart(edb, "stock", 100);
    expect(p.backfillState(edb).phase).toBe("stock");
    p.markPhaseDone(edb, "stock");
    expect(p.backfillState(edb).phase).toBe("options"); // next phase not started yet: still unfinished
    p.markPhaseStart(edb, "options", 100);
    expect(p.backfillState(edb).phase).toBe("options");
    p.markPhaseDone(edb, "options");
    const s = p.backfillState(edb);
    expect(s.phase).toBe("done");
    expect(s.phases.events.finishedAt).toMatch(/^\d{4}-/);
  });

  it("universe drift does not matter once the markers say done", () => {
    rows("events", 5503);
    rows("stock", 5503);
    rows("options", 5504);
    p.markRunStart(edb, 5503);
    for (const ph of p.PHASES) { p.markPhaseStart(edb, ph, 5503); p.markPhaseDone(edb, ph); }
    const s = p.backfillState(edb);
    expect(s.phase).toBe("done");
    expect(s.phases.options).toMatchObject({ done: 5504, total: 5504 });
    expect(s.phases.events).toMatchObject({ done: 5503, total: 5503 });
  });

  it("a new full run makes the old markers stale", () => {
    p.markRunStart(edb, 10);
    for (const ph of p.PHASES) { p.markPhaseStart(edb, ph, 10); p.markPhaseDone(edb, ph, "2020-01-01T00:00:00.000Z"); }
    expect(p.backfillState(edb).phase).toBe("events");
  });

  it("falls back to counts without markers: 99% of the largest and no errors is done", () => {
    rows("events", 5503);
    rows("stock", 5503);
    rows("options", 5504);
    expect(p.backfillState(edb).phase).toBe("done");
    edb.exec("DELETE FROM backfill_progress WHERE task = 'options' AND symbol LIKE 'S1%'");
    expect(p.backfillState(edb).phase).toBe("options");
  });

  it("fallback reports a phase with error rows instead of done", () => {
    rows("events", 100);
    rows("stock", 100);
    rows("options", 100);
    edb.prepare("UPDATE backfill_progress SET status = 'error' WHERE task = 'options' AND symbol = 'S0'").run();
    edb.prepare("INSERT INTO backfill_progress (task, symbol, status) VALUES ('options', 'EXTRA', 'done')").run();
    expect(p.backfillState(edb).phase).toBe("options");
  });
});

describe("markComplete", () => {
  it("writes the markers when progress is complete, and /status then reads done", () => {
    rows("events", 1000, "done", "2020-01-01T01:00:00.000Z");
    rows("stock", 1000, "done", "2020-01-01T02:00:00.000Z");
    rows("options", 1001, "done", "2020-01-01T03:00:00.000Z");
    expect(p.markComplete(edb)).toMatchObject({ universe: 1001 });
    const s = p.backfillState(edb);
    expect(s.phase).toBe("done");
    expect(s.phases.stock.finishedAt).toBe("2020-01-01T02:00:00.000Z");
  });

  it("refuses when a task is short or has error rows, or when there is no progress", () => {
    expect(() => p.markComplete(edb)).toThrow(/no backfill progress/);
    rows("events", 100);
    rows("stock", 100);
    rows("options", 50);
    expect(() => p.markComplete(edb)).toThrow(/options has 50 of 100/);
    rows("options", 100);
    edb.prepare("UPDATE backfill_progress SET status = 'error' WHERE task = 'stock' AND symbol = 'S1'").run();
    expect(() => p.markComplete(edb)).toThrow(/error rows/);
  });
});
