// Scan Lab response shapes (spec §3 and §4) and the pure helpers behind the panel. The web app does not import server code.

export type ScanKind = "stock" | "option";
export type DefStatus = "active" | "draft" | "previous" | "retired" | "discarded";
export type DefAuthor = "built-in" | "form" | "claude";

export type CatalogField = {
  key: string;
  scope: ScanKind;
  label: string;
  unit: string;
  description: string;
  source: string;
  group: string;
};

export type DefMeta = {
  id: number;
  kind: ScanKind;
  version: string;
  status: DefStatus;
  parentId: number | null;
  author: DefAuthor;
  sourceText: string | null;
  notes: unknown;
  createdAt: string;
  promotedAt: string | null;
};
export type DefsResponse = { active: DefMeta | null; draft: DefMeta | null; versions: DefMeta[] };

export type LeafValue = number | boolean | string | null;
export type FormItem = {
  path: string;
  label: string;
  value: LeafValue;
  type: "number" | "boolean" | "choice" | "text";
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string;
  options: string[] | null;
  readOnly: boolean;
  note: string | null;
};
export type FormSection = { section: string; items: FormItem[] };
export type DiffRow = { path: string; label: string; from: string | null; to: string | null; change: "changed" | "added" | "removed" };
export type FormEdit = { path: string; value: LeafValue };

export type NeedsCode = { request: string; reason: string };
export type LineAction = "applied" | "needs_code" | "no_change" | "refused";
/** What Claude did with one changed line of the text; `text` is shown when the server sends it. */
export type LineOutcome = { n: number; action: LineAction; explanation: string; text?: string; change?: "added" | "removed" | "changed"; was?: string };
export type DraftNotes = { notes: string[]; needsCode: NeedsCode[]; lines: LineOutcome[] };

/** What one scored pass looks like: replay, each shadow pass and live all use it. */
export type ResultIdea = { symbol: string; strategy: "buy" | OptionStrategy; contract: string | null; score: number; rank: number };
export type OptionStrategy = "long_call" | "short_put" | "covered_call";
/** Options steps carry their strategy; stock steps have none. */
export type FunnelStep = { step: string; count: number; strategy?: OptionStrategy };
export type ScanResult = {
  at: string;
  scanned: number;
  ideas: ResultIdea[];
  nearMisses: ResultIdea[];
  funnel: FunnelStep[];
  spread: Array<{ bucket: string; count: number }>;
};
export type ShadowPass = { at: string; live: ScanResult; draft: ScanResult };
/** The latest stored replay (live and draft scored on one stored pass). */
export type ReplayRow = { id: number; defId: number; kind: ScanKind; source: "replay"; passAt: string; createdAt: string; live: ScanResult; draft: ScanResult };
/** Passes are newest first. */
export type ShadowView = { on: boolean; startedAt: string | null; count: number; passes: ShadowPass[] };
export type DefTests = { replay: ReplayRow | null; shadow: ShadowView };

export type DefView = {
  meta: DefMeta;
  definition: unknown;
  text: string;
  form: FormSection[];
  diff: DiffRow[];
  tests?: DefTests;
};

export type RankChange = { symbol: string; strategy: ResultIdea["strategy"]; from: number; to: number; scoreFrom: number; scoreTo: number };
export type Compare = {
  source: "replay" | "shadow";
  at: string;
  live: ScanResult;
  draft: ScanResult;
  added: ResultIdea[];
  removed: ResultIdea[];
  rankChanges: RankChange[];
};

export type BuildJob = {
  status: "running" | "done" | "error";
  draftId: number | null;
  notes: string[] | null;
  needsCode: NeedsCode[] | null;
  error: string | null;
  /** The text asked for something the fixed rules forbid (long puts, spreads, naked calls, orders). */
  refused: boolean;
  lines?: LineOutcome[];
};

export const KIND_LABEL: Record<ScanKind, string> = { stock: "Stock scan", option: "Options scan" };

/** Schedule wording from server/src/quant/jobs.ts. */
export const SCHEDULE: Record<ScanKind, string> = {
  stock: "Nightly at 07:00 and 16:30 ET on weekdays · every 15 min in market hours",
  option: "Every 5 min in market hours",
};

const unix = (t: string) => t.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();

