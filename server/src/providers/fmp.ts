// Financial Modeling Prep (optional, keyed). Static fields, foreign/index
// quotes and history, earnings and the economic calendar's forecast/actual.
//
// Uses the "stable" API (https://financialmodelingprep.com/stable/...). The
// docs site (site.financialmodelingprep.com/developer/docs) refused automated
// reads while this was written and no key exists yet, so paths and field names
// below come from memory of the docs, not from a live response. Anything
// marked UNCONFIRMED must be checked against a real response once a key exists.
//
// Plan limits (per the pricing page): Starter is US-listed only with annual
// fundamentals; quarterly data, and non-US exchanges, need Premium or above.
// A plan that lacks an endpoint answers 402/403, surfaced as an FmpError.

const BASE = "https://financialmodelingprep.com/stable";

const PROFILE_TTL = 24 * 3_600_000;
const QUOTE_TTL = 15_000;
const CALENDAR_TTL = 3_600_000;
const CONCURRENCY = 4;

/** Thrown by every function when FMP_API_KEY is unset, so routes can answer with a clear message. */
export class FmpNotConfigured extends Error {
  constructor() {
    super("FMP_API_KEY is not set: add a Financial Modeling Prep key to .env to enable this");
    this.name = "FmpNotConfigured";
  }
}

export class FmpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FmpError";
  }
}

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type Profile = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  marketCap: number | null;
  beta: number | null;
  lastDividend: number | null; // annual dividend per share
  website: string | null;
  isEtf: boolean;
};

/** Quote fields FMP can fill; merge over the server Quote (which carries the rest). */
export type FmpQuote = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  week52High: number | null;
  week52Low: number | null;
  sharesOutstanding: number | null;
  time: number | null; // unix seconds
  source: "fmp";
};

export type EarningsCalendarRow = {
  symbol: string;
  date: number; // unix seconds, UTC midnight
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
};

/** Same fields as the /calendar route returns today (tradingview.EarningsInfo). */
export type EarningsInfo = {
  symbol: string;
  nextEarningsDate: number | null; // unix seconds
  lastEarningsDate: number | null;
  epsForecast: number | null;
};

/** Superset of nasdaq.EarningsSurpriseRow, which /earnings-history/:symbol returns today. */
export type EarningsHistoryRow = {
  fiscalQtrEnd: string; // FMP gives no fiscal period end here; always ""
  dateReported: number; // unix seconds, UTC midnight
  eps: number | null;
  consensusForecast: number | null;
  surprisePercent: number | null;
  revenue: number | null;
  revenueEstimate: number | null;
};

/** Same fields as econcalendar.EconEvent, plus the currency. */
export type EconEvent = {
  title: string;
  country: string;
  date: string; // ISO
  impact: "Low" | "Medium" | "High" | "Holiday";
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  currency: string | null;
};

export function isConfigured(): boolean {
  return Boolean(process.env.FMP_API_KEY?.trim());
}

function requireKey(): string {
  const key = process.env.FMP_API_KEY?.trim();
  if (!key) throw new FmpNotConfigured();
  return key;
}

// Spacing limiter: FMP's plans allow 300 calls/min and up.
const GAP_MS = 60_000 / 300;
let nextSlot = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const cache = new Map<string, { at: number; value: unknown }>();

