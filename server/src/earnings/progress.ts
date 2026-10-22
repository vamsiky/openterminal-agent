import type Database from "better-sqlite3";
import type { EarningsStatus } from "./contracts.js";

// Backfill phase markers, kept in backfill_progress next to the per-symbol rows:
//   task "run",   symbol "all"      detail {universe}   updated_at = when the run started
//   task "phase", symbol <phase>    status running|done  detail {universe}   updated_at = when the phase started / finished
// /status reads the markers, not the counts. The universe (listed names) changes daily, so a
// per-task count can legitimately differ by a few symbols between phases; that must never make a
// finished backfill look unfinished. Names that list after a run are covered by the nightly job
// (jobs.ts), not by re-running the backfill.

export const PHASES = ["events", "stock", "options"] as const;
export type BackfillPhase = (typeof PHASES)[number];
type Backfill = EarningsStatus["backfill"];
export type PhaseSummary = Backfill["phases"][BackfillPhase];

const now = () => new Date().toISOString();

/** Starts a full run: remembers the universe size and when the run began. */
export function markRunStart(d: Database.Database, universe: number): void {
  d.prepare(
    `INSERT INTO backfill_progress (task, symbol, status, detail, updated_at) VALUES ('run', 'all', 'done', ?, ?)
     ON CONFLICT (task, symbol) DO UPDATE SET status = 'done', detail = excluded.detail, updated_at = excluded.updated_at`
  ).run(JSON.stringify({ universe }), now());
}

export function markPhaseStart(d: Database.Database, phase: BackfillPhase, universe: number): void {
  d.prepare(
    `INSERT INTO backfill_progress (task, symbol, status, detail, updated_at) VALUES ('phase', ?, 'running', ?, ?)
     ON CONFLICT (task, symbol) DO UPDATE SET status = 'running', detail = excluded.detail, updated_at = excluded.updated_at`
  ).run(phase, JSON.stringify({ universe }), now());
}

export function markPhaseDone(d: Database.Database, phase: BackfillPhase, at = now()): void {
  d.prepare("UPDATE backfill_progress SET status = 'done', updated_at = ? WHERE task = 'phase' AND symbol = ?").run(at, phase);
}

type Counts = { done: number; errors: number; first: string | null; last: string | null };
function counts(d: Database.Database): Map<string, Counts> {
  const rows = d
    .prepare("SELECT task, SUM(status = 'done') AS done, SUM(status = 'error') AS errors, MIN(updated_at) AS first, MAX(updated_at) AS last FROM backfill_progress WHERE task IN ('events','stock','options') GROUP BY task")
    .all() as Array<{ task: string; done: number; errors: number; first: string; last: string }>;
  return new Map(rows.map((r) => [r.task, { done: r.done ?? 0, errors: r.errors ?? 0, first: r.first, last: r.last }]));
}

/** A task at 99% or more of the largest count counts as complete (the universe drifts by a few names a day). */
const COMPLETE = 0.99;

/** For databases with no markers: every task at 99% of the largest count and no error rows is done. */
export function legacyPhase(c: Map<string, Counts>): Backfill["phase"] {
  const target = Math.max(0, ...PHASES.map((t) => c.get(t)?.done ?? 0));
  if (target === 0) return "idle";
  const open = PHASES.find((t) => (c.get(t)?.done ?? 0) < target * COMPLETE);
  if (open) {
    // The events pass sets the target itself, so it looks finished while it runs: treat a pass still writing as running.
    const ev = c.get("events");
    if (open !== "events" && ev && !c.has("stock") && Date.now() - Date.parse(ev.last ?? "") < 120_000) return "events";
    return open;
  }
  return PHASES.find((t) => (c.get(t)?.errors ?? 0) > 0) ?? "done";
}

/** The backfill state for /status: phase, per-phase {done, total, finishedAt}. */
export function backfillState(d: Database.Database): { phase: Backfill["phase"]; phases: Backfill["phases"] } {
  const c = counts(d);
  const markers = new Map((d.prepare("SELECT symbol, status, detail, updated_at FROM backfill_progress WHERE task = 'phase'").all() as Array<{ symbol: string; status: string; detail: string | null; updated_at: string }>).map((m) => [m.symbol, m]));
  const run = d.prepare("SELECT detail, updated_at FROM backfill_progress WHERE task = 'run'").get() as { detail: string | null; updated_at: string } | undefined;
  const universe = (detail: string | null | undefined): number => {
    try { return (JSON.parse(detail ?? "{}") as { universe?: number }).universe ?? 0; } catch { return 0; }
  };
  const phases = Object.fromEntries(
    PHASES.map((t) => {
      const m = markers.get(t);
      const done = c.get(t)?.done ?? 0;
      const finished = m?.status === "done" && (!run || m.updated_at >= run.updated_at);
      return [t, { done, total: Math.max(universe(m?.detail) || universe(run?.detail), done), finishedAt: finished ? m!.updated_at : null }];
    })
  ) as Backfill["phases"];

  if (markers.size === 0 && !run) return { phase: legacyPhase(c), phases };
  const running = PHASES.find((t) => markers.get(t)?.status === "running");
  if (running) return { phase: running, phases };
  const open = PHASES.find((t) => !phases[t].finishedAt);
  return { phase: open ?? "done", phases };
}

/**
 * One-off for a database whose backfill finished before markers existed (--mark-complete): verifies that
 * every task has at least 99% of the largest done count and no error rows, then writes the markers.
 * Throws with the reason when it does not hold.
 */
export function markComplete(d: Database.Database): { universe: number; phases: Record<BackfillPhase, number> } {
  const c = counts(d);
  const target = Math.max(0, ...PHASES.map((t) => c.get(t)?.done ?? 0));
  if (target === 0) throw new Error("no backfill progress rows to mark complete");
  for (const t of PHASES) {
    const n = c.get(t)?.done ?? 0;
    if (n < target * COMPLETE) throw new Error(`${t} has ${n} of ${target} symbols done (needs at least 99%); finish the backfill first`);
    if ((c.get(t)?.errors ?? 0) > 0) throw new Error(`${t} has ${c.get(t)!.errors} error rows; re-run --phase ${t} first`);
  }
  const start = [...c.values()].map((x) => x.first!).sort()[0];
  const put = d.prepare(
    `INSERT INTO backfill_progress (task, symbol, status, detail, updated_at) VALUES (?, ?, 'done', ?, ?)
     ON CONFLICT (task, symbol) DO UPDATE SET status = 'done', detail = excluded.detail, updated_at = excluded.updated_at`
  );
  d.transaction(() => {
    put.run("run", "all", JSON.stringify({ universe: target, markedComplete: true }), start);
    for (const t of PHASES) put.run("phase", t, JSON.stringify({ universe: target, markedComplete: true }), c.get(t)!.last);
  })();
  return { universe: target, phases: Object.fromEntries(PHASES.map((t) => [t, c.get(t)!.done])) as Record<BackfillPhase, number> };
}
