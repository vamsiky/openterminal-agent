import { dataFetch, type Bar, type Snapshot } from "./alpaca.js";
import type { Candle, Quote } from "./types.js";

// Alpaca's US crypto data (/v1beta3/crypto/us). Pairs look like "BTC/USD";
// the app writes BTC, BTC-USD or BTC/USD, so every entry point normalizes.

const NAMES: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP", ADA: "Cardano",
  DOGE: "Dogecoin", AVAX: "Avalanche", DOT: "Polkadot", LINK: "Chainlink", LTC: "Litecoin",
  BCH: "Bitcoin Cash", UNI: "Uniswap", AAVE: "Aave", SHIB: "Shiba Inu", GRT: "The Graph",
  BAT: "Basic Attention Token", CRV: "Curve DAO", MKR: "Maker", SUSHI: "SushiSwap", YFI: "yearn.finance",
  XTZ: "Tezos", TRUMP: "Official Trump", PEPE: "Pepe", HYPE: "Hyperliquid", SKY: "Sky",
};

/** Plain tickers (BTC, ETH, ...) with a USD pair on Alpaca. Stablecoins are left out on purpose. */
export const CRYPTO_SYMBOLS = new Set(Object.keys(NAMES));

/** "Bitcoin" for BTC; the ticker itself when the name isn't known. */
export function cryptoName(ticker: string): string {
  return NAMES[ticker.toUpperCase()] ?? ticker.toUpperCase();
}

/** BTC, btc-usd or BTC/USD -> "BTC/USD"; null when Alpaca has no such USD pair. */
export function toPair(symbol: string): string | null {
  const m = symbol.trim().toUpperCase().match(/^([A-Z0-9]+)(?:[-/]USD)?$/);
  return m && CRYPTO_SYMBOLS.has(m[1]) ? `${m[1]}/USD` : null;
}

export function isCryptoSymbol(symbol: string): boolean {
  return toPair(symbol) !== null;
}

function pairOrThrow(symbol: string): string {
  const pair = toPair(symbol);
  if (!pair) throw new Error(`alpaca crypto: unsupported symbol ${symbol}`);
  return pair;
}

const base = (pair: string) => pair.split("/")[0];

export type CryptoQuote = { t: string; bp: number; ap: number; bs: number; as: number };
export type CryptoTrade = { t: string; p: number; s: number };

/** Keyed by the symbols the caller passed, in the caller's spelling. Unsupported symbols are skipped. */
async function latest<T>(kind: "quotes" | "trades", symbols: string[]): Promise<Record<string, T>> {
  const pairs = new Map<string, string>();
  for (const s of symbols) {
    const pair = toPair(s);
    if (pair) pairs.set(pair, s);
  }
  if (pairs.size === 0) return {};
  const data = await dataFetch(`/v1beta3/crypto/us/latest/${kind}`, { symbols: [...pairs.keys()].join(",") });
  const out: Record<string, T> = {};
  for (const [pair, row] of Object.entries<T>(data?.[kind] ?? {})) {
    const s = pairs.get(pair);
    if (s) out[s] = row;
  }
  return out;
}

export const latestQuotes = (symbols: string[]) => latest<CryptoQuote>("quotes", symbols);
export const latestTrades = (symbols: string[]) => latest<CryptoTrade>("trades", symbols);

/** Latest trade/quote, minute, today's (UTC) and yesterday's bars; same fields as a stock Snapshot. */
export async function cryptoSnapshots(symbols: string[]): Promise<Record<string, Snapshot | null>> {
  const pairs = new Map<string, string>();
  for (const s of symbols) {
    const pair = toPair(s);
    if (pair) pairs.set(pair, s);
  }
  if (pairs.size === 0) return {};
  const data = await dataFetch("/v1beta3/crypto/us/snapshots", { symbols: [...pairs.keys()].join(",") });
  const out: Record<string, Snapshot | null> = {};
  for (const [pair, snap] of Object.entries<Snapshot | null>(data?.snapshots ?? {})) {
    const s = pairs.get(pair);
    if (s) out[s] = snap;
  }
  return out;
}

export type CryptoTimeframe = "1Min" | "5Min" | "15Min" | "1Hour" | "4Hour" | "1Day" | "1Week" | "1Month";

/** Historical bars for one pair, oldest first, following every page. */
export async function cryptoBars(symbol: string, opts: { timeframe: CryptoTimeframe; start: string; end?: string }): Promise<Bar[]> {
  const pair = pairOrThrow(symbol);
  const bars: Bar[] = [];
  let pageToken: string | undefined;
  do {
    const data = await dataFetch("/v1beta3/crypto/us/bars", {
      symbols: pair,
      timeframe: opts.timeframe,
      start: opts.start,
      end: opts.end,
      limit: "10000",
      sort: "asc",
      page_token: pageToken,
    });
    bars.push(...((data?.bars?.[pair] ?? []) as Bar[]));
    pageToken = data?.next_page_token ?? undefined;
  } while (pageToken);
  return bars;
}

