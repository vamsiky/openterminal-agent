import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarningsCalendarRow, PressRelease } from "../providers/fmp.js";

const earningsReports = vi.fn<(symbol: string, limit?: number, opts?: unknown) => Promise<EarningsCalendarRow[]>>();
const transcriptDates = vi.fn<(symbol: string) => Promise<string[]>>();
const pressReleases = vi.fn<(symbol: string, limit?: number, range?: { from: string; to: string }) => Promise<PressRelease[]>>();
vi.mock("../providers/fmp.js", () => ({ earningsReports, transcriptDates, pressReleases, isConfigured: () => true }));

let tmpDir: string;
let events: typeof import("./events.js");
let sessions: typeof import("./sessions.js");
let edb: typeof import("./db.js").earningsDb;
let db: typeof import("../db.js").db;

const HOLIDAYS = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
const weekdays2026 = (): string[] => {
  const out: string[] = [];
  for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    const day = new Date(d).toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.includes(day)) out.push(day);
  }
  return out;
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-events-test-"));
  process.env.DATA_DIR = tmpDir;
  db = (await import("../db.js")).db;
  await import("../history/store.js"); // daily_bars
  await import("../research/bulk-store.js"); // bulk_profiles
  edb = (await import("./db.js")).earningsDb;
  const cal = await import("../providers/alpaca-calendar.js");
  cal.loadCalendarRows(2026, weekdays2026().map((date) => ({ date, open: "09:30", close: "16:00" })));
  sessions = await import("./sessions.js");
  events = await import("./events.js");
});

