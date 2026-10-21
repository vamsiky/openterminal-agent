// Characters seen in tickers: AAPL, BRK-B, ^GSPC, 0700.HK,
// EURUSD=X, GC=F, M&M.NS. Commas are excluded because the quote endpoints
// take comma-separated symbol lists, and at least one alphanumeric is required
// so dot-only values like ".." can't act as path segments.
const SYMBOL_RE = /^(?=.*[A-Z0-9])[A-Z0-9.\-^=&]{1,20}$/;

/** Uppercases and trims free-text ticker input; null when it isn't a plausible symbol. */
export function normalizeSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

/** Encodes symbols for a `?symbols=` query, keeping the comma separator literal. */
export function symbolsParam(symbols: string[]): string {
  return symbols.map(encodeURIComponent).join(",");
}

/** Search results name stocks "Apple Inc. - Common Stock"; the suffix is noise in a one-line result. */
export function searchName(name: string | null | undefined): string {
  return (name ?? "").replace(/ - (Common Stock|Class [A-Z] Common Stock|Ordinary Shares)$/i, "");
}

/** True for a symbol listed outside the US (0700.HK, SHOP.TO); a single-letter suffix is a US share class (BRK.B). US-listed symbols only. */
export function isForeignSymbol(raw: string): boolean {
  const s = raw.trim().toUpperCase();
  return /^\d+[A-Z0-9-]*\./.test(s) || /\.[A-Z]{2,}$/.test(s);
}

export const US_ONLY_MESSAGE = "US-listed symbols only (e.g. TSM for TSMC)";
