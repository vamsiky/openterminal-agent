import { cached } from "../cache.js";
import * as alpaca from "../providers/alpaca.js";
import * as fmp from "../providers/fmp.js";
import * as secReference from "../providers/sec-reference.js";
import { allAssets } from "../providers/alpaca-assets.js";
import type { MarketRow } from "../providers/types.js";
import { alpacaSymbol, nasdaq100, sp500 } from "../history/universe.js";
import * as live from "../live/feed.js";
import * as bulk from "../research/bulk-store.js";

// Rows for the heatmap, screener, sector list and recap: the 1,500 biggest US
// stocks in FMP's bulk profiles (research/bulk-store.ts) plus the S&P 500 and
// Nasdaq-100 members, priced from Alpaca (the live feed's memory, else REST
// snapshots). Name, sector and market cap come from the bulk profiles; a
// symbol they don't have gets them from FMP's per-symbol profile when
// FMP_API_KEY is set, else from SEC EDGAR (a coarse sector from the SIC code,
// shares × price). Sectors are not GICS, which is licensed.
//
// That per-symbol reference data loads in the background a chunk at a time,
// so after a cold start the rows carry prices at once and fill in sector and
// market cap as the chunks arrive (SEC: about 0.4 s per new ticker, then
// cached a week).

export class AlpacaNotConfigured extends Error {
  constructor() {
    super("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set");
    this.name = "AlpacaNotConfigured";
  }
}

export type RowPrice = { price: number | null; changePercent: number | null; volume: number | null };
export type RowReference = {
  name: string | null;
  sector: string | null;
  marketCap: number | null;
  sharesOutstanding: number | null;
  /** From the bulk profiles: its name beats the listing's, its exchange fills in for a missing listing. */
  bulk?: { exchange: string | null };
};
export type RowListing = { name: string; exchange: string };

const UNIVERSE_TTL = 24 * 3_600_000;
const BULK_UNIVERSE = 1_500;
const BULK_UNIVERSE_TTL = 10 * 60_000;
const SNAPSHOT_TTL = 15_000;
const SNAPSHOT_BATCH = 500;
const REFERENCE_CHUNK = 25;
const REFERENCE_EVERY_MS = 3_600_000;

/**
 * Price, change and volume from a REST snapshot. The day bar covers the
 * regular session only, so its close is the regular price (the close once the
 * session is over), matching the quotes; the latest trade can be an
 * after-hours print and is only the fallback.
 */
export function snapshotPrice(snap: alpaca.Snapshot | null | undefined): RowPrice {
  const price = snap?.dailyBar?.c ?? snap?.latestTrade?.p ?? null;
  const prev = snap?.prevDailyBar?.c ?? null;
  return {
    price,
    changePercent: price !== null && prev ? ((price - prev) / prev) * 100 : null,
    volume: snap?.dailyBar?.v ?? null,
  };
}

/** "Apple Inc. - Common Stock" -> "Apple Inc." (Nasdaq Trader security names carry the share class). */
export function companyName(securityName: string): string {
  return securityName.split(" - ")[0].trim();
}

/** Join the pieces into rows, biggest market cap first. */
export function buildRows(
  symbols: string[],
  prices: Map<string, RowPrice>,
  refs: Map<string, RowReference>,
  listings: Map<string, RowListing>
): MarketRow[] {
  const rows: MarketRow[] = [];
  for (const symbol of symbols) {
    const p = prices.get(symbol);
    if (!p || p.price === null) continue;
    const ref = refs.get(symbol);
    const listing = listings.get(symbol);
    const shares = ref?.sharesOutstanding ?? null;
    rows.push({
      symbol,
      name: ref?.bulk && ref.name ? ref.name : listing ? companyName(listing.name) : ref?.name ?? symbol,
      price: p.price,
      changePercent: p.changePercent,
      volume: p.volume,
      marketCap: ref?.marketCap ?? (shares ? shares * p.price : null),
      sector: ref?.sector ?? "Other",
      exchange: listing?.exchange ?? ref?.bulk?.exchange ?? "",
    });
  }
  return rows.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
}

/** S&P 500 ∪ Nasdaq-100; either list alone is enough. */
function indexMembers(): Promise<string[]> {
  return cached("rows:universe", UNIVERSE_TTL, async () => {
    const lists = await Promise.allSettled([sp500(), nasdaq100()]);
    const ok = lists.filter((r) => r.status === "fulfilled").flatMap((r) => (r as PromiseFulfilledResult<string[]>).value);
    if (ok.length === 0) throw new Error("universe: S&P 500 and Nasdaq-100 lists both unavailable");
    return [...new Set(ok)];
  });
}

let bulkTop: { at: number; symbols: string[] } | null = null;

function bulkUniverse(): string[] {
  if (!bulkTop || Date.now() - bulkTop.at > BULK_UNIVERSE_TTL) {
    let symbols: string[] = [];
    try {
      symbols = bulk.topByMarketCap(BULK_UNIVERSE);
    } catch (err) {
      console.warn("[market-rows] bulk profiles unreadable:", err instanceof Error ? err.message : err);
    }
    bulkTop = { at: Date.now(), symbols };
  }
  return bulkTop.symbols;
}

