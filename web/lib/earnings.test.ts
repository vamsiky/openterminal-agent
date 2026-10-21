import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_CHUNK, fetchCalendar, fmtDay, groupEarnings, inDays, type EarningsEntry } from "./earnings";

const at = (day: string) => Date.parse(day + "T00:00:00Z") / 1000;
const entry = (symbol: string, next: string | null, extra: Partial<EarningsEntry> = {}): EarningsEntry => ({
  symbol,
  nextEarningsDate: next ? at(next) : null,
  lastEarningsDate: null,
  epsForecast: 1,
  ...extra,
});

// Wednesday 2026-10-21, noon in New York.
const now = new Date("2026-10-21T16:00:00Z");

describe("groupEarnings", () => {
  it("buckets upcoming reports by relative day, weeks running Monday to Sunday", () => {
    const g = groupEarnings(
      [
        entry("LATER", "2026-11-05"),
        entry("NEXTWK", "2026-10-27"), // next Monday
        entry("SUN", "2026-10-25"), // this Sunday, still this week
        entry("THU", "2026-10-22"), // tomorrow
        entry("TODAY2", "2026-10-21"),
        entry("TODAY1", "2026-10-21"),
        entry("NEXTSUN", "2026-11-01"),
        entry("NOV2", "2026-11-02"),
      ],
      now
    );
    expect(g.upcoming.map((u) => [u.label, u.rows.map((r) => r.symbol)])).toEqual([
      ["Today", ["TODAY1", "TODAY2"]],
      ["Tomorrow", ["THU"]],
      ["This week", ["SUN"]],
      ["Next week", ["NEXTWK", "NEXTSUN"]],
      ["Later", ["NOV2", "LATER"]],
    ]);
    expect(g.upcoming[1].rows[0].days).toBe(1);
  });

  it("uses the New York day, not the UTC one, for 'today'", () => {
    // 01:00 UTC on the 22nd is still the evening of the 21st in New York.
    const g = groupEarnings([entry("A", "2026-10-21")], new Date("2026-10-22T01:00:00Z"));
    expect(g.upcoming[0].label).toBe("Today");
  });

  it("lists reports of the last 7 days newest first, and puts symbols without any date last", () => {
    const rep = (symbol: string, last: string, next: string | null = null) => entry(symbol, next, { lastEarningsDate: at(last), lastEps: 1.2, lastEpsEstimate: 1, lastSurprisePercent: 20 });
    const g = groupEarnings(
      [rep("OLD", "2026-10-10"), rep("Y", "2026-10-20", "2027-01-20"), rep("W", "2026-10-14"), rep("TOOOLD", "2026-10-13"), entry("SPY", null)],
      now
    );
    expect(g.reported.map((r) => r.symbol)).toEqual(["Y", "W"]);
    expect(g.upcoming.map((u) => u.label)).toEqual(["Later"]);
    expect(g.noDate.map((e) => e.symbol)).toEqual(["OLD", "TOOOLD", "SPY"]); // no upcoming date, whatever they reported
  });
});

describe("labels", () => {
  it("formats the day and the distance", () => {
    expect(fmtDay(at("2026-10-22"))).toBe("Thu Oct 22");
    expect(inDays(0)).toBe("today");
    expect(inDays(3)).toBe("in 3d");
  });
});

describe("fetchCalendar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("splits 320 symbols into requests of at most 150 and merges in order", async () => {
    const symbols = Array.from({ length: 320 }, (_, i) => `S${i}`);
    const fetchMock = vi.fn(async (url: string) => {
      const syms = new URL(url, "http://x").searchParams.get("symbols")!.split(",");
      if (syms[0] === "S0") await new Promise((r) => setTimeout(r, 10));
      return { ok: true, json: async () => syms.map((symbol) => ({ symbol })) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchCalendar(symbols);
    const sizes = fetchMock.mock.calls.map(([u]) => new URL(u, "http://x").searchParams.get("symbols")!.split(",").length);
    expect(sizes).toEqual([150, 150, 20]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(CALENDAR_CHUNK);
    expect(out.map((e) => e.symbol)).toEqual(symbols);
  });
});
