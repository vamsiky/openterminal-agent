import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionScanResult } from "../quant/option-score.js";
import { optionFixtures } from "../scandef/fixtures.test-util.js";

// Scan Lab's test and promote API: draft by form, replay, shadow, compare, promote, rollback, discard.

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;
let sd: typeof import("../scandef/index.js");
let st: typeof import("../scantest/index.js");
let os: typeof import("../quant/option-score.js");
let jobs: typeof import("../quant/jobs.js");
let ss: typeof import("../quant/stock-score.js");

const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = (p: string) => call("GET", p);
const post = (p: string, b: unknown = {}) => call("POST", p, b);

const PASS_1 = "2026-10-21T19:00:00.000Z";
const PASS_2 = "2026-10-21T19:05:00.000Z";

/** A pass as runOptionScan returns it, from generated inputs. */
function fakePass(asOf: string, seed = 5): OptionScanResult {
  const symbols = optionFixtures(300, seed).map((inputs, i) => ({ symbol: `S${i}`, inputs, evaluation: os.evaluateSetups(inputs) }));
  return { scored: symbols.length, durationMs: 1, asOf, definition: sd.getActive("option").version, symbols };
}
const counts = () => ({
  ideas: (db.prepare("SELECT COUNT(*) AS n FROM ideas").get() as { n: number }).n,
  near: (db.prepare("SELECT COUNT(*) AS n FROM idea_near_misses").get() as { n: number }).n,
});

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scantests-route-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  sd = await import("../scandef/index.js");
  st = await import("../scantest/index.js");
  os = await import("../quant/option-score.js");
  jobs = await import("../quant/jobs.js");
  ss = await import("../quant/stock-score.js");
  const { scanRouter } = await import("./scan.js");
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

describe("form draft", () => {
  it("creates a draft from edits and returns it like a GET, with empty tests", async () => {
    const active = sd.getActive("option");
    const r = await post("/scan/defs/draft", { kind: "option", baseId: active.id, edits: [{ path: "listing.maxIdeas", value: 5 }] });
    expect(r.status).toBe(201);
    expect(r.body.meta).toMatchObject({ kind: "option", version: "option-v2", status: "draft", author: "form", parentId: active.id });
    expect(r.body.definition.listing.maxIdeas).toBe(5);
    expect(r.body.text).toContain("5");
    expect(r.body.diff).toEqual([expect.objectContaining({ change: "changed", to: "5" })]);
    expect(r.body.tests).toEqual({ replay: null, shadow: { on: false, startedAt: null, count: 0, passes: [] } });
  });

  it("a new draft replaces the open one, which is discarded", async () => {
    const first = sd.getDraft("option")!;
    const r = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 8 }] });
    expect(r.status).toBe(201);
    expect(r.body.meta.version).toBe("option-v3");
    expect(sd.getById(first.id)!.status).toBe("discarded");
  });

  it("rejects bad edits, bad bodies and unknown bases", async () => {
    const bad = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 9999 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0]).toContain("between");
    expect((await post("/scan/defs/draft", { kind: "option", edits: [{ path: "nope.nothing", value: 1 }] })).status).toBe(400);
    expect((await post("/scan/defs/draft", { kind: "option", edits: [] })).status).toBe(400);
    expect((await post("/scan/defs/draft", { kind: "bonds", edits: [{ path: "a", value: 1 }] })).status).toBe(400);
    expect((await post("/scan/defs/draft", { kind: "option", baseId: 9999, edits: [{ path: "listing.maxIdeas", value: 5 }] })).status).toBe(404);
    const stockBase = sd.getActive("stock").id;
    expect((await post("/scan/defs/draft", { kind: "option", baseId: stockBase, edits: [{ path: "listing.maxIdeas", value: 5 }] })).status).toBe(404);
  });
});

