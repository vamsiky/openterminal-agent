// FMP ownership datasets: 13F institutional positions, insider trades,
// Congress disclosures and share float. All of them are US-only and sit on
// the stable API; paths and fields were probed on 2026-10-21 (Ultimate plan).

import { cached, get, num, str } from "./fmp-core.js";

const DAY = 24 * 3600 * 1000;
const OWNERSHIP_TTL = DAY;
// 13F filings are due 45 days after quarter end; a bit later most are in.
const THIRTEEN_F_LAG_DAYS = 45;

export type Quarter = { year: number; quarter: number };

/** The newest calendar quarter whose 13F deadline has passed. */
export function latestFiledQuarter(now = new Date()): Quarter {
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < 5; i++) {
    const end = Date.UTC(year, quarter * 3, 0); // last day of the quarter
    if (end + THIRTEEN_F_LAG_DAYS * DAY <= now.getTime()) return { year, quarter };
    ({ year, quarter } = previousQuarter({ year, quarter }));
  }
  return { year, quarter };
}

export function previousQuarter(q: Quarter): Quarter {
  return q.quarter === 1 ? { year: q.year - 1, quarter: 4 } : { year: q.year, quarter: q.quarter - 1 };
}

const rows = (json: unknown): any[] => (Array.isArray(json) ? json : []);

export type Institutional = {
  year: number;
  quarter: number;
  /** Position summary row as FMP returns it; null when FMP has no 13F data for the quarter. */
  summary: Record<string, unknown> | null;
  /** Top holders by shares, at most 25. */
  holders: Record<string, unknown>[];
};

async function institutionalFor(symbol: string, q: Quarter): Promise<Institutional> {
  const key = `own:inst:${symbol}:${q.year}:${q.quarter}`;
  return cached(key, OWNERSHIP_TTL, async () => {
    const params = { symbol, year: q.year, quarter: q.quarter };
    const [summary, holders] = await Promise.all([
      get("institutional-ownership/symbol-positions-summary", params),
      get("institutional-ownership/extract-analytics/holder", { ...params, page: 0, limit: 25 }),
    ]);
    return { ...q, summary: rows(summary)[0] ?? null, holders: rows(holders).slice(0, 25) };
  });
}

/**
 * 13F positions summary plus top holders. Without an explicit quarter it tries
 * the latest quarter past its filing deadline, then the one before.
 */
export async function getInstitutional(symbol: string, q?: Quarter): Promise<Institutional> {
  if (q) return institutionalFor(symbol, q);
  const first = latestFiledQuarter();
  const a = await institutionalFor(symbol, first);
  if (a.summary || a.holders.length) return a;
  const b = await institutionalFor(symbol, previousQuarter(first));
  return b.summary || b.holders.length ? b : a;
}

export type InsiderData = { trades: Record<string, unknown>[]; statistics: Record<string, unknown>[] };

/** Form 4 transactions (newest first) and quarterly buy/sell statistics. */
export async function getInsiders(symbol: string, limit: number): Promise<InsiderData> {
  return cached(`own:insiders:${symbol}:${limit}`, OWNERSHIP_TTL, async () => {
    const [trades, statistics] = await Promise.all([
      get("insider-trading/search", { symbol, page: 0, limit }),
      get("insider-trading/statistics", { symbol }),
    ]);
    return { trades: rows(trades), statistics: rows(statistics) };
  });
}

export type CongressTrade = Record<string, unknown> & { chamber: "senate" | "house"; disclosureLagDays: number | null };

function lagDays(transaction: unknown, disclosure: unknown): number | null {
  const a = Date.parse(String(transaction ?? ""));
  const b = Date.parse(String(disclosure ?? ""));
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY) : null;
}

function withChamber(chamber: "senate" | "house", list: unknown): CongressTrade[] {
  return rows(list).map((r) => ({ ...r, chamber, disclosureLagDays: lagDays(r.transactionDate, r.disclosureDate) }));
}

const byTransactionDesc = (a: CongressTrade, b: CongressTrade) =>
  String(b.transactionDate ?? "").localeCompare(String(a.transactionDate ?? ""));

/** Senate and House trades for one symbol, merged, newest transaction first. */
export async function getCongress(symbol: string, limit: number): Promise<CongressTrade[]> {
  return cached(`own:congress:${symbol}:${limit}`, OWNERSHIP_TTL, async () => {
    const [senate, house] = await Promise.all([get("senate-trades", { symbol }), get("house-trades", { symbol })]);
    return [...withChamber("senate", senate), ...withChamber("house", house)].sort(byTransactionDesc).slice(0, limit);
  });
}

export type Float = { symbol: string; date: string | null; floatShares: number | null; outstandingShares: number | null; freeFloat: number | null; source: string | null };

/** Share float; null when FMP has none for the symbol. */
export async function getFloat(symbol: string): Promise<Float | null> {
  return cached(`own:float:${symbol}`, OWNERSHIP_TTL, async () => {
    const r = rows(await get("shares-float", { symbol }))[0];
    if (!r) return null;
    return {
      symbol,
      date: str(r.date),
      floatShares: num(r.floatShares),
      outstandingShares: num(r.outstandingShares),
      freeFloat: num(r.freeFloat),
      source: str(r.source),
    };
  });
}

/** Latest Form 4 filings across the market, newest first. */
export async function getLatestInsiders(limit: number): Promise<Record<string, unknown>[]> {
  return cached(`own:insiders:latest:${limit}`, 5 * 60_000, async () => rows(await get("insider-trading/latest", { page: 0, limit })));
}

/** Latest Senate and House disclosures, merged, newest disclosure first. */
export async function getLatestCongress(limit: number): Promise<CongressTrade[]> {
  return cached(`own:congress:latest:${limit}`, 60 * 60_000, async () => {
    const [senate, house] = await Promise.all([
      get("senate-latest", { page: 0, limit }),
      get("house-latest", { page: 0, limit }),
    ]);
    return [...withChamber("senate", senate), ...withChamber("house", house)]
      .sort((a, b) => String(b.disclosureDate ?? "").localeCompare(String(a.disclosureDate ?? "")) || byTransactionDesc(a, b))
      .slice(0, limit);
  });
}

/** Latest 13F filings across the market, newest first. `link` and `finalLink` are kept: both point at different SEC pages. */
export async function getLatestThirteenF(limit: number): Promise<Record<string, unknown>[]> {
  return cached(`own:13f:latest:${limit}`, 60 * 60_000, async () => rows(await get("institutional-ownership/latest", { page: 0, limit })));
}
