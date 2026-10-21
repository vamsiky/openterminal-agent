import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentName } from "./contracts.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** The shared ground rules plus the agent's own prompt, read from disk on every call so edits need no restart. */
export function loadPrompt(agent: AgentName): string {
  return `${readFileSync(join(dir, "common.md"), "utf8").trim()}\n\n${readFileSync(join(dir, `${agent}.md`), "utf8").trim()}`;
}
