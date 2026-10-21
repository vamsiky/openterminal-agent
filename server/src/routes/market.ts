import { Router } from "express";
import { cached, cacheGet, cacheStore, staleGet } from "../cache.js";
import { withFallback } from "../providers/registry.js";
import type { Candle, MarketRow, Quote } from "../providers/types.js";
import * as stooq from "../providers/stooq.js";
import * as fred from "../providers/fred.js";
import * as ecb from "../providers/ecb.js";
import * as coingecko from "../providers/coingecko.js";
import * as finra from "../providers/finra.js";
import * as secedgar from "../providers/secedgar.js";
import * as secReference from "../providers/sec-reference.js";
import * as alpaca from "../providers/alpaca.js";
import * as alpacaCrypto from "../providers/alpaca-crypto.js";
import * as alpacaNews from "../providers/alpaca-news.js";
import * as alpacaOptions from "../providers/alpaca-options.js";
import * as alpacaAssets from "../providers/alpaca-assets.js";
import * as calendars from "../providers/calendars.js";
import * as fmp from "../providers/fmp.js";
import * as live from "../live/feed.js";
import { alpacaHistory } from "../live/history.js";
import { alpacaSymbol, isForeignSymbol } from "../history/universe.js";
import { AlpacaNotConfigured, companyName, snapshotPrice, usMarketRows } from "./market-rows.js";
import { withConsensus } from "./econ-calendar.js";
import * as estimates from "../estimates/store.js";
import * as bulkStore from "../research/bulk-store.js";
import { timingsFor } from "../estimates/timing.js";
import { tradingDay } from "../history/time.js";

// Yahoo Finance, TradingView, Nasdaq's public API, Google News, Forex Factory
// and Binance were removed: their terms forbid automated use (Binance also
// geo-blocks the US). Alpaca, FMP (optional key), SEC EDGAR, FRED, ECB, FINRA,
// CoinGecko and the official release calendars replace them; Stooq stays as
// the last price fallback.

export const marketRouter = Router();

const QUOTE_TTL = 1_000;
const HISTORY_TTL = 20_000;
const NEWS_TTL = 60_000;

function fail(req: any, res: any, err: unknown) {
  // A feature whose only source needs a key that isn't set: say which, so the UI can.
  if (err instanceof fmp.FmpNotConfigured) return needs(res, "FMP_API_KEY", req.path);
  if (err instanceof AlpacaNotConfigured) return needs(res, "Alpaca API keys", req.path);
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[market]", req.path, detail);
  res.status(502).json({ error: "All data providers are temporarily unavailable. Try again shortly." });
}

function needs(res: any, what: "FMP_API_KEY" | "Alpaca API keys", feature: string) {
  res.status(503).json({ error: `needs ${what}`, feature });
}

/** A quote with every field empty; sources fill in what they have. */
function blankQuote(symbol: string, source: string): Quote {
  return {
    symbol,
    name: null,
    price: null,
    change: null,
    changePercent: null,
    open: null,
    high: null,
    low: null,
    previousClose: null,
    bid: null,
    ask: null,
    volume: null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: null,
    exchange: null,
    marketState: null,
    time: null,
    source,
  };
}

/** Price and change from the last two points of a daily series. */
function seriesQuote(base: Quote, points: Array<{ value: number }>): Quote {
  if (points.length === 0) throw new Error(`${base.source}: no data for ${base.symbol}`);
  const price = points[points.length - 1].value;
  const previousClose = points.length > 1 ? points[points.length - 2].value : null;
  const change = previousClose !== null ? price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  return { ...base, price, change, changePercent, previousClose };
}

/** Daily series points as flat candles. */
function seriesCandles(points: Array<{ date: string; value: number }>): Candle[] {
  return points.map((p) => {
    const time = Math.floor(new Date(p.date + "T00:00:00Z").getTime() / 1000);
    return { time, open: p.value, high: p.value, low: p.value, close: p.value, volume: 0 };
  });
}

// Daily points per range key, for the FRED and ECB series.
const SERIES_RANGE_N: Record<string, number> = {
  "1D": 5,
  "5D": 5,
  "1M": 22,
  "6M": 130,
  YTD: 200,
  "1Y": 252,
  "5Y": 1260,
  MAX: 20_000,
};

// ---- VIX: served from FRED (daily close), since it's an index rather than a
// tradable stock/ETF, so Alpaca doesn't carry it.

function isVix(symbol: string): boolean {
  return symbol.toUpperCase() === "^VIX" || symbol.toUpperCase() === "VIX";
}

async function vixQuote(): Promise<Quote> {
  const base = { ...blankQuote("^VIX", "fred"), name: "CBOE Volatility Index", currency: "USD", exchange: "CBOE" };
  return seriesQuote(base, await fred.series("VIXCLS", 5));
}

async function vixHistory(rangeKey: string): Promise<Candle[]> {
  return seriesCandles(await fred.series("VIXCLS", SERIES_RANGE_N[rangeKey] ?? 130));
}

