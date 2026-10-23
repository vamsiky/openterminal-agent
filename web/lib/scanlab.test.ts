import { describe, expect, it } from "vitest";
import {
  barWidth, buildFailure, changesLine, draftNotes, formatItem, formEdits, ideaTag, inputValue, inRange, isEdited, isStale,
  mergeFunnel, mergeSpread, nearMissRange, nearMissTitle, parseInput, rangeHint, seedText, usedKeys, versionStatus,
  type DefMeta, type FormItem, type FormSection, type ResultIdea,
} from "./scanlab";

const item = (over: Partial<FormItem> = {}): FormItem => ({ path: "listing.minScore", label: "Bar", value: 70, type: "number", min: 0, max: 100, step: 1, unit: "score_0_100", options: null, readOnly: false, note: null, ...over });
const weight = item({ path: "groupWeights.valuation", value: 0.2, min: 0, max: 1, unit: "weight" });
const idea = (symbol: string, strategy = "long_call", score = 70, rank = 1): ResultIdea => ({ symbol, strategy, score, rank });
const meta = (over: Partial<DefMeta> = {}): DefMeta => ({ id: 1, kind: "option", version: "option-v2", status: "draft", parentId: 0, author: "claude", sourceText: "hello", notes: null, createdAt: "2026-10-23T12:00:00Z", promotedAt: null, ...over });

describe("edited and stale detection", () => {
  it("ignores trailing whitespace and line-ending differences", () => {
    expect(isEdited("a\nb  \n", "a\r\nb")).toBe(false);
    expect(isEdited("a\nb!", "a\nb")).toBe(true);
  });
  it("a Claude draft is stale once the text moves off its source text", () => {
    expect(isStale("hello", meta())).toBe(false);
    expect(isStale("hello there", meta())).toBe(true);
  });
  it("form drafts, built-ins and no draft are never stale", () => {
    expect(isStale("anything", meta({ author: "form", sourceText: null }))).toBe(false);
    expect(isStale("anything", null)).toBe(false);
  });
  it("seeds from the open Claude draft's source text, else the active text", () => {
    expect(seedText("active", meta())).toBe("hello");
    expect(seedText("active", meta({ author: "form", sourceText: null }))).toBe("active");
    expect(seedText("active", null)).toBe("active");
  });
});

describe("bars", () => {
  it("scales to the maximum and never hides a non-zero count", () => {
    expect(barWidth(50, 100)).toBe(50);
    expect(barWidth(1, 431)).toBe(1.5);
    expect(barWidth(0, 431)).toBe(0);
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(500, 431)).toBe(100);
  });
  it("lines the funnels up by step, keeping a step only one side has", () => {
    const rows = mergeFunnel([{ step: "Scanned", count: 431 }, { step: "Listed", count: 2 }], [{ step: "Scanned", count: 431 }, { step: "Listed", count: 4 }, { step: "Near", count: 13 }]);
    expect(rows).toEqual([
      { step: "Scanned", live: 431, draft: 431 },
      { step: "Listed", live: 2, draft: 4 },
      { step: "Near", live: null, draft: 13 },
    ]);
  });
  it("lines the spread buckets up, counting a missing bucket as zero", () => {
    expect(mergeSpread([{ bucket: "70+", count: 3 }], [{ bucket: "70+", count: 3 }, { bucket: "65-70", count: 6 }])).toEqual([
      { bucket: "70+", live: 3, draft: 3 },
      { bucket: "65-70", live: 0, draft: 6 },
    ]);
  });
});

describe("compare", () => {
  it("tags new ideas and rank moves", () => {
    const added = [idea("D")];
    const moves = [{ symbol: "MU", strategy: "long_call", from: 2, to: 5 }, { symbol: "ESTC", strategy: "long_call", from: 9, to: 4 }];
    expect(ideaTag(idea("D"), added, moves)).toEqual({ text: "new", tone: "new" });
    expect(ideaTag(idea("MU"), added, moves)).toEqual({ text: "↓3", tone: "down" });
    expect(ideaTag(idea("ESTC"), added, moves)).toEqual({ text: "↑5", tone: "up" });
    expect(ideaTag(idea("BNC"), added, moves)).toEqual({ text: "", tone: "" });
  });
  it("sums up who comes in and drops out", () => {
    expect(changesLine([idea("IOT"), idea("TEM")], [idea("NVDA")])).toBe("In the draft's list: IOT, TEM come in; NVDA drops out.");
    expect(changesLine([], [])).toMatch(/same ideas/);
  });
  it("names the near-miss group and finds its range in a definition", () => {
    expect(nearMissTitle(13, 55, 65)).toBe("Near misses · scored 55 to 65 · 13");
    expect(nearMissRange({ listing: { nearMissFrom: 55, minScore: 65 } })).toEqual({ from: 55, to: 65 });
    expect(nearMissRange({ listing: { nearMissFrom: null, minScore: 70 } })).toBeNull();
    expect(nearMissRange(undefined)).toBeNull();
  });
});

