import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PressRelease } from "../providers/fmp.js";

const pressReleases = vi.fn<(symbol: string, limit?: number) => Promise<PressRelease[]>>();
const earnings = vi.fn(async () => [] as unknown[]);
vi.mock("../providers/fmp.js", () => ({ pressReleases, earnings, isConfigured: () => true }));

let tmpDir: string;
let timing: typeof import("./timing.js");
let store: typeof import("./store.js");
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-timing-test-"));
  process.env.DATA_DIR = tmpDir;
  timing = await import("./timing.js");
  store = await import("./store.js");
  db = (await import("../db.js")).db;
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const rel = (publishedAt: string, title = "Acme Announces Financial Results for the Third Quarter"): PressRelease => ({ publishedAt, title, publisher: null, url: null });

describe("classify", () => {
  it("splits the day at 09:30 and 16:00, and ignores date-only times", () => {
    expect(timing.classify("2026-10-14 07:08:00")).toBe("bmo");
    expect(timing.classify("2026-10-14 09:29:59")).toBe("bmo");
    expect(timing.classify("2026-10-14 09:30:00")).toBe("dmh");
    expect(timing.classify("2026-10-14 15:59:59")).toBe("dmh");
    expect(timing.classify("2026-10-14 16:00:00")).toBe("amc");
    expect(timing.classify("2026-10-14 16:20:00")).toBe("amc");
    expect(timing.classify("2026-10-14 00:00:00")).toBeNull();
  });
});

describe("timingFor", () => {
  const dates = ["2026-08-26", "2026-05-28", "2026-02-25", "2025-11-19"];

  it("takes the majority over the report dates", () => {
    const r = timing.timingFor([rel("2026-08-26 16:20:00"), rel("2026-05-28 16:15:00"), rel("2026-02-25 16:30:00"), rel("2025-11-19 07:00:00")], dates);
    expect(r).toEqual({ timing: "amc", matched: 3, total: 4 });
  });

  it("classifies bmo and dmh", () => {
    expect(timing.timingFor([rel("2026-08-26 06:00:00")], dates.slice(0, 1))).toEqual({ timing: "bmo", matched: 1, total: 1 });
    expect(timing.timingFor([rel("2026-08-26 12:00:00")], dates.slice(0, 1))).toEqual({ timing: "dmh", matched: 1, total: 1 });
  });

  it("ignores midnight times, other days and titles that aren't earnings", () => {
    const r = timing.timingFor([rel("2026-08-26 00:00:00"), rel("2026-08-26 16:20:00", "Acme appoints a new director"), rel("2026-08-27 16:20:00")], dates.slice(0, 1));
    expect(r).toEqual({ timing: null, matched: 0, total: 1 });
  });

  it("counts a date once, by its earliest timed release", () => {
    const r = timing.timingFor([rel("2026-08-26 00:00:00"), rel("2026-08-26 18:00:00"), rel("2026-08-26 07:00:00")], dates.slice(0, 1));
    expect(r.timing).toBe("bmo");
  });

  it("is null on a tie and with no matches", () => {
    expect(timing.timingFor([rel("2026-08-26 16:20:00"), rel("2026-05-28 07:00:00")], dates)).toEqual({ timing: null, matched: 1, total: 4 });
    expect(timing.timingFor([], dates)).toEqual({ timing: null, matched: 0, total: 4 });
  });
});

describe("refreshTimings", () => {
  const today = "2026-10-21";
  const dayAgo = (n: number) => store.addDays(today, -n);

  beforeEach(() => {
    db.exec("DELETE FROM earnings_timing; DELETE FROM earnings_calendar; DELETE FROM watchlist_items; DELETE FROM watchlists;");
    pressReleases.mockReset();
    earnings.mockClear();
    const row = (symbol: string, reportDate: string, actual: number | null) => ({ symbol, reportDate, epsEstimate: 1, revenueEstimate: 1, epsActual: actual, revenueActual: null });
    store.recordCalendar(
      [
        // Four past reports each: no FMP top-up needed.
        ...[5, 95, 185, 275].map((n) => row("WL", dayAgo(n), 1)),
        ...[5, 95, 185, 275].map((n) => row("SOON", dayAgo(n), 1)),
        row("SOON", store.addDays(today, 10), null),
        row("FAR", store.addDays(today, 40), null),
        ...[5, 95, 185, 275].map((n) => row("FAR", dayAgo(n), 1)),
      ],
      today
    );
    db.prepare("INSERT INTO watchlists (name) VALUES ('w')").run();
    db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) SELECT id, 'WL', 0 FROM watchlists WHERE name = 'w'").run();
    // Like FMP's ranged feed: only that day's releases, and only two of the four days have an earnings one.
    pressReleases.mockImplementation(async (symbol, _limit, range) =>
      [rel(`${dayAgo(5)} 16:20:00`), rel(`${dayAgo(95)} 16:20:00`)].filter((r) => r.publishedAt.startsWith(range!.from)).map((r) => ({ ...r, title: `${symbol} results` }))
    );
  });

  it("covers watchlist symbols and those reporting in the next 14 days, not the rest", async () => {
    const r = await timing.refreshTimings(today);
    expect(r).toEqual({ symbols: 2, timed: 2, unknown: 0, failed: 0 });
    expect([...new Set(pressReleases.mock.calls.map((c) => c[0]))].sort()).toEqual(["SOON", "WL"]);
    expect(pressReleases).toHaveBeenCalledWith("WL", 100, { from: dayAgo(5), to: dayAgo(5) });
    expect(timing.timingsFor(["WL", "FAR"]).get("WL")).toEqual({ timing: "amc", matched: 2, total: 4 });
    expect(timing.timingsFor(["FAR"]).size).toBe(0);
    expect(earnings).not.toHaveBeenCalled();
  });

  it("refreshes only entries older than 30 days", async () => {
    timing.recordTiming("WL", { timing: "bmo", matched: 4, total: 4 }, dayAgo(29));
    timing.recordTiming("SOON", { timing: "bmo", matched: 4, total: 4 }, dayAgo(31));
    const r = await timing.refreshTimings(today);
    expect(r.symbols).toBe(1);
    expect([...new Set(pressReleases.mock.calls.map((c) => c[0]))]).toEqual(["SOON"]);
    expect(timing.timingsFor(["WL"]).get("WL")?.timing).toBe("bmo");
    expect(timing.timingsFor(["SOON"]).get("SOON")?.timing).toBe("amc");
  });

  it("tops up report dates from FMP when the captured calendar has fewer than four, and counts failures", async () => {
    db.prepare("DELETE FROM earnings_calendar WHERE symbol = 'WL' AND report_date < ?").run(dayAgo(50));
    earnings.mockResolvedValueOnce([{ upcoming: false, dateReported: Date.parse(dayAgo(185) + "T00:00:00Z") / 1000 }]);
    pressReleases.mockImplementation(async (symbol) => {
      if (symbol === "SOON") throw new Error("boom");
      return [];
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await timing.refreshTimings(today);
    spy.mockRestore();
    expect(earnings).toHaveBeenCalledWith("WL", 8, expect.any(Date));
    expect(r).toEqual({ symbols: 2, timed: 0, unknown: 1, failed: 1 });
    expect(timing.timingsFor(["WL"]).get("WL")).toEqual({ timing: null, matched: 0, total: 2 });
  });
});
