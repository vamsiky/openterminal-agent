import { db } from "../db.js";
import { calendarFor } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import { liveQuote } from "../live/feed.js";
import { nextExDividends } from "../quant/dividends.js";
import { getOptionScorecard } from "../quant/option-score.js";
import { optionHoldings, sharesHeld } from "../quant/positions.js";
import { getLiveScorecard, getStockScorecard } from "../quant/stock-score.js";
import type { Idea } from "../scan/contracts.js";
import { capUsd, judgeModel, MAX_TURNS, model } from "./config.js";
import type { Case, MacroReport, Thesis, ThesisStrategy } from "./contracts.js";
import { guardrail, priceWarning } from "./guardrail.js";
import { loadPrompt } from "./prompts.js";
import { runAgent, type RunResult } from "./runtime.js";
import { caseJson, caseOutput, judgeJson, judgeOutput, type CaseOutput } from "./schemas.js";
import { insertThesis, latestMacro } from "./store.js";
import type { QueueItem } from "./queue.js";

// One analysis: bull and bear in parallel, then the judge, then the guardrail.

export const CASE_TOOLS = [
  "research_summary", "fundamentals", "ownership", "transcripts", "search_transcripts", "content", "quote", "price_history",
  "earnings_calendar", "estimate_revisions", "scorecard", "option_metrics", "market_news",
];
export const JUDGE_TOOLS = ["quote", "option_metrics"];

export type AnalysisTarget = { symbol: string; strategy: ThesisStrategy; contract: string | null; ideaId: number | null; kind: "stock" | "option" };

/** The active idea behind a request, if the app still lists one. */
export function findIdea(t: { symbol: string; strategy: ThesisStrategy; contract: string | null; ideaId: number | null }): Idea | null {
  const row = t.ideaId
    ? db.prepare("SELECT * FROM ideas WHERE id = ?").get(t.ideaId)
    : db.prepare("SELECT * FROM ideas WHERE symbol = ? AND strategy = ? AND status = 'active' AND (contract IS ? OR ? IS NULL) ORDER BY id DESC LIMIT 1").get(t.symbol, t.strategy, t.contract, t.contract);
  if (!row) return null;
  const r = row as any;
  return { id: r.id, kind: r.kind, symbol: r.symbol, strategy: r.strategy, contract: r.contract, score: r.score, rank: r.rank, reasons: JSON.parse(r.reasons), firstSeen: r.first_seen, lastSeen: r.last_seen, status: r.status };
}

const compactCard = (c: ReturnType<typeof getStockScorecard>) =>
  c && {
    asOf: c.asOf, sector: c.sector, industry: c.industry, composite: c.composite, coverage: c.coverage, groups: c.groups,
    factors: c.factors.filter((f) => f.score !== null).map((f) => ({ key: f.key, group: f.group, value: f.value, score: f.score, change20d: f.change })),
  };

export function gatherContext(t: AnalysisTarget, idea: Idea | null, now: Date, macro: MacroReport | null = latestMacro()) {
  const day = nyClock(now).date;
  const stock = getStockScorecard(t.symbol);
  const live = getLiveScorecard(t.symbol);
  const options = t.kind === "option" ? getOptionScorecard(t.symbol) : null;
  const nextEarn = calendarFor([t.symbol], day)[0]?.nextEarningsDate ?? null;
  const q = liveQuote(t.symbol, t.symbol, now);
  const shares = sharesHeld(t.symbol);
  const heldOptions = optionHoldings().filter((o) => o.underlying === t.symbol);
  return {
    today: day,
    now: now.toISOString(),
    idea: { symbol: t.symbol, strategy: t.strategy, contract: t.contract, score: idea?.score ?? null, rank: idea?.rank ?? null, reasons: idea?.reasons ?? [], firstSeen: idea?.firstSeen ?? null },
    stockScorecard: compactCard(stock),
    liveScorecard: live ? { asOf: live.asOf, composite: live.composite, groups: live.groups } : null,
    optionScorecard: options && {
      asOf: options.asOf, score: options.score, momentum: options.momentum, metrics: options.metrics,
      earningsBeforeExpiry: options.earningsBeforeExpiry, nextEarnings: options.nextEarnings,
      setups: options.setups.filter((s) => s.strategy === t.strategy),
    },
    macro: macro && { id: macro.id, asOf: macro.asOf, session: macro.session, regime: macro.regime, summary: macro.summary, risks: macro.risks },
    nextEarningsDate: nextEarn ? new Date(nextEarn * 1000).toISOString().slice(0, 10) : null,
    nextExDividend: nextExDividends([t.symbol], day).get(t.symbol) ?? null,
    quote: q && { price: q.price, change: q.change, changePercent: q.changePercent, asOf: q.asOf ?? null, extended: q.extended },
    held: { shares, options: heldOptions },
  };
}

