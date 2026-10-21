import { nyClock } from "../history/scheduler.js";
import { ensureCalendar, isTradingDay } from "../providers/alpaca-calendar.js";
import { analysisTarget, analyze, findIdea } from "./analysis.js";
import { type PendingAnalysis, runBrief } from "./brief.js";
import { agentsEnabled, analysisCapUsd, capUsd, dailyBudgetUsd, model } from "./config.js";
import type { AgentName, AgentsStatus, MacroReport } from "./contracts.js";
import { runMacro } from "./macro.js";
import * as queue from "./queue.js";
import { availableUsd, canAfford, runningRuns } from "./runtime.js";
import { attemptedOn, failedRunsOn, hasBrief, hasMacro, insertRun, latestBrief, latestMacro, listRuns, runCountOn, skippedOn, spentOn } from "./store.js";
import { scanIdeas } from "./triggers.js";

// Schedule, triggers and the queue worker. All times are New York time on
// trading days. Everything is idempotent per tick: state lives in the tables.

const TICK_MS = 30_000;
const POLL_IDEAS_MS = 60_000;
const BRIEF_WAIT_MIN = 10;
const minutes = (hour: number, minute: number) => hour * 60 + minute;
const nyMinutes = (now: Date): number => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return minutes(Number(parts.find((p) => p.type === "hour")!.value), Number(parts.find((p) => p.type === "minute")!.value));
};

let started = false;
const inflight = new Set<string>();
let draining = false;
let lastIdeaPoll = 0;

// ---- manual and scheduled runs ----

export type StartResult = "started" | "busy" | "budget" | "disabled";

/** Starts a macro or brief run in the background (also used by the schedule). */
export function startRun(agent: "macro" | "brief", opts: { session?: MacroReport["session"]; now?: Date; waitedOut?: boolean } = {}): StartResult {
  if (!agentsEnabled()) return "disabled";
  if (inflight.has(agent)) return "busy";
  const now = opts.now ?? new Date();
  if (!canAfford(agent, capUsd(agent), now)) return "budget";
  inflight.add(agent);
  void (async () => {
    try {
      if (agent === "macro") {
        const r = await runMacro(opts.session ?? "adhoc", now);
        if (!r.ok) console.error("[agents] macro failed:", r.error);
      } else {
        const r = await runBrief(now, pendingAnalyses());
        if (!r.ok) console.error("[agents] brief failed:", r.error);
      }
    } catch (err) {
      console.error(`[agents] ${agent} crashed:`, err);
    } finally {
      inflight.delete(agent);
    }
  })();
  return "started";
}

export function pendingAnalyses(): PendingAnalysis[] {
  return [
    ...queue.running().map((i) => ({ symbol: i.symbol, strategy: i.strategy, state: "running" as const })),
    ...queue.pending().map((i) => ({ symbol: i.symbol, strategy: i.strategy, state: "queued" as const })),
  ];
}

/** Queues a user-requested analysis, or promotes the same queued item to the front. "busy" only when it is running; "budget" when no room. */
export function requestAnalysis(input: { symbol: string; strategy: import("./contracts.js").ThesisStrategy; contract?: string | null; ideaId?: number | null }): { position: number } | "busy" | "budget" | "disabled" {
  if (!agentsEnabled()) return "disabled";
  const contract = input.contract ?? null;
  if (queue.isRunning(input.symbol, input.strategy, contract)) return "busy";
  if (!canAfford("bull", analysisCapUsd())) return "budget";
  const kind = input.strategy === "buy" ? "stock" : "option";
  const idea = findIdea({ symbol: input.symbol, strategy: input.strategy, contract, ideaId: input.ideaId ?? null });
  const r = queue.enqueue({ symbol: input.symbol, strategy: input.strategy, contract, ideaId: idea?.id ?? input.ideaId ?? null, kind, reason: "requested", rank: idea?.rank ?? 0 }, { manual: true });
  if (!r) return "busy";
  setImmediate(() => void drain());
  return r;
}

// ---- queue worker ----

/** Stock ideas wait for the evening (after the 16:30 screen) or the 06:40 pre-market window; options and manual requests go at once. */
export function stockWindowOpen(now: Date): boolean {
  if (!isTradingDay(nyClock(now).date)) return false;
  const m = nyMinutes(now);
  return m >= minutes(16, 35) || (m >= minutes(6, 40) && m < minutes(9, 30));
}

const eligible = (i: queue.QueueItem, now: Date) => i.manual || i.kind === "option" || stockWindowOpen(now);

