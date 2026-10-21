import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// /api/research/screen and /market/datasets over bulk tables in a temp sqlite,
// seeded directly; nothing here calls FMP.

const tmpDir = mkdtempSync(join(tmpdir(), "research-bulk-"));
let server: Server;
let base: string;
let store: typeof import("../../research/bulk-store.js");
let db: typeof import("../../db.js").db;

const AT = "2026-10-21T10:30:00.000Z";

beforeAll(async () => {
  process.env.DATA_DIR = tmpDir;
  store = await import("../../research/bulk-store.js");
  ({ db } = await import("../../db.js"));
  const { router } = await import("./bulk.js");
  const app = express();
  app.use("/api/research", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
});
afterAll(() => {
  server.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const ds = (name: string) => store.DATASETS.find((d) => d.name === name)!;

function seed() {
  const profile = (symbol: string, marketCap: number, sector: string, beta: number) => ({
    symbol, price: 100, marketCap, beta, companyName: `${symbol} Inc.`, exchange: "NASDAQ", sector, industry: "Software", isEtf: false, isFund: false, isActivelyTrading: true, isAdr: false,
  });
  store.upsertRows(ds("profile"), [profile("AAA", 3e12, "Technology", 1.1), profile("BBB", 2e11, "Technology", 1.9), profile("CCC", 5e10, "Energy", 0.7)], AT);
  store.upsertRows(ds("ratios-ttm"), [
    { symbol: "AAA", priceToEarningsRatioTTM: 30, dividendYieldTTM: 0.005 },
    { symbol: "BBB", priceToEarningsRatioTTM: 12, dividendYieldTTM: 0.03 },
  ], AT);
  db.prepare("INSERT INTO bulk_datasets (name, row_count, bytes, calls, duration_ms, updated_at) VALUES ('profile', 3, 100, 1, 5, ?), ('ratios-ttm', 2, 50, 1, 5, ?)").run(AT, AT);
}

beforeEach(() => {
  for (const d of store.DATASETS) db.exec(`DELETE FROM ${d.table}`);
  db.exec("DELETE FROM bulk_datasets");
});

describe("GET /screen", () => {
  it("answers the envelope with the bulk date as asOf", async () => {
    seed();
    const res = await fetch(`${base}/screen?sector=Technology&marketCapMin=1e11&sort=marketCap&order=desc&limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dataset: "screen", source: "fmp", asOf: AT });
    expect(body.data.map((r: any) => r.symbol)).toEqual(["AAA", "BBB"]);
    expect(Object.keys(body.data[0])).toEqual(["symbol", "companyName", "sector", "industry", "exchange", "price", "marketCap"]);
  });

  it("adds requested and filtered fields, sorts by any numeric field", async () => {
    seed();
    const body = await (await fetch(`${base}/screen?peMax=20&fields=beta,dividendYieldTTM&sort=dividendYieldTTM&order=asc`)).json();
    expect(body.data).toEqual([
      expect.objectContaining({ symbol: "BBB", beta: 1.9, dividendYieldTTM: 0.03, priceToEarningsRatioTTM: 12 }),
    ]);
    const all = await (await fetch(`${base}/screen?sort=beta&order=asc&exchange=nasdaq,nyse`)).json();
    expect(all.data.map((r: any) => r.symbol)).toEqual(["CCC", "AAA", "BBB"]);
  });

  it("rejects bad input with 400", async () => {
    seed();
    for (const qs of [
      "sort=marketCap;DROP TABLE bulk_profiles",
      "sort=companyName",
      "fields=data",
      "fields=marketCap,updated_at",
      "limit=501",
      "limit=0",
      "marketCapMin=abc",
      "ratingMin=6",
      "order=sideways",
      "exchange=LSE",
      "pe=10",
    ]) {
      const res = await fetch(`${base}/screen?${qs}`);
      expect(res.status, qs).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM bulk_profiles").get()).toEqual({ n: 3 });
  });

  it("answers 503 before any bulk data exists", async () => {
    const key = process.env.FMP_API_KEY;
    process.env.FMP_API_KEY = "k";
    const loading = await fetch(`${base}/screen`);
    expect(loading.status).toBe(503);
    expect((await loading.json()).error).toMatch(/still loading/);
    delete process.env.FMP_API_KEY;
    const unkeyed = await fetch(`${base}/screen`);
    expect(unkeyed.status).toBe(503);
    expect(await unkeyed.json()).toEqual({ error: "needs FMP_API_KEY", feature: "screen" });
    if (key !== undefined) process.env.FMP_API_KEY = key;
  });
});

describe("GET /market/datasets", () => {
  it("lists every dataset with its row count and last update", async () => {
    seed();
    const body = await (await fetch(`${base}/market/datasets`)).json();
    expect(body).toMatchObject({ dataset: "datasets", source: "fmp" });
    expect(body.data).toHaveLength(store.DATASETS.length);
    expect(body.data[0]).toEqual({
      dataset: "profile",
      table: "bulk_profiles",
      schedule: "daily",
      rows: 3,
      lastRunRows: 3,
      bytes: 100,
      calls: 1,
      durationMs: 5,
      updatedAt: AT,
      error: null,
      errorAt: null,
    });
    expect(body.data.find((d: any) => d.dataset === "income-statement")).toMatchObject({ schedule: "weekly", rows: 0, updatedAt: null });
  });
});
