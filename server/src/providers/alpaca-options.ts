import { dataFetch, snapshots as stockSnapshots } from "./alpaca.js";

// Option chains from Alpaca's OPRA snapshots (/v1beta1/options/snapshots/{underlying}).
// Open interest is not on the market-data host, so it is always null.

export type OptionRow = {
  contract: string; // OCC symbol
  strike: number | null;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  change: number | null;
  percentChange: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  inTheMoney: boolean;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
};

export type OptionChain = {
  symbol: string;
  underlyingPrice: number | null;
  expirationDates: string[]; // YYYY-MM-DD, ascending
  selectedDate: string | null;
  calls: OptionRow[];
  puts: OptionRow[];
};

export type OccSymbol = { root: string; expiry: string; type: "call" | "put"; strike: number };

/** NVDA261102C00215000 -> { root: "NVDA", expiry: "2026-11-02", type: "call", strike: 215 }. */
export function parseOcc(symbol: string): OccSymbol | null {
  const m = symbol.match(/^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    root: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === "C" ? "call" : "put",
    strike: Number(m[6]) / 1000,
  };
}

// Greeks/IV only appear while OPRA has a fresh quote, so every field may be missing.
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toRow(contract: string, occ: OccSymbol, snap: any, underlyingPrice: number | null): OptionRow {
  const last = num(snap?.latestTrade?.p);
  const prev = num(snap?.prevDailyBar?.c);
  const change = last !== null && prev !== null ? last - prev : null;
  return {
    contract,
    strike: occ.strike,
    lastPrice: last,
    bid: num(snap?.latestQuote?.bp),
    ask: num(snap?.latestQuote?.ap),
    change,
    percentChange: change !== null && prev ? (change / prev) * 100 : null,
    volume: num(snap?.dailyBar?.v),
    openInterest: null,
    impliedVolatility: num(snap?.impliedVolatility),
    inTheMoney: underlyingPrice === null ? false : occ.type === "call" ? occ.strike < underlyingPrice : occ.strike > underlyingPrice,
    delta: num(snap?.greeks?.delta),
    gamma: num(snap?.greeks?.gamma),
    theta: num(snap?.greeks?.theta),
    vega: num(snap?.greeks?.vega),
    rho: num(snap?.greeks?.rho),
  };
}

export type ChainFilter = {
  expiry?: string; // YYYY-MM-DD
  expiryMin?: string; // inclusive range, YYYY-MM-DD
  expiryMax?: string;
  type?: "call" | "put";
  strikeMin?: number;
  strikeMax?: number;
};

const PAGE_LIMIT = 1000;
const MAX_PAGES = 10;

/** OPRA by default; ALPACA_OPTIONS_FEED=indicative for plans without OPRA. */
export function optionsFeed(): string {
  return process.env.ALPACA_OPTIONS_FEED?.trim() || "opra";
}

/** Walk the snapshot pages for an underlying; stops at maxPages so a huge chain can't run away. */
async function snapshotPages(underlying: string, filter: ChainFilter, maxPages = MAX_PAGES, stats?: { requests: number }): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (stats) stats.requests++;
    const data = await dataFetch(`/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`, {
      feed: optionsFeed(),
      limit: String(PAGE_LIMIT),
      type: filter.type,
      expiration_date: filter.expiry,
      expiration_date_gte: filter.expiryMin,
      expiration_date_lte: filter.expiryMax,
      strike_price_gte: filter.strikeMin === undefined ? undefined : String(filter.strikeMin),
      strike_price_lte: filter.strikeMax === undefined ? undefined : String(filter.strikeMax),
      page_token: pageToken,
    });
    Object.assign(out, data?.snapshots ?? {});
    pageToken = data?.next_page_token ?? undefined;
    if (!pageToken) break;
  }
  return out;
}

/**
 * Raw snapshots (latest quote/trade, day bar, greeks) for an underlying's
 * contracts across an expiry range and strike band, keyed by OCC symbol.
 * Used by the options sweep, which walks more pages than a chain view does;
 * `stats.requests` counts the page requests made.
 */
export async function optionSnapshots(underlying: string, filter: ChainFilter, maxPages = 30, stats?: { requests: number }): Promise<Record<string, any>> {
  return snapshotPages(underlying.toUpperCase(), filter, maxPages, stats);
}

async function underlyingPrice(symbol: string): Promise<number | null> {
  const snap = (await stockSnapshots([symbol]))[symbol];
  return num(snap?.latestTrade?.p) ?? num(snap?.dailyBar?.c);
}

/**
 * Expiration dates (ascending) that have contracts within `window` (default 20%)
 * of the underlying price. A window keeps the scan to a few pages: a full
 * chain on a large name runs to many thousands of contracts.
 */
export async function expirations(underlying: string, price?: number | null, window = 0.2): Promise<string[]> {
  const symbol = underlying.toUpperCase();
  const p = price === undefined ? await underlyingPrice(symbol) : price;
  const snaps = await snapshotPages(symbol, p ? { strikeMin: p * (1 - window), strikeMax: p * (1 + window) } : {});
  const dates = new Set<string>();
  for (const contract of Object.keys(snaps)) {
    const occ = parseOcc(contract);
    if (occ) dates.add(occ.expiry);
  }
  return [...dates].sort();
}

/**
 * Chain for one underlying and expiry, in the shape /api/options/:symbol serves
 * (calls and puts sorted by strike) plus contract, greeks and IV on each row.
 * Without `expiry` (or when it has no contracts) the nearest expiry is used.
 */
export async function chain(underlying: string, filter: Omit<ChainFilter, "type"> = {}): Promise<OptionChain> {
  const symbol = underlying.toUpperCase();
  const price = await underlyingPrice(symbol);
  const expirationDates = await expirations(symbol, price);
  const selectedDate = filter.expiry && expirationDates.includes(filter.expiry) ? filter.expiry : expirationDates[0] ?? null;
  const calls: OptionRow[] = [];
  const puts: OptionRow[] = [];
  if (selectedDate) {
    const snaps = await snapshotPages(symbol, { ...filter, expiry: selectedDate });
    for (const [contract, snap] of Object.entries(snaps)) {
      const occ = parseOcc(contract);
      if (!occ || occ.expiry !== selectedDate) continue;
      (occ.type === "call" ? calls : puts).push(toRow(contract, occ, snap, price));
    }
    calls.sort((a, b) => a.strike! - b.strike!);
    puts.sort((a, b) => a.strike! - b.strike!);
  }
  return { symbol, underlyingPrice: price, expirationDates, selectedDate, calls, puts };
}
