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

/** "15-minute momentum" and "hourly momentum" read as "15-minute and hourly momentum". */
function mergedLabels(scope: Scope, xs: Expr[]): string {
  const names = xs.map((x) => exprText(scope, x));
  if (xs.every((x) => typeof x === "string") && names.length > 1) {
    const last = names.map((n) => n.split(" ").slice(-1)[0]);
    if (last.every((w) => w === last[0]) && names.every((n) => n.includes(" "))) return `${list(names.map((n) => n.split(" ").slice(0, -1).join(" ")))} ${last[0]}`;
  }
  return list(names);
}

export function exprText(scope: Scope, e: Expr): string {
  if (typeof e === "string") return inline(catalogField(scope, e)?.label ?? e);
  if (typeof e === "number") return num(e);
  const t = (x: Expr) => exprText(scope, x);
  if ("avg" in e) return `the average of ${mergedLabels(scope, e.avg)}`;
  if ("min" in e) return e.min.length === 2 ? `the lower of ${mergedLabels(scope, e.min)}` : `the lowest of ${mergedLabels(scope, e.min)}`;
  if ("max" in e) return e.max.length === 2 ? `the higher of ${mergedLabels(scope, e.max)}` : `the highest of ${mergedLabels(scope, e.max)}`;
  if ("sum" in e) return e.sum.map(t).join(" plus ");
  if ("diff" in e) return `${t(e.diff[0])} minus ${t(e.diff[1])}`;
  if ("ratio" in e) return `${t(e.ratio[0])} divided by ${t(e.ratio[1])}`;
  if ("scale" in e) return `${t(e.scale.expr)} on a 0 to 1 scale from ${num(e.scale.from)} to ${num(e.scale.to)}`;
  if ("if" in e) return `${t(e.if.then)} if ${condText(scope, e.if.cond)}, otherwise ${e.if.else === undefined ? "unknown" : t(e.if.else)}`;
  const [first, ...rest] = e.coalesce;
  return rest.reduce<string>((acc, x) => `${acc} (${typeof x === "number" ? `${num(x)} when unknown` : `or ${t(x)} when unknown`})`, t(first));
}

/** Facts stated as a clause rather than "<field> is true". */
const TRUE_PHRASE: Record<string, string> = {
  earnings_before_expiry: "earnings fall before expiry",
  ex_dividend_before_expiry: "an ex-dividend date falls before expiry",
};

/** Fields with a more natural wording for a "more than" comparison. */
const MORE_THAN: Record<string, (v: number) => string> = {
  vwap_atr_distance: (v) => `price more than ${num(v)} fifteen-minute ATRs above VWAP`,
  day_move_vs_usual: (v) => `today's move is more than ${num(v)}x its usual size`,
};

/** A condition made only of data checks (known, above zero): it guards an expression without changing its meaning. */
function isGuard(c: Cond): boolean {
  if ("all" in c) return c.all.every(isGuard);
  if ("known" in c) return true;
  return "op" in c && c.op === ">" && c.value === 0 && typeof c.expr === "string";
}

const COMPARE: Record<string, (v: string) => string> = { ">=": (v) => `${v} or more`, "<=": (v) => `${v} or less`, ">": (v) => `above ${v}`, "<": (v) => `below ${v}`, "==": (v) => `${v}`, "!=": (v) => `not ${v}` };

