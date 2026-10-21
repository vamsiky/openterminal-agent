import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// OpenFIGI answers below are trimmed from real responses (2026-10-20).

vi.mock("../providers/alpaca-assets.js", () => ({ allAssets: vi.fn() }));

// db.ts (pulled in for dataDir) opens a real sqlite file under DATA_DIR at import time.
let tmpDir: string;
let usListing: typeof import("./us-listing.js");
let assets: typeof import("../providers/alpaca-assets.js");
let dbModule: typeof import("../db.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-uslisting-test-"));
  process.env.DATA_DIR = tmpDir;
  dbModule = await import("../db.js");
  usListing = await import("./us-listing.js");
  assets = await import("../providers/alpaca-assets.js");
});

afterAll(() => {
  dbModule.db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const stock = (symbol: string, name: string, exchange = "NYSE") => ({ symbol, name, exchange, type: "stock" });
const LISTINGS = [
  stock("SHOP", "Shopify Inc. - Class A Subordinate Voting Shares", "Nasdaq"),
  stock("T", "AT&T Inc."),
  stock("TU", "Telus Corporation Ordinary Shares"),
  stock("TSM", "Taiwan Semiconductor Manufacturing Company Ltd."),
  stock("NVO", "Novo Nordisk A/S Common Stock"),
  stock("ACME", "Acme Group PLC American Depositary Shares"),
  stock("ACMY", "Acme Group Ltd Sponsored ADR"),
];

const common = (ticker: string, exchCode: string, name: string, shareClassFIGI: string) => ({
  ticker, exchCode, name, securityType: "Common Stock", securityType2: "Common Stock", marketSector: "Equity", shareClassFIGI,
});
const adr = (ticker: string, name: string, shareClassFIGI: string) => ({
  ticker, exchCode: "US", name, securityType: "ADR", securityType2: "Depositary Receipt", marketSector: "Equity", shareClassFIGI,
});

// idType|idValue|exchCode → records
const FIGI: Record<string, unknown[]> = {
  "TICKER|SHOP|CT": [common("SHOP", "CT", "SHOPIFY INC - CLASS A", "BBG004DW5NC7")],
  "ID_BB_GLOBAL_SHARE_CLASS_LEVEL|BBG004DW5NC7|US": [common("SHOP", "US", "SHOPIFY INC - CLASS A", "BBG004DW5NC7")],
  "TICKER|T|CT": [common("T", "CT", "TELUS CORP", "BBG001S60K53")],
  "ID_BB_GLOBAL_SHARE_CLASS_LEVEL|BBG001S60K53|US": [common("TU", "US", "TELUS CORP", "BBG001S60K53")],
  "TICKER|TU|US": [common("TU", "US", "TELUS CORP", "BBG001S60K53")],
  "TICKER|2330|TT": [common("2330", "TT", "TAIWAN SEMICONDUCTOR MANUFAC", "BBG001S6Q004")],
  // The ordinary shares' US ticker is OTC, not a listing.
  "ID_BB_GLOBAL_SHARE_CLASS_LEVEL|BBG001S6Q004|US": [common("TSMWF", "US", "TAIWAN SEMICONDUCTOR MANUFAC", "BBG001S6Q004")],
  "TICKER|TSM|US": [adr("TSM", "TAIWAN SEMICONDUCTOR-SP ADR", "BBG001S5WWW4")],
  "TICKER|NOVOB|DC": [common("NOVOB", "DC", "NOVO NORDISK A/S-B", "BBG001S6RN12")],
  "ID_BB_GLOBAL_SHARE_CLASS_LEVEL|BBG001S6RN12|US": [common("NONOF", "US", "NOVO NORDISK A/S-B", "BBG001S6RN12")],
  "TICKER|NVO|US": [adr("NVO", "NOVO-NORDISK A/S-SPONS ADR", "BBG001S5TSK0")],
  "TICKER|ACM|LN": [common("ACM", "LN", "ACME GROUP PLC", "BBG000ACME01")],
  "ID_BB_GLOBAL_SHARE_CLASS_LEVEL|BBG000ACME01|US": [],
  "TICKER|ACME|US": [adr("ACME", "ACME GROUP PLC-ADR", "BBG000ACME02")],
  "TICKER|ACMY|US": [adr("ACMY", "ACME GROUP LTD-SPON ADR", "BBG000ACME03")],
};

/** OpenFIGI from the table above; `status` makes every request fail with it. */
function mockFigi(status = 200) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const jobs = JSON.parse(String(init.body)) as Array<{ idType: string; idValue: string; exchCode: string }>;
    const body = jobs.map((j) => {
      const data = FIGI[`${j.idType}|${j.idValue}|${j.exchCode}`];
      return data && data.length > 0 ? { data } : { warning: "No identifier found." };
    });
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const jobsSent = (fetchMock: ReturnType<typeof mockFigi>) =>
  fetchMock.mock.calls.flatMap((c) => JSON.parse(String(c[1].body)) as Array<{ idValue: string }>).map((j) => j.idValue);

beforeEach(() => {
  usListing.resetUsListingState();
  rmSync(join(tmpDir, "us-listings.json"), { force: true });
  vi.mocked(assets.allAssets).mockReset().mockResolvedValue(LISTINGS);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("figiQuery", () => {
  it.each([
    ["SHOP.TO", { ticker: "SHOP", exchCode: "CT" }],
    ["BBD-B.TO", { ticker: "BBD/B", exchCode: "CT" }],
    ["NOVO-B.CO", { ticker: "NOVOB", exchCode: "DC" }],
    ["0700.HK", { ticker: "700", exchCode: "HK" }],
    ["7203.T", { ticker: "7203", exchCode: "JT" }],
    ["2330.TW", { ticker: "2330", exchCode: "TT" }],
    ["SAP.DE", { ticker: "SAP", exchCode: "GR" }],
    ["BP.L", { ticker: "BP/", exchCode: "LN" }],
    ["VOD.L", { ticker: "VOD", exchCode: "LN" }],
    ["AAPL", null],
    ["BRK.B", null],
    ["EURUSD=X", null],
  ])("%s", (symbol, expected) => {
    expect(usListing.figiQuery(symbol)).toEqual(expected);
  });
});

describe("namesMatch", () => {
  it("matches the same company across legal forms and depositary wording", () => {
    expect(usListing.namesMatch("TOYOTA MOTOR CORP", "Toyota Motor Corporation Common Stock")).toBe(true);
    expect(usListing.namesMatch("ALIBABA GROUP HOLDING LTD", "Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share")).toBe(true);
    expect(usListing.namesMatch("ASML HOLDING NV", "ASML Holding N.V. - New York Registry Shares")).toBe(true);
    expect(usListing.namesMatch("SAP SE", "SAP  SE ADS")).toBe(true);
    expect(usListing.namesMatch("BANCO SANTANDER SA", "Banco Santander, S.A. Sponsored ADR (Spain)")).toBe(true);
  });

  it("reads a name OpenFIGI cut at 28 characters as a prefix", () => {
    expect(usListing.namesMatch("TAIWAN SEMICONDUCTOR MANUFAC", "Taiwan Semiconductor Manufacturing Company Ltd.")).toBe(true);
    expect(usListing.namesMatch("TAIWAN SEMICONDUCTOR MANUFAC", "Taiwan Semiconductor Co")).toBe(false);
  });

  it("rejects other companies that share words", () => {
    expect(usListing.namesMatch("TELUS CORP", "AT&T Inc.")).toBe(false);
    expect(usListing.namesMatch("BANCO SANTANDER SA", "Banco Santander Brasil SA American Depositary Shares, each representing one unit")).toBe(false);
    expect(usListing.namesMatch("BANCO SANTANDER SA", "Banco Santander - Chile ADS")).toBe(false);
    expect(usListing.namesMatch("SONY GROUP CORP", "Sony Corp")).toBe(false);
  });
});

describe("lookup", () => {
  it("maps SHOP.TO to SHOP, the same share class on a US exchange", async () => {
    mockFigi();
    expect(await usListing.lookup(["SHOP.TO"])).toEqual(new Map([["SHOP.TO", { symbol: "SHOP", exchange: "Nasdaq", kind: "interlisted" }]]));
  });

  it("maps 2330.TW to the TSM ADR, and NOVO-B.CO to NVO, in one batch", async () => {
    const fetchMock = mockFigi();
    const got = await usListing.lookup(["2330.TW", "NOVO-B.CO"]);
    expect(got.get("2330.TW")).toEqual({ symbol: "TSM", exchange: "NYSE", kind: "adr" });
    expect(got.get("NOVO-B.CO")).toEqual({ symbol: "NVO", exchange: "NYSE", kind: "adr" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps T.TO to Telus (TU), never to AT&T (T)", async () => {
    mockFigi();
    expect((await usListing.lookup(["T.TO"])).get("T.TO")).toEqual({ symbol: "TU", exchange: "NYSE", kind: "interlisted" });

    // Without TU among the US listings there is no mapping at all.
    usListing.resetUsListingState();
    rmSync(join(tmpDir, "us-listings.json"));
    vi.mocked(assets.allAssets).mockResolvedValue(LISTINGS.filter((a) => a.symbol !== "TU"));
    expect(await usListing.lookup(["T.TO"])).toEqual(new Map());
  });

  it("maps nothing when two US receipts carry the company's name", async () => {
    const fetchMock = mockFigi();
    expect(await usListing.lookup(["ACM.L"])).toEqual(new Map());
    expect(jobsSent(fetchMock)).toEqual(expect.arrayContaining(["ACME", "ACMY"]));
  });

  it("maps nothing for a name-alike US stock that isn't a depositary receipt", async () => {
    mockFigi();
    vi.mocked(assets.allAssets).mockResolvedValue([stock("TSMC", "Taiwan Semiconductor Manufacturing Corp Common Stock")]);
    FIGI["TICKER|TSMC|US"] = [common("TSMC", "US", "TAIWAN SEMICONDUCTOR MFG", "BBG000OTHER1")];
    try {
      expect(await usListing.lookup(["2330.TW"])).toEqual(new Map());
    } finally {
      delete FIGI["TICKER|TSMC|US"];
    }
  });

  it("doesn't keep an OpenFIGI failure: the symbol is asked again after the backoff", async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    let fetchMock = mockFigi(429);
    expect(await usListing.lookup(["SHOP.TO"])).toEqual(new Map());
    expect(existsSync(join(tmpDir, "us-listings.json"))).toBe(false);

    fetchMock = mockFigi();
    expect(await usListing.lookup(["SHOP.TO"])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();

    clock.mockReturnValue(t0 + 10 * 60_000);
    expect((await usListing.lookup(["SHOP.TO"])).get("SHOP.TO")?.symbol).toBe("SHOP");
  });

  it("persists answers, 'no listing' included, and checks them again after 30 days", async () => {
    let fetchMock = mockFigi();
    await usListing.lookup(["SHOP.TO", "ACM.L"]);
    const saved = JSON.parse(readFileSync(join(tmpDir, "us-listings.json"), "utf8"));
    expect(saved).toEqual([
      expect.objectContaining({ symbol: "SHOP.TO", listing: { symbol: "SHOP", exchange: "Nasdaq", kind: "interlisted" } }),
      expect.objectContaining({ symbol: "ACM.L", listing: null }),
    ]);

    // A restart reads the file instead of asking OpenFIGI.
    usListing.resetUsListingState();
    fetchMock = mockFigi();
    expect((await usListing.lookup(["SHOP.TO", "ACM.L"])).get("SHOP.TO")?.symbol).toBe("SHOP");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 86_400_000);
    await usListing.lookup(["SHOP.TO"]);
    expect(jobsSent(fetchMock)).toEqual(["SHOP", "BBG004DW5NC7"]);
  });
});
