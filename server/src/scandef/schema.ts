import { z } from "zod";
import { NUMERIC_UNITS, catalogField, type Scope } from "./catalog.js";
import { condDepth, condKeys, condSchema, exprDepth, exprKeys, exprSchema, saySchema, FORMAT_NAMES, SAY_EXTRAS, type Cond, type Expr, type Say } from "./dsl.js";
import { BUILTIN_FACTORS, BUILTIN_LIVE_FACTORS, STOCK_GROUPS } from "./factors.js";

// Option and stock definitions: zod shapes with a min and max on every number, plus the semantic
// checks the shapes cannot express (catalog keys, weights, the fixed strategy rules).

export const STRATEGY_KEYS = ["long_call", "short_put", "covered_call"] as const;
export type StrategyKey = (typeof STRATEGY_KEYS)[number];

const points = z.number().finite().min(-100).max(100);
const score = z.number().finite().min(0).max(100);
const label = z.string().min(1).max(60);
const version = z.string().regex(/^(option|stock)-v\d{1,4}$/);

const termBase = { label, points, say: saySchema.optional(), sayElse: saySchema.optional() };
export const termSchema = z.union([z.object({ ...termBase, expr: exprSchema }).strict(), z.object({ ...termBase, cond: condSchema }).strict()]);
export type Term = z.infer<typeof termSchema>;

const penaltyBase = { label, say: saySchema.optional() };
export const penaltySchema = z.union([
  z.object({ ...penaltyBase, cond: condSchema, points: z.number().finite().min(0).max(100) }).strict(),
  z.object({ ...penaltyBase, signs: z.array(condSchema).min(1).max(8), pointsEach: z.number().finite().min(0).max(100), cap: z.number().finite().min(0).max(100) }).strict(),
]);
export type Penalty = z.infer<typeof penaltySchema>;

export const CONTRACTS = ["atm_call", "atm_put"] as const;
export const strategySchema = z
  .object({
    enabled: z.boolean(),
    label,
    gates: z.array(condSchema).min(1).max(10),
    base: score,
    terms: z.array(termSchema).max(16),
    penalties: z.array(penaltySchema).max(12),
    contract: z.enum(CONTRACTS),
  })
  .strict();
export type StrategyDef = z.infer<typeof strategySchema>;

export const optionListingSchema = z
  .object({
    minScore: score,
    early: z.object({ ivHistoryDaysBelow: z.number().int().min(0).max(252), minScore: score }).strict(),
    maxIdeas: z.number().int().min(1).max(100),
    missesToDrop: z.number().int().min(1).max(20),
    nearMissFrom: score.nullable(),
  })
  .strict();

export type OptionListing = z.infer<typeof optionListingSchema>;

export const optionDefSchema = z
  .object({
    kind: z.literal("option"),
    version,
    parent: version.nullable(),
    listing: optionListingSchema,
    strategies: z.object({ long_call: strategySchema, short_put: strategySchema, covered_call: strategySchema }).strict(),
  })
  .strict();
export type OptionDefinition = z.infer<typeof optionDefSchema>;

const weight = z.number().finite().min(0).max(1);
export const stockFactorSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    group: z.enum(STOCK_GROUPS),
    direction: z.enum(["higher", "lower"]),
    positiveOnly: z.boolean(),
    rankAgainst: z.enum(["sector", "market"]),
    include: z.boolean(),
  })
  .strict();
export type StockFactorDef = z.infer<typeof stockFactorSchema>;

export const stockDefSchema = z
  .object({
    kind: z.literal("stock"),
    version,
    parent: version.nullable(),
    factors: z.array(stockFactorSchema).length(BUILTIN_FACTORS.length),
    liveFactors: z.array(z.object({ key: z.string(), include: z.boolean() }).strict()).length(BUILTIN_LIVE_FACTORS.length),
    groupWeights: z.object({ valuation: weight, quality: weight, growth: weight, earnings: weight, analysts: weight, momentum: weight }).strict(),
    minPeers: z.number().int().min(1).max(200),
    staleBarDays: z.number().int().min(1).max(60),
    filters: z.array(condSchema).max(8),
    listing: z.object({ top: z.number().int().min(1).max(100), minCoverage: z.number().finite().min(0).max(1), earningsFlagDays: z.number().int().min(0).max(120) }).strict(),
  })
  .strict();
