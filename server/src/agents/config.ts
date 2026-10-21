import type { AgentName } from "./contracts.js";

// Agent settings, read from the environment on every call so tests (and a
// restart-free .env edit via process.env) take effect immediately.

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(v) && v >= 0 ? v : fallback;
};

export const agentsEnabled = (): boolean => process.env.AGENTS_ENABLED !== "0";
export const dailyBudgetUsd = (): number => num("AGENTS_DAILY_BUDGET_USD", 5);
export const concurrency = (): number => Math.max(1, Math.floor(num("AGENTS_CONCURRENCY", 2)));
export const model = (): string => process.env.AGENTS_MODEL || "claude-sonnet-5-5";
export const judgeModel = (): string => process.env.AGENTS_JUDGE_MODEL || "claude-opus-5-5";

/** Budget analyses may not spend into until the day's brief has run or been skipped. */
export const BRIEF_RESERVE_USD = 0.6;

export const CAP_ENV: Record<AgentName, [env: string, fallback: number]> = {
  macro: ["AGENTS_CAP_MACRO_USD", 0.3],
  bull: ["AGENTS_CAP_BULL_USD", 0.25],
  bear: ["AGENTS_CAP_BEAR_USD", 0.25],
  judge: ["AGENTS_CAP_JUDGE_USD", 0.4],
  brief: ["AGENTS_CAP_BRIEF_USD", 0.15],
};
export const capUsd = (agent: AgentName): number => num(CAP_ENV[agent][0], CAP_ENV[agent][1]);
/** What one full analysis (bull, bear, judge) may cost at most. */
export const analysisCapUsd = (): number => capUsd("bull") + capUsd("bear") + capUsd("judge");

export const MAX_TURNS: Record<AgentName, number> = { macro: 12, bull: 12, bear: 12, judge: 3, brief: 3 };
