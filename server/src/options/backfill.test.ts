import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IvDay } from "./store.js";

let tmpDir: string;
let bf: typeof import("./backfill.js");
let bs: typeof import("./black-scholes.js");
let sel: typeof import("./selection.js");
let cal: typeof import("../providers/alpaca-calendar.js");
let store: typeof import("./store.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-options-backfill-test-"));
  process.env.DATA_DIR = tmpDir;
  bf = await import("./backfill.js");
  bs = await import("./black-scholes.js");
  sel = await import("./selection.js");
  cal = await import("../providers/alpaca-calendar.js");
  store = await import("./store.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("expiries and strikes", () => {
  it("finds the third Friday, stepping back over a holiday", () => {
    expect(bf.monthlyExpiry(2026, 10)).toBe("2026-10-16");
    expect(bf.monthlyExpiry(2026, 11)).toBe("2026-11-20");
    // Good Friday 2025 was the third Friday of April.
    cal.loadCalendarRows(2025, [{ date: "2025-04-17", open: "09:30", close: "16:00" }]);
    try {
      expect(bf.monthlyExpiry(2025, 4)).toBe("2025-04-17");
    } finally {
      cal.resetCalendar();
    }
  });

  it("brackets 30 days with monthly expiries", () => {
    expect(bf.bracketExpiries("2026-10-05")).toEqual(["2026-10-16", "2026-11-20"]); // 11 and 46 days
    expect(bf.bracketExpiries("2026-10-21")).toEqual(["2026-11-20"]); // exactly 30 days
    expect(bf.bracketExpiries("2026-10-15")).toEqual(["2026-11-20"]); // the Oct expiry is 1 day out: too close
  });

  it("tries strikes on the grids for the price level, nearest first", () => {
    const s = bf.candidateStrikes(100.4);
    expect(s[0]).toBe(100);
    expect(s).toContain(102.5);
    expect(s).toContain(105);
    expect(bf.candidateStrikes(10.2)[0]).toBe(10);
    expect(bf.candidateStrikes(773.14)).toContain(775);
  });
});

/** Closes of a Black-Scholes world: every contract trades at the price a flat vol gives. */
function fakeBar(vol: (day: string) => number, spotOn: (day: string) => number, volume = 50) {
  return (occ: string, day: string) => {
    const p = parseOccLocal(occ);
    const t = Math.max(cal.sessionClose(p.expiry) - cal.sessionClose(day), 60_000) / (365 * 86_400_000);
    const c = bs.price({ right: p.right, spot: spotOn(day), strike: p.strike, t, rate: bs.riskFreeRate(), vol: vol(day) });
    return { c: Math.round(c * 1e4) / 1e4, v: volume };
  };
}
function parseOccLocal(occ: string) {
  const m = occ.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)!;
  return { expiry: `20${m[2]}-${m[3]}-${m[4]}`, right: (m[5] === "C" ? "call" : "put") as "call" | "put", strike: Number(m[6]) / 1000 };
}

describe("dayIv", () => {
  const day = "2026-10-05";
  let expiries: string[] = [];
  beforeAll(() => {
    expiries = bf.bracketExpiries(day);
  });

  it("recovers a flat vol from the contracts' closes", () => {
    const r = bf.dayIv("AAA", day, 100.4, expiries, fakeBar(() => 0.25, () => 100.4));
    expect(r.legs).toBe(4);
    expect(r.iv30).toBeCloseTo(0.25, 2);
  });

  it("needs at least two legs and ignores zero-volume closes", () => {
    const priced = fakeBar(() => 0.25, () => 100.4);
    const onlyOne = (occ: string, d: string) => (occ === sel.buildOcc("AAA", expiries[0], "call", 100) ? priced(occ, d) : undefined);
    expect(bf.dayIv("AAA", day, 100.4, expiries, onlyOne)).toEqual({ iv30: null, legs: 1 });
    const stale = fakeBar(() => 0.25, () => 100.4, 0);
    expect(bf.dayIv("AAA", day, 100.4, expiries, stale)).toEqual({ iv30: null, legs: 0 });
  });

  it("falls back to a one-sided strike when only a call exists", () => {
    const priced = fakeBar(() => 0.3, () => 100.4);
    const callsOnly = (occ: string, d: string) => (occ.includes("C") && /C\d{8}$/.test(occ) ? priced(occ, d) : undefined);
    const r = bf.dayIv("AAA", day, 100.4, expiries, callsOnly);
    expect(r.legs).toBe(2); // one call per expiry
    expect(r.iv30).toBeCloseTo(0.3, 2);
  });
});