export type StockDefinition = z.infer<typeof stockDefSchema>;

export type Definition = OptionDefinition | StockDefinition;
export type DefKind = Definition["kind"];

// ---- semantic checks ----

const MAX_DEPTH = 10;

function checkKeys(scope: Scope, keys: Array<{ key: string; numeric: boolean }>, where: string, errors: string[]): void {
  for (const { key, numeric } of keys) {
    const f = catalogField(scope, key);
    if (!f) errors.push(`${where}: "${key}" is not a ${scope} field in the catalog`);
    else if (numeric && !NUMERIC_UNITS.has(f.unit)) errors.push(`${where}: "${key}" is ${f.unit}, not a number; it can only be used in sentences or "known"`);
  }
}

function checkSay(scope: Scope, say: Say | undefined, where: string, errors: string[]): void {
  if (say === undefined) return;
  const texts = typeof say === "string" ? [say] : say.map((v) => v.text);
  for (const t of texts) {
    for (const m of t.matchAll(/\{([^}]*)\}/g)) {
      const parts = m[1].split(":");
      const [key, fmt] = parts;
      if (parts.length > 2 || !/^[a-z][a-z0-9_]*$/.test(key)) errors.push(`${where}: bad placeholder {${m[1]}}`);
      else if (!(SAY_EXTRAS as readonly string[]).includes(key) && !catalogField(scope, key)) errors.push(`${where}: {${key}} is not a ${scope} field`);
      else if (fmt !== undefined && !FORMAT_NAMES.includes(fmt)) errors.push(`${where}: unknown format "${fmt}" (one of ${FORMAT_NAMES.join(", ")})`);
    }
  }
  if (typeof say !== "string") for (const v of say) if (v.when) checkCond(scope, v.when, where, errors);
}

function checkCond(scope: Scope, c: Cond, where: string, errors: string[]): void {
  checkKeys(scope, condKeys(c), where, errors);
  if (condDepth(c) > MAX_DEPTH) errors.push(`${where}: condition nests deeper than ${MAX_DEPTH}`);
  const walk = (x: Cond) => {
    checkSay(scope, x.say, where, errors);
    if ("all" in x) x.all.forEach(walk);
    else if ("any" in x) x.any.forEach(walk);
    else if ("not" in x) walk(x.not);
  };
  walk(c);
}

function checkExpr(scope: Scope, e: Expr, where: string, errors: string[]): void {
  checkKeys(scope, exprKeys(e), where, errors);
  if (exprDepth(e) > MAX_DEPTH) errors.push(`${where}: expression nests deeper than ${MAX_DEPTH}`);
}

function unique(labels: string[], what: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const l of labels) {
    if (seen.has(l)) errors.push(`${what}: two entries are labelled "${l}"; labels must differ`);
    seen.add(l);
  }
}

/** The covered call may only run against shares held: some gate must require 100 or more. */
function requiresShares(gates: Cond[]): boolean {
  return gates.some((g) => "op" in g && g.op !== "between" && g.expr === "shares_held" && typeof g.value === "number" && ((g.op === ">=" && g.value >= 100) || (g.op === ">" && g.value >= 99)));
}