/** True when the textarea differs from the text it was seeded with (trailing whitespace ignored). */
export function isEdited(text: string, base: string): boolean {
  return unix(text) !== unix(base);
}

/** A built draft goes stale when the text changed after Claude read it. Form drafts have no source text. */
export function isStale(text: string, draft: Pick<DefMeta, "author" | "sourceText"> | null): boolean {
  if (!draft || draft.author !== "claude" || draft.sourceText === null) return false;
  return isEdited(text, draft.sourceText);
}

/** The text the editor should start with: the open Claude draft's source text, else the active definition's. */
export function seedText(activeText: string, draft: Pick<DefMeta, "author" | "sourceText"> | null): string {
  return draft?.author === "claude" && draft.sourceText !== null ? draft.sourceText : activeText;
}

/** Bar width in percent; a non-zero count never vanishes. */
export function barWidth(count: number, max: number, floor = 1.5): number {
  if (!(count > 0) || !(max > 0)) return 0;
  return Math.min(100, Math.max(floor, (count / max) * 100));
}

export type GateRow = { strategy: OptionStrategy | null; step: string; live: number | null; draft: number | null };

/** Funnel steps of both results side by side, keyed on strategy and step, in draft order then any live-only steps. */
export function mergeFunnel(live: FunnelStep[] | undefined, draft: FunnelStep[] | undefined): GateRow[] {
  const key = (f: FunnelStep) => `${f.strategy ?? ""}|${f.step}`;
  const l = new Map((live ?? []).map((f) => [key(f), f.count]));
  const d = new Map((draft ?? []).map((f) => [key(f), f.count]));
  const seen = new Set<string>();
  const rows: GateRow[] = [];
  for (const f of [...(draft ?? []), ...(live ?? [])]) {
    if (seen.has(key(f))) continue;
    seen.add(key(f));
    rows.push({ strategy: f.strategy ?? null, step: f.step, live: l.get(key(f)) ?? null, draft: d.get(key(f)) ?? null });
  }
  return rows;
}

export const STRATEGY_HEADING: Record<OptionStrategy, string> = {
  long_call: "Buy a call",
  short_put: "Sell a cash-secured put",
  covered_call: "Sell a covered call",
};

/** Funnel rows grouped by strategy in first-seen order; stock steps (no strategy) form one group with a null heading. */
export function groupFunnel(rows: GateRow[]): Array<{ strategy: OptionStrategy | null; rows: GateRow[] }> {
  const groups: Array<{ strategy: OptionStrategy | null; rows: GateRow[] }> = [];
  for (const r of rows) {
    let g = groups.find((x) => x.strategy === r.strategy);
    if (!g) groups.push((g = { strategy: r.strategy, rows: [] }));
    g.rows.push(r);
  }
  return groups;
}

export type SpreadRow = { bucket: string; live: number; draft: number };

/** Score buckets of both results side by side, in the order the API lists them. */
export function mergeSpread(live: ScanResult["spread"] | undefined, draft: ScanResult["spread"] | undefined): SpreadRow[] {
  const l = new Map((live ?? []).map((s) => [s.bucket, s.count]));
  const d = new Map((draft ?? []).map((s) => [s.bucket, s.count]));
  const buckets = [...new Set([...(draft ?? []).map((s) => s.bucket), ...(live ?? []).map((s) => s.bucket)])];
  return buckets.map((bucket) => ({ bucket, live: l.get(bucket) ?? 0, draft: d.get(bucket) ?? 0 }));
}

export const ideaKey = (i: Pick<ResultIdea, "symbol" | "strategy">) => `${i.symbol}:${i.strategy}`;

/** Tag shown next to a draft idea: "new", "↑3", "↓2" or nothing when it holds its place. */
export function ideaTag(idea: ResultIdea, added: ResultIdea[], rankChanges: RankChange[]): { text: string; tone: "new" | "up" | "down" | "" } {
  const k = ideaKey(idea);
  if (added.some((a) => ideaKey(a) === k)) return { text: "new", tone: "new" };
  const rc = rankChanges.find((r) => ideaKey(r) === k);
  if (!rc || rc.from === rc.to) return { text: "", tone: "" };
  return rc.to < rc.from ? { text: `↑${rc.from - rc.to}`, tone: "up" } : { text: `↓${rc.to - rc.from}`, tone: "down" };
}