/** "<subject> is 60 or more", "30-day IV is above 20-day realised volatility", "<a> and <b> average 40 or more". */
function compareText(scope: Scope, c: Extract<Cond, { op: ">=" | ">" | "<=" | "<" | "==" | "!=" }>): string {
  const e = c.expr;
  const v = typeof c.value === "number" ? c.value : 0;
  if (typeof e === "string" && c.op === ">" && MORE_THAN[e]) return MORE_THAN[e](v);
  if (typeof e === "object" && "ratio" in e && typeof c.value === "number") {
    const [a, b] = e.ratio.map((x) => exprText(scope, x));
    const word = c.op === ">" ? "above" : c.op === "<" ? "below" : c.op === ">=" ? "at least" : c.op === "<=" ? "at most" : opWords(c.op);
    return v === 1 ? `${a} is ${word} ${b}` : `${a} is ${word} ${num(v)}x ${b}`;
  }
  if (typeof e === "object" && "avg" in e && (c.op === ">=" || c.op === "<=")) return `${mergedLabels(scope, e.avg)} average ${COMPARE[c.op](valueText(c.value, exprUnit(scope, e)))}`;
  if (typeof e === "object" && "min" in e && e.min.length === 2 && c.op === ">") return `both ${mergedLabels(scope, e.min)} are above ${valueText(c.value, exprUnit(scope, e))}`;
  return `${exprText(scope, e)} is ${COMPARE[c.op](valueText(c.value, exprUnit(scope, e)))}`;
}

export function condText(scope: Scope, c: Cond, nested = false): string {
  let s: string;
  if ("all" in c) s = c.all.map((x) => condText(scope, x, true)).join(" and ");
  else if ("any" in c) {
    // "IV rank 60 or more (no IV rank yet: 30-day IV above ...)": an alternative that starts "X is unknown" reads as a fallback.
    const parts = c.any.map((x, i) => {
      if (i > 0 && "all" in x && "not" in x.all[0] && "known" in x.all[0].not) {
        const rest = x.all.slice(1).filter((y) => !isGuard(y));
        return `(no ${exprText(scope, x.all[0].not.known)} yet: ${rest.map((y) => condText(scope, y, true)).join(" and ")})`;
      }
      return condText(scope, x, true);
    });
    s = parts.map((p, i) => (i > 0 && p.startsWith("(no ") ? p : i > 0 ? ` or ${p}` : p)).join(" ").replace(/\s+/g, " ");
  } else if ("not" in c) s = "known" in c.not ? `${exprText(scope, c.not.known)} is unknown` : `not (${condText(scope, c.not)})`;
  else if ("known" in c) s = `${exprText(scope, c.known)} is known`;
  else if (c.op === "between") s = `${exprText(scope, c.expr)} is between ${valueText(c.min, exprUnit(scope, c.expr))} and ${valueText(c.max, exprUnit(scope, c.expr))}`;
  else if (typeof c.value === "boolean" && (c.op === "==" || c.op === "!=")) {
    const on = c.value === (c.op === "==");
    const key = typeof c.expr === "string" ? c.expr : "";
    s = TRUE_PHRASE[key] ? (on ? TRUE_PHRASE[key] : `no: ${TRUE_PHRASE[key]}`) : (on ? "" : "no ") + exprText(scope, c.expr);
  } else s = compareText(scope, c);
  return nested && ("all" in c || "any" in c) ? `(${s})` : s;
}

/** One gate as a sentence, without the label. */
export const gateLine = (c: Cond): string => `${condText("option", c)}.`;

const word = (n: number): string => (n >= 1 ? "full" : n <= 0 ? "none" : num(n));

/** Describes a 0-to-1 share: a scale, an alternative chain (coalesce) or a conditional of those. */
function shareText(scope: Scope, e: Expr): string {
  if (typeof e === "number") return word(e);
  if (typeof e === "object" && "scale" in e) {
    const inner = e.scale.expr;
    if (typeof inner === "object" && "ratio" in inner) {
      const [a, b] = inner.ratio.map((x) => exprText(scope, x));
      return `${a} from ${num(e.scale.from)}x (none) to ${num(e.scale.to)}x (full) of ${b}`;
    }
    return `${exprText(scope, inner)} from ${num(e.scale.from)} (none) to ${num(e.scale.to)} (full)`;
  }
  if (typeof e === "object" && "coalesce" in e) {
    const [first, ...rest] = e.coalesce;
    const f = typeof first === "object" && "scale" in first && typeof first.scale.expr === "string" ? first.scale.expr : null;
    const lead = f ? `With no ${exprText(scope, f)} yet: ` : "When that is unknown: ";
    return [shareText(scope, first), ...rest.map((x) => `${lead}${shareText(scope, x)}`)].join(". ");
  }
  if (typeof e === "object" && "if" in e) {
    const { cond, then, else: els } = e.if;
    if (els === undefined) return isGuard(cond) ? shareText(scope, then) : `${shareText(scope, then)} when ${condText(scope, cond)}`;
    if (typeof then === "number" && typeof els === "number") return `${word(then)} when ${condText(scope, cond)}, else ${word(els)}`;
    return `${shareText(scope, then)} when ${condText(scope, cond)}, otherwise ${shareText(scope, els)}`;
  }
  return exprText(scope, e);
}

