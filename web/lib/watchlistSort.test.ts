import { describe, expect, it } from "vitest";
import type { Quote } from "./api";
import { latestSession, sortSymbols } from "./watchlistSort";

const q = (symbol: string, price: number | null, changePercent: number | null) => [symbol, { symbol, price, changePercent } as Quote] as const;
const quotes = new Map([q("AAA", 10, -2), q("BBB", 30, 5), q("CCC", 20, null)]);
const syms = ["CCC", "AAA", "BBB", "ZZZ"];

describe("sortSymbols", () => {
  it("keeps list order by default", () => expect(sortSymbols(syms, quotes, "default")).toEqual(syms));
  it("sorts by percent change with unquoted and null last", () => {
    expect(sortSymbols(syms, quotes, "chgDesc")).toEqual(["BBB", "AAA", "CCC", "ZZZ"]);
    expect(sortSymbols(syms, quotes, "chgAsc")).toEqual(["AAA", "BBB", "CCC", "ZZZ"]);
  });
  it("sorts by price and symbol", () => {
    expect(sortSymbols(syms, quotes, "priceDesc")).toEqual(["BBB", "CCC", "AAA", "ZZZ"]);
    expect(sortSymbols(syms, quotes, "symAsc")).toEqual(["AAA", "BBB", "CCC", "ZZZ"]);
  });
});

describe("latestSession", () => {
  const s = (price: number, time: string) => ({ price, change: 0, changePercent: 1, time, live: false });
  it("picks the session that traded last", () => {
    const ext = { post: s(1, "2026-10-22T21:00:00Z"), overnight: s(2, "2026-10-23T01:00:00Z"), pre: null };
    expect(latestSession(ext)).toMatchObject({ label: "Night", price: 2 });
    expect(latestSession({ post: null, overnight: null, pre: null })).toBeNull();
    expect(latestSession(undefined)).toBeNull();
  });
});
