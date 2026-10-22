import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarningsCalendarRow, Grade, PriceTargetNews } from "../providers/fmp.js";

const earningsCalendar = vi.fn<(from: string, to: string, opts?: unknown) => Promise<EarningsCalendarRow[]>>();
const grades = vi.fn<(symbol: string) => Promise<Grade[]>>();
const priceTargetNews = vi.fn<(symbol: string) => Promise<PriceTargetNews[]>>();
vi.mock("../providers/fmp.js", () => ({ earningsCalendar, grades, priceTargetNews, pressReleases: vi.fn(async () => []), earningsReports: vi.fn(async () => []), isConfigured: () => true }));

vi.mock("../providers/alpaca-assets.js", () => ({ allAssets: async () => ["AMC","BMO","NOTIME","INFER","SPY","OTC1"].map((symbol) => ({ symbol, name: `${symbol} Common Stock`, exchange: "", type: "stock" })) }));

let tmpDir: string;
let up: typeof import("./upcoming.js");
let timing: typeof import("../estimates/timing.js");
let edb: typeof import("./db.js").earningsDb;
let db: typeof import("../db.js").db;

const today = "2026-10-21";
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
const cal = (symbol: string, date: string, time: "bmo" | "amc" | null, extra: Partial<EarningsCalendarRow> = {}): EarningsCalendarRow => ({
  symbol, date: day(date), epsActual: null, epsEstimated: 1.5, revenueActual: null, revenueEstimated: 100, time, confirmed: false, fiscalPeriod: "Q3", fiscalYear: 2026, periodEnding: "2026-09-30", ...extra,
});

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-upcoming-test-"));
  process.env.DATA_DIR = tmpDir;
  db = (await import("../db.js")).db;
  edb = (await import("./db.js")).earningsDb;
  await import("../research/bulk-store.js");
  timing = await import("../estimates/timing.js");
  up = await import("./upcoming.js");
  const ins = db.prepare("INSERT INTO bulk_profiles (symbol, exchange, is_etf, is_fund, is_actively_trading, data, updated_at) VALUES (?, ?, ?, ?, 1, '{}', 'x')");
  for (const [s, ex, etf] of [["AMC", "NASDAQ", 0], ["BMO", "NYSE", 0], ["NOTIME", "NASDAQ", 0], ["INFER", "NASDAQ", 0], ["SPY", "NYSE", 1], ["OTC1", "OTC", 0]] as const) ins.run(s, ex, etf, 0);
});

afterAll(() => {
  db.close();
  edb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  edb.exec("DELETE FROM upcoming; DELETE FROM analyst_actions; DELETE FROM backfill_progress");
  earningsCalendar.mockReset();
  grades.mockReset().mockResolvedValue([]);
  priceTargetNews.mockReset().mockResolvedValue([]);
});

