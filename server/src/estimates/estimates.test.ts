import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarningsCalendarRow } from "../providers/fmp.js";

const earningsCalendar = vi.fn<(from: string, to: string) => Promise<EarningsCalendarRow[]>>();
vi.mock("../providers/fmp.js", () => ({ earningsCalendar, isConfigured: () => true }));

let tmpDir: string;
let store: typeof import("./store.js");
let capture: typeof import("./capture.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-estimates-test-"));
  process.env.DATA_DIR = tmpDir;
  store = await import("./store.js");
  capture = await import("./capture.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const snap = (eps: number | null, revenue: number | null, symbol = "NVDA", reportDate = "2026-11-18") => ({ symbol, reportDate, eps, revenue });

describe("recordSnapshots", () => {
  it("stores the first capture and only later changes", () => {
    expect(store.recordSnapshots([snap(2.4, 100)], "2026-10-01")).toBe(1);
    expect(store.recordSnapshots([snap(2.4, 100)], "2026-10-02")).toBe(0);
    expect(store.recordSnapshots([snap(2.5, 100)], "2026-10-03")).toBe(1);
    expect(store.recordSnapshots([snap(2.5, 101)], "2026-10-04")).toBe(1);
    expect(store.recordSnapshots([snap(2.5, 101)], "2026-10-05")).toBe(0);
    expect(store.history("NVDA", "2026-11-18").map((p) => p.day)).toEqual(["2026-10-01", "2026-10-03", "2026-10-04"]);
  });

  it("tracks each report date separately and skips rows with no estimate", () => {
    expect(store.recordSnapshots([snap(1, 1, "AAPL", "2026-10-29"), snap(null, null, "MSFT", "2026-10-28")], "2026-10-01")).toBe(1);
    expect(store.history("MSFT", "2026-10-28")).toEqual([]);
    // Next quarter's report for the same symbol is a new key, so it is stored.
    expect(store.recordSnapshots([snap(1, 1, "AAPL", "2027-01-29")], "2026-10-02")).toBe(1);
  });
});

describe("revisions", () => {
  const pts = [
    { day: "2026-07-01", eps: 2.0, revenue: 100 },
    { day: "2026-09-20", eps: 2.2, revenue: 100 },
    { day: "2026-10-15", eps: 2.4, revenue: null },
  ];

  it("compares the latest estimate with the one in force N days ago", () => {
    const r = store.revisions(pts, "2026-10-20");
    expect(r["7d"].eps).toBeCloseTo((2.4 / 2.2 - 1) * 100); // in force on 10-13: the 09-20 row
    expect(r["30d"].eps).toBeCloseTo((2.4 / 2.2 - 1) * 100); // 09-20 row, exactly on the cutoff
    expect(r["60d"].eps).toBeCloseTo(20); // 08-21: the 07-01 row
    expect(r["7d"].revenue).toBeNull(); // latest revenue missing
    expect(r["60d"].revenue).toBeNull();
  });

  it("is null where tracking began later than the window", () => {
    const r = store.revisions(pts.slice(1), "2026-10-20"); // first capture 09-20
    expect(r["30d"].eps).not.toBeNull();
    expect(r["60d"]).toEqual({ eps: null, revenue: null });
    expect(r["90d"]).toEqual({ eps: null, revenue: null });
  });

  it("is all null with no history", () => {
    expect(store.revisions([], "2026-10-20")["7d"]).toEqual({ eps: null, revenue: null });
    expect(store.pctChange(0, 1)).toBeNull();
  });
});

describe("windows", () => {
  it("covers today through today + 120 in windows of at most 7 days", () => {
    const w = capture.windows("2026-10-20");
    expect(w[0]).toEqual(["2026-10-20", "2026-10-26"]);
    expect(w[1][0]).toBe("2026-10-27");
    expect(w[w.length - 1][1]).toBe("2027-02-17");
    for (const [from, to] of w) expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThanOrEqual(6);
    for (let i = 1; i < w.length; i++) expect(Date.parse(w[i][0]) - Date.parse(w[i - 1][1])).toBe(86_400_000);
  });
});

describe("pastWindows", () => {
  it("covers the 100 days before today in contiguous windows of at most 7 days", () => {
    const w = capture.pastWindows("2026-10-20");
    expect(w[0][0]).toBe("2026-07-12");
    expect(w[w.length - 1][1]).toBe("2026-10-19");
    for (const [from, to] of w) expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThanOrEqual(6);
    for (let i = 1; i < w.length; i++) expect(Date.parse(w[i][0]) - Date.parse(w[i - 1][1])).toBe(86_400_000);
  });
});

describe("captureDay", () => {
  beforeEach(() => earningsCalendar.mockReset());
  const row = (symbol: string, eps: number): EarningsCalendarRow => ({
    symbol,
    date: Date.parse("2026-11-18") / 1000,
    epsActual: null,
    epsEstimated: eps,
    revenueActual: null,
    revenueEstimated: 10,
  });

  it("runs once per day and skips the second call", async () => {
    earningsCalendar.mockResolvedValue([row("ZZZ", 1)]);
    const first = await capture.captureDay("2026-11-01");
    expect(first).toMatchObject({ failed: 0, stored: 1 });
    expect(earningsCalendar).toHaveBeenCalledTimes(capture.pastWindows("2026-11-01").length + capture.windows("2026-11-01").length);
    earningsCalendar.mockClear();
    expect(await capture.captureDay("2026-11-01")).toBeNull();
    expect(earningsCalendar).not.toHaveBeenCalled();
  });

  it("does not mark the day done when a window fails, and retries", async () => {
    earningsCalendar.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await capture.captureDay("2026-11-02");
    spy.mockRestore();
    expect(res?.failed).toBe(1);
    expect(store.hasRun("2026-11-02")).toBe(false);
    expect(await capture.captureDay("2026-11-02")).toMatchObject({ failed: 0 });
    expect(store.hasRun("2026-11-02")).toBe(true);
  });

  it("keeps past and future calendar rows and stamps them with the capture day", async () => {
    const past = (symbol: string): EarningsCalendarRow => ({ ...row(symbol, 1), date: Date.parse("2026-12-20") / 1000, epsActual: 1.1, revenueActual: 11 });
    earningsCalendar.mockImplementation(async (_from, to) => (to < "2026-12-25" ? [past("CAL")] : [row("CAL", 2)]));
    await capture.captureDay("2026-12-25");
    const rows = (await import("../db.js")).db.prepare("SELECT * FROM earnings_calendar WHERE symbol = 'CAL' ORDER BY report_date").all();
    expect(rows).toEqual([
      expect.objectContaining({ report_date: "2026-11-18", eps_estimate: 2, eps_actual: null, last_seen_day: "2026-12-25" }),
      expect.objectContaining({ report_date: "2026-12-20", eps_actual: 1.1, revenue_actual: 11, last_seen_day: "2026-12-25" }),
    ]);
    // Past windows add no estimate snapshots.
    expect(store.history("CAL", "2026-12-20")).toEqual([]);
    earningsCalendar.mockImplementation(async () => [{ ...row("CAL", 3) }]);
    await capture.captureDay("2026-12-26", true);
    const again = (await import("../db.js")).db.prepare("SELECT eps_estimate AS e, last_seen_day AS d FROM earnings_calendar WHERE symbol = 'CAL' AND report_date = '2026-11-18'").get();
    expect(again).toEqual({ e: 3, d: "2026-12-26" });
  });
});

describe("calendarFor", () => {
  const entry = (symbol: string, reportDate: string, seen: string, extra: Partial<Parameters<typeof store.recordCalendar>[0][0]> = {}) =>
    store.recordCalendar([{ symbol, reportDate, epsEstimate: 1, revenueEstimate: 10, epsActual: null, revenueActual: null, ...extra }], seen);

  it("ignores a future date that the latest capture no longer lists", () => {
    store.recordRun("2027-02-01", 0, 0);
    entry("MOVED", "2027-02-10", "2027-01-30"); // FMP listed it before, then moved the date
    entry("MOVED", "2027-02-17", "2027-02-01");
    entry("LAST", "2027-01-20", "2027-02-01", { epsActual: 1.2, revenueActual: 12 });
    entry("LAST", "2027-02-18", "2027-02-01");
    const [moved, last, none] = store.calendarFor(["MOVED", "LAST", "NONE"], "2027-02-05");
    expect(moved).toMatchObject({ nextEarningsDate: Date.parse("2027-02-17") / 1000, found: true });
    expect(last).toMatchObject({
      nextEarningsDate: Date.parse("2027-02-18") / 1000,
      lastEarningsDate: Date.parse("2027-01-20") / 1000,
      lastEps: 1.2,
      lastEpsEstimate: 1,
      lastRevenue: 12,
    });
    expect(last.lastSurprisePercent).toBeCloseTo(20);
    expect(none).toMatchObject({ found: false, nextEarningsDate: null, lastEarningsDate: null });
  });
});