describe("backfillUnderlying", () => {
  // 30 weekdays ending 2026-10-16.
  const closes: Array<{ day: string; close: number }> = [];
  for (let d = Date.parse("2026-09-07T00:00:00Z"); closes.length < 30; d += 86_400_000) {
    const day = new Date(d).toISOString().slice(0, 10);
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) closes.push({ day, close: 100 + closes.length * 0.1 });
  }
  const spotOn = (day: string) => closes.find((c) => c.day === day)!.close;

  it("batches contracts, writes a row per day and leaves today to the sweep", async () => {
    const priced = fakeBar(() => 0.22, spotOn);
    const calls: Array<{ n: number; start: string; end: string }> = [];
    const written: IvDay[][] = [];
    const r = await bf.backfillUnderlying("AAA", {
      closes: () => closes,
      today: closes[closes.length - 1].day,
      concurrency: 1,
      bars: async (symbols, start, end, stats) => {
        stats.requests++;
        calls.push({ n: symbols.length, start, end });
        const out: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> = {};
        for (const occ of symbols) {
          for (const c of closes) {
            if (c.day < start || c.day > end) continue;
            const p = parseOccLocal(occ);
            if (p.strike !== Math.round(spotOn(c.day)) && p.strike !== 100 && p.strike !== 101) continue; // only some strikes exist
            if (p.expiry < c.day) continue;
            const b = priced(occ, c.day);
            (out[occ] ??= []).push({ t: `${c.day}T04:00:00Z`, o: b.c, h: b.c, l: b.c, c: b.c, v: b.v });
          }
        }
        return out;
      },
      write: (rows) => written.push(rows),
    });
    expect(r.days).toBe(29); // today (the last close) is excluded
    expect(r.rows).toBe(29);
    expect(r.requests).toBe(calls.length);
    expect(calls.every((c) => c.n <= 200)).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const rows = written[0];
    expect(rows).toHaveLength(29);
    for (const row of rows) expect(row.iv30!).toBeCloseTo(0.22, 2);
    expect(rows[0].hv20).toBeNull(); // fewer than 21 closes up to the first day
    expect(rows[rows.length - 1].hv20).not.toBeNull();
  });

  it("skips days with no usable contracts", async () => {
    const written: IvDay[][] = [];
    const r = await bf.backfillUnderlying("AAA", {
      closes: () => closes,
      today: closes[closes.length - 1].day,
      bars: async () => ({}),
      write: (rows) => written.push(rows),
    });
    expect(r.rows).toBe(0);
    expect(written[0]).toEqual([]);
  });
});

describe("iv_history source", () => {
  it("never lets a backfilled row replace a live one", () => {
    const row = (iv30: number, source?: "live" | "backfill") => ({ symbol: "SRC", day: "2026-09-01", iv30, atmIv: null, hv20: null, source });
    store.upsertBackfillDays([row(0.2)]);
    expect(store.ivHistory("SRC")[0]).toMatchObject({ iv30: 0.2, source: "backfill" });
    store.upsertBackfillDays([row(0.21)]);
    expect(store.ivHistory("SRC")[0].iv30).toBe(0.21); // backfill over backfill
    store.upsertIvDay(row(0.3));
    expect(store.ivHistory("SRC")[0]).toMatchObject({ iv30: 0.3, source: "live" }); // live wins
    store.upsertBackfillDays([row(0.25)]);
    expect(store.ivHistory("SRC")[0]).toMatchObject({ iv30: 0.3, source: "live" });
    expect(store.ivHistoryCount("SRC")).toBe(1);
  });
});
