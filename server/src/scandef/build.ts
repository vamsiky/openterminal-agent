import { randomBytes, randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { agentsEnabled, capUsd, model } from "../agents/config.js";
import { loadPrompt } from "../agents/prompts.js";
import { canAfford, runAgent } from "../agents/runtime.js";
import { catalog, type Scope } from "./catalog.js";
import { BUILTIN_LIVE_FACTORS } from "./factors.js";
import { diff } from "./leaves.js";
import { render } from "./render.js";
import { optionDefSchema, parseDefinition, stockDefSchema, type DefKind } from "./schema.js";
import { createDraft, getActive, getById, nextVersion, type DefRecord } from "./store.js";

// "Build draft with Claude": turns the investor's edited definition text into a draft definition.
// The model proposes; code validates (zod and the catalog checks), sets version and parent, and
// stores the draft. Jobs live in memory only.

export type NeedsCode = { request: string; reason: string };
export type BuildJob = {
  id: string;
  kind: DefKind;
  status: "running" | "done" | "error";
  draftId: number | null;
  notes: string[];
  needsCode: NeedsCode[];
  error: string | null;
  /** True when the text asked for something the fixed rules forbid. */
  refused: boolean;
};
export type StartResult = { jobId: string } | "busy" | "budget" | "disabled";

export const buildOutput = z.object({
  definition: z.record(z.unknown()),
  notes: z.array(z.string()),
  needsCode: z.array(z.object({ request: z.string(), reason: z.string() })),
  refusal: z.string().nullable(),
});
export type BuildOutput = z.infer<typeof buildOutput>;

// The full definition schema goes in the prompt; the structured output only needs the envelope.
export const buildJson = {
  type: "object",
  properties: {
    definition: { type: "object", description: "the complete new definition" },
    notes: { type: "array", items: { type: "string" } },
    needsCode: { type: "array", items: { type: "object", properties: { request: { type: "string" }, reason: { type: "string" } }, required: ["request", "reason"], additionalProperties: false } },
    refusal: { type: ["string", "null"], description: "why the text was refused, or null" },
  },
  required: ["definition", "notes", "needsCode", "refusal"],
  additionalProperties: false,
};

// ---- refusal of the fixed rules ----

const FIXED_RULES = "Scan Lab only builds the three fixed strategies: buy a call, sell a cash-secured put and sell a covered call (only against shares you hold). It cannot express long puts, spreads or naked calls, and nothing in it places orders.";
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\b(?:buy(?:ing)?|long|purchase)\s+(?:a\s+|an\s+|the\s+)?puts?\b/i, "buying puts"],
  [/\b(?:bull|bear|credit|debit|vertical|calendar|diagonal|call|put)\s+spreads?\b|\biron\s+(?:condor|butterfly)|\bbutterfl(?:y|ies)\b|\bstraddles?\b|\bstrangles?\b/i, "spreads or multi-leg structures"],
  [/\bnaked\s+(?:calls?|puts?|short)|\buncovered\s+calls?\b|\bsell(?:ing)?\s+calls?\s+(?:without|with no)\s+(?:the\s+)?shares\b/i, "naked calls"],
  [/\b(?:place|submit|send|execute|stage|route)\s+(?:\w+\s+){0,2}orders?\b|\bauto[- ]?(?:trade|trading|buy|sell|execute)|\bautomatically\s+(?:trade|buy|sell|execute|place)/i, "placing orders"],
];

/** The forbidden thing a text asks for, or null. A cheap first pass; the model refuses what this misses. */
export function forbiddenIn(text: string): string | null {
  for (const [re, what] of FORBIDDEN) if (re.test(text)) return what;
  return null;
}

// ---- prompt ----

/** Stock fields that are empty in the nightly screen (the intraday factors and their scores). */
const nightlyEmpty = (): Set<string> => new Set(BUILTIN_LIVE_FACTORS.flatMap((f) => [f.key, `${f.key}_score`]));

export function catalogText(scope: Scope): string {
  const empty = scope === "stock" ? nightlyEmpty() : new Set<string>();
  return catalog(scope)
    .map((f) => `- ${f.key} | ${f.label} | ${f.unit} | ${f.description}${empty.has(f.key) ? " [EMPTY in the nightly stock screen: live factors are not there, so a filter on it never passes]" : ""}`)
    .join("\n");
}

export const dslSchema = (kind: DefKind): unknown => zodToJsonSchema(kind === "option" ? optionDefSchema : stockDefSchema, { $refStrategy: "root" });

const fence = (nonce: string, name: string, body: string): string => `<<<${name} ${nonce}\n${body}\n${name} ${nonce}>>>`;