// ---- FX (EURUSD=X, USDJPY=X, ...): crosses of the ECB's daily reference
// rates, which are quoted as units of each currency per 1 EUR.

const FX_PAIR = /^([A-Z]{3})([A-Z]{3})=X$/;

async function fxSeries(symbol: string, n: number): Promise<Array<{ date: string; value: number }>> {
  const [, base, quote] = FX_PAIR.exec(symbol)!;
  const perEur = (ccy: string) =>
    ccy === "EUR" ? Promise.resolve(null) : cached(`ecb:fx:${ccy}:${n}`, 3_600_000, () => ecb.series("EXR", `D.${ccy}.EUR.SP00.A`, n));
  const [b, q] = await Promise.all([perEur(base), perEur(quote)]);
  if (!b && !q) throw new Error(`ecb: ${symbol} is not a cross`);
  const byDate = (points: ecb.SeriesPoint[] | null) => new Map(points?.map((p) => [p.date, p.value]));
  const [bm, qm] = [byDate(b), byDate(q)];
  return (q ?? b)!.flatMap((p) => {
    const bv = b ? bm.get(p.date) : 1;
    const qv = q ? qm.get(p.date) : 1;
    return bv && qv ? [{ date: p.date, value: qv / bv }] : [];
  });
}

async function fxQuote(symbol: string): Promise<Quote> {
  const [, base, quote] = FX_PAIR.exec(symbol)!;
  return seriesQuote({ ...blankQuote(symbol, "ecb"), name: `${base}/${quote}`, currency: quote, exchange: "ECB" }, await fxSeries(symbol, 5));
}

// ---- symbol routing ----

/**
 * Crypto goes to Alpaca's crypto feed: BTC and ETH bare (as before), anything
 * else only as -USD or /USD, since bare UNI, LINK, DOT, SKY, BAT, CRV, GRT...
 * are also stock tickers.
 */
function isCrypto(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s === "BTC" || s === "ETH" || (/[-/]USD$/.test(s) && alpacaCrypto.isCryptoSymbol(s));
}

/** The Alpaca symbol for a US stock or ETF ticker, or null for crypto, VIX, indices, FX and futures. */
function usStock(symbol: string): string | null {
  if (isCrypto(symbol) || isVix(symbol)) return null;
  return alpacaSymbol(symbol);
}

// ---- quotes (per-symbol cache, so overlapping widgets share one fetch) ----

/**
 * Fan-out bound for webQuotes: the /quotes route caps `symbols` at 150, so a
 * single call does at most one Alpaca crypto snapshot per crypto symbol, one
 * FRED call for VIX, two ECB calls per FX pair, one batched Alpaca stock
 * snapshot call, one batched FMP call (when keyed) and up to
 * FALLBACK_PER_SYMBOL_CAP Stooq calls. Repetition beyond that is bounded by
 * marketRouter's per-IP rate limit (see index.ts).
 */
const FALLBACK_PER_SYMBOL_CAP = 20;

// Name, exchange and fundamentals for US stock quotes. These barely change
// during a day, so they are fetched in the background, at most hourly per
// ticker, and never hold up a price: from FMP's daily bulk tables
// (research/bulk-store.ts), else per symbol from FMP when FMP_API_KEY is set,
// else the name and exchange from the listing directory and shares outstanding
// from SEC EDGAR (market cap = shares × the live price).
//
// A ticker the sources don't answer (unknown to them, or every source failing
// or rate-limited) is asked again after 5 minutes, doubling with each failure
// in a row up to 30 minutes, rather than on every poll. Its last good fields
// stay on the quote meanwhile.
type StaticFields = Pick<
  Quote,
  "name" | "exchange" | "avgVolume" | "marketCap" | "pe" | "eps" | "dividendYield" | "week52High" | "week52Low" | "beta" | "sharesOutstanding"
>;
const STATIC_TTL = 3_600_000;
const STATIC_RETRY_MS = 5 * 60_000;
const STATIC_RETRY_MAX_MS = 30 * 60_000;
const staticFields = new Map<string, { fields: StaticFields | null; next: number; failures: number }>();
const staticInFlight = new Set<string>();

