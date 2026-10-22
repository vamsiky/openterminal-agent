import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => queryMock(args) }));

let tmp: string;
let server: Server;
let base: string;
let m: {
  db: typeof import("../db.js").db;
  edb: typeof import("../earnings/db.js").earningsDb;
  review: typeof import("../earnings/review.js");
  score: typeof import("../earnings/score.js");
  seed: typeof import("../earnings/fixtures/seed.js");
  stats: typeof import("../earnings/stats.js");
};

const init = { type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [{ name: "openterminal", status: "connected" }] };
const output = (over: Record<string, unknown> = {}) => ({
  adjustment: 5, verdict: "wait",
  newsFactors: [{ factor: "Peer beat last night", direction: "+", evidence: [{ claim: "Peer reported a beat", source: "market_news", asOf: "2026-10-21" }] }],
  entryConditions: ["Above VWAP"], exitPlan: "Out by 15:30 ET, before the print", risks: ["Spread"], summary: "Fine.", ...over,
});
const answer = (o: Record<string, unknown>) => () => (async function* () { yield init; yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.04, duration_ms: 10, num_turns: 2, usage: {}, structured_output: o, errors: [] }; })();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-routes-"));
  process.env.DATA_DIR = tmp;
  const { db } = await import("../db.js");
  await import("../history/store.js");
  await import("../quant/stock-score.js");
  await import("../research/bulk-store.js");
  const { earningsDb } = await import("../earnings/db.js");
  m = {
    db, edb: earningsDb,
    review: await import("../earnings/review.js"), score: await import("../earnings/score.js"),
    seed: await import("../earnings/fixtures/seed.js"), stats: await import("../earnings/stats.js"),
  };
  m.seed.seedAdhoc();
  (await import("../earnings/fixtures/synthetic.js")).seedScreenDay(120, "2026-10-22", false);
  m.stats.rebuildStats();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(m.seed.NOW);
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
  delete process.env.AGENTS_ENABLED;
  delete process.env.AGENTS_DAILY_BUDGET_USD;
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
const settle = async () => {
  for (let i = 0; i < 100 && m.review.pendingReviews() > 0; i++) await new Promise((r) => setTimeout(r, 20));
};

