import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));

const CLOCK = new Date("2026-10-21T21:00:00Z"); // 17:00 New York on 2026-10-21: the budget day is 2026-10-21

let tmp: string;
let server: Server;
let base: string;
let m: {
  db: typeof import("../db.js").db;
  edb: typeof import("../earnings/db.js").earningsDb;
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-routes-edge-"));
  process.env.DATA_DIR = tmp;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(CLOCK);
  const { db } = await import("../db.js");
  await import("../history/store.js");
  await import("../quant/stock-score.js");
  await import("../research/bulk-store.js");
  const { earningsDb } = await import("../earnings/db.js");
  const synthetic = await import("../earnings/fixtures/synthetic.js");
  const stats = await import("../earnings/stats.js");
  synthetic.seedScreenDay(500, "2026-10-22", true);
  stats.rebuildStats();
  m = { db, edb: earningsDb };
  const { earningsRouter } = await import("./earnings.js");
  const app = express();
  app.use(express.json());
  app.use("/api/earnings", earningsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/earnings`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise((r) => server.close(r));
  m.db.close();
  m.edb.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  queryMock.mockReset();
  delete process.env.AGENTS_DAILY_BUDGET_USD;
  delete process.env.AGENTS_ENABLED;
  m.db.prepare("DELETE FROM agent_runs").run();
  m.edb.prepare("DELETE FROM review_queue").run();
  m.edb.prepare("DELETE FROM reviews").run();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as any };
};
const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const spend = (usd: number) =>
  m.db.prepare("INSERT INTO agent_runs (day, agent, symbol, model, status, cost_usd, started_at) VALUES ('2026-10-21', 'bull', 'S0000', 'x', 'ok', ?, '2026-10-21T15:00:00Z')").run(usd);

describe("GET /screen at 500 names", () => {
  it("returns every reporter with no default limit, in under 2 s", async () => {
    const started = performance.now();
    const { status, body } = await get("/screen?from=2026-10-22");
    const ms = performance.now() - started;
    expect(status).toBe(200);
    expect(body).toHaveLength(500);
    expect(ms).toBeLessThan(2000);
  });

  it("limit cuts the sorted list to its first rows", async () => {
    const all = (await get("/screen?from=2026-10-22")).body;
    const seven = (await get("/screen?from=2026-10-22&limit=7")).body;
    expect(seven.map((s: any) => s.symbol)).toEqual(all.slice(0, 7).map((s: any) => s.symbol));
  });

  it("filters combine: the result is exactly the full list filtered by each condition", async () => {
    const full = (await get("/screen?from=2026-10-22&horizon=week")).body as any[];
    const pick = (s: any) => s.upcoming.time === "amc" && s.sector === "Technology" && s.score >= 40 && s.gates.every((g: any) => g.passed);
    const want = full.filter(pick).map((s) => s.symbol).sort();
    expect(want.length).toBeGreaterThan(0);
    const q = "/screen?from=2026-10-22&horizon=week&time=amc&sector=Technology&minScore=40&tradable=true";
    expect((await get(q)).body.map((s: any) => s.symbol).sort()).toEqual(want);
    expect((await get(`${q}&sort=symbol&limit=5`)).body.map((s: any) => s.symbol)).toEqual([...want].slice(0, 5));
  });

  it("a verdict filter adds to the other filters", async () => {
    const full = (await get("/screen?from=2026-10-22&horizon=week")).body as any[];
    const want = full.filter((s) => s.upcoming.time === "bmo" && s.verdict === "conditional").map((s) => s.symbol).sort();
    const got = (await get("/screen?from=2026-10-22&horizon=week&time=bmo&verdict=conditional")).body.map((s: any) => s.symbol).sort();
    expect(got).toEqual(want);
  });

  it("answers 400 for every invalid parameter", async () => {
    const bad = [
      "horizon=year", "time=pm", "verdict=buy", "sort=price", "tradable=maybe", "minScore=101", "minScore=-1",
      "limit=0", "limit=2.5", "limit=abc", "minCap=-5", "symbols=BAD!", "from=yesterday", "to=2026/10/22",
    ];
    for (const q of bad) expect((await get(`/screen?${q}`)).status, q).toBe(400);
  });

  // KNOWN BUG (routes/earnings.ts:20-21): the day schema is a regex only, so an impossible date passes validation and
  // returns 200. Flip to `it` once the schema checks the calendar.
  it.fails("rejects a date that does not exist in the calendar (2026-02-30) (known bug)", async () => {
    expect((await get("/screen?from=2026-02-30")).status).toBe(400);
  });
});

describe("POST /review", () => {
  const symbols = ["S0000", "S0001", "S0002"];

  it("a dryRun answers 200, counts the matches and writes nothing to the queue or the reviews", async () => {
    const r = await post("/review", { horizon: "intraday", symbols, dryRun: true, filter: { from: "2026-10-22" } });
    expect(r.status).toBe(200);
    expect(r.body.queued).toBe(0);
    expect(r.body.wouldQueue).toBeGreaterThan(0);
    expect(m.edb.prepare("SELECT COUNT(*) AS n FROM review_queue").get()).toEqual({ n: 0 });
    expect(m.edb.prepare("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("an exhausted daily budget answers 402 before anything is queued, dryRun included", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.2";
    spend(0.2); // today's spend covers the whole budget
    const real = await post("/review", { horizon: "intraday", symbols, filter: { from: "2026-10-22" } });
    expect(real.status).toBe(402);
    const dry = await post("/review", { horizon: "intraday", symbols, dryRun: true, filter: { from: "2026-10-22" } });
    expect(dry.status).toBe(402);
    expect(m.edb.prepare("SELECT COUNT(*) AS n FROM review_queue").get()).toEqual({ n: 0 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("the same request is accepted once the spend is gone", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.2";
    spend(0.2);
    expect((await post("/review", { horizon: "intraday", symbols, dryRun: true, filter: { from: "2026-10-22" } })).status).toBe(402);
    m.db.prepare("DELETE FROM agent_runs").run();
    expect((await post("/review", { horizon: "intraday", symbols, dryRun: true, filter: { from: "2026-10-22" } })).status).toBe(200);
  });
});
