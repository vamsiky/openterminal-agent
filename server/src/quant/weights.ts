// Versioned scoring weights. A scorecard records the version it was computed
// with, so a later change of weights never rewrites what history means.

export const STOCK_WEIGHTS_VERSION = "stock-v1";

/** Group weights for months-horizon stock scores; groups without data drop out and the rest re-normalise. */
export const STOCK_WEIGHTS: Record<string, number> = {
  valuation: 0.2,
  quality: 0.2,
  growth: 0.15,
  earnings: 0.15,
  analysts: 0.1,
  momentum: 0.2,
};

const SETS: Record<string, Record<string, number>> = { [STOCK_WEIGHTS_VERSION]: STOCK_WEIGHTS };

export function weightsFor(version: string): Record<string, number> {
  return SETS[version] ?? STOCK_WEIGHTS;
}

/** Weighted mean of the groups that have a score, 0–100; null when none has. */
export function composite(groups: Record<string, number | null>, weights: Record<string, number> = STOCK_WEIGHTS): number | null {
  let sum = 0;
  let total = 0;
  for (const [g, w] of Object.entries(weights)) {
    const v = groups[g];
    if (v === null || v === undefined) continue;
    sum += v * w;
    total += w;
  }
  return total > 0 ? sum / total : null;
}
