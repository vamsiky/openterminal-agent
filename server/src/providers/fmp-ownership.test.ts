import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetState } from "./fmp-core.js";
import { getCongress, getFloat, getInsiders, getInstitutional, getLatestCongress, latestFiledQuarter, previousQuarter } from "./fmp-ownership.js";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() };
}

/** Answers by path; `handler` gets the URL object. */
function mockFmp(handler: (url: URL) => unknown) {
  const fetchMock = vi.fn(async (u: string) => ok(handler(new URL(u))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.FMP_API_KEY = "test-key";
  process.env.FMP_MAX_REQ_PER_MIN = "100000";
  resetState();
});
afterEach(() => vi.unstubAllGlobals());

describe("quarters", () => {
  it("picks the newest quarter past its 45 day deadline", () => {
    expect(latestFiledQuarter(new Date("2026-10-21T00:00:00Z"))).toEqual({ year: 2026, quarter: 2 });
    expect(latestFiledQuarter(new Date("2026-11-20T00:00:00Z"))).toEqual({ year: 2026, quarter: 3 });
    expect(latestFiledQuarter(new Date("2027-01-10T00:00:00Z"))).toEqual({ year: 2026, quarter: 3 });
  });
  it("steps back across the year boundary", () => {
    expect(previousQuarter({ year: 2026, quarter: 1 })).toEqual({ year: 2025, quarter: 4 });
  });
});

describe("getInstitutional", () => {
  it("returns summary and holders for an explicit quarter", async () => {
    const f = mockFmp((u) =>
      u.pathname.endsWith("symbol-positions-summary") ? [{ symbol: "AAPL", investorsHolding: 5 }] : [{ investorName: "A" }, { investorName: "B" }]
    );
    const r = await getInstitutional("AAPL", { year: 2026, quarter: 2 });
    expect(r).toEqual({ year: 2026, quarter: 2, summary: { symbol: "AAPL", investorsHolding: 5 }, holders: [{ investorName: "A" }, { investorName: "B" }] });
    const holderUrl = new URL(f.mock.calls.map((c) => c[0]).find((u) => u.includes("extract-analytics"))!);
    expect(holderUrl.searchParams.get("limit")).toBe("25");
    expect(holderUrl.searchParams.get("quarter")).toBe("2");
  });

  it("falls back one quarter when the default quarter is empty", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z")); // default Q3
    try {
      const f = mockFmp((u) => (u.searchParams.get("quarter") === "3" ? [] : u.pathname.endsWith("summary") ? [{ date: "2026-06-30" }] : [{ x: 1 }]));
      const r = await getInstitutional("AAPL");
      expect(r.quarter).toBe(2);
      expect(r.summary).toEqual({ date: "2026-06-30" });
      expect(f).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back for an explicit quarter and caches", async () => {
    const f = mockFmp(() => []);
    const r = await getInstitutional("AAPL", { year: 2026, quarter: 3 });
    expect(r).toEqual({ year: 2026, quarter: 3, summary: null, holders: [] });
    await getInstitutional("AAPL", { year: 2026, quarter: 3 });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("getInsiders / getFloat", () => {
  it("combines trades and statistics", async () => {
    const f = mockFmp((u) => (u.pathname.endsWith("search") ? [{ reportingName: "X" }] : [{ year: 2026, quarter: 4 }]));
    const r = await getInsiders("BRK.B", 10);
    expect(r).toEqual({ trades: [{ reportingName: "X" }], statistics: [{ year: 2026, quarter: 4 }] });
    expect(new URL(f.mock.calls[0][0]).searchParams.get("symbol")).toBe("BRK-B");
  });
  it("maps float and returns null when empty", async () => {
    mockFmp(() => [{ symbol: "AAPL", date: "d", freeFloat: 99.8, floatShares: "10", outstandingShares: 11, source: "s", extra: 1 }]);
    expect(await getFloat("AAPL")).toEqual({ symbol: "AAPL", date: "d", floatShares: 10, outstandingShares: 11, freeFloat: 99.8, source: "s" });
    resetState();
    mockFmp(() => []);
    expect(await getFloat("ZZZZ")).toBeNull();
  });
});

describe("congress", () => {
  it("merges chambers newest transaction first with disclosure lag", async () => {
    mockFmp((u) =>
      u.pathname.endsWith("senate-trades")
        ? [{ transactionDate: "2026-01-01", disclosureDate: "2026-01-31", lastName: "S" }]
        : [{ transactionDate: "2026-03-01", disclosureDate: "2026-03-11", lastName: "H" }, { disclosureDate: "2026-03-11", lastName: "H2" }]
    );
    const r = await getCongress("AAPL", 3);
    expect(r.map((t) => [t.lastName, t.chamber, t.disclosureLagDays])).toEqual([
      ["H", "house", 10],
      ["S", "senate", 30],
      ["H2", "house", null],
    ]);
  });
  it("latest merges by disclosure date", async () => {
    mockFmp((u) => (u.pathname.startsWith("/stable/senate") ? [{ disclosureDate: "2026-10-01", transactionDate: "2026-09-01" }] : [{ disclosureDate: "2026-10-05", transactionDate: "2026-09-01" }]));
    const r = await getLatestCongress(5);
    expect(r.map((t) => t.chamber)).toEqual(["house", "senate"]);
  });
});
