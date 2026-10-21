import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Edge cases of the run path the existing runtime tests leave open: the exact budget cap, the
// 10-minute timeout, every error subtype, a missing MCP entry, and what the status counts.
// Nothing reaches the network: the SDK is mocked.

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));

let tmpDir: string;
let db: typeof import("../db.js").db;
let runtime: typeof import("./runtime.js");
let store: typeof import("./store.js");
let service: typeof import("./service.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-agents-runtime-edge-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  runtime = await import("./runtime.js");
  store = await import("./store.js");
  service = await import("./service.js");
});
afterAll(() => {
  vi.useRealTimers();
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
  type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, duration_ms: 900, num_turns: 2, usage: {},
  structured_output: { answer: "ok" }, errors: [], ...over,
});
const stream = (...msgs: unknown[]) => () => (async function* () { for (const m of msgs) yield m; })();

describe("exact budget cap", () => {
  it("allows a run whose cap lands exactly on the daily budget, and refuses one cent more", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.6";
    queryMock.mockImplementation(stream(init(), result({ total_cost_usd: 0.3 })));
    expect((await runtime.runAgent(spec())).ok).toBe(true); // 0 + 0.3 <= 0.6
    expect((await runtime.runAgent(spec())).status).toBe("ok"); // 0.3 + 0.3 == 0.6, still allowed
    const third = await runtime.runAgent(spec());
    expect(third).toMatchObject({ ok: false, status: "skipped", error: "budget_exhausted" });
    expect(queryMock).toHaveBeenCalledTimes(2);

    process.env.AGENTS_DAILY_BUDGET_USD = "0.59";
    db.prepare("DELETE FROM agent_runs").run();
    queryMock.mockClear();
    queryMock.mockImplementation(stream(init(), result({ total_cost_usd: 0.3 })));
    expect((await runtime.runAgent(spec())).ok).toBe(true);
    expect((await runtime.runAgent(spec())).status).toBe("skipped"); // 0.3 + 0.3 = 0.6 > 0.59
  });

  it("counts a refused run in skippedForBudget, and does not count it as a run", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.1";
    await runtime.runAgent(spec());
    const s = service.status();
    expect(s.today.skippedForBudget).toBe(1);
    expect(s.today.runs).toBe(0);
    expect(s.today.spentUsd).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("soft overshoot", () => {
  it("records the real cost when the SDK stops at its cap, and the next run sees it", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "1";
    // The SDK's own cap is per run; a run may overshoot it by the cost of the turn it was in.
    queryMock.mockImplementation(stream(init(), result({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.34, structured_output: undefined, errors: ["budget"] })));
    const r = await runtime.runAgent(spec({ maxBudgetUsd: 0.3 }));
    expect(r).toMatchObject({ ok: false, status: "error", costUsd: 0.34 });
    expect(store.listRuns(1)[0]).toMatchObject({ status: "error", costUsd: 0.34 });
    expect(service.status().today.spentUsd).toBeCloseTo(0.34, 4);
    expect(runtime.availableUsd("macro")).toBeCloseTo(0.66, 4);
  });
});

describe("error subtypes", () => {
  const subtypes = ["error_max_turns", "error_during_execution", "error_max_structured_output_retries", "error_max_budget_usd"];
  for (const subtype of subtypes) {
    it(`treats ${subtype} as a failed run that keeps its cost`, async () => {
      queryMock.mockImplementation(stream(init(), result({ subtype, is_error: true, total_cost_usd: 0.12, structured_output: undefined, errors: ["detail"] })));
      const r = await runtime.runAgent(spec());
      expect(r).toMatchObject({ ok: false, status: "error", output: null, costUsd: 0.12 });
      expect(r.error).toContain(subtype);
      expect(r.error).toContain("detail");
      expect(store.listRuns(1)[0]).toMatchObject({ status: "error", costUsd: 0.12, error: r.error });
      expect(queryMock).toHaveBeenCalledTimes(1); // an SDK error is not retried; only invalid output is
    });
  }

  it("treats a result with is_error set as a failure even when the subtype says success", async () => {
    queryMock.mockImplementation(stream(init(), result({ is_error: true })));
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: false, status: "error" });
    expect(r.error).toContain("success");
  });
});

describe("MCP server status", () => {
  it("fails when the openterminal entry is missing from the init message", async () => {
    queryMock.mockImplementation(stream(init({ mcp_servers: [{ name: "other", status: "connected" }] })));
    const r = await runtime.runAgent(spec());
    expect(r).toMatchObject({ ok: false, status: "error" });
    expect(r.error).toContain("status: missing");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("fails when the server reports pending, not only failed", async () => {
    queryMock.mockImplementation(stream(init({ mcp_servers: [{ name: "openterminal", status: "pending" }] })));
    const r = await runtime.runAgent(spec());
    expect(r.error).toContain("status: pending");
  });
});

describe("run timeout", () => {
  it("aborts a run after ten minutes and records it as timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        yield init();
        // A run that never finishes on its own: it only ends when the runtime aborts it.
        await new Promise<void>((_, reject) => options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      })()
    );
    const p = runtime.runAgent(spec());
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(store.listRuns(1)[0].status).toBe("running");
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    const r = await p;
    vi.useRealTimers();
    expect(r).toMatchObject({ ok: false, status: "error", error: "run timed out" });
    expect(store.listRuns(1)[0]).toMatchObject({ status: "error", error: "run timed out" });
    expect(runtime.runningRuns()).toEqual([]);
  });
});

describe("brief floor, by agent", () => {
  it("holds the floor from bear and judge as well as bull, and releases it once the brief is attempted", () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.8";
    const morning = new Date("2026-10-21T10:45:00Z"); // 06:45 New York
    expect(runtime.availableUsd("bear", morning)).toBeCloseTo(0.2, 6);
    expect(runtime.availableUsd("judge", morning)).toBeCloseTo(0.2, 6);
    expect(runtime.canAfford("judge", 0.25, morning)).toBe(false);
    store.insertRun({ day: "2026-10-21", agent: "brief", symbol: null, model: "m", status: "skipped", error: "budget_exhausted", now: morning });
    expect(runtime.availableUsd("judge", morning)).toBeCloseTo(0.8, 6);
  });

  it("releases the floor at noon even with no brief, so an afternoon analysis is not held back for nothing", () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.8";
    const afternoon = new Date("2026-10-21T17:00:00Z"); // 13:00 New York
    expect(runtime.reserveActive(afternoon)).toBe(false);
    expect(runtime.canAfford("bull", 0.8, afternoon)).toBe(true);
  });
});
