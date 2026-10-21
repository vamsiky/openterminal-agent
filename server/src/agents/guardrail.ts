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
