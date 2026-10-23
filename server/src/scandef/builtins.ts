import { BUILTIN_FACTORS, BUILTIN_LIVE_FACTORS } from "./factors.js";
import type { Cond, Expr } from "./dsl.js";
import type { OptionDefinition, StockDefinition } from "./schema.js";

// The two built-in definitions: option-v1 and stock-v2 reproduce the scoring the engine had
// before it ran on definitions, number for number.

export const OPTION_V1 = "option-v1";
export const STOCK_V2 = "stock-v2";

const noRank: Cond = { not: { known: "iv_rank" } };
const hvPositive: Cond = { expr: "hv20", op: ">", value: 0 };
const ivVsHv: Expr = { ratio: ["iv30", "hv20"] };
const NO_RANK = "IV {iv30:pct0}% vs 20-day realised {hv20:pct0}% (no IV rank yet)";

/** 0 (rich) to 1 (cheap): from IV rank, else iv30 against hv20 (up to 1.2x counts as cheap). */
const ivCheap: Expr = {
  coalesce: [
    { scale: { expr: "iv_rank", from: 60, to: 30 } },
    { if: { cond: { all: [{ known: "iv30" }, hvPositive] }, then: { if: { cond: { expr: ivVsHv, op: "<=", value: 1.2 }, then: 1, else: 0 } } } },
  ],
};

/** 0 to 1 how rich IV is for selling: from IV rank, else iv30 against hv20. */
const ivRich: Expr = {
  coalesce: [
    { scale: { expr: "iv_rank", from: 30, to: 100 } },
    { if: { cond: { all: [{ known: "iv30" }, hvPositive] }, then: { scale: { expr: ivVsHv, from: 0.8, to: 1.6 } } } },
  ],
};

const richGate: Cond = {
  label: "IV is rich",
  any: [
    { expr: "iv_rank", op: ">=", value: 60, say: "IV rank {iv_rank:int}: premium is rich" },
    { all: [noRank, { known: "iv30" }, hvPositive, { expr: ivVsHv, op: ">", value: 1.0 }], say: `${NO_RANK}: premium is rich` },
  ],
};

const cheapNow: Cond = { expr: ivCheap, op: ">=", value: 0.5 };
const rankKnown: Cond = { known: "iv_rank" };

const earnings = (points: number) => ({
  label: "Earnings before expiry",
  cond: { expr: "earnings_before_expiry", op: "==", value: true } as Cond,
  points,
  say: "caution: earnings on {next_earnings} fall before the {atm_expiry} expiry",
});
const exDividend = (points: number, say: string) => ({
  label: "Ex-dividend before expiry",
  cond: { expr: "ex_dividend_before_expiry", op: "==", value: true } as Cond,
  points,
  say,
});

