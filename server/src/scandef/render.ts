import { catalogField, type Scope } from "./catalog.js";
import type { Cond, Expr } from "./dsl.js";
import { GROUP_LABELS, STOCK_GROUPS } from "./factors.js";
import { factorBase } from "./stock-engine.js";
import { STRATEGY_KEYS, type Definition, type OptionDefinition, type Penalty, type StockDefinition, type Term } from "./schema.js";

// The text view of a definition: a deterministic function, plain sentences built from labels and
// values. The AI never writes this text; the same definition always renders the same way.

const OPTION_SCHEDULE = "Runs every 5 minutes from 09:35 ET to the close on trading days, on the underlyings in your scan universe.";
const STOCK_SCHEDULE = "Screens the scan universe at 07:00 and 16:30 ET on weekdays and re-scores the ideas every 15 minutes in market hours. Horizon: holding for months.";

const num = (n: number): string => String(+n.toFixed(4));
const signed = (n: number): string => (n < 0 ? `-${num(-n)}` : `+${num(n)}`);

/** Lower-cases the first letter of a label for mid-sentence use, unless it starts an acronym or number. */
function inline(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

const list = (xs: string[], last = "and"): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${last} ${xs[xs.length - 1]}`);

const OP_WORDS: Record<string, string> = { ">=": "at least", ">": "above", "<=": "at most", "<": "below", "==": "equal to", "!=": "not equal to" };
export const opWords = (op: string): string => OP_WORDS[op] ?? op;

function valueText(v: number | boolean, unit: string | undefined): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (unit === "x") return `${num(v)}x`;
  if (unit === "days") return `${num(v)} day${v === 1 ? "" : "s"}`;
  if (unit === "usd") return `$${num(v)}`;
  return num(v);
}

/** The catalog unit of an expression when it reads a single field, else undefined. */
export function exprUnit(scope: Scope, e: Expr): string | undefined {
  if (typeof e === "string") return catalogField(scope, e)?.unit;
  if (typeof e === "object" && "scale" in e) return exprUnit(scope, e.scale.expr);
  if (typeof e === "object" && "coalesce" in e) return exprUnit(scope, e.coalesce[0]);
  return undefined;
}

export function exprText(scope: Scope, e: Expr): string {
  if (typeof e === "string") return inline(catalogField(scope, e)?.label ?? e);
  if (typeof e === "number") return num(e);
  const t = (x: Expr) => exprText(scope, x);
  if ("avg" in e) return `the average of ${list(e.avg.map(t))}`;
  if ("min" in e) return e.min.length === 2 ? `the lower of ${list(e.min.map(t))}` : `the lowest of ${list(e.min.map(t))}`;
  if ("max" in e) return e.max.length === 2 ? `the higher of ${list(e.max.map(t))}` : `the highest of ${list(e.max.map(t))}`;
  if ("sum" in e) return e.sum.map(t).join(" plus ");
  if ("diff" in e) return `${t(e.diff[0])} minus ${t(e.diff[1])}`;
  if ("ratio" in e) return `${t(e.ratio[0])} divided by ${t(e.ratio[1])}`;
  if ("scale" in e) return `${t(e.scale.expr)} on a 0 to 1 scale from ${num(e.scale.from)} to ${num(e.scale.to)}`;
  if ("if" in e) return `${t(e.if.then)} if ${condText(scope, e.if.cond)}, otherwise ${e.if.else === undefined ? "unknown" : t(e.if.else)}`;
  const [first, ...rest] = e.coalesce;
  return rest.reduce<string>((acc, x) => `${acc} (${typeof x === "number" ? `${num(x)} when unknown` : `or ${t(x)} when unknown`})`, t(first));
}

export function condText(scope: Scope, c: Cond, nested = false): string {
  let s: string;
  if ("all" in c) s = c.all.map((x) => condText(scope, x, true)).join(" and ");
  else if ("any" in c) s = c.any.map((x) => condText(scope, x, true)).join(" or ");
  else if ("not" in c) s = "known" in c.not ? `${exprText(scope, c.not.known)} is unknown` : `not (${condText(scope, c.not)})`;
  else if ("known" in c) s = `${exprText(scope, c.known)} is known`;
  else {
    const unit = exprUnit(scope, c.expr);
    const subject = exprText(scope, c.expr);
    if (c.op === "between") s = `${subject} is between ${valueText(c.min, unit)} and ${valueText(c.max, unit)}`;
    else if (typeof c.value === "boolean" && (c.op === "==" || c.op === "!=")) s = (c.value === (c.op === "==") ? "" : "no ") + subject;
    else s = `${subject} is ${opWords(c.op)} ${valueText(c.value, unit)}`;
  }
  return nested && ("all" in c || "any" in c) ? `(${s})` : s;
}

/** One gate as a sentence, without the label. */
export const gateLine = (c: Cond): string => `${condText("option", c)}.`;

/** Describes a 0-to-1 share: a scale, an alternative chain (coalesce) or a conditional of those. */
function shareText(scope: Scope, e: Expr): string {
  if (typeof e === "number") return `${num(e)} (${e >= 1 ? "full" : e <= 0 ? "none" : "partial"})`;
  if (typeof e === "object" && "scale" in e) return `${exprText(scope, e.scale.expr)} from ${num(e.scale.from)} (none) to ${num(e.scale.to)} (full)`;
  if (typeof e === "object" && "coalesce" in e) return e.coalesce.map((x) => shareText(scope, x)).join("; when that is unknown, ");
  if (typeof e === "object" && "if" in e) {
    const els = e.if.else === undefined ? "" : `, otherwise ${shareText(scope, e.if.else)}`;
    return `${shareText(scope, e.if.then)} when ${condText(scope, e.if.cond)}${els}`;
  }
  return exprText(scope, e);
}

const isShare = (e: Expr): boolean => typeof e === "object" && ("scale" in e || "coalesce" in e || "if" in e);
const tag = (label: string, text: string): string => (inline(label) === text ? "" : ` (${inline(label)})`);

export function termLine(t: Term): string {
  if ("expr" in t) {
    const e = t.expr;
    if (isShare(e)) return `Up to ${signed(t.points)} for ${inline(t.label)}: ${shareText("option", e)}.`;
    return `${signed(t.points)} times ${exprText("option", e)}${tag(t.label, exprText("option", e))}.`;
  }
  const when = condText("option", t.cond);
  return t.points === 0 ? `Notes when ${when}${tag(t.label, when)}; no points.` : `${signed(t.points)} when ${when}${tag(t.label, when)}.`;
}

export function penaltyLine(p: Penalty): string {
  if ("cond" in p) {
    const when = condText("option", p.cond);
    return `-${num(p.points)} when ${when}${tag(p.label, when)}.`;
  }
  return `-${num(p.pointsEach)} for each sign of ${inline(p.label)}, at most -${num(p.cap)}: ${p.signs.map((s) => condText("option", s)).join("; ")}.`;
}

function optionText(d: OptionDefinition): string {
  const l = d.listing;
  const out: string[] = [
    `OPTIONS SCAN · ${d.version}`,
    `${OPTION_SCHEDULE} Each underlying is judged on its at-the-money call and put at the first expiry far enough out (set by the options sweep). Strategies are fixed: buy calls, sell cash-secured puts, sell covered calls. Never buy puts, spreads or naked calls.`,
    "",
    "LISTING",
    `- List a setup when it scores ${num(l.minScore)} or more.`,
    `- While a name has under ${l.early.ivHistoryDaysBelow} days of IV history, list it from ${num(l.early.minScore)}.`,
    `- Show at most ${l.maxIdeas} ideas, one per symbol and strategy.`,
    `- Drop an idea after it misses ${l.missesToDrop} scan${l.missesToDrop === 1 ? "" : "s"} in a row.`,
    l.nearMissFrom === null ? "- Near misses: not shown." : `- Near misses: setups scoring ${num(l.nearMissFrom)} or more that are not listed are kept from the latest scan.`,
  ];
  for (const key of STRATEGY_KEYS) {
    const s = d.strategies[key];
    out.push("", `${s.label.toUpperCase()}${s.enabled ? "" : " (off)"}`);
    if (!s.enabled) {
      out.push("- Switched off: this strategy lists nothing.");
      continue;
    }
    out.push(`- Contract: the at-the-money ${s.contract === "atm_put" ? "put" : "call"} (set by the options sweep).`);
    if (key === "covered_call") out.push("- Only against shares you hold, 100 per contract.");
    for (const g of s.gates) out.push(`- Gate (${g.label}): ${gateLine(g)}`);
    out.push(`- Score: starts at ${num(s.base)}.`);
    for (const t of s.terms) out.push(`  - ${termLine(t)}`);
    if (s.penalties.length > 0) {
      out.push("- Penalties:");
      for (const p of s.penalties) out.push(`  - ${penaltyLine(p)}`);
    }
  }
  return out.join("\n");
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function factorNote(f: StockDefinition["factors"][number]): string {
  const base = factorBase(f.key);
  const notes: string[] = [];
  if (f.direction === "lower") notes.push("lower is better");
  if (f.positiveOnly) notes.push("losses score worst");
  if (f.rankAgainst === "market") notes.push("ranked against the whole market");
  if (!f.include) notes.push("off");
  return `${base?.label ?? f.key}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

function stockText(d: StockDefinition): string {
  const out: string[] = [
    `STOCK SCAN · ${d.version}`,
    STOCK_SCHEDULE,
    "",
    `FACTORS (each ranked 0 to 100 against the stock's sector peers unless noted; needs ${d.minPeers} peer${d.minPeers === 1 ? "" : "s"} with data, else the whole market is used; momentum is skipped when the last daily bar is over ${d.staleBarDays} days old)`,
  ];
  for (const g of STOCK_GROUPS) {
    const fs = d.factors.filter((f) => f.group === g);
    if (fs.length > 0) out.push(`- ${cap(GROUP_LABELS[g])}: ${fs.map(factorNote).join(", ")}.`);
  }
  out.push(
    `- In market hours the momentum group also uses: ${d.liveFactors.map((f) => `${factorBase(f.key)?.label ?? f.key}${f.include ? "" : " (off)"}`).join(", ")}.`,
    "",
    "WEIGHTS (groups with no data drop out and the rest re-normalise)"
  );
  for (const g of STOCK_GROUPS) out.push(`- ${cap(GROUP_LABELS[g])} ${num(d.groupWeights[g] * 100)}%`);
  if (d.filters.length > 0) {
    out.push("", "FILTERS");
    for (const f of d.filters) out.push(`- ${f.label}: ${condText("stock", f)}.`);
  }
  out.push(
    "",
    "LISTING",
    `- List the top ${d.listing.top} by composite score, one per company.`,
    `- A stock needs data for at least ${num(d.listing.minCoverage * 100)}% of its factors.`,
    `- Earnings within ${d.listing.earningsFlagDays} days are flagged on the idea.`
  );
  return out.join("\n");
}

/** The text of a definition. */
export function render(def: Definition): string {
  return def.kind === "option" ? optionText(def) : stockText(def);
}
