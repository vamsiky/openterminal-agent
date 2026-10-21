import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { FmpError, FmpNotConfigured } from "../../providers/fmp-core.js";
import { envelope, fail, parseQuery, parseSymbol, symbolParam } from "./common.js";

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe("symbolParam", () => {
  it("uppercases and accepts share classes", () => {
    expect(symbolParam.parse("aapl")).toBe("AAPL");
    expect(symbolParam.parse("brk.b")).toBe("BRK.B");
    expect(symbolParam.parse("BRK-B")).toBe("BRK-B");
  });
  it("rejects foreign listings and junk", () => {
    expect(symbolParam.safeParse("7203.T").success).toBe(false);
    expect(symbolParam.safeParse("SAP.DE").success).toBe(false);
    expect(symbolParam.safeParse("a b").success).toBe(false);
    expect(symbolParam.safeParse("").success).toBe(false);
  });
  it("parseSymbol answers 400", () => {
    const res = mockRes();
    expect(parseSymbol(res, "SAP.DE")).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toContain("US-listed symbols only");
    expect(parseSymbol(mockRes(), "msft")).toBe("MSFT");
  });
});

describe("envelope", () => {
  it("wraps data with source and asOf", () => {
    const e = envelope({ symbol: "AAPL", dataset: "profile", data: [1], asOf: new Date("2026-01-01T00:00:00Z") });
    expect(e).toEqual({ symbol: "AAPL", dataset: "profile", source: "fmp", asOf: "2026-01-01T00:00:00.000Z", data: [1] });
  });
  it("omits symbol for market-wide data and defaults asOf to now", () => {
    const e = envelope({ dataset: "gainers", data: [] });
    expect("symbol" in e).toBe(false);
    expect(Date.parse(e.asOf)).not.toBeNaN();
  });
});

describe("fail", () => {
  it("maps FmpNotConfigured to 503", () => {
    const res = mockRes();
    fail(res, new FmpNotConfigured(), "profile");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "needs FMP_API_KEY", feature: "profile" });
  });
  it("maps FmpError to 502 and never leaks the key", () => {
    process.env.FMP_API_KEY = "secret-key";
    const res = mockRes();
    fail(res, new FmpError(500, "fmp 500 for /x?apikey=secret-key"), "profile");
    expect(res.status).toHaveBeenCalledWith(502);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain("secret-key");
    expect(res.json.mock.calls[0][0].feature).toBe("profile");
  });
  it("maps anything else to 500", () => {
    const res = mockRes();
    fail(res, new Error("boom"), "profile");
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("parseQuery", () => {
  it("accepts period, limit and dates", () => {
    expect(parseQuery(mockRes(), { period: "ttm", limit: "5", from: "2026-01-01", to: "2026-02-01" })).toEqual({
      period: "ttm",
      limit: 5,
      from: "2026-01-01",
      to: "2026-02-01",
    });
    expect(parseQuery(mockRes(), {})).toEqual({});
  });
  it("answers 400 on bad input", () => {
    for (const q of [{ period: "weekly" }, { limit: "0" }, { limit: "abc" }, { from: "01/02/2026" }]) {
      const res = mockRes();
      expect(parseQuery(res, q)).toBeNull();
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });
});
