import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionMetrics } from "../scan/contracts.js";

let tmpDir: string;
let sd: typeof import("./index.js");
let ideas: typeof import("../quant/ideas.js");
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scandef-core-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  sd = await import("./index.js");
  ideas = await import("../quant/ideas.js");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const clone = <T,>(x: T): T => structuredClone(x);

describe("catalog", () => {
  it("lists the stock factors raw and as scores, and the option inputs, with unique keys per scope", () => {
    const stock = sd.catalog("stock");
    const option = sd.catalog("option");
    expect(stock.length).toBe(26 * 2 + 3 * 2 + 6 + 2 + 3);
    for (const scope of [stock, option]) expect(new Set(scope.map((f) => f.key)).size).toBe(scope.length);
    expect(stock.find((f) => f.key === "pe")).toMatchObject({ scope: "stock", unit: "x", group: "valuation" });
    expect(stock.find((f) => f.key === "pe_score")?.unit).toBe("score_0_100");
    expect(option.map((f) => f.key)).toEqual(expect.arrayContaining(["m5", "m15", "h1", "d1", "iv_rank", "hv20", "rel_volume", "vwap_atr_distance", "day_move_vs_usual", "earnings_before_expiry", "shares_held", "atm_call_spread_pct"]));
    for (const f of sd.CATALOG) expect(f.description.length).toBeGreaterThan(5);
  });
});

describe("interpreter", () => {
  const ctx = { a: 10, b: 4, zero: 0, none: null, day: "2026-11-05" };
  it("evaluates every expression form, with null in meaning null out", () => {
    const e = (x: import("./dsl.js").Expr) => sd.evalExpr(x, ctx);
    expect(e({ avg: ["a", "b"] })).toBe(7);
    expect(e({ min: ["a", "b"] })).toBe(4);
    expect(e({ max: ["a", "b"] })).toBe(10);
    expect(e({ sum: ["a", "b", 1] })).toBe(15);
    expect(e({ diff: ["a", "b"] })).toBe(6);
    expect(e({ ratio: ["a", "b"] })).toBe(2.5);
    expect(e({ ratio: ["a", "zero"] })).toBeNull();
    expect(e({ avg: ["a", "none"] })).toBeNull();
    expect(e("day")).toBeNull(); // dates are not numbers
    expect(e({ scale: { expr: "a", from: 0, to: 20 } })).toBe(0.5);
    expect(e({ scale: { expr: "a", from: 20, to: 0 } })).toBe(0.5); // lower is better
    expect(e({ scale: { expr: 50, from: 0, to: 20 } })).toBe(1);
    expect(e({ if: { cond: { expr: "a", op: ">", value: 5 }, then: 1, else: 2 } })).toBe(1);
    expect(e({ if: { cond: { expr: "a", op: "<", value: 5 }, then: 1 } })).toBeNull();
    expect(e({ coalesce: ["none", "b", "a"] })).toBe(4);
  });

  it("evaluates conditions; a comparison on null is false", () => {
    const c = (x: import("./dsl.js").Cond) => sd.evalCond(x, ctx);
    expect(c({ expr: "a", op: ">=", value: 10 })).toBe(true);
    expect(c({ expr: "a", op: "==", value: 10 })).toBe(true);
    expect(c({ expr: "a", op: "!=", value: 10 })).toBe(false);
    expect(c({ expr: "none", op: ">=", value: -999 })).toBe(false);
    expect(c({ expr: "none", op: "!=", value: 3 })).toBe(false);
    expect(c({ expr: "a", op: "between", min: 5, max: 10 })).toBe(true);
    expect(c({ known: "none" })).toBe(false);
    expect(c({ known: "day" })).toBe(true);
    expect(c({ all: [{ known: "a" }, { not: { known: "none" } }] })).toBe(true);
    expect(c({ any: [{ known: "none" }, { expr: "b", op: "<", value: 5 }] })).toBe(true);
    expect(c({ not: { expr: "none", op: ">", value: 0 } })).toBe(true);
  });
});

