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

  it("picks WDC's $380 OTM call from the snapshot and uses the stored delta", async () => {
    const [wdc] = mods.score.screen({ from: "2026-10-22", symbols: ["WDC"] }, mods.seed.NOW);
    expect(wdc.contract).toMatchObject({ occ: "WDC261023C00380000", strike: 380, delta: 0.4693 });
  });

  it("month takes the first expiry 25+ days out from the event or next row", async () => {
    const { earningsDb } = await import("./db.js");
    earningsDb
      .prepare("INSERT INTO snapshots (symbol, ts, expiry_kind, report_date, expiry, spot, call_occ, call_strike, call_bid, call_ask, call_iv, call_volume, call_oi, call_delta) VALUES ('WDC','2026-10-21T20:00:00Z','next','2026-10-22','2026-11-20',378.5,'WDC261120C00380000',380,30,31,0.9,200,500,0.5)")
      .run();
    const [m] = mods.score.screen({ from: "2026-10-22", symbols: ["WDC"], horizon: "month" }, mods.seed.NOW);
    expect(m.contract).toMatchObject({ expiry: "2026-11-20", delta: 0.5 });
    const [w] = mods.score.screen({ from: "2026-10-22", symbols: ["WDC"], horizon: "week" }, mods.seed.NOW);
    expect(w.contract!.expiry).toBe("2026-10-23");
    earningsDb.prepare("DELETE FROM snapshots WHERE expiry_kind = 'next'").run();
  });
});
