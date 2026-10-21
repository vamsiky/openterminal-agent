import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;
let server: Server;
let base: string;
let store: typeof import("../options/store.js");
let jobs: typeof import("../options/jobs.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-options-route-test-"));
  process.env.DATA_DIR = tmpDir;
  store = await import("../options/store.js");
  jobs = await import("../options/jobs.js");
  const { optionsDataRouter } = await import("./options-data.js");
  const app = express();
  app.use("/api/options-data", optionsDataRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/options-data`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  jobs.optionsHandle()?.stop();
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

describe("/api/options-data", () => {
  it("answers /stream with no jobs running", async () => {
    expect((await get("/stream")).body).toEqual({ status: null, contracts: [] });
  });

  it("serves the latest metrics, 404 when none", async () => {
    store.saveOptionMetrics({
      underlying: "SPY", asOf: "2026-10-21T15:00:00Z", price: 500, atmExpiry: null, atmCall: null, atmPut: null, atmIv: 0.2, iv30: 0.21,
      ivRank: null, ivPercentile: null, ivHistoryDays: 3, hv20: null, impliedMovePct: null, termSlope: null, putCallVolumeRatio: null,
      unusual: [], atmCallQuote: null, atmPutQuote: null,
    });
    const hit = await get("/metrics/spy");
    expect(hit.status).toBe(200);
    expect(hit.body.iv30).toBe(0.21);
    expect((await get("/metrics/NOPE")).status).toBe(404);
    expect((await get("/metrics/bad%20sym")).status).toBe(400);
  });

  it("serves IV history, newest window oldest first", async () => {
    for (const [day, iv] of [["2026-10-19", 0.2], ["2026-10-20", 0.22], ["2026-10-21", 0.25]] as const) {
      store.upsertIvDay({ symbol: "IVX", day, iv30: iv, atmIv: null, hv20: null });
    }
    expect((await get("/iv/ivx")).body.history.map((r: any) => r.day)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    expect((await get("/iv/ivx?days=2")).body.history).toHaveLength(2);
    expect((await get("/iv/ivx?days=0")).status).toBe(400);
  });

  it("serves minute bars in a range", async () => {
    const occ = "SPY261120C00500000";
    const row = (ts: number) => ({ occ, ts, bid: 1, ask: 1.1, mid: 1.05, last: null, volume: 0, iv: 0.2, delta: 0.5 });
    store.upsertOptionBars([row(1_000), row(1_060), row(1_120)]);
    const body = (await get(`/bars/${occ}?from=1050&to=1200`)).body;
    expect(body.bars.map((b: any) => b.ts)).toEqual([1_060, 1_120]);
    expect((await get(`/bars/${occ}?from=nonsense`)).status).toBe(400);
    expect((await get("/bars/SPY")).status).toBe(400);
  });
});
