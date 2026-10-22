import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmp: string;
let stats: typeof import("./stats.js");
let edb: typeof import("./db.js").earningsDb;
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-stats-edge-"));
  process.env.DATA_DIR = tmp;
  ({ db } = await import("../db.js"));
  await import("../research/bulk-store.js");
  ({ earningsDb: edb } = await import("./db.js"));
  stats = await import("./stats.js");
});
afterAll(() => {
  db.close();
  edb.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const day = (i: number) => `2025-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;

/** One confirmed amc event with 10:00 / 15:45 stock prices, and a call leg that moves call% = 3 + 6 x stock%. */
function event(symbol: string, i: number, stockPct: number, extra: { t0m1?: number; close?: number; prevClose?: number; rClose?: number } = {}): void {
  const d = day(i);
  const close = extra.close ?? 100;
  edb.prepare("INSERT OR REPLACE INTO events (symbol, report_date, time, t0, r, confirmed, check_fmp, reason) VALUES (?,?,'amc',?,?,1,1,'ok')").run(symbol, d, d, d);
  edb
    .prepare("INSERT OR REPLACE INTO stock_paths (symbol, report_date, t0_open, t0_1000, t0_1545, t0_close, r_close, prev_close, t0_m1) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(symbol, d, 100, 100, 100 * (1 + stockPct / 100), close, extra.rClose ?? close, extra.prevClose ?? close, extra.t0m1 ?? 100);
  const o10 = 2;
  const o1545 = o10 * (1 + (3 + 6 * stockPct) / 100);
  edb
    .prepare("INSERT OR REPLACE INTO option_paths (symbol, report_date, entry, expiry_kind, leg, contract, expiry, strike, spot_at_entry, prices, price_source) VALUES (?,?,'T0:10:00','event','atm_call','X',?,100,100,?,'trade')")
    .run(symbol, d, d, JSON.stringify({ "T0:10:00": o10, "T0:15:45": o1545 }));
}

describe("flatDayCall", () => {
  it("is null with only two days under 0.6% in stock move, and the median once there are three", () => {
    // Two flat days (0.3, 0.5) and four big moves: not enough flat days for a median.
    [2, 0.3, -3, 0.5, 4, -5].forEach((x, i) => event("TWOFLAT", i, x));
    // Three flat days (0.3, -0.2, 0.5) and three big moves.
    [2, 0.3, -3, -0.2, 4, 0.5, -5].forEach((x, i) => event("THREEFLAT", i, x));
    stats.rebuildStats();
    expect(stats.getStats("sym:TWOFLAT", "intraday")!.flatDayCall).toBeNull();
    // Flat calls: 3 + 6 x 0.3 = 4.8, 3 + 6 x -0.2 = 1.8, 3 + 6 x 0.5 = 6 -> median 4.8.
    expect(stats.getStats("sym:THREEFLAT", "intraday")!.flatDayCall).toBeCloseTo(4.8, 2);
  });
});

describe("pre-report drift share", () => {
  it("measures T0:close against the T0-1 close, not against prev_close (regression)", () => {
    // Every report day closed 11.1% above the day before (T0-1 = 90, T0:close = 100). prev_close is set equal to the
    // close, the way it is for bmo/amc, so reading prev_close would give a 0% move on every day.
    [1, -1, 2, -2].forEach((x, i) => event("DRIFT", i, x, { t0m1: 90, close: 100, prevClose: 100 }));
    stats.rebuildStats();
    const d = stats.getStats("sym:DRIFT", "intraday")!;
    expect(d.preDrift.rCloseFromPrev).toMatchObject({ n: 4, winRate: 1 });
    expect(d.preDrift.rCloseFromPrev.median).toBeCloseTo(11.1111, 3);
  });
});
