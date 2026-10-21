// Financial Modeling Prep market-wide events and reference data: IPOs and
// lock-ups, M&A, split and dividend calendars, sector/industry snapshots,
// index constituents, ETF holdings and exposure, company profile with
// executives. Paths and fields confirmed against live stable-API responses
// on 2026-10-21. Responses keep FMP's field names.

import { isForeignSymbol } from "../history/universe.js";

/**
 * FMP writes US share classes with a dash (BRK-B), so in FMP's calendars any
 * dotted symbol is a foreign listing, including the single-letter suffixes
 * (BBY.L, AFM.V) that isForeignSymbol lets through for US classes like MKC.V.
 */
function usListed(r: { symbol?: unknown }): boolean {
  const symbol = String(r.symbol ?? "");
  return symbol !== "" && !symbol.includes(".") && !isForeignSymbol(symbol);
}
import { cached, fmpSymbol, get } from "./fmp-core.js";

const CALENDAR_TTL = 3_600_000;
const REFERENCE_TTL = 24 * 3_600_000;
const QUOTE_TTL = 15_000;
const NEWS_TTL = 5 * 60_000;
const DAY_MS = 86_400_000;
const LOCKUP_DAYS = 180;
// Prospectuses and disclosures are filed before the IPO date.
const FILING_LEAD_DAYS = 60;

type Row = Record<string, any>;

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDay(day: string, days: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

function rows(json: unknown): Row[] {
  return Array.isArray(json) ? (json as Row[]) : [];
}

function byDateDesc(a: Row, b: Row): number {
  return String(b.date ?? "").localeCompare(String(a.date ?? ""));
}

function byDateAsc(a: Row, b: Row): number {
  return String(a.date ?? "").localeCompare(String(b.date ?? ""));
}

// ---- IPOs and lock-ups ----

/** IPO date + 180 days: the usual lock-up length, an estimate (real terms are in the prospectus). */
export function lockupExpiry(ipoDay: string): { date: string; estimated: true; basis: string } {
  return { date: shiftDay(ipoDay, LOCKUP_DAYS), estimated: true, basis: `IPO date + ${LOCKUP_DAYS} days` };
}

async function ipoCalendarRaw(from: string, to: string): Promise<Row[]> {
  return cached(`mkt:ipos:${from}:${to}`, CALENDAR_TTL, async () => rows(await get("ipos-calendar", { from, to })).filter(usListed));
}

async function prospectusRaw(from: string, to: string): Promise<Row[]> {
  return cached(`mkt:ipo-prospectus:${from}:${to}`, CALENDAR_TTL, async () => rows(await get("ipos-prospectus", { from, to })));
}

async function disclosureRaw(from: string, to: string): Promise<Row[]> {
  return cached(`mkt:ipo-disclosure:${from}:${to}`, CALENDAR_TTL, async () => rows(await get("ipos-disclosure", { from, to })));
}

function groupBySymbol(list: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of list) {
    const s = String(r.symbol ?? "");
    if (!s) continue;
    out.set(s, [...(out.get(s) ?? []), r]);
  }
  return out;
}

/** IPO calendar rows with prospectus pricing, SEC disclosures and an estimated lock-up expiry; ascending by date. */
export async function ipos(from: string, to: string): Promise<Row[]> {
  const filingFrom = shiftDay(from, -FILING_LEAD_DAYS);
  const [calendar, prospectuses, disclosures] = await Promise.all([ipoCalendarRaw(from, to), prospectusRaw(filingFrom, to), disclosureRaw(filingFrom, to)]);
  const pros = groupBySymbol(prospectuses);
  const discl = groupBySymbol(disclosures);
  return calendar
    .map((r) => ({
      ...r,
      prospectus: (pros.get(r.symbol) ?? []).sort((a, b) => String(b.filingDate).localeCompare(String(a.filingDate))),
      disclosures: (discl.get(r.symbol) ?? []).sort((a, b) => String(b.filingDate).localeCompare(String(a.filingDate))),
      lockupExpiry: lockupExpiry(String(r.date)),
    }))
    .sort(byDateAsc);
}

const NOT_COMMON = /\b(warrants?|rights?|units?)\b/i;

/** Latest prices for symbols, one batch call. */
async function prices(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!symbols.length) return out;
  const list = [...new Set(symbols)].sort();
  const quotes = await cached(`mkt:batch-quote:${list.join(",")}`, QUOTE_TTL, async () => rows(await get("batch-quote", { symbols: list.join(",") })));
  for (const q of quotes) if (typeof q.price === "number" && q.symbol) out.set(String(q.symbol), q.price);
  return out;
}

