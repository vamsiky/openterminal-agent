import { describe, expect, it } from "vitest";
import type { OptionPosition } from "../scan/contracts.js";
import { buildOcc, pickStrike, selectContracts, type ExpiryStrikes } from "./selection.js";
import { parseOcc } from "../providers/alpaca-options.js";

const strikes = [95, 97.5, 100, 102.5, 105];
const chain = (...expiries: string[]): ExpiryStrikes[] => expiries.map((expiry) => ({ expiry, strikes }));
const held = (occ: string): OptionPosition => {
  const p = parseOcc(occ)!;
  return { kind: "option", occ, underlying: p.root, expiry: p.expiry, strike: p.strike, right: p.type, quantity: 1, cost: null, openedAt: null };
};

describe("buildOcc", () => {
  it("round-trips through parseOcc", () => {
    const occ = buildOcc("NVDA", "2026-11-02", "call", 215);
    expect(occ).toBe("NVDA261102C00215000");
    expect(parseOcc(occ)).toMatchObject({ root: "NVDA", expiry: "2026-11-02", type: "call", strike: 215 });
    expect(buildOcc("SPY", "2026-12-18", "put", 502.5)).toBe("SPY261218P00502500");
  });
});

describe("pickStrike", () => {
  it("takes the nearest strike", () => {
    expect(pickStrike(strikes, 101.2)).toBe(100);
    expect(pickStrike(strikes, 101.4)).toBe(102.5);
  });
  it("keeps the previous strike until another is nearer by more than 25% of the gap", () => {
    // Gap 2.5: best 102.5 must beat 100 by > 0.625.
    expect(pickStrike(strikes, 101.3, 100)).toBe(100); // 1.3 vs 1.2: nearer by 0.1
    expect(pickStrike(strikes, 101.9, 100)).toBe(102.5); // 1.9 vs 0.6: nearer by 1.3
    expect(pickStrike(strikes, 101.6, 100)).toBe(102.5); // 1.6 vs 0.9: 0.7 > 0.625 -> moves
  });
  it("is null with no strikes", () => {
    expect(pickStrike([], 100)).toBeNull();
  });
});

describe("selectContracts", () => {
  const base = { today: "2026-10-21", minDte: 7, cap: 1000 };
  const prices = new Map([["AAA", 100], ["BBB", 100], ["CCC", 100]]);

  it("streams a call and put on the nearest expiry at least minDte out", () => {
    const sel = selectContracts({ ...base, underlyings: ["AAA"], prices, chains: new Map([["AAA", chain("2026-10-23", "2026-10-30", "2026-11-20")]]), holdings: [] });
    expect(sel.contracts).toEqual(["AAA261030C00100000", "AAA261030P00100000"]);
    expect(sel.pairs.get("AAA")).toMatchObject({ expiry: "2026-10-30", strike: 100 });
  });

  it("puts held options first and dedupes them against the pair", () => {
    const h = held("AAA261030C00100000");
    const sel = selectContracts({ ...base, underlyings: ["AAA"], prices, chains: new Map([["AAA", chain("2026-10-30")]]), holdings: [h, held("ZZZ261120C00050000")] });
    expect(sel.contracts).toEqual(["AAA261030C00100000", "ZZZ261120C00050000", "AAA261030P00100000"]);
  });

  it("drops the lowest-priority underlyings at the cap, holdings first", () => {
    const chains = new Map(["AAA", "BBB", "CCC"].map((u) => [u, chain("2026-10-30")]));
    const sel = selectContracts({
      ...base, cap: 3, underlyings: ["AAA", "BBB", "CCC"], prices, chains,
      holdings: [held("ZZZ261120C00050000"), held("YYY261120C00050000")],
    });
    // Two holdings leave room for one more contract: no pair fits.
    expect(sel.contracts).toEqual(["ZZZ261120C00050000", "YYY261120C00050000"]);
    expect(sel.skipped).toEqual(["AAA", "BBB", "CCC"]);
    const roomy = selectContracts({ ...base, cap: 4, underlyings: ["AAA", "BBB", "CCC"], prices, chains, holdings: [held("ZZZ261120C00050000")] });
    expect(roomy.contracts).toHaveLength(3);
    expect(roomy.skipped).toEqual(["BBB", "CCC"]);
  });

  it("keeps the first holdings when they alone exceed the cap", () => {
    const sel = selectContracts({
      ...base, cap: 2, underlyings: ["AAA"], prices, chains: new Map([["AAA", chain("2026-10-30")]]),
      holdings: [held("ZZZ261120C00050000"), held("YYY261120C00050000"), held("XXX261120C00050000")],
    });
    expect(sel.contracts).toEqual(["ZZZ261120C00050000", "YYY261120C00050000"]);
    expect(sel.heldDropped).toBe(1);
  });

  it("applies hysteresis against the previous pair", () => {
    const chains = new Map([["AAA", chain("2026-10-30")]]);
    const first = selectContracts({ ...base, underlyings: ["AAA"], prices: new Map([["AAA", 100.2]]), chains, holdings: [] });
    const next = selectContracts({ ...base, underlyings: ["AAA"], prices: new Map([["AAA", 101.3]]), chains, holdings: [], previous: first.pairs });
    expect(next.pairs.get("AAA")?.strike).toBe(100);
    const far = selectContracts({ ...base, underlyings: ["AAA"], prices: new Map([["AAA", 102.4]]), chains, holdings: [], previous: first.pairs });
    expect(far.pairs.get("AAA")?.strike).toBe(102.5);
  });

  it("skips underlyings without a price or a usable expiry", () => {
    const sel = selectContracts({ ...base, underlyings: ["AAA", "BBB"], prices: new Map([["AAA", 100]]), chains: new Map([["AAA", chain("2026-10-22")], ["BBB", chain("2026-10-30")]]), holdings: [] });
    expect(sel.contracts).toEqual([]);
  });
});
