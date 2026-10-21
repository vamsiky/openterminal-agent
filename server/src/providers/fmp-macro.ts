import { cached, get, isConfigured, num } from "./fmp-core.js";

// US rates from FMP, the primary source for /api/macro (FRED is the fallback
// when there is no FMP key or FMP lacks a series). Every function resolves to null when FMP
// has no key or no data, so a value is filled only if it exists.

export type Dated = { value: number; date: string };
const HOUR = 3_600_000;
const FIVE_MIN = 300_000;

export type TreasuryRates = { date: string; month3: number | null; year5: number | null; year10: number | null; year30: number | null };

/** The latest row of FMP's treasury-rates. */
export async function treasuryRates(): Promise<TreasuryRates | null> {
  if (!isConfigured()) return null;
  return cached("fmp:treasury-rates", FIVE_MIN, async () => {
    const rows = await get("treasury-rates", { limit: 1 });
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r || typeof r.date !== "string") return null;
    return { date: r.date, month3: num(r.month3), year5: num(r.year5), year10: num(r.year10), year30: num(r.year30) };
  });
}

/** CBOE VIX from FMP's index quote. */
export async function vix(): Promise<Dated | null> {
  if (!isConfigured()) return null;
  return cached("fmp:vix", FIVE_MIN, async () => {
    const rows = await get("quote", { symbol: "^VIX" });
    const q = Array.isArray(rows) ? rows[0] : null;
    const price = num(q?.price);
    if (price === null) return null;
    return { value: price, date: typeof q.timestamp === "number" ? new Date(q.timestamp * 1000).toISOString().slice(0, 10) : "" };
  });
}

const latestIndicator = async (name: string): Promise<Array<{ date: string; value: number }>> => {
  const rows = await get("economic-indicators", { name });
  return (Array.isArray(rows) ? rows : []).flatMap((r) => (typeof r?.date === "string" && num(r.value) !== null ? [{ date: r.date, value: num(r.value)! }] : [])).sort((a, b) => b.date.localeCompare(a.date));
};

/** Effective federal funds rate (percent), latest month. */
export async function policyRate(): Promise<Dated | null> {
  if (!isConfigured()) return null;
  return cached("fmp:federalFunds", HOUR, async () => {
    const [latest] = await latestIndicator("federalFunds");
    return latest ? { value: latest.value, date: latest.date.slice(0, 7) } : null;
  });
}

/** Month shifted by `n` months from a YYYY-MM-DD date, as [first day, last day] of that month. */
function monthBounds(date: string, n: number): [string, string] {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + n, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return [d.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

/** CPI inflation, year over year in percent, from the CPI index level of the latest month and of the same month a year earlier. */
export async function cpiYoy(): Promise<Dated | null> {
  if (!isConfigured()) return null;
  return cached("fmp:cpi-yoy", HOUR, async () => {
    const [latest] = await latestIndicator("CPI");
    if (!latest) return null;
    const [from, to] = monthBounds(latest.date, -12);
    const prior = (await get("economic-indicators", { name: "CPI", from, to }).then((r) => (Array.isArray(r) ? r : []))).find((r) => typeof r?.date === "string" && r.date.slice(0, 7) === from.slice(0, 7));
    const base = num(prior?.value);
    if (base === null || base === 0) return null;
    return { value: Math.round((latest.value / base - 1) * 1000) / 10, date: latest.date.slice(0, 7) };
  });
}

// ---- merging with FRED ----

export type Source = { source: string; asOf: string | null } | null;
export type UsRates = {
  yields: Array<{ tenor: string; value: number }>;
  vix: number | null;
  policyRate: number | null;
  inflation: number | null;
  sources: { yields: Source; vix: Source; policyRate: Source; inflation: Source };
};

const TENORS = [["3M", "month3"], ["5Y", "year5"], ["10Y", "year10"], ["30Y", "year30"]] as const;

/**
 * FMP values first; a tenor or the VIX FMP could not give comes from FRED. Nothing is filled without data.
 * `fred.yields` is per tenor (null on failure or not asked for) with the date FRED reported.
 */
export function mergeRates(
  fred: { yields: Array<{ tenor: string; value: number | null; date?: string }>; vix: { value: number; date?: string } | null },
  fmp: { treasury: TreasuryRates | null; vix: Dated | null; policy: Dated | null; cpi: Dated | null }
): UsRates {
  const used = new Set<string>();
  const dates: string[] = [];
  const yields: UsRates["yields"] = [];
  for (const [tenor, key] of TENORS) {
    const f = fred.yields.find((y) => y.tenor === tenor);
    if (fmp.treasury?.[key] != null) {
      yields.push({ tenor, value: fmp.treasury[key]! });
      used.add("fmp:treasury-rates");
      dates.push(fmp.treasury.date);
    } else if (f && f.value !== null) {
      yields.push({ tenor, value: f.value });
      used.add("fred");
      if (f.date) dates.push(f.date);
    }
  }
  const asOf = dates.sort()[0] ?? null;
  const sources: UsRates["sources"] = {
    yields: yields.length ? { source: [...used].join("+"), asOf } : null,
    vix: null,
    policyRate: fmp.policy ? { source: "fmp:economic-indicators federalFunds", asOf: fmp.policy.date } : null,
    inflation: fmp.cpi ? { source: "fmp:economic-indicators CPI, year over year %", asOf: fmp.cpi.date } : null,
  };
  let vix: number | null = null;
  if (fmp.vix) {
    vix = fmp.vix.value;
    sources.vix = { source: "fmp:quote ^VIX", asOf: fmp.vix.date || null };
  } else if (fred.vix) {
    vix = fred.vix.value;
    sources.vix = { source: "fred", asOf: fred.vix.date ?? null };
  }
  return { yields, vix, policyRate: fmp.policy?.value ?? null, inflation: fmp.cpi?.value ?? null, sources };
}