/** Which of the draft's ideas passed the live pass (added) or dropped from it (removed), as one line. */
export function changesLine(added: ResultIdea[], removed: ResultIdea[]): string {
  const names = (xs: ResultIdea[]) => [...new Set(xs.map((x) => x.symbol))].join(", ");
  const parts: string[] = [];
  if (added.length) parts.push(`${names(added)} come${added.length === 1 ? "s" : ""} in`);
  if (removed.length) parts.push(`${names(removed)} drop${removed.length === 1 ? "s" : ""} out`);
  return parts.length ? `In the draft's list: ${parts.join("; ")}.` : "The draft lists the same ideas as live.";
}

/** The "Near misses · scored 55 to 65 · 13" group title. */
export function nearMissTitle(count: number, from: number, to: number): string {
  return `Near misses · scored ${from} to ${to} · ${count}`;
}

/** The score range an option definition keeps near misses for, or null when it keeps none. */
export function nearMissRange(definition: unknown): { from: number; to: number } | null {
  const l = (definition as { listing?: { nearMissFrom?: unknown; minScore?: unknown } } | null)?.listing;
  return typeof l?.nearMissFrom === "number" && typeof l.minScore === "number" ? { from: l.nearMissFrom, to: l.minScore } : null;
}

// ---- settings form ----

/** Weights and fractional percentages are stored as fractions but edited as percent. */
export const isPercentItem = (it: Pick<FormItem, "unit" | "max">) => it.unit === "weight" || (it.unit === "pct" && it.max === 1);

/** A form value as shown in a cell: "20%", "ATM", "off", "yes". */
export function formatItem(it: FormItem, value: LeafValue = it.value): string {
  if (value === null || value === "") return "off";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return isPercentItem(it) ? `${+(value * 100).toFixed(2)}%` : String(+value.toFixed(4));
  return value;
}

/** What goes in the input box for a form value. */
export function inputValue(it: FormItem, value: LeafValue): string {
  if (value === null) return "";
  if (typeof value === "number") return isPercentItem(it) ? String(+(value * 100).toFixed(2)) : String(value);
  return String(value);
}

/** Parses an input box back to a form value; undefined when it isn't valid. An empty box is off for nullable numbers. */
export function parseInput(it: FormItem, raw: string): LeafValue | undefined {
  if (it.type === "boolean") return raw === "true";
  if (it.type !== "number") return raw;
  const s = raw.trim();
  if (s === "") return it.value === null || it.path === "listing.nearMissFrom" ? null : undefined;
  const n = Number(s);
  if (!isFinite(n)) return undefined;
  return isPercentItem(it) ? +(n / 100).toFixed(6) : n;
}

/** The range hint shown under a number input, e.g. "0 to 100". */
export function rangeHint(it: FormItem): string | null {
  if (it.type !== "number" || it.min === null || it.max === null) return null;
  const pct = isPercentItem(it);
  const f = (n: number) => (pct ? `${+(n * 100).toFixed(2)}%` : String(n));
  return `${f(it.min)} to ${f(it.max)}`;
}

/** Whether a value is within the item's bounds; used to hold back "Save as draft" on out-of-range input. */
export function inRange(it: FormItem, value: LeafValue): boolean {
  if (it.type !== "number" || value === null || typeof value !== "number") return true;
  return (it.min === null || value >= it.min) && (it.max === null || value <= it.max);
}

/** Paths whose edited value differs from the stored one, as the body of POST /defs/draft. */
export function formEdits(form: FormSection[], edits: Record<string, LeafValue>): FormEdit[] {
  const out: FormEdit[] = [];
  for (const s of form) {
    for (const it of s.items) {
      if (it.readOnly || !(it.path in edits)) continue;
      if (JSON.stringify(edits[it.path]) !== JSON.stringify(it.value)) out.push({ path: it.path, value: edits[it.path] });
    }
  }
  return out;
}

// ---- diff, versions, build ----

export const DIFF_TAG: Record<DiffRow["change"], { text: string; tone: "chg" | "new" | "gone" }> = {
  changed: { text: "changed", tone: "chg" },
  added: { text: "added", tone: "new" },
  removed: { text: "removed", tone: "gone" },
};

