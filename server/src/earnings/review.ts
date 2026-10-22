import { z } from "zod";
import { capUsd, MAX_TURNS, model, agentsEnabled } from "../agents/config.js";
import { loadPrompt } from "../agents/prompts.js";
import { availableUsd, runAgent } from "../agents/runtime.js";
import { nyClock } from "../history/scheduler.js";
import type { EarningsReview, EarningsSetup, Horizon } from "./contracts.js";
import { earningsDb } from "./db.js";
import { setupFor } from "./score.js";

// The earnings agent: adds news, macro and judgement to a precomputed setup. Runs through the Phase 2 runtime
// (runAgent: SDK, daily budget guard, agent_runs rows). The queue is its own small table in earnings.db because the
// Phase 2 queue is keyed on (symbol, strategy, contract) and these items are (symbol, horizon, report date).

export const MAX_ADJUSTMENT = 15;
export const REVIEW_TOOLS = ["earnings_setup", "market_news", "macro", "quote", "transcripts", "search_transcripts"];

earningsDb.exec(`
CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon TEXT NOT NULL,
  report_date TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | dropped
  queued_at TEXT NOT NULL,
  UNIQUE (day, symbol, horizon, report_date)
);
`);

// ---- agent output ----

const evidence = z.object({ claim: z.string().min(1), source: z.string().min(1), asOf: z.string().nullable() });
export const reviewOutput = z.object({
  adjustment: z.number(),
  verdict: z.enum(["act", "wait", "pass"]),
  newsFactors: z.array(z.object({ factor: z.string().min(1), direction: z.enum(["+", "-"]), evidence: z.array(evidence) })),
  entryConditions: z.array(z.string()),
  exitPlan: z.string().min(1),
  risks: z.array(z.string()),
  summary: z.string().min(1),
});
export type ReviewOutput = z.infer<typeof reviewOutput>;
const str = { type: "string" };
const evidenceJson = {
  type: "object",
  properties: { claim: str, source: { type: "string", description: "tool and section, e.g. market_news" }, asOf: { type: ["string", "null"] } },
  required: ["claim", "source", "asOf"],
  additionalProperties: false,
};
export const reviewJson = {
  type: "object",
  properties: {
    adjustment: { type: "number", minimum: -MAX_ADJUSTMENT, maximum: MAX_ADJUSTMENT },
    verdict: { enum: ["act", "wait", "pass"] },
    newsFactors: { type: "array", items: { type: "object", properties: { factor: str, direction: { enum: ["+", "-"] }, evidence: { type: "array", items: evidenceJson } }, required: ["factor", "direction", "evidence"], additionalProperties: false } },
    entryConditions: { type: "array", items: str },
    exitPlan: str,
    risks: { type: "array", items: str },
    summary: str,
  },
  required: ["adjustment", "verdict", "newsFactors", "entryConditions", "exitPlan", "risks", "summary"],
  additionalProperties: false,
};

// ---- guardrail (in code, not the model) ----

/** Turns the agent output into the stored review fields; the base score and every setup number are never touched. */
export function finalize(setup: EarningsSetup, out: ReviewOutput): Pick<EarningsReview, "status" | "statusReason" | "adjustment" | "adjustedScore" | "verdict"> {
  const rejected = (reason: string) => ({ status: "error" as const, statusReason: reason, adjustment: null, adjustedScore: null, verdict: out.verdict });
  if (Math.abs(out.adjustment) > MAX_ADJUSTMENT) return rejected(`adjustment ${out.adjustment} is outside +-${MAX_ADJUSTMENT}`);
  if (out.adjustment !== 0 && !out.newsFactors.some((f) => f.evidence.length > 0)) return rejected("a non-zero adjustment needs a news factor with evidence");
  if (out.verdict === "act" && setup.gates.some((g) => !g.passed)) return rejected(`verdict act on a setup that failed gate ${setup.gates.filter((g) => !g.passed).map((g) => g.key).join(", ")}`);
  const adjustedScore = Math.min(100, Math.max(0, setup.score + out.adjustment));
  return { status: "ok", statusReason: null, adjustment: out.adjustment, adjustedScore, verdict: out.verdict };
}

// ---- storage ----

