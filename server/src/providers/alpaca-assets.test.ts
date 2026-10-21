import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// universe.ts pulls in db.ts, which opens real sqlite files under DATA_DIR at import time.
let tmpDir: string;
let assets: typeof import("./alpaca-assets.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-assets-test-"));
  process.env.DATA_DIR = tmpDir;
  assets = await import("./alpaca-assets.js");
});

afterAll(async () => {
  (await import("../db.js")).db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const nasdaq = [
  "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
  "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N",
  "AAPD|Direxion Daily AAPL Bear 1X Shares|G|N|N|100|Y|N",
  "AMD|Advanced Micro Devices, Inc. - Common Stock|Q|N|N|100|N|N",
  "NVDA|NVIDIA Corporation - Common Stock|Q|N|N|100|N|N",
  "QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N",
  "ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N",
  "File Creation Time: 1016202621:00|||||||",
].join("\n");
const other = [
  "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
  "BRK.B|Berkshire Hathaway Inc. Class B|N|BRK.B|N|100|N|BRK=B",
  "SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY",
].join("\r\n");

function mockDirectories() {
  const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, text: async () => (url.includes("nasdaqlisted") ? nasdaq : other) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("asset search", () => {
  beforeEach(() => assets.resetAssets());
  afterEach(() => vi.unstubAllGlobals());

  it("ranks exact symbol, then symbol prefix, then name words", async () => {
    mockDirectories();
    expect((await assets.search("aapl")).map((r) => r.symbol)).toEqual(["AAPL", "AAPD"]);
    expect((await assets.search("AA")).map((r) => r.symbol)).toEqual(["AAPD", "AAPL", "AAVE-USD"]);
    expect((await assets.search("micro devices")).map((r) => r.symbol)).toEqual(["AMD"]);
    expect((await assets.search("nvidia")).map((r) => r.symbol)).toEqual(["NVDA"]);
  });

  it("returns the old search shape, with ETFs as funds, exchange names and crypto pairs", async () => {
    mockDirectories();
    expect(await assets.search("spy")).toEqual([{ symbol: "SPY", name: "SPDR S&P 500 ETF Trust", exchange: "NYSE Arca", type: "fund" }]);
    expect((await assets.search("brk.b"))[0]).toEqual({ symbol: "BRK.B", name: "Berkshire Hathaway Inc. Class B", exchange: "NYSE", type: "stock" });
    expect((await assets.search("btc"))[0]).toEqual({ symbol: "BTC-USD", name: "Bitcoin", exchange: "Crypto", type: "crypto" });
    expect((await assets.search("bitcoin")).map((r) => r.symbol)).toContain("BTC-USD");
  });

  it("skips test issues, honours the limit and returns nothing for a blank query", async () => {
    mockDirectories();
    expect(await assets.search("zxzzt")).toEqual([]);
    expect(await assets.search("a", 2)).toHaveLength(2);
    expect(await assets.search("  ")).toEqual([]);
  });

  it("loads once a day and keeps the stale list when a refresh fails", async () => {
    const fetchMock = mockDirectories();
    const t0 = Date.parse("2026-10-20T12:00:00Z");
    await assets.allAssets(t0);
    await assets.allAssets(t0 + 3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // nasdaqlisted + otherlisted, once
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "" })));
    expect((await assets.allAssets(t0 + 25 * 3_600_000)).length).toBeGreaterThan(0);
  });

  it("surfaces the error when there is no list to fall back on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "" })));
    await expect(assets.search("aapl")).rejects.toThrow(/503/);
  });
});
