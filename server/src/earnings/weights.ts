import type { Horizon, ScoreComponent } from "./contracts.js";

// Versioned weights of the earnings setup score, per horizon. A setup records
// the version, so changing a number here never rewrites what an old score meant.

export const EARNINGS_WEIGHTS_VERSION = "earn-v1";

export type HorizonWeights = {
  /** Points available per component; they sum to 100. */
  max: Record<ScoreComponent["key"], number>;
  /** Shrinkage of own history toward the pool: blended = (n*own + k*pool) / (n + k). */
  k: number;
  /** Analyst window and points: a target raise adds, a cut subtracts (each counted once). */
  analystDays: number;
  analystRaise: number;
  analystCut: number;
  /** Points per rising reaction among the last four. */
  reaction: number;
  /** Last quarter beat on both EPS and revenue / on one of them. */
  beatBoth: number;
  beatOne: number;
  /** Consensus revision points (full at +-revFullPct, negative below zero); 0 where the horizon ignores them. */
  revEps30: number;
  revEps90: number;
  revFullPct: number;
  /** Points for the share of past report days that closed above the previous close. */
  drift: number;
  /** Carry: points for the break-even part, and for options cheaper than usual at this point of the ramp. */
  carryBreakeven: number;
  carryIv: number;
  /** Calendar days from entry to T0 (to measure how far an expiry is from entry). */
  entryLeadDays: number;
};

const common = { k: 5, revFullPct: 5 };

export const WEIGHTS: Record<Horizon, HorizonWeights> = {
  intraday: {
    ...common,
    max: { tradability: 25, history: 30, setup: 20, demand: 15, carry: 10 },
    analystDays: 10, analystRaise: 3, analystCut: 2, reaction: 1.5, beatBoth: 3, beatOne: 1.5,
    revEps30: 0, revEps90: 0, drift: 3, carryBreakeven: 10, carryIv: 0, entryLeadDays: 0,
  },
  week: {
    ...common,
    max: { tradability: 20, history: 25, setup: 20, demand: 20, carry: 15 },
    analystDays: 30, analystRaise: 5, analystCut: 3, reaction: 1, beatBoth: 3, beatOne: 1.5,
    revEps30: 3, revEps90: 2, drift: 3, carryBreakeven: 10, carryIv: 5, entryLeadDays: 7,
  },
  month: {
    ...common,
    max: { tradability: 15, history: 20, setup: 25, demand: 25, carry: 15 },
    analystDays: 30, analystRaise: 6, analystCut: 4, reaction: 1.5, beatBoth: 4, beatOne: 2,
    revEps30: 4, revEps90: 3, drift: 2, carryBreakeven: 10, carryIv: 5, entryLeadDays: 28,
  },
};

export const GATES = { maxSpreadPct: 15, minVolume: 50 };
export const BANDS = { candidate: 70, conditional: 55 };
/** Setup sub-points (SMA20/50/200) and momentum divisor at max 20; other horizons scale by max/20. */
export const SETUP = { sma: [3, 4, 3] as const, momentumDiv: 10, rsiHot: [[85, 8], [75, 5]] as const, rsiColdBelow: 35, rsiColdPenalty: 3 };
/** Tradability penalty for a contract that traded fewer than minVolume today. */
export const LOW_VOLUME_PENALTY = 5;
