import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Status codes and bodies of the agents routes that answer the app's error paths. Every body must be JSON
// with an `error` string (or the documented 202 shape). The SDK is mocked so nothing reaches the network.

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-agents-bodies-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  const { agentsRouter } = await import("./agents.js");
  const app = express();
  app.use(express.json());
  app.use("/api/agents", agentsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents`;
});

afterAll(async () => {
  delete process.env.AGENTS_ENABLED;
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  queryMock.mockReset();
  db.prepare("DELETE FROM agent_runs").run();
  db.prepare("DELETE FROM agent_queue").run();
  delete process.env.AGENTS_ENABLED;
  delete process.env.AGENTS_DAILY_BUDGET_USD;
});

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** An SDK run that fails fast, so a queued analysis finishes without network or cost. */
const failFast = () =>
  queryMock.mockImplementation(() => (async function* () {
    yield { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0, duration_ms: 1, num_turns: 0, usage: {}, errors: ["offline test"] };
  })());

describe("JSON bodies", () => {
  it("answers 503 as JSON when agents are disabled, on both POST routes", async () => {
    process.env.AGENTS_ENABLED = "0";
    for (const [path, body] of [["/analyze", { symbol: "AAA", strategy: "buy" }], ["/run/brief", undefined], ["/run/macro", undefined]] as const) {
      const res = await post(path, body);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("content-type"), path).toMatch(/application\/json/);
      expect((await res.json()).error).toMatch(/AGENTS_ENABLED=0/);
    }
    expect((await fetch(`${base}/status`)).status).toBe(200); // reads still work
  });

  it("answers 402 as JSON when the daily budget cannot fund the run", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0";
    const analyze = await post("/analyze", { symbol: "AAA", strategy: "buy" });
    expect(analyze.status).toBe(402);
    expect(analyze.headers.get("content-type")).toMatch(/application\/json/);
    expect(await analyze.json()).toEqual({ error: "daily AI budget reached" });
    const macro = await post("/run/macro");
    expect(macro.status).toBe(402);
    expect(await macro.json()).toEqual({ error: "daily AI budget reached" });
  });

  it("answers 202 with queued and a position for an analysis that fits the budget", async () => {
    failFast();
    const res = await post("/analyze", { symbol: "AAA", strategy: "buy", ideaId: null });
    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ queued: true, position: 1 });
  });

  it("answers 400 as JSON for a bad symbol, strategy or body", async () => {
    for (const body of [{ symbol: "bad sym", strategy: "buy" }, { symbol: "AAA", strategy: "buy_puts" }, { strategy: "buy" }]) {
      const res = await post("/analyze", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTypeOf("string");
    }
  });

  it("answers 404 as JSON for an unknown agent to run", async () => {
    const res = await post("/run/judge");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "agent must be macro or brief" });
  });

  it("answers 409 as JSON while the same run is still going", async () => {
    let finish!: () => void;
    const hold = new Promise<void>((r) => (finish = r));
    queryMock.mockImplementation(() => (async function* () {
      await hold;
      yield { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {}, errors: [] };
    })());
    const first = await post("/run/macro");
    expect(first.status).toBe(202);
    const second = await post("/run/macro");
    expect(second.status).toBe(409);
    expect(second.headers.get("content-type")).toMatch(/application\/json/);
    expect(await second.json()).toEqual({ error: "macro is already running" });
    finish();
    await new Promise((r) => setTimeout(r, 50));
  });
});
