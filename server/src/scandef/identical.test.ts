import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionSetup } from "../scan/contracts.js";
import type { SetupInputs } from "../quant/option-score.js";
import { BUILTIN_FACTORS } from "./factors.js";
import { optionFixtures, rng } from "./fixtures.test-util.js";
import {
  refBuildDists, refBuildSetups, refListOptionIdeas, refScoreFactor, refStretchCheck, refSummarize, refTopStocks,
  type RefActive, type RefCard, type RefFactor,
} from "./reference.test-util.js";

// The acceptance test: the engine, running option-v1 and stock-v2, scores exactly as the code did
// before it ran on definitions (reference.test-util.ts, a frozen copy).

let tmpDir: string;
let sd: typeof import("./index.js");
let os: typeof import("../quant/option-score.js");
let ss: typeof import("../quant/stock-score.js");
let ideas: typeof import("../quant/ideas.js");
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scandef-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  sd = await import("./index.js");
  os = await import("../quant/option-score.js");
  ss = await import("../quant/stock-score.js");
  ideas = await import("../quant/ideas.js");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

/** The one wording difference: the first gate's reason and the daily-uptrend reason are separate entries now. */
function joinLead(reasons: string[]): string[] {
  if (reasons.length >= 2 && reasons[0].startsWith("momentum is strong") && reasons[1].startsWith("daily uptrend")) return [`${reasons[0]}, ${reasons[1]}`, ...reasons.slice(2)];
  return reasons;
}

function sameSetups(got: OptionSetup[], want: OptionSetup[]): void {
  expect(got.map((s) => s.strategy)).toEqual(want.map((s) => s.strategy));
  got.forEach((s, i) => {
    expect(Math.abs(s.score - want[i].score)).toBeLessThan(1e-9);
    expect(s.contract).toBe(want[i].contract);
    expect(joinLead(s.reasons)).toEqual(want[i].reasons);
  });
}

describe("option-v1 against the reference scoring", () => {
  it("builds identical setups (strategy, score, contract, reasons) over generated inputs", () => {
    let withSetups = 0;
    const seen = new Set<string>();
    for (const f of optionFixtures(30_000, 7)) {
      const want = refBuildSetups(f);
      sameSetups(os.buildSetups(f), want);
      sameSetups(sd.evaluateOption(sd.OPTION_V1_DEF, { ctx: sd.optionCtx(f), hasData: f.metrics !== null, contracts: { atm_call: f.metrics?.atmCall ?? null, atm_put: f.metrics?.atmPut ?? null } }).setups, want);
      if (want.length > 0) withSetups++;
      for (const s of want) seen.add(s.strategy);
    }
    expect(seen).toEqual(new Set(["long_call", "short_put", "covered_call"]));
    expect(withSetups).toBeGreaterThan(500);
  });

  it("stretch penalty matches the reference at every sign combination and boundary", () => {
    const base = optionFixtures(1, 1)[0];
    const strong: SetupInputs = { ...base, momentum: { m5: 50, m15: 82, h1: 68, d1: 60 }, nextEarnings: null, relVolume: 1, metrics: { ...base.metrics!, atmCall: "AAA261120C00100000", ivRank: 20, hv20: null } };
    for (const vwapAtr of [null, 1.99, 2, 2.01, 3]) for (const rsi15 of [null, 74.9, 75, 75.4, 90]) for (const dayMovePct of [null, 2.9, 3, 3.1, 8]) {
      for (const dailyAtrPct of [null, 2, 0]) {
        const stretch = { vwapAtr, rsi15, dayMovePct, dailyAtrPct };
        sameSetups(os.buildSetups({ ...strong, stretch }), refBuildSetups({ ...strong, stretch }));
      }
    }
    for (const hv20 of [0.25, 0.3, 0.5]) for (const dayMovePct of [1, 1.5, 2.5, 4, 4.8]) {
      const s: SetupInputs = { ...strong, metrics: { ...strong.metrics!, hv20 }, stretch: { vwapAtr: 0, rsi15: 50, dayMovePct, dailyAtrPct: 2 } };
      sameSetups(os.buildSetups(s), refBuildSetups(s));
    }
    expect(refStretchCheck({ vwapAtr: 3, rsi15: 80, dayMovePct: 9, dailyAtrPct: 2 }, null).penalty).toBe(30);
  });

  it("lists, drops and keeps ideas exactly as the reference does, pass after pass", () => {
    const r = rng(11);
    const symbols = Array.from({ length: 40 }, (_, k) => `S${String(k).padStart(2, "0")}`);
    let active: RefActive[] = [];
    for (let pass = 0; pass < 60; pass++) {
      const cards = symbols.map((underlying) => {
        // Scores clustered on the bars (60, 70) so ties and boundaries come up.
        const score = [58, 59.9, 60, 60.1, 69.9, 70, 70.1, 75, 90, 100][Math.floor(r() * 10)];
        const strategy = (["long_call", "short_put", "covered_call"] as const)[Math.floor(r() * 3)];
        const setups = r() < 0.3 ? [] : [{ strategy, score, contract: `${underlying}C`, reasons: ["r"] }];
        const metrics = r() < 0.1 ? null : { ivHistoryDays: [0, 19, 20, 21, 200][Math.floor(r() * 5)] };
        return { underlying, metrics, setups } as RefCard;
      });
      const want = refListOptionIdeas(cards, active);
      const got = ideas.listOptionCandidates(cards as never, sd.OPTION_V1_DEF.listing);
      expect(got.top.map((c) => [c.symbol, c.strategy, c.contract, c.score, c.reasons])).toEqual(want.listed.map((c) => [c.symbol, c.strategy, c.contract, c.score, c.reasons]));
      expect(got.nearMisses).toEqual([]);
      const present = new Set(want.listed.map((c) => `${c.symbol}|${c.strategy}`));
      active = [
        ...want.listed.map((c) => ({ symbol: c.symbol, strategy: c.strategy, misses: 0 })),
        ...active.filter((a) => !present.has(`${a.symbol}|${a.strategy}`) && !want.dropped.includes(`${a.symbol}|${a.strategy}`)).map((a) => ({ ...a, misses: a.misses + 1 })),
      ];
    }
  });
});

