import { describe, expect, it } from "vitest";
import { normalizeSymbol, symbolsParam } from "./symbol";

describe("normalizeSymbol", () => {
  it("uppercases and trims", () => {
    expect(normalizeSymbol("  aapl ")).toBe("AAPL");
  });
  it("accepts Yahoo-style tickers", () => {
    for (const s of ["BRK-B", "^GSPC", "0700.HK", "EURUSD=X", "GC=F", "M&M.NS", "BTC-USD"]) {
      expect(normalizeSymbol(s)).toBe(s);
    }
  });
  it("rejects junk", () => {
    for (const s of ["", "  ", "..", "A,B", "A B", "A/B", "A".repeat(21), "^", "é"]) {
      expect(normalizeSymbol(s)).toBeNull();
    }
  });
});

describe("symbolsParam", () => {
  it("encodes each symbol but keeps commas", () => {
    expect(symbolsParam(["AAPL", "^GSPC", "M&M.NS"])).toBe("AAPL,%5EGSPC,M%26M.NS");
    expect(symbolsParam([])).toBe("");
  });
});
