import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_ROWS, FIXTURE_EVENTS, review } from "./earningsFixtures";
import {
  FILTERS_KEY, countLine, defaultFilters, estimateReviewCost, eventReactionPct, latestReviews, loadFilters, saveFilters, screenParams, screenQuery, sortSetups, surprisePct, weekdaysAhead,
} from "./earningsScreen";

const FRI = new Date(2026, 9, 23); // Fri 2026-10-23

describe("filters to query string", () => {
  it("defaults to the next session, report-day horizon", () => {
    const f = defaultFilters(new Date(2026, 9, 21));
    expect(screenQuery(f)).toBe("from=2026-10-22&to=2026-10-22&horizon=intraday");
  });
  it("skips weekends and scales the default date with the horizon", () => {
    expect(weekdaysAhead(FRI, 1)).toBe("2026-10-26");
    expect(defaultFilters(FRI, "week").from).toBe("2026-10-30");
    expect(defaultFilters(FRI, "month").from).toBe("2026-11-20");
  });
  it("maps every filter", () => {
    const f = { ...defaultFilters(FRI), horizon: "week" as const, time: "amc" as const, sector: " Technology ", minCapB: "2", maxCapB: "10.5", minScore: "55", verdict: "candidate" as const, tradable: true };
    expect(screenParams(f)).toEqual({ from: "2026-10-26", to: "2026-10-26", horizon: "week", time: "amc", sector: "Technology", minCap: "2000000000", maxCap: "10500000000", minScore: "55", verdict: "candidate", tradable: "1" });
  });
  it("omits blank and invalid numbers", () => {
    expect(screenParams({ ...defaultFilters(FRI), minCapB: "x", minScore: " " })).not.toHaveProperty("minCap");
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());
  it("round-trips filters but lets the date follow the next session unless custom", () => {
    saveFilters({ ...defaultFilters(FRI), sector: "Energy", tradable: true, from: "2026-01-01", to: "2026-01-01", customRange: false });
    const g = loadFilters(FRI);
    expect(g.sector).toBe("Energy");
    expect(g.tradable).toBe(true);
    expect(g.from).toBe("2026-10-26");
    saveFilters({ ...defaultFilters(FRI), from: "2026-11-02", to: "2026-11-03", customRange: true });
    expect(loadFilters(FRI).from).toBe("2026-11-02");
  });
  it("survives corrupt or blocked storage", () => {
    localStorage.setItem(FILTERS_KEY, "{nope");
    expect(loadFilters(FRI).time).toBe("any");
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    expect(() => saveFilters(defaultFilters(FRI))).not.toThrow();
    Storage.prototype.setItem = orig;
  });
});

describe("sorting and counts", () => {
  it("sorts by score and puts missing values last in both directions", () => {
    expect(sortSetups(FIXTURE_ROWS, { key: "score", dir: "desc" }).map((r) => r.symbol)).toEqual(["CCC", "AAA", "BBB", "DDD"]);
    expect(sortSetups(FIXTURE_ROWS, { key: "reaction", dir: "desc" }).map((r) => r.symbol)).toEqual(["AAA", "DDD", "BBB", "CCC"]);
    expect(sortSetups(FIXTURE_ROWS, { key: "reaction", dir: "asc" }).map((r) => r.symbol)).toEqual(["BBB", "AAA", "DDD", "CCC"]);
    expect(sortSetups(FIXTURE_ROWS, { key: "spread", dir: "asc" }).at(-1)?.symbol).toBe("CCC");
    expect(sortSetups(FIXTURE_ROWS, { key: "symbol", dir: "asc" })[0].symbol).toBe("AAA");
  });
  it("counts reporting and gate passers", () => {
    expect(countLine(FIXTURE_ROWS)).toBe("4 reporting · 2 pass gates");
    expect(estimateReviewCost(FIXTURE_ROWS)).toBeCloseTo(0.3);
  });
  it("computes surprise and event reaction", () => {
    expect(surprisePct(FIXTURE_ROWS[0])).toBeCloseTo(20);
    expect(surprisePct(FIXTURE_ROWS[2])).toBeNull();
    expect(eventReactionPct(FIXTURE_EVENTS[0])).toBeCloseTo(6.5);
  });
  it("keeps the newest review per symbol and report date", () => {
    const m = latestReviews([review("AAA", { id: 3 }), review("AAA", { id: 9 }), review("AAA", { id: 12, reportDate: "2026-10-29" })]);
    expect(m.get("AAA|2026-10-22")?.id).toBe(9);
    expect(m.size).toBe(2);
  });
});
