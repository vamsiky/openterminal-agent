import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmp: string;
let m: { score: typeof import("./score.js"); stats: typeof import("./stats.js"); syn: typeof import("./fixtures/synthetic.js") };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-perf-"));
  process.env.DATA_DIR = tmp;
  await import("../history/store.js");
  await import("../quant/stock-score.js");
  await import("../research/bulk-store.js");
  m = { score: await import("./score.js"), stats: await import("./stats.js"), syn: await import("./fixtures/synthetic.js") };
});
afterAll(async () => {
  (await import("../db.js")).db.close();
  (await import("./db.js")).earningsDb.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("timing at full scale", () => {
  it("screens 6,854 names reporting on one day in under 2 s", () => {
    m.syn.seedScreenDay(6854, "2026-10-22");
    const now = new Date("2026-10-21T21:00:00Z");
    m.score.screen({ from: "2026-10-22", horizon: "intraday" }, now); // warm the statement caches
    const t = Date.now();
    const out = m.score.screen({ from: "2026-10-22", horizon: "intraday" }, now);
    const ms = Date.now() - t;
    console.log(`screen: ${out.length} setups in ${ms} ms`);
    expect(out.length).toBe(6854);
    expect(ms).toBeLessThan(2000);
  }, 120_000);

  it("rebuilds stats over 270k events in well under a minute", () => {
    m.syn.seedEvents(270_000, 6854, 0.12);
    const r = m.stats.rebuildStats();
    console.log(`rebuildStats: ${r.scopes} scopes in ${r.ms} ms`);
    expect(r.scopes).toBeGreaterThan(20_000);
    expect(r.ms).toBeLessThan(60_000);
  }, 300_000);
});
