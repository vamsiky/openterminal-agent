import type { OptionSetup, OptionStrategy } from "../scan/contracts.js";
import { condSays, evalCond, evalExpr, renderSay, type Cond, type Ctx } from "./dsl.js";
import { STRATEGY_KEYS, type OptionDefinition, type Penalty, type Term } from "./schema.js";

// Interprets an option definition for one symbol. Pure: the caller supplies the catalog values.

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

export type GateTrace = { label: string; passed: boolean };
export type TermTrace = { label: string; kind: "term" | "penalty"; applied: boolean; /** Points added (negative for a penalty). */ points: number };
/** How one strategy fared for one symbol, for the funnel and for explaining a miss. */
export type StrategyTrace = {
  strategy: OptionStrategy;
  label: string;
  enabled: boolean;
  /** The symbol had option metrics, so the strategy could be judged. */
  hasData: boolean;
  /** Every gate in order, then the contract check; all are evaluated, none short-circuits. */
  gates: GateTrace[];
  /** Label of the first gate that failed, or null when all passed (or there was no data). */
  firstFailed: string | null;
  passed: boolean;
  score: number | null;
  contract: string | null;
  reasons: string[];
  terms: TermTrace[];
};
export type OptionEvaluation = {
  /** Setups that passed their gates, best score first. */
  setups: OptionSetup[];
  /** One trace per strategy, in the fixed order long_call, short_put, covered_call. */
  traces: StrategyTrace[];
};
export type OptionEvalInput = {
  ctx: Ctx;
  hasData: boolean;
  contracts: { atm_call: string | null; atm_put: string | null };
};

export const CONTRACT_GATE_LABEL = "Contract available";

function termValue(t: Term, ctx: Ctx): { applied: boolean; points: number; say: string | null } {
  if ("expr" in t) {
    const v = evalExpr(t.expr, ctx);
    if (v === null) return { applied: false, points: 0, say: renderSay(t.sayElse, ctx) };
    return { applied: true, points: t.points * v, say: renderSay(t.say, ctx) };
  }
  if (evalCond(t.cond, ctx)) return { applied: true, points: t.points, say: renderSay(t.say, ctx) };
  return { applied: false, points: 0, say: renderSay(t.sayElse, ctx) };
}

function penaltyValue(p: Penalty, ctx: Ctx): { applied: boolean; points: number; say: string | null } {
  if ("cond" in p) {
    const hit = evalCond(p.cond, ctx);
    return { applied: hit, points: hit ? p.points : 0, say: hit ? renderSay(p.say, ctx) : null };
  }
  const met = p.signs.filter((c: Cond) => evalCond(c, ctx));
  if (met.length === 0) return { applied: false, points: 0, say: null };
  const fragments = met.flatMap((c) => condSays(c, ctx));
  return { applied: true, points: Math.min(p.cap, p.pointsEach * met.length), say: renderSay(p.say, ctx, { signs: fragments.join(", ") }) };
}

export function evaluateOption(def: OptionDefinition, input: OptionEvalInput): OptionEvaluation {
  const { ctx } = input;
  const setups: OptionSetup[] = [];
  const traces: StrategyTrace[] = [];
  for (const key of STRATEGY_KEYS) {
    const s = def.strategies[key];
    const trace: StrategyTrace = { strategy: key, label: s.label, enabled: s.enabled, hasData: input.hasData, gates: [], firstFailed: null, passed: false, score: null, contract: null, reasons: [], terms: [] };
    traces.push(trace);
    if (!s.enabled || !input.hasData) continue;
    const contract = input.contracts[s.contract];
    trace.gates = s.gates.map((g) => ({ label: g.label ?? "", passed: evalCond(g, ctx) }));
    trace.gates.push({ label: CONTRACT_GATE_LABEL, passed: !!contract });
    trace.firstFailed = trace.gates.find((g) => !g.passed)?.label ?? null;
    if (trace.firstFailed !== null) continue;

    const reasons = s.gates.flatMap((g) => condSays(g, ctx));
    let score = s.base;
    for (const t of s.terms) {
      const r = termValue(t, ctx);
      trace.terms.push({ label: t.label, kind: "term", applied: r.applied, points: r.points });
      score += r.points;
      if (r.say) reasons.push(r.say);
    }
    for (const p of s.penalties) {
      const r = penaltyValue(p, ctx);
      trace.terms.push({ label: p.label, kind: "penalty", applied: r.applied, points: -r.points });
      score -= r.points;
      if (r.say) reasons.push(r.say);
    }
    trace.passed = true;
    trace.score = round1(clamp(score, 0, 100));
    trace.contract = contract;
    trace.reasons = reasons;
    setups.push({ strategy: key, score: trace.score, contract, reasons });
  }
  setups.sort((a, b) => b.score - a.score);
  return { setups, traces };
}

/**
 * The option funnel for one strategy over many symbols: names with data, then the count still in after
 * each gate in order (including the contract check). The caller adds the "listed" step from its listing rules.
 */
export function optionFunnel(strategy: OptionStrategy, traces: StrategyTrace[]): Array<{ step: string; count: number }> {
  const mine = traces.filter((t) => t.strategy === strategy && t.enabled && t.hasData);
  const steps: Array<{ step: string; count: number }> = [{ step: "With data", count: mine.length }];
  const labels = mine[0]?.gates.map((g) => g.label) ?? [];
  labels.forEach((label, i) => {
    steps.push({ step: label, count: mine.filter((t) => t.gates.slice(0, i + 1).every((g) => g.passed)).length });
  });
  return steps;
}
