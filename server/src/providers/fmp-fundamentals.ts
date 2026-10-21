// Fundamentals, estimates and analyst datasets from Financial Modeling Prep's
// stable API. Every function returns FMP's own field names; only
// noise is dropped and sub-datasets are grouped. `asOf` is when the oldest
// underlying FMP response was fetched (cached responses keep their time).

import { FmpError, cached, get } from "./fmp-core.js";
import { isForeignSymbol } from "../history/universe.js";

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

export type Statement = "income" | "balance" | "cashflow";
export type Period = "quarter" | "annual" | "ttm";
export type Range = { from?: string; to?: string };
export type Result<T> = { data: T; asOf: Date };
type Row = Record<string, any>;

type Fetched = { at: number; rows: Row[] };

/** One FMP call, cached; the stored value remembers when it was fetched. */
async function load(path: string, params: Record<string, string | number | undefined>, ttl: number): Promise<Fetched> {
  const key = `fund:${path}:${JSON.stringify(params)}`;
  return cached(key, ttl, async () => {
    const json = await get(path, params);
    return { at: Date.now(), rows: Array.isArray(json) ? json : json ? [json] : [] };
  });
}

/** Like load, but a plan without the dataset (402/403) or no data (404) reads as absent rather than failing the route. */
async function loadOptional(path: string, params: Record<string, string | number | undefined>, ttl: number): Promise<Fetched> {
  try {
    return await load(path, params, ttl);
  } catch (err) {
    if (err instanceof FmpError && [402, 403, 404].includes(err.status)) return { at: Date.now(), rows: [] };
    throw err;
  }
}

const oldest = (...f: Fetched[]) => new Date(Math.min(...f.map((x) => x.at)));

/** Keeps rows whose date (`date` unless told otherwise) falls within from..to (inclusive); rows without one are kept. */
export function inRange<T extends Row>(rows: T[], { from, to }: Range, key = "date"): T[] {
  return rows.filter((r) => {
    const d = typeof r[key] === "string" ? r[key].slice(0, 10) : null;
    return !d || ((!from || d >= from) && (!to || d <= to));
  });
}

const STATEMENT_PATH: Record<Statement, string> = {
  income: "income-statement",
  balance: "balance-sheet-statement",
  cashflow: "cash-flow-statement",
};

/** Statements newest first, with filingDate and acceptedDate. `ttm` is FMP's rolling trailing-twelve-month series, one row per reported quarter. */
export async function statements(symbol: string, type: Statement, period: Period, limit: number, range: Range): Promise<Result<Row[]>> {
  const path = STATEMENT_PATH[type] + (period === "ttm" ? "-ttm" : "");
  const f = await load(path, { symbol, period: period === "ttm" ? undefined : period, limit }, DAY);
  return { data: inRange(f.rows, range), asOf: new Date(f.at) };
}

const METRIC_ID = new Set(["symbol", "date", "fiscalYear", "period", "reportedCurrency"]);
const split = (row: Row) => Object.fromEntries(Object.entries(row).filter(([k]) => !METRIC_ID.has(k)));

/**
 * key-metrics and ratios joined per period date. The two share some names
 * (currentRatio), so each keeps its fields in its own object. TTM is a single
 * row whose fields carry FMP's TTM suffix.
 */
export async function metrics(symbol: string, period: Period, limit: number, range: Range): Promise<Result<Row[]>> {
  if (period === "ttm") {
    const [km, rt] = await Promise.all([load("key-metrics-ttm", { symbol }, DAY), load("ratios-ttm", { symbol }, DAY)]);
    const data = km.rows.length || rt.rows.length ? [{ symbol, period: "TTM", keyMetrics: split(km.rows[0] ?? {}), ratios: split(rt.rows[0] ?? {}) }] : [];
    return { data, asOf: oldest(km, rt) };
  }
  const p = { symbol, period, limit };
  const [km, rt] = await Promise.all([load("key-metrics", p, DAY), load("ratios", p, DAY)]);
  const ratios = new Map(rt.rows.map((r) => [r.date, r]));
  const seen = new Set<string>();
  const data: Row[] = km.rows.map((k) => {
    seen.add(k.date);
    const r = ratios.get(k.date);
    return { symbol: k.symbol, date: k.date, fiscalYear: k.fiscalYear, period: k.period, reportedCurrency: k.reportedCurrency, keyMetrics: split(k), ratios: r ? split(r) : null };
  });
  for (const r of rt.rows) {
    if (seen.has(r.date)) continue;
    data.push({ symbol: r.symbol, date: r.date, fiscalYear: r.fiscalYear, period: r.period, reportedCurrency: r.reportedCurrency, keyMetrics: null, ratios: split(r) });
  }
  data.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { data: inRange(data, range), asOf: oldest(km, rt) };
}

/** The three statement-growth datasets plus FMP's financial-growth, each newest first. */
export async function growth(symbol: string, period: "quarter" | "annual", limit: number, range: Range): Promise<Result<{ income: Row[]; balance: Row[]; cashflow: Row[]; financial: Row[] }>> {
  const p = { symbol, period, limit };
  const [income, balance, cashflow, financial] = await Promise.all([
    load("income-statement-growth", p, DAY),
    load("balance-sheet-statement-growth", p, DAY),
    load("cash-flow-statement-growth", p, DAY),
    load("financial-growth", p, DAY),
  ]);
  return {
    data: { income: inRange(income.rows, range), balance: inRange(balance.rows, range), cashflow: inRange(cashflow.rows, range), financial: inRange(financial.rows, range) },
    asOf: oldest(income, balance, cashflow, financial),
  };
}