const isShare = (e: Expr): boolean => typeof e === "object" && ("scale" in e || "coalesce" in e || "if" in e);
const tag = (label: string, text: string): string => (inline(label) === text ? "" : ` (${inline(label)})`);
/** "for momentum", but "when options are cheap" for a label that is itself a clause. */
const forLabel = (label: string): string => (/ (is|are) /i.test(label) ? `when ${inline(label)}` : `for ${inline(label)}`);

/** A term that adds nothing and only puts a sentence in the reasons. */
export const isNote = (t: Term): boolean => t.points === 0;

export function termLine(t: Term): string {
  if ("expr" in t) {
    const e = t.expr;
    if (isShare(e)) return `Up to ${signed(t.points)} ${forLabel(t.label)}: ${shareText("option", e)}.`;
    return `${signed(t.points)} times ${exprText("option", e)}${tag(t.label, exprText("option", e))}.`;
  }
  const when = condText("option", t.cond);
  return t.points === 0 ? `Note, no points: ${inline(t.label)}, when ${when}.` : `${signed(t.points)} when ${when}${tag(t.label, when)}.`;
}

export function penaltyLine(p: Penalty): string {
  if ("cond" in p) {
    return `-${num(p.points)} when ${condText("option", p.cond)}.`;
  }
  return `-${num(p.pointsEach)} for each of these signs (${inline(p.label)}), at most -${num(p.cap)}: ${p.signs.map((s) => condText("option", s)).join("; ")}.`;
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
    for (const g of s.gates) out.push(`- Gate · ${g.label}: ${gateLine(g)}`);
    out.push(`- Score: starts at ${num(s.base)}.`);
    for (const t of s.terms.filter((x) => !isNote(x))) out.push(`  - ${termLine(t)}`);
    if (s.penalties.length > 0) {
      out.push("- Penalties:");
      for (const p of s.penalties) out.push(`  - ${penaltyLine(p)}`);
    }
    for (const t of s.terms.filter(isNote)) out.push(`- ${termLine(t)}`);
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
    "FACTORS (each stock is ranked 0 to 100 against its sector peers, unless noted)",
    `- With fewer than ${d.minPeers} sector peers that have data, the whole market is the comparison.`,
    `- Momentum is skipped when the last daily bar is more than ${d.staleBarDays} days old.`,
  ];
  for (const g of STOCK_GROUPS) {
    const fs = d.factors.filter((f) => f.group === g);
    if (fs.length > 0) out.push(`- ${cap(GROUP_LABELS[g])}: ${fs.map(factorNote).join(", ")}.`);
  }
  out.push(
    `- In market hours the momentum group also uses ${d.liveFactors.map((f) => `${factorBase(f.key)?.label ?? f.key}${f.include ? "" : " (off)"}`).join(", ")}.`,
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
    `- List the top ${d.listing.top} by stock score, one per company.`,
    `- A stock needs data for at least ${num(d.listing.minCoverage * 100)}% of its factors.`,
    `- Earnings within ${d.listing.earningsFlagDays} days are flagged on the idea.`
  );
  return out.join("\n");
}

/** The text of a definition. */
export function render(def: Definition): string {
  return def.kind === "option" ? optionText(def) : stockText(def);
}
