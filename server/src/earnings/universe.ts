import { db } from "../db.js";
import { allAssets } from "../providers/alpaca-assets.js";
import "../research/bulk-store.js"; // creates bulk_profiles

// The names the earnings store covers: US-listed common stock and ADRs. bulk_profiles
// also lists preferreds, baby bonds, notes, warrants and rights under their parent's
// company name, so the security's own name (Nasdaq Trader's directories, via
// alpaca-assets, cached for a day) decides.

// Preferred stock and the debt that trades like a stock, warrants, rights and units.
const NOT_COMMON = /\bpreferred\b|\bpref\b|\bnotes?\b|\bdebentures?\b|\bbonds?\b|\bwarrants?\b|\brights?\b|\bunits?\b|\d%|% series|\bseries [a-z]\b.*\b(cumulative|fixed|floating|perpetual)\b|\bsubordinated\b|\bsenior\b.*\bdue\b|\bdue \d{4}\b|\btrust certificates?\b|\bstrats\b|\bsecurities, series\b/i;
// A name that says plain common/ordinary shares keeps a loose word such as "Unit" (Unit Corporation).
const COMMON = /\b(common stock|ordinary shares?|common shares?|class [a-z] common|american depositary (shares?|receipts?))\b/i;
const HARD = /\bstrats\b|\bsecurities, series\b|\bpreferred\b|\bnotes?\b|\bdebentures?\b|\bbonds?\b|\bwarrants?\b|\bdue \d{4}\b|\d%|% series|\bsubordinated\b/i;

/** Pure rule: whether a ticker and its security name are common stock or an ADR. */
export function isCommonOrAdr(symbol: string, name: string | null): boolean {
  if (/[-./]/.test(symbol)) return false;
  if (name === null) return true;
  if (NOT_COMMON.test(name)) return COMMON.test(name) && !HARD.test(name) && !/\b(warrants?|rights?)\b/i.test(name);
  return true;
}

let last: Set<string> | null = null;

/** Names from the directories; if they can't be loaded, the local symbols table (same source, stored). */
async function securityNames(): Promise<Map<string, string> | null> {
  try {
    return new Map((await allAssets()).map((a) => [a.symbol, a.name]));
  } catch {
    const rows = db.prepare("SELECT symbol, name FROM symbols WHERE active = 1 AND name IS NOT NULL").all() as Array<{ symbol: string; name: string }>;
    return rows.length > 0 ? new Map(rows.map((r) => [r.symbol, r.name])) : null;
  }
}

/**
 * US-listed (NYSE, NASDAQ, AMEX), actively trading common stock and ADRs, sorted. Not ETFs or funds; no
 * "-", "." or "/" in the ticker (so no share-class or preferred suffixes); no preferred, notes, bonds,
 * warrants, rights or units by security name.
 */
export async function earningsUniverse(): Promise<string[]> {
  const rows = db
    .prepare(
      `SELECT symbol FROM bulk_profiles
       WHERE exchange IN ('NYSE','NASDAQ','AMEX') AND COALESCE(is_etf,0) = 0 AND COALESCE(is_fund,0) = 0 AND is_actively_trading = 1
       ORDER BY symbol`
    )
    .all() as Array<{ symbol: string }>;
  const names = await securityNames();
  const kept = rows.map((r) => r.symbol).filter((s) => (names === null || names.has(s)) && isCommonOrAdr(s, names?.get(s) ?? null));
  last = new Set(kept);
  return kept;
}

/** The set from the latest earningsUniverse() call, for synchronous callers (snapshots); null before the first. */
export function lastEarningsUniverse(): Set<string> | null {
  return last;
}

/** The universe as a set. */
export async function earningsUniverseSet(): Promise<Set<string>> {
  return new Set(await earningsUniverse());
}