describe("validation", () => {
  it("accepts the built-ins", () => {
    expect(sd.parseDefinition(sd.OPTION_V1_DEF).ok).toBe(true);
    expect(sd.parseDefinition(sd.STOCK_V2_DEF).ok).toBe(true);
  });

  it("rejects unknown catalog keys, wrong scope, non-numeric fields and bad placeholders", () => {
    const d = clone(sd.OPTION_V1_DEF);
    d.strategies.long_call.gates[0] = { label: "x", expr: "pe", op: ">=", value: 1 };
    let r = sd.parseDefinition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/"pe" is not a option field/);

    const e = clone(sd.OPTION_V1_DEF);
    e.strategies.long_call.gates[0] = { label: "x", expr: "atm_expiry", op: ">=", value: 1 };
    r = sd.parseDefinition(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/not a number/);

    const f = clone(sd.OPTION_V1_DEF);
    f.strategies.long_call.gates[2].say = "daily {nope:int}";
    r = sd.parseDefinition(f);
    expect(r.ok).toBe(false);
  });

  it("enforces bounds, unknown fields and the fixed strategy rules", () => {
    const d = clone(sd.OPTION_V1_DEF);
    d.listing.minScore = 120;
    expect(sd.parseDefinition(d).ok).toBe(false);
    const extra = { ...clone(sd.OPTION_V1_DEF), strategies: { ...clone(sd.OPTION_V1_DEF).strategies, long_put: {} } };
    expect(sd.parseDefinition(extra).ok).toBe(false); // there is no way to express a long put
    const noShares = clone(sd.OPTION_V1_DEF);
    noShares.strategies.covered_call.gates = noShares.strategies.covered_call.gates.slice(1);
    const r = sd.parseDefinition(noShares);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/shares_held of 100/);
    const wrongContract = clone(sd.OPTION_V1_DEF);
    wrongContract.strategies.short_put.contract = "atm_call";
    expect(sd.parseDefinition(wrongContract).ok).toBe(false);
    const nm = clone(sd.OPTION_V1_DEF);
    nm.listing.nearMissFrom = 70;
    expect(sd.parseDefinition(nm).ok).toBe(false);
    nm.listing.nearMissFrom = 65;
    expect(sd.parseDefinition(nm).ok).toBe(true);
  });

  it("checks stock weights, factor lists and filters", () => {
    const d = clone(sd.STOCK_V2_DEF);
    d.groupWeights.valuation = 0.3;
    let r = sd.parseDefinition(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/sum to 1/);
    const e = clone(sd.STOCK_V2_DEF);
    e.factors = e.factors.slice(1);
    expect(sd.parseDefinition(e).ok).toBe(false);
    const f = clone(sd.STOCK_V2_DEF);
    f.filters = [{ label: "Price over 10", expr: "price", op: ">=", value: 10 }];
    expect(sd.parseDefinition(f).ok).toBe(true);
    f.filters = [{ label: "Bad", expr: "iv_rank", op: ">=", value: 10 }];
    r = sd.parseDefinition(f);
    expect(r.ok).toBe(false);
  });
});

describe("text", () => {
  it("renders the same text for the same definition, with the mock's sections", () => {
    const text = sd.render(sd.OPTION_V1_DEF);
    expect(sd.render(clone(sd.OPTION_V1_DEF))).toBe(text);
    for (const heading of ["OPTIONS SCAN · option-v1", "LISTING", "BUY A CALL", "SELL A CASH-SECURED PUT", "SELL A COVERED CALL"]) expect(text).toContain(heading);
    expect(text).toContain("- List a setup when it scores 70 or more.");
    expect(text).toContain("- While a name has under 20 days of IV history, list it from 60.");
    expect(text).toContain("- Near misses: not shown.");
    expect(text).toContain("Never buy puts, spreads or naked calls");
    expect(text).toContain("every 5 minutes");
    const stock = sd.render(sd.STOCK_V2_DEF);
    for (const heading of ["STOCK SCAN · stock-v2", "FACTORS", "WEIGHTS", "LISTING"]) expect(stock).toContain(heading);
    expect(stock).not.toContain("FILTERS");
    expect(stock).toContain("07:00 and 16:30 ET");
    expect(stock).not.toContain("18:00");
    expect(stock).toContain("- Valuation 20%");
  });

  it("follows the values: a changed number, a near-miss bar and a filter appear in the text", () => {
    const d = clone(sd.OPTION_V1_DEF);
    d.listing.minScore = 75;
    d.listing.nearMissFrom = 68;
    d.strategies.long_call.gates[2].value = 30;
    const text = sd.render(d);
    expect(text).toContain("scores 75 or more");
    expect(text).toContain("scoring 68 or more");
    expect(text).toContain("daily trend is at least 30");
    const s = clone(sd.STOCK_V2_DEF);
    s.filters = [{ label: "Priced over 10", expr: "price", op: ">=", value: 10 }];
    expect(sd.render(s)).toContain("FILTERS\n- Priced over 10: price is at least $10.");
  });
});

