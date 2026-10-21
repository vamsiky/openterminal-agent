import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UniverseSettings } from "../scan/contracts.js";

let tmpDir: string;
let uni: typeof import("./universe.js");
let pos: typeof import("./positions.js");
let db: typeof import("../db.js").db;

const base = (o: Partial<UniverseSettings> = {}): UniverseSettings => ({ ...uni.DEFAULT_UNIVERSE, ...o });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-universe-edge-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  uni = await import("./universe.js");
  pos = await import("./positions.js");

  const profile = db.prepare(
    `INSERT INTO bulk_profiles (symbol, company_name, exchange, sector, industry, country, price, market_cap, average_volume, is_etf, is_fund, is_adr, is_actively_trading, data, updated_at)
     VALUES (@symbol, @symbol, @exchange, @sector, @industry, 'US', @price, 1e9, @volume, @etf, @fund, 0, @active, '{}', '')`
  );
  const row = (symbol: string, o: Partial<Record<string, unknown>> = {}) =>
    profile.run({ exchange: "NYSE", sector: "Industrials", industry: "Machinery", price: 50, volume: 1_000_000, etf: 0, fund: 0, active: 1, ...o, symbol });

  row("EDGE5", { price: 5, volume: 4_000_000 }); // exactly the price floor and exactly $20M
  row("UNDER5", { price: 4.99, volume: 10_000_000 }); // a cent under the price floor
  row("DOLLAR", { price: 10, volume: 1_999_999 }); // $19,999,990: just under the dollar volume floor
  row("AMEX1", { exchange: "AMEX", price: 30, volume: 1_000_000 });
  row("CBOE1", { exchange: "CBOE", price: 30, volume: 1_000_000 });
  row("PINK", { exchange: "OTC", price: 30, volume: 1_000_000 });
  row("FUNDX", { fund: 1, price: 30, volume: 1_000_000 });
  row("ETFX", { etf: 1, price: 30, volume: 1_000_000 });
  row("HALT", { active: 0, price: 30, volume: 1_000_000 });
  row("NOSECT", { sector: null, price: 30, volume: 1_000_000 });
  row("7203.T", { exchange: "NYSE", price: 30, volume: 1_000_000 }); // a Tokyo listing whose profile says US
  row("HOLD", { sector: "Energy", price: 2, volume: 100 }); // illiquid, but a holding

  db.prepare("INSERT INTO watchlists (id, name) VALUES (10, 'Core'), (11, 'Empty')").run();
  const item = db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)");
  [["EDGE5", "WL"], ["7203.T", "WL"], ["^VIX", "WL"], ["AAA-B", "WL"]].forEach(([s], i) => item.run(10, s, i));
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("liquidity boundaries (sector and market modes)", () => {
  it("keeps a stock exactly at the price floor and the dollar-volume floor", () => {
    expect(uni.resolveUniverse(base({ mode: "market" }))).toEqual(["AMEX1", "CBOE1", "EDGE5", "NOSECT"]); // market mode does not filter on sector
  });

  it("drops a stock a cent under the price floor, or $10 short of the dollar-volume floor", () => {
    const syms = uni.resolveUniverse(base({ mode: "market" }));
    expect(syms).not.toContain("UNDER5");
    expect(syms).not.toContain("DOLLAR");
  });

  it("moves the floors with the settings", () => {
    expect(uni.resolveUniverse(base({ mode: "market", minAvgDollarVolume: 19_999_990 }))).toContain("DOLLAR");
    expect(uni.resolveUniverse(base({ mode: "market", minPrice: 4.99 }))).toContain("UNDER5");
    expect(uni.resolveUniverse(base({ mode: "market", minPrice: 5.01 }))).not.toContain("EDGE5");
  });

  it("excludes ETFs, funds, inactive names and OTC listings", () => {
    const syms = uni.resolveUniverse(base({ mode: "market", minPrice: 0, minAvgDollarVolume: 0 }));
    for (const s of ["ETFX", "FUNDX", "HALT", "PINK"]) expect(syms).not.toContain(s);
    expect(uni.resolveUniverse(base({ mode: "sector", sectors: ["Industrials", "Energy"], minPrice: 0, minAvgDollarVolume: 0 }))).not.toContain("NOSECT");
  });

  it("requireOptions has no effect yet (the bulk profile carries no optionable flag)", () => {
    expect(uni.resolveUniverse(base({ mode: "market", requireOptions: false }))).toEqual(uni.resolveUniverse(base({ mode: "market", requireOptions: true })));
  });

  it("applies the industry narrowing case-insensitively and yields nothing for an unknown one", () => {
    expect(uni.resolveUniverse(base({ mode: "sector", sectors: ["INDUSTRIALS"], industries: ["machinery"], minPrice: 0, minAvgDollarVolume: 0 }))).toEqual(["AMEX1", "CBOE1", "DOLLAR", "EDGE5", "UNDER5"]);
    expect(uni.resolveUniverse(base({ mode: "sector", sectors: ["Industrials"], industries: ["Nonexistent"] }))).toEqual([]);
  });
});

