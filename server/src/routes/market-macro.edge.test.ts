import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/macro end to end through the market router, with the network stubbed by URL: FMP is the first
// source for yields, the VIX, the policy rate and CPI; FRED fills only the series FMP did not give.

let tmpDir: string;
let server: Server;
let base: string;
let db: typeof import("../db.js").db;

type Fred = Record<string, string>;
type Fmp = { treasury?: Record<string, number | null> | null; vix?: boolean; policy?: boolean; cpi?: boolean };
let fredCsv: Fred = {};
let fmpData: Fmp = {};
let fredCalls: string[] = [];

const FULL_TREASURY = { date: "2026-10-20", month3: 5.3, year5: 4.1, year10: 4.2, year30: 4.5 };
const csv = (id: string, value: string) => `observation_date,${id}\n2026-10-19,${value}\n2026-10-20,.\n`;

const realFetch = globalThis.fetch;

function stubNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname === "127.0.0.1") return realFetch(input, init); // this test's own server
      if (url.hostname === "fred.stlouisfed.org") {
        const id = url.searchParams.get("id")!;
        fredCalls.push(id);
        const body = fredCsv[id];
        if (body === undefined) return new Response("<html>not found</html>", { status: 404 });
        return new Response(body, { status: 200, headers: { "content-type": "text/csv" } });
      }
      if (url.hostname === "financialmodelingprep.com") {
        const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
        const last = url.pathname.split("/").pop();
        if (last === "treasury-rates") return json(fmpData.treasury === undefined ? [FULL_TREASURY] : fmpData.treasury ? [{ ...FULL_TREASURY, ...fmpData.treasury }] : []);
        if (last === "quote") return json(fmpData.vix === false ? [] : [{ symbol: "^VIX", price: 17.5, timestamp: 1792540800 }]);
        if (last === "economic-indicators") {
          const name = url.searchParams.get("name");
          if (name === "federalFunds") return json(fmpData.policy === false ? [] : [{ date: "2026-09-01", value: 4.33 }]);
          if (name === "CPI") return json(fmpData.cpi === false ? [] : [{ date: "2026-08-01", value: 320 }, { date: "2025-08-01", value: 310 }]);
          return json([]);
        }
        return json([]);
      }
      return new Response("no network in tests", { status: 503 });
    })
  );
}