describe("form and diff", () => {
  it("covers every number and switch, including terms and penalties added later", () => {
    const d = clone(sd.OPTION_V1_DEF);
    const before = sd.formOf(d).flatMap((s) => s.items).length;
    d.strategies.short_put.terms.push({ label: "Tight spread", expr: { scale: { expr: "atm_put_spread_pct", from: 10, to: 2 } }, points: 5 });
    d.strategies.short_put.penalties.push({ label: "Wide spread", cond: { expr: "atm_put_spread_pct", op: ">", value: 15 }, points: 4 });
    const form = sd.formOf(d);
    const items = form.flatMap((s) => s.items);
    expect(items.length).toBe(before + 3 + 2); // points, from, to; points, threshold
    expect(items.find((i) => i.label === "Tight spread: points")).toMatchObject({ value: 5, min: -100, max: 100 });
    expect(items.find((i) => i.label === "Tight spread: none at")).toMatchObject({ value: 10 });
    expect(items.find((i) => i.label === "Wide spread: points off")).toMatchObject({ value: 4 });
    expect(items.find((i) => i.label.startsWith("Wide spread") && i.label.endsWith("above"))).toMatchObject({ value: 15 });
    // Every numeric or boolean leaf of the scoring JSON (not the wording variants) is a form item.
    let leafCount = 0;
    const walk = (x: unknown) => {
      if (typeof x === "number" || typeof x === "boolean") leafCount++;
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) if (k !== "say" && k !== "sayElse") walk(v);
    };
    walk(d.strategies);
    walk({ ...d.listing, nearMissFrom: undefined });
    expect(items.filter((i) => i.type === "number" || i.type === "boolean").length - 1).toBe(leafCount); // minus the null nearMissFrom item
  });

  it("marks the contract read-only and refuses to edit it", () => {
    const item = sd.formOf(sd.OPTION_V1_DEF).flatMap((s) => s.items).find((i) => i.path === "strategies.long_call.contract")!;
    expect(item).toMatchObject({ readOnly: true, type: "text" });
    expect(item.note).toMatch(/options sweep/);
    const r = sd.applyForm(sd.OPTION_V1_DEF, [{ path: "strategies.long_call.contract", value: "atm_put" }]);
    expect(r.ok).toBe(false);
  });

  it("applies edits and validates them", () => {
    const r = sd.applyForm(sd.OPTION_V1_DEF, [
      { path: "listing.minScore", value: 75 },
      { path: "strategies.long_call.gates[2].value", value: 30 },
      { path: "listing.nearMissFrom", value: 65 },
      { path: "strategies.covered_call.enabled", value: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.def.kind === "option") {
      expect(r.def.listing.minScore).toBe(75);
      expect(r.def.strategies.long_call.gates[2]).toMatchObject({ value: 30 });
      expect(r.def.strategies.covered_call.enabled).toBe(false);
      expect(r.def.version).toBe("option-v1"); // the store names it
    }
    expect(sd.OPTION_V1_DEF.listing.minScore).toBe(70); // the input is untouched
    for (const bad of [
      [{ path: "listing.minScore", value: 101 }],
      [{ path: "listing.minScore", value: "high" as never }],
      [{ path: "nope", value: 1 }],
      [{ path: "listing.nearMissFrom", value: 70 }], // not below the listing bar
    ]) expect(sd.applyForm(sd.OPTION_V1_DEF, bad).ok).toBe(false);
    const clear = sd.applyForm(sd.applyForm(sd.OPTION_V1_DEF, [{ path: "listing.nearMissFrom", value: 60 }]).ok ? (sd.applyForm(sd.OPTION_V1_DEF, [{ path: "listing.nearMissFrom", value: 60 }]) as { def: import("./schema.js").Definition }).def : sd.OPTION_V1_DEF, [{ path: "listing.nearMissFrom", value: null }]);
    expect(clear.ok).toBe(true);
  });

  it("applies stock edits and rejects weights that do not sum to 1", () => {
    expect(sd.applyForm(sd.STOCK_V2_DEF, [{ path: "groupWeights.valuation", value: 0.25 }]).ok).toBe(false);
    const r = sd.applyForm(sd.STOCK_V2_DEF, [
      { path: "groupWeights.valuation", value: 0.25 },
      { path: "groupWeights.momentum", value: 0.15 },
      { path: "minPeers", value: 8 },
      { path: "factors[0].direction", value: "higher" },
      { path: "liveFactors[0].include", value: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.def.kind === "stock") {
      expect(r.def.minPeers).toBe(8);
      expect(r.def.factors[0].direction).toBe("higher");
      expect(r.def.liveFactors[0].include).toBe(false);
    }
  });

  it("diffs two definitions with labels and formatted values", () => {
    const next = sd.applyForm(sd.OPTION_V1_DEF, [
      { path: "listing.minScore", value: 75 },
      { path: "strategies.long_call.gates[2].value", value: 30 },
      { path: "listing.nearMissFrom", value: 65 },
    ]);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const rows = sd.diff(sd.OPTION_V1_DEF, next.def);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Listing › List a setup when it scores at least", from: "70", to: "75", change: "changed" }),
        expect.objectContaining({ label: "Buy a call › Daily uptrend: at least", from: "25", to: "30", change: "changed" }),
        expect.objectContaining({ label: "Listing › Keep near misses from (empty = off)", from: "off", to: "65", change: "changed" }),
      ])
    );
    expect(rows).toHaveLength(3);
    expect(sd.diff(sd.OPTION_V1_DEF, sd.OPTION_V1_DEF)).toEqual([]);
  });

  it("reports added and removed terms as one row each", () => {
    const d = clone(sd.OPTION_V1_DEF);
    d.strategies.long_call.terms.push({ label: "Unusual activity", expr: { scale: { expr: "unusual_count", from: 0, to: 3 } }, points: 5 });
    d.strategies.long_call.penalties = [];
    const rows = sd.diff(sd.OPTION_V1_DEF, d);
    expect(rows.filter((r) => r.change === "added")).toEqual([expect.objectContaining({ label: "Buy a call › Score: Unusual activity" })]);
    expect(rows.filter((r) => r.change === "removed").map((r) => r.label)).toEqual(["Buy a call › Penalty: Earnings before expiry", "Buy a call › Penalty: Stretched"]);
    // A structural change with the same numbers is still a change.
    const e = clone(sd.OPTION_V1_DEF);
    e.strategies.long_call.gates[0] = { label: "Momentum average", expr: { max: ["m15", "h1"] }, op: ">=", value: 40 };
    expect(sd.diff(sd.OPTION_V1_DEF, e)).toEqual([expect.objectContaining({ label: "Buy a call › Gate: Momentum average", change: "changed" })]);
  });
});

