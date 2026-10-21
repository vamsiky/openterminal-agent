import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configFromEnv, type ApiConfig } from "./api.js";
import { createServer } from "./index.js";
import { render, tools } from "./tools.js";

const cfg: ApiConfig = { baseUrl: "http://api.test", apiKey: "k3y", maxChars: 1000, timeoutMs: 1000 };

let calls: Array<{ url: URL; init: RequestInit }>;
let respond: (url: URL) => { status?: number; body: unknown };

beforeEach(() => {
  calls = [];
  respond = () => ({ body: { data: [] } });
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const { status = 200, body } = respond(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function connect(c = cfg) {
  const server = createServer(c);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(name: string, args: Record<string, unknown>, c = cfg) {
  const client = await connect(c);
  const res: any = await client.callTool({ name, arguments: args });
  return { res, text: res.content[0].text as string };
}

const last = () => calls[calls.length - 1].url;

describe("tool list", () => {
  it("registers every tool, all read-only", async () => {
    const client = await connect();
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual([
      "research_summary", "fundamentals", "ownership", "transcripts", "search_transcripts", "content",
      "quote", "price_history", "earnings_calendar", "estimate_revisions", "economic_calendar", "market", "screen",
      "ideas", "scorecard", "universe", "option_metrics",
    ]);
    for (const t of list.tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description!.length).toBeGreaterThan(30);
    }
  });

  it("only ever sends GET with the key header", async () => {
    for (const t of tools) {
      const args: Record<string, unknown> = { symbol: "AAPL", symbols: ["AAPL"], section: "float", query: "x" };
      if (t.name === "fundamentals") args.section = "peers";
      if (t.name === "content") args.section = "news";
      if (t.name === "market") args.section = "ipos";
      await call(t.name, args);
    }
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) {
      expect(c.init.method).toBe("GET");
      expect((c.init.headers as Record<string, string>)["x-api-key"]).toBe("k3y");
    }
  });
});

describe("URLs", () => {
  it("fundamentals", async () => {
    await call("fundamentals", { symbol: "BRK.B", section: "statements", type: "cashflow", period: "annual", limit: 4 });
    expect(last().pathname).toBe("/api/research/BRK.B/statements");
    expect(last().search).toBe("?period=annual&limit=4&type=cashflow");
    await call("fundamentals", { symbol: "AAPL", section: "peers", type: "income" });
    expect(last().pathname).toBe("/api/research/AAPL/peers");
    expect(last().search).toBe("");
  });

  it("ownership passes year/quarter only to institutional", async () => {
    await call("ownership", { symbol: "AAPL", section: "institutional", year: 2026, quarter: 2, limit: 5 });
    expect(last().pathname + last().search).toBe("/api/research/AAPL/institutional?year=2026&quarter=2");
    await call("ownership", { symbol: "AAPL", section: "insiders", limit: 5 });
    expect(last().pathname + last().search).toBe("/api/research/AAPL/insiders?limit=5");
    await call("ownership", { symbol: "AAPL", section: "float" });
    expect(last().pathname + last().search).toBe("/api/research/AAPL/float");
  });

  it("transcripts lists, fetches one, and refuses half a pair", async () => {
    await call("transcripts", { symbol: "NVDA" });
    expect(last().pathname).toBe("/api/research/NVDA/transcripts");
    await call("transcripts", { symbol: "NVDA", year: 2026, quarter: 1 });
    expect(last().pathname).toBe("/api/research/NVDA/transcripts/2026/1");
    const n = calls.length;
    const { res, text } = await call("transcripts", { symbol: "NVDA", year: 2026 });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/both year and quarter/);
    expect(calls.length).toBe(n);
  });

  it("search_transcripts, content, quote, history, calendars", async () => {
    await call("search_transcripts", { symbol: "AAPL", query: "supply chain", limit: 3 });
    expect(last().pathname + last().search).toBe("/api/research/AAPL/transcripts/search?q=supply+chain&limit=3");
    await call("content", { symbol: "AAPL", section: "filings", type: "8-K", from: "2026-01-01" });
    expect(last().pathname + last().search).toBe("/api/research/AAPL/filings?from=2026-01-01&type=8-K");
    await call("content", { symbol: "AAPL", section: "press-releases", type: "8-K" });
    expect(last().search).toBe("");
    await call("quote", { symbols: ["AAPL", "BRK.B"] });
    expect(last().pathname + last().search).toBe("/api/quotes?symbols=AAPL%2CBRK.B");
    await call("price_history", { symbol: "AAPL" });
    expect(last().pathname + last().search).toBe("/api/history/AAPL?range=6M");
    await call("price_history", { symbol: "AAPL", range: "5Y" });
    expect(last().search).toBe("?range=5Y");
    await call("earnings_calendar", { symbols: ["AAPL", "MSFT"] });
    expect(last().pathname + last().search).toBe("/api/calendar?symbols=AAPL%2CMSFT");
    await call("estimate_revisions", { symbol: "AAPL" });
    expect(last().pathname).toBe("/api/estimates/AAPL");
    await call("economic_calendar", {});
    expect(last().pathname).toBe("/api/econ-calendar");
  });

  it("market maps sections, path params and query params", async () => {
    await call("market", { section: "index", params: { name: "sp500" } });
    expect(last().pathname).toBe("/api/research/market/index/sp500");
    await call("market", { section: "index-changes", params: { name: "nasdaq", limit: 10 } });
    expect(last().pathname + last().search).toBe("/api/research/market/index/nasdaq/changes?limit=10");
    await call("market", { section: "etf-holdings", params: { symbol: "SPY", limit: 20 } });
    expect(last().pathname + last().search).toBe("/api/research/market/etf/SPY/holdings?limit=20");
    await call("market", { section: "ipos", params: { from: "2026-11-01", to: "2026-11-30" } });
    expect(last().pathname + last().search).toBe("/api/research/market/ipos?from=2026-11-01&to=2026-11-30");
    await call("market", { section: "insiders-latest" });
    expect(last().pathname).toBe("/api/research/market/insiders/latest");
    await call("market", { section: "filings-8k-latest" });
    expect(last().pathname).toBe("/api/research/market/filings/8k/latest");
  });

  it("market rejects unknown params and missing path params without calling the API", async () => {
    let r = await call("market", { section: "ipos", params: { bogus: 1 } });
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/unknown params for ipos: bogus/);
    r = await call("market", { section: "index" });
    expect(r.text).toMatch(/needs params.name/);
    expect(calls).toHaveLength(0);
  });

  it("screen joins fields and forwards filters", async () => {
    await call("screen", { sector: "Technology", marketCapMin: 1e11, sort: "marketCap", order: "desc", limit: 10, fields: ["priceToEarningsRatioTTM", "upsidePercent"] });
    expect(last().pathname).toBe("/api/research/screen");
    expect(Object.fromEntries(last().searchParams)).toEqual({
      sector: "Technology", marketCapMin: "100000000000", sort: "marketCap", order: "desc", limit: "10", fields: "priceToEarningsRatioTTM,upsidePercent",
    });
  });
});