/** Static fields for the given tickers, in one batch per source; tickers no source knows are left out. */
async function fetchStaticFields(tickers: string[]): Promise<Map<string, StaticFields>> {
  const out = new Map<string, StaticFields>();
  let bulk = new Map<string, bulkStore.BulkProfile>();
  try {
    bulk = bulkStore.profiles(tickers);
  } catch (err) {
    console.warn("[quotes] bulk profiles unreadable:", err instanceof Error ? err.message : err);
  }
  for (const [s, b] of bulk) {
    out.set(s, {
      name: b.name,
      exchange: b.exchange,
      avgVolume: b.avgVolume,
      marketCap: b.marketCap,
      pe: b.pe,
      eps: b.eps,
      dividendYield: b.dividendYield,
      week52High: b.week52High,
      week52Low: b.week52Low,
      beta: b.beta,
      sharesOutstanding: b.sharesOutstanding,
    });
  }
  // Per-symbol sources only for the tickers the bulk tables don't have.
  const symbols = tickers.filter((s) => !bulk.has(s));
  if (symbols.length === 0) return out;
  if (fmp.isConfigured()) {
    // Profiles and TTM ratios change daily at most and are cached a day, so
    // the hourly refresh costs no FMP calls between them.
    const [profiles, ratios] = await Promise.all([
      fmp.profiles(symbols).catch(() => new Map<string, fmp.Profile>()),
      fmp.ratiosTtm(symbols).catch(() => new Map<string, fmp.RatiosTtm>()),
    ]);
    for (const s of symbols) {
      const p = profiles.get(s);
      const r = ratios.get(s);
      if (!p && !r) continue;
      out.set(s, {
        name: p?.name ?? null,
        exchange: p?.exchange ?? null,
        avgVolume: p?.avgVolume ?? null,
        marketCap: p?.marketCap ?? null,
        pe: r?.pe ?? null,
        eps: r?.eps ?? null,
        dividendYield: r?.dividendYield ?? null,
        week52High: p?.week52High ?? null,
        week52Low: p?.week52Low ?? null,
        beta: p?.beta ?? null,
        sharesOutstanding: p?.marketCap && p.price ? Math.round(p.marketCap / p.price) : null,
      });
    }
    return out;
  }
  const [assets, refs] = await Promise.all([
    alpacaAssets.allAssets().catch(() => [] as alpacaAssets.SearchResult[]),
    secReference.reference(symbols).catch(() => new Map<string, secReference.Reference>()),
  ]);
  const listed = new Map(assets.map((a) => [a.symbol, a]));
  for (const s of symbols) {
    const listing = listed.get(usStock(s) ?? s);
    const ref = refs.get(s);
    if (!listing && !ref) continue;
    out.set(s, {
      name: listing ? companyName(listing.name) : ref!.name,
      exchange: listing?.exchange || null,
      avgVolume: null,
      marketCap: null,
      pe: null,
      eps: null,
      dividendYield: null,
      week52High: null,
      week52Low: null,
      beta: null,
      sharesOutstanding: ref?.sharesOutstanding ?? null,
    });
  }
  return out;
}

/** Refresh the static fields of the tickers that are due, in one background batch. */
function refreshStatic(symbols: string[]): void {
  const now = Date.now();
  const due = symbols.filter((s) => !staticInFlight.has(s) && (staticFields.get(s)?.next ?? 0) <= now);
  if (due.length === 0) return;
  for (const s of due) staticInFlight.add(s);
  fetchStaticFields(due)
    .catch(() => new Map<string, StaticFields>())
    .then((got) => {
      const at = Date.now();
      for (const s of due) {
        const fields = got.get(s);
        if (fields) {
          staticFields.set(s, { fields, next: at + STATIC_TTL, failures: 0 });
        } else {
          const known = staticFields.get(s);
          const failures = (known?.failures ?? 0) + 1;
          const wait = Math.min(STATIC_RETRY_MS * 2 ** (failures - 1), STATIC_RETRY_MAX_MS);
          staticFields.set(s, { fields: known?.fields ?? null, next: at + wait, failures });
        }
      }
    })
    .finally(() => {
      for (const s of due) staticInFlight.delete(s);
    });
}

/** The quote with its known static fields; market cap follows the price when shares outstanding are known. */
function withStatic(q: Quote, f: StaticFields | null | undefined): Quote {
  if (!f) return q;
  const out: Quote = { ...q };
  for (const [k, v] of Object.entries(f)) if (v !== null) (out as any)[k] = v;
  if (f.sharesOutstanding && q.price !== null) out.marketCap = f.sharesOutstanding * q.price;
  return out;
}

/**
 * Quotes: US stocks and ETFs from the live Alpaca feed in memory (real time
 * for anything on screen), everything else, or anything the feed doesn't know
 * yet, from webQuotes below.
 */
export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  const out = new Map<string, Quote>();
  let rest = symbols;
  if (live.enabled()) {
    const mapped = new Map(symbols.map((s) => [s, usStock(s)]));
    await live.focusOn([...new Set([...mapped.values()].filter((a): a is string => a !== null))]);
    rest = [];
    for (const s of symbols) {
      const a = mapped.get(s);
      const q = a ? live.liveQuote(a, s) : null;
      if (q) out.set(s, q);
      else rest.push(s);
    }
  }
  if (rest.length > 0) for (const [s, q] of await webQuoteMap(rest)) out.set(s, q);
  // FMP quotes carry their own fields.
  const stocks = [...out.keys()].filter((s) => usStock(s) && out.get(s)!.source !== "fmp");
  refreshStatic(stocks);
  for (const s of stocks) out.set(s, withStatic(out.get(s)!, staticFields.get(s)?.fields));
  return symbols.map((s) => out.get(s)).filter((q): q is Quote => Boolean(q));
}

