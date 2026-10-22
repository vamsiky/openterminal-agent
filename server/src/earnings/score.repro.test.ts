import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmp: string;
let mods: { score: typeof import("./score.js"); stats: typeof import("./stats.js"); seed: typeof import("./fixtures/seed.js") };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-repro-"));
  process.env.DATA_DIR = tmp;
  await import("../history/store.js");
  await import("../quant/stock-score.js");
  mods = { score: await import("./score.js"), stats: await import("./stats.js"), seed: await import("./fixtures/seed.js") };
  mods.seed.seedAdhoc();
  mods.stats.rebuildStats();
});
afterAll(async () => {
  (await import("../db.js")).db.close();
  (await import("./db.js")).earningsDb.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const EXPECTED: Record<string, number> = { RNG: 69, MXL: 57, APPF: 51, WDC: 48, SSNC: 36, VRSN: 34, KN: 33 };

describe("reproduction of the 2026-10-22 intraday run", () => {
  it("scores within 5 points and fails the same gates", async () => {
    const out = mods.score.screen({ from: "2026-10-22", horizon: "intraday" }, mods.seed.NOW);
    const rows: string[] = [];
    for (const [sym, want] of Object.entries(EXPECTED)) {
      const s = out.find((x) => x.symbol === sym)!;
      const ex = mods.seed.adhoc[sym].expected;
      const pts = Object.fromEntries(s.components.map((c) => [c.key, c.points]));
      rows.push(`${sym} total ${want} got ${s.score} | A ${ex.A}/${pts.tradability} B ${ex.B}/${pts.history} C ${ex.C}/${pts.setup} D ${ex.D}/${pts.demand} E ${ex.E}/${pts.carry} gates ${ex.gate ? "FAIL" : "ok"}/${s.gates.every((g) => g.passed) ? "ok" : "FAIL"}`);
      expect(Math.abs(s.score - want), `${sym}: ${s.score} vs ${want}`).toBeLessThanOrEqual(5);
      expect(s.gates.every((g) => g.passed), `${sym} gates`).toBe(!ex.gate);
    }
    console.log(rows.join("\n"));
  });
});