/** Version list line, e.g. "Active · promoted today". */
export function versionStatus(m: DefMeta, now = Date.now()): string {
  const built = m.author === "built-in" ? "built-in settings" : m.author === "form" ? "edited in Settings" : "built by Claude";
  const day = (iso: string | null) => {
    if (!iso) return "";
    const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(" ", "T") + "Z");
    if (!isFinite(t)) return "";
    const d = Math.floor((now - t) / 86_400_000);
    return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  };
  switch (m.status) {
    case "active": return `Active · ${built}${m.promotedAt ? `, promoted ${day(m.promotedAt)}` : ""}`;
    case "draft": return `Draft · ${built}, ${day(m.createdAt) || "just now"}`;
    case "previous": return `Previous · ${built}`;
    case "retired": return `Retired ${day(m.promotedAt ?? m.createdAt)} · ${built}`;
    default: return `Discarded · ${built}`;
  }
}

export type BuildFailure = { kind: "busy" | "budget" | "disabled" | "other"; message: string };

/** A failed build request in plain words; the statuses are those /api/agents/analyze uses. */
export function buildFailure(status: number | undefined, message: string): BuildFailure {
  if (status === 409) return { kind: "busy", message: "Claude is already building a draft for this scan. Wait for it to finish, then try again." };
  if (status === 402) return { kind: "budget", message: "Today's AI budget is used up, so no new draft can be built. Settings still work, and the budget resets tomorrow." };
  if (status === 503) return { kind: "disabled", message: "AI agents are turned off, so Claude can't build drafts. Settings edits still work." };
  return { kind: "other", message };
}

export const LINE_TAG: Record<LineAction, { text: string; tone: "chg" | "gone" | "kept" }> = {
  applied: { text: "applied", tone: "chg" },
  needs_code: { text: "needs code", tone: "gone" },
  no_change: { text: "no change", tone: "kept" },
  refused: { text: "refused", tone: "gone" },
};

/** A failed build job's error in plain words; "nothing to change" becomes a sentence about the text. */
export function buildJobError(error: string | null): string {
  if (!error) return "Claude couldn't build a draft from that text.";
  if (/nothing to change|found nothing/i.test(error)) return "Your text matches the active scan; nothing to build.";
  return error;
}

/** True when a build job is polled again. */
export const buildRunning = (j: Pick<BuildJob, "status"> | undefined) => j?.status === "running";

/** Reads the notes a draft was saved with (meta.notes) when they are the {notes, needsCode} shape; anything else is empty. */
export function draftNotes(meta: Pick<DefMeta, "notes"> | null): DraftNotes {
  const n = meta?.notes;
  const o = (n && typeof n === "object" && !Array.isArray(n) ? n : {}) as Record<string, unknown>;
  const strings = Array.isArray(n) ? n : Array.isArray(o.notes) ? o.notes : [];
  const needs = Array.isArray(o.needsCode) ? o.needsCode : [];
  return {
    lines: (Array.isArray(o.lines) ? o.lines : []).filter((l): l is LineOutcome => !!l && typeof (l as LineOutcome).n === "number" && ["applied", "needs_code", "no_change", "refused"].includes((l as LineOutcome).action)),
    notes: strings.filter((x): x is string => typeof x === "string"),
    needsCode: needs.filter((x): x is NeedsCode => !!x && typeof (x as NeedsCode).request === "string").map((x) => ({ request: x.request, reason: String(x.reason ?? "") })),
  };
}

/** Pass time as "9:35 AM" for the shadow table. */
export function passTime(iso: string): string {
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(" ", "T") + "Z");
  if (!isFinite(t)) return "—";
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

/** Ideas in the draft pass that the live pass doesn't list. */
export function onlyInDraft(pass: ShadowPass): number {
  const live = new Set(pass.live.ideas.map(ideaKey));
  return pass.draft.ideas.filter((i) => !live.has(ideaKey(i))).length;
}

/** Catalog keys a definition mentions anywhere (expressions name fields as plain strings). */
export function usedKeys(definition: unknown, keys: Iterable<string>): Set<string> {
  const known = new Set(keys);
  const used = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (known.has(v)) used.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(definition);
  return used;
}