/** Test hook: reset the limiter and cache between tests. */
export function resetState(): void {
  nextSlot = 0;
  cache.clear();
}

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function get(path: string, params: Record<string, string | number | undefined>): Promise<any> {
  const key = requireKey();
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  url.searchParams.set("apikey", key);

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, (isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Never echo the URL: it carries the key.
      throw new FmpError(res.status, `fmp ${res.status} for /${path}${res.status === 401 ? " (check FMP_API_KEY)" : ""}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    // FMP reports some errors as 200 with {"Error Message": "..."}.
    if (json && !Array.isArray(json) && typeof json["Error Message"] === "string") {
      throw new FmpError(200, `fmp /${path}: ${json["Error Message"].slice(0, 200)}`);
    }
    return json;
  }
}

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function unixDay(date: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000) : null;
}

function norm(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

/**
 * Company profiles, cached 24 h. GET /profile?symbol=X, one call per symbol
 * (UNCONFIRMED: a comma list may work on higher plans, but one call each is
 * safe on every plan). Symbols FMP doesn't know are omitted.
 */
export async function profiles(symbols: string[]): Promise<Map<string, Profile>> {
  requireKey();
  const out = new Map<string, Profile>();
  await mapLimit(norm(symbols), async (symbol) => {
    const p = await cached(`profile:${symbol}`, PROFILE_TTL, async () => {
      const rows = await get("profile", { symbol });
      const r = Array.isArray(rows) ? rows[0] : null;
      if (!r) return null;
      return {
        symbol,
        name: str(r.companyName),
        exchange: str(r.exchange) ?? str(r.exchangeFullName),
        currency: str(r.currency),
        sector: str(r.sector),
        industry: str(r.industry),
        country: str(r.country),
        marketCap: num(r.marketCap),
        beta: num(r.beta),
        lastDividend: num(r.lastDividend),
        website: str(r.website),
        isEtf: r.isEtf === true,
      } satisfies Profile;
    });
    if (p) out.set(symbol, p);
  });
  return out;
}

/**
 * Quotes, cached 15 s. GET /batch-quote?symbols=A,B (UNCONFIRMED: the batch
 * endpoint may need Premium; on 402/403 it falls back to /quote?symbol=X per
 * symbol). The stable quote has no P/E or EPS (read here only if present,
 * UNCONFIRMED), so pe and eps are usually null; /ratios-ttm would fill them.
 * sharesOutstanding is marketCap / price.
 */
export async function quotes(symbols: string[]): Promise<Map<string, FmpQuote>> {
  requireKey();
  const wanted = norm(symbols);
  const out = new Map<string, FmpQuote>();
  const missing: string[] = [];
  for (const s of wanted) {
    const hit = cache.get(`quote:${s}`);
    if (hit && Date.now() - hit.at < QUOTE_TTL) out.set(s, hit.value as FmpQuote);
    else missing.push(s);
  }
  if (missing.length === 0) return out;

  let rows: any[];
  try {
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));
    rows = (await mapLimit(chunks, (c) => get("batch-quote", { symbols: c.join(",") }))).flat();
  } catch (err) {
    if (!(err instanceof FmpError) || (err.status !== 402 && err.status !== 403)) throw err;
    rows = (await mapLimit(missing, (symbol) => get("quote", { symbol }))).flat();
  }

  for (const r of rows) {
    const symbol = String(r?.symbol ?? "").toUpperCase();
    if (!symbol) continue;
    const price = num(r.price);
    const marketCap = num(r.marketCap);
    const q: FmpQuote = {
      symbol,
      name: str(r.name),
      exchange: str(r.exchange),
      price,
      change: num(r.change),
      changePercent: num(r.changePercentage ?? r.changesPercentage),
      open: num(r.open),
      high: num(r.dayHigh),
      low: num(r.dayLow),
      previousClose: num(r.previousClose),
      volume: num(r.volume),
      avgVolume: num(r.avgVolume ?? r.averageVolume), // UNCONFIRMED: absent from the stable quote
      marketCap,
      pe: num(r.pe), // UNCONFIRMED
      eps: num(r.eps), // UNCONFIRMED
      week52High: num(r.yearHigh),
      week52Low: num(r.yearLow),
      sharesOutstanding: num(r.sharesOutstanding) ?? (marketCap && price ? Math.round(marketCap / price) : null),
      time: num(r.timestamp),
      source: "fmp",
    };
    cache.set(`quote:${symbol}`, { at: Date.now(), value: q });
    out.set(symbol, q);
  }
  return out;
}

/** Daily EOD candles, oldest first. GET /historical-price-eod/full?symbol&from&to (dates YYYY-MM-DD). */
export async function historical(symbol: string, from: string, to: string): Promise<Candle[]> {
  requireKey();
  const sym = symbol.trim().toUpperCase();
  return cached(`hist:${sym}:${from}:${to}`, CALENDAR_TTL, async () => {
    const json = await get("historical-price-eod/full", { symbol: sym, from, to });
    // UNCONFIRMED: older docs wrapped rows in {symbol, historical: [...]}; accept both.
    const rows: any[] = Array.isArray(json) ? json : (json?.historical ?? []);
    const candles: Candle[] = [];
    for (const r of rows) {
      const time = unixDay(r.date);
      const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
      if (time === null || open === null || high === null || low === null || close === null) continue;
      candles.push({ time, open, high, low, close, volume: num(r.volume) ?? 0 });
    }
    return candles.sort((a, b) => a.time - b.time);
  });
}

function earningsRow(r: any): EarningsCalendarRow | null {
  const date = unixDay(r?.date);
  const symbol = String(r?.symbol ?? "").toUpperCase();
  if (date === null || !symbol) return null;
  return {
    symbol,
    date,
    epsActual: num(r.epsActual),
    epsEstimated: num(r.epsEstimated),
    revenueActual: num(r.revenueActual),
    revenueEstimated: num(r.revenueEstimated),
  };
}

/** Raw earnings calendar for a date window (YYYY-MM-DD; FMP caps the window at 90 days). GET /earnings-calendar. */
export async function earningsCalendar(from: string, to: string): Promise<EarningsCalendarRow[]> {
  requireKey();
  return cached(`earn-cal:${from}:${to}`, CALENDAR_TTL, async () => {
    const rows = await get("earnings-calendar", { from, to });
    return (Array.isArray(rows) ? rows : []).map(earningsRow).filter((r): r is EarningsCalendarRow => r !== null);
  });
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The /calendar route's shape: per symbol, next and last report date and the next EPS forecast. */
export async function earningsInfo(symbols: string[], now = new Date()): Promise<EarningsInfo[]> {
  requireKey();
  const today = isoDay(now);
  const day = 86_400_000;
  const [ahead, ahead2, behind] = await Promise.all([
    earningsCalendar(today, isoDay(new Date(now.getTime() + 89 * day))),
    earningsCalendar(isoDay(new Date(now.getTime() + 90 * day)), isoDay(new Date(now.getTime() + 179 * day))),
    earningsCalendar(isoDay(new Date(now.getTime() - 89 * day)), isoDay(new Date(now.getTime() - day))),
  ]);
  const todayUnix = unixDay(today)!;
  const upcoming = [...ahead, ...ahead2].sort((a, b) => a.date - b.date);
  return symbols.map((raw) => {
    const symbol = raw.trim().toUpperCase();
    const next = upcoming.find((r) => r.symbol === symbol && r.date >= todayUnix);
    const last = behind.filter((r) => r.symbol === symbol).sort((a, b) => b.date - a.date)[0];
    return {
      symbol: raw,
      nextEarningsDate: next?.date ?? null,
      lastEarningsDate: last?.date ?? null,
      epsForecast: next?.epsEstimated ?? null,
    };
  });
}

/**
 * Reported quarters, newest first. GET /earnings?symbol=X&limit=N. Rows with
 * no epsActual (future dates) are dropped. surprisePercent is computed:
 * (actual - estimate) / |estimate| * 100.
 */
export async function earnings(symbol: string, limit = 12): Promise<EarningsHistoryRow[]> {
  requireKey();
  const sym = symbol.trim().toUpperCase();
  return cached(`earnings:${sym}:${limit}`, CALENDAR_TTL, async () => {
    const rows = await get("earnings", { symbol: sym, limit });
    return (Array.isArray(rows) ? rows : [])
      .map(earningsRow)
      .filter((r): r is EarningsCalendarRow => r !== null && r.epsActual !== null)
      .sort((a, b) => b.date - a.date)
      .map((r) => ({
        fiscalQtrEnd: "",
        dateReported: r.date,
        eps: r.epsActual,
        consensusForecast: r.epsEstimated,
        surprisePercent:
          r.epsActual !== null && r.epsEstimated !== null && r.epsEstimated !== 0
            ? ((r.epsActual - r.epsEstimated) / Math.abs(r.epsEstimated)) * 100
            : null,
        revenue: r.revenueActual,
        revenueEstimate: r.revenueEstimated,
      }));
  });
}

function impact(v: unknown): EconEvent["impact"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "high") return "High";
  if (s === "medium") return "Medium";
  if (s === "holiday") return "Holiday";
  return "Low";
}

/**
 * Economic calendar. GET /economic-calendar?from&to. Dates arrive as
 * "YYYY-MM-DD HH:mm:ss" in UTC (UNCONFIRMED timezone) and are returned as ISO.
 */
export async function economicCalendar(from: string, to: string): Promise<EconEvent[]> {
  requireKey();
  return cached(`econ:${from}:${to}`, CALENDAR_TTL, async () => {
    const rows = await get("economic-calendar", { from, to });
    const out: EconEvent[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(r?.date ?? ""));
      const title = str(r?.event);
      if (!m || !title) continue;
      const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
      const text = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
      out.push({
        title,
        country: str(r.country) ?? "",
        date: `${m[1]}T${time}.000Z`,
        impact: impact(r.impact),
        forecast: text(r.estimate),
        previous: text(r.previous),
        actual: text(r.actual),
        currency: str(r.currency),
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  });
}