function snapshotQuote(symbol: string, snap: alpaca.Snapshot): Quote | null {
  const { price, changePercent, volume } = snapshotPrice(snap);
  if (price === null) return null;
  const previousClose = snap.prevDailyBar?.c ?? null;
  const tradeAt = snap.latestTrade ? Date.parse(snap.latestTrade.t) : NaN;
  return {
    ...blankQuote(symbol, "alpaca"),
    price,
    change: previousClose !== null ? price - previousClose : null,
    changePercent,
    open: snap.dailyBar?.o ?? null,
    high: snap.dailyBar?.h ?? null,
    low: snap.dailyBar?.l ?? null,
    previousClose,
    bid: snap.latestQuote?.bp || null,
    ask: snap.latestQuote?.ap || null,
    volume,
    currency: "USD",
    time: Number.isNaN(tradeAt) ? null : Math.floor(tradeAt / 1000),
  };
}

/** Keyed by the requested symbol; symbols nothing answered (and with no last-known quote) are left out. */
// Symbols no source could answer, and when to ask again. Without this, a
// ticker nothing covers (an OTC name FMP doesn't carry, say) costs the whole
// fallback chain, Stooq's timeout included, on every poll of the widget showing
// it, and holds up the other symbols in the same request.
const UNANSWERED_RETRY_MS = 10 * 60_000;
const unanswered = new Map<string, number>(); // symbol → when to try again (ms)