export const OPTION_V1_DEF: OptionDefinition = {
  kind: "option",
  version: OPTION_V1,
  parent: null,
  listing: { minScore: 70, early: { ivHistoryDaysBelow: 20, minScore: 60 }, maxIdeas: 20, missesToDrop: 2, nearMissFrom: null },
  strategies: {
    long_call: {
      enabled: true,
      label: "Buy a call",
      contract: "atm_call",
      base: 40,
      gates: [
        { label: "Momentum average", expr: { avg: ["m15", "h1"] }, op: ">=", value: 40, say: "momentum is strong: 15-minute {m15:int}, hourly {h1:int}" },
        { label: "Both timeframes up", expr: { min: ["m15", "h1"] }, op: ">", value: 0 },
        { label: "Daily uptrend", expr: "d1", op: ">=", value: 25, say: "daily uptrend {d1:int} (at least {value})" },
      ],
      terms: [
        { label: "Momentum", expr: { scale: { expr: { avg: ["m15", "h1"] }, from: 40, to: 100 } }, points: 25 },
        { label: "Daily trend", expr: { scale: { expr: "d1", from: 0, to: 50 } }, points: 10 },
        {
          label: "Options are cheap",
          expr: ivCheap,
          points: 15,
          say: [
            { when: { all: [rankKnown, cheapNow] }, text: "IV rank {iv_rank:int}: options are not expensive" },
            { when: rankKnown, text: "IV rank {iv_rank:int}: options are pricey" },
            { when: cheapNow, text: `${NO_RANK}: options are not expensive` },
            { text: `${NO_RANK}: options are pricey` },
          ],
          sayElse: "IV is unknown",
        },
        { label: "Volume", expr: { scale: { expr: "rel_volume", from: 0, to: 1.5 } }, points: 5, say: "volume is {rel_volume:1dp}x normal for the time of day" },
        { label: "High volume", cond: { expr: "rel_volume", op: ">=", value: 1.5 }, points: 5 },
      ],
      penalties: [
        earnings(25),
        {
          label: "Stretched",
          signs: [
            { label: "Above VWAP", expr: "vwap_atr_distance", op: ">", value: 2, say: "{vwap_atr_distance:1dp} ATR above VWAP" },
            { label: "15-minute RSI", expr: "rsi_15m", op: ">", value: 75, say: "15-min RSI {rsi_15m:int}" },
            { label: "Day move", expr: "day_move_vs_usual", op: ">", value: 1.5, say: "up {day_move_pct:1dp}% vs a normal {usual_day_move_pct:1dp}% day" },
          ],
          pointsEach: 10,
          cap: 30,
          say: "stretched: {signs}: consider waiting for a pullback",
        },
      ],
    },
    short_put: {
      enabled: true,
      label: "Sell a cash-secured put",
      contract: "atm_put",
      base: 40,
      gates: [
        { label: "Stock worth owning", expr: "stock_composite", op: ">=", value: 60, say: "stock score {stock_composite:int}/100: worth owning if assigned" },
        richGate,
        { label: "Not falling hard", expr: "d1", op: ">", value: -50, say: "daily trend {d1:int}, not falling hard" },
      ],
      terms: [
        { label: "Rich IV", expr: ivRich, points: 25 },
        { label: "Stock score", expr: { scale: { expr: "stock_composite", from: 60, to: 100 } }, points: 20 },
        { label: "Hourly momentum", expr: { scale: { expr: { coalesce: ["h1", 0] }, from: -50, to: 50 } }, points: 10 },
        { label: "Cash needed", cond: { expr: "put_cash_required", op: ">", value: 0 }, points: 0, say: "needs cash for 100 shares at the strike (about {put_cash_required:usd0})" },
      ],
      penalties: [earnings(15), exDividend(3, "note: ex-dividend {next_ex_dividend} before expiry")],
    },
    covered_call: {
      enabled: true,
      label: "Sell a covered call",
      contract: "atm_call",
      base: 40,
      gates: [
        { label: "Shares held", expr: "shares_held", op: ">=", value: 100, say: "you hold {shares_held} shares ({contracts_covered} contract{contracts_covered:s} covered)" },
        richGate,
        { label: "15-minute momentum flat", expr: "m15", op: "<=", value: 20, say: "momentum is flat or down: 15-minute {m15:int}, hourly {h1:int}" },
        { label: "Hourly momentum flat", expr: "h1", op: "<=", value: 20 },
      ],
      terms: [
        { label: "Rich IV", expr: ivRich, points: 30 },
        { label: "Flat or falling momentum", expr: { scale: { expr: { avg: ["m15", "h1"] }, from: 20, to: -60 } }, points: 20 },
        { label: "Daily trend flat", cond: { expr: "d1", op: "<=", value: 20 }, points: 10 },
      ],
      penalties: [earnings(10), exDividend(30, "ex-dividend {next_ex_dividend} before expiry: early assignment risk")],
    },
  },
};

export const STOCK_V2_DEF: StockDefinition = {
  kind: "stock",
  version: STOCK_V2,
  parent: null,
  factors: BUILTIN_FACTORS.map((f) => ({
    key: f.key,
    group: f.group as StockDefinition["factors"][number]["group"],
    direction: f.lowerBetter ? "lower" : "higher",
    positiveOnly: f.positiveOnly === true,
    rankAgainst: f.market ? "market" : "sector",
    include: true,
  })),
  liveFactors: BUILTIN_LIVE_FACTORS.map((f) => ({ key: f.key, include: true })),
  groupWeights: { valuation: 0.2, quality: 0.2, growth: 0.15, earnings: 0.15, analysts: 0.1, momentum: 0.2 },
  minPeers: 5,
  staleBarDays: 7,
  filters: [],
  listing: { top: 25, minCoverage: 0.6, earningsFlagDays: 30 },
};
