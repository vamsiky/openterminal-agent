import { afterEach, describe, expect, it, vi } from "vitest";
import * as stooq from "./stooq.js";

afterEach(() => vi.unstubAllGlobals());

const csvQuote = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-10-20,22:00:00,1,2,0.5,1.5,100\n";

describe("stooq symbols", () => {
  it("never receives a dotted symbol", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => csvQuote }));
    vi.stubGlobal("fetch", fetchMock);
    for (const s of ["VOD.L", "SHOP.TO", "0700.HK", "SAP.DE", "BRK.B"]) {
      await expect(stooq.quote(s)).rejects.toThrow(/US-listed/);
      await expect(stooq.history(s)).rejects.toThrow(/US-listed/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps plain US tickers and dashed share classes to .us", async () => {
    const fetchMock = vi.fn(async (...args: [string]) => ({ ok: true, text: async () => csvQuote, args }));
    vi.stubGlobal("fetch", fetchMock);
    for (const s of ["AAPL", "BRK-B"]) await stooq.quote(s);
    const sent = fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("s"));
    expect(sent).toEqual(["aapl.us", "brk-b.us"]);
  });
});
