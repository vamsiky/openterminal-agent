import { z } from "zod";

// The expression and condition language definitions are written in: JSON only, evaluated by the
// interpreter below. No eval, no user code. A null input makes an expression null; a comparison
// on null is false. Catalog keys are checked against the scope in schema.ts, not here.

export type Expr =
  | string
  | number
  | { avg: Expr[] }
  | { min: Expr[] }
  | { max: Expr[] }
  | { sum: Expr[] }
  | { diff: [Expr, Expr] }
  | { ratio: [Expr, Expr] }
  | { scale: { expr: Expr; from: number; to: number } }
  | { if: { cond: Cond; then: Expr; else?: Expr } }
  | { coalesce: Expr[] };

export const CMP_OPS = [">=", ">", "<=", "<", "==", "!="] as const;
export type CmpOp = (typeof CMP_OPS)[number];

/** A sentence for the reasons list: a template, or variants where the first whose `when` holds is used. */
export type Say = string | Array<{ when?: Cond; text: string }>;
type Meta = { label?: string; say?: Say };
export type Cond = Meta &
  (
    | { expr: Expr; op: CmpOp; value: number | boolean }
    | { expr: Expr; op: "between"; min: number; max: number }
    | { known: Expr }
    | { all: Cond[] }
    | { any: Cond[] }
    | { not: Cond }
  );

const LIMIT = 1_000_000;
const num = z.number().finite().min(-LIMIT).max(LIMIT);
const list = <T extends z.ZodTypeAny>(t: T) => z.array(t).min(1).max(12);

export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.string().regex(/^[a-z][a-z0-9_]*$/).max(48),
    num,
    z.object({ avg: list(exprSchema) }).strict(),
    z.object({ min: list(exprSchema) }).strict(),
    z.object({ max: list(exprSchema) }).strict(),
    z.object({ sum: list(exprSchema) }).strict(),
    z.object({ diff: z.tuple([exprSchema, exprSchema]) }).strict(),
    z.object({ ratio: z.tuple([exprSchema, exprSchema]) }).strict(),
    z.object({ scale: z.object({ expr: exprSchema, from: num, to: num }).strict().refine((s) => s.from !== s.to, "scale needs from and to to differ") }).strict(),
    z.object({ if: z.object({ cond: condSchema, then: exprSchema, else: exprSchema.optional() }).strict() }).strict(),
    z.object({ coalesce: list(exprSchema) }).strict(),
  ])
);

const sayText = z.string().min(1).max(300);
export const saySchema: z.ZodType<Say> = z.lazy(() => z.union([sayText, z.array(z.object({ when: condSchema.optional(), text: sayText }).strict()).min(1).max(8)]));

const meta = { label: z.string().min(1).max(60).optional(), say: saySchema.optional() };

export const condSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ ...meta, expr: exprSchema, op: z.enum(CMP_OPS), value: z.union([num, z.boolean()]) }).strict(),
    z.object({ ...meta, expr: exprSchema, op: z.literal("between"), min: num, max: num }).strict().refine((c) => c.min <= c.max, "min must not exceed max"),
    z.object({ ...meta, known: exprSchema }).strict(),
    z.object({ ...meta, all: z.array(condSchema).min(1).max(12) }).strict(),
    z.object({ ...meta, any: z.array(condSchema).min(1).max(12) }).strict(),
    z.object({ ...meta, not: condSchema }).strict(),
  ])
);

/** Per-symbol values by catalog key. Booleans are 1 and 0; dates and text are strings (usable in sentences only). */
export type Ctx = Record<string, number | string | null | undefined>;

