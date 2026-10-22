import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar } from "../providers/alpaca.js";

const stockBars = vi.fn<(opts: { symbols: string[]; timeframe: string; start: string; end?: string }) => AsyncGenerator<Record<string, Bar[]>>>();
vi.mock("../providers/alpaca.js", async (orig) => ({ ...(await orig<typeof import("../providers/alpaca.js")>()), stockBars }));

let tmpDir: string;
let paths: typeof import("./stock-paths.js");
let edb: typeof import("./db.js").earningsDb;
let db: typeof import("../db.js").db;

const HOLIDAYS = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
const sessionDays: string[] = [];
for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 86_400_000) {
  const dow = new Date(d).getUTCDay();
  const day = new Date(d).toISOString().slice(0, 10);
  if (dow !== 0 && dow !== 6 && !HOLIDAYS.includes(day)) sessionDays.push(day);
}
const at = (day: string, n: number) => sessionDays[sessionDays.indexOf(day) + n];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-stockpaths-test-"));
  process.env.DATA_DIR = tmpDir;
  db = (await import("../db.js")).db;
  edb = (await import("./db.js")).earningsDb;
  await import("../history/store.js");
  const cal = await import("../providers/alpaca-calendar.js");
  cal.loadCalendarRows(2026, sessionDays.map((date) => ({ date, open: "09:30", close: "16:00" })));
  paths = await import("./stock-paths.js");
});

