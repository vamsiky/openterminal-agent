import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OptionScanResult } from "../quant/option-score.js";
import { optionFixtures } from "../scandef/fixtures.test-util.js";

// Scan Lab end to end over the routes, on generated inputs, in order: an option pass, a form draft tested by
// replay and live shadow, promoted, rolled back and back again; a discard; a build with Claude (agent mocked) with
// per-line outcomes; a refused build; a code request; and a stock reweight. Uses the test DB, never data/.
// The option passes do what the scheduled job does after scoring (scorecards, ideas, capture): the job's own
// scoring needs stored minute and daily bars, which an empty test DB does not have.

vi.mock("../agents/runtime.js", async (orig) => ({ ...(await orig<typeof import("../agents/runtime.js")>()), runAgent: vi.fn() }));

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;
let sd: typeof import("../scandef/index.js");
let st: typeof import("../scantest/index.js");
let os: typeof import("../quant/option-score.js");
let ideas: typeof import("../quant/ideas.js");
let ss: typeof import("../quant/stock-score.js");
let build: typeof import("../scandef/build.js");
let runAgent: ReturnType<typeof vi.fn>;

const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const get = (p: string) => call("GET", p);
const post = (p: string, b: unknown = {}) => call("POST", p, b);

const PASS_1 = "2026-10-21T19:00:00.000Z";
const PASS_2 = "2026-10-21T19:05:00.000Z";
const PASS_3 = "2026-10-21T19:10:00.000Z";
const STOCK_PASS = "2026-10-21T19:00:00.000Z";
const BAR = 65;
const NEAR_FROM = 55;

const key = (i: { symbol: string; strategy: string }) => `${i.symbol}|${i.strategy}`;
const activeOption = () => sd.getActive("option");
const versionsOf = (kind: "option" | "stock") => sd.listVersions(kind).map((v) => `${v.version}:${v.status}`);
const distinctDefinitions = () => (db.prepare("SELECT DISTINCT definition FROM ideas WHERE kind = 'option' AND status = 'active' ORDER BY definition").all() as Array<{ definition: string }>).map((r) => r.definition);
const ideaRows = () => db.prepare("SELECT * FROM ideas ORDER BY id").all();

// The bar each name is listed at: option-v1's early bar (60) while its IV history is under 20 days, else the listing score.
const fixture = optionFixtures(300, 5);
const listedAt = (i: { symbol: string; score: number }, bar: number) => i.score >= ((fixture[Number(i.symbol.slice(1))].metrics?.ivHistoryDays ?? 0) < 20 ? 60 : bar);

/** A pass as runOptionScan returns it, from generated inputs (300 names). */
function fakePass(asOf: string, seed: number): OptionScanResult {
  const symbols = optionFixtures(300, seed).map((inputs, i) => ({ symbol: `S${i}`, inputs, evaluation: os.evaluateSetups(inputs) }));
  return { scored: symbols.length, durationMs: 1, asOf, definition: sd.getActive("option").version, symbols };
}