describe("refreshUpcoming", () => {
  it("keeps US-listed unreported names with FMP's time, T0 and R, and drops the rest", async () => {
    earningsCalendar.mockImplementation(async (from) =>
      from !== today
        ? []
        : [
            cal("AMC", "2026-10-22", "amc", { confirmed: true }),
            cal("BMO", "2026-10-22", "bmo"),
            cal("SPY", "2026-10-22", null), // ETF
            cal("OTC1", "2026-10-22", "amc"), // not on a US exchange
            cal("000403.SZ", "2026-10-22", null), // foreign
            cal("AMC", "2026-07-30", "amc", { epsActual: 2 }), // already reported
          ]
    );
    const r = await up.refreshUpcoming(today);
    expect(r).toEqual({ rows: 2, failed: 0 });
    const rows = edb.prepare("SELECT * FROM upcoming ORDER BY symbol").all();
    expect(rows).toMatchObject([
      { symbol: "AMC", report_date: "2026-10-22", time: "amc", time_source: "fmp", t0: "2026-10-22", r: "2026-10-23", fmp_confirmed_flag: 1, fiscal_period: "Q3", eps_estimate: 1.5, revenue_estimate: 100 },
      { symbol: "BMO", time: "bmo", t0: "2026-10-21", r: "2026-10-22", fmp_confirmed_flag: 0 },
    ]);
    expect(earningsCalendar).toHaveBeenCalledWith(today, expect.any(String), { includeReportTimes: true });
  });

  it("falls back to the stored press-release timing only when FMP's time is null", async () => {
    timing.recordTiming("INFER", { timing: "dmh", matched: 3, total: 4, source: "press_release" }, today);
    timing.recordTiming("AMC", { timing: "bmo", matched: 3, total: 4, source: "press_release" }, today);
    earningsCalendar.mockImplementation(async (from) => (from !== today ? [] : [cal("INFER", "2026-10-22", null), cal("NOTIME", "2026-10-22", null), cal("AMC", "2026-10-22", "amc")]));
    await up.refreshUpcoming(today);
    const by = Object.fromEntries((edb.prepare("SELECT * FROM upcoming").all() as Array<Record<string, unknown>>).map((r) => [r.symbol, r]));
    expect(by.INFER).toMatchObject({ time: "dmh", time_source: "press_release", t0: "2026-10-22", r: "2026-10-22" });
    expect(by.NOTIME).toMatchObject({ time: null, time_source: null, t0: null, r: null });
    expect(by.AMC).toMatchObject({ time: "amc", time_source: "fmp" });
  });

  it("replaces yesterday's rows on a clean refresh, but keeps them when a window failed", async () => {
    earningsCalendar.mockImplementation(async (from) => (from !== today ? [] : [cal("AMC", "2026-10-22", "amc")]));
    await up.refreshUpcoming(today);
    earningsCalendar.mockImplementation(async (from) => (from !== today ? [] : [cal("BMO", "2026-10-23", "bmo")]));
    await up.refreshUpcoming(today);
    expect((edb.prepare("SELECT symbol FROM upcoming").all() as Array<{ symbol: string }>).map((r) => r.symbol)).toEqual(["BMO"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    earningsCalendar.mockImplementation(async (from) => {
      if (from === today) return [cal("AMC", "2026-10-22", "amc")];
      throw new Error("boom");
    });
    const r = await up.refreshUpcoming(today);
    spy.mockRestore();
    expect(r.failed).toBeGreaterThan(0);
    expect((edb.prepare("SELECT symbol FROM upcoming ORDER BY symbol").all() as Array<{ symbol: string }>).map((x) => x.symbol)).toEqual(["AMC", "BMO"]);
  });
});

describe("analyst actions", () => {
  it("classifies price-target moves", () => {
    expect(up.targetAction(120, 100)).toBe("pt_raise");
    expect(up.targetAction(80, 100)).toBe("pt_cut");
    expect(up.targetAction(100, 100)).toBe("pt_maintain");
    expect(up.targetAction(100, null)).toBe("pt_set");
  });

  it("stores grades and targets of names reporting within 60 days plus watchlist symbols, and refetches on a schedule", async () => {
    edb.prepare("INSERT INTO upcoming (symbol, report_date) VALUES ('AMC', ?), ('BMO', ?), ('NOTIME', ?)").run("2026-10-23", "2026-12-01", "2027-03-01");
    db.prepare("INSERT INTO watchlists (name) VALUES ('w')").run();
    db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) SELECT id, 'WLONLY', 0 FROM watchlists WHERE name = 'w'").run();
    grades.mockImplementation(async (s) => [{ date: "2026-10-20", firm: "Acme", action: "upgrade", previousGrade: "Hold", newGrade: "Buy" }, { date: "2026-01-02", firm: "Old", action: "maintain", previousGrade: null, newGrade: null }].map((g) => ({ ...g, firm: `${g.firm}-${s}` })));
    priceTargetNews.mockImplementation(async () => [{ date: "2026-10-19", firm: "Acme", priceTarget: 150, priorPriceTarget: 120, title: "t" }]);
    const r = await up.refreshAnalystActions(today);
    expect(r).toEqual({ symbols: 3, rows: 6, failed: 0 }); // AMC, BMO, WLONLY (NOTIME is 130 days out)
    expect(grades).not.toHaveBeenCalledWith("NOTIME");
    const rows = edb.prepare("SELECT * FROM analyst_actions WHERE symbol = 'AMC' ORDER BY action").all();
    expect(rows).toMatchObject([
      { date: "2026-10-19", firm: "Acme", action: "pt_raise", price_target: 150, prior_price_target: 120 },
      { date: "2026-10-20", firm: "Acme-AMC", action: "upgrade", prior_grade: "Hold", new_grade: "Buy", price_target: null },
    ]);

    // Reporting tomorrow: refetched the next day; a name 40 days out waits a week.
    const next = await up.refreshAnalystActions("2026-10-22");
    expect(next.symbols).toBe(1);
    expect(grades).toHaveBeenLastCalledWith("AMC");
  });
});