/** Altman Z and Piotroski (null when FMP has none) and the latest quarterly enterprise values. */
export async function scores(symbol: string, limit: number): Promise<Result<{ scores: Row | null; enterpriseValues: Row[] }>> {
  const [s, ev] = await Promise.all([load("financial-scores", { symbol }, DAY), load("enterprise-values", { symbol, period: "quarter", limit }, DAY)]);
  return { data: { scores: s.rows[0] ?? null, enterpriseValues: ev.rows }, asOf: oldest(s, ev) };
}

/** Revenue by product and by geography; each row is { symbol, fiscalYear, period, reportedCurrency, date, data: { segment: revenue } }. */
export async function segments(symbol: string, period: "quarter" | "annual", limit: number, range: Range): Promise<Result<{ product: Row[]; geographic: Row[] }>> {
  const [product, geographic] = await Promise.all([
    load("revenue-product-segmentation", { symbol, period }, DAY),
    load("revenue-geographic-segmentation", { symbol, period }, DAY),
  ]);
  const shape = (f: Fetched) => inRange(f.rows, range).slice(0, limit);
  return { data: { product: shape(product), geographic: shape(geographic) }, asOf: oldest(product, geographic) };
}

/**
 * Consensus estimates per fiscal period. FMP lists periods from the far
 * future back to the 1990s; this returns them oldest first starting from the
 * nearest period that may not have reported yet (period end within the last
 * 100 days quarterly, 370 annually), unless `from` says otherwise.
 */
export async function analystEstimates(symbol: string, period: "quarter" | "annual", limit: number, range: Range, today: string): Promise<Result<Row[]>> {
  const f = await load("analyst-estimates", { symbol, period, limit: 100 }, HOUR);
  const back = (period === "quarter" ? 100 : 370) * DAY;
  const from = range.from ?? new Date(Date.parse(today + "T00:00:00Z") - back).toISOString().slice(0, 10);
  const rows = inRange(f.rows, { from, to: range.to }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { data: rows.slice(0, limit), asOf: new Date(f.at) };
}

export type Analysts = {
  priceTargetSummary: Row | null;
  priceTargetConsensus: Row | null;
  priceTargets: Row[];
  grades: Row[];
  gradesConsensus: Row | null;
  gradesHistorical: Row[];
  ratingsSnapshot: Row | null;
};

/** publishers arrives as a JSON-encoded string; hand it back as an array. */
function summary(row: Row | undefined): Row | null {
  if (!row) return null;
  let publishers = row.publishers;
  if (typeof publishers === "string") {
    try {
      publishers = JSON.parse(publishers);
    } catch {
      // leave the string as FMP sent it
    }
  }
  return { ...row, publishers };
}

/** Price targets, rating changes and the consensus views. A dataset missing from the plan reads null/empty. */
export async function analysts(symbol: string, limit: number, range: Range): Promise<Result<Analysts>> {
  const p = { symbol };
  const [sum, cons, targets, grades, gcons, ghist, snap] = await Promise.all([
    loadOptional("price-target-summary", p, HOUR),
    loadOptional("price-target-consensus", p, HOUR),
    loadOptional("price-target-news", { symbol, limit }, HOUR),
    loadOptional("grades", { symbol, limit }, HOUR),
    loadOptional("grades-consensus", p, HOUR),
    loadOptional("grades-historical", { symbol, limit }, HOUR),
    loadOptional("ratings-snapshot", p, HOUR),
  ]);
  const fetched = [sum, cons, targets, grades, gcons, ghist, snap];
  return {
    data: {
      priceTargetSummary: summary(sum.rows[0]),
      priceTargetConsensus: cons.rows[0] ?? null,
      priceTargets: inRange(targets.rows, range, "publishedDate"),
      grades: inRange(grades.rows, range),
      gradesConsensus: gcons.rows[0] ?? null,
      gradesHistorical: inRange(ghist.rows, range),
      ratingsSnapshot: snap.rows[0] ?? null,
    },
    asOf: oldest(...fetched),
  };
}

/** FMP's unlevered and levered DCF values against the price they were struck at. */
export async function valuation(symbol: string): Promise<Result<{ dcf: Row | null; leveredDcf: Row | null }>> {
  const [dcf, levered] = await Promise.all([loadOptional("discounted-cash-flow", { symbol }, DAY), loadOptional("levered-discounted-cash-flow", { symbol }, DAY)]);
  return { data: { dcf: dcf.rows[0] ?? null, leveredDcf: levered.rows[0] ?? null }, asOf: oldest(dcf, levered) };
}

/** Peers with the price and market cap FMP already attaches; foreign listings are dropped. */
export async function peers(symbol: string): Promise<Result<Row[]>> {
  const f = await load("stock-peers", { symbol }, DAY);
  return { data: f.rows.filter((r) => typeof r.symbol === "string" && !isForeignSymbol(r.symbol)), asOf: new Date(f.at) };
}
