import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;
let sd: typeof import("../scandef/index.js");
let ideas: typeof import("../quant/ideas.js");

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scandefs-route-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  sd = await import("../scandef/index.js");
  ideas = await import("../quant/ideas.js");
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

describe("catalog and definitions", () => {
  it("serves the catalog by scope", async () => {
    const all = await get("/scan/catalog");
    expect(all.body.fields.length).toBe(sd.CATALOG.length);
    const opt = await get("/scan/catalog?scope=option");
    expect(opt.body.fields.every((f: { scope: string }) => f.scope === "option")).toBe(true);
    expect(opt.body.fields[0]).toEqual(expect.objectContaining({ key: "m5", label: expect.any(String), unit: "score_pm100", description: expect.any(String), source: expect.any(String), group: "Momentum" }));
    expect((await get("/scan/catalog?scope=bonds")).status).toBe(400);
  });

  it("lists the active definition, the open draft and the versions", async () => {
    let r = await get("/scan/defs?kind=option");
    expect(r.body.active).toMatchObject({ version: "option-v1", status: "active", author: "built-in" });
    expect(r.body.draft).toBeNull();
    expect(r.body.versions).toHaveLength(1);
    expect((await get("/scan/defs")).status).toBe(400);

    const edited = sd.applyForm(sd.OPTION_V1_DEF, [{ path: "listing.minScore", value: 75 }]);
    if (!edited.ok) throw new Error("form");
    const draft = sd.createDraft({ kind: "option", definition: edited.def, author: "form" });
    r = await get("/scan/defs?kind=option");
    expect(r.body.draft).toMatchObject({ id: draft.id, version: "option-v2", status: "draft" });
    expect(r.body.versions.map((v: { version: string }) => v.version)).toEqual(["option-v2", "option-v1"]);
  });

  it("returns a definition with its text, form and the diff against its parent", async () => {
    const draft = sd.getDraft("option")!;
    const r = await get(`/scan/defs/${draft.id}`);
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ version: "option-v2", parentId: sd.getActive("option").id });
    expect(r.body.definition.listing.minScore).toBe(75);
    expect(r.body.text).toContain("scores 75 or more");
    expect(r.body.form.map((s: { section: string }) => s.section)).toEqual(["Listing", "Buy a call", "Sell a cash-secured put", "Sell a covered call"]);
    expect(r.body.diff).toEqual([expect.objectContaining({ label: "Listing › List a setup when it scores at least", from: "70", to: "75", change: "changed" })]);

    const active = await get(`/scan/defs/${sd.getActive("option").id}`);
    expect(active.body.diff).toEqual([]);
    expect((await get("/scan/defs/9999")).status).toBe(404);
    expect((await get("/scan/defs/abc")).status).toBe(400);
    sd.setStatus(draft.id, "discarded");
  });
});

describe("near misses", () => {
  const card = (underlying: string, score: number | null) => ({
    underlying, asOf: "t", score, momentum: { m5: 0, m15: 0, h1: 0, d1: 0 }, metrics: { ivHistoryDays: 200 }, earningsBeforeExpiry: null, nextEarnings: null,
    setups: score === null ? [] : [{ strategy: "long_call", score, contract: `${underlying}C`, reasons: ["r"] }],
  });
  const seed = (cards: ReturnType<typeof card>[]) => {
    db.prepare("DELETE FROM option_scorecards").run();
    for (const c of cards) db.prepare("INSERT INTO option_scorecards (underlying, as_of, score, data) VALUES (?, 't', ?, ?)").run(c.underlying, c.score, JSON.stringify(c));
  };

  it("keeps none while nearMissFrom is null, and the band once it is set", async () => {
    seed([card("AAA", 85), card("BBB", 72), card("CCC", 68), card("DDD", 62), card("EEE", 50)]);
    ideas.updateOptionIdeas(new Date("2026-10-21T19:00:00Z"));
    expect((await get("/scan/ideas?kind=option&status=near")).body).toEqual({ asOf: null, ideas: [] });
    expect((await get("/scan/ideas?kind=option")).body.ideas.map((i: { symbol: string }) => i.symbol)).toEqual(["AAA", "BBB"]);

    const edited = sd.applyForm(sd.OPTION_V1_DEF, [{ path: "listing.nearMissFrom", value: 60 }]);
    if (!edited.ok) throw new Error("form");
    const d = sd.createDraft({ kind: "option", definition: edited.def, author: "form" });
    sd.setStatus(d.id, "active");
    ideas.updateOptionIdeas(new Date("2026-10-21T19:05:00Z"));

    const near = (await get("/scan/ideas?kind=option&status=near")).body;
    expect(near.ideas.map((i: { symbol: string; score: number; rank: number; status: string; definition: string }) => [i.symbol, i.score, i.rank, i.status, i.definition])).toEqual([
      ["CCC", 68, 1, "near", "option-v3"],
      ["DDD", 62, 2, "near", "option-v3"],
    ]);
    expect(near.asOf).toBe("2026-10-21T19:05:00.000Z");
    expect(near.ideas[0]).toMatchObject({ kind: "option", strategy: "long_call", contract: "CCCC", reasons: ["r"] });

    const active = (await get("/scan/ideas?kind=option")).body.ideas;
    expect(active.map((i: { symbol: string; definition: string }) => [i.symbol, i.definition])).toEqual([["AAA", "option-v3"], ["BBB", "option-v3"]]);
    expect((await get("/scan/ideas?kind=stock&status=near")).status).toBe(400);

    // The near misses are the latest pass's: a new pass replaces them, and a listed name leaves the band.
    seed([card("AAA", 85), card("BBB", 72), card("CCC", 71), card("DDD", 40)]);
    ideas.updateOptionIdeas(new Date("2026-10-21T19:10:00Z"));
    expect((await get("/scan/ideas?kind=option&status=near")).body.ideas).toEqual([]);
    sd.setStatus(sd.listVersions("option").find((v) => v.status === "previous")!.id, "active");
    ideas.updateOptionIdeas(new Date("2026-10-21T19:15:00Z"));
    expect((await get("/scan/ideas?kind=option&status=near")).body.ideas).toEqual([]);
  });
});