const numeric = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function all(xs: Expr[], ctx: Ctx): number[] | null {
  const out: number[] = [];
  for (const x of xs) {
    const v = evalExpr(x, ctx);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

export function evalExpr(e: Expr, ctx: Ctx): number | null {
  if (typeof e === "string") return numeric(ctx[e]);
  if (typeof e === "number") return e;
  if ("avg" in e) {
    const v = all(e.avg, ctx);
    return v ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }
  if ("min" in e) {
    const v = all(e.min, ctx);
    return v ? Math.min(...v) : null;
  }
  if ("max" in e) {
    const v = all(e.max, ctx);
    return v ? Math.max(...v) : null;
  }
  if ("sum" in e) {
    const v = all(e.sum, ctx);
    return v ? v.reduce((a, b) => a + b, 0) : null;
  }
  if ("diff" in e) {
    const a = evalExpr(e.diff[0], ctx);
    const b = evalExpr(e.diff[1], ctx);
    return a === null || b === null ? null : a - b;
  }
  if ("ratio" in e) {
    const a = evalExpr(e.ratio[0], ctx);
    const b = evalExpr(e.ratio[1], ctx);
    return a === null || b === null || b === 0 ? null : a / b;
  }
  if ("scale" in e) {
    const x = evalExpr(e.scale.expr, ctx);
    return x === null ? null : Math.max(0, Math.min(1, (x - e.scale.from) / (e.scale.to - e.scale.from)));
  }
  if ("if" in e) {
    return evalCond(e.if.cond, ctx) ? evalExpr(e.if.then, ctx) : e.if.else === undefined ? null : evalExpr(e.if.else, ctx);
  }
  for (const x of e.coalesce) {
    const v = evalExpr(x, ctx);
    if (v !== null) return v;
  }
  return null;
}

const asNumber = (v: number | boolean) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

export function evalCond(c: Cond, ctx: Ctx): boolean {
  if ("all" in c) return c.all.every((x) => evalCond(x, ctx));
  if ("any" in c) return c.any.some((x) => evalCond(x, ctx));
  if ("not" in c) return !evalCond(c.not, ctx);
  if ("known" in c) {
    const k = c.known;
    if (typeof k === "string") return ctx[k] !== null && ctx[k] !== undefined;
    return evalExpr(k, ctx) !== null;
  }
  const x = evalExpr(c.expr, ctx);
  if (x === null) return false;
  if (c.op === "between") return x >= c.min && x <= c.max;
  const v = asNumber(c.value);
  switch (c.op) {
    case ">=": return x >= v;
    case ">": return x > v;
    case "<=": return x <= v;
    case "<": return x < v;
    case "==": return x === v;
    default: return x !== v;
  }
}

// ---- sentences ----

const FORMATS: Record<string, (x: number) => string> = {
  int: (x) => String(Math.round(x)),
  "1dp": (x) => x.toFixed(1),
  "2dp": (x) => x.toFixed(2),
  pct0: (x) => (x * 100).toFixed(0),
  pct1: (x) => (x * 100).toFixed(1),
  usd0: (x) => `$${Math.round(x).toLocaleString("en-US")}`,
  s: (x) => (x === 1 ? "" : "s"),
};
export const FORMAT_NAMES = Object.keys(FORMATS);

/** `{key}` or `{key:format}` in a sentence template. */
export const PLACEHOLDER = /\{([a-z][a-z0-9_]*)(?::([a-z0-9]+))?\}/g;
/** Placeholders that are not catalog keys: the compared value, the bounds of a range and the penalty's met signs. */
export const SAY_EXTRAS = ["value", "min", "max", "signs"] as const;

export function fillTemplate(text: string, ctx: Ctx, extra: Record<string, string> = {}): string {
  return text.replace(PLACEHOLDER, (_m, key: string, fmt?: string) => {
    if (key in extra) return extra[key];
    const v = ctx[key];
    if (v === null || v === undefined) return "?";
    if (typeof v === "string") return v;
    const f = fmt ? FORMATS[fmt] : undefined;
    return f ? f(v) : String(v);
  });
}

/** The sentence for a `say`, or null when no variant applies. */
export function renderSay(say: Say | undefined, ctx: Ctx, extra: Record<string, string> = {}): string | null {
  if (say === undefined) return null;
  if (typeof say === "string") return fillTemplate(say, ctx, extra);
  for (const v of say) if (v.when === undefined || evalCond(v.when, ctx)) return fillTemplate(v.text, ctx, extra);
  return null;
}

const show = (v: number | boolean) => String(typeof v === "boolean" ? (v ? 1 : 0) : v);

/** The reasons a passing condition contributes: its own sentence, else its children's (the first passing one for `any`). */
export function condSays(c: Cond, ctx: Ctx): string[] {
  if (c.say !== undefined) {
    const extra: Record<string, string> = {};
    if ("op" in c) {
      if (c.op === "between") {
        extra.min = show(c.min);
        extra.max = show(c.max);
      } else extra.value = show(c.value);
    }
    const s = renderSay(c.say, ctx, extra);
    return s === null ? [] : [s];
  }
  if ("all" in c) return c.all.flatMap((x) => condSays(x, ctx));
  if ("any" in c) {
    const hit = c.any.find((x) => evalCond(x, ctx));
    return hit ? condSays(hit, ctx) : [];
  }
  return [];
}

// ---- walking ----

/** Every catalog key referenced by an expression, with whether it is used as a number. */
export function exprKeys(e: Expr, out: Array<{ key: string; numeric: boolean }> = [], numericUse = true): Array<{ key: string; numeric: boolean }> {
  if (typeof e === "string") out.push({ key: e, numeric: numericUse });
  else if (typeof e === "number") return out;
  else if ("avg" in e) e.avg.forEach((x) => exprKeys(x, out));
  else if ("min" in e) e.min.forEach((x) => exprKeys(x, out));
  else if ("max" in e) e.max.forEach((x) => exprKeys(x, out));
  else if ("sum" in e) e.sum.forEach((x) => exprKeys(x, out));
  else if ("diff" in e) e.diff.forEach((x) => exprKeys(x, out));
  else if ("ratio" in e) e.ratio.forEach((x) => exprKeys(x, out));
  else if ("scale" in e) exprKeys(e.scale.expr, out);
  else if ("if" in e) {
    condKeys(e.if.cond, out);
    exprKeys(e.if.then, out);
    if (e.if.else !== undefined) exprKeys(e.if.else, out);
  } else e.coalesce.forEach((x) => exprKeys(x, out));
  return out;
}

export function condKeys(c: Cond, out: Array<{ key: string; numeric: boolean }> = []): Array<{ key: string; numeric: boolean }> {
  if ("all" in c) c.all.forEach((x) => condKeys(x, out));
  else if ("any" in c) c.any.forEach((x) => condKeys(x, out));
  else if ("not" in c) condKeys(c.not, out);
  else if ("known" in c) exprKeys(c.known, out, false);
  else exprKeys(c.expr, out);
  if (typeof c.say === "object") for (const v of c.say) if (v.when) condKeys(v.when, out);
  return out;
}

/** Placeholder keys in every sentence of a condition (own and nested), for validation. */
export function condPlaceholders(c: Cond, out: string[] = []): string[] {
  const addSay = (s: Say | undefined) => {
    if (s === undefined) return;
    const texts = typeof s === "string" ? [s] : s.map((v) => v.text);
    for (const t of texts) for (const m of t.matchAll(PLACEHOLDER)) out.push(`${m[1]}:${m[2] ?? ""}`);
    if (typeof s !== "string") for (const v of s) if (v.when) condPlaceholders(v.when, out);
  };
  addSay(c.say);
  if ("all" in c) c.all.forEach((x) => condPlaceholders(x, out));
  else if ("any" in c) c.any.forEach((x) => condPlaceholders(x, out));
  else if ("not" in c) condPlaceholders(c.not, out);
  return out;
}

export function exprDepth(e: Expr): number {
  if (typeof e !== "object") return 1;
  if ("avg" in e) return 1 + Math.max(...e.avg.map(exprDepth));
  if ("min" in e) return 1 + Math.max(...e.min.map(exprDepth));
  if ("max" in e) return 1 + Math.max(...e.max.map(exprDepth));
  if ("sum" in e) return 1 + Math.max(...e.sum.map(exprDepth));
  if ("diff" in e) return 1 + Math.max(...e.diff.map(exprDepth));
  if ("ratio" in e) return 1 + Math.max(...e.ratio.map(exprDepth));
  if ("scale" in e) return 1 + exprDepth(e.scale.expr);
  if ("if" in e) return 1 + Math.max(condDepth(e.if.cond), exprDepth(e.if.then), e.if.else === undefined ? 0 : exprDepth(e.if.else));
  return 1 + Math.max(...e.coalesce.map(exprDepth));
}

export function condDepth(c: Cond): number {
  if ("all" in c) return 1 + Math.max(...c.all.map(condDepth));
  if ("any" in c) return 1 + Math.max(...c.any.map(condDepth));
  if ("not" in c) return 1 + condDepth(c.not);
  if ("known" in c) return 1 + exprDepth(c.known);
  return 1 + exprDepth(c.expr);
}
