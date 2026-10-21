import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// db.ts (pulled in for dataDir) opens a real sqlite file under DATA_DIR at import time.
let tmpDir: string;
let sec: typeof import("./sec-reference.js");
let dbModule: typeof import("../db.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-secref-test-"));
  process.env.DATA_DIR = tmpDir;
  dbModule = await import("../db.js");
  sec = await import("./sec-reference.js");
});

afterAll(() => {
  dbModule.db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const TICKERS = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1652044, ticker: "GOOGL", title: "Alphabet Inc." },
  "2": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
};

const SUBMISSIONS: Record<string, any> = {
  "0000320193": { name: "Apple Inc.", sic: "3571", sicDescription: "Electronic Computers" },
  "0001652044": { name: "Alphabet Inc.", sic: "7370", sicDescription: "Services-Computer Programming, Data Processing, Etc." },
  "0001067983": { name: "BERKSHIRE HATHAWAY INC", sic: "6331", sicDescription: "Fire, Marine & Casualty Insurance" },
};

const SHARES = {
  "0000320193": {
    units: {
      shares: [
        { end: "2026-04-17", val: 14687356000, filed: "2026-05-01" },
        { end: "2026-07-17", val: 14594180000, filed: "2026-07-31" },
      ],
    },
  },
  "0001067983": { units: { shares: [{ end: "2026-07-24", val: 1_300_000_000, filed: "2026-08-01" }] } },
};

function mockSec() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("company_tickers.json")) return { ok: true, status: 200, json: async () => TICKERS };
    const cik = url.match(/CIK(\d{10})/)?.[1] ?? "";
    if (url.includes("/submissions/")) return { ok: true, status: 200, json: async () => SUBMISSIONS[cik] };
    if (SHARES[cik as keyof typeof SHARES]) return { ok: true, status: 200, json: async () => SHARES[cik as keyof typeof SHARES] };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("SEC_EDGAR_CONTACT", "ops@example.com");
  sec.resetReferenceState();
  rmSync(join(tmpDir, "sec-reference.json"), { force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("sectorFromSic", () => {
  it.each([
    ["3571", "Technology"],
    ["3674", "Technology"],
    ["7372", "Technology"],
    ["2834", "Health Care"],
    ["3841", "Health Care"],
    ["6022", "Financials"],
    ["6331", "Financials"],
    ["6798", "Real Estate"],
    ["1311", "Energy"],
    ["2911", "Energy"],
    ["4911", "Utilities"],
    ["4953", "Industrials"],
    ["4813", "Communication Services"],
    ["5411", "Consumer Staples"],
    ["5961", "Consumer Discretionary"],
    ["3711", "Consumer Discretionary"],
    ["3634", "Consumer Discretionary"],
    ["2000", "Consumer Staples"],
    ["2860", "Materials"],
    ["3312", "Materials"],
    ["3721", "Industrials"],
    ["4400", "Industrials"],
    ["9999", "Other"],
    [null, "Other"],
  ])("maps SIC %s to %s", (sic, sector) => {
    expect(sec.sectorFromSic(sic)).toBe(sector);
  });
});

describe("latestShares", () => {
  it("takes the most recent period and ignores empty values", () => {
    expect(sec.latestShares(SHARES["0000320193"])).toEqual({ shares: 14594180000, asOf: "2026-07-17" });
    expect(sec.latestShares({ units: { shares: [{ end: "2026-01-01", val: 0 }] } })).toBeNull();
    expect(sec.latestShares(null)).toBeNull();
  });
});

describe("reference", () => {
  it("builds entries from the ticker map, submissions and share concept, and treats a 404 concept as unknown shares", async () => {
    const fetchMock = mockSec();
    const out = await sec.reference(["aapl", "GOOGL", "BRK.B", "SPY"]);

    expect(out.get("AAPL")).toEqual({
      symbol: "AAPL",
      cik: "0000320193",
      name: "Apple Inc.",
      sic: "3571",
      sicDescription: "Electronic Computers",
      sector: "Technology",
      sharesOutstanding: 14594180000,
      sharesAsOf: "2026-07-17",
      fetchedAt: expect.any(Number),
    });
    expect(out.get("GOOGL")).toMatchObject({ sector: "Technology", sharesOutstanding: null, sharesAsOf: null });
    expect(out.get("BRK.B")).toMatchObject({ cik: "0001067983", sector: "Financials", sharesOutstanding: 1_300_000_000 });
    expect(out.has("SPY")).toBe(false); // no CIK
    // identifying User-Agent on every call
    for (const [, init] of fetchMock.mock.calls) expect(init.headers["User-Agent"]).toBe("OpenTerminal ops@example.com");
  });

  it("persists to DATA_DIR and does not refetch fresh entries after a restart", async () => {
    mockSec();
    await sec.reference(["AAPL"]);
    expect(JSON.parse(readFileSync(join(tmpDir, "sec-reference.json"), "utf8"))[0]).toMatchObject({ symbol: "AAPL", cik: "0000320193" });

    sec.resetReferenceState(); // simulated restart: memory gone, file stays
    const fetchMock = mockSec();
    const out = await sec.reference(["AAPL"]);
    expect(out.get("AAPL")?.name).toBe("Apple Inc.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes entries older than seven days and keeps the stale one if the refresh fails", async () => {
    const stale = { symbol: "AAPL", cik: "0000320193", name: "Old Name", sic: null, sicDescription: null, sector: "Other", sharesOutstanding: 1, sharesAsOf: null, fetchedAt: Date.now() - 8 * 86_400_000 };
    writeFileSync(join(tmpDir, "sec-reference.json"), JSON.stringify([stale]));

    mockSec();
    expect((await sec.reference(["AAPL"])).get("AAPL")?.name).toBe("Apple Inc.");

    writeFileSync(join(tmpDir, "sec-reference.json"), JSON.stringify([stale]));
    sec.resetReferenceState();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    expect((await sec.reference(["AAPL"])).get("AAPL")?.name).toBe("Old Name");
  });

  it("refreshReference refetches even fresh entries", async () => {
    mockSec();
    await sec.reference(["AAPL"]);
    const fetchMock = mockSec();
    await sec.refreshReference(["AAPL"]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps SEC requests at least 200 ms apart", async () => {
    vi.useFakeTimers();
    const fetchMock = mockSec();
    const times: number[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      times.push(Date.now());
      return url.endsWith("company_tickers.json")
        ? { ok: true, status: 200, json: async () => TICKERS }
        : { ok: true, status: 200, json: async () => (url.includes("/submissions/") ? SUBMISSIONS["0000320193"] : SHARES["0000320193"]) };
    });
    const p = sec.reference(["AAPL"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(200);
  });
});
