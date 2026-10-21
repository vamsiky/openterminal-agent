import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() });
const bad = (status: number) => ({ ok: false, status, json: async () => ({}), text: async () => "nope", headers: new Headers() });

let tmpDir: string;
let server: Server;
let base: string;
let fmpCalls: URL[];
let fmpReply: (url: URL) => unknown;
let core: typeof import("../../providers/fmp-core.js");
let store: typeof import("../../research/transcripts-store.js");
let db: typeof import("../../db.js").db;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-content-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.FMP_API_KEY = "test-key";
  process.env.FMP_MAX_REQ_PER_MIN = "3000";
  core = await import("../../providers/fmp-core.js");
  store = await import("../../research/transcripts-store.js");
  db = (await import("../../db.js")).db;
  const { router, marketRouter } = await import("./content.js");
  const app = express();
  app.use("/api/research/market", marketRouter);
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

beforeEach(() => {
  process.env.FMP_API_KEY = "test-key";
  core.resetState();
  db.exec("DELETE FROM content_transcripts; DELETE FROM content_transcripts_fts;");
  fmpCalls = [];
  fmpReply = () => ok([]);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.startsWith("http://127.0.0.1")) return realFetch(url, init);
    const u = new URL(url);
    fmpCalls.push(u);
    return Promise.resolve(fmpReply(u));
  });
});
afterEach(() => vi.unstubAllGlobals());

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as any };
};

const transcript = (year: number, quarter: number, content: string, date = "2025-10-30") => ({ symbol: "AAPL", period: `Q${quarter}`, year, date, content });

describe("transcripts", () => {
  it("lists dates in the envelope", async () => {
    fmpReply = () => ok([{ quarter: 4, fiscalYear: 2025, date: "2025-10-30" }]);
    const r = await get("/aapl/transcripts");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ symbol: "AAPL", dataset: "transcripts", source: "fmp", data: [{ quarter: 4, fiscalYear: 2025, date: "2025-10-30" }] });
  });

  it("fetches a transcript on first request, then serves it from storage", async () => {
    fmpReply = () => ok([transcript(2025, 4, "Tim Cook: services grew strongly")]);
    const a = await get("/AAPL/transcripts/2025/4");
    expect(a.body.data).toEqual({ fiscalYear: 2025, quarter: 4, date: "2025-10-30", content: "Tim Cook: services grew strongly" });
    const b = await get("/AAPL/transcripts/2025/4");
    expect(b.body.data.content).toBe(a.body.data.content);
    expect(fmpCalls).toHaveLength(1);
  });

  it("answers 404 when FMP has no transcript, 400 for a bad quarter or foreign symbol", async () => {
    expect((await get("/AAPL/transcripts/2026/4")).status).toBe(404);
    expect((await get("/AAPL/transcripts/2025/5")).status).toBe(400);
    expect((await get("/SAP.DE/transcripts")).status).toBe(400);
  });

  it("searches stored transcripts with snippets, newest first, scoped to the symbol", async () => {
    fmpReply = (u) => ok([transcript(+u.searchParams.get("year")!, +u.searchParams.get("quarter")!, "We saw record Services revenue this quarter and strong tariff headwinds.", u.searchParams.get("year") === "2025" ? "2025-10-30" : "2024-11-01")]);
    await get("/AAPL/transcripts/2024/4");
    await get("/AAPL/transcripts/2025/4");
    const other = await store.getOrFetch("MSFT", 2025, 4);
    expect(other?.symbol).toBe("MSFT");
    const r = await get("/AAPL/transcripts/search?q=services%20TARIFF");
    expect(r.status).toBe(200);
    expect(r.body.data.map((h: any) => h.fiscalYear)).toEqual([2025, 2024]);
    expect(r.body.data[0].snippet).toContain("Services");
    expect((await get("/AAPL/transcripts/search?q=nothing")).body.data).toEqual([]);
    expect((await get("/AAPL/transcripts/search")).status).toBe(400);
  });

  it("replaces a re-stored transcript in the search index", async () => {
    fmpReply = () => ok([transcript(2025, 4, "alpha beta")]);
    await store.fetchAndStore("AAPL", 2025, 4, "2025-10-30");
    fmpReply = () => ok([transcript(2025, 4, "gamma delta")]);
    await store.fetchAndStore("AAPL", 2025, 4, "2025-10-30");
    expect(store.search("AAPL", "alpha", 5)).toEqual([]);
    expect(store.search("AAPL", "gamma", 5)).toHaveLength(1);
  });
});

