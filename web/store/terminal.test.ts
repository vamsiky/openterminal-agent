import { beforeEach, describe, expect, it } from "vitest";
import { useTerminal } from "./terminal";

const reset = () =>
  useTerminal.setState({
    watchlists: [{ name: "default", symbols: ["AAPL", "MSFT"] }],
    activeWatchlist: "default",
    watchlist: ["AAPL", "MSFT"],
  });

describe("watchlist actions", () => {
  beforeEach(reset);
  const s = () => useTerminal.getState();

  it("addToWatchlist normalizes, dedupes and ignores invalid symbols", () => {
    s().addToWatchlist(" nvda ");
    s().addToWatchlist("NVDA");
    s().addToWatchlist("bad symbol");
    expect(s().watchlist).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(s().watchlists[0].symbols).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("removeFromWatchlist edits only the active list", () => {
    s().createWatchlist("Other");
    s().addToWatchlist("TSLA");
    s().removeFromWatchlist("TSLA");
    expect(s().watchlist).toEqual([]);
    expect(s().watchlists.find((l) => l.name === "default")!.symbols).toEqual(["AAPL", "MSFT"]);
  });

  it("createWatchlist switches to the new list; an existing name just switches", () => {
    s().createWatchlist("Tech");
    expect(s().activeWatchlist).toBe("Tech");
    expect(s().watchlist).toEqual([]);
    s().createWatchlist("default");
    expect(s().activeWatchlist).toBe("default");
    expect(s().watchlists).toHaveLength(2);
  });

  it("setActiveWatchlist keeps `watchlist` in step; unknown name falls back to the first", () => {
    s().createWatchlist("Tech");
    s().setActiveWatchlist("default");
    expect(s().watchlist).toEqual(["AAPL", "MSFT"]);
    s().setActiveWatchlist("nope");
    expect(s().activeWatchlist).toBe("default");
  });

  it("deleteWatchlist falls back to another list, or an empty default when none remain", () => {
    s().createWatchlist("Tech");
    s().deleteWatchlist("Tech");
    expect(s().activeWatchlist).toBe("default");
    s().deleteWatchlist("default");
    expect(s().watchlists).toEqual([{ name: "default", symbols: [] }]);
    expect(s().watchlist).toEqual([]);
  });

  it("setWatchlists replaces all lists and keeps the active one when it still exists", () => {
    s().setWatchlists([
      { name: "A", symbols: ["X"] },
      { name: "default", symbols: ["Y"] },
    ]);
    expect(s().activeWatchlist).toBe("default");
    expect(s().watchlist).toEqual(["Y"]);
    s().setWatchlists([{ name: "A", symbols: ["X"] }]);
    expect(s().activeWatchlist).toBe("A");
  });
});

describe("persist migrate", () => {
  const migrate = (persisted: unknown, version: number) =>
    useTerminal.persist.getOptions().migrate!(persisted, version) as any;

  it("version 0 single list becomes the default list", () => {
    const out = migrate({ watchlist: ["AAPL", "IBM"], activeSymbol: "IBM" }, 0);
    expect(out.watchlists).toEqual([{ name: "default", symbols: ["AAPL", "IBM"] }]);
    expect(out.activeWatchlist).toBe("default");
    expect(out.watchlist).toEqual(["AAPL", "IBM"]);
    expect(out.activeSymbol).toBe("IBM");
  });

  it("version 1 state passes through, and null state is tolerated", () => {
    const st = { watchlists: [{ name: "A", symbols: [] }], watchlist: [] };
    expect(migrate(st, 1)).toEqual(st);
    expect(migrate(null, 0)).toEqual({});
  });
});
