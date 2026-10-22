import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OptionContract } from "../providers/alpaca-trading.js";

// Stock bars for the split factor come from a mocked stockBarsPage; nothing reaches the network.
const stockBarsPage = vi.fn<(opts: { symbols: string[]; adjustment?: string }) => Promise<{ bars: Record<string, Array<{ t: string; c: number }>>; nextPageToken: string | null }>>();
vi.mock("../providers/alpaca.js", async (orig) => ({ ...(await orig<typeof import("../providers/alpaca.js")>()), stockBarsPage }));

let tmpDir: string;
let op: typeof import("./option-paths.js");
let db: typeof import("../db.js").db;
let edb: typeof import("./db.js").earningsDb;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-option-edge-"));
  process.env.DATA_DIR = tmpDir;
  db = (await import("../db.js")).db;
  await import("../history/store.js"); // daily_bars
  edb = (await import("./db.js")).earningsDb;
  op = await import("./option-paths.js");
});

afterAll(async () => {
  const { minuteDb } = await import("../history/store.js");
  edb.close();
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** Weekdays from `from` to `to` (inclusive) as YYYY-MM-DD. */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

function putDaily(symbol: string, closes: Array<[string, number]>): void {
  db.prepare("DELETE FROM daily_bars WHERE symbol = ?").run(symbol);
  const ins = db.prepare("INSERT INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 1000)");
  for (const [d, c] of closes) ins.run(symbol, d, c, c, c, c);
}

describe("split factor for the option side", () => {
  const may = weekdays("2026-05-04", "2026-05-29");
  const rawBars = (symbol: string, close: number) => ({ bars: { [symbol]: may.map((d) => ({ t: `${d}T04:00:00Z`, c: close })) }, nextPageToken: null });

  it("a 2:1 split: days before it scale by 2 (raw 100 over adjusted 50), days after it by 1", async () => {
    // Adjusted history is halved before the split on 2026-05-15; the raw listed prices are not.
    putDaily("TWO", may.map((d) => [d, d < "2026-05-15" ? 50 : 100] as [string, number]));
    stockBarsPage.mockResolvedValue(rawBars("TWO", 100));
    const f = await op.rawPriceFactors("TWO", "2026-05-04", "2026-05-29", { requests: 0 });
    expect(f("2026-05-12")).toBe(2);
    expect(f("2026-05-20")).toBe(1);
  });

  it("a 10:1 split: the factor is 10 and a 0.8% difference is treated as no split", async () => {
    putDaily("TEN", may.map((d) => [d, 10] as [string, number]));
    stockBarsPage.mockResolvedValue(rawBars("TEN", 100));
    expect((await op.rawPriceFactors("TEN", "2026-05-04", "2026-05-29", { requests: 0 }))("2026-05-20")).toBe(10);
    putDaily("NOSPLIT", may.map((d) => [d, 100 / 1.008] as [string, number]));
    stockBarsPage.mockResolvedValue(rawBars("NOSPLIT", 100));
    expect((await op.rawPriceFactors("NOSPLIT", "2026-05-04", "2026-05-29", { requests: 0 }))("2026-05-20")).toBe(1);
  });

  it("without adjusted bars to compare, the factor is 1 and no raw bars are requested", async () => {
    stockBarsPage.mockClear();
    const f = await op.rawPriceFactors("NEVERSEEN", "2026-05-04", "2026-05-29", { requests: 0 });
    expect(f("2026-05-20")).toBe(1);
    expect(stockBarsPage).not.toHaveBeenCalled();
  });

  it("scales the event's stock spots into raw terms, so the listed strike nearest the raw spot is chosen", () => {
    const factor = (day: string) => (day < "2026-05-15" ? 2 : 1);
    const ev = { symbol: "TWO", reportDate: "2026-05-14", t0: "2026-05-13", r: "2026-05-14", spots: { "T0-5": 50.2, "T0:10:00": 50.4 } as Record<string, number> };
    const raw = op.toRawSpots(ev, factor);
    expect(raw.spots["T0-5"]).toBeCloseTo(100.4, 6);
    expect(raw.spots["T0:10:00"]).toBeCloseTo(100.8, 6);
    // Listed strikes are raw: 90 to 110. Using the adjusted 50.2 would pick 90; the raw 100.4 picks 100.
    const contract = (strike: number, type: "call" | "put"): OptionContract => ({
      occ: `TWO26${type === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`, underlying: "TWO", expiry: "2026-05-15", type, strike, status: "inactive", openInterest: null,
    });
    const contracts = [90, 95, 100, 105, 110].flatMap((k) => [contract(k, "call"), contract(k, "put")]);
    const lookup = { daily: (_occ: string, day: string) => (day === "2026-05-06" ? { t: day, o: 1, h: 1, l: 1, c: 1, v: 5 } : undefined), intraday: () => undefined };
    const adjusted = op.buildLegPaths({ ...ev, spots: { "T0-5": 50.2 } as Record<string, number> }, contracts, lookup, 0.04);
    const rawPaths = op.buildLegPaths(raw, contracts, lookup, 0.04);
    expect(adjusted.find((p) => p.expiryKind === "event" && p.leg === "atm_call")!.strike).toBe(90);
    expect(rawPaths.find((p) => p.expiryKind === "event" && p.leg === "atm_call")!.strike).toBe(100);
  });
});

describe("a fixed contract tracked across anchors with gaps", () => {
  const mk = (strike: number): OptionContract => ({ occ: `GAP26C${String(strike * 1000).padStart(8, "0")}`, underlying: "GAP", expiry: "2026-07-24", type: "call", strike, status: "inactive", openInterest: null });
  const contracts = [95, 100, 105].map(mk);
  const ev = { symbol: "GAP", reportDate: "2026-07-23", t0: "2026-07-23", r: "2026-07-24", spots: { "T0-5": 100.4 } as Record<string, number> };

  it("keeps the same contract at every anchor and reports a null for the missing day, not a different strike", () => {
    // Bars on T0-5 (07-16), T0-1 (07-22), T0 (07-23) and R (07-24). T0-2 (07-21) is missing for every strike.
    const days = ["2026-07-16", "2026-07-22", "2026-07-23", "2026-07-24"];
    const lookup = {
      daily: (occ: string, day: string) => (days.includes(day) ? { t: day, o: 2, h: 2, l: 2, c: occ.endsWith("00100000") ? 2.5 : 1, v: 9 } : undefined),
      intraday: () => undefined,
    };
    const paths = op.buildLegPaths(ev, contracts, lookup, 0.04);
    const leg = paths.find((p) => p.entry === "T0-5" && p.expiryKind === "event" && p.leg === "atm_call")!;
    expect(leg.strike).toBe(100);
    expect(leg.contract).toBe("GAP26C00100000");
    expect(leg.prices["T0-5"]).toBe(2.5);
    expect(leg.prices["T0-2"]).toBeNull(); // the gap
    expect(leg.prices["T0-1"]).toBe(2.5);
    expect(leg.prices["T0:close"]).toBe(2.5);
    expect(leg.prices["R:close"]).toBe(2.5);
    expect(leg.prices["T0:15:45"]).toBeNull(); // no intraday bars at all
    // Every anchor the leg tracks is priced from that one contract, so there is one contract for the whole path.
    expect(new Set(paths.filter((p) => p.entry === "T0-5" && p.expiryKind === "event" && p.leg === "atm_call").map((p) => p.contract))).toEqual(new Set(["GAP26C00100000"]));
  });
});

describe("option backfill floor", () => {
  it("an event before Alpaca's option history is never fetched, even with an earlier --since", async () => {
    edb.prepare("INSERT OR REPLACE INTO events (symbol, report_date, time, t0, r, confirmed, reason) VALUES ('OLD','2023-10-23','amc','2023-10-23','2023-10-24',1,'ok')").run();
    edb.prepare("INSERT OR REPLACE INTO stock_paths (symbol, report_date, t0_m20, t0_m10, t0_m5, t0_m2, t0_m1, t0_open, t0_1000, t0_1545, t0_close, r_open, r_close) VALUES ('OLD','2023-10-23',1,1,1,1,1,1,1,1,1,1,1)").run();
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await op.backfillOptions(["OLD"], { since: "2017-01-01" });
      expect(res).toEqual({ events: 0, legs: 0, requests: 0, errors: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