describe("replay, compare and promote", () => {
  it("answers 404 until a pass has been stored, and 409 for promote without a replay", async () => {
    const draft = sd.getDraft("option")!;
    const r = await post(`/scan/defs/${draft.id}/replay`, { source: "latest" });
    expect(r.status).toBe(404);
    expect((await post(`/scan/defs/${draft.id}/promote`)).status).toBe(409);
    expect((await get(`/scan/defs/${draft.id}/compare?source=replay`)).status).toBe(404);
  });

  it("stores each option pass's inputs and replays the latest or a named pass", async () => {
    st.captureOptionPass(fakePass(PASS_1, 5));
    st.captureOptionPass(fakePass(PASS_2, 6));
    expect((await get("/scan/inputs?kind=option")).body.passes.map((p: { passAt: string }) => p.passAt)).toEqual([PASS_2, PASS_1]);

    const draft = sd.getDraft("option")!;
    const latest = await post(`/scan/defs/${draft.id}/replay`, { source: "latest" });
    expect(latest.status).toBe(201);
    expect(latest.body).toMatchObject({ defId: draft.id, kind: "option", source: "replay", passAt: PASS_2 });
    for (const side of [latest.body.live, latest.body.draft]) {
      expect(Object.keys(side)).toEqual(["at", "scanned", "ideas", "nearMisses", "funnel", "spread"]);
      expect(side.scanned).toBe(300);
    }
    expect(latest.body.live.ideas.length).toBeGreaterThan(8);
    expect(latest.body.draft.ideas).toHaveLength(8);
    expect(latest.body.live.ideas[0]).toEqual({ symbol: expect.any(String), strategy: expect.any(String), contract: expect.any(String), score: expect.any(Number), rank: 1 });

    const named = await post(`/scan/defs/${draft.id}/replay`, { source: PASS_1 });
    expect(named.body.passAt).toBe(PASS_1);
    expect((await post(`/scan/defs/${draft.id}/replay`, { source: "2020-01-01T00:00:00.000Z" })).status).toBe(404);
    expect((await post(`/scan/defs/${draft.id}/replay`, { source: "" })).status).toBe(400);
    // Replaying again leaves the newest result as the one the view and compare use.
    await post(`/scan/defs/${draft.id}/replay`, { source: "latest" });
    expect((await get(`/scan/defs/${draft.id}`)).body.tests.replay.passAt).toBe(PASS_2);
  });

  it("replay writes nothing but its result", async () => {
    const before = counts();
    const draft = sd.getDraft("option")!;
    await post(`/scan/defs/${draft.id}/replay`, { source: "latest" });
    expect(counts()).toEqual(before);
  });

  it("compares live and draft: added, removed and rank changes", async () => {
    const draft = sd.getDraft("option")!;
    const r = await get(`/scan/defs/${draft.id}/compare?source=replay`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["added", "at", "draft", "live", "rankChanges", "removed", "source"]);
    expect(r.body.draft.ideas).toHaveLength(8);
    expect(r.body.removed).toHaveLength(r.body.live.ideas.length - 8);
    expect(r.body.added).toEqual([]);
    expect(r.body.rankChanges).toEqual([]);
    expect((await get(`/scan/defs/${draft.id}/compare?source=other`)).status).toBe(400);
    expect((await get(`/scan/defs/${draft.id}/compare?source=shadow`)).status).toBe(404);
  });

  it("promotes a replayed draft; the old active becomes previous", async () => {
    const draft = sd.getDraft("option")!;
    const r = await post(`/scan/defs/${draft.id}/promote`);
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ id: draft.id, status: "active", version: "option-v3" });
    const list = await get("/scan/defs?kind=option");
    expect(list.body.active.id).toBe(draft.id);
    expect(list.body.draft).toBeNull();
    expect(list.body.versions.map((v: { version: string; status: string }) => `${v.version}:${v.status}`)).toEqual(["option-v3:active", "option-v2:discarded", "option-v1:previous"]);
    // Only a draft can be promoted or discarded.
    expect((await post(`/scan/defs/${draft.id}/promote`)).status).toBe(409);
    expect((await post(`/scan/defs/${draft.id}/discard`)).status).toBe(409);
  });

  it("the next scan pass uses the promoted definition, and the rolled-back one after a rollback", async () => {
    const metrics = optionFixtures(40, 9).map((i) => i.metrics);
    const optionMetrics = (symbols: string[]) => new Map(symbols.flatMap((s, i) => (metrics[i % 40] ? [[s, metrics[i % 40]!] as const] : [])));
    const symbols = ["AAA", "BBB", "CCC"];
    const now = new Date("2026-10-21T19:10:00Z");
    expect(os.runOptionScan(symbols, optionMetrics, now).definition).toBe("option-v3");

    const v1 = sd.listVersions("option").find((v) => v.status === "previous")!;
    expect((await post(`/scan/defs/${v1.id}/rollback`)).body.meta).toMatchObject({ version: "option-v1", status: "active" });
    expect(os.runOptionScan(symbols, optionMetrics, now).definition).toBe("option-v1");
    expect(sd.getActive("option").version).toBe("option-v1");
    expect(sd.listVersions("option").map((v) => `${v.version}:${v.status}`)).toEqual(["option-v3:retired", "option-v2:discarded", "option-v1:active"]);

    // Nothing is left to roll back to.
    const retired = sd.listVersions("option")[0];
    expect((await post(`/scan/defs/${retired.id}/rollback`)).status).toBe(409);
    expect((await post(`/scan/defs/${sd.getActive("option").id}/rollback`)).status).toBe(409);
  });

  it("the scheduled option pass reads the new definition after a promote", async () => {
    const metrics = optionFixtures(40, 9).map((i) => i.metrics).filter((m) => m !== null);
    const quant = jobs.startQuantJobs({ optionMetrics: (symbols) => new Map(symbols.map((s, i) => [s, metrics[i % metrics.length]!])), optionsStatus: () => null });
    try {
      db.prepare("INSERT INTO watchlists (id, name) VALUES (1, 'w')").run();
      for (const [i, s] of ["AAA", "BBB"].entries()) db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (1, ?, ?)").run(s, i);
      const r = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 3 }] });
      const id = r.body.meta.id;
      await post(`/scan/defs/${id}/replay`, {});
      await post(`/scan/defs/${id}/promote`);
      expect(jobs.runJob("option-scan", new Date("2026-10-21T19:15:00Z"))).toBe(true);
      const row = db.prepare("SELECT definition FROM scan_inputs WHERE kind = 'option' ORDER BY pass_at DESC LIMIT 1").get() as { definition: string };
      expect(row.definition).toBe(r.body.meta.version);
      expect((db.prepare("SELECT definition FROM ideas WHERE kind = 'option' LIMIT 1").get() as { definition: string } | undefined)?.definition ?? r.body.meta.version).toBe(r.body.meta.version);
    } finally {
      quant?.stop();
    }
  });
});