/** The task for one build. Every piece of user-supplied text sits between nonce-tagged delimiters. */
export function buildPrompt(base: DefRecord, text: string, nonce = randomBytes(8).toString("hex")): string {
  const scope: Scope = base.kind;
  while (text.includes(nonce)) nonce = randomBytes(8).toString("hex");
  return [
    `Build a draft ${base.kind} scan definition from the investor's edited text. Return the complete new definition.`,
    `Today's base is ${base.version}; leave version and parent as in the base.`,
    `## Data catalog (${scope} scope): key | label | unit | description\nOnly these keys may appear in conditions, expressions and \`say\` placeholders.\n${catalogText(scope)}`,
    `## Definition JSON Schema (${base.kind})\n\`\`\`json\n${JSON.stringify(dslSchema(base.kind))}\n\`\`\``,
    `## Base definition (JSON)\n${fence(nonce, "UNTRUSTED_BASE_JSON", JSON.stringify(base.definition, null, 1))}`,
    `## Base definition as text (what the investor started from)\n${fence(nonce, "UNTRUSTED_BASE_TEXT", render(base.definition))}`,
    `## The investor's edited text\n${fence(nonce, "UNTRUSTED_EDITED_TEXT", text)}`,
    "Compare the edited text with the base text and change only what the edit changes.",
  ].join("\n\n");
}

// ---- jobs ----

const jobs = new Map<string, BuildJob>();
const running = new Map<DefKind, string>();
const MAX_JOBS = 50;

export const getJob = (id: string): BuildJob | null => jobs.get(id) ?? null;

/** Resolves when the job has finished; for tests. */
const finished = new Map<string, Promise<void>>();
export const jobDone = (id: string): Promise<void> => finished.get(id) ?? Promise.resolve();

function fail(job: BuildJob, error: string, extra: Partial<BuildJob> = {}): void {
  Object.assign(job, { status: "error", error }, extra);
}

const budgetMessage = "daily AI budget reached";

/** Runs the model, validates, and retries once with the errors. Returns the candidate or the failure. */
async function produce(base: DefRecord, text: string, job: BuildJob): Promise<{ output: BuildOutput; def: ReturnType<typeof parseDefinition> & { ok: true } } | null> {
  const system = loadPrompt("scanlab");
  const prompt = buildPrompt(base, text);
  const version = nextVersion(base.kind);
  let extra = "";
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!canAfford("scanlab", capUsd("scanlab"))) {
      fail(job, budgetMessage);
      return null;
    }
    const r = await runAgent({
      agent: "scanlab",
      model: model(),
      system,
      prompt: prompt + extra,
      schema: buildOutput,
      jsonSchema: buildJson,
      tools: [],
      maxBudgetUsd: capUsd("scanlab"),
      maxTurns: 2,
    });
    if (!r.ok || !r.output) {
      fail(job, r.error === "budget_exhausted" ? budgetMessage : `Claude could not build a draft: ${r.error ?? "no output"}`);
      return null;
    }
    const out = r.output;
    job.notes = out.notes;
    job.needsCode = out.needsCode;
    if (out.refusal) {
      fail(job, out.refusal, { notes: [out.refusal], needsCode: [], refused: true });
      return null;
    }
    // The server owns kind, version and parent.
    const candidate = { ...out.definition, kind: base.kind, version, parent: base.version };
    const parsed = parseDefinition(candidate);
    if (parsed.ok) return { output: out, def: parsed };
    lastErrors = parsed.errors;
    extra = `\n\nYour previous definition was rejected by validation:\n${lastErrors.slice(0, 12).map((e) => `- ${e}`).join("\n")}\nReturn the complete corrected output; use only catalog keys of the ${base.kind} scope and stay inside the schema bounds.`;
  }
  fail(job, `Claude's draft did not pass validation: ${lastErrors.slice(0, 5).join("; ")}`);
  return null;
}

async function run(job: BuildJob, base: DefRecord, text: string): Promise<void> {
  try {
    const made = await produce(base, text, job);
    if (!made) return;
    const { output, def } = made;
    if (diff(base.definition, def.def).length === 0) {
      return fail(job, output.needsCode.length ? "Nothing in your text could be built; the rest needs a code change." : "Claude found nothing to change in your text.");
    }
    const draft = createDraft({ kind: base.kind, baseId: base.id, definition: def.def, author: "claude", sourceText: text, notes: { notes: output.notes, needsCode: output.needsCode } });
    Object.assign(job, { status: "done", draftId: draft.id });
  } catch (err) {
    fail(job, err instanceof Error ? err.message : String(err));
  } finally {
    if (running.get(job.kind) === job.id) running.delete(job.kind);
  }
}

/** Starts a build in the background: one at a time per kind. `base` defaults to the active definition. */
export function startBuild(kind: DefKind, baseId: number | undefined, text: string): StartResult | "no_base" {
  if (!agentsEnabled()) return "disabled";
  if (running.has(kind)) return "busy";
  const base = baseId === undefined ? getActive(kind) : getById(baseId);
  if (!base || base.kind !== kind) return "no_base";
  if (!canAfford("scanlab", capUsd("scanlab"))) return "budget";

  const job: BuildJob = { id: randomUUID(), kind, status: "running", draftId: null, notes: [], needsCode: [], error: null, refused: false };
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);

  const forbidden = forbiddenIn(text);
  if (forbidden) {
    fail(job, `${FIXED_RULES} Your text asks for ${forbidden}, so I did not build a draft.`, { refused: true });
    job.notes = [job.error!];
    return { jobId: job.id };
  }
  running.set(kind, job.id);
  finished.set(job.id, run(job, base, text).finally(() => setTimeout(() => finished.delete(job.id), 60_000).unref()));
  return { jobId: job.id };
}