/** The scheduled pass's tail: scorecards, then the ideas, then the capture. */
function scheduledPass(r: OptionScanResult): void {
  db.prepare("DELETE FROM option_scorecards").run();
  for (const s of r.symbols) {
    const setups = s.evaluation.setups;
    const card = { underlying: s.symbol, asOf: r.asOf, score: setups[0]?.score ?? null, momentum: s.inputs.momentum, metrics: s.inputs.metrics, earningsBeforeExpiry: null, nextEarnings: null, setups, definition: r.definition };
    db.prepare("INSERT INTO option_scorecards (underlying, as_of, score, data) VALUES (?, ?, ?, ?)").run(s.symbol, r.asOf, card.score, JSON.stringify(card));
  }
  ideas.updateOptionIdeas(new Date(r.asOf));
  st.captureOptionPass(r);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scan-e2e-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  sd = await import("../scandef/index.js");
  st = await import("../scantest/index.js");
  os = await import("../quant/option-score.js");
  ideas = await import("../quant/ideas.js");
  ss = await import("../quant/stock-score.js");
  build = await import("../scandef/build.js");
  runAgent = (await import("../agents/runtime.js")).runAgent as unknown as ReturnType<typeof vi.fn>;
  const { scanRouter } = await import("../routes/scan.js");
  const app = express();
  app.use(express.json());
  app.use("/api/scan", scanRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("option lifecycle", () => {
  let v1Id = 0;
  let v2Id = 0;
  let live: any;
  let draftResult: any;

  it("1. an option pass captures its inputs and lists ideas under option-v1", () => {
    v1Id = activeOption().id;
    scheduledPass(fakePass(PASS_1, 5));
    const listed = ideas.listIdeas({ kind: "option" });
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed.map((i) => i.definition))).toEqual(new Set(["option-v1"]));
    expect(activeOption().version).toBe("option-v1");
  });

  it("1. the captured pass is stored under its time and day", async () => {
    const r = await get("/scan/inputs?kind=option");
    expect(r.body.passes[0]).toMatchObject({ passAt: PASS_1, definition: "option-v1" });
  });

  it("2. a form draft lowers the bar to 65 and keeps near misses from 55", async () => {
    const r = await post("/scan/defs/draft", {
      kind: "option",
      baseId: v1Id,
      edits: [
        { path: "listing.minScore", value: BAR },
        { path: "listing.nearMissFrom", value: NEAR_FROM },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.meta).toMatchObject({ version: "option-v2", status: "draft", author: "form", parentId: v1Id });
    v2Id = r.body.meta.id;
    expect(r.body.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Listing › List a setup when it scores at least", from: "70", to: "65", change: "changed" }),
        expect.objectContaining({ label: "Listing › Keep near misses from (empty = off)", to: "55", change: "changed" }),
      ]),
    );
    expect(r.body.text).toContain("scores 65 or more");
    expect(r.body.tests).toEqual({ replay: null, shadow: { on: false, startedAt: null, count: 0, passes: [] } });
    // The draft replaces the open one from the first step.
    expect(versionsOf("option")).toEqual(["option-v2:draft", "option-v1:active"]);
  });

  it("2. promote is refused until the draft has been replayed", async () => {
    const r = await post(`/scan/defs/${v2Id}/promote`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/replay option-v2 before promoting/);
    expect(activeOption().version).toBe("option-v1");
  });

  it("2. replay of a pass that was never stored is 404", async () => {
    const r = await post(`/scan/defs/${v2Id}/replay`, { source: "2020-01-01T00:00:00.000Z" });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no stored option pass at 2020-01-01/);
  });

  it("2. replay scores the stored pass with the draft and with the active definition", async () => {
    const r = await post(`/scan/defs/${v2Id}/replay`, { source: "latest" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ defId: v2Id, kind: "option", source: "replay", passAt: PASS_1 });
    live = r.body.live;
    draftResult = r.body.draft;
    expect(live.scanned).toBe(draftResult.scanned);
    expect(live.ideas.length).toBeGreaterThan(0);
    expect(draftResult.ideas.length).toBeGreaterThanOrEqual(live.ideas.length);
  });

  it("2. the draft lists every live idea and more, with near misses in the band", () => {
    const draftKeys = new Set(draftResult.ideas.map(key));
    for (const i of live.ideas) expect(draftKeys.has(key(i))).toBe(true);
    // Both sides fill the 20-idea cap on this data, so the draft's list can only match live, not grow past it.
    expect(draftResult.ideas.length).toBeGreaterThanOrEqual(live.ideas.length);
    expect(draftResult.ideas.every((i: { symbol: string; score: number }) => listedAt(i, BAR))).toBe(true);
    expect(draftResult.nearMisses.length).toBeGreaterThan(0);
    for (const n of draftResult.nearMisses) {
      expect(n.score).toBeGreaterThanOrEqual(NEAR_FROM);
      expect(n.score).toBeLessThan(BAR);
    }
    expect(live.nearMisses).toEqual([]);
  });

  it("2. compare: the draft's added names, with no live names removed", async () => {
    const r = await get(`/scan/defs/${v2Id}/compare?source=replay`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["added", "at", "draft", "live", "rankChanges", "removed", "source"]);
    expect(r.body.removed).toEqual([]);
    expect(r.body.added).toHaveLength(draftResult.ideas.length - live.ideas.length);
  });

  it("2. live shadow turns on for the draft, and only a draft can be shadowed", async () => {
    expect((await post(`/scan/defs/${v1Id}/shadow`, { on: true })).status).toBe(409);
    const on = await post(`/scan/defs/${v2Id}/shadow`, { on: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ on: true, count: 0, passes: [] });
  });

  it("2. one pass records a shadow row and the draft writes no ideas", () => {
    // The live pass writes its ideas first, as the job does; the capture then scores the draft beside it.
    const r = fakePass(PASS_2, 5);
    db.prepare("DELETE FROM option_scorecards").run();
    for (const s of r.symbols) db.prepare("INSERT INTO option_scorecards (underlying, as_of, score, data) VALUES (?, ?, ?, ?)").run(s.symbol, r.asOf, s.evaluation.setups[0]?.score ?? null, JSON.stringify({ underlying: s.symbol, asOf: r.asOf, score: s.evaluation.setups[0]?.score ?? null, momentum: s.inputs.momentum, metrics: s.inputs.metrics, earningsBeforeExpiry: null, nextEarnings: null, setups: s.evaluation.setups, definition: r.definition }));
    ideas.updateOptionIdeas(new Date(PASS_2));
    const before = ideaRows();
    st.captureOptionPass(r);
    expect(ideaRows()).toEqual(before);
    expect(distinctDefinitions()).toEqual(["option-v1"]);
  });

  it("2. the shadow row carries the live result and the draft result for that pass", async () => {
    const view = await get(`/scan/defs/${v2Id}/shadow`);
    expect(view.body.on).toBe(true);
    expect(view.body.count).toBe(1);
    const row = view.body.passes[0];
    expect(row.at).toBe(PASS_2);
    expect(row.draft.ideas.length).toBeGreaterThanOrEqual(row.live.ideas.length);
    expect(row.draft.ideas.every((i: { symbol: string; score: number }) => listedAt(i, BAR))).toBe(true);
    const cmp = await get(`/scan/defs/${v2Id}/compare?source=shadow`);
    expect(cmp.body).toMatchObject({ source: "shadow", at: PASS_2 });
  });

  it("2. promote makes the draft active and stops the shadow", async () => {
    const r = await post(`/scan/defs/${v2Id}/promote`);
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ id: v2Id, version: "option-v2", status: "active" });
    expect(versionsOf("option")).toEqual(["option-v2:active", "option-v1:previous"]);
    expect(st.shadowing("option")).toBeNull();
    expect((await post(`/scan/defs/${v2Id}/shadow`, { on: true })).status).toBe(409);
  });

  it("2. the next pass lists with the new bar, under option-v2", () => {
    scheduledPass(fakePass(PASS_3, 5));
    const listed = ideas.listIdeas({ kind: "option" });
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed.map((i) => i.definition))).toEqual(new Set(["option-v2"]));
    expect(listed.every((i) => listedAt(i, BAR))).toBe(true);
  });

  it("2. rollback restores option-v1 and the next pass uses it", async () => {
    const r = await post(`/scan/defs/${v1Id}/rollback`);
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ version: "option-v1", status: "active" });
    expect(versionsOf("option")).toEqual(["option-v2:previous", "option-v1:active"]);
    scheduledPass(fakePass("2026-10-21T19:15:00Z", 5));
    expect(distinctDefinitions()).toEqual(["option-v1"]);
  });

  it("2. switching back rolls option-v2 forward again; rolling the active one back is refused", async () => {
    expect((await post(`/scan/defs/${v2Id}/rollback`)).body.meta).toMatchObject({ version: "option-v2", status: "active" });
    expect(versionsOf("option")).toEqual(["option-v2:active", "option-v1:previous"]);
    expect((await post(`/scan/defs/${v2Id}/rollback`)).status).toBe(409);
  });

  it("3. a discarded draft leaves the active version alone and cannot be promoted", async () => {
    const r = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 9 }] });
    const id = r.body.meta.id;
    expect((await post(`/scan/defs/${id}/discard`)).body.meta.status).toBe("discarded");
    expect(sd.getDraft("option")).toBeNull();
    expect(activeOption().id).toBe(v2Id);
    expect((await post(`/scan/defs/${id}/promote`)).status).toBe(409);
    expect((await post(`/scan/defs/${id}/shadow`, { on: true })).status).toBe(409);
    expect((await get(`/scan/defs/${id}`)).body.meta.status).toBe("discarded");
  });

  it("4. a build with Claude stores its per-line outcomes with each draft's changed line", async () => {
    const GATE = "- Gate · Options not expensive: only buy a call when IV rank is 50 or less.";
    const SI = "- Skip names whose short interest is above 20% of float.";
    const base = sd.render(activeOption().definition);
    const text = base
      .replace("- Gate · Daily uptrend", `${GATE}\n- Gate · Daily uptrend`)
      .replace("- Contract: the at-the-money put (set by the options sweep).", `- Contract: the at-the-money put (set by the options sweep).\n${SI}`);
    const def = structuredClone(activeOption().definition) as any;
    def.strategies.long_call.gates.push({ label: "Options not expensive", expr: "iv_rank", op: "<=", value: 50 });
    runAgent.mockResolvedValueOnce({
      ok: true,
      output: {
        definition: def,
        notes: ["Added an IV rank gate to buying calls."],
        needsCode: [{ request: "short interest", reason: "not in the catalog" }],
        refusal: null,
        lines: [
          { n: 1, action: "applied", explanation: "new gate" },
          { n: 2, action: "needs_code", explanation: "no short interest field" },
        ],
      },
      costUsd: 0.01,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      durationMs: 1,
      error: null,
      status: "ok",
      auth: "api_key",
    });
    const start = await post("/scan/defs/build", { kind: "option", text });
    expect(start.status).toBe(202);
    await build.jobDone(start.body.jobId);
    const j = (await get(`/scan/defs/build/${start.body.jobId}`)).body;
    expect(j).toMatchObject({ status: "done", error: null, notes: ["Added an IV rank gate to buying calls."] });
    const full = [
      { n: 1, kind: "added", section: "BUY A CALL", text: GATE, action: "applied", explanation: "new gate" },
      { n: 2, kind: "added", section: "SELL A CASH-SECURED PUT", text: SI, action: "needs_code", explanation: "no short interest field" },
    ];
    expect(j.lines).toEqual(full);
    const draft = sd.getDraft("option")!;
    expect(j.draftId).toBe(draft.id);
    expect(draft).toMatchObject({ author: "claude", sourceText: text });
    expect((draft.notes as any).lines).toEqual(full);
    expect((draft.notes as any).needsCode).toEqual([{ request: "short interest", reason: "not in the catalog" }]);
    const spec = runAgent.mock.calls.at(-1)![0];
    expect(spec).toMatchObject({ agent: "scanlab", tools: [], maxTurns: 2 });
    expect(spec.maxBudgetUsd).toBe(0.2);

    // 6. A code request is stored against that draft and listed as open.
    const req = await post("/scan/code-requests", { kind: "option", draftId: draft.id, request: "Add short interest", reason: "Not in the catalog" });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ kind: "option", draftId: draft.id, request: "Add short interest", status: "open" });
    const open = await get("/scan/code-requests?kind=option&status=open");
    expect(open.body.requests.map((r: { request: string }) => r.request)).toContain("Add short interest");
    expect((await post("/scan/code-requests", { kind: "option", draftId: 999999, request: "x" })).status).toBe(404);
  });

  it("5. a refused build creates no draft", async () => {
    expect((await post(`/scan/defs/${sd.getDraft("option")!.id}/discard`)).status).toBe(200);
    const before = versionsOf("option");
    const text = `${sd.render(activeOption().definition)}\nbuy puts when momentum is negative`;
    runAgent.mockResolvedValueOnce({
      ok: true,
      output: { definition: structuredClone(activeOption().definition), notes: [], needsCode: [], refusal: "Scan Lab never buys puts, so I did not build this.", lines: [{ n: 1, action: "refused", explanation: "buying puts is not allowed" }] },
      costUsd: 0.01,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      durationMs: 1,
      error: null,
      status: "ok",
      auth: "api_key",
    });
    const start = await post("/scan/defs/build", { kind: "option", text });
    expect(start.status).toBe(202);
    await build.jobDone(start.body.jobId);
    const j = (await get(`/scan/defs/build/${start.body.jobId}`)).body;
    expect(j).toMatchObject({ status: "error", refused: true, draftId: null, error: "Scan Lab never buys puts, so I did not build this." });
    expect(sd.getDraft("option")).toBeNull();
    expect(versionsOf("option")).toEqual(before);
    expect(activeOption().id).toBe(v2Id);
  });

  it("edges: an out-of-range value and an unknown path are 400s, and nothing is drafted", async () => {
    const before = versionsOf("option");
    const range = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 9999 }] });
    expect(range.status).toBe(400);
    expect(range.body.errors[0]).toMatch(/between 1 and 100/);
    const unknown = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "nope.nothing", value: 1 }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/nope\.nothing: no such setting/);
    expect(versionsOf("option")).toEqual(before);
  });
});