afterAll(() => {
  db.close();
  edb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** Close = 100 + session number, open = close - 0.5, volume 1000 except `volumes`; no bar on `missing`. */
function bars(symbol: string, volumes: Record<string, number> = {}, missing: string[] = []): void {
  db.prepare("DELETE FROM daily_bars WHERE symbol = ?").run(symbol);
  const ins = db.prepare("INSERT INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)");
  sessionDays.forEach((day, i) => {
    if (!missing.includes(day)) ins.run(symbol, day, 100 + i - 0.5, 100 + i + 1, 100 + i - 1, 100 + i, volumes[day] ?? 1000);
  });
}
const closeOf = (day: string) => 100 + sessionDays.indexOf(day);
const bar = (utcStart: string, c: number): Bar => ({ t: utcStart, o: c, h: c, l: c, c, v: 100 });

beforeEach(() => {
  edb.exec("DELETE FROM stock_paths");
  stockBars.mockReset();
});

describe("daily anchors", () => {
  const t0 = "2026-05-06";
  const r = "2026-05-07";

  it("reads every anchor from the daily bars, with prevClose, volume ratio and ATR", () => {
    bars("X", { [r]: 4000 });
    const p = paths.dailyPath(paths.loadDaily("X"), t0, r);
    expect(p).toMatchObject({
      "T0-20": closeOf(at(t0, -20)), "T0-10": closeOf(at(t0, -10)), "T0-5": closeOf(at(t0, -5)), "T0-2": closeOf(at(t0, -2)), "T0-1": closeOf(at(t0, -1)),
      "T0:open": closeOf(t0) - 0.5, "T0:close": closeOf(t0), "R:open": closeOf(r) - 0.5, "R:close": closeOf(r),
      "R+5": closeOf(at(r, 5)), "R+20": closeOf(at(r, 20)),
      prevClose: closeOf(t0), rVolumeRatio: 4,
    });
    expect(p.atr14Pct).toBeCloseTo((2 / closeOf(t0)) * 100, 3); // range 2, gaps 1: true range 2 each day
  });

  it("gives null for an anchor whose bar is missing, without shifting to another day", () => {
    bars("X", {}, [at(t0, -5), at(r, 5)]);
    const p = paths.dailyPath(paths.loadDaily("X"), t0, r);
    expect(p["T0-5"]).toBeNull();
    expect(p["R+5"]).toBeNull();
    expect(p["T0-10"]).toBe(closeOf(at(t0, -10)));
    expect(p["R+20"]).toBe(closeOf(at(r, 20)));
  });

  it("for a dmh report (R is T0) prevClose is the session before and the volume baseline excludes the day", () => {
    bars("X", { [t0]: 3000 });
    const p = paths.dailyPath(paths.loadDaily("X"), t0, t0);
    expect(p.prevClose).toBe(closeOf(at(t0, -1)));
    expect(p.rVolumeRatio).toBe(3);
    expect(p["R:close"]).toBe(p["T0:close"]);
  });

  it("returns null ratios when R has no bar or the baseline is thin", () => {
    bars("X", {}, [r]);
    expect(paths.reaction(paths.loadDaily("X"), t0, r)).toBeNull();
    expect(paths.dailyPath(paths.loadDaily("X"), t0, r).rVolumeRatio).toBeNull();
    bars("Y");
    db.prepare("DELETE FROM daily_bars WHERE symbol = 'Y' AND day < ?").run(at(t0, -4));
    expect(paths.dailyPath(paths.loadDaily("Y"), t0, r).rVolumeRatio).toBeNull();
  });
});

describe("intraday anchors", () => {
  // 2026-05-06 is EDT: 09:45 New York is 13:45Z, 15:30 is 19:30Z.
  it("takes the close of the bar ending at the anchor, else the last bar within 45 minutes, else null", () => {
    const end10 = Date.parse("2026-05-06T14:00:00Z");
    expect(paths.barClose([bar("2026-05-06T13:45:00Z", 10), bar("2026-05-06T13:30:00Z", 9)], end10)).toBe(10);
    expect(paths.barClose([bar("2026-05-06T13:30:00Z", 9), bar("2026-05-06T13:15:00Z", 8)], end10)).toBe(9); // bar ending 09:45
    expect(paths.barClose([bar("2026-05-06T13:00:00Z", 7)], end10)).toBe(7); // ends 09:15, 45 minutes before: still ok
    expect(paths.barClose([bar("2026-05-06T12:45:00Z", 6)], end10)).toBeNull(); // 60 minutes
    expect(paths.barClose([bar("2026-05-06T14:00:00Z", 11)], end10)).toBeNull(); // later bars never count
    expect(paths.barClose([], end10)).toBeNull();
  });

  it("fetches one multi-symbol request per T0 date and stores the 10:00 and 15:45 closes", async () => {
    bars("AAA");
    bars("BBB");
    bars("CCC", {}, [at("2026-05-06", 1)]); // R close missing but R is old: still stored
    stockBars.mockImplementation(async function* (opts) {
      const out: Record<string, Bar[]> = {};
      for (const s of opts.symbols) {
        if (s === "BBB") continue; // no intraday bars at all
        out[s] = [bar("2026-05-06T13:45:00Z", s === "AAA" ? 11 : 21), bar("2026-05-06T19:30:00Z", s === "AAA" ? 12 : 22)];
      }
      yield out;
    });
    const events = [
      { symbol: "AAA", reportDate: "2026-05-06", t0: "2026-05-06", r: "2026-05-07" },
      { symbol: "BBB", reportDate: "2026-05-06", t0: "2026-05-06", r: "2026-05-07" },
      { symbol: "CCC", reportDate: "2026-05-06", t0: "2026-05-06", r: "2026-05-07" },
    ];
    const res = await paths.buildStockPaths(events, "2026-10-21");
    expect(res).toEqual({ stored: 3, skipped: 0 });
    expect(stockBars).toHaveBeenCalledTimes(1);
    expect(stockBars.mock.calls[0][0]).toMatchObject({ symbols: ["AAA", "BBB", "CCC"], timeframe: "15Min" });
    const row = (s: string) => edb.prepare("SELECT * FROM stock_paths WHERE symbol = ?").get(s) as Record<string, number | null>;
    expect(row("AAA")).toMatchObject({ t0_1000: 11, t0_1545: 12, t0_close: closeOf("2026-05-06"), r_close: closeOf("2026-05-07"), prev_close: closeOf("2026-05-06") });
    expect(row("BBB")).toMatchObject({ t0_1000: null, t0_1545: null, t0_close: closeOf("2026-05-06") });
    expect(row("CCC")).toMatchObject({ t0_1000: 21, r_close: null });
  });

  it("holds back a recent event whose R bar has not landed yet", async () => {
    bars("AAA", {}, ["2026-10-20"]);
    stockBars.mockImplementation(async function* () {
      yield {};
    });
    const res = await paths.buildStockPaths([{ symbol: "AAA", reportDate: "2026-10-19", t0: "2026-10-19", r: "2026-10-20" }], "2026-10-21");
    expect(res).toEqual({ stored: 0, skipped: 1 });
  });
});
