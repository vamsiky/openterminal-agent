import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { apiKey } from "../auth.js";
import { nyClock } from "../history/scheduler.js";
import { isTradingDay } from "../providers/alpaca-calendar.js";
import { BRIEF_RESERVE_USD, concurrency, dailyBudgetUsd } from "./config.js";
import type { AgentName } from "./contracts.js";
import { attemptedOn, finishRun, hasBrief, insertRun, spentOn } from "./store.js";

// Runs one agent through the Claude Agent SDK: no built-in tools, only the
// app's own MCP server (read-only HTTP API), structured output validated with
// zod, a per-run cap and the daily budget guard. Every attempt is an agent_runs row.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN_TIMEOUT_MS = 10 * 60_000;
export const MCP_PREFIX = "mcp__openterminal__";

export type Usage = { input: number; output: number; cacheRead: number; cacheCreation: number };
export type RunSpec<T> = {
  agent: AgentName;
  model: string;
  system: string;
  prompt: string;
  /** Validates the structured output; the JSON schema below is what the model is asked to produce. */
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  /** MCP tool names without the mcp__openterminal__ prefix. */
  tools: string[];
  maxBudgetUsd: number;
  maxTurns: number;
  symbol?: string;
  now?: Date;
};
export type RunResult<T> = {
  ok: boolean;
  output: T | null;
  costUsd: number;
  usage: Usage;
  durationMs: number;
  error: string | null;
  /** "skipped" when the budget guard refused (error is "budget_exhausted"). */
  status: "ok" | "error" | "skipped";
  auth: "api_key" | "claude_login" | null;
};

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

// ---- budget ----

/** Whether the $0.60 floor for the day's brief is still held back from analyses. */
export function reserveActive(now: Date): boolean {
  const ny = nyClock(now);
  return isTradingDay(ny.date) && ny.hour < 12 && !hasBrief(ny.date) && !attemptedOn(ny.date, "brief");
}

/** Dollars an agent may still start today: macro and brief use the whole budget, analyses leave the brief's floor. */
export function availableUsd(agent: AgentName, now = new Date()): number {
  const day = nyClock(now).date;
  const floor = agent === "bull" || agent === "bear" || agent === "judge" || agent === "earnings" ? (reserveActive(now) ? BRIEF_RESERVE_USD : 0) : 0;
  return dailyBudgetUsd() - spentOn(day) - floor;
}

export const canAfford = (agent: AgentName, amountUsd: number, now = new Date()): boolean => amountUsd <= availableUsd(agent, now) + 1e-9;

// ---- concurrency ----

let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < concurrency()) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
}
function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

export type RunningRun = { agent: AgentName; symbol: string | null; startedAt: string };
const running = new Map<number, RunningRun>();
export const runningRuns = (): RunningRun[] => [...running.values()];

// ---- SDK options ----

function subprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  return env;
}

export function buildOptions(spec: RunSpec<unknown>, abortController: AbortController, onStderr: (s: string) => void): Options {
  const env = subprocessEnv();
  const options: Options = {
    model: spec.model,
    systemPrompt: spec.system,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    maxTurns: spec.maxTurns,
    maxBudgetUsd: spec.maxBudgetUsd,
    persistSession: false,
    outputFormat: { type: "json_schema", schema: spec.jsonSchema },
    env,
    abortController,
    stderr: onStderr,
  };
  if (spec.tools.length > 0) {
    // Absolute paths: a relative command or a cwd makes the server fail silently.
    options.mcpServers = {
      openterminal: {
        type: "stdio",
        command: join(repoRoot, "node_modules", ".bin", "tsx"),
        args: [process.env.AGENTS_MCP_ENTRY || join(repoRoot, "mcp", "src", "index.ts")],
        env: { OPENTERMINAL_API_URL: `http://127.0.0.1:${process.env.API_PORT ?? 4000}`, OPENTERMINAL_API_KEY: apiKey, PATH: env.PATH ?? "" },
      },
    };
    options.allowedTools = spec.tools.map((t) => MCP_PREFIX + t);
  }
  return options;
}

// ---- one attempt ----

