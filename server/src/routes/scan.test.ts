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

const get = async (path: string) => (await fetch(base + path)).json();
const send = (method: string, path: string, body: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scan-route-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  const { scanRouter } = await import("./scan.js");
  const { positionsRouter } = await import("./positions.js");
  const app = express();
  app.use(express.json());
  app.use("/api/scan", scanRouter);
  app.use("/api/positions", positionsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  db.prepare("INSERT INTO watchlists (id, name) VALUES (1, 'L')").run();
  db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (1, 'AAA', 0), (1, 'BBB', 1)").run();
  db.prepare("INSERT INTO symbols (symbol, active) VALUES ('NVDA', 1), ('AAPL', 1)").run(); // positions must be listed
  db.prepare(
    `INSERT INTO bulk_profiles (symbol, company_name, exchange, sector, industry, country, price, market_cap, average_volume, is_etf, is_fund, is_adr, is_actively_trading, data, updated_at)
     VALUES ('AAA', 'A', 'NASDAQ', 'Technology', 'Software', 'US', 50, 1e9, 1e6, 0, 0, 0, 1, '{}', ''), ('BBB', 'B', 'NYSE', 'Energy', 'Oil', 'US', 20, 1e9, 1e6, 0, 0, 0, 1, '{}', '')`
  ).run();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("universe", () => {
  it("returns the defaults and the symbol count", async () => {
    const body = await get("/scan/universe");
    expect(body.settings).toMatchObject({ mode: "watchlists", watchlistIds: null, minPrice: 5 });
    expect(body.symbolCount).toBe(2);
    expect((await get("/scan/universe/symbols")).symbols).toEqual(["AAA", "BBB"]);
  });

  it("saves valid settings (PUT or POST) and rejects bad ones", async () => {
    const settings = { mode: "sector", watchlistIds: null, sectors: ["Technology"], industries: [], minPrice: 5, minAvgDollarVolume: 1000, requireOptions: false };
    const res = await send("PUT", "/scan/universe", settings);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings, symbolCount: 1 });
    expect((await get("/scan/universe")).settings.mode).toBe("sector");
    expect((await send("POST", "/scan/universe", { ...settings, mode: "watchlists" })).status).toBe(200);
    expect((await send("PUT", "/scan/universe", { ...settings, mode: "everything" })).status).toBe(400);
    expect((await send("PUT", "/scan/universe", { mode: "market" })).status).toBe(400);
  });

  it("lists sectors", async () => {
    expect(await get("/scan/sectors")).toEqual({
      sectors: ["Energy", "Technology"],
      industries: [{ sector: "Energy", industry: "Oil" }, { sector: "Technology", industry: "Software" }],
    });
  });
});

describe("ideas, scorecards and status", () => {
  it("serves ideas with default and bounded parameters", async () => {
    db.prepare("INSERT INTO ideas (kind, symbol, strategy, contract, score, rank, reasons, first_seen, last_seen) VALUES ('stock', 'AAA', 'buy', NULL, 80, 1, '[\"r\"]', 't', 't'), ('option', 'AAA', 'long_call', 'AAA261120C00100000', 75, 1, '[]', 't', 't')").run();
    const all = await get("/scan/ideas");
    expect(all.ideas).toHaveLength(2);
    expect(all.asOf).toBe("t");
    const stocks = await get("/scan/ideas?kind=stock&status=active&limit=5");
    expect(stocks.ideas).toEqual([expect.objectContaining({ symbol: "AAA", strategy: "buy", reasons: ["r"], firstSeen: "t", status: "active" })]);
    expect((await fetch(`${base}/scan/ideas?limit=500`)).status).toBe(400);
    expect((await fetch(`${base}/scan/ideas?kind=bond`)).status).toBe(400);
  });

  it("returns the three scorecards of a symbol", async () => {
    expect(await get("/scan/scorecard/aaa")).toEqual({ stock: null, live: null, options: null });
    db.prepare("INSERT INTO scorecards (day, symbol, composite, groups, factors, coverage, weights_version) VALUES ('2026-10-21', 'AAA', 77, '{\"momentum\":80}', '{\"pe\":[10,60,null]}', 0.5, 'stock-v1')").run();
    const body = await get("/scan/scorecard/AAA");
    expect(body.stock).toMatchObject({ symbol: "AAA", composite: 77, groups: { momentum: 80 }, factors: [{ key: "pe", group: "valuation", value: 10, score: 60, change: null }] });
    expect((await fetch(`${base}/scan/scorecard/$$$`)).status).toBe(400);
  });

  it("reports the last run per job and no options status without the jobs", async () => {
    db.prepare("INSERT INTO scan_runs (job, started_at, finished_at, status, symbols, duration_ms) VALUES ('stock-nightly', 's', 'f', 'ok', 5, 12)").run();
    expect(await get("/scan/status")).toEqual({
      runs: { "stock-nightly": { started_at: "s", finished_at: "f", status: "ok", symbols: 5, duration_ms: 12, error: null } },
      options: null,
    });
  });

  it("refuses unknown jobs", async () => {
    expect((await send("POST", "/scan/run/bogus", {})).status).toBe(404);
  });
});

describe("positions", () => {
  it("imports a CSV, lists it, and answers errors with 400", async () => {
    expect(await get("/positions")).toEqual({ importedAt: null, positions: [] });
    const ok = await send("POST", "/positions/import", { csv: "symbol,quantity,cost\nNVDA,100,90\nAAPL261120C00200000,-1,3", filename: "w.csv" });
    expect(await ok.json()).toEqual({ imported: 2 });
    const list = await get("/positions");
    expect(list.positions).toHaveLength(2);
    expect(list.importedAt).toEqual(expect.any(String));

    const bad = await send("POST", "/positions/import", { csv: "symbol,quantity\nNVDA,1\nBAD!,2" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ errors: [{ line: 3, message: expect.any(String) }] });
    expect((await get("/positions")).positions).toHaveLength(2);
    expect((await send("POST", "/positions/import", { nope: 1 })).status).toBe(400);
  });
});