afterAll(() => {
  db.close();
  edb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** Flat 100 closes, volume 1000, with the given days' volume replaced; no bar on `missing` days. */
function bars(symbol: string, spikes: Record<string, number>, missing: string[] = []): void {
  const ins = db.prepare("INSERT OR REPLACE INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?, ?, 100, 101, 99, 100, ?)");
  db.prepare("DELETE FROM daily_bars WHERE symbol = ?").run(symbol);
  for (const day of weekdays2026()) if (!missing.includes(day)) ins.run(symbol, day, spikes[day] ?? 1000);
}
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
const row = (d: string, time: "bmo" | "amc" | null, extra: Partial<EarningsCalendarRow> = {}): EarningsCalendarRow => ({
  symbol: "X", date: day(d), epsActual: 1.2, epsEstimated: 1, revenueActual: 110, revenueEstimated: 100, time, confirmed: true, fiscalPeriod: "Q2", fiscalYear: 2026, periodEnding: "2026-06-30", ...extra,
});
const rel = (publishedAt: string, title = "X Announces Financial Results"): PressRelease => ({ publishedAt, title, publisher: null, url: null });
const stored = (symbol: string, reportDate: string) => edb.prepare("SELECT * FROM events WHERE symbol = ? AND report_date = ?").get(symbol, reportDate) as Record<string, unknown> | undefined;

beforeEach(() => {
  edb.exec("DELETE FROM events");
  earningsReports.mockReset();
  transcriptDates.mockReset().mockResolvedValue([]);
  pressReleases.mockReset().mockResolvedValue([]);
});

describe("T0 and R", () => {
  it("amc: T0 is the report date and R the next session; bmo: T0 the previous session and R the report date; dmh: both the report date", () => {
    expect(sessions.sessionsFor("2026-05-06", "amc")).toEqual({ t0: "2026-05-06", r: "2026-05-07" });
    expect(sessions.sessionsFor("2026-05-06", "bmo")).toEqual({ t0: "2026-05-05", r: "2026-05-06" });
    expect(sessions.sessionsFor("2026-05-06", "dmh")).toEqual({ t0: "2026-05-06", r: "2026-05-06" });
    expect(sessions.sessionsFor("2026-05-06", null)).toEqual({ t0: null, r: null });
  });

  it("skips weekends and the Thanksgiving holiday", () => {
    expect(sessions.sessionsFor("2026-05-08", "amc")).toEqual({ t0: "2026-05-08", r: "2026-05-11" }); // Friday
    expect(sessions.sessionsFor("2026-11-25", "amc")).toEqual({ t0: "2026-11-25", r: "2026-11-27" });
    expect(sessions.sessionsFor("2026-11-27", "bmo")).toEqual({ t0: "2026-11-25", r: "2026-11-27" });
    expect(sessions.sessionsFor("2026-05-26", "bmo")).toEqual({ t0: "2026-05-22", r: "2026-05-26" }); // Monday holiday before it
    expect(sessions.sessionsFor("2026-11-26", "amc")).toEqual({ t0: "2026-11-27", r: "2026-11-30" }); // a holiday date moves to the next session
  });
});

describe("confirmation", () => {
  it("confirms an amc report on fmp + volume, with FMP's time and the sessions", async () => {
    bars("X", { "2026-05-07": 5000 });
    earningsReports.mockResolvedValue([row("2026-05-06", "amc")]);
    const r = await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(r).toMatchObject({ events: 1, confirmed: 1, shifted: 0, unconfirmed: 0 });
    expect(stored("X", "2026-05-06")).toMatchObject({ time: "amc", time_source: "fmp", t0: "2026-05-06", r: "2026-05-07", confirmed: 1, check_fmp: 1, check_volume: 1, check_transcript: 0, reason: "ok", eps_estimate: 1, revenue_estimate: 100, fiscal_period: "Q2", fmp_confirmed_flag: 1 });
    expect(pressReleases).not.toHaveBeenCalled(); // volume already confirmed it
  });

  it("confirms on the transcript date, one day after an amc report too, without volume", async () => {
    bars("X", {});
    earningsReports.mockResolvedValue([row("2026-05-06", "amc")]);
    transcriptDates.mockResolvedValue(["2026-05-07"]);
    await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(stored("X", "2026-05-06")).toMatchObject({ confirmed: 1, check_transcript: 1, check_volume: 0, reason: "ok" });
    earningsReports.mockResolvedValue([row("2026-05-06", "bmo")]);
    await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(stored("X", "2026-05-06")).toMatchObject({ confirmed: 0, check_transcript: 0, reason: "unconfirmed" }); // bmo: exact date only
  });

  it("falls back to an earnings press release (bmo: the evening before counts) when transcript and volume fail", async () => {
    bars("X", {});
    earningsReports.mockResolvedValue([row("2026-05-06", "bmo")]);
    pressReleases.mockResolvedValue([rel("2026-05-05 17:30:00")]);
    await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(stored("X", "2026-05-06")).toMatchObject({ confirmed: 1, check_press_release: 1, reason: "ok" });
    expect(pressReleases).toHaveBeenCalledWith("X", 100, { from: "2026-05-05", to: "2026-05-06" });
  });

  it("flags a date only FMP knows as unconfirmed", async () => {
    bars("X", {});
    earningsReports.mockResolvedValue([row("2026-05-06", "amc")]);
    pressReleases.mockResolvedValue([rel("2026-05-06 16:05:00", "X appoints a director")]);
    const r = await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(r).toMatchObject({ confirmed: 0, unconfirmed: 1 });
    expect(stored("X", "2026-05-06")).toMatchObject({ confirmed: 0, reason: "unconfirmed", check_fmp: 1, check_volume: 0 });
  });

  it("corrects a date one session off when volume peaks there (WDC 08-04 vs 08-05)", async () => {
    bars("X", { "2026-08-06": 6000 }); // R of the real 08-05 amc report
    earningsReports.mockResolvedValue([row("2026-08-04", "amc")]);
    transcriptDates.mockResolvedValue(["2026-08-05"]); // would pass the ±1 amc rule on the wrong date too
    const r = await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(r).toMatchObject({ confirmed: 1, shifted: 1 });
    expect(stored("X", "2026-08-04")).toBeUndefined();
    expect(stored("X", "2026-08-05")).toMatchObject({ original_date: "2026-08-04", reason: "date_shifted", confirmed: 1, check_volume: 1, t0: "2026-08-05", r: "2026-08-06" });
  });

  it("also finds a shift to the earlier session, and a re-run is idempotent", async () => {
    bars("X", { "2026-08-04": 6000 }); // real R is 08-04 (bmo on 08-04); FMP says 08-05
    earningsReports.mockResolvedValue([row("2026-08-05", "bmo")]);
    await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    const again = await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(stored("X", "2026-08-04")).toMatchObject({ original_date: "2026-08-05", reason: "date_shifted", confirmed: 1, t0: "2026-08-03", r: "2026-08-04" });
    expect(edb.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect(again.fresh).toEqual([]);
  });

  it("infers dmh from a mid-session press release when FMP has no time", async () => {
    bars("X", { "2026-05-06": 5000 });
    earningsReports.mockResolvedValue([row("2026-05-06", null)]);
    pressReleases.mockResolvedValue([rel("2026-05-06 12:10:00")]);
    await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(stored("X", "2026-05-06")).toMatchObject({ time: "dmh", time_source: "press_release", t0: "2026-05-06", r: "2026-05-06", check_press_release: 1, confirmed: 1 });
  });

  it("leaves T0/R empty and the event unconfirmed when the time stays unknown", async () => {
    bars("X", { "2026-05-07": 5000 });
    earningsReports.mockResolvedValue([row("2026-05-06", null)]);
    await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(stored("X", "2026-05-06")).toMatchObject({ time: null, time_source: null, t0: null, r: null, confirmed: 0, reason: "unconfirmed" });
  });

  it("marks no_bars (not confirmed) when R has no daily bar, and skips unreported or out-of-range rows", async () => {
    bars("X", {}, ["2026-05-07"]);
    earningsReports.mockResolvedValue([row("2026-05-06", "amc"), row("2026-02-05", "amc", { epsActual: null }), row("2025-05-06", "amc")]);
    transcriptDates.mockResolvedValue(["2026-05-06"]);
    const r = await events.processSymbol("X", { since: "2026-01-01", today: "2026-10-21" });
    expect(r).toMatchObject({ events: 1, confirmed: 0, noBars: 1 });
    expect(stored("X", "2026-05-06")).toMatchObject({ reason: "no_bars", confirmed: 0, check_transcript: 1 });
  });

  it("brackets a report across the holiday: bmo on the Friday after Thanksgiving", async () => {
    bars("X", { "2026-11-27": 5000 });
    earningsReports.mockResolvedValue([row("2026-11-27", "bmo")]);
    await events.processSymbol("X", { since: "2026-01-01", today: "2026-12-31" });
    expect(stored("X", "2026-11-27")).toMatchObject({ t0: "2026-11-25", r: "2026-11-27", confirmed: 1 });
  });
});

describe("universe", () => {
  it("keeps listed common stocks only", () => {
    const ins = db.prepare("INSERT INTO bulk_profiles (symbol, exchange, is_etf, is_fund, is_actively_trading, data, updated_at) VALUES (?, ?, ?, ?, ?, '{}', 'x')");
    ins.run("OKA", "NASDAQ", 0, 0, 1);
    ins.run("OKB", "NYSE", 0, 0, 1);
    ins.run("OKC", "AMEX", 0, 0, 1);
    ins.run("ETFX", "NYSE", 1, 0, 1);
    ins.run("FUNDX", "NASDAQ", 0, 1, 1);
    ins.run("DEADX", "NASDAQ", 0, 0, 0);
    ins.run("OTCX", "OTC", 0, 0, 1);
    ins.run("SHOP.TO", "NYSE", 0, 0, 1);
    ins.run("BRK.B", "NYSE", 0, 0, 1);
    expect(events.universe()).toEqual(["BRK.B", "OKA", "OKB", "OKC"]);
  });
});