describe("scan tools", () => {
  it("ideas defaults to active stock ideas and forwards kind and limit", async () => {
    await call("ideas", {});
    expect(last().pathname + last().search).toBe("/api/scan/ideas?kind=stock&status=active");
    await call("ideas", { kind: "option", limit: 5 });
    expect(last().pathname + last().search).toBe("/api/scan/ideas?kind=option&status=active&limit=5");
  });

  it("scorecard and option_metrics hit their symbol routes", async () => {
    await call("scorecard", { symbol: "BRK.B" });
    expect(last().pathname).toBe("/api/scan/scorecard/BRK.B");
    await call("option_metrics", { symbol: "AAPL" });
    expect(last().pathname).toBe("/api/options-data/metrics/AAPL");
  });

  it("universe merges settings, symbols and status", async () => {
    respond = (url) => ({
      body: url.pathname.endsWith("/symbols") ? { symbols: ["AAPL"] } : url.pathname.endsWith("/status") ? { runs: {} } : { settings: { mode: "watchlists" }, symbolCount: 1 },
    });
    const { text } = await call("universe", {}, { ...cfg, maxChars: 100_000 });
    expect(JSON.parse(text)).toEqual({ settings: { mode: "watchlists" }, symbolCount: 1, symbols: ["AAPL"], status: { runs: {} } });
    expect(calls.map((c) => c.url.pathname).sort()).toEqual(["/api/scan/status", "/api/scan/universe", "/api/scan/universe/symbols"]);
  });

  it("rejects bad kind and limit before any request", async () => {
    for (const args of [{ kind: "put" }, { limit: 0 }]) {
      let rejected = false;
      try { rejected = (await call("ideas", args)).res.isError === true; } catch { rejected = true; }
      expect(rejected).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("input validation", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["fundamentals", { symbol: "AAPL", section: "nope" }],
    ["fundamentals", { symbol: "AAPL", section: "peers", period: "weekly" }],
    ["fundamentals", { symbol: "AAPL", section: "peers", limit: 0 }],
    ["ownership", { symbol: "AAPL", section: "institutional", quarter: 5 }],
    ["content", { symbol: "AAPL", section: "news", from: "01/02/2026" }],
    ["quote", { symbols: [] }],
    ["price_history", { symbol: "AAPL", range: "10Y" }],
    ["screen", { sort: "notAField" }],
    ["screen", { ratingMin: 9 }],
    ["search_transcripts", { symbol: "AAPL" }],
  ];
  it.each(bad)("%s rejects %j before any request", async (name, args) => {
    let rejected = false;
    try {
      const { res } = await call(name, args);
      rejected = res.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("research_summary", () => {
  it("uses the server's own snapshot when it has one", async () => {
    respond = () => ({ body: { symbol: "AAPL", dataset: "summary", data: { x: 1 } } });
    const { text } = await call("research_summary", { symbol: "aapl" });
    expect(JSON.parse(text).dataset).toBe("summary");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/research/AAPL"]);
  });

  it("fans out and keeps partial results", async () => {
    respond = (url) => (url.pathname === "/api/research/AAPL" ? { status: 404, body: { error: "Cannot GET" } } : url.pathname.endsWith("/valuation") ? { status: 502, body: { error: "fmp 500", feature: "research.valuation" } } : { body: { data: { ok: url.pathname } } });
    const { res, text } = await call("research_summary", { symbol: "aapl" }, { ...cfg, maxChars: 100_000 });
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(text);
    expect(out.symbol).toBe("AAPL");
    expect(out.metricsTtm).toEqual({ ok: "/api/research/AAPL/metrics" });
    expect(out.valuation.error).toMatch(/502 fmp 500 \[research.valuation\]/);
    expect(calls.map((c) => c.url.pathname).sort()).toEqual([
      "/api/calendar", "/api/quotes", "/api/research/AAPL", "/api/research/AAPL/analysts", "/api/research/AAPL/estimates",
      "/api/research/AAPL/metrics", "/api/research/AAPL/profile", "/api/research/AAPL/valuation",
    ]);
  });

  it("trims profile and analyst grades", async () => {
    respond = (url) =>
      url.pathname === "/api/research/AAPL"
        ? { status: 404, body: {} }
        : url.pathname.endsWith("/profile")
        ? { body: { data: { profile: { symbol: "AAPL", description: "long".repeat(100), sector: "Technology" }, executives: [{}] } } }
        : url.pathname.endsWith("/analysts")
        ? { body: { data: { grades: Array.from({ length: 50 }, (_, i) => ({ i })), priceTargets: [] } } }
        : { body: { data: {} } };
    const out = JSON.parse((await call("research_summary", { symbol: "AAPL" }, { ...cfg, maxChars: 100_000 })).text);
    expect(out.profile).toEqual({ symbol: "AAPL", sector: "Technology" });
    expect(out.analysts.grades).toHaveLength(5);
  });

  it("fails as a whole when everything fails", async () => {
    respond = () => ({ status: 400, body: { error: "US-listed symbols only (e.g. TSM for TSMC)" } });
    const { res, text } = await call("research_summary", { symbol: "SAP.DE" });
    expect(res.isError).toBe(true);
    expect(text).toContain("US-listed symbols only");
  });
});

describe("fundamentals analysts", () => {
  it("caps grades at limit (default 20)", async () => {
    respond = () => ({ body: { data: { grades: Array.from({ length: 50 }, (_, i) => ({ i })) } } });
    const cap = async (args: object) => JSON.parse((await call("fundamentals", { symbol: "AAPL", section: "analysts", ...args }, { ...cfg, maxChars: 100_000 })).text).data.grades.length;
    expect(await cap({})).toBe(20);
    expect(await cap({ limit: 7 })).toBe(7);
  });
});

describe("errors", () => {
  it("maps API errors to tool errors with the message", async () => {
    respond = () => ({ status: 503, body: { error: "needs FMP_API_KEY", feature: "research.float" } });
    const { res, text } = await call("ownership", { symbol: "AAPL", section: "float" });
    expect(res.isError).toBe(true);
    expect(text).toBe("503 needs FMP_API_KEY [research.float]");
  });

  it("hints at the key on 401", async () => {
    respond = () => ({ status: 401, body: { error: "Unauthorized" } });
    const { text } = await call("quote", { symbols: ["AAPL"] });
    expect(text).toMatch(/401 Unauthorized.*OPENTERMINAL_API_KEY/);
  });

  it("reports an unreachable API and non-JSON error bodies", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    let r = await call("economic_calendar", {});
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/cannot reach the OpenTerminal API at http:\/\/api.test.*fetch failed/);
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
    r = await call("economic_calendar", {});
    expect(r.text).toBe("502 <html>bad gateway</html>");
  });

  it("never echoes the API key", async () => {
    respond = () => ({ status: 500, body: { error: "boom" } });
    const { text } = await call("economic_calendar", {});
    expect(text).not.toContain("k3y");
  });
});

describe("truncation", () => {
  it("leaves small results alone and compacts JSON", async () => {
    respond = () => ({ body: { a: 1, b: [1, 2] } });
    expect((await call("economic_calendar", {})).text).toBe('{"a":1,"b":[1,2]}');
  });

  it("cuts long text and says how to narrow", async () => {
    respond = () => ({ body: { data: { content: "x".repeat(5000) } } });
    const { res, text } = await call("transcripts", { symbol: "AAPL", year: 2026, quarter: 1 });
    expect(res.isError).toBeUndefined();
    expect(text.startsWith('{"data":{"content":"xxx')).toBe(true);
    expect(text).toContain("[truncated: showing 1000 of 5023 characters.");
    expect(text).toContain("search_transcripts");
    expect(text.length).toBeLessThan(1400);
  });

  it("render() is a no-op under the limit", () => {
    expect(render({ a: 1 }, 10)).toBe('{"a":1}');
    expect(render(undefined, 10)).toBe("null");
  });
});

describe("config", () => {
  it("reads URL, key and max chars from env", () => {
    const c = configFromEnv({ OPENTERMINAL_API_URL: "http://x:1/", OPENTERMINAL_API_KEY: "abc", OPENTERMINAL_MAX_CHARS: "5000" });
    expect(c).toMatchObject({ baseUrl: "http://x:1", apiKey: "abc", maxChars: 5000 });
  });
  it("defaults to localhost:4000 and 40k chars; ignores a silly max", () => {
    const c = configFromEnv({ OPENTERMINAL_API_KEY: "abc", OPENTERMINAL_MAX_CHARS: "5" });
    expect(c).toMatchObject({ baseUrl: "http://127.0.0.1:4000", maxChars: 40_000 });
  });
});
