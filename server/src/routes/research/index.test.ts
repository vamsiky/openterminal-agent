import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// The area routers open sqlite at import time, so point DATA_DIR at a temp
// folder first. No FMP key: every FMP-backed route answers 503, which proves
// the route matched without touching the network.
let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-research-index-"));
  process.env.DATA_DIR = tmpDir;
  vi.stubEnv("FMP_API_KEY", "");
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL, init?: RequestInit) =>
      String(url).startsWith("http://127.0.0.1:") ? realFetch(url, init) : Promise.reject(new Error("no network in tests"))
    )
  );
  const { researchRouter } = await import("./index.js");
  const app = express();
  app.use("/api/research", researchRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research`;
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const status = async (path: string) => (await fetch(`${base}${path}`)).status;

it("routes market-wide paths to the market routers, not to /:symbol", async () => {
  for (const path of ["/market/insiders/latest", "/market/congress/latest", "/market/press-releases/latest", "/market/filings/8k/latest", "/market/ipos"]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status, path).toBe(503);
    expect((await res.json()).error, path).toBe("needs FMP_API_KEY");
  }
  expect(await status("/market/datasets")).toBe(200); // local bulk tables, no FMP call
});

it("routes per-symbol paths from every area and rejects foreign symbols", async () => {
  for (const path of ["/AAPL/statements", "/AAPL/institutional", "/AAPL/transcripts", "/AAPL/profile", "/AAPL/etf-exposure"]) {
    expect(await status(path), path).toBe(503);
  }
  expect(await status("/SAP.DE/profile")).toBe(400);
});
