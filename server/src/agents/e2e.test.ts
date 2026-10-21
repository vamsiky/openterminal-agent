import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// End to end through the agents routes, with the SDK mocked by prompt and model (no network, no cost):
// an idea in the database, POST /analyze, the worker runs bull and bear, then the judge; the thesis is read back
// by idea. Then the brief, first with no macro report (the brief must say so), then with one.

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));
// The brief reads the economic calendar and the live tape; neither is reachable in tests.
vi.mock("../providers/calendars.js", async (orig) => ({ ...(await orig<object>()), econEvents: vi.fn(async () => []) }));
vi.mock("../providers/fmp.js", async (orig) => ({ ...(await orig<object>()), isConfigured: () => false }));
vi.mock("../live/feed.js", async (orig) => ({ ...(await orig<object>()), liveQuote: () => null }));

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;
let judgeModel: string;

const evidence = [{ claim: "EPS estimates rose 6% in 30 days", source: "estimate_revisions:summary", asOf: "2026-10-20" }];
const bullOut = { summary: "Estimates are rising.", points: [{ point: "Revisions up", evidence }] };
const bearOut = { summary: "Valuation is full.", points: [{ point: "P/E above peers", evidence }] };
const judgeOut = (over: Record<string, unknown> = {}) => ({
  verdict: "act", confidence: 71, horizon: "3-6 months", entry: { low: 90, high: 95, note: "pullback zone" },
  target: { price: 130, note: "prior high" }, invalidation: { price: 80, condition: "" }, exitPlan: "trim into 130",
  catalysts: [{ date: "2026-12-17", event: "earnings" }], risks: ["valuation"], summary: "Revisions outweigh valuation.", evidence, ...over,
});
const macroOut = {
  regime: { rates: "falling", risk: "on", volatility: "low", dollar: "flat", oil: "flat" },
  summary: "Yields eased; equities firm into the open.",
  events: [{ time: "2026-10-21T12:30:00Z", event: "CPI", importance: "high" }],
  risks: ["oil"], evidence,
};

/** The SDK, answering by which agent is asking: the judge by model, the brief by having no tools, the rest by prompt. */
function answer(prompt: string, options: { model: string; allowedTools?: string[] }) {
  if (options.model === judgeModel) return { structured: judgeOut(), cost: 0.2 };
  if (!options.allowedTools) return { structured: { markdown: "## Regime\nRates falling. Watch the 12:30 CPI print." }, cost: 0.05 };
  if (prompt.includes("Argue the BULL")) return { structured: bullOut, cost: 0.1 };
  if (prompt.includes("Argue the BEAR")) return { structured: bearOut, cost: 0.1 };
  return { structured: macroOut, cost: 0.12 }; // the macro report
}

const briefPrompts = () => queryMock.mock.calls.map((c) => c[0].prompt as string).filter((p) => p.startsWith("Write today's pre-market brief"));

async function until<T>(read: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: res.status === 404 ? null : await res.json() };
};
const post = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-agents-e2e-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  await import("../quant/ideas.js"); // creates the ideas table
  const { agentsRouter } = await import("../routes/agents.js");
  judgeModel = (await import("./config.js")).judgeModel();
  const app = express();
  app.use(express.json());
  app.use("/api/agents", agentsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(({ prompt, options }: { prompt: string; options: { model: string; allowedTools?: string[] } }) => {
    const { structured, cost } = answer(prompt, options);
    return (async function* () {
      yield { type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "openterminal", status: "connected" }] };
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: cost, duration_ms: 500, num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 }, structured_output: structured, errors: [] };
    })();
  });
});

