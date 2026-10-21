import { describe, expect, it } from "vitest";
import type { OptionPosition } from "../scan/contracts.js";
import { HYSTERESIS, pickStrike, selectContracts, type ExpiryStrikes, type Pair } from "./selection.js";

const TODAY = "2026-10-21";
const chain = (...exp: ExpiryStrikes[]) => exp;
const oneExpiry = (expiry: string, strikes: number[]) => chain({ expiry, strikes });
const held = (occ: string, underlying: string): OptionPosition => ({
  kind: "option", occ, underlying, expiry: "2026-11-20", strike: 100, right: "call", quantity: 1, cost: null, openedAt: null,
});

describe("re-centring hysteresis, at the boundary", () => {
  it("HYSTERESIS is a quarter of the strike gap", () => {
    expect(HYSTERESIS).toBe(0.25);
  });

  it("keeps the previous strike when the better one is nearer by exactly 25% of the gap", () => {
    // Strikes 100 and 110 (gap 10). At 103.75 the 100 strike is 3.75 away, the 110 is 6.25 away: 2.5 nearer, exactly 25%.
    expect(pickStrike([100, 110, 120], 103.75, 110)).toBe(110);
  });

  it("re-centres once the better strike is nearer by more than 25% of the gap", () => {
    // 103.7: 100 is 3.7 away, 110 is 6.3 away: 2.6 nearer, more than 2.5.
    expect(pickStrike([100, 110, 120], 103.7, 110)).toBe(100);
  });

  it("uses the gap on the side of the best strike, so an uneven ladder is judged locally", () => {
    // Strikes 100, 105, 150: near 100 the gap to the next strike is 5, so 25% is 1.25. At 101.5 the best is 100 (1.5 away),
    // the previous 105 is 3.5 away: 2 nearer, more than 1.25, so it re-centres.
    expect(pickStrike([100, 105, 150], 101.5, 105)).toBe(100);
  });

  it("drops a previous strike that is no longer listed", () => {
    expect(pickStrike([100, 110], 107, 95)).toBe(110);
  });
});

describe("minimum days to expiry", () => {
  const input = (expiries: ExpiryStrikes[]) => ({
    underlyings: ["AAA"],
    prices: new Map([["AAA", 100]]),
    chains: new Map([["AAA", expiries]]),
    holdings: [],
    cap: 1000,
    minDte: 7,
    today: TODAY,
  });

  it("accepts an expiry exactly minDte days out", () => {
    const sel = selectContracts(input(oneExpiry("2026-10-28", [100])));
    expect(sel.pairs.get("AAA")!.expiry).toBe("2026-10-28");
    expect(sel.contracts).toEqual(["AAA261028C00100000", "AAA261028P00100000"]);
  });

  it("skips an expiry one day short and takes the next usable one", () => {
    const sel = selectContracts(input(chain({ expiry: "2026-10-27", strikes: [100] }, { expiry: "2026-11-06", strikes: [100] })));
    expect(sel.pairs.get("AAA")!.expiry).toBe("2026-11-06");
  });

  it("streams nothing for an underlying whose every expiry is too near, and does not count it as skipped", () => {
    const sel = selectContracts(input(oneExpiry("2026-10-22", [100])));
    expect(sel.contracts).toEqual([]);
    expect(sel.pairs.size).toBe(0);
    expect(sel.skipped).toEqual([]);
  });

  it("ignores expiries that have no strikes", () => {
    const sel = selectContracts(input(chain({ expiry: "2026-10-28", strikes: [] }, { expiry: "2026-11-06", strikes: [100] })));
    expect(sel.pairs.get("AAA")!.expiry).toBe("2026-11-06");
  });
});

describe("underlyings with no expiries", () => {
  it("is left out with no contracts, and the others still get their pairs", () => {
    const sel = selectContracts({
      underlyings: ["NOEXP", "AAA"],
      prices: new Map([["NOEXP", 50], ["AAA", 100]]),
      chains: new Map([["NOEXP", []], ["AAA", oneExpiry("2026-11-20", [100])]]),
      holdings: [],
      cap: 1000,
      minDte: 7,
      today: TODAY,
    });
    expect([...sel.pairs.keys()]).toEqual(["AAA"]);
    expect(sel.contracts.every((c) => c.startsWith("AAA"))).toBe(true);
  });
});

