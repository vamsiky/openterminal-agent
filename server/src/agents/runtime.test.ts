import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));

let tmpDir: string;
let db: typeof import("../db.js").db;
let runtime: typeof import("./runtime.js");
let store: typeof import("./store.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-agents-runtime-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  runtime = await import("./runtime.js");
  store = await import("./store.js");
});
afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});
beforeEach(() => {
  queryMock.mockReset();
  db.prepare("DELETE FROM agent_runs").run();
  delete process.env.AGENTS_DAILY_BUDGET_USD;
});

const schema = z.object({ answer: z.string() });
const spec = (over: Partial<Parameters<typeof runtime.runAgent>[0]> = {}) =>
  ({ agent: "macro", model: "m", system: "s", prompt: "p", schema, jsonSchema: { type: "object" }, tools: ["quote"], maxBudgetUsd: 0.3, maxTurns: 5, ...over }) as Parameters<typeof runtime.runAgent<{ answer: string }>>[0];

const init = (over: Record<string, unknown> = {}) => ({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "openterminal", status: "connected" }], ...over });
const result = (over: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, duration_ms: 1200, num_turns: 3,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
  structured_output: { answer: "hi" }, errors: [], ...over,
});
const stream = (...msgs: unknown[]) => () => (async function* () { for (const m of msgs) yield m; })();

describe("runAgent", () => {
  it("returns the validated output and records the run, cost, tokens and auth", async () => {
    queryMock.mockImplementation(stream(init(), result()));
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: true, output: { answer: "hi" }, costUsd: 0.05, status: "ok", auth: "claude_login" });
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk", persistSession: false, maxTurns: 5, maxBudgetUsd: 0.3 });
    expect(opts.allowedTools).toEqual(["mcp__openterminal__quote"]);
    expect(opts.mcpServers.openterminal.args[0]).toMatch(/^\/.*mcp\/src\/index\.ts$/);
    expect(opts.mcpServers.openterminal).not.toHaveProperty("cwd");
    const [row] = store.listRuns(1);
    expect(row).toMatchObject({ status: "ok", costUsd: 0.05, inputTokens: 100, outputTokens: 50, turns: 3, auth: "claude_login" });
  });

  it("refuses when today's spend plus the cap would pass the daily budget", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.2";
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: false, status: "skipped", error: "budget_exhausted" });
    expect(queryMock).not.toHaveBeenCalled();
    expect(store.listRuns(1)[0].status).toBe("skipped");
    const day = store.listRuns(1)[0].day;
    expect(store.skippedOn(day)).toBe(1);
  });

  it("counts earlier spend against the budget", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.5";
    queryMock.mockImplementation(stream(init(), result({ total_cost_usd: 0.25 })));
    expect((await runtime.runAgent(spec())).ok).toBe(true);
    expect((await runtime.runAgent(spec())).status).toBe("skipped"); // 0.25 + 0.3 > 0.5
  });

  it("treats error subtypes as failed runs and keeps their cost", async () => {
    queryMock.mockImplementation(stream(init(), result({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.33, structured_output: undefined, errors: ["over"] })));
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: false, status: "error", costUsd: 0.33 });
    expect(r.error).toContain("error_max_budget_usd");
    expect(store.listRuns(1)[0]).toMatchObject({ status: "error", costUsd: 0.33 });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on schema-invalid output and sums the cost", async () => {
    queryMock
      .mockImplementationOnce(stream(init(), result({ structured_output: { wrong: 1 } })))
      .mockImplementationOnce(stream(init(), result({ total_cost_usd: 0.04 })));
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: true, output: { answer: "hi" } });
    expect(r.costUsd).toBeCloseTo(0.09);
    expect(queryMock.mock.calls[1][0].prompt).toContain("rejected by the schema check");
    expect(store.listRuns(5)).toHaveLength(2);
  });

  it("fails with an error when the output is invalid twice", async () => {
    queryMock.mockImplementation(stream(init(), result({ structured_output: { wrong: 1 } })));
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: false, status: "error", output: null });
    expect(r.error).toContain("invalid output");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(r.costUsd).toBeCloseTo(0.1);
  });

  it("fails clearly when the MCP server is not connected, without retrying", async () => {
    queryMock.mockImplementation(stream(init({ mcp_servers: [{ name: "openterminal", status: "failed" }] })));
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: false, status: "error" });
    expect(r.error).toContain("not connected (status: failed)");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("does not require the MCP server for agents without tools, and reports the api key source", async () => {
    queryMock.mockImplementation(stream(init({ apiKeySource: "ANTHROPIC_API_KEY", mcp_servers: [] }), result()));
    const r = await runtime.runAgent(spec({ tools: [] }));
    expect(r).toMatchObject({ ok: true, auth: "api_key" });
    expect(queryMock.mock.calls[0][0].options.mcpServers).toBeUndefined();
  });

  it("records a thrown SDK error as a failed run", async () => {
    queryMock.mockImplementation(() => (async function* () { throw new Error("spawn failed"); yield 1; })());
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: false, error: "spawn failed" });
  });

  it("holds back the brief's floor from analyses but not from macro", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.8";
    // A weekday morning with no brief yet: reserve is active.
    const morning = new Date("2026-10-21T10:45:00Z"); // 06:45 New York, a Wednesday
    expect(runtime.reserveActive(morning)).toBe(true);
    expect(runtime.canAfford("bull", 0.2, morning)).toBe(true);
    expect(runtime.canAfford("bull", 0.25, morning)).toBe(false);
    expect(runtime.canAfford("macro", 0.3, morning)).toBe(true);
    store.insertRun({ day: "2026-10-21", agent: "brief", symbol: null, model: "m", status: "skipped", now: morning });
    expect(runtime.reserveActive(morning)).toBe(false);
    expect(runtime.canAfford("bull", 0.3, morning)).toBe(true);
  });
});
