import { beforeEach, describe, expect, it, vi } from "vitest";

// Heatmap/screener rows: universe × prices × reference data, every source mocked.

const liveQuotes = new Map<string, { price: number; changePercent: number; volume: number }>();
vi.mock("../live/feed.js", () => ({
  enabled: () => liveQuotes.size > 0,
  liveQuote: (a: string) => liveQuotes.get(a) ?? null,
}));
vi.mock("../history/universe.js", () => ({
  alpacaSymbol: (s: string) => (/^[A-Z.]+$/.test(s) ? s : null),
  sp500: vi.fn(async () => ["AAPL", "BRK.B", "XOM"]),
  nasdaq100: vi.fn(async () => ["AAPL", "NVDA"]),
}));
vi.mock("../providers/alpaca.js", () => ({ isConfigured: vi.fn(() => true), snapshots: vi.fn() }));
vi.mock("../providers/alpaca-assets.js", () => ({
  allAssets: vi.fn(async () => [
    { symbol: "AAPL", name: "Apple Inc. - Common Stock", exchange: "Nasdaq", type: "stock" },
    { symbol: "NVDA", name: "NVIDIA Corporation - Common Stock", exchange: "Nasdaq", type: "stock" },
  ]),
}));
vi.mock("../providers/sec-reference.js", () => ({ reference: vi.fn() }));
vi.mock("../providers/fmp.js", () => ({ isConfigured: vi.fn(() => false), profiles: vi.fn() }));
const bulkProfiles = new Map<string, object>();
vi.mock("../research/bulk-store.js", () => ({
  topByMarketCap: vi.fn((n: number) => [...bulkProfiles.keys()].slice(0, n)),
  profiles: vi.fn((symbols: string[]) => new Map(symbols.filter((s) => bulkProfiles.has(s)).map((s) => [s, bulkProfiles.get(s)]))),
}));

const rows = await import("./market-rows.js");
const alpaca = await import("../providers/alpaca.js");
const sec = await import("../providers/sec-reference.js");
const fmp = await import("../providers/fmp.js");
const bulk = await import("../research/bulk-store.js");

const snap = (price: number, prev: number, v = 10) => ({
  latestTrade: { t: "2026-10-20T15:00:00Z", p: price, s: 1 },
  dailyBar: { t: "", o: 0, h: 0, l: 0, c: price, v },
  prevDailyBar: { t: "", o: 0, h: 0, l: 0, c: prev, v },
});

beforeEach(() => {
  rows.resetRows();
  liveQuotes.clear();
  bulkProfiles.clear();
  vi.mocked(alpaca.snapshots).mockReset();
  vi.mocked(sec.reference).mockReset().mockResolvedValue(new Map());
  vi.mocked(fmp.isConfigured).mockReturnValue(false);
});

describe("buildRows", () => {
  it("joins prices, reference data and listings, biggest market cap first", () => {
    const out = rows.buildRows(
      ["A", "B", "C", "D"],
      new Map([
        ["A", { price: 10, changePercent: 1, volume: 5 }],
        ["B", { price: 20, changePercent: -1, volume: 6 }],
        ["C", { price: 30, changePercent: 0, volume: 7 }],
        ["D", { price: null, changePercent: null, volume: null }],
      ]),
      new Map([
        ["A", { name: "A CORP", sector: "Energy", marketCap: null, sharesOutstanding: 100 }],
        ["B", { name: "B Inc", sector: "Technology", marketCap: 5_000, sharesOutstanding: null }],
      ]),
      new Map([["A", { name: "A Corp. - Class A Common Stock", exchange: "NYSE" }]])
    );
    expect(out).toEqual([
      { symbol: "B", name: "B Inc", price: 20, changePercent: -1, volume: 6, marketCap: 5_000, sector: "Technology", exchange: "" },
      { symbol: "A", name: "A Corp.", price: 10, changePercent: 1, volume: 5, marketCap: 1_000, sector: "Energy", exchange: "NYSE" },
      { symbol: "C", name: "C", price: 30, changePercent: 0, volume: 7, marketCap: null, sector: "Other", exchange: "" },
    ]);
  });

  it("reads change from a snapshot's previous close", () => {
    expect(rows.snapshotPrice(snap(110, 100) as any)).toEqual({ price: 110, changePercent: 10, volume: 10 });
    expect(rows.snapshotPrice(null)).toEqual({ price: null, changePercent: null, volume: null });
  });

  it("uses the regular session's close, not an after-hours last trade", () => {
    const afterHours = { ...snap(110, 100), latestTrade: { t: "2026-10-20T22:00:00Z", p: 115, s: 1 } };
    expect(rows.snapshotPrice(afterHours as any)).toEqual({ price: 110, changePercent: 10, volume: 10 });
  });
});

