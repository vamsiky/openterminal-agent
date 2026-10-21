import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Bulk tables in a temp sqlite; FMP's bulk CSVs come from a mocked fetch.

const tmpDir = mkdtempSync(join(tmpdir(), "bulk-store-"));
let store: typeof import("./bulk-store.js");
let db: typeof import("../db.js").db;

const CSV: Record<string, string> = {
  "profile-bulk": [
    `"symbol","price","marketCap","beta","range","averageVolume","companyName","exchange","industry","sector","country","isEtf","isActivelyTrading","isAdr","isFund"`,
    `"NVDA",200,5000000000000,2.2,"150-250",120000000,"NVIDIA Corporation","NASDAQ","Semiconductors","Technology","US",false,true,false,false`,
    `"BRK-B",500,1000000000000,0.8,"400-520",4000000,"Berkshire Hathaway Inc.","NYSE","Insurance - Diversified","Financial Services","US",false,true,false,false`,
    `"TSM",300,1500000000000,1.2,"",10000000,"Taiwan Semiconductor","NYSE","Semiconductors","Technology","TW",false,true,true,false`,
    `"ACME",10,50000000,3.1,"5-12",100000,"Acme Corp","OTC","Software - Application","Technology","US",false,true,false,false`,
    `"QQQ",500,300000000000,1,"",1,"Invesco QQQ","NASDAQ","Asset Management","Financial Services","US",true,true,false,false`,
    `"2330.TW",1000,9000000000000,1,"",1,"TSMC","TAI","Semiconductors","Technology","TW",false,true,false,false`,
  ].join("\n"),
  "ratios-ttm-bulk": [
    `"symbol","priceToEarningsRatioTTM","netIncomePerShareTTM","dividendYieldTTM"`,
    `"NVDA",50,4,0.0002`,
    `"BRK-B",15,33,0`,
    `"TSM",25,12,0.012`,
    `"2330.TW",20,50,0.02`,
  ].join("\n"),
  "rating-bulk": [`"symbol","date","rating"`, `"NVDA","2026-10-20","A-"`, `"TSM","2026-10-20","B"`].join("\n"),
  "price-target-summary-bulk": [
    `"symbol","lastQuarterCount","lastQuarterAvgPriceTarget","lastYearCount","lastYearAvgPriceTarget"`,
    `"NVDA",10,250,40,220`,
    `"TSM",0,0,5,330`,
  ].join("\n"),
  "income-statement-growth-bulk": [
    `"symbol","date","fiscalYear","period","reportedCurrency","growthRevenue","growthEPS"`,
    `"NVDA","2025-01-26","2025","FY","USD",1.14,1.47`,
    `"NVDA","2026-01-25","2026","FY","USD",0.6,0.5`,
    `"TSM","2025-12-31","2025","FY","USD",0.3,0.4`,
  ].join("\n"),
  "income-statement-bulk": [
    `"date","symbol","reportedCurrency","fiscalYear","period","revenue","netIncome","epsDiluted"`,
    `"2026-07-27","NVDA","USD","2027","Q2",46000000000,26000000000,1.08`,
    `"2026-06-30","2330.TW","TWD","2026","Q2",1,1,1`,
  ].join("\n"),
};

const fetchMock = vi.fn(async (url: string) => {
  const u = new URL(url);
  const path = u.pathname.replace("/stable/", "");
  if (path === "profile-bulk" && u.searchParams.get("part") !== "0") return new Response("Query Error", { status: 400 });
  const body = CSV[path];
  return body === undefined ? new Response("[]", { headers: { "content-type": "application/json" } }) : new Response(body, { headers: { "content-type": "text/csv" } });
});

