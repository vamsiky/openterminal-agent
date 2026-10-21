import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bar as AlpacaBar } from "../providers/alpaca.js";

let tmpDir: string;
let hourly: typeof import("./hourly.js");
let db: typeof import("../db.js").db;

const NOW = new Date("2026-10-21T11:00:00Z"); // 07:00 New York
// EDT: 09:00 New York is 13:00Z.
const bar = (day: string, utcHour: number, c: number): AlpacaBar => ({ t: `${day}T${String(utcHour).padStart(2, "0")}:00:00Z`, o: c, h: c + 1, l: c - 1, c, v: 1000, vw: c });
const session = (day: string, base: number) => [8, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23].map((h, i) => bar(day, h, base + i)); // 04:00 and 08:00 pre-market, 16:00 and 19:00 after hours

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-hourly-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  hourly = await import("./hourly.js");
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("refreshHourly", () => {
  it("stores regular-session hours only, counts requests, and prunes old rows", async () => {
    const calls: Array<{ symbols: string[]; start: string }> = [];
    const fetchBars = async function* (symbols: string[], start: string) {
      calls.push({ symbols, start });
      // Two pages per request.
      yield Object.fromEntries(symbols.map((s) => [s, session("2026-10-20", 100)]));
      yield Object.fromEntries(symbols.map((s) => [s, [...session("2026-10-19", 90), bar("2026-08-01", 14, 50)]]));
    };
    expect(hourly.hourlyNeeded(["AAA"], NOW)).toBe(true);
    const syms = Array.from({ length: 130 }, (_, i) => `S${i}`);
    const r = await hourly.refreshHourly(syms, NOW, fetchBars);
    expect(r).toMatchObject({ symbols: 130, requests: 4 }); // 100 + 30 symbols, 2 pages each
    expect(calls.map((c) => c.symbols.length)).toEqual([100, 30]);
    expect(calls[0].start).toBe("2026-09-06T11:00:00.000Z"); // 45 days back
    const rows = db.prepare("SELECT ts FROM hourly_bars WHERE symbol = 'S0' ORDER BY ts").all() as Array<{ ts: number }>;
    // Kept: 09:00–15:00 New York, 13Z..19Z; the pre-market and after-hours bars are dropped.
    expect(rows.map((x) => new Date(x.ts * 1000).getUTCHours())).toEqual([13, 14, 15, 16, 17, 18, 19, 13, 14, 15, 16, 17, 18, 19]);
    expect(rows.some((x) => new Date(x.ts * 1000).toISOString().startsWith("2026-08-01"))).toBe(false); // pruned
    expect(hourly.hourlyNeeded(syms, NOW)).toBe(false);
    expect(hourly.hourlyNeeded([...syms, "NEWCO"], NOW)).toBe(true); // a symbol with nothing cached
    expect(hourly.hourlyNeeded(syms, new Date(NOW.getTime() + 86_400_000))).toBe(true); // a new day
  });
});

describe("hourlySeries", () => {
  it("joins cached hours of earlier days with today's hours built from minute bars", () => {
    const openToday = Date.UTC(2026, 9, 21, 13, 30) / 1000;
    const minute = Array.from({ length: 100 }, (_, m) => ({ ts: openToday + m * 60, open: 200, high: 201 + m, low: 199, close: 200 + m, volume: 10 }));
    const series = hourly.hourlySeries("S0", minute, "2026-10-21", openToday + 6000);
    const todays = series.filter((b) => b.ts! >= openToday - 1800);
    // 09:30–10:00 falls in the 09:00 hour, then 10:00–11:00 and 11:00–11:10.
    expect(todays.map((b) => (b.ts! - (openToday - 1800)) / 3600)).toEqual([0, 1, 2]);
    expect(todays[0]).toMatchObject({ open: 200, close: 229, volume: 300 });
    expect(todays[1].volume).toBe(600);
    expect(series.length).toBe(14 + 3);
    expect(series[0].ts!).toBeLessThan(openToday - 86_400);
  });
});

describe("hourlyPlan", () => {
  const day2 = new Date("2026-10-22T11:00:00Z");
  const empty = async function* () {
    yield {};
  };

  it("asks for a symbol with no bars once a day, and only fetches the missing ones afterwards", async () => {
    const seen: string[][] = [];
    const fetchBars = async function* (symbols: string[]) {
      seen.push(symbols);
      yield Object.fromEntries(symbols.filter((s) => s !== "NOBARS").map((s) => [s, session("2026-10-21", 100)]));
    };
    const universe = ["HAS1", "HAS2", "NOBARS"];
    expect(hourly.hourlyPlan(universe, day2)).toEqual({ mode: "daily", symbols: universe });
    await hourly.refreshHourly(universe, day2, fetchBars);
    // NOBARS has nothing cached, but it was asked for today: no plan, so no refetch on the next tick.
    expect(hourly.hourlyPlan(universe, day2)).toBeNull();
    expect(hourly.hourlyNeeded(universe, day2)).toBe(false);

    // A symbol new to the universe is fetched alone, as a missing-mode run that leaves the daily mark alone.
    const plan = hourly.hourlyPlan([...universe, "NEWCO"], day2)!;
    expect(plan).toEqual({ mode: "missing", symbols: ["NEWCO"] });
    await hourly.refreshHourly(plan.symbols, day2, fetchBars, false);
    expect(seen[seen.length - 1]).toEqual(["NEWCO"]);
    expect(hourly.hourlyPlan([...universe, "NEWCO"], day2)).toBeNull();

    // The next day everything is asked for again, including NOBARS.
    const day3 = new Date(day2.getTime() + 86_400_000);
    expect(hourly.hourlyPlan(universe, day3)).toEqual({ mode: "daily", symbols: universe });
  });

  it("resumes a run cut short: symbols already asked for today are not fetched again", async () => {
    const day4 = new Date("2026-10-26T11:00:00Z");
    const universe = Array.from({ length: 150 }, (_, i) => `R${i}`);
    let batches = 0;
    const dies = async function* (symbols: string[]) {
      if (++batches === 2) throw new Error("connection reset");
      yield Object.fromEntries(symbols.map((s) => [s, session("2026-10-23", 100)]));
    };
    await expect(hourly.refreshHourly(universe, day4, dies)).rejects.toThrow("connection reset");
    const plan = hourly.hourlyPlan(universe, day4)!;
    expect(plan).toEqual({ mode: "daily", symbols: universe.slice(100) }); // the first batch of 100 finished
    await hourly.refreshHourly(plan.symbols, day4, empty);
    expect(hourly.hourlyPlan(universe, day4)).toBeNull();
  });
});