describe("cap", () => {
  const three = (cap: number, holdings: OptionPosition[] = []) =>
    selectContracts({
      underlyings: ["AAA", "BBB", "CCC"],
      prices: new Map([["AAA", 100], ["BBB", 100], ["CCC", 100]]),
      chains: new Map([
        ["AAA", oneExpiry("2026-11-20", [100])],
        ["BBB", oneExpiry("2026-11-20", [100])],
        ["CCC", oneExpiry("2026-11-20", [100])],
      ]),
      holdings,
      cap,
      minDte: 7,
      today: TODAY,
    });

  it("fills exactly to the cap and skips the first underlying that would overflow it", () => {
    const sel = three(5);
    expect(sel.contracts).toHaveLength(4);
    expect(sel.skipped).toEqual(["CCC"]);
    expect(sel.pairs.has("CCC")).toBe(false);
  });

  it("takes all three pairs at a cap of six", () => {
    const sel = three(6);
    expect(sel.contracts).toHaveLength(6);
    expect(sel.skipped).toEqual([]);
  });

  it("counts held options against the cap before any pair", () => {
    const sel = three(5, [held("HOLD261120C00100000", "HOLD")]);
    expect(sel.contracts[0]).toBe("HOLD261120C00100000");
    expect(sel.contracts).toHaveLength(5);
    expect(sel.skipped).toEqual(["CCC"]);
  });

  it("does not double-count a held option that is already a pair contract", () => {
    const sel = three(4, [held("AAA261120C00100000", "AAA")]);
    expect(sel.heldDropped).toBe(0);
    expect(sel.contracts).toHaveLength(4); // the held call is AAA's call, so AAA needs only one more contract
    expect(sel.pairs.has("AAA")).toBe(true);
    expect(sel.skipped).toEqual(["CCC"]);
  });

  it("drops held options beyond the cap and reports how many", () => {
    const hs = [held("HOLD1261120C00100000", "HOLD1"), held("HOLD2261120C00100000", "HOLD2"), held("HOLD3261120C00100000", "HOLD3")];
    const sel = three(2, hs);
    expect(sel.contracts).toEqual(["HOLD1261120C00100000", "HOLD2261120C00100000"]);
    expect(sel.heldDropped).toBe(1);
    expect(sel.pairs.size).toBe(0);
  });
});

describe("hysteresis across a selection", () => {
  it("keeps the previous pair when the expiry is unchanged and the strike is only slightly nearer, and resets it on a new expiry", () => {
    const previous = new Map<string, Pair>([["AAA", { expiry: "2026-11-20", strike: 110, call: "x", put: "y" }]]);
    const base = {
      underlyings: ["AAA"],
      prices: new Map([["AAA", 103.7]]),
      holdings: [],
      cap: 1000,
      minDte: 7,
      today: TODAY,
    };
    const kept = selectContracts({ ...base, chains: new Map([["AAA", oneExpiry("2026-11-20", [100, 110, 120])]]), previous });
    expect(kept.pairs.get("AAA")!.strike).toBe(100); // 2.6 nearer, so it re-centres
    const sticky = selectContracts({ ...base, prices: new Map([["AAA", 108.5]]), chains: new Map([["AAA", oneExpiry("2026-11-20", [100, 110, 120])]]), previous });
    expect(sticky.pairs.get("AAA")!.strike).toBe(110); // 110 is nearer by 1.5, which is under 2.5, so the old strike stays
    const newExpiry = selectContracts({ ...base, prices: new Map([["AAA", 108.5]]), chains: new Map([["AAA", oneExpiry("2026-12-18", [100, 110, 120])]]), previous });
    expect(newExpiry.pairs.get("AAA")!.strike).toBe(110); // nearest, since the previous pair was on another expiry
  });
});
