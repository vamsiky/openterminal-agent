import { catalogField, type Scope } from "./catalog.js";
import type { Cond, Expr } from "./dsl.js";
import { GROUP_LABELS, STOCK_GROUPS } from "./factors.js";
import { gateLine, opWords, penaltyLine, termLine, condText, exprUnit, factorNote } from "./render.js";
import { factorBase } from "./stock-engine.js";
import { STRATEGY_KEYS, parseDefinition, type Definition, type StockDefinition } from "./schema.js";

// Every number, switch and choice in a definition, as a flat list of leaves. Settings (formOf), edits
// (applyForm) and the structural diff are all built on it, so a term or penalty added later is covered.

export type LeafValue = number | boolean | string | null;
export type Leaf = {
  /** Where it lives, with array indexes: "strategies.long_call.terms[0].points". Edits address this. */
  path: string;
  /** The same place with items named by label, stable across reordering: used to match two versions. */
  key: string;
  section: string;
  label: string;
  value: LeafValue;
  type: "number" | "boolean" | "choice" | "text";
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  readOnly?: boolean;
  note?: string;
  /** The item the leaf belongs to (a gate, term, penalty, factor, filter), for added and removed rows. */
  item: { key: string; label: string; line?: string };
};

type Bounds = { min: number; max: number; step: number };
const UNIT_BOUNDS: Record<string, Bounds> = {
  score_0_100: { min: 0, max: 100, step: 1 },
  score_pm100: { min: -100, max: 100, step: 1 },
  pct: { min: -1000, max: 1000, step: 0.01 },
  ratio: { min: -1000, max: 1000, step: 0.1 },
  x: { min: -100, max: 100, step: 0.1 },
  usd: { min: 0, max: 10_000_000, step: 1 },
  days: { min: 0, max: 3650, step: 1 },
  count: { min: 0, max: 1_000_000, step: 1 },
  bool: { min: 0, max: 1, step: 1 },
};
const GENERIC: Bounds = { min: -1_000_000, max: 1_000_000, step: 0.1 };
const boundsFor = (unit: string | undefined): Bounds => (unit ? (UNIT_BOUNDS[unit] ?? GENERIC) : GENERIC);

type Walker = { scope: Scope; emit: (rel: string, relKey: string, leaf: Omit<Leaf, "path" | "key" | "section" | "item">) => void };

function walkExpr(w: Walker, e: Expr, path: string, key: string, label: string, unit: string | undefined): void {
  if (typeof e === "string") return;
  if (typeof e === "number") {
    const b = boundsFor(unit);
    w.emit(path, key, { label, value: e, type: "number", unit: unit ?? "", ...b });
    return;
  }
  const arr = (xs: Expr[], name: string) => xs.forEach((x, i) => walkExpr(w, x, `${path}.${name}[${i}]`, `${key}.${name}[${i}]`, label, unit));
  if ("avg" in e) arr(e.avg, "avg");
  else if ("min" in e) arr(e.min, "min");
  else if ("max" in e) arr(e.max, "max");
  else if ("sum" in e) arr(e.sum, "sum");
  else if ("diff" in e) arr(e.diff, "diff");
  else if ("ratio" in e) arr(e.ratio, "ratio");
  else if ("scale" in e) {
    const u = exprUnit(w.scope, e.scale.expr) ?? unit;
    const b = boundsFor(u);
    w.emit(`${path}.scale.from`, `${key}.scale.from`, { label: `${label}: none at`, value: e.scale.from, type: "number", unit: u ?? "", ...b });
    w.emit(`${path}.scale.to`, `${key}.scale.to`, { label: `${label}: full at`, value: e.scale.to, type: "number", unit: u ?? "", ...b });
    walkExpr(w, e.scale.expr, `${path}.scale.expr`, `${key}.scale.expr`, label, u);
  } else if ("if" in e) {
    walkCond(w, e.if.cond, `${path}.if.cond`, `${key}.if.cond`, label);
    walkExpr(w, e.if.then, `${path}.if.then`, `${key}.if.then`, label, unit);
    if (e.if.else !== undefined) walkExpr(w, e.if.else, `${path}.if.else`, `${key}.if.else`, label, unit);
  } else arr(e.coalesce, "coalesce");
}

