import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetState } from "../../providers/fmp-core.js";
import { router, symbolRouter } from "./market.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/research", router);
  app.use("/api/research", symbolRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
});
afterAll(() => server.close());

const realFetch = globalThis.fetch;

/** Mocks FMP only; calls to the local test server pass through. */
function mockFmp(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith("http://127.0.0.1")) return realFetch(input, init);
      const body = routes[new URL(input).pathname.replace("/stable/", "")] ?? [];
      return { ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() };
    })
  );
}

describe("research market routes", () => {
  beforeEach(() => {
    process.env.FMP_API_KEY = "test-key";
    process.env.FMP_MAX_REQ_PER_MIN = "100000";
    resetState();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("wraps splits in the envelope", async () => {
    mockFmp({ "splits-calendar": [{ symbol: "A", date: "2026-11-01" }] });
    const res = await fetch(`${base}/market/splits?from=2026-11-01&to=2026-11-30`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dataset: "splits", source: "fmp", data: [{ symbol: "A" }] });
    expect(typeof body.asOf).toBe("string");
  });

  it("answers 400 for bad dates, ranges, index names and foreign symbols", async () => {
    expect((await fetch(`${base}/market/ipos?from=nope`)).status).toBe(400);
    expect((await fetch(`${base}/market/dividends?from=2026-12-01&to=2026-11-01`)).status).toBe(400);
    expect((await fetch(`${base}/market/index/ftse`)).status).toBe(400);
    expect((await fetch(`${base}/market/lockups?days=0`)).status).toBe(400);
    expect((await fetch(`${base}/market/sectors/history`)).status).toBe(400);
    expect((await fetch(`${base}/SAP.DE/profile`)).status).toBe(400);
    expect((await fetch(`${base}/market/etf/SAP.DE/holdings`)).status).toBe(400);
  });

  it("answers 503 without a key and 502 when FMP fails", async () => {
    process.env.FMP_API_KEY = "";
    const none = await fetch(`${base}/market/mergers`);
    expect(none.status).toBe(503);
    expect(await none.json()).toEqual({ error: "needs FMP_API_KEY", feature: "market-mergers" });

    process.env.FMP_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) =>
        input.startsWith("http://127.0.0.1") ? realFetch(input, init) : { ok: false, status: 500, json: async () => ({}), text: async () => "boom", headers: new Headers() }
      )
    );
    const bad = await fetch(`${base}/market/mergers`);
    expect(bad.status).toBe(502);
    expect(JSON.stringify(await bad.json())).not.toContain("test-key");
  });

  it("serves index constituents, sector history and ETF holdings with limit", async () => {
    mockFmp({
      "dowjones-constituent": [{ symbol: "NVDA" }],
      "historical-industry-performance": [{ date: "2026-10-20", industry: "Biotechnology", averageChange: 1 }],
      "historical-industry-pe": [{ date: "2026-10-20", pe: 14 }],
      "etf/holdings": [{ asset: "A", weightPercentage: 1 }, { asset: "B", weightPercentage: 5 }],
    });
    expect((await (await fetch(`${base}/market/index/dowjones`)).json()).data).toEqual([{ symbol: "NVDA" }]);
    const hist = await (await fetch(`${base}/market/industries/history?industry=Biotechnology`)).json();
    expect(hist.data).toEqual([{ date: "2026-10-20", industry: "Biotechnology", averageChange: 1, pe: 14 }]);
    const holdings = await (await fetch(`${base}/market/etf/spy/holdings?limit=1`)).json();
    expect(holdings).toMatchObject({ symbol: "SPY", dataset: "etf-holdings", data: [{ asset: "B" }] });
  });

  it("serves the per-symbol profile and ETF exposure", async () => {
    mockFmp({
      profile: [{ symbol: "AAPL" }],
      "key-executives": [{ name: "X" }],
      "employee-count": [{ periodOfReport: "2025-09-27", employeeCount: 1 }],
      "etf/asset-exposure": [{ symbol: "XLK", weightPercentage: 20 }, { symbol: "QQQ", weightPercentage: 8 }],
    });
    const profile = await (await fetch(`${base}/aapl/profile`)).json();
    expect(profile).toMatchObject({ symbol: "AAPL", dataset: "profile", data: { profile: { symbol: "AAPL" }, employeeCount: { latest: 1 } } });
    const exposure = await (await fetch(`${base}/AAPL/etf-exposure?limit=1`)).json();
    expect(exposure.data).toEqual([{ symbol: "XLK", weightPercentage: 20 }]);
  });
});
