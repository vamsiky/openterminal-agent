import { describe, expect, it } from "vitest";
import { guardrail, type GuardrailInput } from "./guardrail.js";

// The guardrail's boundaries. The judge can't waive these, so each boundary is tested on its own.

const DAY = "2026-10-21";
const act = (over: Partial<GuardrailInput> = {}): GuardrailInput => ({
  verdict: "act",
  strategy: "buy",
  invalidation: { price: 80, condition: "" },
  catalysts: [{ date: "2026-12-17", event: "earnings" }],
  ...over,
});

describe("invalidation", () => {
  it("accepts a price alone, or a condition alone", () => {
    expect(guardrail(act({ invalidation: { price: 80, condition: "" } }), DAY)).toBeNull();
    expect(guardrail(act({ invalidation: { price: null, condition: "guidance cut" } }), DAY)).toBeNull();
  });

  it("rejects no price and a blank or whitespace condition", () => {
    expect(guardrail(act({ invalidation: { price: null, condition: "   " } }), DAY)).toMatch(/invalidation/);
    expect(guardrail(act({ invalidation: null }), DAY)).toMatch(/invalidation/);
  });

  it("accepts a price of zero, which is a value, not a missing one", () => {
    expect(guardrail(act({ invalidation: { price: 0, condition: "" } }), DAY)).toBeNull();
  });
});

describe("catalysts", () => {
  it("accepts a catalyst on the thesis day, and an ISO timestamp on that day", () => {
    expect(guardrail(act({ catalysts: [{ date: DAY, event: "CPI" }] }), DAY)).toBeNull();
    expect(guardrail(act({ catalysts: [{ date: "2026-10-21T16:00:00Z", event: "fed" }] }), DAY)).toBeNull();
  });

  it("rejects a catalyst dated the day before, and one with no date", () => {
    expect(guardrail(act({ catalysts: [{ date: "2026-10-20", event: "earnings" }] }), DAY)).toMatch(/dated catalyst/);
    expect(guardrail(act({ catalysts: [{ date: null, event: "earnings" }] }), DAY)).toMatch(/dated catalyst/);
  });

  it("needs only one good catalyst among several", () => {
    expect(guardrail(act({ catalysts: [{ date: "2026-09-01", event: "old" }, { date: "2026-11-05", event: "earnings" }] }), DAY)).toBeNull();
  });

  it("rejects a catalyst whose date is not a date", () => {
    expect(guardrail(act({ catalysts: [{ date: "next Tuesday", event: "earnings" }] }), DAY)).toMatch(/dated catalyst/);
  });
});

describe("covered calls and shares held", () => {
  const cc = (sharesHeld?: number) => guardrail({ ...act({ strategy: "covered_call" }) }, DAY, sharesHeld === undefined ? {} : { sharesHeld });
  it("needs exactly 100 shares, not 99", () => {
    expect(cc(99)).toMatch(/100 shares/);
    expect(cc(100)).toBeNull();
  });

  it("treats no share count as no shares", () => {
    expect(cc()).toMatch(/100 shares/);
  });

  it("does not ask for shares on a short put", () => {
    expect(guardrail(act({ strategy: "short_put" }), DAY)).toBeNull();
  });
});

describe("verdicts other than act", () => {
  const bare = { invalidation: null, catalysts: [], strategy: "covered_call" as const };
  it("never rejects wait or pass, however incomplete", () => {
    expect(guardrail({ ...bare, verdict: "wait" }, DAY, { sharesHeld: 0 })).toBeNull();
    expect(guardrail({ ...bare, verdict: "pass" }, DAY, { sharesHeld: 0 })).toBeNull();
  });
});
