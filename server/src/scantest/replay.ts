import { db } from "../db.js";
import type { FactorScore, Scorecard } from "../scan/contracts.js";
import { buildDists, scoreFactor, summarize, type Dists } from "../quant/stock-score.js";
import { evaluateSetups, type SetupInputs } from "../quant/option-score.js";
import { onDefinitionChange } from "../scandef/store.js";
import type { OptionDefinition, StockDefinition } from "../scandef/schema.js";
import { factorSpecs, intradayTotal, liveKeys, type StockCandidate } from "../scandef/stock-engine.js";
import { optionResult, stockResult, type TestResult } from "./result.js";

// Scores a stored pass with any definition. Pure apart from reading the nightly cards: nothing is written.

// ---- snapshots ----

export type OptionSnapshot = {
  v: 1;
  asOf: string;
  /** The option definition that scored the pass. */
  def: OptionDefinition;
  symbols: Array<{ symbol: string; inputs: SetupInputs }>;
  live: TestResult;
};

/** One stock of a 15-minute pass: its final factors (in scoring order) and the screen's extra inputs. */
export type StockRow = {
  symbol: string;
  sector: string | null;
  industry: string | null;
  price: number | null;
  nextEarningsDays: number | null;
  /** [key, group, raw value, score] */
  factors: Array<[string, string, number | null, number | null]>;
};
export type StockSnapshot = {
  v: 1;
  asOf: string;
  /** The nightly day whose raw values the percentile distributions are rebuilt from. */
  day: string | null;
  def: StockDefinition;
  symbols: StockRow[];
  live: TestResult;
};

export type Replayed = { live: TestResult; draft: TestResult };

// ---- options ----

const itemsOf = (snap: OptionSnapshot, def: OptionDefinition) =>
  snap.symbols.map((s) => ({ symbol: s.symbol, metrics: s.inputs.metrics, evaluation: evaluateSetups(s.inputs, def) }));

/** Scores the stored inputs of an option pass under `def` and under the definition that scored the pass. */
export function replayOption(snap: OptionSnapshot, def: OptionDefinition): Replayed {
  return {
    live: optionResult(snap.def, itemsOf(snap, snap.def), snap.asOf),
    draft: optionResult(def, itemsOf(snap, def), snap.asOf),
  };
}

/** Only the draft's side, for the shadow (the live side is the pass's own result). */
export const shadowOption = (snap: OptionSnapshot, def: OptionDefinition): TestResult => optionResult(def, itemsOf(snap, def), snap.asOf);

// ---- stocks ----

let distCache: { key: string; at: number; rows: Array<{ sector: string; raw: Record<string, number | null> }> } | null = null;
const DIST_ROWS_TTL_MS = 10 * 60_000;
onDefinitionChange((e) => {
  if (e.kind === "stock") distCache = null;
});

/** The day's raw factor values for every stock, from the stored nightly cards. */
function nightlyRaw(day: string): Array<{ sector: string; raw: Record<string, number | null> }> {
  if (distCache && distCache.key === day && Date.now() - distCache.at < DIST_ROWS_TTL_MS) return distCache.rows;
  const rows: Array<{ sector: string; raw: Record<string, number | null> }> = [];
  for (const r of db.prepare("SELECT sector, factors FROM scorecards WHERE day = ? AND factors IS NOT NULL").iterate(day) as Iterable<{ sector: string | null; factors: string }>) {
    const raw: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(JSON.parse(r.factors) as Record<string, [number | null, number | null, number | null]>)) raw[k] = v[0];
    rows.push({ sector: r.sector ?? "", raw });
  }
  distCache = { key: day, at: Date.now(), rows };
  return rows;
}

/** Whether a factor's score has to be recomputed under `def` rather than taken from the pass. */
function rescored(was: StockDefinition, def: StockDefinition): (key: string) => boolean {
  const before = new Map(was.factors.map((f) => [f.key, f]));
  const after = new Map(def.factors.map((f) => [f.key, f]));
  return (key) => {
    const a = before.get(key);
    const b = after.get(key);
    return !a || !b || def.minPeers !== was.minPeers || a.direction !== b.direction || a.positiveOnly !== b.positiveOnly || a.rankAgainst !== b.rankAgainst;
  };
}

export type StockScoring = { candidates: StockCandidate[]; distMs: number };

/**
 * The pass's stocks scored under `def`. A factor whose ranking is unchanged keeps the pass's score; one whose
 * direction, peer set or minimum peers changed is ranked again against distributions rebuilt from the nightly day's
 * stored raw values for every stock (as computeScorecards does), not from the pass's own cards.
 */
export function scoreStocks(snap: StockSnapshot, def: StockDefinition): StockScoring {
  const specs = factorSpecs(def);
  const included = new Map(specs.filter((s) => s.include).map((s) => [s.key, s]));
  const live = liveKeys(def);
  const changed = rescored(snap.def, def);
  const redo = specs.filter((s) => s.include && changed(s.key));
  const t0 = performance.now();
  const dists: Dists | null = redo.length > 0 && snap.day ? buildDists(redo, nightlyRaw(snap.day)) : null;
  const distMs = dists ? performance.now() - t0 : 0;
  const redoKeys = new Set(redo.map((s) => s.key));
  const total = intradayTotal(def);
  const candidates = snap.symbols.map((row): StockCandidate => {
    const sector = row.sector ?? "";
    const factors: FactorScore[] = [];
    for (const [key, group, value, score] of row.factors) {
      const spec = included.get(key);
      if (spec) factors.push({ key, group: spec.group, value, score: redoKeys.has(key) ? (dists ? scoreFactor(dists, spec, sector, value, def.minPeers) : null) : score, change: null });
      else if (live.has(key) && !specs.some((s) => s.key === key)) factors.push({ key, group, value, score, change: null });
    }
    const s = summarize(def, factors, total);
    const card: Scorecard = { symbol: row.symbol, asOf: snap.asOf, sector: row.sector, industry: row.industry, composite: s.composite, groups: s.groups, factors, coverage: s.coverage, weightsVersion: def.version };
    return { card, price: row.price, nextEarningsDays: row.nextEarningsDays };
  });
  return { candidates, distMs };
}

export const stockResultOf = (snap: StockSnapshot, def: StockDefinition): TestResult => stockResult(def, scoreStocks(snap, def).candidates, snap.asOf);

export function replayStock(snap: StockSnapshot, def: StockDefinition): Replayed {
  return { live: stockResultOf(snap, snap.def), draft: stockResultOf(snap, def) };
}
