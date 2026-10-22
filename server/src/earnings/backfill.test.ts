import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarningsCalendarRow } from "../providers/fmp.js";

const earningsReports = vi.fn<(symbol: string, limit?: number, opts?: unknown) => Promise<EarningsCalendarRow[]>>();
const earningsCalendar = vi.fn<(from: string, to: string, opts?: unknown) => Promise<EarningsCalendarRow[]>>();
vi.mock("../providers/fmp.js", () => ({
  earningsReports,
  earningsCalendar,
  transcriptDates: vi.fn(async () => []),
  pressReleases: vi.fn(async () => []),
  grades: vi.fn(async () => []),
  priceTargetNews: vi.fn(async () => []),
  isConfigured: () => true,
}));
vi.mock("../providers/alpaca.js", async (orig) => ({
  ...(await orig<typeof import("../providers/alpaca.js")>()),
  stockBars: async function* () {
    yield {};
  },
}));

let tmpDir: string;
let backfill: typeof import("./backfill.js");
let jobs: typeof import("./jobs.js");
let edb: typeof import("./db.js").earningsDb;
let db: typeof import("../db.js").db;

const days: string[] = [];
for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 86_400_000) {
  const dow = new Date(d).getUTCDay();
  if (dow !== 0 && dow !== 6) days.push(new Date(d).toISOString().slice(0, 10));
}
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
const row = (symbol: string, date: string): EarningsCalendarRow => ({ symbol, date: day(date), epsActual: 1, epsEstimated: 1, revenueActual: 1, revenueEstimated: 1, time: "amc", confirmed: true, fiscalPeriod: "Q1", fiscalYear: 2026, periodEnding: null });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-backfill-test-"));
  process.env.DATA_DIR = tmpDir;
  db = (await import("../db.js")).db;
  edb = (await import("./db.js")).earningsDb;
  await import("../history/store.js");
  await import("../research/bulk-store.js");
  const cal = await import("../providers/alpaca-calendar.js");
  cal.loadCalendarRows(2026, days.map((date) => ({ date, open: "09:30", close: "16:00" })));
  backfill = await import("./backfill.js");
  jobs = await import("./jobs.js");
  const ins = db.prepare("INSERT INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?, ?, 100, 101, 99, 100, ?)");
  for (const s of ["AAA", "BBB"]) for (const d of days) ins.run(s, d, d === "2026-05-07" ? 9000 : 1000);
  const prof = db.prepare("INSERT INTO bulk_profiles (symbol, exchange, is_etf, is_fund, is_actively_trading, data, updated_at) VALUES (?, 'NASDAQ', 0, 0, 1, '{}', 'x')");
  prof.run("AAA");
  prof.run("BBB");
});

afterAll(() => {
  db.close();
  edb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  edb.exec("DELETE FROM events; DELETE FROM stock_paths; DELETE FROM backfill_progress; DELETE FROM upcoming");
  earningsReports.mockReset();
  earningsCalendar.mockReset().mockResolvedValue([]);
});

const opts = { since: "2026-01-01", today: "2026-10-21" };

