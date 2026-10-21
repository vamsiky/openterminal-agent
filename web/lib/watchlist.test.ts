import { afterEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "./api";
import { fetchQuotes, listPath, normalizeListName, QUOTE_CHUNK } from "./watchlist";

describe("normalizeListName", () => {
  it("trims and collapses spaces", () => {
    expect(normalizeListName("  Daily   Watchlist ")).toBe("Daily Watchlist");
    expect(normalizeListName("Energy-AI")).toBe("Energy-AI");
  });
  it("rejects invalid names", () => {
    for (const n of ["", "   ", "-lead", "a/b", "a.b", "x".repeat(41)]) expect(normalizeListName(n)).toBeNull();
    expect(normalizeListName("x".repeat(40))).not.toBeNull();
  });
  it("rejects 'import' in any case", () => {
    for (const n of ["import", "Import", "IMPORT", " iMpOrT "]) expect(normalizeListName(n)).toBeNull();
    expect(normalizeListName("imports")).toBe("imports");
  });
});

describe("listPath", () => {
  it("encodes the name", () => {
    expect(listPath("Daily Watchlist")).toBe("/api/watchlists/Daily%20Watchlist");
  });
});

describe("fetchQuotes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("splits 320 symbols into 3 requests of at most 150 and merges in order", async () => {
    const symbols = Array.from({ length: 320 }, (_, i) => `S${i}`);
    const fetchMock = vi.fn(async (url: string) => {
      const syms = new URL(url, "http://x").searchParams.get("symbols")!.split(",");
      // Answer the later chunk first to prove order comes from the chunks, not arrival.
      if (syms[0] === "S0") await new Promise((r) => setTimeout(r, 10));
      return { ok: true, json: async () => syms.map((symbol) => ({ symbol }) as Quote) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchQuotes(symbols);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map(([u]) => new URL(u, "http://x").searchParams.get("symbols")!.split(",").length);
    expect(sizes).toEqual([150, 150, 20]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(QUOTE_CHUNK);
    expect(out.map((q) => q.symbol)).toEqual(symbols);
  });

  it("makes one request for a short list and none for an empty one", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchQuotes(["AAPL"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fetchQuotes([])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