export async function drain(now = () => new Date()): Promise<void> {
  if (draining || !agentsEnabled()) return;
  draining = true;
  try {
    queue.pruneStale(now());
    for (;;) {
      const t = now();
      const day = nyClock(t).date;
      const item = queue.pending().find((i) => eligible(i, t));
      if (!item) return;
      if (!canAfford("bull", analysisCapUsd(), t)) {
        // Waits for the next day (or for the brief's floor to release); counted once per item and day.
        if (queue.noteBudgetSkip(item.id, day)) insertRun({ day, agent: "bull", symbol: item.symbol, model: "-", status: "skipped", error: "budget_exhausted", now: t });
        return;
      }
      if (!item.manual && item.ideaId !== null && findIdea({ ...item })?.status !== "active") {
        queue.markDropped(item.id);
        continue;
      }
      queue.markRunning(item.id);
      try {
        const r = await analyze(analysisTarget(item), t);
        if (r.outcome === "budget") queue.requeue(item.id);
        else queue.markDone(item.id);
        if (r.outcome === "budget") return;
      } catch (err) {
        console.error(`[agents] analysis of ${item.symbol} failed:`, err);
        queue.markDone(item.id);
      }
    }
  } finally {
    draining = false;
  }
}

// ---- schedule ----

export function schedulerTick(now: Date): void {
  const ny = nyClock(now);
  const day = ny.date;
  if (!isTradingDay(day)) return;
  const m = nyMinutes(now);

  if (m >= minutes(6, 30) && m < minutes(12, 0) && !hasMacro(day, "pre") && failedRunsOn(day, "macro") < 3) startRun("macro", { session: "pre", now });
  if (m >= minutes(16, 20) && !hasMacro(day, "post") && failedRunsOn(day, "macro") < 3) startRun("macro", { session: "post", now });

  if (m >= minutes(7, 0) && m < minutes(12, 0) && !hasBrief(day) && !attemptedOn(day, "brief") && !inflight.has("brief") && !inflight.has("macro")) {
    // Stock analyses from the 06:40 window get up to ten minutes to finish; the brief then lists what is still pending.
    const waiting = canAfford("bull", analysisCapUsd(), now) && queue.pending().concat(queue.running()).some((i) => i.kind === "stock");
    if (!waiting || m >= minutes(7, BRIEF_WAIT_MIN)) {
      // No budget left: record the skip so it is counted and the brief's reserve is released.
      if (startRun("brief", { now }) === "budget") insertRun({ day, agent: "brief", symbol: null, model: model(), status: "skipped", error: "budget_exhausted", now });
    }
  }
}

export async function tick(now = new Date()): Promise<void> {
  try {
    await ensureCalendar(Number(nyClock(now).date.slice(0, 4)));
    schedulerTick(now);
    if (now.getTime() - lastIdeaPoll >= POLL_IDEAS_MS) {
      lastIdeaPoll = now.getTime();
      scanIdeas(now);
    }
    void drain();
  } catch (err) {
    console.error("[agents] tick failed:", err);
  }
}

/** Hook for the quant jobs: call after ideas-screen and option-scan so new ideas are queued at once. */
export function onIdeasUpdated(now = new Date()): void {
  if (!started || !agentsEnabled()) return;
  try {
    scanIdeas(now);
    lastIdeaPoll = now.getTime();
    void drain();
  } catch (err) {
    console.error("[agents] ideas hook failed:", err);
  }
}

export function startAgents(): { stop: () => void } | null {
  if (!agentsEnabled()) {
    console.log("[agents] AGENTS_ENABLED=0; agents disabled.");
    return null;
  }
  started = true;
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  setTimeout(() => void tick(), 20_000).unref();
  console.log(`[agents] enabled: macro 06:30 and 16:20 ET, stock analyses 06:40 and after the 16:30 screen, brief 07:00 ET; daily budget $${dailyBudgetUsd()}`);
  return {
    stop: () => {
      clearInterval(timer);
      started = false;
    },
  };
}

// ---- status ----

export type StatusExtras = { auth: "api_key" | "claude_login" | null; availableUsd: number };

export function status(now = new Date()): AgentsStatus & StatusExtras {
  const day = nyClock(now).date;
  const lastMacro = latestMacro();
  const lastBrief = latestBrief();
  const auth = (listRuns(20).find((r) => r.auth)?.auth ?? null) as StatusExtras["auth"];
  return {
    enabled: agentsEnabled(),
    today: { day, spentUsd: Math.round(spentOn(day) * 10000) / 10000, budgetUsd: dailyBudgetUsd(), runs: runCountOn(day), skippedForBudget: skippedOn(day) },
    queue: queue.pending().map((i) => ({ symbol: i.symbol, strategy: i.strategy, reason: i.reason, queuedAt: i.queuedAt })),
    running: runningRuns().map((r) => ({ agent: r.agent as AgentName, symbol: r.symbol, startedAt: r.startedAt })),
    lastMacro: lastMacro ? { id: lastMacro.id, asOf: lastMacro.asOf } : null,
    lastBrief: lastBrief ? { id: lastBrief.id, day: lastBrief.day } : null,
    auth,
    availableUsd: Math.round(availableUsd("macro", now) * 10000) / 10000,
  };
}
