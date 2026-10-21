import { describe, expect, it } from "vitest";
import { EXTENDED_SESSIONS, fmt, fmtBig, fmtChange, fmtPct, pctClass } from "./api";

describe("fmt", () => {
  it("formats with two decimals and thousands separators", () => {
    expect(fmt(1234.5)).toBe("1,234.50");
    expect(fmt(0)).toBe("0.00");
    expect(fmt(3.14159, 3)).toBe("3.142");
  });
  it("shows a dash for missing or non-finite values", () => {
    for (const v of [null, undefined, NaN, Infinity]) expect(fmt(v)).toBe("—");
  });
});

describe("fmtChange / fmtPct", () => {
  it("signs positives only", () => {
    expect(fmtChange(4.53, 2.09)).toBe("+4.53 (+2.09%)");
    expect(fmtChange(-1.2, -0.5)).toBe("-1.20 (-0.50%)");
    expect(fmtChange(0, 0)).toBe("0.00 (0.00%)");
  });
  it("handles nulls", () => {
    expect(fmtChange(null, undefined)).toBe("— (—%)");
    expect(fmtPct(null)).toBe("—%");
  });
  it("fmtPct", () => {
    expect(fmtPct(1.5)).toBe("+1.50%");
    expect(fmtPct(-1.5)).toBe("-1.50%");
  });
});

describe("fmtBig", () => {
  it("picks the unit", () => {
    expect(fmtBig(2.5e12)).toBe("2.50T");
    expect(fmtBig(3e9)).toBe("3.00B");
    expect(fmtBig(4.2e6)).toBe("4.20M");
    expect(fmtBig(1500)).toBe("1.5K");
    expect(fmtBig(999)).toBe("999");
    expect(fmtBig(-2e9)).toBe("-2.00B");
  });
  it("dashes missing values", () => {
    expect(fmtBig(null)).toBe("—");
    expect(fmtBig(undefined)).toBe("—");
    expect(fmtBig(NaN)).toBe("—");
  });
});

describe("pctClass", () => {
  it("maps sign to class", () => {
    expect(pctClass(1)).toBe("up");
    expect(pctClass(0)).toBe("up");
    expect(pctClass(-0.1)).toBe("down");
    expect(pctClass(null)).toBe("dim");
    expect(pctClass(undefined)).toBe("dim");
  });
});

describe("EXTENDED_SESSIONS", () => {
  it("is in trading order", () => {
    expect(EXTENDED_SESSIONS.map((s) => s.key)).toEqual(["post", "overnight", "pre"]);
  });
});