/**
 * The top 1,500 US stocks by market cap from the bulk profiles, plus the
 * S&P 500 ∪ Nasdaq-100 so no index member drops out. Without bulk data
 * (no FMP key, or before the first download) it is the index members alone.
 */
export async function universe(): Promise<string[]> {
  const top = bulkUniverse();
  let members: string[] = [];
  try {
    members = await indexMembers();
  } catch (err) {
    if (top.length === 0) throw err;
  }
  return [...new Set([...top, ...members])];
}

/** Reference data from the bulk profiles; market cap follows the live price through shares outstanding. */
function bulkReferences(symbols: string[]): Map<string, RowReference> {
  const out = new Map<string, RowReference>();
  let found = new Map<string, bulk.BulkProfile>();
  try {
    found = bulk.profiles(symbols);
  } catch (err) {
    console.warn("[market-rows] bulk profiles unreadable:", err instanceof Error ? err.message : err);
  }
  for (const [s, p] of found) {
    out.set(s, { name: p.name, sector: p.sector, marketCap: p.sharesOutstanding ? null : p.marketCap, sharesOutstanding: p.sharesOutstanding, bulk: { exchange: p.exchange } });
  }
  return out;
}

async function prices(symbols: string[]): Promise<Map<string, RowPrice>> {
  const out = new Map<string, RowPrice>();
  const missing: string[] = [];
  for (const s of symbols) {
    const a = alpacaSymbol(s);
    const q = a && live.enabled() ? live.liveQuote(a, s) : null;
    if (q?.price != null) out.set(s, { price: q.price, changePercent: q.changePercent, volume: q.volume });
    else if (a) missing.push(s);
  }
  if (missing.length === 0) return out;
  if (!alpaca.isConfigured()) {
    if (out.size === 0) throw new AlpacaNotConfigured();
    return out;
  }
  for (let i = 0; i < missing.length; i += SNAPSHOT_BATCH) {
    const batch = missing.slice(i, i + SNAPSHOT_BATCH);
    const byAlpaca = new Map(batch.map((s) => [alpacaSymbol(s)!, s]));
    try {
      const snaps = await cached(`rows:snapshots:${batch.join(",")}`, SNAPSHOT_TTL, () => alpaca.snapshots([...byAlpaca.keys()]));
      for (const [a, snap] of Object.entries(snaps)) {
        const s = byAlpaca.get(a);
        if (s) out.set(s, snapshotPrice(snap));
      }
    } catch (err) {
      if (out.size === 0) throw err;
    }
  }
  return out;
}

const refs = new Map<string, RowReference>();
let refsLoading: Promise<void> | null = null;
let refsLoadedAt = 0;

async function referenceChunk(symbols: string[]): Promise<Map<string, RowReference>> {
  const out = new Map<string, RowReference>();
  if (fmp.isConfigured()) {
    for (const [s, p] of await fmp.profiles(symbols)) {
      out.set(s, { name: p.name, sector: p.sector, marketCap: p.marketCap, sharesOutstanding: null });
    }
    return out;
  }
  for (const [s, r] of await secReference.reference(symbols)) {
    out.set(s, { name: r.name, sector: r.sector, marketCap: null, sharesOutstanding: r.sharesOutstanding });
  }
  return out;
}

/**
 * Start (at most hourly) a background pass over `symbols`, merging each chunk
 * as it lands. A chunk that fails is skipped, not the rest of the pass: one
 * transient SEC/FMP error shouldn't leave the heatmap half-filled for an hour.
 */
export function loadReferences(symbols: string[], chunkSize = REFERENCE_CHUNK): void {
  if (symbols.length === 0 || refsLoading || (refsLoadedAt && Date.now() - refsLoadedAt < REFERENCE_EVERY_MS)) return;
  refsLoading = (async () => {
    let failed = 0;
    let lastError = "";
    for (let i = 0; i < symbols.length; i += chunkSize) {
      try {
        for (const [s, r] of await referenceChunk(symbols.slice(i, i + chunkSize))) refs.set(s, r);
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (failed > 0) console.warn(`[market-rows] reference data unavailable for ${failed} chunk(s): ${lastError}`);
  })().finally(() => {
    refsLoading = null;
    refsLoadedAt = Date.now();
  });
}

/** Wait for the background reference pass (tests). */
export function referencesSettled(): Promise<void> {
  return refsLoading ?? Promise.resolve();
}

/** Test hook. */
export function resetRows(): void {
  refs.clear();
  bulkTop = null;
  refsLoading = null;
  refsLoadedAt = 0;
}

async function listings(): Promise<Map<string, RowListing>> {
  const assets = await allAssets().catch(() => []);
  return new Map(assets.map((a) => [a.symbol, { name: a.name, exchange: a.exchange }]));
}

/** US large-cap rows, biggest first. */
export async function usMarketRows(): Promise<MarketRow[]> {
  const symbols = await universe();
  const fromBulk = bulkReferences(symbols);
  loadReferences(symbols.filter((s) => !fromBulk.has(s)));
  const [p, l] = await Promise.all([prices(symbols), listings()]);
  return buildRows(symbols, p, new Map([...refs, ...fromBulk]), l);
}