describe("the store", () => {
  it("seeds option-v1 and stock-v2 as active", () => {
    expect(sd.getActive("option")).toMatchObject({ version: "option-v1", status: "active", author: "built-in" });
    expect(sd.getActive("stock")).toMatchObject({ version: "stock-v2", status: "active", author: "built-in" });
    expect(sd.getActive("option").text).toBe(sd.render(sd.OPTION_V1_DEF));
    expect(sd.getActive("option").definition).toEqual(sd.OPTION_V1_DEF);
  });

  it("creates drafts with the next version, replacing the open one, and promotes and rolls back", () => {
    const events: string[] = [];
    sd.onDefinitionChange((e) => events.push(`${e.kind}:${e.event}`));
    const r = sd.applyForm(sd.OPTION_V1_DEF, [{ path: "listing.minScore", value: 75 }]);
    if (!r.ok) throw new Error("form");
    const d1 = sd.createDraft({ kind: "option", definition: r.def, author: "form" });
    expect(d1).toMatchObject({ version: "option-v2", status: "draft", author: "form", parentId: sd.getActive("option").id });
    expect((d1.definition as import("./schema.js").OptionDefinition).parent).toBe("option-v1");
    expect(d1.text).toContain("scores 75 or more");

    const d2 = sd.createDraft({ kind: "option", definition: r.def, author: "claude", sourceText: "edited text", notes: ["n"] });
    expect(d2.version).toBe("option-v3");
    expect(sd.getById(d1.id)?.status).toBe("discarded");
    expect(sd.getDraft("option")?.id).toBe(d2.id);
    expect(d2.sourceText).toBe("edited text");
    expect(d2.notes).toEqual(["n"]);

    sd.setStatus(d2.id, "active");
    expect(sd.getActive("option").version).toBe("option-v3");
    expect(sd.listVersions("option").map((v) => [v.version, v.status])).toEqual([["option-v3", "active"], ["option-v2", "discarded"], ["option-v1", "previous"]]);
    expect(sd.getDraft("option")).toBeNull();
    expect(sd.getById(d2.id)?.promotedAt).not.toBeNull();

    const prev = sd.listVersions("option").find((v) => v.status === "previous")!;
    sd.setStatus(prev.id, "active");
    expect(sd.getActive("option").version).toBe("option-v1");
    expect(sd.getById(d2.id)?.status).toBe("retired");
    expect(events).toEqual(["option:drafted", "option:drafted", "option:activated", "option:activated"]);
  });

  it("refuses invalid drafts and impossible status changes", () => {
    expect(() => sd.createDraft({ kind: "option", definition: { ...clone(sd.OPTION_V1_DEF), listing: { ...sd.OPTION_V1_DEF.listing, maxIdeas: 0 } }, author: "form" })).toThrow(sd.DefinitionError);
    expect(() => sd.createDraft({ kind: "stock", baseId: sd.getActive("option").id, definition: sd.STOCK_V2_DEF, author: "form" })).toThrow(/no stock definition/);
    expect(() => sd.setStatus(sd.getActive("option").id, "discarded")).toThrow(/cannot move/);
    const d = sd.createDraft({ kind: "stock", definition: sd.STOCK_V2_DEF, author: "form" });
    expect(d.version).toBe("stock-v3");
    sd.setStatus(d.id, "discarded");
    expect(sd.getById(d.id)?.status).toBe("discarded");
    expect(sd.getActive("stock").version).toBe("stock-v2");
  });
});