const lens = (side: "bull" | "bear", ctx: object) =>
  `Argue the ${side.toUpperCase()} case for this idea. Facts we already hold:\n${JSON.stringify(ctx)}`;

const toCase = (side: "bull" | "bear", r: RunResult<CaseOutput>): Case | null => (r.output ? { side, summary: r.output.summary, points: r.output.points, costUsd: r.costUsd } : null);

export type AnalysisOutcome = { outcome: "done"; thesis: Thesis } | { outcome: "budget" };

/** Bull and bear in parallel, then the judge; stores one thesis row (status ok, rejected or error). */
export async function analyze(item: AnalysisTarget, now = new Date()): Promise<AnalysisOutcome> {
  const day = nyClock(now).date;
  const idea = findIdea(item);
  const macro = latestMacro();
  const ctx = gatherContext(item, idea, now, macro);
  const asOf = now.toISOString();

  const caseRun = (side: "bull" | "bear") =>
    runAgent({
      agent: side, model: model(), system: loadPrompt(side), prompt: lens(side, ctx), schema: caseOutput, jsonSchema: caseJson,
      tools: CASE_TOOLS, maxBudgetUsd: capUsd(side), maxTurns: MAX_TURNS[side], symbol: item.symbol, now,
    });
  const [bullRun, bearRun] = await Promise.all([caseRun("bull"), caseRun("bear")]);
  const bull = toCase("bull", bullRun);
  const bear = toCase("bear", bearRun);
  let cost = bullRun.costUsd + bearRun.costUsd;

  const base = {
    ideaId: idea?.id ?? item.ideaId, symbol: item.symbol, kind: item.kind, strategy: item.strategy, contract: item.contract, asOf,
    verdict: null, confidence: null, horizon: null, entry: null, target: null, invalidation: null, exitPlan: null,
    catalysts: [], risks: [], summary: null, bull, bear, evidence: [],
    inputs: {
      scorecardAsOf: ctx.stockScorecard?.asOf ?? null, optionScorecardAsOf: ctx.optionScorecard?.asOf ?? null,
      macroId: macro?.id ?? null, ideaScore: idea?.score ?? null,
    },
    models: { bull: bull ? model() : null, bear: bear ? model() : null, judge: null },
  } satisfies Omit<Thesis, "id" | "status" | "statusReason" | "costUsd" | "models"> & { models: Thesis["models"] };
  const fail = (reason: string) => ({ outcome: "done" as const, thesis: insertThesis(day, { ...base, status: "error", statusReason: reason, costUsd: cost }) });

  if (bullRun.status === "skipped" && bearRun.status === "skipped") return { outcome: "budget" };
  if (!bull || !bear) return fail(`${!bull ? "bull" : "bear"} case failed: ${(!bull ? bullRun : bearRun).error}`);

  const judgeRun = await runAgent({
    agent: "judge", model: judgeModel(), system: loadPrompt("judge"),
    prompt: `Decide on this idea. Facts we hold:\n${JSON.stringify(ctx)}\n\nBULL CASE:\n${JSON.stringify(bull)}\n\nBEAR CASE:\n${JSON.stringify(bear)}`,
    schema: judgeOutput, jsonSchema: judgeJson, tools: JUDGE_TOOLS, maxBudgetUsd: capUsd("judge"), maxTurns: MAX_TURNS.judge, symbol: item.symbol, now,
  });
  cost += judgeRun.costUsd;
  if (!judgeRun.output) return fail(`judge failed: ${judgeRun.error}`);

  const j = judgeRun.output;
  const rejected = guardrail({ verdict: j.verdict, invalidation: j.invalidation, catalysts: j.catalysts, strategy: item.strategy }, day, { sharesHeld: ctx.held.shares });
  const warning = priceWarning(j, ctx.quote?.price ?? null);
  return {
    outcome: "done",
    thesis: insertThesis(day, {
      ...base, ...j, status: rejected ? "rejected" : "ok", statusReason: [rejected, warning].filter(Boolean).join("; ") || null, costUsd: cost, models: { ...base.models, judge: judgeModel() },
    }),
  };
}

export const analysisTarget = (i: QueueItem): AnalysisTarget => ({ symbol: i.symbol, strategy: i.strategy, contract: i.contract, ideaId: i.ideaId, kind: i.kind });