describe("stock-v2 against the reference scoring", () => {
  it("percentiles, group scores, composites and coverage are identical over generated universes", () => {
    const r = rng(5);
    const specs = sd.factorSpecs(sd.STOCK_V2_DEF);
    const refFactors: RefFactor[] = BUILTIN_FACTORS;
    const sectors = ["Technology", "Energy", "Utilities", "Healthcare", "Tiny"];
    for (let round = 0; round < 12; round++) {
      const rows = Array.from({ length: 60 + Math.floor(r() * 80) }, () => {
        const sector = sectors[Math.floor(r() * (round % 3 === 0 ? 5 : 4))];
        const raw: Record<string, number | null> = {};
        for (const f of BUILTIN_FACTORS) {
          const x = r();
          raw[f.key] = x < 0.15 ? null : x < 0.25 ? 0 : x < 0.35 ? -Math.round(r() * 20) : x < 0.5 ? Math.round(r() * 5) : r() * 100 - 20;
        }
        return { sector, raw };
      });
      const refDists = refBuildDists(refFactors, rows);
      const dists = ss.buildDists(specs, rows);
      for (const row of rows) {
        const refScored = refFactors.map((f) => ({ group: f.group, score: refScoreFactor(refDists, f, row.sector, row.raw[f.key]) }));
        const scored = specs.map((f) => ({ group: f.group, score: ss.scoreFactor(dists, f, row.sector, row.raw[f.key], sd.STOCK_V2_DEF.minPeers) }));
        scored.forEach((x, i) => {
          if (x.score === null || refScored[i].score === null) expect(x.score).toBe(refScored[i].score);
          else expect(Math.abs(x.score - refScored[i].score!)).toBeLessThan(1e-9);
        });
        const want = refSummarize(refScored, refFactors.length);
        const got = ss.summarize(sd.STOCK_V2_DEF, scored.map((x, i) => ({ key: specs[i].key, group: x.group, value: null, score: x.score, change: null })), sd.nightlyTotal(sd.STOCK_V2_DEF));
        expect(got.coverage).toBe(want.coverage);
        if (want.composite === null) expect(got.composite).toBeNull();
        else expect(Math.abs(got.composite! - want.composite)).toBeLessThan(1e-9);
        for (const g of Object.keys(want.groups)) {
          if (want.groups[g] === null) expect(got.groups[g]).toBeNull();
          else expect(Math.abs(got.groups[g]! - want.groups[g]!)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it("screens the same top stocks as the reference", () => {
    const r = rng(9);
    const cards = Array.from({ length: 300 }, (_, k) => ({
      symbol: `T${String(k).padStart(3, "0")}`,
      composite: r() < 0.1 ? null : [50, 60, 70, 80][Math.floor(r() * 4)] + Math.floor(r() * 3),
      coverage: [0.5, 0.59, 0.6, 0.61, 0.9, 1][Math.floor(r() * 6)],
    }));
    const candidates = cards.map((c) => ({
      card: { symbol: c.symbol, asOf: "", sector: null, industry: null, composite: c.composite, groups: {}, factors: [], coverage: c.coverage, weightsVersion: "stock-v2" },
      price: null,
      nextEarningsDays: null,
    }));
    expect(sd.screenStocks(sd.STOCK_V2_DEF, candidates).picked.map((c) => c.card.symbol)).toEqual(refTopStocks(cards));
  });
});