describe("evaluation trace", () => {
  const metrics = (o: Partial<OptionMetrics> = {}): OptionMetrics => ({
    underlying: "AAA", asOf: "", price: 100, atmExpiry: "2026-11-20", atmCall: "AAA261120C00100000", atmPut: "AAA261120P00100000",
    atmIv: 0.3, iv30: 0.3, ivRank: 20, ivPercentile: 25, ivHistoryDays: 200, hv20: 0.28, impliedMovePct: 5, termSlope: 0, putCallVolumeRatio: 0.8, unusual: [],
    atmCallQuote: null, atmPutQuote: null, ...o,
  });
  const input = (o: Partial<import("../quant/option-score.js").SetupInputs> = {}): import("../quant/option-score.js").SetupInputs => ({
    momentum: { m5: 50, m15: 60, h1: 55, d1: 30 }, metrics: metrics(), composite: 70, relVolume: 2, sharesHeld: 0, nextEarnings: null, today: "2026-10-21", ...o,
  });
  const run = (i: import("../quant/option-score.js").SetupInputs, def = sd.OPTION_V1_DEF) =>
    sd.evaluateOption(def, { ctx: sd.optionCtx(i), hasData: i.metrics !== null, contracts: { atm_call: i.metrics?.atmCall ?? null, atm_put: i.metrics?.atmPut ?? null } });

  it("reports which gate failed first, the terms applied and the score", () => {
    const ev = run(input({ momentum: { m5: 50, m15: 60, h1: 55, d1: 10 } }));
    const call = ev.traces.find((t) => t.strategy === "long_call")!;
    expect(ev.traces.map((t) => t.strategy)).toEqual(["long_call", "short_put", "covered_call"]);
    expect(call.passed).toBe(false);
    expect(call.firstFailed).toBe("Daily uptrend");
    expect(call.gates.map((g) => [g.label, g.passed])).toEqual([["Momentum average", true], ["Both timeframes up", true], ["Daily uptrend", false], ["Contract available", true]]);
    expect(call.score).toBeNull();
    const put = ev.traces.find((t) => t.strategy === "short_put")!;
    expect(put.firstFailed).toBe("IV is rich"); // IV rank 20 is not rich
    expect(put.passed).toBe(false);
    expect(put.gates.map((g) => g.passed)).toEqual([true, false, true, true]);
    const cc = ev.traces.find((t) => t.strategy === "covered_call")!;
    expect(cc.gates[0]).toEqual({ label: "Shares held", passed: false });

    const good = run(input());
    const lc = good.traces[0];
    expect(lc.passed).toBe(true);
    expect(lc.score).toBe(good.setups[0].score);
    expect(lc.terms.filter((t) => t.applied).map((t) => t.label)).toEqual(["Momentum", "Daily trend", "Options are cheap", "Volume", "High volume"]);
    expect(lc.terms.reduce((a, t) => a + t.points, 40)).toBeCloseTo(lc.score!, 0);
  });

  it("marks strategies without data, and disabled ones, and counts the funnel", () => {
    const none = run(input({ metrics: null }));
    expect(none.setups).toEqual([]);
    expect(none.traces.every((t) => !t.hasData && t.gates.length === 0)).toBe(true);

    const off = clone(sd.OPTION_V1_DEF);
    off.strategies.long_call.enabled = false;
    expect(run(input(), off).setups).toEqual([]);
    expect(run(input(), off).traces[0].enabled).toBe(false);

    const traces = [run(input()), run(input({ momentum: { m5: 0, m15: 10, h1: 10, d1: 40 } })), run(input({ momentum: { m5: 0, m15: 60, h1: 60, d1: 0 } })), run(input({ metrics: null }))].flatMap((e) => e.traces);
    expect(sd.optionFunnel("long_call", traces)).toEqual([
      { step: "With data", count: 3 },
      { step: "Momentum average", count: 2 },
      { step: "Both timeframes up", count: 2 },
      { step: "Daily uptrend", count: 1 },
      { step: "Contract available", count: 1 },
    ]);
  });

  it("moves the thresholds with the definition", () => {
    const loose = clone(sd.OPTION_V1_DEF);
    loose.strategies.long_call.gates[2].value = 5;
    const i = input({ momentum: { m5: 50, m15: 60, h1: 55, d1: 10 } });
    expect(run(i).setups).toEqual([]);
    expect(run(i, loose).setups.map((s) => s.strategy)).toEqual(["long_call"]);
    expect(run(i, loose).setups[0].reasons[1]).toBe("daily uptrend 10 (at least 5)");
  });
});

