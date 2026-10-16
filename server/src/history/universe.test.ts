import { describe, expect, it } from "vitest";
import { parseNasdaq100, parseSp500Wikitext, parseSymbolDirectory } from "./universe.js";

describe("symbol directory parsing", () => {
  it("reads Nasdaq-listed symbols and skips test issues and the footer", () => {
    const text = [
      "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
      "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N",
      "QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N",
      "ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N",
      "File Creation Time: 1016202621:00|||||||",
    ].join("\n");
    expect(parseSymbolDirectory(text, "nasdaq")).toEqual([
      { symbol: "AAPL", name: "Apple Inc. - Common Stock", exchange: "Nasdaq", isEtf: false },
      { symbol: "QQQ", name: "Invesco QQQ Trust, Series 1", exchange: "Nasdaq", isEtf: true },
    ]);
  });

  it("reads other-listed symbols by ACT symbol and skips preferreds", () => {
    const text = [
      "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
      "BRK.B|Berkshire Hathaway Inc. Class B|N|BRK.B|N|100|N|BRK=B",
      "SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY",
      "BAC$K|Bank of America Pfd|N|BACpK|N|100|N|BAC-K",
    ].join("\r\n");
    expect(parseSymbolDirectory(text, "other")).toEqual([
      { symbol: "BRK.B", name: "Berkshire Hathaway Inc. Class B", exchange: "NYSE", isEtf: false },
      { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", exchange: "NYSE Arca", isEtf: true },
    ]);
  });

  it("rejects a file with an unexpected header", () => {
    expect(() => parseSymbolDirectory("<html>blocked</html>", "nasdaq")).toThrow(/unexpected header/);
  });
});

describe("index membership parsing", () => {
  it("takes S&P 500 tickers from the first wikitable only", () => {
    const wikitext = [
      "intro",
      '{| class="wikitable sortable" id="constituents"',
      "|-",
      "| {{NyseSymbol|MMM}} || [[3M]] || Industrials",
      "|-",
      "| {{NasdaqSymbol|AAPL}} || [[Apple Inc.]] || Information Technology",
      "|-",
      "|{{NyseSymbol|BRK.B}}",
      "|}",
      '{| class="wikitable" id="changes"',
      "| {{NyseSymbol|OLD}} || removed",
      "|}",
    ].join("\n");
    expect(parseSp500Wikitext(wikitext)).toEqual(["MMM", "AAPL", "BRK.B"]);
  });

  it("reads Nasdaq-100 rows", () => {
    expect(parseNasdaq100({ data: { data: { rows: [{ symbol: "aapl" }, { symbol: "MSFT" }, {}] } } })).toEqual(["AAPL", "MSFT"]);
  });
});
