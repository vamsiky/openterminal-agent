import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FmpError, FmpNotConfigured, cached, fmpSymbol, get, mapLimit, maxRequestsPerMinute, num, requireKey, resetState, str, unixDay } from "./fmp-core.js";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => "", headers: new Headers() };
}
function bad(status: number, body = "nope") {
  return { ok: false, status, json: async () => ({}), text: async () => body, headers: new Headers({ "retry-after": "0" }) };
}

describe("fmp-core", () => {
  beforeEach(() => {
    process.env.FMP_API_KEY = "test-key";
    delete process.env.FMP_MAX_REQ_PER_MIN;
    resetState();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the limiter from FMP_MAX_REQ_PER_MIN, defaulting to 300", () => {
    expect(maxRequestsPerMinute(undefined)).toBe(300);
    expect(maxRequestsPerMinute("")).toBe(300);
    expect(maxRequestsPerMinute("abc")).toBe(300);
    expect(maxRequestsPerMinute("0")).toBe(300);
    expect(maxRequestsPerMinute("3000")).toBe(3000);
  });

  it("converts share classes to FMP's dash form", () => {
    expect(fmpSymbol("brk.b")).toBe("BRK-B");
    expect(fmpSymbol(" BF.B ")).toBe("BF-B");
    expect(fmpSymbol("AAPL")).toBe("AAPL");
  });

  it("requireKey throws FmpNotConfigured without a key", () => {
    process.env.FMP_API_KEY = "  ";
    expect(() => requireKey()).toThrow(FmpNotConfigured);
  });

  it("caches within the ttl and reloads after resetState", async () => {
    const load = vi.fn(async () => ({ n: 1 }));
    await cached("k", 60_000, load);
    await cached("k", 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);
    resetState();
    await cached("k", 60_000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("get sends the key and dashed symbols, and maps failures to FmpError without the key", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok([{ a: 1 }])).mockResolvedValueOnce(bad(402, "Premium only"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await get("profile", { symbol: "BRK.B", skip: undefined })).toEqual([{ a: 1 }]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/stable/profile");
    expect(url.searchParams.get("symbol")).toBe("BRK-B");
    expect(url.searchParams.get("apikey")).toBe("test-key");
    const err = await get("quote", { symbol: "X" }).catch((e) => e);
    expect(err).toBeInstanceOf(FmpError);
    expect(err.status).toBe(402);
    expect(err.message).not.toContain("test-key");
  });

  it("get retries 429 and surfaces 200 error bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(bad(429)).mockResolvedValueOnce(ok({ "Error Message": "Invalid thing" }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await get("x", {}).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(FmpError);
    expect(err.message).toContain("Invalid thing");
  });

  it("mapLimit keeps order", async () => {
    expect(await mapLimit([3, 1, 2], async (n) => n * 2)).toEqual([6, 2, 4]);
  });

  it("parses numbers, strings and days", () => {
    expect(num("1.5")).toBe(1.5);
    expect(num("")).toBeNull();
    expect(num("x")).toBeNull();
    expect(str("  ")).toBeNull();
    expect(str("a")).toBe("a");
    expect(unixDay("2026-01-02 10:00:00")).toBe(Date.UTC(2026, 0, 2) / 1000);
    expect(unixDay("nope")).toBeNull();
  });
});
