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

type Priced = { entry: { low: number | null; high: number | null } | null; target: { price: number | null } | null; invalidation: { price: number | null } | null };

/**
 * Sanity check on the judge's prices; it never rejects. Stock theses: entry, target and invalidation are underlying
 * prices, flagged when more than 50% from the current price. Option theses: invalidation is an underlying price (same
 * check), entry is a premium per share checked against the contract's current mid (more than 50% away), and target
 * is a premium, flagged only beyond 5x or under 0.05x of the mid (profit-takes legitimately sit far from it).
 * Without a price to compare with, that check is skipped.
 */
export function priceWarning(t: Priced, ref: { underlying: number | null; premium?: number | null; option?: boolean }): string | null {
  const hits: string[] = [];
  const far = (label: string, v: number | null | undefined, price: number | null | undefined, lo = 1 - PRICE_DISTANCE_WARN, hi = 1 + PRICE_DISTANCE_WARN) => {
    if (typeof v !== "number" || typeof price !== "number" || !(price > 0)) return;
    const ratio = v / price;
    if (ratio < lo || ratio > hi) hits.push(`${label} ${v} vs ${price}`);
  };
  if (ref.option) {
    far("entry low (premium) ", t.entry?.low, ref.premium);
    far("entry high (premium)", t.entry?.high, ref.premium);
    far("target (premium)", t.target?.price, ref.premium, 0.05, 5);
  } else {
    far("entry low", t.entry?.low, ref.underlying);
    far("entry high", t.entry?.high, ref.underlying);
    far("target", t.target?.price, ref.underlying);
  }
  far("invalidation", t.invalidation?.price, ref.underlying);
  return hits.length ? `warning: far from the current price: ${hits.join(", ")}` : null;
}