describe("holdings and the US-only rule", () => {
  it("always adds holdings, even illiquid ones outside the sector", () => {
    pos.importPositions("symbol,quantity\nHOLD,10\nNVDA261120C00300000,1");
    expect(uni.resolveUniverse(base({ mode: "sector", sectors: ["Technology"] }))).toEqual(["HOLD", "NVDA"]);
    expect(uni.resolveUniverse(base({ mode: "sector", sectors: [] }))).toEqual(["HOLD", "NVDA"]);
    expect(uni.resolveUniverse(base({ mode: "watchlists", watchlistIds: [] }))).toEqual(["HOLD", "NVDA"]);
    db.prepare("DELETE FROM positions").run();
  });

  it("keeps the foreign listing out of every mode, including the watchlists", () => {
    for (const mode of ["watchlists", "market"] as const) {
      expect(uni.resolveUniverse(base({ mode, minPrice: 0, minAvgDollarVolume: 0 }))).not.toContain("7203.T");
    }
    expect(uni.resolveUniverse(base({ mode: "watchlists" }))).toEqual(["EDGE5"]);
  });

  it("merges a holding that is also on a watchlist without duplicates", () => {
    pos.importPositions("symbol,quantity\nEDGE5,10");
    expect(uni.resolveUniverse(base({ mode: "watchlists", watchlistIds: [10] }))).toEqual(["EDGE5"]);
    db.prepare("DELETE FROM positions").run();
  });
});

describe("empty and missing watchlists", () => {
  it("returns nothing for an empty watchlist or an id that doesn't exist", () => {
    expect(uni.resolveUniverse(base({ watchlistIds: [11] }))).toEqual([]);
    expect(uni.resolveUniverse(base({ watchlistIds: [999] }))).toEqual([]);
  });

  it("returns nothing in sector mode with no sectors chosen, but still holdings", () => {
    expect(uni.resolveUniverse(base({ mode: "sector", sectors: [] }))).toEqual([]);
    pos.importPositions("symbol,quantity\nKO,10");
    expect(uni.resolveUniverse(base({ mode: "sector", sectors: [] }))).toEqual(["KO"]);
    db.prepare("DELETE FROM positions").run();
  });
});

describe("saved settings", () => {
  it("falls back to the defaults for corrupt JSON and fills missing keys from older saves", () => {
    db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('universe', ?)").run("{not json");
    expect(uni.getUniverseSettings()).toEqual(uni.DEFAULT_UNIVERSE);
    db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('universe', ?)").run(JSON.stringify({ mode: "market", minPrice: 10 }));
    expect(uni.getUniverseSettings()).toEqual({ ...uni.DEFAULT_UNIVERSE, mode: "market", minPrice: 10 });
    db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('universe', ?)").run(JSON.stringify({ mode: "galaxy" }));
    expect(uni.getUniverseSettings()).toEqual(uni.DEFAULT_UNIVERSE);
    uni.setUniverseSettings(uni.DEFAULT_UNIVERSE);
  });

  it("rejects too many sectors and a non-integer watchlist id", () => {
    expect(() => uni.setUniverseSettings(base({ sectors: Array.from({ length: 31 }, (_, i) => `S${i}`) }))).toThrow();
    expect(() => uni.setUniverseSettings(base({ watchlistIds: [1.5] }))).toThrow();
  });
});