async function webQuoteMap(symbols: string[]): Promise<Map<string, Quote>> {
  const fresh = new Map<string, Quote>();
  const missing: string[] = [];
  const now = Date.now();
  for (const sym of symbols) {
    const hit = cacheGet<Quote>(`quote:${sym}`);
    if (hit) fresh.set(sym, hit);
    else if ((unanswered.get(sym) ?? 0) <= now) missing.push(sym);
  }
  if (missing.length === 0) return fresh;

  const fetched = new Map<string, Quote>();
  let remaining = missing;
  const each = async (batch: string[], get: (symbol: string) => Promise<Quote>) => {
    const results = await Promise.allSettled(batch.map(get));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(batch[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  };

  await each(remaining.filter(isCrypto), (s) => alpacaCrypto.quote(s));
  await each(remaining.filter(isVix), () => vixQuote());
  await each(remaining.filter((s) => FX_PAIR.test(s)), fxQuote);

  // US stocks and ETFs in one snapshot request. With the live feed on,
  // getQuotes has already asked for a first-click snapshot (bounded by
  // live.SNAPSHOT_WAIT_MS), so don't ask Alpaca a second time.
  const stocks = new Map(remaining.flatMap((s) => (usStock(s) ? [[usStock(s)!, s] as const] : [])));
  if (stocks.size > 0 && !live.enabled() && alpaca.isConfigured()) {
    try {
      for (const [a, snap] of Object.entries(await alpaca.snapshots([...stocks.keys()]))) {
        const s = stocks.get(a);
        const q = s && snap ? snapshotQuote(s, snap) : null;
        if (q) fetched.set(s!, q);
      }
    } catch {
      // FMP and Stooq below
    }
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  // OTC names, indices and whatever Alpaca didn't answer: FMP in one batch when keyed.
  if (remaining.length > 0 && fmp.isConfigured()) {
    try {
      const got = await fmp.quotes(remaining);
      for (const s of remaining) {
        const f = got.get(s);
        if (f && f.price !== null) fetched.set(s, { ...blankQuote(s, "fmp"), ...f, symbol: s, currency: "USD" }); // Starter: US listings only
      }
    } catch {
      // Stooq below
    }
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  await each(remaining.slice(0, FALLBACK_PER_SYMBOL_CAP), (s) => stooq.quote(s));

  // asOf records when this server fetched the quote. Cached and stale
  // fallbacks keep their original asOf, so research notes can say how fresh
  // the data behind them was.
  const asOf = new Date().toISOString();
  for (const [sym, q] of fetched) {
    q.asOf = asOf;
    cacheStore(`quote:${sym}`, q, QUOTE_TTL);
    unanswered.delete(sym);
  }
  for (const sym of missing) if (!fetched.has(sym)) unanswered.set(sym, Date.now() + UNANSWERED_RETRY_MS);

  const out = new Map<string, Quote>();
  for (const sym of symbols) {
    const q = fresh.get(sym) ?? fetched.get(sym) ?? staleGet<Quote>(`quote:${sym}`);
    if (q) out.set(sym, q);
  }
  return out;
}

marketRouter.get("/quotes", async (req, res) => {
  const requested = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 150);
  if (requested.length === 0) return res.status(400).json({ error: "symbols required" });
  // US-listed symbols only: foreign ones never reach a provider.
  const symbols = requested.filter((s) => !isForeignSymbol(s));
  if (symbols.length === 0) return res.json([]);
  try {
    const data = await getQuotes(symbols);
    if (data.length === 0) throw new Error("no quotes from any provider");
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- history / candles ----

// Alpaca candles end with the live price, so they're cached only briefly.
const ALPACA_HISTORY_TTL = 2_000;

const DAY_MS = 86_400_000;
const FMP_RANGE_DAYS: Record<string, number> = { "1D": 5, "5D": 7, "1M": 31, "6M": 183, "1Y": 366, "5Y": 5 * 366, MAX: 50 * 366 };

/** Daily EOD candles from FMP for a range key (FMP has no intraday on every plan). */
function fmpHistory(symbol: string, rangeKey: string, now = new Date()): Promise<Candle[]> {
  const to = now.toISOString().slice(0, 10);
  const from =
    rangeKey === "YTD"
      ? `${to.slice(0, 4)}-01-01`
      : new Date(now.getTime() - (FMP_RANGE_DAYS[rangeKey] ?? FMP_RANGE_DAYS["6M"]) * DAY_MS).toISOString().slice(0, 10);
  return fmp.historical(symbol, from, to);
}

/** FMP when keyed, then Stooq: for everything that isn't a US stock on Alpaca, crypto, VIX or FX (OTC names, mostly). */
function otherHistory(symbol: string, rangeKey: string): Promise<Candle[]> {
  return withFallback<Candle[]>([
    ...(fmp.isConfigured() ? [["fmp", () => fmpHistory(symbol, rangeKey)] as [string, () => Promise<Candle[]>]] : []),
    ["stooq", () => stooq.history(symbol)],
  ]);
}

marketRouter.get("/history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (isForeignSymbol(symbol)) return res.status(400).json({ error: "US-listed symbols only" });
  const rangeKey = String(req.query.range ?? "6M");
  const a = usStock(symbol);
  if (a && alpaca.isConfigured()) {
    try {
      const data = await cached(`alpaca-history:${a}:${rangeKey}`, ALPACA_HISTORY_TTL, () => alpacaHistory(a, rangeKey));
      if (data && data.length > 0) return res.json(data);
    } catch (err) {
      console.warn("[market] alpaca history failed, using other sources:", err instanceof Error ? err.message : err);
    }
  }
  try {
    const data = await cached(`history:${symbol}:${rangeKey}`, HISTORY_TTL, () =>
      isCrypto(symbol)
        ? withFallback([["alpaca-crypto", () => alpacaCrypto.history(symbol, rangeKey)]])
        : isVix(symbol)
        ? vixHistory(rangeKey)
        : FX_PAIR.test(symbol)
        ? fxSeries(symbol, SERIES_RANGE_N[rangeKey] ?? 130).then(seriesCandles)
        : otherHistory(symbol, rangeKey)
    );
    if (!Array.isArray(data) || data.length === 0) throw new Error("empty history from all providers");
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- search: US listings (Nasdaq Trader directories) + Alpaca crypto pairs ----

marketRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  try {
    const data = await cached(`search:${q.toLowerCase()}`, 300_000, () => withFallback([["listings", () => alpacaAssets.search(q)]]));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- news (Alpaca News: Benzinga) ----

const NEWS_LIMIT = 40;

function marketNews(limit: number): Promise<alpacaNews.NewsItem[]> {
  return withFallback([
    ["alpaca-news", async () => (await alpacaNews.marketNews(limit)).map((i) => alpacaNews.toNewsItem(i))],
  ]);
}

marketRouter.get("/news", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  if (!alpaca.isConfigured()) return needs(res, "Alpaca API keys", req.path);
  try {
    const data = await cached(`news:${symbol ?? "top"}`, NEWS_TTL, async () => {
      if (!symbol) return marketNews(NEWS_LIMIT);
      return withFallback([
        ["alpaca-news", async () => (await alpacaNews.symbolNews(symbol, NEWS_LIMIT)).map((i) => alpacaNews.toNewsItem(i, symbol))],
      ]);
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- economic calendar: official US release schedules, with FMP's
// forecast/previous/actual when FMP_API_KEY is set ----

const ECON_DAYS = 14;
// The agencies' schedules are in New York dates.
const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

marketRouter.get("/econ-calendar", async (req, res) => {
  const today = nyDate.format(new Date());
  const to = new Date(Date.parse(today) + ECON_DAYS * DAY_MS).toISOString().slice(0, 10);
  try {
    const data = await cached(`econ-calendar:${today}`, 900_000, async () => {
      const official = await calendars.econEvents(today, to);
      if (!fmp.isConfigured()) return official;
      const consensus = await fmp.economicCalendar(today, to).catch((err) => {
        console.warn("[market] fmp economic calendar unavailable:", err instanceof Error ? err.message : err);
        return [];
      });
      return withConsensus(official, consensus);
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- options (Alpaca OPRA snapshots; open interest isn't on the data host, so it's null) ----

marketRouter.get("/options/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const expiry = req.query.expiry ? String(req.query.expiry) : undefined;
  if (!alpaca.isConfigured()) return needs(res, "Alpaca API keys", req.path);
  try {
    const data = await cached(`options:${symbol}:${expiry ?? "front"}`, 60_000, () =>
      withFallback([["alpaca-options", () => alpacaOptions.chain(symbol, { expiry })]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- crypto ----

marketRouter.get("/crypto", async (req, res) => {
  try {
    const data = await cached("crypto:markets", 5_000, () => withFallback([["coingecko", () => coingecko.markets(50)]]));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/global", async (req, res) => {
  try {
    const data = await cached("crypto:global", 120_000, () =>
      withFallback([["coingecko", () => coingecko.globalStats()]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/orderbook/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!alpacaCrypto.isCryptoSymbol(symbol)) {
    return res.status(400).json({ error: "unsupported crypto symbol" });
  }
  try {
    const data = await cached(`orderbook:${symbol}`, 5_000, () =>
      withFallback([["alpaca-crypto", () => alpacaCrypto.orderBook(symbol)]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- macro: treasury yield curve (FRED) + key indexes via ETF proxies ----

const YIELD_SERIES: Array<{ id: string; tenor: string }> = [
  { id: "DGS3MO", tenor: "3M" },
  { id: "DGS5", tenor: "5Y" },
  { id: "DGS10", tenor: "10Y" },
  { id: "DGS30", tenor: "30Y" },
];

const INDEX_PROXIES: Record<string, string> = {
  SPY: "S&P 500 (SPY)",
  DIA: "Dow Jones (DIA)",
  QQQ: "Nasdaq 100 (QQQ)",
  IWM: "Russell 2000 (IWM)",
  GLD: "Gold (GLD)",
  USO: "WTI Crude (USO)",
  TLT: "20Y+ Treasury (TLT)",
  UUP: "Dollar Index (UUP)",
};

// ---- EU macro: ECB AAA euro-area yield curve + policy rate + HICP inflation,
// plus key European indexes via US-listed ETF proxies (same trick as the US
// index proxies above, so they price from Alpaca like any US ETF).

const EU_YIELD_SERIES: Array<{ flowRef: string; key: string; tenor: string }> = [
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M", tenor: "3M" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_5Y", tenor: "5Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", tenor: "10Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_30Y", tenor: "30Y" },
];

// Deposit facility rate — the ECB's operative policy rate since the 2024
// operational framework review (not the main refinancing rate).
const EU_POLICY_RATE = { flowRef: "FM", key: "D.U2.EUR.4F.KR.DFR.LEV" };
const EU_INFLATION = { flowRef: "ICP", key: "M.U2.N.000000.4.ANR" }; // HICP, y/y

const EU_INDEX_PROXIES: Record<string, string> = {
  FEZ: "Euro Stoxx 50 (FEZ)",
  IEUR: "MSCI Europe (IEUR)",
  EWG: "Germany (EWG)",
  EWU: "UK (EWU)",
  EWQ: "France (EWQ)",
  EWI: "Italy (EWI)",
};

marketRouter.get("/macro", async (req, res) => {
  try {
    if (req.query.region === "eu") {
      const [yieldResults, policyRate, inflation, quotes] = await Promise.all([
        Promise.allSettled(
          EU_YIELD_SERIES.map((s) => cached(`ecb:${s.key}`, 300_000, () => ecb.latest(s.flowRef, s.key)))
        ),
        cached(`ecb:${EU_POLICY_RATE.key}`, 300_000, () => ecb.latest(EU_POLICY_RATE.flowRef, EU_POLICY_RATE.key)).catch(
          () => null
        ),
        cached(`ecb:${EU_INFLATION.key}`, 300_000, () => ecb.latest(EU_INFLATION.flowRef, EU_INFLATION.key)).catch(
          () => null
        ),
        getQuotes(Object.keys(EU_INDEX_PROXIES)),
      ]);
      const yields = EU_YIELD_SERIES.map((s, i) => {
        const r = yieldResults[i];
        return { tenor: s.tenor, value: r.status === "fulfilled" ? r.value?.value ?? null : null };
      }).filter((y) => y.value !== null);

      const indexes = quotes.map((q) => ({
        symbol: q.symbol,
        label: EU_INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
      }));

      if (yields.length === 0 && indexes.length === 0) throw new Error("no EU macro data from any provider");
      res.json({
        yields,
        vix: null,
        indexes,
        policyRate: policyRate?.value ?? null,
        inflation: inflation?.value ?? null,
      });
      return;
    }

    const [yieldResults, vix, quotes] = await Promise.all([
      Promise.allSettled(YIELD_SERIES.map((s) => cached(`fred:${s.id}`, 300_000, () => fred.latest(s.id)))),
      cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
      getQuotes(Object.keys(INDEX_PROXIES)),
    ]);
    const yields = YIELD_SERIES.map((s, i) => {
      const r = yieldResults[i];
      return { tenor: s.tenor, value: r.status === "fulfilled" ? r.value?.value ?? null : null };
    }).filter((y) => y.value !== null);

    const indexes = quotes.map((q) => ({
      symbol: q.symbol,
      label: INDEX_PROXIES[q.symbol] ?? q.symbol,
      price: q.price,
      changePercent: q.changePercent,
    }));

    if (yields.length === 0 && indexes.length === 0) throw new Error("no macro data from any provider");
    res.json({ yields, vix: vix?.value ?? null, indexes, policyRate: null, inflation: null });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- heatmap + screener + sectors over the US large caps (see market-rows.ts) ----
// European rows came from TradingView's scanner, which is gone, and no
// licensed source covers European listings yet: ?market=eu answers an empty
// list with the reason in the X-Market-Note header.

const EU_NOTE = "European listings are unavailable: their only source (TradingView) forbids automated use.";

function isEu(req: any, res: any): boolean {
  if (req.query.market !== "eu") return false;
  res.set("X-Market-Note", EU_NOTE);
  res.json([]);
  return true;
}

marketRouter.get("/heatmap", async (req, res) => {
  if (isEu(req, res)) return;
  try {
    const rows = await usMarketRows();
    const top = rows.filter((r) => r.marketCap).slice(0, 150);
    res.json(top);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/screener", async (req, res) => {
  if (isEu(req, res)) return;
  try {
    let rows = await usMarketRows();
    const num = (v: unknown) => (v === undefined ? undefined : Number(v));
    const f = {
      sector: req.query.sector ? String(req.query.sector) : undefined,
      marketCapMin: num(req.query.marketCapMin),
      changeMin: num(req.query.changeMin),
      changeMax: num(req.query.changeMax),
      volumeMin: num(req.query.volumeMin),
    };
    rows = rows.filter((r) => {
      if (f.sector && r.sector !== f.sector) return false;
      if (f.marketCapMin !== undefined && (r.marketCap ?? 0) < f.marketCapMin) return false;
      if (f.changeMin !== undefined && (r.changePercent ?? -Infinity) < f.changeMin) return false;
      if (f.changeMax !== undefined && (r.changePercent ?? Infinity) > f.changeMax) return false;
      if (f.volumeMin !== undefined && (r.volume ?? 0) < f.volumeMin) return false;
      return true;
    });
    const sortKey = String(req.query.sort ?? "marketCap") as keyof MarketRow;
    const dir = req.query.dir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = (a[sortKey] as number | null) ?? -Infinity;
      const bv = (b[sortKey] as number | null) ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
    res.json(rows.slice(0, 500));
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/sectors", async (req, res) => {
  if (isEu(req, res)) return;
  try {
    const rows = await usMarketRows();
    res.json([...new Set(rows.map((r) => r.sector))].sort());
  } catch {
    res.json([]);
  }
});

// ---- market recap: templated end-of-day-style narrative + supporting stats ----

const RECAP_TTL = 15_000;

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "flat";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function buildRecapSummary(d: {
  indexes: Array<{ symbol: string; label: string; changePercent: number | null }>;
  bestSector?: { sector: string; avgChangePercent: number };
  worstSector?: { sector: string; avgChangePercent: number };
  gainers: MarketRow[];
  losers: MarketRow[];
  vix: number | null;
}): string {
  const spy = d.indexes.find((i) => i.symbol === "SPY");
  const qqq = d.indexes.find((i) => i.symbol === "QQQ");
  const dia = d.indexes.find((i) => i.symbol === "DIA");
  const spyChange = spy?.changePercent ?? 0;
  const dir = spyChange > 0.15 ? "trading higher" : spyChange < -0.15 ? "trading lower" : "little changed";

  const parts: string[] = [];
  parts.push(
    `US stocks are ${dir}, with the S&P 500 ${pct(spy?.changePercent)}, the Nasdaq 100 ${pct(qqq?.changePercent)} and the Dow ${pct(dia?.changePercent)}.`
  );
  if (d.bestSector && d.worstSector && d.bestSector.sector !== d.worstSector.sector) {
    parts.push(
      `${d.bestSector.sector} is leading sector performance (${pct(d.bestSector.avgChangePercent)}), while ${d.worstSector.sector} lags (${pct(d.worstSector.avgChangePercent)}).`
    );
  }
  if (d.gainers[0] && d.losers[0]) {
    parts.push(
      `${d.gainers[0].name} paces advancers, up ${pct(d.gainers[0].changePercent)}, while ${d.losers[0].name} is the biggest decliner, down ${pct(
        d.losers[0].changePercent
      )}.`
    );
  }
  if (d.vix !== null) {
    parts.push(`The VIX volatility index is at ${d.vix.toFixed(2)}.`);
  }
  return parts.join(" ");
}

marketRouter.get("/recap", async (req, res) => {
  try {
    const data = await cached("recap:full", RECAP_TTL, async () => {
      const [quotes, vix, rows, headlines] = await Promise.all([
        getQuotes(Object.keys(INDEX_PROXIES)),
        cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
        usMarketRows(),
        // Headlines are a garnish: a recap without them beats no recap.
        cached("news:recap", NEWS_TTL, () => marketNews(NEWS_LIMIT)).catch(() => [] as alpacaNews.NewsItem[]),
      ]);

      const indexes = quotes.map((q) => ({
        symbol: q.symbol,
        label: INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
      }));

      const ranked = rows.filter((r) => (r.marketCap ?? 0) > 2_000_000_000 && r.changePercent !== null);
      const gainers = [...ranked].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0)).slice(0, 5);
      const losers = [...ranked].sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0)).slice(0, 5);

      const sectorMap = new Map<string, { sum: number; count: number }>();
      for (const r of rows) {
        if (r.changePercent === null || !r.sector) continue;
        const cur = sectorMap.get(r.sector) ?? { sum: 0, count: 0 };
        cur.sum += r.changePercent;
        cur.count += 1;
        sectorMap.set(r.sector, cur);
      }
      const sectors = [...sectorMap.entries()]
        .map(([sector, { sum, count }]) => ({ sector, avgChangePercent: sum / count }))
        .sort((a, b) => b.avgChangePercent - a.avgChangePercent);

      const bestSector = sectors[0];
      const worstSector = sectors[sectors.length - 1];

      const summary = buildRecapSummary({ indexes, bestSector, worstSector, gainers, losers, vix: vix?.value ?? null });

      return {
        summary,
        updatedAt: new Date().toISOString(),
        indexes,
        vix: vix?.value ?? null,
        gainers,
        losers,
        sectors: sectors.slice(0, 3).concat(sectors.length > 3 ? sectors.slice(-3) : []),
        news: headlines.slice(0, 6),
      };
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings calendar for a list of symbols: the locally captured FMP calendar ----

const CALENDAR_FALLBACK_MS = 2000;

marketRouter.get("/calendar", async (req, res) => {
  const symbols = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 500);
  if (symbols.length === 0) return res.status(400).json({ error: "symbols required" });
  if (!fmp.isConfigured() && !estimates.hasCalendarRows()) return needs(res, "FMP_API_KEY", req.path);
  try {
    const today = tradingDay(new Date().toISOString());
    const rows = estimates.calendarFor(symbols, today);
    // Symbols the captured calendar doesn't know, before today's capture has run: ask FMP per symbol, but only wait a moment; the rest arrive on the next request.
    const missing = rows.filter((r) => !r.found).map((r) => r.symbol);
    const captured = estimates.latestRunDay();
    if (missing.length > 0 && fmp.isConfigured() && (captured === null || captured < today)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const info = await Promise.race([
        fmp.earningsInfo(missing).catch(() => null),
        new Promise<null>((r) => (timer = setTimeout(() => r(null), CALENDAR_FALLBACK_MS))),
      ]);
      clearTimeout(timer);
      const bySymbol = new Map((info ?? []).map((i) => [i.symbol.toUpperCase(), i]));
      for (const r of rows) {
        const i = bySymbol.get(r.symbol);
        if (i) Object.assign(r, { nextEarningsDate: i.nextEarningsDate, lastEarningsDate: i.lastEarningsDate, epsForecast: i.epsForecast });
      }
    }
    const timings = timingsFor(symbols);
    res.json(
      rows.map((r) => {
        const t = timings.get(r.symbol);
        return { ...r, found: undefined, timing: t?.timing ?? null, timingBasis: t?.timing ? { matched: t.matched, total: t.total } : null };
      })
    );
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings history: forecast vs actual per quarter (FMP), plus next-day price move ----

/** A year of daily closes: local Alpaca bars, else FMP, else Stooq. */
async function yearOfCloses(symbol: string): Promise<Candle[]> {
  const a = usStock(symbol);
  if (a && alpaca.isConfigured()) {
    const local = await alpacaHistory(a, "1Y").catch(() => null);
    if (local && local.length > 0) return local;
  }
  return otherHistory(symbol, "1Y");
}

marketRouter.get("/earnings-history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!fmp.isConfigured()) return needs(res, "FMP_API_KEY", req.path);
  try {
    const data = await cached(`earnings-history:${symbol}`, 3_600_000, async () => {
      const [surprises, candles] = await Promise.all([fmp.earnings(symbol), yearOfCloses(symbol)]);
      const sorted = [...candles].sort((a, b) => a.time - b.time);
      // The price reaction: a before-open report moves the report day (its
      // close against the previous close), any other the next trading day
      // (its close against the report day's).
      const timing = timingsFor([fmp.fmpSymbol(symbol)]).get(fmp.fmpSymbol(symbol))?.timing ?? null;
      return surprises.map((s) => {
        if (s.upcoming) return { ...s, dayAfterChangePercent: null };
        const idx = sorted.findIndex((c) => c.time >= s.dateReported);
        if (idx < 0 || sorted[idx].time - s.dateReported > 3 * 86_400) return { ...s, dayAfterChangePercent: null };
        const [from, to] = timing === "bmo" ? [sorted[idx - 1], sorted[idx]] : [sorted[idx], sorted[idx + 1]];
        const dayAfterChangePercent = from && to ? ((to.close - from.close) / from.close) * 100 : null;
        return { ...s, dayAfterChangePercent };
      });
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- short sale volume (FINRA Reg SHO daily file) ----

marketRouter.get("/short-volume/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const day = await cached("finra-shortvol-day", 6 * 3_600_000, () => finra.latestDay());
    const row = day.get(symbol);
    if (!row) return res.json(null);
    res.json({ ...row, shortVolumePercent: (row.shortVolume / row.totalVolume) * 100 });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- insider transactions (SEC EDGAR Form 4) ----

marketRouter.get("/insider/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await cached(`insider:${symbol}`, 3_600_000, () => secedgar.insiderTransactions(symbol));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});