/** Priced IPOs whose estimated 180-day lock-up expires within the next `days` days, soonest first. Warrants, rights and units are left out. */
export async function lockups(days: number, today = isoDay(new Date())): Promise<Row[]> {
  const ipoFrom = shiftDay(today, -LOCKUP_DAYS);
  const ipoTo = shiftDay(today, days - LOCKUP_DAYS);
  const [calendar, prospectuses] = await Promise.all([ipoCalendarRaw(ipoFrom, ipoTo), prospectusRaw(shiftDay(ipoFrom, -FILING_LEAD_DAYS), ipoTo)]);
  const pros = groupBySymbol(prospectuses);
  const priced = calendar.filter((r) => r.actions === "Priced" && !NOT_COMMON.test(String(r.company ?? "")));
  const now = await prices(priced.map((r) => String(r.symbol)));
  return priced
    .map((r) => {
      const ipoPrice = (pros.get(r.symbol) ?? []).map((p) => p.pricePublicPerShare).find((p) => typeof p === "number" && p > 0) ?? null;
      const price = now.get(r.symbol) ?? null;
      return {
        ...r,
        lockupExpiry: lockupExpiry(String(r.date)),
        ipoPrice,
        price,
        changeSinceIpoPercent: ipoPrice && price ? ((price - ipoPrice) / ipoPrice) * 100 : null,
      };
    })
    .sort((a, b) => a.lockupExpiry.date.localeCompare(b.lockupExpiry.date));
}

// ---- M&A, splits, dividends ----

/** Latest M&A filings, newest first. */
export async function mergers(limit: number): Promise<Row[]> {
  return cached(`mkt:mergers:${limit}`, NEWS_TTL, async () => rows(await get("mergers-acquisitions-latest", { page: 0, limit })));
}

async function calendar(path: string, from: string, to: string): Promise<Row[]> {
  return cached(`mkt:${path}:${from}:${to}`, CALENDAR_TTL, async () => rows(await get(path, { from, to })).filter(usListed));
}

/** US-listed stock splits in the range, ascending by date. */
export async function splits(from: string, to: string): Promise<Row[]> {
  return (await calendar("splits-calendar", from, to)).slice().sort(byDateAsc);
}

/** US-listed dividends in the range (ex-dates), ascending by date. */
export async function dividends(from: string, to: string): Promise<Row[]> {
  return (await calendar("dividends-calendar", from, to)).slice().sort(byDateAsc);
}

// ---- Sectors and industries ----

export type Exchange = "NASDAQ" | "NYSE";

/**
 * Snapshots need a trading day; without a date, walk back from today until
 * FMP has rows (weekends and holidays are empty).
 */
async function snapshot(path: string, exchange: Exchange, date: string | undefined, today: string): Promise<{ date: string; rows: Row[] }> {
  const attempts = date ? [date] : Array.from({ length: 6 }, (_, i) => shiftDay(today, -i));
  for (const d of attempts) {
    const list = await cached(`mkt:${path}:${exchange}:${d}`, CALENDAR_TTL, async () => rows(await get(path, { date: d, exchange })));
    if (list.length) return { date: d, rows: list };
  }
  return { date: attempts[0], rows: [] };
}

async function group(kind: "sector" | "industry", exchange: Exchange, date?: string, today = isoDay(new Date())): Promise<{ date: string; rows: Row[] }> {
  const perf = await snapshot(`${kind}-performance-snapshot`, exchange, date, today);
  const pe = await snapshot(`${kind}-pe-snapshot`, exchange, perf.date, today);
  const peByName = new Map(pe.rows.map((r) => [String(r[kind]), r.pe]));
  const merged = perf.rows.map((r): Row => ({ ...r, pe: peByName.get(String(r[kind])) ?? null })).sort((a, b) => (b.averageChange ?? -Infinity) - (a.averageChange ?? -Infinity));
  return { date: perf.date, rows: merged };
}

/** Sector performance (averageChange, percent) joined with sector P/E; best performer first. */
export const sectors = (exchange: Exchange, date?: string, today?: string) => group("sector", exchange, date, today);
/** Industry performance joined with industry P/E; best performer first. */
export const industries = (exchange: Exchange, date?: string, today?: string) => group("industry", exchange, date, today);

/** Daily performance and P/E history of one sector or industry, newest first. */
export async function groupHistory(kind: "sector" | "industry", name: string, exchange: Exchange, fromDay?: string, toDay?: string, today = isoDay(new Date())): Promise<Row[]> {
  // FMP answers nothing when only one end of the range is given.
  const to = toDay ?? (fromDay ? today : undefined);
  const from = fromDay ?? (toDay ? shiftDay(toDay, -365) : undefined);
  const [perf, pe] = await Promise.all(
    (["performance", "pe"] as const).map((what) =>
      cached(`mkt:hist-${kind}-${what}:${name}:${exchange}:${from}:${to}`, CALENDAR_TTL, async () => rows(await get(`historical-${kind}-${what}`, { [kind]: name, exchange, from, to })))
    )
  );
  const peByDate = new Map(pe.map((r) => [String(r.date), r.pe]));
  return perf.map((r) => ({ ...r, pe: peByDate.get(String(r.date)) ?? null })).sort(byDateDesc);
}