beforeAll(async () => {
  process.env.DATA_DIR = tmpDir;
  process.env.FMP_API_KEY = "test-key";
  vi.stubGlobal("fetch", fetchMock);
  store = await import("./bulk-store.js");
  ({ db } = await import("../db.js"));
  (await import("../providers/fmp-bulk.js")).resetState(0);
});
afterAll(() => {
  vi.unstubAllGlobals();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const ds = (name: string) => store.DATASETS.find((d) => d.name === name)!;
const NOW = new Date("2026-10-21T14:00:00Z"); // 10 AM New York

async function loadAll() {
  for (const name of ["profile", "ratios-ttm", "rating", "price-target-summary", "income-statement-growth"]) {
    const r = await store.runDataset(ds(name), NOW);
    expect(r.error).toBeUndefined();
  }
}

describe("refresh", () => {
  beforeEach(() => {
    for (const d of store.DATASETS) db.exec(`DELETE FROM ${d.table}`);
    db.exec("DELETE FROM bulk_datasets");
    fetchMock.mockClear();
  });

  it("keeps US listings only, in the app's symbol form", async () => {
    const r = await store.runDataset(ds("profile"), NOW);
    expect(r).toMatchObject({ dataset: "profile", rows: 5, calls: 1 });
    const symbols = (db.prepare("SELECT symbol FROM bulk_profiles ORDER BY symbol").all() as Array<{ symbol: string }>).map((x) => x.symbol);
    expect(symbols).toEqual(["ACME", "BRK.B", "NVDA", "QQQ", "TSM"]);
    const row = db.prepare("SELECT * FROM bulk_profiles WHERE symbol = 'BRK.B'").get() as any;
    expect(row).toMatchObject({ company_name: "Berkshire Hathaway Inc.", market_cap: 1e12, is_etf: 0, is_actively_trading: 1, year_range: "400-520" });
    expect(JSON.parse(row.data)).toMatchObject({ symbol: "BRK.B", companyName: "Berkshire Hathaway Inc.", isEtf: false });

    // Other datasets keep the symbols profile-bulk listed in the US.
    await store.runDataset(ds("ratios-ttm"), NOW);
    expect((db.prepare("SELECT symbol FROM bulk_ratios_ttm ORDER BY symbol").all() as any[]).map((x) => x.symbol)).toEqual(["BRK.B", "NVDA", "TSM"]);
  });

  it("upserts by symbol, and drops symbols a complete snapshot no longer has", async () => {
    const d = ds("ratios-ttm");
    store.upsertRows(d, [{ symbol: "OLD", priceToEarningsRatioTTM: 9 }, { symbol: "NVDA", priceToEarningsRatioTTM: 1 }], "2026-10-20T10:00:00.000Z");
    await store.runDataset(ds("profile"), NOW);
    await store.runDataset(d, NOW);
    const rows = db.prepare("SELECT symbol, pe FROM bulk_ratios_ttm ORDER BY symbol").all();
    expect(rows).toEqual([
      { symbol: "BRK.B", pe: 15 },
      { symbol: "NVDA", pe: 50 },
      { symbol: "TSM", pe: 25 },
    ]);
  });

  it("upserts statements by symbol, date and period, and keeps history", async () => {
    const d = ds("income-statement");
    store.upsertRows(d, [{ symbol: "NVDA", date: "2026-04-26", period: "Q1", fiscalYear: "2027", revenue: 44e9 }], "2026-10-01T00:00:00.000Z");
    await store.runDataset(ds("profile"), NOW);
    const r = await store.runDataset(d, NOW);
    expect(r.calls).toBe(15); // three fiscal years (next, current, previous) × FY, Q1..Q4
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("income-statement-bulk")).map((c) => new URL(c[0]).searchParams.get("period"))).toEqual([
      "FY", "Q1", "Q2", "Q3", "Q4", "FY", "Q1", "Q2", "Q3", "Q4", "FY", "Q1", "Q2", "Q3", "Q4",
    ]);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("income-statement-bulk")).map((c) => new URL(c[0]).searchParams.get("year"))).toEqual(
      ["2027", "2026", "2025"].flatMap((y) => Array(5).fill(y))
    );
    // The same Q2 row comes back for every call (the mock ignores params); it is stored once.
    const rows = db.prepare("SELECT symbol, date, period, fiscal_year, revenue FROM bulk_income_statements ORDER BY date").all();
    expect(rows).toEqual([
      { symbol: "NVDA", date: "2026-04-26", period: "Q1", fiscal_year: "2027", revenue: 44e9 },
      { symbol: "NVDA", date: "2026-07-27", period: "Q2", fiscal_year: "2027", revenue: 46e9 },
    ]);
  });

  it("derives the rating score and records each dataset's run", async () => {
    await loadAll();
    expect(db.prepare("SELECT symbol, rating, overall_score FROM bulk_ratings ORDER BY symbol").all()).toEqual([
      { symbol: "NVDA", rating: "A-", overall_score: 4 },
      { symbol: "TSM", rating: "B", overall_score: 3 },
    ]);
    const status = store.datasets().find((s) => s.dataset === "profile")!;
    expect(status).toMatchObject({ table: "bulk_profiles", schedule: "daily", rows: 5, lastRunRows: 5, calls: 1, updatedAt: NOW.toISOString(), error: null });
    expect(store.datasets().find((s) => s.dataset === "dcf")).toMatchObject({ rows: 0, updatedAt: null });
  });

  it("records a failure, keeps the old rows, and retries an hour later", async () => {
    await store.runDataset(ds("profile"), NOW);
    fetchMock.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    const later = new Date(NOW.getTime() + 86_400_000);
    const r = await store.runDataset(ds("profile"), later);
    expect(r.error).toMatch(/fmp 503/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bulk_profiles").get()).toEqual({ n: 5 });
    const s = store.datasets().find((x) => x.dataset === "profile")!;
    expect(s).toMatchObject({ updatedAt: NOW.toISOString(), errorAt: later.toISOString() });
    expect(store.isDue(ds("profile"), new Date(later.getTime() + 30 * 60_000))).toBe(false);
    expect(store.isDue(ds("profile"), new Date(later.getTime() + 61 * 60_000))).toBe(true);
  });

  it("runDue refreshes due datasets only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await store.runDue(NOW);
    expect(first.map((r) => r.dataset)).toEqual(store.DATASETS.map((d) => d.name));
    expect(await store.runDue(new Date(NOW.getTime() + 3_600_000))).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("staleness", () => {
  const status = (updated_at: string) => ({ name: "x", row_count: 1, bytes: 1, calls: 1, duration_ms: 1, updated_at, error: null, error_at: null });

  it("finds the last 6 AM in New York, across DST", () => {
    expect(store.refreshBoundary(new Date("2026-10-21T14:00:00Z")).toISOString()).toBe("2026-10-21T10:00:00.000Z"); // EDT
    expect(store.refreshBoundary(new Date("2026-10-21T09:59:00Z")).toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(store.refreshBoundary(new Date("2026-12-01T12:00:00Z")).toISOString()).toBe("2026-12-01T11:00:00.000Z"); // EST
    expect(store.refreshBoundary(new Date("2026-12-01T10:30:00Z")).toISOString()).toBe("2026-11-30T11:00:00.000Z");
  });

  it("runs daily datasets after 6 AM New York once, weekly ones after seven days", () => {
    const daily = ds("profile");
    const weekly = ds("income-statement");
    expect(store.isDue(daily, NOW, status("") as any)).toBe(true); // never loaded
    expect(store.isDue(daily, NOW, status("2026-10-21T10:30:00Z") as any)).toBe(false);
    expect(store.isDue(daily, NOW, status("2026-10-21T09:30:00Z") as any)).toBe(true);
    expect(store.isDue(daily, new Date("2026-10-22T09:00:00Z"), status("2026-10-21T10:30:00Z") as any)).toBe(false); // 5 AM next day
    expect(store.isDue(daily, new Date("2026-10-22T10:01:00Z"), status("2026-10-21T10:30:00Z") as any)).toBe(true);
    expect(store.isDue(weekly, NOW, status("2026-10-16T12:00:00Z") as any)).toBe(false);
    expect(store.isDue(weekly, NOW, status("2026-10-14T12:00:00Z") as any)).toBe(true);
  });
});

describe("reads and the screen", () => {
  beforeAll(async () => {
    for (const d of store.DATASETS) db.exec(`DELETE FROM ${d.table}`);
    await loadAll();
  });

  it("profiles() joins TTM ratios and derives shares and the 52-week range", () => {
    const p = store.profiles(["NVDA", "BRK.B", "NOPE"]);
    expect([...p.keys()].sort()).toEqual(["BRK.B", "NVDA"]);
    expect(p.get("NVDA")).toEqual({
      symbol: "NVDA",
      name: "NVIDIA Corporation",
      exchange: "NASDAQ",
      sector: "Technology",
      industry: "Semiconductors",
      price: 200,
      marketCap: 5e12,
      sharesOutstanding: 25e9,
      beta: 2.2,
      avgVolume: 120e6,
      week52Low: 150,
      week52High: 250,
      pe: 50,
      eps: 4,
      dividendYield: 0.0002,
    });
    expect(store.profiles([]).size).toBe(0);
  });

  it("topByMarketCap() lists exchange-listed stocks only, biggest first", () => {
    expect(store.topByMarketCap(10)).toEqual(["NVDA", "TSM", "BRK.B"]);
    expect(store.topByMarketCap(1)).toEqual(["NVDA"]);
  });

  const q = (o: Partial<import("./bulk-store.js").ScreenQuery> = {}) => ({ sort: "marketCap" as const, order: "desc" as const, limit: 50, ...o });

  it("filters, sorts and returns the base fields plus the filtered ones", () => {
    const { rows, asOf } = store.screen(q({ sector: "technology", peMax: 40 }));
    expect(asOf).toBe(NOW.toISOString());
    expect(rows).toEqual([
      { symbol: "TSM", companyName: "Taiwan Semiconductor", sector: "Technology", industry: "Semiconductors", exchange: "NYSE", price: 300, marketCap: 1.5e12, priceToEarningsRatioTTM: 25 },
    ]);
  });

  it("uses the latest fiscal year's growth, the rating score and the price-target upside", () => {
    // NVDA's FY2026 grew EPS 50% (FY2025: 147%); TSM's latest grew 40%.
    const { rows } = store.screen(q({ epsGrowthMin: 0.45, fields: ["growthFiscalYear", "upsidePercent", "overallScore", "isAdr"] }));
    expect(rows).toEqual([
      {
        symbol: "NVDA",
        companyName: "NVIDIA Corporation",
        sector: "Technology",
        industry: "Semiconductors",
        exchange: "NASDAQ",
        price: 200,
        marketCap: 5e12,
        growthFiscalYear: "2026",
        upsidePercent: 25,
        overallScore: 4,
        isAdr: false,
        growthEPS: 0.5,
      },
    ]);
    // TSM has no target last quarter, so its upside uses last year's average.
    expect(store.screen(q({ ratingMin: 3, upsideMin: 5 })).rows.map((r) => [r.symbol, r.overallScore])).toEqual([
      ["NVDA", 4],
      ["TSM", 3],
    ]);
    expect(store.screen(q({ ratingMin: 4, betaMax: 2 })).rows).toEqual([]);
  });

  it("skips OTC unless asked, sorts nulls last and honours asc", () => {
    expect(store.screen(q()).rows.map((r) => r.symbol)).toEqual(["NVDA", "TSM", "BRK.B"]);
    expect(store.screen(q({ exchange: ["OTC"] })).rows.map((r) => r.symbol)).toEqual(["ACME"]);
    expect(store.screen(q({ sort: "upsidePercent", order: "asc" })).rows.map((r) => [r.symbol, r.upsidePercent])).toEqual([
      ["TSM", 10],
      ["NVDA", 25],
      ["BRK.B", null],
    ]);
    expect(store.screen(q({ limit: 1 })).rows).toHaveLength(1);
  });

  it("binds values and rejects fields outside the whitelist", () => {
    const evil = "Technology' OR 1=1; DROP TABLE bulk_profiles; --";
    expect(store.screen(q({ sector: evil })).rows).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bulk_profiles").get()).toEqual({ n: 5 });
    expect(() => store.buildScreen(q({ sort: "marketCap; DROP TABLE bulk_profiles" as any }))).toThrow(/unknown field/);
    expect(() => store.buildScreen(q({ fields: ["data" as any] }))).toThrow(/unknown field/);
    expect(() => store.buildScreen(q({ sort: "companyName" }))).toThrow(/cannot sort/);
    const { sql, args } = store.buildScreen(q({ sector: evil, marketCapMin: 1e11 }));
    expect(sql).not.toContain("DROP");
    expect(args).toContain(evil);
  });
});