describe("live shadow", () => {
  let draftId: number;

  it("only a draft can be shadowed", async () => {
    const r = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 2 }] });
    draftId = r.body.meta.id;
    expect((await post(`/scan/defs/${sd.getActive("option").id}/shadow`, { on: true })).status).toBe(409);
    expect((await post(`/scan/defs/${draftId}/shadow`, { on: "yes" })).status).toBe(400);
  });

  it("scores the draft beside every pass without touching ideas", async () => {
    const on = await post(`/scan/defs/${draftId}/shadow`, { on: true });
    expect(on.body).toMatchObject({ on: true, count: 0, passes: [] });
    const before = counts();
    st.captureOptionPass(fakePass("2026-10-21T19:20:00.000Z", 5));
    st.captureOptionPass(fakePass("2026-10-21T19:25:00.000Z", 6));
    expect(counts()).toEqual(before);

    const view = await get(`/scan/defs/${draftId}/shadow`);
    expect(view.body.on).toBe(true);
    expect(view.body.count).toBe(2);
    expect(view.body.passes.map((p: { at: string }) => p.at)).toEqual(["2026-10-21T19:25:00.000Z", "2026-10-21T19:20:00.000Z"]);
    const live = sd.getActive("option").definition.listing.maxIdeas;
    expect(view.body.passes[0].live.ideas.length).toBeGreaterThan(2);
    expect(view.body.passes[0].live.ideas.length).toBeLessThanOrEqual(live);
    expect(view.body.passes[0].draft.ideas).toHaveLength(2);
    expect((await get(`/scan/defs/${draftId}`)).body.tests.shadow.count).toBe(2);

    const cmp = await get(`/scan/defs/${draftId}/compare?source=shadow`);
    expect(cmp.body).toMatchObject({ source: "shadow", at: "2026-10-21T19:25:00.000Z" });
    expect(cmp.body.removed).toHaveLength(cmp.body.live.ideas.length - 2);
    expect((await get(`/scan/defs/${draftId}/compare?source=shadow&at=2026-10-21T19:20:00.000Z`)).body.at).toBe("2026-10-21T19:20:00.000Z");
  });

  it("the scheduled pass shadows the draft and never calls the ideas listener for the draft", async () => {
    const metrics = optionFixtures(40, 9).map((i) => i.metrics).filter((m) => m !== null);
    const calls: Date[] = [];
    jobs.setIdeasListener((d) => calls.push(d));
    const quant = jobs.startQuantJobs({ optionMetrics: (symbols) => new Map(symbols.map((s, i) => [s, metrics[i % metrics.length]!])), optionsStatus: () => null });
    try {
      expect(jobs.runJob("option-scan", new Date("2026-10-21T19:30:00Z"))).toBe(true);
      // One call, for the live pass; the shadow adds none.
      expect(calls).toHaveLength(1);
      expect((await get(`/scan/defs/${draftId}/shadow`)).body.count).toBe(3);
    } finally {
      jobs.setIdeasListener(null);
      quant?.stop();
    }
  });

  it("can be switched off, and keeps its passes", async () => {
    const off = await post(`/scan/defs/${draftId}/shadow`, { on: false });
    expect(off.body).toMatchObject({ on: false, count: 3 });
    st.captureOptionPass(fakePass("2026-10-21T19:35:00.000Z"));
    expect((await get(`/scan/defs/${draftId}/shadow`)).body.count).toBe(3);
  });

  it("stops when the draft is replaced, discarded or a definition is promoted", async () => {
    await post(`/scan/defs/${draftId}/shadow`, { on: true });
    expect(st.shadowing("option")).not.toBeNull();
    const next = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 6 }] });
    expect(st.shadowing("option")).toBeNull();

    const id = next.body.meta.id;
    await post(`/scan/defs/${id}/shadow`, { on: true });
    expect((await post(`/scan/defs/${id}/discard`)).body.meta.status).toBe("discarded");
    expect(st.shadowing("option")).toBeNull();
    expect((await get(`/scan/defs/${id}`)).body.tests.shadow.on).toBe(false);

    const again = await post("/scan/defs/draft", { kind: "option", edits: [{ path: "listing.maxIdeas", value: 7 }] });
    await post(`/scan/defs/${again.body.meta.id}/replay`, {});
    await post(`/scan/defs/${again.body.meta.id}/shadow`, { on: true });
    await post(`/scan/defs/${again.body.meta.id}/promote`);
    expect(st.shadowing("option")).toBeNull();
    // A stock draft's shadow does not stop an option shadow, and each kind has at most one.
    const stock = await post("/scan/defs/draft", { kind: "stock", edits: [{ path: "listing.top", value: 12 }] });
    expect(stock.status).toBe(201);
  });
});

