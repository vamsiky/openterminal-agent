import { usListings } from "../history/universe.js";
import { CRYPTO_SYMBOLS, cryptoName } from "./alpaca-crypto.js";

// Searchable symbol list. Alpaca's /v2/assets is on the trading host, which
// alpaca.ts refuses, so US listings come from Nasdaq Trader's public symbol
// directories (the same files the history universe uses), plus the crypto
// pairs Alpaca serves. Refreshed daily.

/** Same fields as the /api/search results of the old providers. */
export type SearchResult = { symbol: string; name: string; exchange: string; type: string };

const TTL_MS = 24 * 3_600_000;

let assets: SearchResult[] | null = null;
let loadedAt = 0;
let loading: Promise<SearchResult[]> | null = null;

async function load(): Promise<SearchResult[]> {
  const listings = await usListings();
  const rows: SearchResult[] = listings.map((l) => ({
    symbol: l.symbol,
    name: l.name ?? l.symbol,
    exchange: l.exchange ?? "",
    type: l.isEtf ? "fund" : "stock",
  }));
  for (const ticker of CRYPTO_SYMBOLS) rows.push({ symbol: `${ticker}-USD`, name: cryptoName(ticker), exchange: "Crypto", type: "crypto" });
  return rows;
}

/** The cached list; reloads once a day. A failed reload keeps serving the stale list. */
export async function allAssets(now = Date.now()): Promise<SearchResult[]> {
  if (assets && now - loadedAt < TTL_MS) return assets;
  loading ??= load()
    .then((rows) => {
      assets = rows;
      loadedAt = now;
      return rows;
    })
    .finally(() => {
      loading = null;
    });
  try {
    return await loading;
  } catch (err) {
    if (assets) return assets;
    throw err;
  }
}

/** Test hook: drop the cached list. */
export function resetAssets(): void {
  assets = null;
  loadedAt = 0;
  loading = null;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** 0 exact symbol, 1 symbol prefix, 2 name starts with the query, 3 every query word starts a name word; null no match. */
function rank(a: SearchResult, q: string, qWords: string[]): number | null {
  const sym = a.symbol.toLowerCase();
  const plain = sym.replace(/-usd$/, "");
  if (sym === q || plain === q) return 0;
  if (sym.startsWith(q)) return 1;
  const name = a.name.toLowerCase();
  if (name.startsWith(q)) return 2;
  if (qWords.length === 0) return null;
  const nameWords = words(a.name);
  return qWords.every((w) => nameWords.some((n) => n.startsWith(w))) ? 3 : null;
}

/** Match `query` against symbol and security name; exact symbol first, then prefix, then name words. */
export async function search(query: string, limit = 15): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qWords = words(q);
  const hits: { a: SearchResult; r: number }[] = [];
  for (const a of await allAssets()) {
    const r = rank(a, q, qWords);
    if (r !== null) hits.push({ a, r });
  }
  hits.sort((x, y) => x.r - y.r || x.a.symbol.length - y.a.symbol.length || x.a.symbol.localeCompare(y.a.symbol));
  return hits.slice(0, limit).map((h) => h.a);
}
