import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let uni: typeof import("./universe.js");
let pos: typeof import("./positions.js");
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-universe-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  uni = await import("./universe.js");
  pos = await import("./positions.js");

  const profile = db.prepare(
    `INSERT INTO bulk_profiles (symbol, company_name, exchange, sector, industry, country, price, market_cap, average_volume, is_etf, is_fund, is_adr, is_actively_trading, data, updated_at)
     VALUES (@symbol, @symbol, @exchange, @sector, @industry, 'US', @price, 1e9, @volume, @etf, 0, 0, @active, '{}', '')`
  );
  const row = (symbol: string, o: Partial<Record<string, unknown>> = {}) =>
    profile.run({ exchange: "NASDAQ", sector: "Technology", industry: "Software", price: 100, volume: 1_000_000, etf: 0, active: 1, ...o, symbol });
  row("AAA");
  row("BBB", { sector: "Healthcare", industry: "Biotech" });
  row("CCC", { price: 3 }); // under the price floor
  row("DDD", { volume: 1000 }); // illiquid
  row("EEE", { etf: 1 });
  row("FFF", { active: 0 });
  row("GGG", { exchange: "OTC" });
  row("HHH", { industry: "Hardware" });

  // Exchange listings: ZZZ is listed (an ETF, say) though it has no FMP profile; DOGE and the rest are not.
  db.prepare("INSERT INTO symbols (symbol, active) VALUES ('ZZZ', 1), ('OLD', 0), ('KO', 1), ('NVDA', 1)").run();
  db.prepare("INSERT INTO watchlists (id, name) VALUES (1, 'One'), (2, 'Two')").run();
  const item = db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)");
  [[1, "AAA"], [1, "BBB"], [1, "^VIX"], [1, "BTC-USD"], [2, "ZZZ"], [2, "7203.T"], [2, "DOGE"], [2, "OLD"], [2, "SHIB-USD"], [2, "aaa"]].forEach(([id, s], i) => item.run(id, s, i));
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const settings = (o: Partial<import("../scan/contracts.js").UniverseSettings>) => ({ ...uni.DEFAULT_UNIVERSE, ...o });

describe("settings", () => {
  it("defaults, saves and rejects bad input", () => {
    expect(uni.getUniverseSettings()).toEqual(uni.DEFAULT_UNIVERSE);
    uni.setUniverseSettings(settings({ mode: "sector", sectors: ["Technology"] }));
    expect(uni.getUniverseSettings()).toMatchObject({ mode: "sector", sectors: ["Technology"] });
    expect(() => uni.setUniverseSettings(settings({ minPrice: -1 }))).toThrow();
    uni.setUniverseSettings(uni.DEFAULT_UNIVERSE);
  });
});

describe("resolveUniverse", () => {
  it("watchlists mode: every list, US tickers only", () => {
    expect(uni.resolveUniverse(settings({}))).toEqual(["AAA", "BBB", "ZZZ"]);
  });

  it("drops symbols that are not US listings (crypto, delisted) but keeps held ones", () => {
    expect(uni.resolveUniverse(settings({ watchlistIds: [2] }))).not.toContain("DOGE");
    // A position the listings do not know (an import would now reject it; this is an older snapshot).
    db.prepare("INSERT INTO positions (kind, symbol, underlying, quantity) VALUES ('stock', 'NEWIPO', 'NEWIPO', 5)").run();
    expect(uni.resolveUniverse(settings({ watchlistIds: [2] }))).toEqual(["AAA", "NEWIPO", "ZZZ"]);
    pos.importPositions("symbol,quantity");
  });

  it("watchlists mode: chosen lists", () => {
    expect(uni.resolveUniverse(settings({ watchlistIds: [2] }))).toEqual(["AAA", "ZZZ"]);
    expect(uni.resolveUniverse(settings({ watchlistIds: [] }))).toEqual([]);
  });

  it("sector mode applies price, dollar volume, stock-only and exchange filters", () => {
    expect(uni.resolveUniverse(settings({ mode: "sector", sectors: ["technology"] }))).toEqual(["AAA", "HHH"]);
    expect(uni.resolveUniverse(settings({ mode: "sector", sectors: ["Technology"], industries: ["Hardware"] }))).toEqual(["HHH"]);
    expect(uni.resolveUniverse(settings({ mode: "sector", sectors: ["Technology"], minPrice: 0, minAvgDollarVolume: 0 }))).toEqual(["AAA", "CCC", "DDD", "HHH"]);
    expect(uni.resolveUniverse(settings({ mode: "sector", sectors: [] }))).toEqual([]);
  });

  it("market mode takes every liquid listed stock", () => {
    expect(uni.resolveUniverse(settings({ mode: "market" }))).toEqual(["AAA", "BBB", "HHH"]);
  });

  it("always includes holdings and option underlyings", () => {
    pos.importPositions("symbol,quantity\nKO,10\nNVDA261120C00300000,1");
    expect(uni.resolveUniverse(settings({ mode: "sector", sectors: ["Healthcare"] }))).toEqual(["BBB", "KO", "NVDA"]);
    pos.importPositions("symbol,quantity\nKO,10");
  });

  it("lists sectors with industries", () => {
    expect(uni.listSectors()).toEqual({
      sectors: ["Healthcare", "Technology"],
      industries: [
        { sector: "Healthcare", industry: "Biotech" },
        { sector: "Technology", industry: "Hardware" },
        { sector: "Technology", industry: "Software" },
      ],
    });
  });
});
