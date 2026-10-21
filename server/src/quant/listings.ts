import { db } from "../db.js";
import "../history/store.js"; // creates the symbols (exchange listings) table
import { isForeignSymbol } from "../history/universe.js";
import "../research/bulk-store.js"; // creates bulk_profiles

/**
 * Symbols that are US-listed securities: in the exchange listings (`symbols`)
 * or the FMP profiles. Keeps crypto (DOGE), forex, index tickers and foreign
 * listings (VOD.L) out. Null when neither table is loaded yet, which callers
 * read as "can't tell, don't filter".
 */
export function listedSymbols(): Set<string> | null {
  const rows = db.prepare("SELECT symbol FROM symbols WHERE active = 1 UNION SELECT symbol FROM bulk_profiles").all() as Array<{ symbol: string }>;
  return rows.length > 0 ? new Set(rows.map((r) => r.symbol)) : null;
}

/** Not a foreign-looking ticker and, where listings are known, present in them. */
export function isUsListed(symbol: string, listed: Set<string> | null): boolean {
  return !isForeignSymbol(symbol) && (listed === null || listed.has(symbol));
}