function condName(scope: Scope, c: Cond, fallback: string): string {
  if (c.label) return c.label;
  if ("expr" in c && typeof c.expr === "string") return catalogField(scope, c.expr)?.label ?? fallback;
  if ("known" in c && typeof c.known === "string") return catalogField(scope, c.known)?.label ?? fallback;
  return fallback;
}

function walkCond(w: Walker, c: Cond, path: string, key: string, label: string): void {
  if ("all" in c) c.all.forEach((x, i) => walkCond(w, x, `${path}.all[${i}]`, `${key}.all[${i}]`, `${label} · ${condName(w.scope, x, String(i + 1))}`));
  else if ("any" in c) c.any.forEach((x, i) => walkCond(w, x, `${path}.any[${i}]`, `${key}.any[${i}]`, `${label} · ${condName(w.scope, x, String(i + 1))}`));
  else if ("not" in c) walkCond(w, c.not, `${path}.not`, `${key}.not`, label);
  else if ("known" in c) walkExpr(w, c.known, `${path}.known`, `${key}.known`, label, undefined);
  else {
    const unit = exprUnit(w.scope, c.expr);
    if (c.op === "between") {
      const b = boundsFor(unit);
      w.emit(`${path}.min`, `${key}.min`, { label: `${label}: from`, value: c.min, type: "number", unit: unit ?? "", ...b });
      w.emit(`${path}.max`, `${key}.max`, { label: `${label}: to`, value: c.max, type: "number", unit: unit ?? "", ...b });
    } else if (typeof c.value === "boolean") {
      w.emit(`${path}.value`, `${key}.value`, { label: `${label}: ${c.op === "==" ? "is" : "is not"}`, value: c.value, type: "boolean", unit: "bool" });
    } else {
      w.emit(`${path}.value`, `${key}.value`, { label: `${label}: ${opWords(c.op)}`, value: c.value, type: "number", unit: unit ?? "", ...boundsFor(unit) });
    }
    walkExpr(w, c.expr, `${path}.expr`, `${key}.expr`, label, unit);
  }
}

const pt = (label: string, value: number, extra: Partial<Leaf> = {}): Omit<Leaf, "path" | "key" | "section" | "item"> => ({ label, value, type: "number", unit: "points", min: 0, max: 100, step: 1, ...extra });