describe("press releases, news and filings", () => {
  it("passes limit, from and to through and returns the articles", async () => {
    fmpReply = () => ok([{ symbol: "AAPL", publishedDate: "2026-10-13 08:56:00", publisher: "BW", title: "T", site: "s", text: "body", url: "u" }]);
    const r = await get("/BRK.B/press-releases?limit=3&from=2026-09-01&to=2026-09-30");
    expect(r.body.dataset).toBe("press-releases");
    expect(r.body.data[0].text).toBe("body");
    expect(fmpCalls[0].searchParams.get("symbols")).toBe("BRK-B");
    expect(fmpCalls[0].searchParams.get("from")).toBe("2026-09-01");
    expect(fmpCalls[0].searchParams.get("limit")).toBe("3");
    expect((await get("/AAPL/press-releases?from=yesterday")).status).toBe(400);
  });

  it("serves stock news", async () => {
    fmpReply = () => ok([{ symbol: "AAPL", publishedDate: "2026-10-21 02:15:00", publisher: "SA", title: "N", site: "s", text: "t", url: "u" }]);
    const r = await get("/AAPL/news");
    expect(r.body).toMatchObject({ dataset: "news", data: [{ title: "N" }] });
    expect(fmpCalls[0].searchParams.get("limit")).toBe("30");
  });

  it("filters filings by type and always sends a date range", async () => {
    fmpReply = () =>
      ok([
        { symbol: "AAPL", cik: "1", filingDate: "2026-10-19 00:00:00", acceptedDate: "2026-10-19 18:00:00", formType: "4", link: "l", finalLink: "f" },
        { symbol: "AAPL", cik: "1", filingDate: "2026-10-01 00:00:00", acceptedDate: "2026-10-01 18:00:00", formType: "8-K", link: "l", finalLink: "f" },
      ]);
    const r = await get("/AAPL/filings?type=8-K&limit=5");
    expect(r.body.data.map((f: any) => f.formType)).toEqual(["8-K"]);
    expect(fmpCalls[0].searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fmpCalls[0].searchParams.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("serves the market-wide feeds", async () => {
    fmpReply = (u) => (u.pathname.includes("press-releases-latest") ? ok([{ symbol: "DKS", publishedDate: "2026-10-21 03:45:00", title: "PR" }]) : ok([{ symbol: "X", filingDate: "2026-10-20 00:00:00", formType: "8-K" }]));
    expect((await get("/market/press-releases/latest")).body).toMatchObject({ dataset: "press-releases-latest", data: [{ symbol: "DKS" }] });
    const k = await get("/market/filings/8k/latest");
    expect(k.body).toMatchObject({ dataset: "filings-8k-latest", data: [{ symbol: "X", formType: "8-K" }] });
    expect(fmpCalls.at(-1)!.searchParams.get("formType")).toBe("8-K");
  });
});

describe("errors", () => {
  it("answers 503 without a key and 502 on an FMP failure, never leaking the key", async () => {
    process.env.FMP_API_KEY = "";
    const a = await get("/AAPL/news");
    expect(a.status).toBe(503);
    expect(a.body).toEqual({ error: "needs FMP_API_KEY", feature: "/research/news" });
    process.env.FMP_API_KEY = "test-key";
    fmpReply = () => bad(500);
    const b = await get("/AAPL/press-releases");
    expect(b.status).toBe(502);
    expect(JSON.stringify(b.body)).not.toContain("test-key");
  });

  it("falls back to stored transcript dates when the FMP list fails", async () => {
    fmpReply = () => ok([transcript(2025, 4, "stored text")]);
    await get("/AAPL/transcripts/2025/4");
    core.resetState();
    fmpReply = () => bad(500);
    const r = await get("/AAPL/transcripts");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([{ fiscalYear: 2025, quarter: 4, date: "2025-10-30" }]);
  });
});