async function attempt<T>(spec: RunSpec<T>, prompt: string, now: Date): Promise<RunResult<T> & { invalid?: string }> {
  const day = nyClock(now).date;
  const base = { output: null, usage: emptyUsage(), costUsd: 0, durationMs: 0, auth: null as RunResult<T>["auth"] };

  if (spec.maxBudgetUsd > availableUsd(spec.agent, now) + 1e-9) {
    insertRun({ day, agent: spec.agent, symbol: spec.symbol ?? null, model: spec.model, status: "skipped", error: "budget_exhausted", now });
    return { ...base, ok: false, status: "skipped", error: "budget_exhausted" };
  }

  await acquire();
  const startedAt = new Date();
  const runId = insertRun({ day, agent: spec.agent, symbol: spec.symbol ?? null, model: spec.model, status: "running", now: startedAt });
  running.set(runId, { agent: spec.agent, symbol: spec.symbol ?? null, startedAt: startedAt.toISOString() });
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
  timer.unref();
  const stderr: string[] = [];
  let auth: RunResult<T>["auth"] = null;
  let result: any = null;
  let failure: string | null = null;
  try {
    for await (const m of query({ prompt, options: buildOptions(spec, abort, (s) => stderr.push(s)) }) as AsyncIterable<any>) {
      if (m.type === "system" && m.subtype === "init") {
        auth = m.apiKeySource === "none" ? "claude_login" : "api_key";
        if (spec.tools.length > 0) {
          const server = (m.mcp_servers ?? []).find((s: { name: string }) => s.name === "openterminal");
          if (!server || server.status !== "connected") {
            failure = `mcp server openterminal not connected (status: ${server?.status ?? "missing"})`;
            abort.abort();
            break;
          }
        }
      } else if (m.type === "result") result = m;
    }
  } catch (err) {
    if (!failure) failure = abort.signal.aborted ? "run timed out" : err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    running.delete(runId);
    release();
  }

  const durationMs = result?.duration_ms ?? Date.now() - started;
  const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0;
  const u = result?.usage ?? {};
  const usage: Usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
  };
  const turns = result?.num_turns ?? 0;

  let output: T | null = null;
  let invalid: string | undefined;
  if (!failure) {
    if (!result) failure = `no result message${stderr.length ? `: ${stderr.join("").slice(-300)}` : ""}`;
    else if (result.subtype !== "success" || result.is_error) {
      failure = `${result.subtype}${result.errors?.length ? `: ${result.errors.join("; ").slice(0, 300)}` : ""}`;
    } else {
      const parsed = result.structured_output === undefined ? null : spec.schema.safeParse(result.structured_output);
      if (parsed?.success) output = parsed.data;
      else {
        invalid = parsed ? parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") : "no structured output returned";
        failure = `invalid output: ${invalid}`;
      }
    }
  }
  finishRun(runId, { status: failure ? "error" : "ok", auth, costUsd, usage, turns, durationMs, error: failure });
  return { ok: !failure, output, costUsd, usage, durationMs, error: failure, status: failure ? "error" : "ok", auth, invalid };
}

/** Runs the agent; an output that fails validation is retried once (the retry is another budgeted run). */
export async function runAgent<T>(spec: RunSpec<T>): Promise<RunResult<T>> {
  const now = spec.now ?? new Date();
  let r = await attempt(spec, spec.prompt, now);
  if (!r.ok && r.invalid !== undefined) {
    const second = await attempt(
      spec,
      `${spec.prompt}\n\nYour previous answer was rejected by the schema check (${r.invalid}). Answer again with output that matches the schema exactly.`,
      new Date()
    );
    r = {
      ...second,
      costUsd: r.costUsd + second.costUsd,
      durationMs: r.durationMs + second.durationMs,
      usage: {
        input: r.usage.input + second.usage.input,
        output: r.usage.output + second.usage.output,
        cacheRead: r.usage.cacheRead + second.usage.cacheRead,
        cacheCreation: r.usage.cacheCreation + second.usage.cacheCreation,
      },
    };
  }
  const { invalid: _invalid, ...out } = r;
  void _invalid;
  return out;
}
