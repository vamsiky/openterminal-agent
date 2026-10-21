import { describe, expect, it } from "vitest";
import { isForeignSymbol, normalizeSymbol, searchName, symbolsParam } from "./symbol";

describe("normalizeSymbol", () => {
  it("uppercases and trims", () => {
    expect(normalizeSymbol("  aapl ")).toBe("AAPL");
  });
  it("accepts tickers with dots, dashes, carets and equals signs", () => {
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

describe("searchName", () => {
  it("drops the listing-type suffix", () => {
    expect(searchName("Apple Inc. - Common Stock")).toBe("Apple Inc.");
    expect(searchName("Alphabet Inc. - Class A Common Stock")).toBe("Alphabet Inc.");
    expect(searchName("Bitcoin")).toBe("Bitcoin");
    expect(searchName(null)).toBe("");
  });
});

describe("isForeignSymbol", () => {
  it("flags numeric roots and exchange suffixes of two or more letters", () => {
    for (const s of ["0700.HK", "2330.TW", "7203.T", "005930.KS", "SHOP.TO", "ASML.AS", "SAP.DE", "NOVO-B.CO", "BHP.AX", "INFY.NS", "RY.TO", "BBD-B.TO"]) {
      expect(isForeignSymbol(s), s).toBe(true);
    }
  });
  it("leaves US symbols, share classes, crypto, indices and FX alone", () => {
    for (const s of ["AAPL", "TSM", "BRK.B", "BRK-B", "MKC.V", "BTC-USD", "^VIX", "EURUSD=X"]) {
      expect(isForeignSymbol(s), s).toBe(false);
    }
  });
});