// ---- Index constituents ----

export const INDEXES = { sp500: "sp500", nasdaq: "nasdaq", dowjones: "dowjones" } as const;
export type IndexName = keyof typeof INDEXES;

/** Current constituents. FMP's nasdaq list is the Nasdaq-100. */
export async function indexConstituents(name: IndexName): Promise<Row[]> {
  return cached(`mkt:index:${name}`, REFERENCE_TTL, async () => rows(await get(`${name}-constituent`, {})));
}

/** Additions and removals, newest first. FMP returns the full history; from/to/limit trim it here. */
export async function indexChanges(name: IndexName, from?: string, to?: string, limit?: number): Promise<Row[]> {
  const all = await cached(`mkt:index-changes:${name}`, REFERENCE_TTL, async () => rows(await get(`historical-${name}-constituent`, {})));
  const kept = all.filter((r) => (!from || String(r.date) >= from) && (!to || String(r.date) <= to)).sort(byDateDesc);
  return limit ? kept.slice(0, limit) : kept;
}

// ---- ETFs ----

/** An ETF's holdings, heaviest first. Empty for a symbol that is not an ETF. */
export async function etfHoldings(symbol: string): Promise<Row[]> {
  const list = await cached(`mkt:etf-holdings:${fmpSymbol(symbol)}`, REFERENCE_TTL, async () => rows(await get("etf/holdings", { symbol })));
  return list.slice().sort((a, b) => (b.weightPercentage ?? -Infinity) - (a.weightPercentage ?? -Infinity));
}

/** Fund facts plus country and sector weightings. `country` weights arrive as "97.66%" strings and are kept as numbers here. */
export async function etfExposure(symbol: string): Promise<{ info: Row | null; countryWeightings: Row[]; sectorWeightings: Row[] }> {
  const key = fmpSymbol(symbol);
  const [info, countries, sectorList] = await Promise.all([
    cached(`mkt:etf-info:${key}`, REFERENCE_TTL, async () => rows(await get("etf/info", { symbol }))),
    cached(`mkt:etf-country:${key}`, REFERENCE_TTL, async () => rows(await get("etf/country-weightings", { symbol }))),
    cached(`mkt:etf-sector:${key}`, REFERENCE_TTL, async () => rows(await get("etf/sector-weightings", { symbol }))),
  ]);
  const fund: Row = { ...info[0] };
  delete fund.description;
  delete fund.sectorsList;
  return {
    info: info[0] ? fund : null,
    countryWeightings: countries.map((r) => ({ ...r, weightPercentage: Number.parseFloat(String(r.weightPercentage)) })),
    sectorWeightings: sectorList,
  };
}

/** US-listed ETFs that hold the stock, heaviest weight first. US ETF tickers have no dot (isForeignSymbol misses AAP3.L), and FMP carries bogus weights over 100%. */
export async function etfAssetExposure(symbol: string): Promise<Row[]> {
  const list = await cached(`mkt:etf-asset-exposure:${fmpSymbol(symbol)}`, REFERENCE_TTL, async () => rows(await get("etf/asset-exposure", { symbol })));
  return list.filter((r) => !String(r.symbol ?? "").includes(".") && !(r.weightPercentage > 100)).sort((a, b) => (b.weightPercentage ?? -Infinity) - (a.weightPercentage ?? -Infinity));
}

// ---- Company profile ----

/** FMP's company profile (null when FMP has none), key executives, and employee counts from 10-K filings (newest first). */
export async function companyProfile(symbol: string): Promise<{ profile: Row | null; executives: Row[]; employeeCount: { latest: number | null; history: Row[] } }> {
  const key = fmpSymbol(symbol);
  const [profile, executives, employees] = await Promise.all([
    cached(`mkt:profile:${key}`, REFERENCE_TTL, async () => rows(await get("profile", { symbol }))),
    cached(`mkt:executives:${key}`, REFERENCE_TTL, async () => rows(await get("key-executives", { symbol }))),
    cached(`mkt:employees:${key}`, REFERENCE_TTL, async () => rows(await get("employee-count", { symbol }))),
  ]);
  const history = employees.slice().sort((a, b) => String(b.periodOfReport).localeCompare(String(a.periodOfReport)));
  return { profile: profile[0] ?? null, executives, employeeCount: { latest: history[0]?.employeeCount ?? null, history } };
}
