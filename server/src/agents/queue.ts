import { db } from "../db.js";
import { addDays } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import { heldSymbols } from "../quant/positions.js";
import type { ThesisStrategy } from "./contracts.js";

// The analysis queue, in memory-fast SQLite so it survives restarts. One row
// per (day, symbol, strategy, key contract); automatic option items key on (symbol, strategy, day) only. Order: manual requests, then held
// symbols, then idea rank.

export type QueueItem = {
  id: number; day: string; symbol: string; strategy: ThesisStrategy; contract: string | null; ideaId: number | null;
  kind: "stock" | "option"; reason: string; rank: number; manual: boolean; queuedAt: string;
};

const toItem = (r: any): QueueItem => ({
  id: r.id, day: r.day, symbol: r.symbol, strategy: r.strategy, contract: r.item_contract || null, ideaId: r.idea_id, kind: r.kind,
  reason: r.reason, rank: r.rank, manual: r.manual === 1, queuedAt: r.queued_at,
});

export type EnqueueInput = { symbol: string; strategy: ThesisStrategy; contract?: string | null; ideaId?: number | null; kind: "stock" | "option"; reason: string; rank?: number };

/**
 * Adds an item. Automatic items are deduped per day: by (symbol, strategy) for options, since the idea's contract
 * re-centres as the price moves (the thesis still records the contract analysed), and by (symbol, strategy) for stocks.
 * A row already queued, running or done today stops them. Manual items (the user's Analyse button) are per contract and
 * skip the per-day dedupe: one already queued is promoted to the front (ahead of automatic items, in request order);
 * only one running right now refuses it.
 * Returns the item's position (1 = next) or null when refused.
 */
export function enqueue(input: EnqueueInput, opts: { manual?: boolean; now?: Date } = {}): { position: number } | null {
  const now = opts.now ?? new Date();
  const day = nyClock(now).date;
  const real = input.contract ?? "";
  const manual = opts.manual ? 1 : 0;
  const key = manual ? real : "";
  if (manual) {
    // A manual request promotes the same item when it is already queued (automatic or not); only a running one refuses it.
    const row = db.prepare("SELECT id, status FROM agent_queue WHERE symbol = ? AND strategy = ? AND item_contract = ? AND status IN ('queued','running') ORDER BY id DESC").get(input.symbol, input.strategy, real) as { id: number; status: string } | undefined;
    if (row?.status === "running") return null;
    if (row) {
      db.prepare("UPDATE agent_queue SET manual = 1, reason = ?, queued_at = ? WHERE id = ?").run(input.reason, now.toISOString(), row.id);
      return { position: pending().findIndex((i) => i.id === row.id) + 1 };
    }
  }
  const active = manual
    ? undefined
    : db.prepare("SELECT id, status FROM agent_queue WHERE symbol = ? AND strategy = ? AND status IN ('queued','running') ORDER BY id DESC").get(input.symbol, input.strategy);
  if (active) {
    // A queued automatic item follows the idea's current contract.
    if ((active as { status: string }).status === "queued") db.prepare("UPDATE agent_queue SET item_contract = ? WHERE id = ?").run(real, (active as { id: number }).id);
    return null;
  }
  const today = db.prepare("SELECT id, status FROM agent_queue WHERE day = ? AND symbol = ? AND strategy = ? AND contract = ?").get(day, input.symbol, input.strategy, key) as { id: number; status: string } | undefined;
  if (today && !manual) return null;
  const fields = { reason: input.reason, rank: input.rank ?? 1000, idea: input.ideaId ?? null, kind: input.kind, manual, at: now.toISOString(), real };
  if (today) {
    db.prepare("UPDATE agent_queue SET status = 'queued', reason = @reason, rank = @rank, idea_id = @idea, kind = @kind, manual = @manual, item_contract = @real, skipped_day = NULL, queued_at = @at WHERE id = @id").run({ ...fields, id: today.id });
  } else {
    db.prepare(
      `INSERT INTO agent_queue (day, symbol, strategy, contract, item_contract, idea_id, kind, reason, rank, manual, status, queued_at)
       VALUES (@day, @symbol, @strategy, @key, @real, @idea, @kind, @reason, @rank, @manual, 'queued', @at)`
    ).run({ ...fields, day, symbol: input.symbol, strategy: input.strategy, key });
  }
  const id = (db.prepare("SELECT id FROM agent_queue WHERE day = ? AND symbol = ? AND strategy = ? AND contract = ?").get(day, input.symbol, input.strategy, key) as { id: number }).id;
  return { position: pending().findIndex((i) => i.id === id) + 1 };
}

/** Queued items in processing order. */
export function pending(): QueueItem[] {
  const held = new Set(heldSymbols());
  return (db.prepare("SELECT * FROM agent_queue WHERE status = 'queued'").all() as any[])
    .map(toItem)
    .sort((a, b) => Number(b.manual) - Number(a.manual) || (a.manual && b.manual ? a.queuedAt.localeCompare(b.queuedAt) : 0) || Number(held.has(b.symbol)) - Number(held.has(a.symbol)) || a.rank - b.rank || a.id - b.id);
}

export function running(): QueueItem[] {
  return (db.prepare("SELECT * FROM agent_queue WHERE status = 'running' ORDER BY id").all() as any[]).map(toItem);
}

export const isRunning = (symbol: string, strategy: ThesisStrategy, contract: string | null): boolean =>
  db.prepare("SELECT 1 FROM agent_queue WHERE symbol = ? AND strategy = ? AND item_contract = ? AND status = 'running'").get(symbol, strategy, contract ?? "") !== undefined;
export const isBusy = (symbol: string, strategy: ThesisStrategy, contract: string | null): boolean =>
  db.prepare("SELECT 1 FROM agent_queue WHERE symbol = ? AND strategy = ? AND item_contract = ? AND status IN ('queued','running')").get(symbol, strategy, contract ?? "") !== undefined;

export const markRunning = (id: number): void => void db.prepare("UPDATE agent_queue SET status = 'running' WHERE id = ?").run(id);
export const markDone = (id: number): void => void db.prepare("UPDATE agent_queue SET status = 'done' WHERE id = ?").run(id);
export const markDropped = (id: number): void => void db.prepare("UPDATE agent_queue SET status = 'dropped' WHERE id = ?").run(id);
export const requeue = (id: number): void => void db.prepare("UPDATE agent_queue SET status = 'queued' WHERE id = ?").run(id);

/** Records, once per item and day, that the budget kept it waiting; returns true the first time. */
export function noteBudgetSkip(id: number, day: string): boolean {
  return db.prepare("UPDATE agent_queue SET skipped_day = ? WHERE id = ? AND (skipped_day IS NULL OR skipped_day != ?)").run(day, id, day).changes > 0;
}

/** Queued items older than three days are dropped: their ideas have long since moved on. */
export function pruneStale(now = new Date()): number {
  const cutoff = addDays(nyClock(now).date, -3);
  return db.prepare("UPDATE agent_queue SET status = 'dropped' WHERE status = 'queued' AND day < ? AND manual = 0").run(cutoff).changes;
}