export function checkOption(d: OptionDefinition): string[] {
  const errors: string[] = [];
  for (const key of STRATEGY_KEYS) {
    const s = d.strategies[key];
    const at = `${key}`;
    const wantContract = key === "short_put" ? "atm_put" : "atm_call";
    if (s.contract !== wantContract) errors.push(`${at}: contract must be ${wantContract}`);
    if (key === "covered_call" && s.enabled && !requiresShares(s.gates)) errors.push(`${at}: a covered call needs a gate requiring shares_held of 100 or more`);
    unique(s.gates.map((g) => g.label ?? ""), `${at} gates`, errors);
    s.gates.forEach((g, i) => {
      if (!g.label) errors.push(`${at}.gates[${i}]: every gate needs a label`);
      checkCond("option" as Scope, g, `${at}.gates[${i}]`, errors);
    });
    unique(s.terms.map((t) => t.label), `${at} terms`, errors);
    s.terms.forEach((t, i) => {
      const w = `${at}.terms[${i}]`;
      if ("expr" in t) checkExpr("option", t.expr, w, errors);
      else checkCond("option", t.cond, w, errors);
      checkSay("option", t.say, w, errors);
      checkSay("option", t.sayElse, w, errors);
    });
    unique(s.penalties.map((p) => p.label), `${at} penalties`, errors);
    s.penalties.forEach((p, i) => {
      const w = `${at}.penalties[${i}]`;
      if ("cond" in p) checkCond("option", p.cond, w, errors);
      else {
        p.signs.forEach((c) => checkCond("option", c, w, errors));
        if (p.cap < p.pointsEach) errors.push(`${w}: cap is below the points for one sign`);
      }
      checkSay("option", p.say, w, errors);
    });
  }
  if (d.listing.nearMissFrom !== null && d.listing.nearMissFrom >= d.listing.minScore) errors.push("listing.nearMissFrom must be below minScore");
  return errors;
}

export function checkStock(d: StockDefinition): string[] {
  const errors: string[] = [];
  const keys = new Set(d.factors.map((f) => f.key));
  for (const f of BUILTIN_FACTORS) if (!keys.has(f.key)) errors.push(`factors: missing "${f.key}"`);
  if (keys.size !== d.factors.length) errors.push("factors: a factor is listed twice");
  for (const f of d.factors) if (!BUILTIN_FACTORS.some((b) => b.key === f.key)) errors.push(`factors: "${f.key}" is not a stock factor`);
  const live = new Set(d.liveFactors.map((f) => f.key));
  for (const f of BUILTIN_LIVE_FACTORS) if (!live.has(f.key)) errors.push(`liveFactors: missing "${f.key}"`);
  if (live.size !== d.liveFactors.length) errors.push("liveFactors: a factor is listed twice");
  for (const f of d.liveFactors) if (!BUILTIN_LIVE_FACTORS.some((b) => b.key === f.key)) errors.push(`liveFactors: "${f.key}" is not a live factor`);
  const sum = Object.values(d.groupWeights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.001) errors.push(`groupWeights must sum to 1 (they sum to ${sum.toFixed(3)})`);
  unique(d.filters.map((f) => f.label ?? ""), "filters", errors);
  d.filters.forEach((f, i) => {
    if (!f.label) errors.push(`filters[${i}]: every filter needs a label`);
    checkCond("stock", f, `filters[${i}]`, errors);
  });
  if (d.factors.every((f) => !f.include)) errors.push("factors: at least one factor must be included");
  return errors;
}

export type ParseResult = { ok: true; def: Definition } | { ok: false; errors: string[] };

const issueText = (i: z.ZodIssue) => `${i.path.join(".") || "definition"}: ${i.message}`;

/** Validates stored or generated JSON: shape first, then the semantic checks. */
export function parseDefinition(json: unknown): ParseResult {
  const kind = typeof json === "object" && json !== null ? (json as { kind?: unknown }).kind : undefined;
  const shape = kind === "option" ? optionDefSchema : kind === "stock" ? stockDefSchema : null;
  if (!shape) return { ok: false, errors: ['kind must be "option" or "stock"'] };
  const r = shape.safeParse(json);
  if (!r.success) {
    // Union errors are noisy; keep the distinct messages.
    const msgs = [...new Set(r.error.issues.flatMap((i) => (i.code === "invalid_union" ? i.unionErrors.flatMap((u) => u.issues.map(issueText)) : [issueText(i)])))];
    return { ok: false, errors: msgs.slice(0, 12) };
  }
  const errors = r.data.kind === "option" ? checkOption(r.data) : checkStock(r.data);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, def: r.data };
}