describe("stock lifecycle", () => {
  let snap: any;
  let stockDraftId = 0;

  it("replay answers 404 while no stock pass has been stored", async () => {
    const early = await post("/scan/defs/draft", { kind: "stock", edits: [{ path: "listing.top", value: 10 }] });
    expect(early.status).toBe(201);
    const r = await post(`/scan/defs/${early.body.meta.id}/replay`, { source: "latest" });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no stored stock inputs yet/);
    expect((await post(`/scan/defs/${early.body.meta.id}/discard`)).status).toBe(200);
  });

  it("saves a stock pass with generated candidates and scores it live", () => {
    const def = sd.getActive("stock").definition;
    const cands = Array.from({ length: 60 }, (_, i) => {
      const factors = [
        ...sd.factorSpecs(def).map((f, k) => ({ key: f.key, group: f.group, value: 1 + k, score: Math.max(0, 99 - i - (k % 3)), change: null })),
        ...["price_vs_vwap", "rsi_15m", "rel_volume"].map((key) => ({ key, group: "momentum", value: 1, score: 60, change: null })),
      ];
      const s = ss.summarize(def, factors, sd.intradayTotal(def));
      return { card: { symbol: `Z${String(i).padStart(2, "0")}`, asOf: STOCK_PASS, sector: "Technology", industry: null, composite: s.composite, groups: s.groups, factors, coverage: s.coverage, weightsVersion: def.version }, price: 20, nextEarningsDays: null };
    });
    snap = {
      v: 1 as const,
      asOf: STOCK_PASS,
      day: null,
      def,
      symbols: cands.map((c) => ({ symbol: c.card.symbol, sector: c.card.sector, industry: null, price: c.price, nextEarningsDays: null, factors: c.card.factors.map((f) => [f.key, f.group, f.value, f.score] as [string, string, number | null, number | null]) })),
      live: st.stockResult(def, cands, STOCK_PASS),
    };
    st.saveInput("stock", STOCK_PASS, "2026-10-21", def.version, snap);
    expect(snap.live.ideas.length).toBeGreaterThan(0);
  });

  it("weights that do not sum to 1 are rejected, and no draft is made", async () => {
    const w = sd.getActive("stock").definition.groupWeights;
    const r = await post("/scan/defs/draft", { kind: "stock", edits: [{ path: "groupWeights.valuation", value: Math.round((w.valuation + 0.05) * 100) / 100 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sum/i);
    expect(sd.getDraft("stock")).toBeNull();
  });

  it("a reweight draft moves 5 points from momentum to valuation, then replays and compares", async () => {
    const w = sd.getActive("stock").definition.groupWeights;
    const r = await post("/scan/defs/draft", {
      kind: "stock",
      edits: [
        { path: "groupWeights.valuation", value: Math.round((w.valuation + 0.05) * 100) / 100 },
        { path: "groupWeights.momentum", value: Math.round((w.momentum - 0.05) * 100) / 100 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.meta).toMatchObject({ kind: "stock", status: "draft", author: "form" });
    expect(r.body.diff.map((d: { path: string }) => d.path).sort()).toEqual(["groupWeights.momentum", "groupWeights.valuation"]);
    stockDraftId = r.body.meta.id;

    const rep = await post(`/scan/defs/${stockDraftId}/replay`, { source: "latest" });
    expect(rep.status).toBe(201);
    expect(rep.body).toMatchObject({ kind: "stock", source: "replay", passAt: STOCK_PASS });
    expect(rep.body.live).toEqual(snap.live);
    expect(rep.body.draft.funnel[0].step).toBe("Scored");
    expect(rep.body.draft.ideas.length).toBeLessThanOrEqual(sd.getDraft("stock")!.definition.listing.top);

    const cmp = await get(`/scan/defs/${stockDraftId}/compare?source=replay`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.live).toEqual(snap.live);
    expect(cmp.body.draft).toEqual(rep.body.draft);
  });

  it("the stock draft is discarded, and stock versions are untouched", async () => {
    expect((await post(`/scan/defs/${stockDraftId}/discard`)).body.meta.status).toBe("discarded");
    expect(sd.getById(stockDraftId)!.status).toBe("discarded");
    expect(versionsOf("stock")).toContain("stock-v2:active");
    expect(sd.getDraft("stock")).toBeNull();
  });

  it("edges: shadow on a non-draft and rollback to the active are 409s", async () => {
    expect((await post(`/scan/defs/${sd.getActive("stock").id}/shadow`, { on: true })).status).toBe(409);
    expect((await post(`/scan/defs/${sd.getActive("stock").id}/rollback`)).status).toBe(409);
    expect((await post(`/scan/defs/${activeOption().id}/rollback`)).status).toBe(409);
  });
});
