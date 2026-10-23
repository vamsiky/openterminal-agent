import type { OptionMetrics } from "../scan/contracts.js";
import type { SetupInputs, Stretch } from "../quant/option-score.js";

// Deterministic generated inputs for the identical-scores tests: random values mixed with the
// exact thresholds of option-v1 so every boundary is hit from both sides.

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TODAY = "2026-10-21";
const EXPIRY = "2026-11-20";

export function optionFixtures(n: number, seed = 1): SetupInputs[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const mixed = (special: Array<number | null>, lo: number, hi: number, nullable = true): number | null => {
    const x = r();
    if (x < 0.65) return pick(special);
    if (nullable && x < 0.7) return null;
    return Math.round((lo + r() * (hi - lo)) * 10) / 10;
  };
  const mom = (): number | null => mixed([null, -100, -50, -49.9, -1, 0, 0.1, 19.9, 20, 20.1, 25, 30, 39.9, 40, 50, 60, 100], -100, 100);
  const dates = [null, "2026-10-20", TODAY, "2026-10-22", "2026-11-05", EXPIRY, "2026-11-21"];
  const out: SetupInputs[] = [];
  for (let k = 0; k < n; k++) {
    const hasMetrics = r() > 0.04;
    const hv20 = mixed([null, 0, 0.2, 0.25, 0.3, 0.5], 0, 1.2);
    const iv30 = mixed([null, 0.3, 0.36, 0.2, 0.5, 0.25], 0.05, 1.5);
    const m: OptionMetrics | null = hasMetrics
      ? {
          underlying: "AAA", asOf: "2026-10-21T19:00:00Z", price: pick([null, 0, 100, 250.4, 12.34]), atmExpiry: pick([EXPIRY, EXPIRY, EXPIRY, null]),
          atmCall: pick(["AAA261120C00100000", "AAA261120C00100000", null]), atmPut: pick(["AAA261120P00100000", "AAA261120P00100000", null]),
          atmIv: 0.3, iv30, ivRank: mixed([null, null, 0, 29.9, 30, 30.1, 45, 59.9, 60, 60.1, 100], 0, 100), ivPercentile: 25,
          ivHistoryDays: pick([0, 19, 20, 21, 200]), hv20, impliedMovePct: 5, termSlope: 0, putCallVolumeRatio: 0.8, unusual: [],
          atmCallQuote: null, atmPutQuote: null,
        }
      : null;
    const dailyAtrPct = pick([null, 2, 3.5, 0, 1.2]);
    const stretch: Stretch | undefined =
      r() < 0.2
        ? undefined
        : {
            vwapAtr: mixed([null, 0, 1.9, 2, 2.01, 3, 2.6], -3, 5),
            rsi15: mixed([null, 50, 74, 75, 75.5, 84.4, 90], 20, 95),
            dayMovePct: mixed([null, 0, 2, 3, 3.1, 7.6, -2], -5, 10),
            dailyAtrPct,
          };
    out.push({
      momentum: { m5: mom(), m15: mom(), h1: mom(), d1: mixed([null, -60, -50, -49.9, 0, 19.9, 20, 20.1, 24.9, 25, 50, 100], -100, 100) },
      metrics: m,
      composite: mixed([null, 59.9, 60, 60.1, 80, 100, 0], 0, 100),
      relVolume: mixed([null, 0, 0.7, 1.49, 1.5, 1.51, 3], 0, 4),
      sharesHeld: pick([0, 0, 99, 100, 199, 200, 250, 100.5, 1000]),
      nextEarnings: pick(dates),
      nextExDividend: pick(dates),
      stretch,
      today: TODAY,
    });
  }
  return out;
}
