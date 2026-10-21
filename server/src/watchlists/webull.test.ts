import { describe, expect, it } from "vitest";
import { appSymbol, parseWebullCsv } from "./webull.js";

describe("appSymbol", () => {
  it("maps crypto and the VIX index to the app's symbols", () => {
    expect(appSymbol("btc", "CCC")).toBe("BTC-USD");
    expect(appSymbol("VIX", "CBOE")).toBe("^VIX");
    expect(appSymbol("VIX", "NYSE")).toBe("VIX");
    expect(appSymbol("brk.b", "NYSE")).toBe("BRK.B");
  });
});

describe("parseWebullCsv", () => {
  it("finds columns by header, in any order", () => {
    const csv = "Symbol,Watchlist,Exchange\nbtc,Crypto,CCC\nAAPL,Crypto,NASDAQ\n";
    expect(parseWebullCsv(csv)).toEqual([{ name: "Crypto", symbols: ["BTC-USD", "AAPL"] }]);
  });

  it("works without an Exchange column, leaving symbols unmapped", () => {
    expect(parseWebullCsv("Watchlist,Symbol\nA,btc\n")).toEqual([{ name: "A", symbols: ["BTC"] }]);
  });

  it("handles escaped quotes, CRLF and trailing blank lines", () => {
    const csv = 'Watchlist,#,Symbol,Name,Exchange\r\nA,1,X,"Say ""hi"", Inc.",NYSE\r\nA,2,Y,Why,NYSE\r\n\r\n\r\n';
    expect(parseWebullCsv(csv)).toEqual([{ name: "A", symbols: ["X", "Y"] }]);
  });

  it("keeps a duplicate symbol once and collapses runs of spaces in names", () => {
    const csv = "Watchlist,Symbol\nDaily   Watchlist,AAPL\nDaily Watchlist,aapl\nDaily Watchlist,MSFT\n";
    expect(parseWebullCsv(csv)).toEqual([{ name: "Daily Watchlist", symbols: ["AAPL", "MSFT"] }]);
  });

  it("skips rows missing a name or symbol", () => {
    expect(parseWebullCsv("Watchlist,Symbol\n,AAPL\nA,\nA,MSFT\n")).toEqual([{ name: "A", symbols: ["MSFT"] }]);
  });

  it("throws for empty text", () => {
    expect(() => parseWebullCsv("")).toThrow(/Webull/);
  });
});