describe("GET /screen", () => {
  it("returns every match with no default limit, sorted by score", async () => {
    const { status, body } = await get("/screen?from=2026-10-22");
    expect(status).toBe(200);
    expect(body.length).toBe(127); // 7 ad-hoc names + 120 synthetic
    const scores = body.map((s: any) => s.score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    expect(body[0].components).toHaveLength(5);
  });
  it("filters: limit, tradable, symbols, minScore, verdict, time, sector, sort", async () => {
    expect((await get("/screen?from=2026-10-22&limit=5")).body).toHaveLength(5);
    const tradable = (await get("/screen?from=2026-10-22&symbols=RNG,MXL,APPF,WDC&tradable=true")).body;
    expect(tradable.map((s: any) => s.symbol).sort()).toEqual(["MXL", "RNG", "WDC"]);
    expect((await get("/screen?from=2026-10-22&symbols=RNG,APPF&verdict=pass")).body.map((s: any) => s.symbol)).toEqual(["APPF"]);
    const high = (await get("/screen?from=2026-10-22&minScore=60")).body;
    expect(high.every((s: any) => s.score >= 60)).toBe(true);
    expect((await get("/screen?from=2026-10-22&time=bmo")).body.every((s: any) => s.upcoming.time === "bmo")).toBe(true);
    expect((await get("/screen?from=2026-10-22&sector=Technology")).body.every((s: any) => s.sector === "Technology")).toBe(true);
    const bySymbol = (await get("/screen?from=2026-10-22&sort=symbol&limit=3")).body.map((s: any) => s.symbol);
    expect(bySymbol).toEqual([...bySymbol].sort());
  });
  it("defaults to the next session and rejects bad input", async () => {
    expect((await get("/screen")).body).toHaveLength(127);
    expect((await get("/screen?horizon=year")).status).toBe(400);
    expect((await get("/screen?from=yesterday")).status).toBe(400);
  });
});

describe("other reads", () => {
  it("GET /setup/:symbol", async () => {
    const ok = await get("/setup/rng?horizon=intraday");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ symbol: "RNG", horizon: "intraday", weightsVersion: "earn-v1" });
    expect(ok.body.upcoming).toMatchObject({ reportDate: "2026-10-22", time: "amc", t0: "2026-10-22" });
    expect(ok.body.analyst).toEqual([]);
    expect((await get("/setup/NOPE")).status).toBe(404);
    expect((await get("/setup/RNG?horizon=bad")).status).toBe(400);
  });
  it("GET /setup falls back to a live chain only here, when no snapshot exists", async () => {
    m.edb.prepare("INSERT INTO upcoming (symbol, report_date, time, time_source, t0, r) VALUES ('LIVE','2026-10-22','amc','fmp','2026-10-22','2026-10-23')").run();
    const s = await m.score.setupFor("LIVE", "intraday", {
      now: m.seed.NOW,
      live: async () => ({ price: 50, candidates: [{ kind: "event", leg: "atm_call", occ: "LIVE261023C00050000", expiry: "2026-10-23", strike: 50, bid: 1, ask: 1.04, iv: 0.5, delta: 0.5, volume: 90, openInterest: 10 }] }),
    });
    expect(s!.contract!.occ).toBe("LIVE261023C00050000");
    expect(s!.live.price).toBe(50);
    const none = await m.score.setupFor("LIVE", "intraday", { now: m.seed.NOW, live: async () => { throw new Error("offline"); } });
    expect(none!.contract).toBeNull();
    expect(none!.verdict).toBe("pass");
  });
  it("GET /calendar", async () => {
    const { body } = await get("/calendar?from=2026-10-22&to=2026-10-22&time=amc");
    expect(body.length).toBeGreaterThan(7);
    const rng = body.find((r: any) => r.symbol === "RNG");
    expect(rng).toMatchObject({ reportDate: "2026-10-22", time: "amc", timeSource: "fmp", optionable: true, tradable: true });
    expect(rng.lastReport.reactionPct).toBeCloseTo(25.09, 1);
    expect(body.find((r: any) => r.symbol === "APPF").tradable).toBe(false);
    const noOpt = (await get("/calendar?from=2026-10-22&to=2026-10-22&optionable=false")).body;
    expect(noOpt.every((r: any) => r.optionable === false)).toBe(true);
    expect(noOpt.some((r: any) => r.symbol === "RNG")).toBe(false);
    expect((await get("/calendar?from=nope")).status).toBe(400);
  });
  it("GET /events/:symbol", async () => {
    const { body } = await get("/events/RNG?from=2025-01-01&confirmed=true");
    expect(body.length).toBe(7);
    expect(body[0].reportDate > body[1].reportDate).toBe(true);
    expect(body[0]).toMatchObject({ symbol: "RNG", confirmed: true, time: "amc" });
    expect(body[0].stock).toMatchObject({ "T0:10:00": expect.any(Number), prevClose: expect.any(Number) });
    expect(body.find((e: any) => e.options.length > 0).options[0]).toMatchObject({ entry: "T0:10:00", expiryKind: "event", leg: "atm_call" });
    expect((await get("/events/RNG?confirmed=false")).body).toEqual([]);
  });
  it("GET /stats", async () => {
    const own = await get("/stats?symbol=RNG&horizon=intraday");
    expect(own.body).toMatchObject({ horizon: "intraday", time: "any", scope: { symbol: "RNG" } });
    expect(own.body.n).toBe(10);
    expect((await get("/stats?symbol=RNG&time=amc")).body.time).toBe("amc");
    expect((await get("/stats")).body.scope).toEqual({ symbol: null, sector: null, capBucket: null });
    expect((await get("/stats?symbol=ZZZ")).status).toBe(404);
    expect((await get("/stats?sector=Technology")).status).toBe(400);
  });
  it("GET /status", async () => {
    const { body } = await get("/status");
    expect(body.backfill).toMatchObject({ eventsStored: 550, eventsConfirmed: 550 });
    expect(body.backfill.phase).toBe("idle");
    const mark = (task: string, n: number) => { for (let i = 0; i < n; i++) m.edb.prepare("INSERT OR REPLACE INTO backfill_progress (task, symbol, status, updated_at) VALUES (?,?,'done','2020-01-01T00:00:00Z')").run(task, `P${i}`); };
    mark("events", 10);
    expect((await get("/status")).body.backfill.phase).toBe("stock");
    mark("stock", 10);
    expect((await get("/status")).body.backfill.phase).toBe("options");
    mark("options", 4);
    expect((await get("/status")).body.backfill.phase).toBe("options");
    mark("options", 10);
    expect((await get("/status")).body.backfill.phase).toBe("done");
    m.edb.prepare("DELETE FROM backfill_progress").run();
    expect(body.snapshots.namesTracked).toBe(127);
    expect(body.db.sizeBytes).toBeGreaterThan(0);
  });
});