describe("analysis, from an idea to the thesis read back", () => {
  it("analyses an idea through POST /analyze and returns its thesis by idea", async () => {
    db.prepare(
      "INSERT INTO ideas (id, kind, symbol, strategy, contract, score, rank, reasons, first_seen, last_seen, status) VALUES (1, 'stock', 'MU', 'buy', NULL, 82, 1, ?, ?, ?, 'active')"
    ).run(JSON.stringify(["momentum 90/100; best: 6-month return, 98/100 against sector peers"]), new Date().toISOString(), new Date().toISOString());

    const queued = await post("/analyze", { symbol: "MU", strategy: "buy", ideaId: 1 });
    expect(queued).toEqual({ status: 202, body: { queued: true, position: 1 } });

    const thesis = await until(async () => {
      const r = await get("/theses/latest?ideaId=1");
      return r.status === 200 ? r.body : null;
    });
    expect(thesis).toMatchObject({
      ideaId: 1, symbol: "MU", kind: "stock", strategy: "buy", status: "ok", verdict: "act", confidence: 71,
      inputs: { ideaScore: 82 }, models: { bull: "claude-sonnet-5-5", bear: "claude-sonnet-5-5", judge: judgeModel },
    });
    expect(thesis.bull).toMatchObject({ side: "bull", summary: "Estimates are rising." });
    expect(thesis.bear).toMatchObject({ side: "bear", summary: "Valuation is full." });
    expect(thesis.costUsd).toBeCloseTo(0.4, 6); // bull 0.1 + bear 0.1 + judge 0.2

    // The bull and bear ran in parallel with the tool list, the judge with its own two tools and three turns.
    const byModel = queryMock.mock.calls.map((c) => c[0].options);
    expect(byModel.filter((o) => o.model === judgeModel)).toHaveLength(1);
    expect(byModel.find((o) => o.model === judgeModel).allowedTools).toEqual(["mcp__openterminal__quote", "mcp__openterminal__option_metrics"]);
    expect(byModel.find((o) => o.model === judgeModel).maxTurns).toBe(3);

    const again = await get(`/theses/latest?symbol=MU&strategy=buy`);
    expect(again.body.id).toBe(thesis.id);
    const list = await get("/theses?symbol=MU");
    expect(list.body.map((t: { id: number }) => t.id)).toEqual([thesis.id]);
    expect((await get(`/theses/${thesis.id}`)).body.verdict).toBe("act");

    const runs = (await get("/runs?limit=10")).body as Array<{ agent: string; status: string; symbol: string }>;
    expect(runs.filter((r) => r.status === "ok").map((r) => r.agent).sort()).toEqual(["bear", "bull", "judge"]);
    expect(runs.every((r) => r.symbol === "MU")).toBe(true);
  });

  it("gives the brief its inputs, saying so when there is no macro report", async () => {
    // Nothing has been queued since the analysis finished, so the queue is empty.
    expect((await get("/status")).body.queue).toEqual([]);
    expect((await post("/run/brief")).status).toBe(202);
    const brief = await until(async () => {
      const r = await get("/brief/latest");
      return r.status === 200 ? r.body : null;
    });
    expect(brief).toMatchObject({ markdown: expect.stringContaining("## Regime"), macroId: null, costUsd: 0.05 });
    const prompt = briefPrompts().at(-1)!;
    const inputs = JSON.parse(prompt.slice(prompt.indexOf("(JSON):\n") + "(JSON):\n".length));
    expect(inputs.macroNote).toBe("No macro report today");
    expect(inputs.macro).toBeNull();
    expect(inputs.stockIdeas[0]).toMatchObject({ symbol: "MU", analysis: "thesis", thesis: { verdict: "act", confidence: 71 } });
    expect(inputs).not.toHaveProperty("thesisIds"); // the model's prompt omits the ids; the stored brief keeps them
    expect(brief.thesisIds).toEqual([(await get("/theses/latest?ideaId=1")).body.id]);
    expect(inputs.economicEvents).toEqual([]);
    expect(inputs.earnings.reportingToday).toEqual([]);
  });

  it("writes the brief with today's macro report once one exists", async () => {
    expect((await post("/run/macro")).status).toBe(202);
    const macro = await until(async () => {
      const r = await get("/macro/latest");
      return r.status === 200 ? r.body : null;
    });
    expect(macro).toMatchObject({ session: "adhoc", summary: macroOut.summary, regime: macroOut.regime, costUsd: 0.12 });

    expect((await post("/run/brief")).status).toBe(202);
    await until(async () => ((await get("/brief/latest")).body?.macroId === macro.id ? true : null));
    const prompt = briefPrompts().at(-1)!;
    expect(prompt).not.toContain("No macro report today");
    expect(prompt).toContain(macroOut.summary);
  });
});
