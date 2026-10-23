import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FactorScore } from "../scan/contracts.js";
import { optionFixtures, rng } from "../scandef/fixtures.test-util.js";
import type { OptionSnapshot, StockSnapshot } from "./replay.js";

let tmpDir: string;
let db: typeof import("../db.js").db;
let sd: typeof import("../scandef/index.js");
let ss: typeof import("../quant/stock-score.js");
let os: typeof import("../quant/option-score.js");
let rp: typeof import("./replay.js");
let rs: typeof import("./result.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-scantest-replay-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  sd = await import("../scandef/index.js");
  ss = await import("../quant/stock-score.js");
  os = await import("../quant/option-score.js");
  rp = await import("./replay.js");
  rs = await import("./result.js");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const NOW = "2026-10-21T19:00:00.000Z";

describe("spread", () => {
  it("buckets in 5-point steps from 50 to 80, with the tails", () => {
    const s = rs.spreadOf([0, 49.9, 50, 54.9, 55, 79.9, 80, 100]);
    expect(s.map((b) => b.bucket)).toEqual(["<50", "50-55", "55-60", "60-65", "65-70", "70-75", "75-80", "80+"]);
    expect(s.map((b) => b.count)).toEqual([2, 2, 1, 0, 0, 0, 1, 2]);
  });
});

describe("option replay", () => {
  const symbolsOf = (n: number) => optionFixtures(n, 7).map((inputs, i) => ({ symbol: `S${i}`, inputs }));

  /** What the live pass would have stored: evaluated under the active definition. */
  function livePass(def = sd.OPTION_V1_DEF): OptionSnapshot {
    const symbols = symbolsOf(600);
    const items = symbols.map((s) => ({ symbol: s.symbol, metrics: s.inputs.metrics, evaluation: os.evaluateSetups(s.inputs, def) }));
    return { v: 1, asOf: NOW, def, symbols, live: rs.optionResult(def, items, NOW) };
  }

  it("replaying the active definition reproduces the pass's live result exactly", () => {
    const snap = livePass();
    expect(snap.live.ideas.length).toBeGreaterThan(0);
    // The stored form survives a JSON round trip, as it does in scan_inputs.
    const stored = JSON.parse(JSON.stringify(snap)) as OptionSnapshot;
    const r = rp.replayOption(stored, stored.def);
    expect(r.live).toEqual(snap.live);
    expect(r.draft).toEqual(snap.live);
  });

  it("a smaller list changes the listing and the near misses, and nothing else moves", () => {
    const snap = livePass();
    const higher = sd.applyForm(sd.OPTION_V1_DEF, [{ path: "listing.maxIdeas", value: 5 }]);
    expect(higher.ok).toBe(true);
    if (!higher.ok) return;
    const r = rp.replayOption(snap, higher.def as never);
    expect(r.live).toEqual(snap.live);
    expect(r.draft.ideas.length).toBeLessThan(r.live.ideas.length);
    expect(r.draft.ideas).toHaveLength(5);
    const cmp = rs.compareResults(r.live, r.draft);
    expect(cmp.removed.length).toBeGreaterThan(0);
    expect(cmp.added).toEqual([]);
  });

  it("the funnel runs per strategy: with data, each gate, listed", () => {
    const f = livePass().live.funnel;
    const calls = f.filter((s) => s.strategy === "long_call");
    expect(calls[0].step).toBe("With data");
    expect(calls[calls.length - 1].step).toBe("Listed");
    expect(calls.length).toBe(sd.OPTION_V1_DEF.strategies.long_call.gates.length + 3);
    for (let i = 1; i < calls.length - 1; i++) expect(calls[i].count).toBeLessThanOrEqual(calls[i - 1].count);
  });

  it("the spread counts every setup that passed its gates", () => {
    const snap = livePass();
    const passed = snap.symbols.reduce((n, s) => n + os.evaluateSetups(s.inputs).setups.length, 0);
    expect(snap.live.spread.reduce((n, b) => n + b.count, 0)).toBe(passed);
  });
});

// ---- stocks ----

const SECTORS = ["Technology", "Healthcare", "Energy", "Utilities", "Real Estate", "Tiny"];
const DAY = "2026-10-21";

type Fixture = { snap: StockSnapshot; rows: Array<{ symbol: string; sector: string; raw: Record<string, number | null> }> };

/** Nightly cards in the test DB for `n` stocks, and a live pass over the first `m` of them as runIntradayStockScan builds it. */
function stockFixture(n: number, m: number, seed = 3): Fixture {
  const r = rng(seed);
  const def = sd.STOCK_V2_DEF;
  const rows = Array.from({ length: n }, (_, i) => {
    const raw: Record<string, number | null> = {};
    for (const f of ss.FACTORS) raw[f.key] = r() < 0.12 ? null : Math.round((r() - 0.3) * 1000) / 100;
    return { symbol: `T${String(i).padStart(5, "0")}`, sector: i % 97 === 0 ? "Tiny" : SECTORS[i % 5], raw };
  });
  db.prepare("DELETE FROM scorecards WHERE day = ?").run(DAY);
  const put = db.prepare("INSERT INTO scorecards (day, symbol, sector, industry, composite, groups, factors, coverage, weights_version) VALUES (?, ?, ?, NULL, NULL, '{}', ?, 1, 'stock-v2')");
  db.transaction(() => {
    for (const x of rows) put.run(DAY, x.symbol, x.sector, JSON.stringify(Object.fromEntries(Object.entries(x.raw).map(([k, v]) => [k, [v, null, null]]))));
  })();
  const specs = sd.factorSpecs(def);
  const dists = ss.buildDists(specs, rows);
  const live = rows.slice(0, m).map((x) => {
    const factors: FactorScore[] = specs.map((s) => {
      // Momentum is re-valued live; the other groups keep the nightly raw value.
      const value = s.group === "momentum" && x.raw[s.key] !== null ? x.raw[s.key]! * 1.01 : x.raw[s.key];
      return { key: s.key, group: s.group, value, score: ss.scoreFactor(dists, s, x.sector, value, def.minPeers), change: null };
    });
    factors.push({ key: "price_vs_vwap", group: "momentum", value: 0.5, score: 62, change: null }, { key: "rsi_15m", group: "momentum", value: 55, score: 55, change: null }, { key: "rel_volume", group: "momentum", value: r() < 0.5 ? null : 1.3, score: r() < 0.5 ? null : 57.5, change: null });
    const s = ss.summarize(def, factors, sd.intradayTotal(def));
    return { x, factors, ...s };
  });
  const candidates = live.map((l, i) => ({ card: { symbol: l.x.symbol, asOf: NOW, sector: l.x.sector, industry: null, composite: l.composite, groups: l.groups, factors: l.factors, coverage: l.coverage, weightsVersion: def.version }, price: 10 + i, nextEarningsDays: i % 9 === 0 ? 3 : null }));
  const snap: StockSnapshot = {
    v: 1,
    asOf: NOW,
    day: DAY,
    def,
    symbols: candidates.map((c) => ({ symbol: c.card.symbol, sector: c.card.sector, industry: null, price: c.price, nextEarningsDays: c.nextEarningsDays, factors: c.card.factors.map((f) => [f.key, f.group, f.value, f.score]) })),
    live: rs.stockResult(def, candidates, NOW),
  };
  return { snap, rows };
}

describe("stock replay", () => {
  it("replaying the active definition reproduces the pass's live result exactly", () => {
    const { snap } = stockFixture(900, 408);
    expect(snap.live.ideas).toHaveLength(def().listing.top);
    const stored = JSON.parse(JSON.stringify(snap)) as StockSnapshot;
    const r = rp.replayStock(stored, stored.def);
    expect(r.live).toEqual(snap.live);
    expect(r.draft).toEqual(snap.live);
  });

  const def = () => sd.STOCK_V2_DEF;
  const edit = (edits: Array<{ path: string; value: number | boolean | string }>) => {
    const r = sd.applyForm(def(), edits);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.def as import("../scandef/schema.js").StockDefinition;
  };

  it("a change to weights or the top N needs no distributions", () => {
    const { snap } = stockFixture(900, 408);
    const d = edit([{ path: "listing.top", value: 10 }]);
    const r = rp.replayStock(snap, d);
    expect(r.live).toEqual(snap.live);
    expect(r.draft.ideas).toEqual(snap.live.ideas.slice(0, 10));
    expect(rp.scoreStocks(snap, d).distMs).toBe(0);
  });

  it("a change to ranking rebuilds the distributions from the day's stored raw values for every stock", () => {
    const { snap, rows } = stockFixture(900, 408);
    const idx = def().factors.findIndex((f) => f.key === "pe");
    const flipped = edit([{ path: `factors[${idx}].rankAgainst`, value: "market" }]);
    expect(flipped.factors[idx].rankAgainst).toBe("market");
    const { candidates } = rp.scoreStocks(snap, flipped);

    // Independent: the same factor ranked against all 900 stocks, everything else as the pass scored it.
    const specs = sd.factorSpecs(flipped);
    const dists = ss.buildDists(specs, rows);
    const pe = specs[idx];
    for (const c of candidates.slice(0, 50)) {
      const f = c.card.factors.find((x) => x.key === "pe")!;
      expect(f.score).toBe(ss.scoreFactor(dists, pe, c.card.sector ?? "", f.value, def().minPeers));
      const before = snap.symbols.find((s) => s.symbol === c.card.symbol)!.factors.filter(([k]) => k !== "pe");
      for (const [k, , , score] of before) expect(c.card.factors.find((x) => x.key === k)!.score).toBe(score);
    }
    // The 408 live cards would rank differently from the 900 nightly ones.
    const own = ss.buildDists([pe], snap.symbols.map((s) => ({ sector: s.sector ?? "", raw: { pe: s.factors.find(([k]) => k === "pe")![2] } })));
    const some = candidates.filter((c) => c.card.factors.find((x) => x.key === "pe")!.score !== ss.scoreFactor(own, pe, c.card.sector ?? "", c.card.factors.find((x) => x.key === "pe")!.value, def().minPeers));
    expect(some.length).toBeGreaterThan(0);
  });

  it("excluding a factor drops it from scores and coverage; minPeers changes every ranked factor", () => {
    const { snap } = stockFixture(900, 408);
    const idx = def().factors.findIndex((f) => f.key === "roe");
    const off = rp.scoreStocks(snap, edit([{ path: `factors[${idx}].include`, value: false }])).candidates;
    expect(off[0].card.factors.some((f) => f.key === "roe")).toBe(false);
    const peers = rp.scoreStocks(snap, edit([{ path: "minPeers", value: 150 }]));
    expect(peers.distMs).toBeGreaterThan(0);
    // "Tiny" has fewer than 150 peers, so its cards now rank against the whole market.
    const tiny = peers.candidates.filter((c) => c.card.sector === "Tiny");
    const was = new Map(snap.symbols.map((r) => [r.symbol, r]));
    expect(tiny.some((c) => c.card.factors.some((f) => f.key === "pe" && f.score !== was.get(c.card.symbol)!.factors.find(([k]) => k === "pe")![3]))).toBe(true);
  });

  it("a stricter coverage bar shows in the funnel", () => {
    const { snap } = stockFixture(900, 408);
    const r = rp.replayStock(snap, edit([{ path: "listing.minCoverage", value: 0.95 }]));
    expect(r.draft.funnel[1].count).toBeLessThan(r.live.funnel[1].count);
    expect(r.draft.funnel[0].count).toBe(r.live.funnel[0].count);
  });

  it("replays a universe-sized pass (about 6,800 stocks) quickly", () => {
    const { snap } = stockFixture(6800, 6800);
    const idx = def().factors.findIndex((f) => f.key === "pe");
    const d = edit([{ path: `factors[${idx}].rankAgainst`, value: "market" }]);
    const t0 = performance.now();
    const r = rp.replayStock(snap, d);
    const ms = performance.now() - t0;
    const t1 = performance.now();
    rp.replayStock(snap, d);
    const warm = performance.now() - t1;
    console.log(`stock replay, 6800 stocks, rankAgainst change: ${ms.toFixed(0)} ms cold, ${warm.toFixed(0)} ms warm; distributions ${rp.scoreStocks(snap, d).distMs.toFixed(0)} ms`);
    const all = edit([{ path: "minPeers", value: 60 }]);
    const t2 = performance.now();
    rp.replayStock(snap, all);
    console.log(`stock replay, 6800 stocks, every factor re-ranked (minPeers change): ${(performance.now() - t2).toFixed(0)} ms warm`);
    expect(r.draft.ideas.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(8000);
  });
});
