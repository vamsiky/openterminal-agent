import { nyClock } from "../history/scheduler.js";
import { capUsd, MAX_TURNS, model } from "./config.js";
import type { MacroReport } from "./contracts.js";
import { loadPrompt } from "./prompts.js";
import { runAgent } from "./runtime.js";
import { macroJson, macroOutput } from "./schemas.js";
import { insertMacro } from "./store.js";

export const MACRO_TOOLS = ["macro", "economic_calendar", "market_news", "quote", "market"];

/** One macro report (pre-market, post-close or ad hoc); stores it and returns it, or the reason it failed. */
export async function runMacro(session: MacroReport["session"], now = new Date()): Promise<{ ok: true; report: MacroReport } | { ok: false; error: string }> {
  const day = nyClock(now).date;
  const label = { pre: "pre-market (before the open)", post: "post-close (after the close)", adhoc: "ad hoc (right now)" }[session];
  const r = await runAgent({
    agent: "macro",
    model: model(),
    system: loadPrompt("macro"),
    prompt: `Write the ${label} macro report. Now: ${now.toISOString()} (New York date ${day}).`,
    schema: macroOutput,
    jsonSchema: macroJson,
    tools: MACRO_TOOLS,
    maxBudgetUsd: capUsd("macro"),
    maxTurns: MAX_TURNS.macro,
    now,
  });
  if (!r.ok || !r.output) return { ok: false, error: r.error ?? "no output" };
  return { ok: true, report: insertMacro(day, session, r.output, r.costUsd, now) };
}
