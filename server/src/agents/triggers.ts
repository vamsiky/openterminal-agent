import { addDays } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import { listIdeas } from "../quant/ideas.js";
import type { Idea } from "../scan/contracts.js";
import { enqueue } from "./queue.js";
import { latestThesisForStrategy, latestThesisFor } from "./store.js";

export const STOCK_THESIS_DAYS = 7;
export const SCORE_MOVE = 10;

/** Why an idea needs analysing now, or null: no usable thesis in the window, or its score moved 10+ points since. */
export function needsAnalysis(idea: Idea, now: Date): string | null {
  const day = nyClock(now).date;
  // Option ideas re-centre their contract as the price moves, so any contract's thesis of the day counts.
  const last = idea.kind === "option" ? latestThesisForStrategy(idea.symbol, idea.strategy) : latestThesisFor(idea.symbol, idea.strategy, idea.contract);
  // A thesis that errored does not count: the idea is tried again (the queue's per-day dedupe stops loops).
  if (!last || last.status === "error") return last ? "last analysis failed" : "no thesis yet";
  const thesisDay = last.asOf.slice(0, 10);
  const fresh = idea.kind === "stock" ? thesisDay > addDays(day, -STOCK_THESIS_DAYS) : thesisDay === day;
  const moved = last.inputs.ideaScore !== null ? Math.abs(idea.score - last.inputs.ideaScore) : 0;
  if (moved >= SCORE_MOVE) return `score moved ${Math.round(moved)} points since the last thesis`;
  return fresh ? null : idea.kind === "stock" ? `no thesis in ${STOCK_THESIS_DAYS} days` : "no thesis today";
}

/** Queues every active idea that needs analysing; returns how many were added. Ideas come in rank order. */
export function scanIdeas(now = new Date()): number {
  let added = 0;
  for (const kind of ["stock", "option"] as const) {
    for (const idea of listIdeas({ kind, limit: 100 })) {
      const reason = needsAnalysis(idea, now);
      if (!reason) continue;
      const r = enqueue({ symbol: idea.symbol, strategy: idea.strategy === "buy" ? "buy" : idea.strategy, contract: idea.contract, ideaId: idea.id, kind, reason, rank: idea.rank }, { now });
      if (r && !r.existing) added++;
    }
  }
  return added;
}