describe("POST /review and GET /reviews", () => {
  const symbols = ["RNG", "MXL", "WDC", "APPF"];

  it("dryRun matches and fits the budget but queues nothing", async () => {
    const r = await post("/review", { horizon: "intraday", symbols, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ queued: 0, wouldQueue: 3, skipped: 0, estimatedCostUsd: 0.45 });
    expect(m.review.pendingReviews()).toBe(0);
  });

  it("queues every match whose gates passed (default filter) and runs the agent", async () => {
    queryMock.mockImplementation(answer(output()));
    const r = await post("/review", { horizon: "intraday", symbols });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ queued: 3, skipped: 0, estimatedCostUsd: 0.45 });
    await settle();
    const reviews = (await get("/reviews?reportDate=2026-10-22&horizon=intraday")).body;
    expect(reviews.map((x: any) => x.symbol).sort()).toEqual(["MXL", "RNG", "WDC"]);
    const rng = reviews.find((x: any) => x.symbol === "RNG");
    const setup = (await get("/setup/RNG")).body;
    expect(rng).toMatchObject({ status: "ok", adjustment: 5, verdict: "wait", baseScore: setup.score, adjustedScore: setup.score + 5, costUsd: 0.04 });
    expect(rng.newsFactors[0].evidence[0].source).toBe("market_news");
    // The agent got the tool list and the precomputed setup in the prompt.
    const call = queryMock.mock.calls[0][0];
    expect(call.options.allowedTools).toContain("mcp__openterminal__earnings_setup");
    expect(call.options.maxTurns).toBe(6);
    expect(call.options.maxBudgetUsd).toBe(0.15);
    expect(call.prompt).toContain('"weightsVersion":"earn-v1"');
  });

  it("dedupes per symbol, horizon, report date and day; filter and from/to on reviews", async () => {
    queryMock.mockImplementation(answer(output()));
    await post("/review", { horizon: "intraday", symbols });
    await settle();
    const again = await post("/review", { horizon: "intraday", symbols });
    expect(again.body).toMatchObject({ queued: 0, skipped: 3 });
    const wk = await post("/review", { horizon: "week", symbols: ["RNG"], filter: { tradable: false } });
    expect(wk.body.queued).toBe(1); // another horizon is another item
    await settle();
    expect((await get("/reviews?from=2026-10-22&to=2026-10-22")).body.length).toBe(4);
    expect((await get("/reviews?from=2026-10-23")).body).toEqual([]);
    expect((await get("/reviews?to=2026-10-21")).body).toEqual([]);
    expect((await get("/reviews?symbol=rng&horizon=week")).body).toHaveLength(1);
  });

  it("answers 402 when the budget cannot fit one, 503 when disabled, 400 on bad bodies", async () => {
    process.env.AGENTS_DAILY_BUDGET_USD = "0.1";
    expect((await post("/review", { horizon: "intraday", symbols })).status).toBe(402);
    expect((await post("/review", { horizon: "intraday", symbols, dryRun: true })).status).toBe(402);
    delete process.env.AGENTS_DAILY_BUDGET_USD;
    process.env.AGENTS_ENABLED = "0";
    expect((await post("/review", { horizon: "intraday", symbols })).status).toBe(503);
    delete process.env.AGENTS_ENABLED;
    expect((await post("/review", { symbols })).status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("review guardrail", () => {
  const setup = async () => (await m.score.setupFor("RNG", "intraday", { now: m.seed.NOW }))!;

  it("rejects an adjustment beyond +-15 and keeps the base score", async () => {
    queryMock.mockImplementation(answer(output({ adjustment: 22 })));
    const s = await setup();
    const { review } = await m.review.reviewSetup(s);
    expect(review).toMatchObject({ status: "error", adjustment: null, adjustedScore: null, baseScore: s.score });
    expect(review!.statusReason).toMatch(/outside \+-15/);
  });
  it("accepts exactly 15 and clamps the adjusted score to 0..100", async () => {
    queryMock.mockImplementation(answer(output({ adjustment: -15 })));
    const s = await setup();
    expect((await m.review.reviewSetup(s)).review).toMatchObject({ status: "ok", adjustment: -15, adjustedScore: s.score - 15 });
  });
  it("requires evidence for a non-zero adjustment and refuses act on a failed gate", async () => {
    queryMock.mockImplementation(answer(output({ newsFactors: [] })));
    expect((await m.review.reviewSetup(await setup())).review!.statusReason).toMatch(/evidence/);
    queryMock.mockImplementation(answer(output({ adjustment: 0, verdict: "act" })));
    const bad = (await m.score.setupFor("APPF", "intraday", { now: m.seed.NOW }))!;
    expect((await m.review.reviewSetup(bad)).review!.statusReason).toMatch(/failed gate/);
    queryMock.mockImplementation(answer(output({ adjustment: 0, newsFactors: [], verdict: "act" })));
    expect((await m.review.reviewSetup(await setup())).review).toMatchObject({ status: "ok", verdict: "act", adjustment: 0 });
  });
  it("stores a run that fails as an error review; a budget refusal stores nothing", async () => {
    queryMock.mockImplementation(() => (async function* () { yield init; yield { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.1, errors: ["too many turns"] }; })());
    const r = await m.review.reviewSetup(await setup());
    expect(r.review).toMatchObject({ status: "error", costUsd: 0.1 });
    process.env.AGENTS_DAILY_BUDGET_USD = "0.05";
    const skipped = await m.review.reviewSetup(await setup());
    expect(skipped).toEqual({ review: null, skipped: "budget" });
  });
});
