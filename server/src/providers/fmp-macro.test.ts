import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetState } from "./fmp-core.js";
import { cpiYoy, mergeRates, policyRate, treasuryRates, vix } from "./fmp-macro.js";

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const calls: string[] = [];

function mockFmp(routes: Record<string, (url: URL) => unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url.pathname.split("/").pop() + url.search.replace(/apikey=[^&]*/, "apikey=x"));
    const h = routes[url.pathname.split("/").pop()!];
    return h ? json(h(url)) : new Response("no route", { status: 404 });
  }));
}

beforeEach(() => {
  process.env.FMP_API_KEY = "test";
  process.env.FMP_MAX_REQ_PER_MIN = "100000";
  resetState();
  calls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FMP_API_KEY;
  delete process.env.FMP_MAX_REQ_PER_MIN;
});

describe("fmp macro series", () => {
  it("reads the latest treasury row and the VIX quote", async () => {
    mockFmp({
      "treasury-rates": () => [{ date: "2026-10-19", month3: 4.27, year5: 4.94, year10: 5.15, year30: 5.48 }],
      quote: () => [{ symbol: "^VIX", price: 16.64, timestamp: 1792607311 }],
    });
    expect(await treasuryRates()).toEqual({ date: "2026-10-19", month3: 4.27, year5: 4.94, year10: 5.15, year30: 5.48 });
    expect(await vix()).toEqual({ value: 16.64, date: "2026-10-21" });
  });

  it("reads the federal funds rate and computes CPI year over year with its period", async () => {
    mockFmp({
      "economic-indicators": (url) => {
        const name = url.searchParams.get("name");
        if (name === "federalFunds") return [{ date: "2026-08-01", value: 3.63 }, { date: "2026-09-01", value: 3.75 }];
        if (url.searchParams.get("from")) return [{ date: "2025-09-01", value: 324.245 }];
        return [{ date: "2026-09-01", value: 336.298 }, { date: "2026-08-01", value: 334.131 }];
      },
    });
    expect(await policyRate()).toEqual({ value: 3.75, date: "2026-09" });
    expect(await cpiYoy()).toEqual({ value: 3.7, date: "2026-09" });
    expect(calls.some((c) => c.includes("from=2025-09-01") && c.includes("to=2025-09-30"))).toBe(true);
  });

  it("is null without data, and without an FMP key", async () => {
    mockFmp({ "economic-indicators": (url) => (url.searchParams.get("from") ? [] : [{ date: "2026-09-01", value: 336.298 }]), "treasury-rates": () => [], quote: () => [] });
    expect(await cpiYoy()).toBeNull(); // no value for the year-earlier month
    expect(await treasuryRates()).toBeNull();
    expect(await vix()).toBeNull();
    delete process.env.FMP_API_KEY;
    resetState();
    expect(await policyRate()).toBeNull();
  });
});

describe("mergeRates", () => {
  const treasury = { date: "2026-10-19", month3: 4.27, year5: 4.94, year10: 5.15, year30: null };
  const fmp = { treasury, vix: { value: 16.64, date: "2026-10-21" }, policy: { value: 3.75, date: "2026-09" }, cpi: { value: 3.7, date: "2026-09" } };
  const allFailed = ["3M", "5Y", "10Y", "30Y"].map((tenor) => ({ tenor, value: null }));

  it("uses FMP for everything when FRED is down, leaving out what FMP lacks, with sources", () => {
    const r = mergeRates({ yields: allFailed, vix: null }, fmp);
    expect(r.yields).toEqual([{ tenor: "3M", value: 4.27 }, { tenor: "5Y", value: 4.94 }, { tenor: "10Y", value: 5.15 }]);
    expect(r).toMatchObject({ vix: 16.64, policyRate: 3.75, inflation: 3.7 });
    expect(r.sources.yields).toEqual({ source: "fmp:treasury-rates", asOf: "2026-10-19" });
    expect(r.sources.vix?.source).toBe("fmp:quote ^VIX");
    expect(r.sources.inflation).toEqual({ source: "fmp:economic-indicators CPI, year over year %", asOf: "2026-09" });
  });

  it("prefers FRED and fills only the missing tenors from FMP", () => {
    const fred = { yields: [{ tenor: "3M", value: 4.3, date: "2026-10-20" }, { tenor: "5Y", value: null }, { tenor: "10Y", value: 5.2, date: "2026-10-20" }, { tenor: "30Y", value: null }], vix: { value: 17, date: "2026-10-20" } };
    const r = mergeRates(fred, fmp);
    expect(r.yields).toEqual([{ tenor: "3M", value: 4.3 }, { tenor: "5Y", value: 4.94 }, { tenor: "10Y", value: 5.2 }]);
    expect(r.vix).toBe(17);
    expect(r.sources.yields?.source).toBe("fred+fmp:treasury-rates");
    expect(r.sources.vix).toEqual({ source: "fred", asOf: "2026-10-20" });
  });

  it("returns nulls and empty yields when no source has data", () => {
    const r = mergeRates({ yields: allFailed, vix: null }, { treasury: null, vix: null, policy: null, cpi: null });
    expect(r).toEqual({ yields: [], vix: null, policyRate: null, inflation: null, sources: { yields: null, vix: null, policyRate: null, inflation: null } });
  });
});
