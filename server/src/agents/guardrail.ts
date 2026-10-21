import type { Thesis } from "./contracts.js";

export type GuardrailInput = Pick<Thesis, "verdict" | "invalidation" | "catalysts" | "strategy">;

/**
 * The rules the model does not get to waive, applied to a verdict of "act" only (wait and pass are never rejected).
 * Returns the reason the thesis is rejected, or null.
 */
export function guardrail(t: GuardrailInput, day: string, opts: { sharesHeld?: number } = {}): string | null {
  if (t.verdict !== "act") return null;
  const inv = t.invalidation;
  if (!inv || (inv.price === null && !inv.condition.trim())) return "act without an invalidation (a price or a condition)";
  if (!t.catalysts.some((c) => c.date !== null && /^\d{4}-\d{2}-\d{2}/.test(c.date) && c.date.slice(0, 10) >= day)) {
    return "act without a dated catalyst on or after the thesis day";
  }
  if (t.strategy === "covered_call" && (opts.sharesHeld ?? 0) < 100) return "covered call without at least 100 shares held";
  return null;
}

export const PRICE_DISTANCE_WARN = 0.5;

/**
 * Sanity check on the judge's prices: entry, target and invalidation more than 50% away from the current price are
 * flagged (a typo, a unit slip or an invented level). Returns a warning, or null; it never rejects.
 */
export function priceWarning(t: { entry: { low: number | null; high: number | null } | null; target: { price: number | null } | null; invalidation: { price: number | null } | null }, price: number | null): string | null {
  if (price === null || !(price > 0)) return null;
  const far = (label: string, v: number | null | undefined) => (typeof v === "number" && Math.abs(v / price - 1) > PRICE_DISTANCE_WARN ? [`${label} ${v}`] : []);
  const hits = [...far("entry low", t.entry?.low), ...far("entry high", t.entry?.high), ...far("target", t.target?.price), ...far("invalidation", t.invalidation?.price)];
  return hits.length ? `warning: ${hits.join(", ")} more than 50% from the current price ${price}` : null;
}