describe("usMarketRows", () => {
  it("prices the S&P 500 ∪ Nasdaq-100 from snapshots and fills sector and cap from SEC in the background", async () => {
    vi.mocked(alpaca.snapshots).mockResolvedValue({ AAPL: snap(200, 190), "BRK.B": snap(500, 500), XOM: snap(100, 101), NVDA: snap(180, 170) } as any);
    vi.mocked(sec.reference).mockImplementation(async (symbols) => {
      const known: Record<string, [string, number | null]> = { AAPL: ["Technology", 15], XOM: ["Energy", 4], NVDA: ["Technology", 24] };
      return new Map(symbols.filter((s) => known[s]).map((s) => [s, { symbol: s, name: s, sector: known[s][0], sharesOutstanding: known[s][1] } as any]));
    });

    const first = await rows.usMarketRows();
    expect(alpaca.snapshots).toHaveBeenCalledWith(["AAPL", "BRK.B", "XOM", "NVDA"]);
    expect(first.map((r) => [r.symbol, r.price])).toEqual(expect.arrayContaining([["AAPL", 200], ["NVDA", 180]]));

    await rows.referencesSettled();
    const next = await rows.usMarketRows();
    expect(next.map((r) => [r.symbol, r.sector, r.marketCap])).toEqual([
      ["NVDA", "Technology", 24 * 180],
      ["AAPL", "Technology", 15 * 200],
      ["XOM", "Energy", 400],
      ["BRK.B", "Other", null],
    ]);
    expect(next[0].name).toBe("NVIDIA Corporation");
  });

  it("skips a failed reference chunk and keeps loading the rest", async () => {
    vi.mocked(alpaca.snapshots).mockResolvedValue({ AAPL: snap(200, 190), "BRK.B": snap(500, 500), XOM: snap(100, 101), NVDA: snap(180, 170) } as any);
    vi.mocked(sec.reference).mockImplementation(async (symbols) => {
      if (symbols.includes("XOM")) throw new Error("sec edgar 503");
      return new Map(symbols.map((s) => [s, { symbol: s, name: s, sector: "Technology", sharesOutstanding: 10 } as any]));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    rows.loadReferences(["AAPL", "XOM", "NVDA"], 1);
    await rows.referencesSettled();
    const out = await rows.usMarketRows();
    expect(out.filter((r) => r.marketCap !== null).map((r) => r.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 chunk(s): sec edgar 503"));
    warn.mockRestore();
  });

  it("prefers the live feed's memory over snapshots, and FMP profiles over SEC when keyed", async () => {
    for (const s of ["AAPL", "BRK.B", "XOM", "NVDA"]) liveQuotes.set(s, { price: 50, changePercent: 2, volume: 9 });
    vi.mocked(fmp.isConfigured).mockReturnValue(true);
    vi.mocked(fmp.profiles).mockResolvedValue(new Map([["XOM", { name: "Exxon Mobil", sector: "Energy", marketCap: 9e11 } as any]]));

    await rows.usMarketRows();
    await rows.referencesSettled();
    const out = await rows.usMarketRows();
    expect(alpaca.snapshots).not.toHaveBeenCalled();
    expect(sec.reference).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ symbol: "XOM", name: "Exxon Mobil", sector: "Energy", marketCap: 9e11, price: 50, changePercent: 2 });
  });

  it("takes the top of the bulk profiles plus the index members, with bulk name, sector and shares", async () => {
    // Bulk market caps are a day old: shares (cap / bulk price) × the live price gives today's.
    const profile = (name: string, sector: string, marketCap: number, price: number) => ({ name, sector, exchange: "NYSE", marketCap, price, sharesOutstanding: marketCap / price });
    bulkProfiles.set("NVDA", profile("NVIDIA Corporation (bulk)", "Technology", 5e12, 200));
    bulkProfiles.set("TSM", profile("Taiwan Semiconductor", "Technology", 1.5e12, 300));
    bulkProfiles.set("XOM", profile("Exxon Mobil Corporation", "Energy", 4e11, 100));
    vi.mocked(alpaca.snapshots).mockResolvedValue({ AAPL: snap(200, 190), "BRK.B": snap(500, 500), XOM: snap(110, 100), NVDA: snap(180, 170), TSM: snap(300, 300) } as any);
    vi.mocked(sec.reference).mockImplementation(async (symbols) => new Map(symbols.map((s) => [s, { symbol: s, name: s, sector: "Other SEC", sharesOutstanding: 10 } as any])));

    const symbols = await rows.universe();
    expect(symbols).toEqual(["NVDA", "TSM", "XOM", "AAPL", "BRK.B"]);
    await rows.usMarketRows();
    await rows.referencesSettled();
    // Only the symbols missing from bulk go to the per-symbol sources.
    expect(vi.mocked(sec.reference).mock.calls.flat(2)).toEqual(["AAPL", "BRK.B"]);
    const out = await rows.usMarketRows();
    expect(out.find((r) => r.symbol === "NVDA")).toEqual({
      symbol: "NVDA", name: "NVIDIA Corporation (bulk)", price: 180, changePercent: expect.any(Number), volume: 10, marketCap: 25e9 * 180, sector: "Technology", exchange: "Nasdaq",
    });
    expect(out.find((r) => r.symbol === "TSM")).toMatchObject({ name: "Taiwan Semiconductor", exchange: "NYSE", marketCap: 1.5e12 });
    expect(out.find((r) => r.symbol === "XOM")).toMatchObject({ sector: "Energy", marketCap: 4e9 * 110 });
    expect(out.find((r) => r.symbol === "AAPL")).toMatchObject({ sector: "Other SEC", marketCap: 2000 });
  });

  it("falls back to the index members alone when the bulk tables are unreadable", async () => {
    vi.mocked(bulk.topByMarketCap).mockImplementationOnce(() => {
      throw new Error("no such table");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await rows.universe()).toEqual(["AAPL", "BRK.B", "XOM", "NVDA"]);
    warn.mockRestore();
  });
});