describe("backfill resume", () => {
  it("skips symbols already done, retries errored ones, and reports totals", async () => {
    earningsReports.mockImplementation(async (s) => {
      if (s === "BBB") throw new Error("fmp down");
      return [row("AAA", "2026-05-06")];
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await backfill.runEvents(["AAA", "BBB"], opts);
    expect(first.totals).toMatchObject({ symbols: 2, errors: 1, events: 1, confirmed: 1 });
    expect(edb.prepare("SELECT symbol, status FROM backfill_progress WHERE task = 'events' ORDER BY symbol").all()).toEqual([
      { symbol: "AAA", status: "done" },
      { symbol: "BBB", status: "error" },
    ]);

    earningsReports.mockReset().mockImplementation(async (s) => [row(s, "2026-05-06")]);
    const second = await backfill.runEvents(["AAA", "BBB"], opts);
    spy.mockRestore();
    expect(second.totals).toMatchObject({ symbols: 1, skipped: 1, errors: 0, events: 1 });
    expect(earningsReports).toHaveBeenCalledTimes(1);
    expect(earningsReports).toHaveBeenCalledWith("BBB", 80, { includeReportTimes: true });
    expect(edb.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 2 });
  });

  it("runs the stock phase for stored events, once, and is idempotent", async () => {
    earningsReports.mockImplementation(async (s) => [row(s, "2026-05-06")]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await backfill.runEvents(["AAA", "BBB"], opts);
    const stock = await backfill.runStock(["AAA", "BBB"], { today: opts.today });
    expect(stock).toMatchObject({ symbols: 2, stockPaths: 2, errors: 0 });
    const again = await backfill.runStock(["AAA", "BBB"], { today: opts.today });
    spy.mockRestore();
    expect(again).toMatchObject({ symbols: 0, skipped: 2, stockPaths: 0 });
    expect(edb.prepare("SELECT symbol, r_volume_ratio FROM stock_paths ORDER BY symbol").all()).toEqual([
      { symbol: "AAA", r_volume_ratio: 9 },
      { symbol: "BBB", r_volume_ratio: 9 },
    ]);
  });

  it("applies the request caps from the backfill variables", () => {
    process.env.EARNINGS_BACKFILL_ALPACA_PER_MIN = "1234";
    delete process.env.EARNINGS_BACKFILL_FMP_PER_MIN;
    backfill.applyCaps();
    expect(process.env.ALPACA_MAX_REQ_PER_MIN).toBe("1234");
    expect(process.env.FMP_MAX_REQ_PER_MIN).toBe("1500");
    delete process.env.EARNINGS_BACKFILL_ALPACA_PER_MIN;
    delete process.env.ALPACA_MAX_REQ_PER_MIN;
    delete process.env.FMP_MAX_REQ_PER_MIN;
  });
});

describe("nightly job", () => {
  it("is due after 18:30 New York time on a trading day, once", () => {
    expect(jobs.isDue(new Date("2026-10-21T22:00:00Z"), null)).toBe(false); // 18:00 ET
    expect(jobs.isDue(new Date("2026-10-21T22:31:00Z"), null)).toBe(true);
    expect(jobs.isDue(new Date("2026-10-21T22:31:00Z"), "2026-10-21T22:40:00.000Z")).toBe(false);
    expect(jobs.isDue(new Date("2026-10-22T22:31:00Z"), "2026-10-21T22:40:00.000Z")).toBe(true);
    expect(jobs.isDue(new Date("2026-10-24T22:31:00Z"), null)).toBe(false); // Saturday
  });

  it("stores new reports, refreshes upcoming, calls the hooks and records the run", async () => {
    earningsCalendar.mockImplementation(async (from) =>
      from < "2026-10-21" ? [row("AAA", "2026-10-20")] : from === "2026-10-21" ? [{ ...row("BBB", "2026-10-30"), epsActual: null }] : []
    );
    earningsReports.mockImplementation(async (s) => [row(s, "2026-10-20")]);
    const afterNewEvents = vi.fn(async () => {});
    const afterNightly = vi.fn(async () => {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await jobs.runNightly("2026-10-21", { afterNewEvents, afterNightly });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nightly 2026-10-21: 1 reporters, 1 new events"));
    spy.mockRestore();
    expect(s).toMatchObject({ symbols: 1, newEvents: 1, upcoming: 1, failed: 0 });
    expect(afterNewEvents).toHaveBeenCalledWith([{ symbol: "AAA", reportDate: "2026-10-20" }]);
    expect(afterNightly).toHaveBeenCalledTimes(1);
    expect(edb.prepare("SELECT symbol FROM upcoming").all()).toEqual([{ symbol: "BBB" }]);
    expect(jobs.lastNightly()).toMatchObject({ newEvents: 1 });
  });
});