const toReview = (r: any): EarningsReview => ({
  id: r.id, symbol: r.symbol, horizon: r.horizon, reportDate: r.report_date, asOf: r.as_of, status: r.status, statusReason: r.status_reason,
  baseScore: r.base_score, adjustedScore: r.adjusted_score, adjustment: r.adjustment, verdict: r.verdict,
  newsFactors: JSON.parse(r.news_factors ?? "[]"), entryConditions: JSON.parse(r.entry_conditions ?? "[]"), exitPlan: r.exit_plan,
  risks: JSON.parse(r.risks ?? "[]"), summary: r.summary, costUsd: r.cost_usd, model: r.model,
});

export function insertReview(setup: EarningsSetup, out: ReviewOutput | null, fin: ReturnType<typeof finalize> | { status: "error"; statusReason: string }, costUsd: number, modelName: string | null, now = new Date()): EarningsReview {
  const f = fin as Partial<ReturnType<typeof finalize>> & { status: "ok" | "error"; statusReason: string | null };
  const info = earningsDb
    .prepare(
      `INSERT INTO reviews (symbol, horizon, report_date, as_of, status, status_reason, base_score, adjusted_score, adjustment, verdict, news_factors, entry_conditions, exit_plan, risks, summary, cost_usd, model)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      setup.symbol, setup.horizon, setup.upcoming.reportDate, now.toISOString(), f.status, f.statusReason ?? null, setup.score, f.adjustedScore ?? null, f.adjustment ?? null,
      f.verdict ?? null, JSON.stringify(out?.newsFactors ?? []), JSON.stringify(out?.entryConditions ?? []), out?.exitPlan ?? null, JSON.stringify(out?.risks ?? []), out?.summary ?? null, costUsd, modelName
    );
  return toReview(earningsDb.prepare("SELECT * FROM reviews WHERE id = ?").get(info.lastInsertRowid));
}

export type ReviewQuery = { reportDate?: string; from?: string; to?: string; horizon?: Horizon; symbol?: string; limit?: number };
export function listReviews(q: ReviewQuery): EarningsReview[] {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (q.reportDate) { where.push("report_date = @reportDate"); args.reportDate = q.reportDate; }
  if (q.from) { where.push("report_date >= @from"); args.from = q.from; }
  if (q.to) { where.push("report_date <= @to"); args.to = q.to; }
  if (q.horizon) { where.push("horizon = @horizon"); args.horizon = q.horizon; }
  if (q.symbol) { where.push("symbol = @symbol"); args.symbol = q.symbol.toUpperCase(); }
  const sql = `SELECT * FROM reviews ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC ${q.limit ? "LIMIT " + Math.floor(q.limit) : ""}`;
  return (earningsDb.prepare(sql).all(args) as any[]).map(toReview);
}

// ---- queueing ----

export type QueueResult = { queued: number; wouldQueue?: number; skipped: number; estimatedCostUsd: number; fitsToday: number };

export const reviewCapUsd = (): number => capUsd("earnings");
const round = (x: number) => Math.round(x * 10000) / 10000;

/** How many reviews today's remaining budget can start. */
export function fitsToday(now = new Date()): number {
  const cap = reviewCapUsd();
  return cap > 0 ? Math.max(0, Math.floor((availableUsd("earnings", now) + 1e-9) / cap)) : 0;
}

/**
 * Queues one review per setup. Deduped per (symbol, horizon, report date, NY day): a setup already queued, running or
 * reviewed today is skipped. With dryRun nothing is written. Items beyond today's budget wait in the queue for it.
 */
export function queueReviews(horizon: Horizon, setups: EarningsSetup[], opts: { dryRun?: boolean; now?: Date } = {}): QueueResult {
  const now = opts.now ?? new Date();
  const day = nyClock(now).date;
  const exists = earningsDb.prepare("SELECT 1 FROM review_queue WHERE day = ? AND symbol = ? AND horizon = ? AND report_date = ? AND status != 'dropped'");
  const reviewed = earningsDb.prepare("SELECT 1 FROM reviews WHERE symbol = ? AND horizon = ? AND report_date = ? AND substr(as_of, 1, 10) = ? AND status = 'ok'");
  const insert = earningsDb.prepare("INSERT INTO review_queue (day, symbol, horizon, report_date, score, queued_at) VALUES (?,?,?,?,?,?) ON CONFLICT (day, symbol, horizon, report_date) DO UPDATE SET status = 'queued', score = excluded.score WHERE status = 'dropped'");
  let n = 0;
  let skipped = 0;
  const run = () => {
    for (const s of setups) {
      if (exists.get(day, s.symbol, horizon, s.upcoming.reportDate) || reviewed.get(s.symbol, horizon, s.upcoming.reportDate, day)) {
        skipped++;
        continue;
      }
      n++;
      if (!opts.dryRun) insert.run(day, s.symbol, horizon, s.upcoming.reportDate, s.score, now.toISOString());
    }
  };
  if (opts.dryRun) run();
  else earningsDb.transaction(run)();
  const fits = fitsToday(now);
  return { queued: opts.dryRun ? 0 : n, ...(opts.dryRun ? { wouldQueue: n } : {}), skipped, estimatedCostUsd: round(n * reviewCapUsd()), fitsToday: fits };
}

// ---- worker ----

let draining = false;
export const pendingReviews = (): number => (earningsDb.prepare("SELECT COUNT(*) AS n FROM review_queue WHERE status IN ('queued','running')").get() as { n: number }).n;

function prompt(setup: EarningsSetup, now: Date): string {
  return (
    `Review this ${setup.horizon} earnings setup for ${setup.symbol}. Now: ${now.toISOString()} (New York date ${nyClock(now).date}). ` +
    `Report date ${setup.upcoming.reportDate} (${setup.upcoming.time ?? "time unknown"}); base score ${setup.score}, verdict ${setup.verdict}. ` +
    `All numbers below were computed by the system and must not be changed.\n\nSETUP:\n${JSON.stringify(setup)}`
  );
}

/** Reviews one setup now (shared by the worker and tests). */
export async function reviewSetup(setup: EarningsSetup, now = new Date()): Promise<{ review: EarningsReview | null; skipped?: "budget" }> {
  const r = await runAgent({
    agent: "earnings",
    model: model(),
    system: loadPrompt("earnings"),
    prompt: prompt(setup, now),
    schema: reviewOutput,
    jsonSchema: reviewJson,
    tools: REVIEW_TOOLS,
    maxBudgetUsd: reviewCapUsd(),
    maxTurns: MAX_TURNS.earnings,
    symbol: setup.symbol,
    now,
  });
  if (r.status === "skipped") return { review: null, skipped: "budget" };
  if (!r.ok || !r.output) return { review: insertReview(setup, null, { status: "error", statusReason: r.error ?? "no output" }, r.costUsd, model(), now) };
  return { review: insertReview(setup, r.output, finalize(setup, r.output), r.costUsd, model(), now) };
}

/** Works through the queue, highest base score first, while the budget lasts. Items whose report date has passed are dropped. */
export async function drainReviews(now = () => new Date()): Promise<void> {
  if (draining || !agentsEnabled()) return;
  draining = true;
  try {
    for (;;) {
      const t = now();
      const today = nyClock(t).date;
      earningsDb.prepare("UPDATE review_queue SET status = 'dropped' WHERE status = 'queued' AND report_date < ?").run(today);
      if (fitsToday(t) < 1) return;
      const item = earningsDb.prepare("SELECT * FROM review_queue WHERE status = 'queued' ORDER BY score DESC, id LIMIT 1").get() as { id: number; symbol: string; horizon: Horizon } | undefined;
      if (!item) return;
      earningsDb.prepare("UPDATE review_queue SET status = 'running' WHERE id = ?").run(item.id);
      try {
        const setup = await setupFor(item.symbol, item.horizon, { now: t });
        if (!setup) {
          earningsDb.prepare("UPDATE review_queue SET status = 'dropped' WHERE id = ?").run(item.id);
          continue;
        }
        const r = await reviewSetup(setup, t);
        if (r.skipped) {
          earningsDb.prepare("UPDATE review_queue SET status = 'queued' WHERE id = ?").run(item.id);
          return;
        }
        earningsDb.prepare("UPDATE review_queue SET status = 'done' WHERE id = ?").run(item.id);
      } catch (err) {
        console.error(`[earnings] review of ${item.symbol} failed:`, err);
        earningsDb.prepare("UPDATE review_queue SET status = 'done' WHERE id = ?").run(item.id);
      }
    }
  } finally {
    draining = false;
  }
}

/** Retries waiting items every minute (budget frees up the next day). OPS wires this next to startAgents. */
export function startReviewWorker(): { stop: () => void } {
  const timer = setInterval(() => void drainReviews(), 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
