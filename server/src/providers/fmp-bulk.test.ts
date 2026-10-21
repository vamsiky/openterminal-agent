import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// fmp-bulk imports universe.ts, which opens sqlite under DATA_DIR at import time.
const tmpDir = mkdtempSync(join(tmpdir(), "fmp-bulk-"));
let bulk: typeof import("./fmp-bulk.js");
let FmpError: typeof import("./fmp-core.js").FmpError;

beforeAll(async () => {
  process.env.DATA_DIR = tmpDir;
  bulk = await import("./fmp-bulk.js");
  ({ FmpError } = await import("./fmp-core.js"));
});
afterAll(async () => {
  (await import("../db.js")).db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const PROFILE_CSV = [
  `"symbol","price","companyName","description","isEtf","cik","fullTimeEmployees","exchange"`,
  `"AAPL",250.5,"Apple Inc.","Makes phones, tablets
and ""Macs"".",false,"0000320193","164000","NASDAQ"`,
  `"BRK-B",480,"Berkshire Hathaway Inc.",,false,"0001067983",,"NYSE"`,
  `" GVT&D.NS",1e3,"GE Vernova T&D","",true,,"",NSE`,
].join("\r\n");

describe("CsvParser", () => {
  it("keeps quoted fields as strings and types unquoted ones like FMP's JSON", () => {
    const rows = bulk.parseCsv(PROFILE_CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      symbol: "AAPL",
      price: 250.5,
      companyName: "Apple Inc.",
      description: 'Makes phones, tablets\nand "Macs".',
      isEtf: false,
      cik: "0000320193",
      fullTimeEmployees: "164000",
      exchange: "NASDAQ",
    });
    expect(rows[1]).toMatchObject({ symbol: "BRK-B", description: null, fullTimeEmployees: null });
    expect(rows[2]).toMatchObject({ symbol: " GVT&D.NS", price: 1000, description: "", isEtf: true, cik: null, exchange: "NSE" });
  });

  it("gives the same rows whatever the chunk boundaries", () => {
    const whole = bulk.parseCsv(PROFILE_CSV);
    for (const size of [1, 2, 3, 7, 50]) {
      const p = new bulk.CsvParser();
      const rows = [];
      for (let i = 0; i < PROFILE_CSV.length; i += size) rows.push(...p.push(PROFILE_CSV.slice(i, i + size)));
      rows.push(...p.end());
      expect(rows).toEqual(whole);
    }
  });

  it("handles a trailing newline, blank lines, a quote closing at the end and missing trailing fields", () => {
    expect(bulk.parseCsv(`"a","b"\n1,"x"\n\n2\n`)).toEqual([
      { a: 1, b: "x" },
      { a: 2, b: null },
    ]);
    expect(bulk.parseCsv(`"a","b"\n1,"say ""hi"""`)).toEqual([{ a: 1, b: 'say "hi"' }]);
    expect(bulk.parseCsv(`"a"\n`)).toEqual([]);
  });

  it("parses FMP's JSON-in-CSV publishers field", () => {
    const [row] = bulk.parseCsv(`"symbol","publishers"\n"A","[""StreetInsider"",""Benzinga""]"\n`);
    expect(JSON.parse(row.publishers as string)).toEqual(["StreetInsider", "Benzinga"]);
  });
});

describe("US listings", () => {
  it("converts FMP symbols to the app's form", () => {
    expect(bulk.appSymbol("BRK-B")).toBe("BRK.B");
    expect(bulk.appSymbol(" gvt&d.ns")).toBe("GVT&D.NS");
    expect(bulk.appSymbol("BAC-PL")).toBe("BAC-PL");
  });

  it("keeps US exchanges and drops foreign suffixes, whatever the country", () => {
    expect(bulk.isUsListing({ symbol: "AAPL", exchange: "NASDAQ", country: "US" })).toBe(true);
    expect(bulk.isUsListing({ symbol: "ACN", exchange: "NYSE", country: "IE", isAdr: false })).toBe(true);
    expect(bulk.isUsListing({ symbol: "TSM", exchange: "NYSE", country: "TW", isAdr: true })).toBe(true);
    expect(bulk.isUsListing({ symbol: "TCEHY", exchange: "OTC", country: "CN" })).toBe(true);
    expect(bulk.isUsListing({ symbol: "SPY", exchange: "AMEX" })).toBe(true);
    expect(bulk.isUsListing({ symbol: "SHOP.TO", exchange: "TSX" })).toBe(false);
    expect(bulk.isUsListing({ symbol: "0700.HK", exchange: "HKSE" })).toBe(false);
    expect(bulk.isUsListing({ symbol: "SAP.DE", exchange: "NYSE" })).toBe(false); // a foreign suffix wins
    expect(bulk.isUsListing({ symbol: "", exchange: "NYSE" })).toBe(false);
  });

  it("maps rating letters to /ratings-snapshot's overallScore", () => {
    expect(bulk.ratingScore("A-")).toBe(4);
    expect(bulk.ratingScore("B-")).toBe(2);
    expect(bulk.ratingScore("C-")).toBe(1);
    expect(bulk.ratingScore("S")).toBe(5);
    expect(bulk.ratingScore("Z")).toBeNull();
    expect(bulk.ratingScore(null)).toBeNull();
  });
});

function csv(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/csv" } });
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("download", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.FMP_API_KEY = "secret-key";
    bulk.resetState(0);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("streams rows and counts bytes", async () => {
    fetchMock.mockResolvedValueOnce(csv(`"symbol","dcf"\n"AAPL",200\n"MSFT",400\n`));
    const rows: unknown[] = [];
    const got = await bulk.download("dcf-bulk", {}, (r) => rows.push(r));
    expect(got).toEqual({ rows: 2, bytes: 37, calls: 1 });
    expect(rows).toEqual([{ symbol: "AAPL", dcf: 200 }, { symbol: "MSFT", dcf: 400 }]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/stable/dcf-bulk");
    expect(url.searchParams.get("apikey")).toBe("secret-key");
  });

  it("retries FMP's bulk 429 and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ "Error Message": "Limit Reach. This is a bulk endpoint..." }, 429))
      .mockResolvedValueOnce(csv(`"symbol"\n"AAPL"\n`));
    const got = await bulk.download("rating-bulk", {}, () => {});
    expect(got).toMatchObject({ rows: 1, calls: 2 });
  });

  it("spaces calls to the same endpoint", async () => {
    bulk.resetState(40);
    fetchMock.mockImplementation(async () => csv(`"symbol"\n"A"\n`));
    const t = Date.now();
    await Promise.all([bulk.download("dcf-bulk", {}, () => {}), bulk.download("dcf-bulk", {}, () => {})]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(35);
  });

  it("throws FmpError without leaking the key, for HTTP errors and 200 error messages", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const err = await bulk.download("dcf-bulk", {}, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(FmpError);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain("secret-key");

    fetchMock.mockResolvedValueOnce(json({ "Error Message": "Special Endpoint" }));
    await expect(bulk.download("dcf-bulk", {}, () => {})).rejects.toMatchObject({ status: 200 });
  });

  it("needs the key", async () => {
    delete process.env.FMP_API_KEY;
    await expect(bulk.download("dcf-bulk", {}, () => {})).rejects.toThrow(/FMP_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pages profile-bulk until FMP refuses the part number", async () => {
    fetchMock
      .mockResolvedValueOnce(csv(`"symbol"\n"A"\n"B"\n`))
      .mockResolvedValueOnce(csv(`"symbol"\n"C"\n`))
      .mockResolvedValueOnce(json("Query Error: Invalid or missing query parameter - part", 400));
    const rows: unknown[] = [];
    const got = await bulk.downloadParts("profile-bulk", (r) => rows.push(r));
    expect(got).toMatchObject({ rows: 3, parts: 2, calls: 2 });
    expect(fetchMock.mock.calls.map((c) => new URL(c[0]).searchParams.get("part"))).toEqual(["0", "1", "2"]);
  });

  it("fails when the first profile part fails", async () => {
    fetchMock.mockResolvedValueOnce(json("bad", 400));
    await expect(bulk.downloadParts("profile-bulk", () => {})).rejects.toMatchObject({ status: 400 });
  });
});
