import { db } from "../db.js";
import { addDays } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import { heldSymbols } from "../quant/positions.js";
import type { ThesisStrategy } from "./contracts.js";

// The analysis queue, in memory-fast SQLite so it survives restarts. One row
// per (day, symbol, strategy, contract). Order: manual requests, then held
// symbols, then idea rank.

export type QueueItem = {
  id: number; day: string; symbol: string; strategy: ThesisStrategy; contract: string | null; ideaId: number | null;
  kind: "stock" | "option"; reason: string; rank: number; manual: boolean; queuedAt: string;
};

const toItem = (r: any): QueueItem => ({
  id: r.id, day: r.day, symbol: r.symbol, strategy: r.strategy, contract: r.contract || null, ideaId: r.idea_id, kind: r.kind,
  reason: r.reason, rank: r.rank, manual: r.manual === 1, queuedAt: r.queued_at,
});

export type EnqueueInput = { symbol: string; strategy: ThesisStrategy; contract?: string | null; ideaId?: number | null; kind: "stock" | "option"; reason: string; rank?: number };

/**
 * Adds an item. Automatic items are deduped by (symbol, strategy, contract, day): a row already queued, running or
 * done today stops them. Manual items (the user's Analyse button) skip that dedupe and only refuse a row that is
 * queued or running right now. Returns the item's position (1 = next) or null when refused.
 */
export function enqueue(input: EnqueueInput, opts: { manual?: boolean; now?: Date } = {}): { position: number } | null {
  const now = opts.now ?? new Date();
  const day = nyClock(now).date;
  const contract = input.contract ?? "";
  const manual = opts.manual ? 1 : 0;
  const anyDay = db.prepare("SELECT id FROM agent_queue WHERE symbol = ? AND strategy = ? AND contract = ? AND status IN ('queued','running')").get(input.symbol, input.strategy, contract);
  if (anyDay) return null;
  const today = db.prepare("SELECT id, status FROM agent_queue WHERE day = ? AND symbol = ? AND strategy = ? AND contract = ?").get(day, input.symbol, input.strategy, contract) as { id: number; status: string } | undefined;
  if (today && !manual) return null;
  const fields = { reason: input.reason, rank: input.rank ?? 1000, idea: input.ideaId ?? null, kind: input.kind, manual, at: now.toISOString() };
  if (today) {
    db.prepare("UPDATE agent_queue SET status = 'queued', reason = @reason, rank = @rank, idea_id = @idea, kind = @kind, manual = @manual, skipped_day = NULL, queued_at = @at WHERE id = @id").run({ ...fields, id: today.id });
  } else {
    db.prepare(
      `INSERT INTO agent_queue (day, symbol, strategy, contract, idea_id, kind, reason, rank, manual, status, queued_at)
       VALUES (@day, @symbol, @strategy, @contract, @idea, @kind, @reason, @rank, @manual, 'queued', @at)`
    ).run({ ...fields, day, symbol: input.symbol, strategy: input.strategy, contract });
  }
  const id = (db.prepare("SELECT id FROM agent_queue WHERE day = ? AND symbol = ? AND strategy = ? AND contract = ?").get(day, input.symbol, input.strategy, contract) as { id: number }).id;
  return { position: pending().findIndex((i) => i.id === id) + 1 };
}

/** Queued items in processing order. */
export function pending(): QueueItem[] {
  const held = new Set(heldSymbols());
  return (db.prepare("SELECT * FROM agent_queue WHERE status = 'queued'").all() as any[])
    .map(toItem)
    .sort((a, b) => Number(b.manual) - Number(a.manual) || Number(held.has(b.symbol)) - Number(held.has(a.symbol)) || a.rank - b.rank || a.id - b.id);
}

export function running(): QueueItem[] {
  return (db.prepare("SELECT * FROM agent_queue WHERE status = 'running' ORDER BY id").all() as any[]).map(toItem);
}

export const isBusy = (symbol: string, strategy: ThesisStrategy, contract: string | null): boolean =>
  db.prepare("SELECT 1 FROM agent_queue WHERE symbol = ? AND strategy = ? AND contract = ? AND status IN ('queued','running')").get(symbol, strategy, contract ?? "") !== undefined;

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
