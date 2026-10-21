import { z } from "zod";
import { db } from "../db.js";
import { isForeignSymbol } from "../history/universe.js";
import { LISTED_EXCHANGES } from "../research/bulk-store.js";
import type { UniverseSettings } from "../scan/contracts.js";
import { heldSymbols } from "./positions.js";

// Which symbols the scans cover. The mode picks a base set (watchlists, FMP
// sectors, or the whole US market after liquidity filters); holdings are
// always added. Settings live in scan_settings (key "universe", JSON).

db.exec(`
CREATE TABLE IF NOT EXISTS scan_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const DEFAULT_UNIVERSE: UniverseSettings = {
  mode: "watchlists",
  watchlistIds: null,
  sectors: [],
  industries: [],
  minPrice: 5,
  minAvgDollarVolume: 20_000_000,
  requireOptions: true,
};

export const universeSchema = z.object({
  mode: z.enum(["watchlists", "sector", "market"]),
  watchlistIds: z.array(z.number().int()).max(500).nullable(),
  sectors: z.array(z.string().min(1).max(80)).max(30),
  industries: z.array(z.string().min(1).max(120)).max(200),
  minPrice: z.number().min(0).max(100_000),
  minAvgDollarVolume: z.number().min(0).max(1e12),
  requireOptions: z.boolean(),
});

export function getUniverseSettings(): UniverseSettings {
  const row = db.prepare("SELECT value FROM scan_settings WHERE key = 'universe'").get() as { value: string } | undefined;
  if (!row) return { ...DEFAULT_UNIVERSE };
  try {
    // Missing keys (settings saved by an older version) fall back to the defaults.
    const parsed = universeSchema.safeParse({ ...DEFAULT_UNIVERSE, ...JSON.parse(row.value) });
    return parsed.success ? parsed.data : { ...DEFAULT_UNIVERSE };
  } catch {
    return { ...DEFAULT_UNIVERSE };
  }
}

export function setUniverseSettings(settings: UniverseSettings): UniverseSettings {
  const clean = universeSchema.parse(settings);
  db.prepare(
    "INSERT INTO scan_settings (key, value, updated_at) VALUES ('universe', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(JSON.stringify(clean));
  return clean;
}

/** US stock tickers only: no indices (^VIX), crypto (BTC-USD), futures or foreign listings. */
const TICKER = /^[A-Z][A-Z0-9]{0,5}(\.[A-Z])?$/;
export const isScannable = (symbol: string) => TICKER.test(symbol) && !isForeignSymbol(symbol);

/**
 * Symbols passing the sector/market filters. `requireOptions` can't be applied:
 * the bulk profile has no optionable flag, so every liquid stock is assumed
 * to have a chain (the sweep skips ones that don't).
 */
function marketSymbols(s: UniverseSettings, sectorsOnly: boolean): string[] {
  const where = [
    "is_etf = 0",
    "is_fund = 0",
    "is_actively_trading = 1",
    "exchange IN (SELECT value FROM json_each(?))",
    "price >= ?",
    "price * average_volume >= ?",
  ];
  const args: Array<string | number> = [JSON.stringify(LISTED_EXCHANGES), s.minPrice, s.minAvgDollarVolume];
  if (sectorsOnly) {
    where.push("lower(sector) IN (SELECT lower(value) FROM json_each(?))");
    args.push(JSON.stringify(s.sectors));
    if (s.industries.length > 0) {
      where.push("lower(industry) IN (SELECT lower(value) FROM json_each(?))");
      args.push(JSON.stringify(s.industries));
    }
  }
  const rows = db.prepare(`SELECT symbol FROM bulk_profiles WHERE ${where.join(" AND ")}`).all(...args) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

function watchlistSymbols(ids: number[] | null): string[] {
  const rows = (
    ids === null
      ? db.prepare("SELECT DISTINCT symbol FROM watchlist_items")
      : db.prepare("SELECT DISTINCT symbol FROM watchlist_items WHERE watchlist_id IN (SELECT value FROM json_each(?))")
  ).all(...(ids === null ? [] : [JSON.stringify(ids)])) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

/** The mode's set plus holdings (stocks and option underlyings), US tickers only, sorted. */
export function resolveUniverse(settings = getUniverseSettings()): string[] {
  const base =
    settings.mode === "watchlists"
      ? watchlistSymbols(settings.watchlistIds)
      : settings.mode === "sector"
        ? settings.sectors.length > 0
          ? marketSymbols(settings, true)
          : []
        : marketSymbols(settings, false);
  return [...new Set([...base, ...heldSymbols()].map((s) => s.toUpperCase()))].filter(isScannable).sort();
}

/** FMP sectors and their industries, from the bulk profiles (stocks only), sorted, for the settings screen. */
export function listSectors(): { sectors: string[]; industries: Array<{ sector: string; industry: string }> } {
  const rows = db
    .prepare(
      `SELECT DISTINCT sector, industry FROM bulk_profiles
       WHERE is_etf = 0 AND is_fund = 0 AND is_actively_trading = 1 AND sector IS NOT NULL AND sector != ''
       ORDER BY sector, industry`
    )
    .all() as Array<{ sector: string; industry: string | null }>;
  return {
    sectors: [...new Set(rows.map((r) => r.sector))],
    industries: rows.filter((r) => r.industry).map((r) => ({ sector: r.sector, industry: r.industry! })),
  };
}
