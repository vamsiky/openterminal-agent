import type { OptionScorecard, OptionStrategy, Scorecard } from "../scan/contracts.js";
import { listOptionCandidates, onePerCompany, type OptionCandidate } from "../quant/ideas.js";
import { optionFunnel, type OptionEvaluation } from "../scandef/engine.js";
import type { OptionDefinition, StockDefinition } from "../scandef/schema.js";
import { screenStocks, type StockCandidate } from "../scandef/stock-engine.js";

// The result of one pass under one definition, in the shape replay, shadow and live share. Pure.

export type ResultIdea = { symbol: string; strategy: "buy" | OptionStrategy; contract: string | null; score: number; rank: number };
export type FunnelStep = { step: string; count: number; /** Options only: which strategy the step belongs to. */ strategy?: OptionStrategy };
export type SpreadBucket = { bucket: string; count: number };
export type TestResult = {
  at: string;
  scanned: number;
  ideas: ResultIdea[];
  nearMisses: ResultIdea[];
  funnel: FunnelStep[];
  spread: SpreadBucket[];
};

export const SPREAD_BUCKETS = ["<50", "50-55", "55-60", "60-65", "65-70", "70-75", "75-80", "80+"] as const;

/** Counts scores in 5-point buckets from 50 to 80, plus under 50 and 80 and up. */
export function spreadOf(scores: number[]): SpreadBucket[] {
  const counts = new Array<number>(SPREAD_BUCKETS.length).fill(0);
  for (const s of scores) counts[s < 50 ? 0 : s >= 80 ? 7 : 1 + Math.floor((s - 50) / 5)]++;
  return SPREAD_BUCKETS.map((bucket, i) => ({ bucket, count: counts[i] }));
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const ranked = (cs: Array<{ symbol: string; strategy: "buy" | OptionStrategy; contract: string | null; score: number }>): ResultIdea[] =>
  cs.map((c, i) => ({ symbol: c.symbol, strategy: c.strategy, contract: c.contract, score: round1(c.score), rank: i + 1 }));

/** One option symbol as scored: its metrics (for the early-IV bar) and the evaluation under some definition. */
export type OptionItem = { symbol: string; metrics: OptionScorecard["metrics"]; evaluation: OptionEvaluation };

export function optionResult(def: OptionDefinition, items: OptionItem[], at: string): TestResult {
  const cards = items.map((i) => ({ underlying: i.symbol, metrics: i.metrics, setups: i.evaluation.setups }));
  const { top, nearMisses } = listOptionCandidates(cards, def.listing);
  const traces = items.flatMap((i) => i.evaluation.traces);
  const funnel: FunnelStep[] = [];
  for (const [key, s] of Object.entries(def.strategies) as Array<[OptionStrategy, OptionDefinition["strategies"][OptionStrategy]]>) {
    if (!s.enabled) continue;
    for (const f of optionFunnel(key, traces)) funnel.push({ ...f, strategy: key });
    funnel.push({ step: "Listed", count: top.filter((c: OptionCandidate) => c.strategy === key).length, strategy: key });
  }
  return {
    at,
    scanned: items.length,
    ideas: ranked(top),
    nearMisses: ranked(nearMisses),
    funnel,
    spread: spreadOf(items.flatMap((i) => i.evaluation.setups.map((s) => s.score))),
  };
}

/** The stock screen over a pass's cards: scored, coverage, each filter, then the top N. */
export function stockResult(def: StockDefinition, candidates: StockCandidate[], at: string, dedupe?: (cs: StockCandidate[]) => StockCandidate[]): TestResult {
  const keepOne =
    dedupe ??
    ((cs: StockCandidate[]) => {
      const keep = new Set(onePerCompany(cs.map((c) => c.card)).map((c: Scorecard) => c.symbol));
      return cs.filter((c) => keep.has(c.card.symbol));
    });
  const { picked, pool, funnel } = screenStocks(def, candidates, keepOne);
  return {
    at,
    scanned: candidates.length,
    ideas: ranked(picked.map((c) => ({ symbol: c.card.symbol, strategy: "buy" as const, contract: null, score: c.card.composite! }))),
    nearMisses: [],
    funnel,
    spread: spreadOf(pool.map((c) => c.card.composite!)),
  };
}

export type Compare = {
  live: TestResult;
  draft: TestResult;
  added: ResultIdea[];
  removed: ResultIdea[];
  rankChanges: Array<{ symbol: string; strategy: ResultIdea["strategy"]; from: number; to: number; scoreFrom: number; scoreTo: number }>;
};

const keyOf = (i: ResultIdea) => `${i.symbol}|${i.strategy}`;

/** Ideas the draft adds or removes against live, and those that stay but move. */
export function compareResults(live: TestResult, draft: TestResult): Compare {
  const l = new Map(live.ideas.map((i) => [keyOf(i), i]));
  const d = new Map(draft.ideas.map((i) => [keyOf(i), i]));
  const rankChanges: Compare["rankChanges"] = [];
  for (const [k, to] of d) {
    const from = l.get(k);
    if (from && (from.rank !== to.rank || from.score !== to.score)) rankChanges.push({ symbol: to.symbol, strategy: to.strategy, from: from.rank, to: to.rank, scoreFrom: from.score, scoreTo: to.score });
  }
  return { live, draft, added: draft.ideas.filter((i) => !l.has(keyOf(i))), removed: live.ideas.filter((i) => !d.has(keyOf(i))), rankChanges };
}
