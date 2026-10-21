import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));
vi.mock("../live/feed.js", () => ({ liveQuote: () => null }));

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;
let store: typeof import("../agents/store.js");

const get = (path: string) => fetch(base + path);
const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-agents-route-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  await import("../quant/ideas.js");
  await import("../quant/positions.js");
  store = await import("../agents/store.js");
  const { agentsRouter } = await import("./agents.js");
  const app = express();
  app.use(express.json());
  app.use("/api/agents", agentsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});
beforeEach(() => {
  // A call that never finishes keeps queued work from running during the tests.
  queryMock.mockImplementation(() => (async function* () { await new Promise(() => {}); yield 1; })());
  for (const t of ["agent_runs", "agent_queue", "theses", "macro_reports", "briefs"]) db.prepare(`DELETE FROM ${t}`).run();
  delete process.env.AGENTS_ENABLED;
  delete process.env.AGENTS_DAILY_BUDGET_USD;
});

const thesis = (over: Record<string, unknown> = {}) =>
  store.insertThesis("2026-10-21", {
    ideaId: 7, symbol: "MU", kind: "stock", strategy: "buy", contract: null, asOf: "2026-10-21T22:00:00Z", status: "ok", statusReason: null, verdict: "wait", confidence: 50, horizon: "months",
    entry: null, target: null, invalidation: null, exitPlan: null, catalysts: [], risks: [], summary: "s", bull: null, bear: null, evidence: [],
    inputs: { scorecardAsOf: null, optionScorecardAsOf: null, macroId: null, ideaScore: 80 }, models: { bull: null, bear: null, judge: null }, costUsd: 0.3, ...over,
  } as never);

describe("GET", () => {
  it("status has the contract fields and auth", async () => {
    const body = await (await get("/status")).json();
    expect(body).toMatchObject({ enabled: true, today: { budgetUsd: 5, spentUsd: 0, runs: 0, skippedForBudget: 0 }, queue: [], running: [], lastMacro: null, lastBrief: null, auth: null });
  });

  it("answers 404 with no macro report, brief or thesis", async () => {
    expect((await get("/macro/latest")).status).toBe(404);
    expect((await get("/brief/latest")).status).toBe(404);
    expect((await get("/theses/latest?symbol=MU&strategy=buy")).status).toBe(404);
    expect((await get("/theses/99")).status).toBe(404);
    expect(await (await get("/theses")).json()).toEqual([]);
  });

  it("lists theses newest first and finds the latest by idea or by symbol and strategy", async () => {
    const a = thesis();
    const b = thesis({ summary: "newer" });
    thesis({ symbol: "AMD", ideaId: 8 });
    const list = await (await get("/theses?symbol=mu&strategy=buy")).json();
    expect(list.map((t: { id: number }) => t.id)).toEqual([b.id, a.id]);
    expect((await (await get("/theses/latest?ideaId=7")).json()).id).toBe(b.id);
    expect((await (await get("/theses/latest?symbol=MU&strategy=buy")).json()).summary).toBe("newer");
    expect((await (await get(`/theses/${a.id}`)).json()).id).toBe(a.id);
    expect((await get("/theses/latest")).status).toBe(400);
    expect((await get("/theses?strategy=buy_puts")).status).toBe(400);
  });

  it("returns macro reports, briefs and runs", async () => {
    store.insertMacro("2026-10-21", "pre", { regime: { rates: "flat", risk: "on", volatility: "low", dollar: "flat", oil: "flat" }, summary: "s", events: [], risks: [], evidence: [] }, 0.1);
    store.insertBrief({ day: "2026-10-21", asOf: "2026-10-21T11:00:00Z", markdown: "## Regime", macroId: 1, thesisIds: [], costUsd: 0.02 });
    expect((await (await get("/macro/latest")).json()).session).toBe("pre");
    expect(await (await get("/macro?limit=5")).json()).toHaveLength(1);
    expect((await (await get("/brief/latest")).json()).markdown).toBe("## Regime");
    expect(await (await get("/briefs")).json()).toHaveLength(1);
    store.insertRun({ day: "2026-10-21", agent: "macro", symbol: null, model: "m", status: "skipped", error: "budget_exhausted", now: new Date() });
    expect((await (await get("/runs")).json())[0]).toMatchObject({ agent: "macro", status: "skipped", error: "budget_exhausted" });
    expect((await get("/runs?limit=0")).status).toBe(400);
  });
});

describe("POST /analyze", () => {
  it("queues with 202 and a position, then answers 409 for the same idea", async () => {
    const res = await post("/analyze", { symbol: "mu", strategy: "buy" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: true });
    const again = await post("/analyze", { symbol: "MU", strategy: "buy" });
    expect(again.status).toBe(409);
    expect(await again.json()).toHaveProperty("error");
    // A different contract is a different idea.
    expect((await post("/analyze", { symbol: "MU", strategy: "short_put", contract: "MU261120P00090000" })).status).toBe(202);
  });

  it("answers 402 when the daily budget cannot fund an analysis", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.5";
    const res = await post("/analyze", { symbol: "MU", strategy: "buy" });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "daily AI budget reached" });
  });

  it("answers 503 when agents are disabled and 400 for bad input", async () => {
    process.env.AGENTS_ENABLED = "0";
    expect((await post("/analyze", { symbol: "MU", strategy: "buy" })).status).toBe(503);
    expect((await post("/run/macro")).status).toBe(503);
    delete process.env.AGENTS_ENABLED;
    expect((await post("/analyze", { symbol: "MU", strategy: "buy_put" })).status).toBe(400);
    expect((await post("/analyze", { symbol: "bad symbol!", strategy: "buy" })).status).toBe(400);
  });
});

describe("POST /run/:agent", () => {
  it("starts macro with 202, then 409 while it runs", async () => {
    const res = await post("/run/macro");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ started: true, agent: "macro" });
    expect((await post("/run/macro")).status).toBe(409);
  });

  it("answers 402 without budget, 404 for other agents", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.1";
    const res = await post("/run/brief");
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "daily AI budget reached" });
    expect((await post("/run/judge")).status).toBe(404);
  });
});