/** Every leaf of a definition, in display order. */
export function leavesOf(def: Definition): Leaf[] {
  const out: Leaf[] = [];
  const at = (section: string, item: Leaf["item"], path: string, key: string, leaf: Omit<Leaf, "path" | "key" | "section" | "item">) => out.push({ ...leaf, path, key, section, item });
  const scalar = (section: string, path: string, leaf: Omit<Leaf, "path" | "key" | "section" | "item">) => at(section, { key: path, label: leaf.label }, path, path, leaf);

  if (def.kind === "option") {
    const l = def.listing;
    scalar("Listing", "listing.minScore", pt("List a setup when it scores at least", l.minScore, { unit: "score_0_100" }));
    scalar("Listing", "listing.early.ivHistoryDaysBelow", pt("While IV history is under (days)", l.early.ivHistoryDaysBelow, { unit: "days", max: 252 }));
    scalar("Listing", "listing.early.minScore", pt("...list it from", l.early.minScore, { unit: "score_0_100" }));
    scalar("Listing", "listing.maxIdeas", pt("Show at most (ideas)", l.maxIdeas, { unit: "count", min: 1, max: 100 }));
    scalar("Listing", "listing.missesToDrop", pt("Drop after missing (scans in a row)", l.missesToDrop, { unit: "count", min: 1, max: 20 }));
    scalar("Listing", "listing.nearMissFrom", pt("Keep near misses from (empty = off)", l.nearMissFrom as number, { unit: "score_0_100", note: "Setups at or above this that are not listed are kept for the Ideas tab. Must be below the listing score." }));
    for (const k of STRATEGY_KEYS) {
      const s = def.strategies[k];
      const sec = s.label;
      const base = `strategies.${k}`;
      scalar(sec, `${base}.enabled`, { label: "Enabled", value: s.enabled, type: "boolean", unit: "bool" });
      scalar(sec, `${base}.contract`, { label: "Contract", value: s.contract === "atm_put" ? "at-the-money put" : "at-the-money call", type: "text", unit: "", readOnly: true, note: "Set by the options sweep: first expiry far enough out, at-the-money strike." });
      scalar(sec, `${base}.base`, pt("Starting score", s.base, { unit: "score_0_100" }));
      s.gates.forEach((g, i) => {
        const name = g.label ?? `Gate ${i + 1}`;
        const item = { key: `${base}.gates[${name}]`, label: `${sec} › Gate: ${name}`, line: gateLine(g) };
        const w: Walker = { scope: "option", emit: (rel, relKey, leaf) => at(sec, item, rel, relKey, leaf) };
        walkCond(w, g, `${base}.gates[${i}]`, `${base}.gates[${name}]`, name);
      });
      s.terms.forEach((t, i) => {
        const item = { key: `${base}.terms[${t.label}]`, label: `${sec} › Score: ${t.label}`, line: termLine(t) };
        const w: Walker = { scope: "option", emit: (rel, relKey, leaf) => at(sec, item, rel, relKey, leaf) };
        w.emit(`${base}.terms[${i}].points`, `${base}.terms[${t.label}].points`, { label: `${t.label}: points`, value: t.points, type: "number", unit: "points", min: -100, max: 100, step: 1 });
        if ("expr" in t) walkExpr(w, t.expr, `${base}.terms[${i}].expr`, `${base}.terms[${t.label}].expr`, t.label, undefined);
        else walkCond(w, t.cond, `${base}.terms[${i}].cond`, `${base}.terms[${t.label}].cond`, t.label);
      });
      s.penalties.forEach((p, i) => {
        const item = { key: `${base}.penalties[${p.label}]`, label: `${sec} › Penalty: ${p.label}`, line: penaltyLine(p) };
        const w: Walker = { scope: "option", emit: (rel, relKey, leaf) => at(sec, item, rel, relKey, leaf) };
        const pk = `${base}.penalties[${p.label}]`;
        if ("cond" in p) {
          w.emit(`${base}.penalties[${i}].points`, `${pk}.points`, { ...pt(`${p.label}: points off`, p.points) });
          walkCond(w, p.cond, `${base}.penalties[${i}].cond`, `${pk}.cond`, p.label);
        } else {
          w.emit(`${base}.penalties[${i}].pointsEach`, `${pk}.pointsEach`, pt(`${p.label}: points off per sign`, p.pointsEach));
          w.emit(`${base}.penalties[${i}].cap`, `${pk}.cap`, pt(`${p.label}: at most`, p.cap));
          p.signs.forEach((c, j) => walkCond(w, c, `${base}.penalties[${i}].signs[${j}]`, `${pk}.signs[${j}]`, `${p.label} · ${condName("option", c, String(j + 1))}`));
        }
      });
    }
    return out;
  }

  const d: StockDefinition = def;
  d.factors.forEach((f, i) => {
    const base = factorBase(f.key);
    const item = { key: `factors[${f.key}]`, label: `Factors › ${base?.label ?? f.key}`, line: factorNote(f) };
    const sec = `Factors · ${cap(GROUP_LABELS[f.group])}`;
    const name = base?.label ?? f.key;
    at(sec, item, `factors[${i}].include`, `factors[${f.key}].include`, { label: `${name}: include`, value: f.include, type: "boolean", unit: "bool" });
    at(sec, item, `factors[${i}].direction`, `factors[${f.key}].direction`, { label: `${name}: better when`, value: f.direction, type: "choice", unit: "", options: ["higher", "lower"] });
    at(sec, item, `factors[${i}].positiveOnly`, `factors[${f.key}].positiveOnly`, { label: `${name}: losses score worst`, value: f.positiveOnly, type: "boolean", unit: "bool" });
    at(sec, item, `factors[${i}].rankAgainst`, `factors[${f.key}].rankAgainst`, { label: `${name}: ranked against`, value: f.rankAgainst, type: "choice", unit: "", options: ["sector", "market"] });
  });
  d.liveFactors.forEach((f, i) => {
    const name = factorBase(f.key)?.label ?? f.key;
    const item = { key: `liveFactors[${f.key}]`, label: `Live factors › ${name}`, line: `${name}${f.include ? "" : " (off)"}` };
    at("Live factors", item, `liveFactors[${i}].include`, `liveFactors[${f.key}].include`, { label: `${name}: include`, value: f.include, type: "boolean", unit: "bool" });
  });
  for (const g of STOCK_GROUPS) scalar("Weights", `groupWeights.${g}`, { label: `${cap(GROUP_LABELS[g])} weight`, value: d.groupWeights[g], type: "number", unit: "weight", min: 0, max: 1, step: 0.05 });
  scalar("Scoring", "minPeers", { label: "Sector peers needed", value: d.minPeers, type: "number", unit: "count", min: 1, max: 200, step: 1 });
  scalar("Scoring", "staleBarDays", { label: "Skip momentum after (days without a bar)", value: d.staleBarDays, type: "number", unit: "days", min: 1, max: 60, step: 1 });
  d.filters.forEach((f, i) => {
    const name = f.label ?? `Filter ${i + 1}`;
    const item = { key: `filters[${name}]`, label: `Filters › ${name}`, line: `${condText("stock", f)}.` };
    const w: Walker = { scope: "stock", emit: (rel, relKey, leaf) => at("Filters", item, rel, relKey, leaf) };
    walkCond(w, f, `filters[${i}]`, `filters[${name}]`, name);
  });
  scalar("Listing", "listing.top", { label: "List the top (stocks)", value: d.listing.top, type: "number", unit: "count", min: 1, max: 100, step: 1 });
  scalar("Listing", "listing.minCoverage", { label: "Minimum data coverage", value: d.listing.minCoverage, type: "number", unit: "pct", min: 0, max: 1, step: 0.05 });
  scalar("Listing", "listing.earningsFlagDays", { label: "Flag earnings within (days)", value: d.listing.earningsFlagDays, type: "number", unit: "days", min: 0, max: 120, step: 1 });
  return out;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// ---- settings form ----

export type FormItem = {
  path: string;
  label: string;
  value: LeafValue;
  type: Leaf["type"];
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string;
  options: string[] | null;
  readOnly: boolean;
  note: string | null;
};
export type FormSection = { section: string; items: FormItem[] };

/** The Settings view: every numeric, boolean and choice leaf, grouped by section. */
export function formOf(def: Definition): FormSection[] {
  const sections: FormSection[] = [];
  for (const l of leavesOf(def)) {
    let s = sections.find((x) => x.section === l.section);
    if (!s) sections.push((s = { section: l.section, items: [] }));
    s.items.push({
      path: l.path,
      label: l.label,
      value: l.value,
      type: l.type,
      min: l.min ?? null,
      max: l.max ?? null,
      step: l.step ?? null,
      unit: l.unit,
      options: l.options ?? null,
      readOnly: l.readOnly === true,
      note: l.note ?? null,
    });
  }
  return sections;
}

export type FormEdit = { path: string; value: LeafValue };
export type ApplyResult = { ok: true; def: Definition } | { ok: false; errors: string[] };

/** Sets the edited leaves on a copy of the definition (version and parent untouched) and validates it. */
export function applyForm(def: Definition, edits: FormEdit[]): ApplyResult {
  const leaves = new Map(leavesOf(def).map((l) => [l.path, l]));
  const copy = structuredClone(def) as unknown as Record<string, unknown>;
  const errors: string[] = [];
  for (const e of edits) {
    const leaf = leaves.get(e.path);
    if (!leaf) {
      errors.push(`${e.path}: no such setting`);
      continue;
    }
    if (leaf.readOnly) {
      errors.push(`${leaf.label}: read-only (${leaf.note ?? "fixed"})`);
      continue;
    }
    const nullable = e.path === "listing.nearMissFrom";
    if (e.value === null && nullable) {
      setPath(copy, e.path, null);
      continue;
    }
    if (leaf.type === "number") {
      if (typeof e.value !== "number" || !Number.isFinite(e.value)) errors.push(`${leaf.label}: must be a number`);
      else if ((leaf.min !== undefined && e.value < leaf.min) || (leaf.max !== undefined && e.value > leaf.max)) errors.push(`${leaf.label}: must be between ${leaf.min} and ${leaf.max}`);
      else setPath(copy, e.path, e.value);
    } else if (leaf.type === "boolean") {
      if (typeof e.value !== "boolean") errors.push(`${leaf.label}: must be true or false`);
      else setPath(copy, e.path, e.value);
    } else if (leaf.type === "choice") {
      if (typeof e.value !== "string" || !leaf.options?.includes(e.value)) errors.push(`${leaf.label}: must be one of ${leaf.options?.join(", ")}`);
      else setPath(copy, e.path, e.value);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return parseDefinition(copy);
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(/\.|\[(\d+)\]/).filter((p): p is string => p !== undefined && p !== "");
  let node: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    node = (node as Record<string | number, unknown>)[p];
  }
  const last = parts[parts.length - 1];
  (node as Record<string | number, unknown>)[/^\d+$/.test(last) ? Number(last) : last] = value;
}

// ---- structural diff ----

export type DiffRow = { path: string; label: string; from: string | null; to: string | null; change: "changed" | "added" | "removed" };

function shown(l: Leaf): string {
  const v = l.value;
  if (v === null) return "off";
  if (typeof v === "boolean") return l.label.endsWith(": include") || l.label === "Enabled" ? (v ? "on" : "off") : v ? "yes" : "no";
  if (typeof v === "number") {
    if (l.unit === "weight" || (l.unit === "pct" && l.max === 1)) return `${+(v * 100).toFixed(2)}%`;
    return String(+v.toFixed(4));
  }
  return String(v);
}

/** What differs between two definitions, with human labels and formatted values; computed in code. */
export function diff(a: Definition, b: Definition): DiffRow[] {
  const la = leavesOf(a);
  const lb = leavesOf(b);
  const byKeyA = new Map(la.map((l) => [l.key, l]));
  const itemsA = new Map(la.map((l) => [l.item.key, l.item]));
  const itemsB = new Map(lb.map((l) => [l.item.key, l.item]));
  const rows: DiffRow[] = [];
  const changedItems = new Set<string>();
  for (const l of lb) {
    if (!itemsA.has(l.item.key)) continue;
    const old = byKeyA.get(l.key);
    if (!old) continue;
    if (JSON.stringify(old.value) !== JSON.stringify(l.value)) {
      rows.push({ path: l.path, label: `${l.section} › ${l.label}`, from: shown(old), to: shown(l), change: "changed" });
      changedItems.add(l.item.key);
    }
  }
  for (const [key, item] of itemsB) {
    const before = itemsA.get(key);
    if (!before) rows.push({ path: lb.find((l) => l.item.key === key)!.path, label: item.label, from: null, to: item.line ?? null, change: "added" });
    else if (!changedItems.has(key) && before.line !== item.line) rows.push({ path: lb.find((l) => l.item.key === key)!.path, label: item.label, from: before.line ?? null, to: item.line ?? null, change: "changed" });
  }
  for (const [key, item] of itemsA) {
    if (!itemsB.has(key)) rows.push({ path: la.find((l) => l.item.key === key)!.path, label: item.label, from: item.line ?? null, to: null, change: "removed" });
  }
  return rows;
}