export type OrderBookLevel = { p: number; s: number };
export type CryptoOrderBook = { bids: OrderBookLevel[]; asks: OrderBookLevel[]; time: string | null };

/** Latest orderbook, bids best (highest) first, asks best (lowest) first. */
export async function orderbook(symbol: string): Promise<CryptoOrderBook> {
  const pair = pairOrThrow(symbol);
  const data = await dataFetch("/v1beta3/crypto/us/latest/orderbooks", { symbols: pair });
  const book = data?.orderbooks?.[pair];
  if (!book) throw new Error(`alpaca crypto: no orderbook for ${symbol}`);
  return {
    bids: [...(book.b ?? [])].sort((a: OrderBookLevel, b: OrderBookLevel) => b.p - a.p),
    asks: [...(book.a ?? [])].sort((a: OrderBookLevel, b: OrderBookLevel) => a.p - b.p),
    time: book.t ?? null,
  };
}

// ---- adapters to the route shapes (Quote, Candle, orderbook string pairs) ----

/** One symbol, 24h-style fields from today's UTC daily bar. */
export async function quote(symbol: string): Promise<Quote> {
  const pair = pairOrThrow(symbol);
  const snap = (await cryptoSnapshots([symbol]))[symbol];
  const price = snap?.latestTrade?.p ?? snap?.minuteBar?.c ?? snap?.dailyBar?.c ?? null;
  if (price === null) throw new Error(`alpaca crypto: no price for ${symbol}`);
  const prev = snap?.prevDailyBar?.c ?? null;
  const tradeTime = snap?.latestTrade ? Date.parse(snap.latestTrade.t) : NaN;
  return {
    symbol: symbol.toUpperCase(),
    name: NAMES[base(pair)] ?? base(pair),
    price,
    change: prev === null ? null : price - prev,
    changePercent: prev ? ((price - prev) / prev) * 100 : null,
    open: snap?.dailyBar?.o ?? null,
    high: snap?.dailyBar?.h ?? null,
    low: snap?.dailyBar?.l ?? null,
    previousClose: prev,
    bid: snap?.latestQuote?.bp || null,
    ask: snap?.latestQuote?.ap || null,
    volume: snap?.dailyBar?.v ?? null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: "Alpaca",
    marketState: "Open",
    time: Number.isNaN(tradeTime) ? null : Math.round(tradeTime / 1000),
    source: "alpaca",
  };
}

const DAY = 86_400_000;
const RANGES: Record<string, { timeframe: CryptoTimeframe; start: (now: Date) => Date }> = {
  "1D": { timeframe: "5Min", start: (n) => new Date(n.getTime() - DAY) },
  "5D": { timeframe: "15Min", start: (n) => new Date(n.getTime() - 5 * DAY) },
  "1M": { timeframe: "1Hour", start: (n) => new Date(n.getTime() - 30 * DAY) },
  "6M": { timeframe: "4Hour", start: (n) => new Date(n.getTime() - 182 * DAY) },
  YTD: { timeframe: "1Day", start: (n) => new Date(Date.UTC(n.getUTCFullYear(), 0, 1)) },
  "1Y": { timeframe: "1Day", start: (n) => new Date(n.getTime() - 365 * DAY) },
  "5Y": { timeframe: "1Week", start: (n) => new Date(n.getTime() - 5 * 365 * DAY) },
  MAX: { timeframe: "1Month", start: () => new Date(Date.UTC(2021, 0, 1)) }, // Alpaca's crypto data begins in 2021
};

/** The app's range keys (1D, 5D, 1M, 6M, YTD, 1Y, 5Y, MAX) -> candles, oldest first. */
export async function history(symbol: string, rangeKey: string, now = new Date()): Promise<Candle[]> {
  const { timeframe, start } = RANGES[rangeKey] ?? RANGES["6M"];
  const bars = await cryptoBars(symbol, { timeframe, start: start(now).toISOString() });
  return bars.map((b) => ({ time: Math.round(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

/** [price, size] string pairs, best first, cut to `limit` levels. */
export async function orderBook(symbol: string, limit = 20): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
  const book = await orderbook(symbol);
  const pairs = (levels: OrderBookLevel[]) => levels.slice(0, limit).map((l): [string, string] => [String(l.p), String(l.s)]);
  return { bids: pairs(book.bids), asks: pairs(book.asks) };
}
