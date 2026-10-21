import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resetState } from "../../providers/fmp-core.js";
import { marketRouter, router } from "./ownership.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/research/market", marketRouter);
  app.use("/api/research", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
});
afterAll(() => server.close());

const realFetch = globalThis.fetch;
function mockFmp(handler: (url: URL) => { status?: number; body: unknown }) {
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    if (input.startsWith(base.replace("/api/research", ""))) return realFetch(input, init);
    const r = handler(new URL(input));
    const status = r.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: async () => r.body, text: async () => "boom", headers: new Headers() });
  });
}

beforeEach(() => {
  process.env.FMP_API_KEY = "test-key";
  process.env.FMP_MAX_REQ_PER_MIN = "100000";
  resetState();
});
afterEach(() => vi.unstubAllGlobals());

it("serves institutional with an explicit quarter", async () => {
  mockFmp((u) => ({ body: u.pathname.endsWith("summary") ? [{ symbol: "AAPL" }] : [{ investorName: "A" }] }));
  const res = await fetch(`${base}/aapl/institutional?year=2026&quarter=2`);
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j).toMatchObject({ symbol: "AAPL", dataset: "institutional", source: "fmp", data: { year: 2026, quarter: 2, summary: { symbol: "AAPL" }, holders: [{ investorName: "A" }] } });
});

it("rejects bad input", async () => {
  mockFmp(() => ({ body: [] }));
  expect((await fetch(`${base}/SAP.DE/float`)).status).toBe(400);
  expect((await fetch(`${base}/AAPL/institutional?year=2026`)).status).toBe(400);
  expect((await fetch(`${base}/AAPL/institutional?year=2026&quarter=5`)).status).toBe(400);
  expect((await fetch(`${base}/AAPL/insiders?limit=0`)).status).toBe(400);
  expect((await fetch(`${base}/market/insiders/latest?limit=x`)).status).toBe(400);
});

it("serves insiders, congress and float", async () => {
  mockFmp((u) => {
    if (u.pathname.endsWith("insider-trading/search")) return { body: [{ reportingName: "X" }] };
    if (u.pathname.endsWith("insider-trading/statistics")) return { body: [{ year: 2026 }] };
    if (u.pathname.endsWith("senate-trades")) return { body: [{ transactionDate: "2026-01-01", disclosureDate: "2026-01-04" }] };
    if (u.pathname.endsWith("house-trades")) return { body: [] };
    return { body: [{ symbol: "AAPL", floatShares: 1, outstandingShares: 2, freeFloat: 50 }] };
  });
  expect((await (await fetch(`${base}/AAPL/insiders?limit=5`)).json()).data).toEqual({ trades: [{ reportingName: "X" }], statistics: [{ year: 2026 }] });
  expect((await (await fetch(`${base}/AAPL/congress`)).json()).data[0]).toMatchObject({ chamber: "senate", disclosureLagDays: 3 });
  expect((await (await fetch(`${base}/AAPL/float`)).json()).data).toMatchObject({ floatShares: 1, freeFloat: 50 });
});

it("serves the market routes without a symbol", async () => {
  mockFmp(() => ({ body: [{ a: 1 }] }));
  for (const p of ["insiders/latest", "congress/latest", "institutional/latest-filings"]) {
    const j = await (await fetch(`${base}/market/${p}`)).json();
    expect("symbol" in j).toBe(false);
    expect(j.data.length).toBeGreaterThan(0);
  }
});

it("maps missing key to 503 and FMP failures to 502", async () => {
  delete process.env.FMP_API_KEY;
  expect(await (await fetch(`${base}/AAPL/float`)).json()).toEqual({ error: "needs FMP_API_KEY", feature: "float" });
  process.env.FMP_API_KEY = "test-key";
  mockFmp(() => ({ status: 500, body: {} }));
  const res = await fetch(`${base}/AAPL/float`);
  expect(res.status).toBe(502);
  expect((await res.json()).feature).toBe("float");
});
