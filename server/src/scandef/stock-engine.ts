import type { Scorecard } from "../scan/contracts.js";
import { evalCond, type Ctx } from "./dsl.js";
import { BUILTIN_FACTORS, BUILTIN_LIVE_FACTORS, STOCK_GROUPS, type FactorBase } from "./factors.js";
import type { StockDefinition } from "./schema.js";

// Pure helpers that turn a stock definition into what the scoring passes need.

export type StockFactorSpec = FactorBase & { include: boolean };

const BASE_BY_KEY = new Map([...BUILTIN_FACTORS, ...BUILTIN_LIVE_FACTORS].map((f) => [f.key, f]));
export const factorBase = (key: string): FactorBase | undefined => BASE_BY_KEY.get(key);

/** The nightly factors as the definition configures them. */
export function factorSpecs(def: StockDefinition): StockFactorSpec[] {
  return def.factors.map((f) => ({
    key: f.key,
    group: f.group,
    label: BASE_BY_KEY.get(f.key)?.label ?? f.key,
    lowerBetter: f.direction === "lower",
    positiveOnly: f.positiveOnly,
    market: f.rankAgainst === "market",
    include: f.include,
  }));
}

/** Keys of the intraday factors switched on. */
export function liveKeys(def: StockDefinition): Set<string> {
  return new Set(def.liveFactors.filter((f) => f.include).map((f) => f.key));
}

/** Number of factors that count toward coverage in the nightly pass, and in the intraday pass. */
export const nightlyTotal = (def: StockDefinition): number => def.factors.filter((f) => f.include).length;
export const intradayTotal = (def: StockDefinition): number => nightlyTotal(def) + liveKeys(def).size;

export type StockCandidate = { card: Scorecard; price: number | null; nextEarningsDays: number | null };

/** The catalog values (stock scope) of a scorecard, for filters. */
export function stockCtx(c: StockCandidate): Ctx {
  const ctx: Ctx = {
    composite: c.card.composite,
    coverage: c.card.coverage,
    price: c.price,
    sector: c.card.sector,
    next_earnings_days: c.nextEarningsDays,
  };
  for (const f of c.card.factors) {
    ctx[f.key] = f.value;
    ctx[`${f.key}_score`] = f.score;
  }
  for (const g of STOCK_GROUPS) ctx[`${g}_score`] = c.card.groups[g] ?? null;
  return ctx;
}

export type StockScreen = {
  /** The listed stocks, best composite first. */
  picked: StockCandidate[];
  /** Scored, then coverage, then each filter, then the final list. */
  funnel: Array<{ step: string; count: number }>;
};

/**
 * Picks the stock ideas: composite present, enough coverage, every filter, best first, one per company
 * (`dedupe` sees top x3 candidates, so removing a second share class still leaves `top`).
 */
export function screenStocks(def: StockDefinition, candidates: StockCandidate[], dedupe: (cs: StockCandidate[]) => StockCandidate[] = (cs) => cs): StockScreen {
  const { top, minCoverage } = def.listing;
  const funnel: StockScreen["funnel"] = [];
  let pool = candidates.filter((c) => c.card.composite !== null);
  funnel.push({ step: "Scored", count: pool.length });
  pool = pool.filter((c) => c.card.coverage >= minCoverage);
  funnel.push({ step: `Coverage of ${Math.round(minCoverage * 100)}% or more`, count: pool.length });
  for (const f of def.filters) {
    pool = pool.filter((c) => evalCond(f, stockCtx(c)));
    funnel.push({ step: f.label ?? "Filter", count: pool.length });
  }
  pool.sort((a, b) => b.card.composite! - a.card.composite! || (a.card.symbol < b.card.symbol ? -1 : a.card.symbol > b.card.symbol ? 1 : 0));
  const picked = dedupe(pool.slice(0, top * 3)).slice(0, top);
  funnel.push({ step: `Top ${top}`, count: picked.length });
  return { picked, funnel };
}
