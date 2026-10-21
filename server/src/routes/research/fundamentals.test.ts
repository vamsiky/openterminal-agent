import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let server: Server;
let base: string;
let store: typeof import("../../estimates/store.js");
let core: typeof import("../../providers/fmp-core.js");

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() });

function stub(routes: Record<string, unknown>) {
  const mock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace("/stable/", "");
    const body = routes[path];
    if (typeof body === "number") return { ok: false, status: body, json: async () => ({}), text: async () => "boom", headers: new Headers() };
    return ok(body ?? []);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-research-fund-test-"));
  process.env.DATA_DIR = tmpDir;
  store = await import("../../estimates/store.js");
  core = await import("../../providers/fmp-core.js");
  const { router } = await import("./fundamentals.js");
  const app = express();
  app.use("/api/research", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  const { db } = await import("../../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

// fetch is stubbed per test, but the test's own requests to the local server must still go through.
const realFetch = globalThis.fetch;
const api = (path: string) => realFetch(`${base}${path}`);

beforeEach(() => {
  process.env.FMP_API_KEY = "test-key";
  process.env.FMP_MAX_REQ_PER_MIN = "100000";
  core.resetState();
});
afterEach(() => vi.unstubAllGlobals());

describe("validation", () => {
  it("answers 400 for foreign symbols and bad query values", async () => {
    stub({});
    expect((await api("/SAP.DE/statements")).status).toBe(400);
    expect((await api("/AAPL/statements?type=nope")).status).toBe(400);
    expect((await api("/AAPL/statements?period=weekly")).status).toBe(400);
    expect((await api("/AAPL/metrics?limit=0")).status).toBe(400);
    expect((await api("/AAPL/metrics?from=yesterday")).status).toBe(400);
    expect((await api("/AAPL/growth?period=ttm")).status).toBe(400);
    expect((await api("/AAPL/segments?period=ttm")).status).toBe(400);
    expect((await api("/AAPL/estimates?period=ttm")).status).toBe(400);
  });
});

describe("failures", () => {
  it("answers 503 without a key", async () => {
    delete process.env.FMP_API_KEY;
    const res = await api("/AAPL/valuation");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "needs FMP_API_KEY", feature: "research.valuation" });
  });

  it("answers 502 when FMP fails, without the key", async () => {
    stub({ "stock-peers": 500 });
    const res = await api("/AAPL/peers");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.feature).toBe("research.peers");
    expect(JSON.stringify(body)).not.toContain("test-key");
  });
});

describe("routes", () => {
  it("statements: envelope with defaults", async () => {
    const mock = stub({ "income-statement": [{ date: "2026-06-27", filingDate: "2026-07-31", acceptedDate: "2026-07-31 06:01:02", revenue: 1 }] });
    const body = await (await api("/aapl/statements")).json();
    expect(body).toMatchObject({ symbol: "AAPL", dataset: "statements", source: "fmp", data: [{ revenue: 1, filingDate: "2026-07-31" }] });
    expect(Date.parse(body.asOf)).not.toBeNaN();
    const url = new URL(mock.mock.calls[0][0] as string);
    expect(url.searchParams.get("period")).toBe("quarter");
    expect(url.searchParams.get("limit")).toBe("8");
  });

  it("statements: type and ttm select the endpoint", async () => {
    const mock = stub({ "balance-sheet-statement-ttm": [{ date: "d" }] });
    const body = await (await api("/AAPL/statements?type=balance&period=ttm")).json();
    expect(body.data).toHaveLength(1);
    expect(new URL(mock.mock.calls[0][0] as string).pathname).toBe("/stable/balance-sheet-statement-ttm");
  });

  it("metrics, growth, scores, segments, valuation, peers", async () => {
    stub({
      "key-metrics": [{ symbol: "A", date: "d", marketCap: 1 }],
      ratios: [{ symbol: "A", date: "d", netProfitMargin: 0.2 }],
      "income-statement-growth": [{ date: "d" }],
      "financial-scores": [{ altmanZScore: 3 }],
      "revenue-product-segmentation": [{ date: "d", data: { a: 1 } }],
      "discounted-cash-flow": [{ dcf: 1 }],
      "stock-peers": [{ symbol: "MSFT" }],
    });
    expect((await (await api("/A/metrics")).json()).data[0]).toMatchObject({ keyMetrics: { marketCap: 1 }, ratios: { netProfitMargin: 0.2 } });
    expect((await (await api("/A/growth")).json()).data.income).toHaveLength(1);
    expect((await (await api("/A/scores")).json()).data.scores.altmanZScore).toBe(3);
    expect((await (await api("/A/segments")).json()).data.product).toHaveLength(1);
    expect((await (await api("/A/valuation")).json()).data.dcf.dcf).toBe(1);
    expect((await (await api("/A/peers")).json()).data).toEqual([{ symbol: "MSFT" }]);
  });

  it("analysts groups every dataset", async () => {
    stub({ "price-target-consensus": [{ targetConsensus: 340 }], grades: [{ date: "2026-10-20" }] });
    const body = await (await api("/AAPL/analysts")).json();
    expect(body.data.priceTargetConsensus.targetConsensus).toBe(340);
    expect(body.data.grades).toHaveLength(1);
    expect(body.data.priceTargetSummary).toBeNull();
  });

  it("estimates attaches the app's own revision history", async () => {
    const day = (n: number) => store.addDays(new Date().toISOString().slice(0, 10), n);
    const report = day(20);
    store.recordSnapshots([{ symbol: "NVDA", reportDate: report, eps: 2.0, revenue: 100 }], day(-40));
    store.recordSnapshots([{ symbol: "NVDA", reportDate: report, eps: 2.2, revenue: 100 }], day(-3));
    stub({ "analyst-estimates": [{ symbol: "NVDA", date: day(60), epsAvg: 3 }] });
    const body = await (await api("/NVDA/estimates?period=quarter")).json();
    expect(body.dataset).toBe("estimates");
    expect(body.data.estimates).toEqual([{ symbol: "NVDA", date: day(60), epsAvg: 3 }]);
    expect(body.data.nextReport).toMatchObject({ reportDate: report, eps: 2.2, revenue: 100 });
    expect(body.data.nextReport.history).toHaveLength(2);
    expect(body.data.nextReport.revisions["7d"].eps).toBeCloseTo(10);
  });

  it("estimates for an untracked symbol has a null nextReport date", async () => {
    stub({});
    const body = await (await api("/ZZZZ/estimates")).json();
    expect(body.data.estimates).toEqual([]);
    expect(body.data.nextReport).toMatchObject({ reportDate: null, eps: null, revenue: null, history: [] });
  });
});
