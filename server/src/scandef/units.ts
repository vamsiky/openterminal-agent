import { catalogField, type Scope } from "./catalog.js";
import type { Cond, Expr } from "./dsl.js";

// The range a threshold may take, by the catalog unit of the value it is compared with. The Settings
// form shows these as min and max, and validation enforces the same limits.

export type Bounds = { min: number; max: number; step: number };
export const UNIT_BOUNDS: Record<string, Bounds> = {
  score_0_100: { min: 0, max: 100, step: 1 },
  score_pm100: { min: -100, max: 100, step: 1 },
  pct: { min: -5, max: 5, step: 0.01 },
  ratio: { min: -20, max: 20, step: 0.1 },
  x: { min: -20, max: 20, step: 0.1 },
  usd: { min: 0, max: 1_000_000, step: 1 },
  days: { min: 0, max: 400, step: 1 },
  count: { min: 0, max: 10_000, step: 1 },
  bool: { min: 0, max: 1, step: 1 },
};
const GENERIC: Bounds = { min: -1_000_000, max: 1_000_000, step: 0.1 };
export const boundsFor = (unit: string | undefined): Bounds => (unit ? (UNIT_BOUNDS[unit] ?? GENERIC) : GENERIC);

/** The catalog unit of an expression: a field's own, the inputs' for avg/min/max/sum/diff, "ratio" for a ratio; undefined when unclear. */
export function exprUnit(scope: Scope, e: Expr): string | undefined {
  if (typeof e === "string") return catalogField(scope, e)?.unit;
  if (typeof e === "number") return undefined;
  if ("scale" in e) return exprUnit(scope, e.scale.expr);
  if ("coalesce" in e) return e.coalesce.map((x) => exprUnit(scope, x)).find((u) => u !== undefined);
  if ("avg" in e) return e.avg.map((x) => exprUnit(scope, x)).find((u) => u !== undefined);
  if ("min" in e) return e.min.map((x) => exprUnit(scope, x)).find((u) => u !== undefined);
  if ("max" in e) return e.max.map((x) => exprUnit(scope, x)).find((u) => u !== undefined);
  if ("sum" in e) return e.sum.map((x) => exprUnit(scope, x)).find((u) => u !== undefined);
  if ("diff" in e) return exprUnit(scope, e.diff[0]) ?? exprUnit(scope, e.diff[1]);
  if ("ratio" in e) return "ratio";
  return exprUnit(scope, e.if.then);
}

function checkValue(unit: string | undefined, v: number, what: string, where: string, errors: string[]): void {
  if (!unit || !UNIT_BOUNDS[unit]) return;
  const b = UNIT_BOUNDS[unit];
  if (v < b.min || v > b.max) errors.push(`${where}: ${what} ${v} is outside ${b.min} to ${b.max} (the range for ${unit})`);
}

/** Errors for comparison values, ranges and scale ends that fall outside the range of the field they are compared with. */
export function expressionBounds(scope: Scope, e: Expr, where: string, errors: string[]): void {
  if (typeof e !== "object") return;
  if ("scale" in e) {
    const u = exprUnit(scope, e.scale.expr);
    checkValue(u, e.scale.from, "scale start", where, errors);
    checkValue(u, e.scale.to, "scale end", where, errors);
    expressionBounds(scope, e.scale.expr, where, errors);
  } else if ("if" in e) {
    conditionBounds(scope, e.if.cond, where, errors);
    expressionBounds(scope, e.if.then, where, errors);
    if (e.if.else !== undefined) expressionBounds(scope, e.if.else, where, errors);
  } else {
    const kids = "avg" in e ? e.avg : "min" in e ? e.min : "max" in e ? e.max : "sum" in e ? e.sum : "diff" in e ? e.diff : "ratio" in e ? e.ratio : e.coalesce;
    kids.forEach((k) => expressionBounds(scope, k, where, errors));
  }
}

export function conditionBounds(scope: Scope, c: Cond, where: string, errors: string[]): void {
  if ("all" in c) c.all.forEach((x) => conditionBounds(scope, x, where, errors));
  else if ("any" in c) c.any.forEach((x) => conditionBounds(scope, x, where, errors));
  else if ("not" in c) conditionBounds(scope, c.not, where, errors);
  else if ("known" in c) expressionBounds(scope, c.known, where, errors);
  else {
    const u = exprUnit(scope, c.expr);
    if (c.op === "between") {
      checkValue(u, c.min, "range start", where, errors);
      checkValue(u, c.max, "range end", where, errors);
    } else if (typeof c.value === "number") checkValue(u, c.value, "threshold", where, errors);
    expressionBounds(scope, c.expr, where, errors);
  }
}