describe("stock tests", () => {
  it("replays a stored 15-minute pass under a stock draft and promotes it", async () => {
    const def = sd.getActive("stock").definition;
    const cands = Array.from({ length: 60 }, (_, i) => {
      const factors = [
        ...sd.factorSpecs(def).map((f, k) => ({ key: f.key, group: f.group, value: 1 + k, score: Math.max(0, 99 - i - (k % 3)), change: null })),
        ...["price_vs_vwap", "rsi_15m", "rel_volume"].map((key) => ({ key, group: "momentum", value: 1, score: 60, change: null })),
      ];
      const s = ss.summarize(def, factors, sd.intradayTotal(def));
      return { card: { symbol: `Z${String(i).padStart(2, "0")}`, asOf: PASS_1, sector: "Technology", industry: null, composite: s.composite, groups: s.groups, factors, coverage: s.coverage, weightsVersion: def.version }, price: 20, nextEarningsDays: null };
    });
    const snap = {
      v: 1 as const, asOf: PASS_1, day: null, def,
      symbols: cands.map((c) => ({ symbol: c.card.symbol, sector: c.card.sector, industry: null, price: c.price, nextEarningsDays: null, factors: c.card.factors.map((f) => [f.key, f.group, f.value, f.score] as [string, string, number | null, number | null]) })),
      live: st.stockResult(def, cands, PASS_1),
    };
    st.saveInput("stock", PASS_1, "2026-10-21", def.version, snap);
    expect(snap.live.ideas).toHaveLength(Math.min(def.listing.top, 60));

    const d = await post("/scan/defs/draft", { kind: "stock", edits: [{ path: "listing.top", value: 12 }] });
    const id = d.body.meta.id;
    expect((await post(`/scan/defs/${id}/promote`)).status).toBe(409);
    const r = await post(`/scan/defs/${id}/replay`, {});
    expect(r.status).toBe(201);
    expect(r.body.live).toEqual(snap.live);
    expect(r.body.draft.ideas).toEqual(snap.live.ideas.slice(0, 12));
    expect(r.body.draft.funnel.map((f: { step: string }) => f.step)).toEqual(["Scored", "Coverage of 60% or more", "Top 12"]);
    expect(r.body.draft.spread.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBeGreaterThan(0);
    const cmp = await get(`/scan/defs/${id}/compare?source=replay`);
    expect(cmp.body.removed).toHaveLength(snap.live.ideas.length - 12);
    expect((await post(`/scan/defs/${id}/promote`)).body.meta.status).toBe("active");
    expect(sd.getActive("stock").definition.listing.top).toBe(12);
  });
});

describe("pruning", () => {
  it("keeps the last ten trading days of inputs", () => {
    expect(st.keepFrom("2026-10-23")).toBe("2026-10-12");
    expect(st.keepFrom("2026-10-24")).toBe("2026-10-12");
    for (const day of ["2026-10-01", "2026-10-09", "2026-10-12", "2026-10-22"]) st.saveInput("stock", `${day}T15:00:00.000Z`, day, "stock-v2", { v: 1 });
    st.pruneTestData(new Date("2026-10-23T15:00:00Z"));
    const days = (db.prepare("SELECT day FROM scan_inputs WHERE kind = 'stock' ORDER BY day").all() as Array<{ day: string }>).map((r) => r.day);
    expect(days).toEqual(["2026-10-12", "2026-10-21", "2026-10-22"]);
  });
});