describe("near misses", () => {
  const card = (underlying: string, score: number, ivHistoryDays = 200) => ({
    underlying, metrics: { ivHistoryDays } as OptionMetrics, setups: [{ strategy: "long_call" as const, score, contract: `${underlying}C`, reasons: ["r"] }],
  });

  it("keeps setups at or above nearMissFrom that are not listed, best first, and lists none when off", () => {
    const cards = [card("A", 85), card("B", 72), card("C", 69), card("D", 64), card("E", 59), card("F", 66, 5), card("G", 55, 5)];
    const off = ideas.listOptionCandidates(cards, sd.OPTION_V1_DEF.listing);
    expect(off.top.map((c) => c.symbol)).toEqual(["A", "B", "F"]); // F is early: bar 60
    expect(off.nearMisses).toEqual([]);
    const on = ideas.listOptionCandidates(cards, { ...sd.OPTION_V1_DEF.listing, nearMissFrom: 62 });
    expect(on.top.map((c) => c.symbol)).toEqual(["A", "B", "F"]);
    expect(on.nearMisses.map((c) => [c.symbol, c.score])).toEqual([["C", 69], ["D", 64]]);
    const capped = ideas.listOptionCandidates(cards, { ...sd.OPTION_V1_DEF.listing, nearMissFrom: 62, maxIdeas: 2 });
    expect(capped.top.map((c) => c.symbol)).toEqual(["A", "B"]);
    expect(capped.nearMisses.map((c) => c.symbol)).toEqual(["C", "F", "D"]); // F scored above the bar but missed the cap
  });
});

describe("stock screen with filters", () => {
  it("applies filters in order and reports the funnel", () => {
    const cand = (symbol: string, composite: number | null, coverage: number, price: number | null, pe: number | null) => ({
      card: { symbol, asOf: "", sector: "Technology", industry: null, composite, groups: { valuation: 50 }, factors: [{ key: "pe", group: "valuation", value: pe, score: 50, change: null }], coverage, weightsVersion: "stock-v2" },
      price,
      nextEarningsDays: null,
    });
    const def = clone(sd.STOCK_V2_DEF);
    def.listing.top = 2;
    def.filters = [
      { label: "Price over 10", expr: "price", op: ">=", value: 10 },
      { label: "P/E under 30", expr: "pe", op: "<", value: 30 },
    ];
    const cs = [cand("A", 90, 0.9, 50, 20), cand("B", 88, 0.9, 5, 10), cand("C", 85, 0.9, 40, 45), cand("D", 80, 0.9, 40, 25), cand("E", 70, 0.9, 40, 12), cand("F", null, 1, 40, 12), cand("G", 95, 0.3, 40, 12)];
    const r = sd.screenStocks(def, cs);
    expect(r.picked.map((c) => c.card.symbol)).toEqual(["A", "D"]);
    expect(r.funnel).toEqual([
      { step: "Scored", count: 6 },
      { step: "Coverage of 60% or more", count: 5 },
      { step: "Price over 10", count: 4 },
      { step: "P/E under 30", count: 3 },
      { step: "Top 2", count: 2 },
    ]);
  });
});