describe("settings form", () => {
  it("shows weights as percent and everything else as plain numbers", () => {
    expect(formatItem(weight)).toBe("20%");
    expect(formatItem(item())).toBe("70");
    expect(formatItem(item({ value: null }))).toBe("off");
    expect(formatItem(item({ type: "boolean", value: true }))).toBe("yes");
    expect(inputValue(weight, 0.15)).toBe("15");
  });
  it("parses input back, in percent for weights, and null for an emptied nullable number", () => {
    expect(parseInput(weight, "15")).toBe(0.15);
    expect(parseInput(item(), " 65 ")).toBe(65);
    expect(parseInput(item(), "abc")).toBeUndefined();
    expect(parseInput(item({ path: "listing.nearMissFrom", value: 55 }), "")).toBeNull();
    expect(parseInput(item(), "")).toBeUndefined();
    expect(parseInput(item({ type: "boolean", value: false }), "true")).toBe(true);
  });
  it("checks bounds and describes them", () => {
    expect(inRange(item(), 101)).toBe(false);
    expect(inRange(item(), 100)).toBe(true);
    expect(rangeHint(item())).toBe("0 to 100");
    expect(rangeHint(weight)).toBe("0% to 100%");
  });
  it("sends only the edits that differ from the stored value, never read-only ones", () => {
    const form: FormSection[] = [{ section: "Listing", items: [item(), item({ path: "listing.maxIdeas", value: 20 }), item({ path: "x.contract", value: "atm", type: "text", readOnly: true })] }];
    expect(formEdits(form, { "listing.minScore": 65, "listing.maxIdeas": 20, "x.contract": "other" })).toEqual([{ path: "listing.minScore", value: 65 }]);
  });
});

describe("catalog use", () => {
  it("finds the catalog keys a definition names, however deep", () => {
    const def = { strategies: { long_call: { gates: [{ expr: { avg: ["m15", "h1"] }, op: ">=", value: 40 }], terms: [{ label: "iv_rank", expr: "d1" }] } } };
    expect([...usedKeys(def, ["m15", "h1", "d1", "atm_iv", "iv_rank"])].sort()).toEqual(["d1", "h1", "iv_rank", "m15"]);
  });
});

describe("builds and versions", () => {
  it("explains busy, budget and disabled in plain words", () => {
    expect(buildFailure(409, "x").kind).toBe("busy");
    expect(buildFailure(402, "x").message).toMatch(/budget/);
    expect(buildFailure(503, "x").message).toMatch(/turned off/);
    expect(buildFailure(500, "boom")).toEqual({ kind: "other", message: "boom" });
  });
  it("reads saved notes in either shape", () => {
    expect(draftNotes(meta({ notes: ["a", "b"] })).notes).toEqual(["a", "b"]);
    expect(draftNotes(meta({ notes: { notes: ["a"], needsCode: [{ request: "short interest", reason: "not in the catalog" }] } })).needsCode).toHaveLength(1);
    expect(draftNotes(meta({ notes: 5 }))).toEqual({ notes: [], needsCode: [] });
    expect(draftNotes(null)).toEqual({ notes: [], needsCode: [] });
  });
  it("words the version status", () => {
    const now = Date.parse("2026-10-23T18:00:00Z");
    expect(versionStatus(meta(), now)).toBe("Draft · built by Claude, today");
    expect(versionStatus(meta({ status: "active", author: "built-in" }), now)).toBe("Active · built-in settings");
    expect(versionStatus(meta({ status: "retired", author: "built-in", createdAt: "2026-10-21T12:00:00Z" }), now)).toBe("Retired 2 days ago · built-in settings");
  });
});