async function freshServer(env: Record<string, string | undefined>) {
  Object.assign(process.env, { FMP_API_KEY: "test", FMP_MAX_REQ_PER_MIN: "100000" }, env); // no spacing between test calls
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  vi.resetModules(); // a fresh market router, so no cache survives from the previous case
  const { marketRouter } = await import("./market.js");
  if (server) await new Promise((r) => server.close(r));
  const app = express();
  app.use("/api/market", marketRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/market`;
}

const macro = async () => {
  const res = await fetch(`${base}/macro`);
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-market-macro-"));
  process.env.DATA_DIR = tmpDir;
  fredCalls = [];
  fredCsv = {};
  fmpData = {};
  stubNetwork();
  ({ db } = await import("../db.js"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise((r) => server.close(r));
  server = undefined as unknown as Server;
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FMP_API_KEY;
  delete process.env.FMP_MAX_REQ_PER_MIN;
  delete process.env.DATA_DIR;
});

describe("GET /api/market/macro sources", () => {
  it("takes every series from FMP and never calls FRED for the yields or the VIX", async () => {
    await freshServer({});
    const { status, body } = await macro();
    expect(status).toBe(200);
    expect(body.yields).toEqual([
      { tenor: "3M", value: 5.3 },
      { tenor: "5Y", value: 4.1 },
      { tenor: "10Y", value: 4.2 },
      { tenor: "30Y", value: 4.5 },
    ]);
    expect(body.vix).toBe(17.5);
    expect(body.sources.yields).toEqual({ source: "fmp:treasury-rates", asOf: "2026-10-20" });
    expect(body.sources.vix).toEqual({ source: "fmp:quote ^VIX", asOf: expect.any(String) });
    expect(body.policyRate).toBe(4.33);
    expect(body.sources.policyRate).toEqual({ source: "fmp:economic-indicators federalFunds", asOf: "2026-09" });
    expect(body.inflation).toBeCloseTo(3.2, 1);
    expect(body.sources.inflation).toEqual({ source: "fmp:economic-indicators CPI, year over year %", asOf: "2026-08" });
    expect(fredCalls).toEqual([]);
  });

  it("fills only the tenor FMP lacks from FRED, and names both sources", async () => {
    fmpData = { treasury: { year30: null } };
    fredCsv = { DGS30: csv("DGS30", "4.6") };
    await freshServer({});
    const { body } = await macro();
    expect(body.yields.find((y: { tenor: string }) => y.tenor === "30Y")).toEqual({ tenor: "30Y", value: 4.6 });
    expect(body.yields.find((y: { tenor: string }) => y.tenor === "3M")).toEqual({ tenor: "3M", value: 5.3 });
    expect(body.sources.yields.source).toBe("fmp:treasury-rates+fred");
    expect(fredCalls).toEqual(["DGS30"]); // not the tenors FMP had, and not the VIX FMP answered
  });

  it("falls back to FRED for the whole curve and the VIX with no FMP key, and says so", async () => {
    fredCsv = { DGS3MO: csv("DGS3MO", "5.1"), DGS5: csv("DGS5", "3.9"), DGS10: csv("DGS10", "4.0"), DGS30: csv("DGS30", "4.4"), VIXCLS: csv("VIXCLS", "18.2") };
    await freshServer({ FMP_API_KEY: undefined });
    const { status, body } = await macro();
    expect(status).toBe(200);
    expect(body.yields.map((y: { value: number }) => y.value)).toEqual([5.1, 3.9, 4.0, 4.4]);
    expect(body.vix).toBe(18.2);
    expect(body.sources.yields).toEqual({ source: "fred", asOf: "2026-10-19" });
    expect(body.sources.vix).toEqual({ source: "fred", asOf: "2026-10-19" });
    expect(body.policyRate).toBeNull();
    expect(body.sources.policyRate).toBeNull();
  });

  it("drops a FRED maintenance page for its tenor and still answers with the rest", async () => {
    fmpData = { treasury: { year10: null } };
    fredCsv = { DGS10: "<!DOCTYPE html><html><body>Maintenance</body></html>" };
    await freshServer({});
    const res = await macro();
    expect(res.status).toBe(200);
    expect(res.body.yields.map((y: { tenor: string }) => y.tenor)).toEqual(["3M", "5Y", "30Y"]);
    expect(res.body.sources.yields.source).toBe("fmp:treasury-rates");
  });

  it("falls back to FRED for the policy rate when FMP has none", async () => {
    fmpData = { policy: false };
    fredCsv = { FEDFUNDS: csv("FEDFUNDS", "4.33") };
    await freshServer({});
    const { body } = await macro();
    expect(body.policyRate).toBe(4.33);
    expect(body.sources.policyRate).toMatchObject({ source: "fred" });
  });

  it("falls back to FRED for CPI year over year (latest month against the same month a year earlier)", async () => {
    fmpData = { cpi: false };
    const rows = ["2025-08-01,310", "2025-09-01,311", "2026-07-01,318", "2026-08-01,320"];
    fredCsv = { CPIAUCSL: `observation_date,CPIAUCSL\n${rows.join("\n")}\n` };
    await freshServer({});
    const { body } = await macro();
    expect(body.inflation).toBe(3.2);
    expect(body.sources.inflation).toEqual({ source: "fred", asOf: "2026-08" });
  });

  it("leaves the policy rate and inflation null when neither source has them", async () => {
    fmpData = { policy: false, cpi: false };
    fredCsv = {};
    await freshServer({});
    const { body } = await macro();
    expect(body.policyRate).toBeNull();
    expect(body.inflation).toBeNull();
  });
});
