// Test-only snapshot of the scoring as it was before the engine moved onto definitions
// (option-score.ts, ideas.ts, stock-score.ts, weights.ts at v0.3.0). The identical-scores
// test runs it against the interpreter with option-v1 and stock-v2. Do not "fix" it.
import type { OptionMetrics, OptionSetup } from "../scan/contracts.js";
import type { Momentum, SetupInputs, Stretch } from "../quant/option-score.js";

const STRONG_MOMENTUM = 40;
const FLAT_MOMENTUM = 20;
const D1_MIN_LONG_CALL = 25;
const STRETCH_VWAP_ATR = 2;
const STRETCH_RSI_15M = 75;
const STRETCH_DAY_MOVE_MULT = 1.5;
const STRETCH_PENALTY = 10;
const STRETCH_PENALTY_CAP = 30;
const D1_STRONGLY_NEGATIVE = -50;
const REL_VOLUME_HIGH = 1.5;
const IV_RANK_CHEAP = 30;
const IV_RANK_RICH = 60;
const IV_VS_HV_NOT_EXPENSIVE = 1.2;
const IV_VS_HV_RICH = 1.0;
const WOULD_OWN_COMPOSITE = 60;
const SHARES_PER_CONTRACT = 100;
const EARNINGS_PENALTY = { long_call: 25, short_put: 15, covered_call: 10 } as const;
const EX_DIVIDEND_PENALTY = { covered_call: 30, short_put: 3 } as const;
const SETUP_BASE = 40;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${Math.round(x)}`;

export function refStretchCheck(st: Stretch | undefined, hv20: number | null): { penalty: number; text: string | null } {
  if (!st) return { penalty: 0, text: null };
  const met: string[] = [];
  if (st.vwapAtr !== null && st.vwapAtr > STRETCH_VWAP_ATR) met.push(`${st.vwapAtr.toFixed(1)} ATR above VWAP`);
  if (st.rsi15 !== null && st.rsi15 > STRETCH_RSI_15M) met.push(`15-min RSI ${Math.round(st.rsi15)}`);
  const normal = hv20 !== null && hv20 > 0 ? (hv20 / Math.sqrt(252)) * 100 : st.dailyAtrPct;
  if (st.dayMovePct !== null && normal !== null && normal > 0 && st.dayMovePct > STRETCH_DAY_MOVE_MULT * normal) {
    met.push(`up ${st.dayMovePct.toFixed(1)}% vs a normal ${normal.toFixed(1)}% day`);
  }
  if (met.length === 0) return { penalty: 0, text: null };
  return { penalty: Math.min(STRETCH_PENALTY_CAP, STRETCH_PENALTY * met.length), text: `stretched: ${met.join(", ")}: consider waiting for a pullback` };
}

function ivCheapness(m: OptionMetrics): { value: number; text: string } | null {
  if (m.ivRank !== null) {
    return { value: clamp((IV_RANK_RICH - m.ivRank) / (IV_RANK_RICH - IV_RANK_CHEAP), 0, 1), text: `IV rank ${pct(m.ivRank)}` };
  }
  if (m.iv30 !== null && m.hv20 !== null && m.hv20 > 0) {
    const ratio = m.iv30 / m.hv20;
    return { value: ratio <= IV_VS_HV_NOT_EXPENSIVE ? 1 : 0, text: `IV ${(m.iv30 * 100).toFixed(0)}% vs 20-day realised ${(m.hv20 * 100).toFixed(0)}% (no IV rank yet)` };
  }
  return null;
}

function ivRichness(m: OptionMetrics): { value: number; text: string; rich: boolean } | null {
  if (m.ivRank !== null) {
    return { value: clamp((m.ivRank - IV_RANK_CHEAP) / (100 - IV_RANK_CHEAP), 0, 1), text: `IV rank ${pct(m.ivRank)}`, rich: m.ivRank >= IV_RANK_RICH };
  }
  if (m.iv30 !== null && m.hv20 !== null && m.hv20 > 0) {
    const ratio = m.iv30 / m.hv20;
    return { value: clamp((ratio - 0.8) / 0.8, 0, 1), text: `IV ${(m.iv30 * 100).toFixed(0)}% vs 20-day realised ${(m.hv20 * 100).toFixed(0)}% (no IV rank yet)`, rich: ratio > IV_VS_HV_RICH };
  }
  return null;
}

function earningsNote(i: SetupInputs): { before: boolean | null; text: string | null } {
  const expiry = i.metrics?.atmExpiry;
  if (!expiry || !i.nextEarnings) return { before: null, text: null };
  const before = i.nextEarnings >= i.today && i.nextEarnings <= expiry;
  return { before, text: before ? `earnings on ${i.nextEarnings} fall before the ${expiry} expiry` : null };
}

function exDividendBefore(i: SetupInputs): string | null {
  const expiry = i.metrics?.atmExpiry;
  const ex = i.nextExDividend;
  return expiry && ex && ex >= i.today && ex <= expiry ? ex : null;
}

export function refBuildSetups(i: SetupInputs): OptionSetup[] {
  const m = i.metrics;
  if (!m) return [];
  const { m15, h1, d1 } = i.momentum as Momentum;
  const earn = earningsNote(i);
  const out: OptionSetup[] = [];

  if (m15 !== null && h1 !== null && d1 !== null && m.atmCall) {
    const avg = (m15 + h1) / 2;
    if (avg >= STRONG_MOMENTUM && Math.min(m15, h1) > 0 && d1 >= D1_MIN_LONG_CALL) {
      const iv = ivCheapness(m);
      const reasons = [`momentum is strong: 15-minute ${pct(m15)}, hourly ${pct(h1)}, daily uptrend ${pct(d1)} (at least ${D1_MIN_LONG_CALL})`];
      let score = SETUP_BASE + 25 * clamp((avg - STRONG_MOMENTUM) / (100 - STRONG_MOMENTUM), 0, 1) + 10 * clamp(d1 / 50, 0, 1);
      if (iv) {
        score += 15 * iv.value;
        reasons.push(iv.value >= 0.5 ? `${iv.text}: options are not expensive` : `${iv.text}: options are pricey`);
      } else reasons.push("IV is unknown");
      if (i.relVolume !== null) {
        score += 10 * (i.relVolume >= REL_VOLUME_HIGH ? 1 : 0.5 * (i.relVolume / REL_VOLUME_HIGH));
        reasons.push(`volume is ${i.relVolume.toFixed(1)}x normal for the time of day`);
      }
      if (earn.text) {
        score -= EARNINGS_PENALTY.long_call;
        reasons.push(`caution: ${earn.text}`);
      }
      const stretched = refStretchCheck(i.stretch, m.hv20);
      if (stretched.text) {
        score -= stretched.penalty;
        reasons.push(stretched.text);
      }
      out.push({ strategy: "long_call", score: round1(clamp(score, 0, 100)), contract: m.atmCall, reasons });
    }
  }

  const rich = ivRichness(m);
  if (i.composite !== null && i.composite >= WOULD_OWN_COMPOSITE && rich?.rich && d1 !== null && d1 > D1_STRONGLY_NEGATIVE && m.atmPut) {
    const reasons = [`stock score ${pct(i.composite)}/100: worth owning if assigned`, `${rich.text}: premium is rich`, `daily trend ${pct(d1)}, not falling hard`];
    let score =
      SETUP_BASE +
      25 * rich.value +
      20 * clamp((i.composite - WOULD_OWN_COMPOSITE) / (100 - WOULD_OWN_COMPOSITE), 0, 1) +
      10 * clamp(((h1 ?? 0) + 50) / 100, 0, 1);
    if (m.price) reasons.push(`needs cash for 100 shares at the strike (about $${Math.round(m.price * 100).toLocaleString("en-US")})`);
    if (earn.text) {
      score -= EARNINGS_PENALTY.short_put;
      reasons.push(`caution: ${earn.text}`);
    }
    const exDiv = exDividendBefore(i);
    if (exDiv) {
      score -= EX_DIVIDEND_PENALTY.short_put;
      reasons.push(`note: ex-dividend ${exDiv} before expiry`);
    }
    out.push({ strategy: "short_put", score: round1(clamp(score, 0, 100)), contract: m.atmPut, reasons });
  }

  if (i.sharesHeld >= SHARES_PER_CONTRACT && rich?.rich && m15 !== null && h1 !== null && m15 <= FLAT_MOMENTUM && h1 <= FLAT_MOMENTUM && m.atmCall) {
    const flat = (FLAT_MOMENTUM - (m15 + h1) / 2) / (FLAT_MOMENTUM + 60);
    const reasons = [
      `you hold ${i.sharesHeld} shares (${Math.floor(i.sharesHeld / SHARES_PER_CONTRACT)} contract${i.sharesHeld >= 2 * SHARES_PER_CONTRACT ? "s" : ""} covered)`,
      `${rich.text}: premium is rich`,
      `momentum is flat or down: 15-minute ${pct(m15)}, hourly ${pct(h1)}`,
    ];
    let score = SETUP_BASE + 30 * rich.value + 20 * clamp(flat, 0, 1) + 10 * (d1 !== null && d1 <= FLAT_MOMENTUM ? 1 : 0);
    if (earn.text) {
      score -= EARNINGS_PENALTY.covered_call;
      reasons.push(`caution: ${earn.text}`);
    }
    const exDiv = exDividendBefore(i);
    if (exDiv) {
      score -= EX_DIVIDEND_PENALTY.covered_call;
      reasons.push(`ex-dividend ${exDiv} before expiry: early assignment risk`);
    }
    out.push({ strategy: "covered_call", score: round1(clamp(score, 0, 100)), contract: m.atmCall, reasons });
  }

  return out.sort((a, b) => b.score - a.score);
}

// ---- option idea listing (updateOptionIdeas without the database) ----

export type RefCard = { underlying: string; metrics: { ivHistoryDays?: number } | null; setups: OptionSetup[] };
export type RefActive = { symbol: string; strategy: string; misses: number };
export type RefListed = { symbol: string; strategy: string; contract: string | null; score: number; reasons: string[] };

export const REF_EARLY_IV_REASON = "IV history < 20 days: IV judged against 20-day realised volatility";

/** One pass of the listing: the new top list, and what happens to each previously active idea not in it. */
export function refListOptionIdeas(cards: RefCard[], active: RefActive[]): { listed: RefListed[]; dropped: string[]; kept: Array<{ key: string; misses: number }> } {
  const candidates: RefListed[] = [];
  for (const card of cards) {
    const early = (card.metrics?.ivHistoryDays ?? 0) < 20;
    for (const s of card.setups) {
      if (s.score < (early ? 60 : 70)) continue;
      candidates.push({ symbol: card.underlying, strategy: s.strategy, contract: s.contract, score: s.score, reasons: early ? [...s.reasons, REF_EARLY_IV_REASON] : s.reasons });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const listed = candidates.slice(0, 20);
  const present = new Set(listed.map((c) => `${c.symbol}|${c.strategy}`));
  const dropped: string[] = [];
  const kept: Array<{ key: string; misses: number }> = [];
  for (const r of active) {
    const key = `${r.symbol}|${r.strategy}`;
    if (present.has(key)) continue;
    if (r.misses + 1 >= 2) dropped.push(key);
    else kept.push({ key, misses: r.misses + 1 });
  }
  return { listed, dropped, kept };
}

// ---- stock scoring ----

export type RefFactor = { key: string; group: string; lowerBetter?: boolean; positiveOnly?: boolean; market?: boolean };
export type RefDist = { all: number[]; bySector: Map<string, number[]> };
export type RefDists = Map<string, RefDist>;
export const REF_MIN_PEERS = 5;
export const REF_WEIGHTS: Record<string, number> = { valuation: 0.2, quality: 0.2, growth: 0.15, earnings: 0.15, analysts: 0.1, momentum: 0.2 };

function rankValue(def: RefFactor, raw: number | null): number | null {
  if (raw === null) return null;
  if (def.positiveOnly && raw <= 0) return -1e18;
  return def.lowerBetter ? -raw : raw;
}

export function refBuildDists(factors: RefFactor[], rows: Array<{ sector: string; raw: Record<string, number | null> }>): RefDists {
  const dists: RefDists = new Map();
  for (const def of factors) {
    const all: number[] = [];
    const bySector = new Map<string, number[]>();
    for (const r of rows) {
      const v = rankValue(def, r.raw[def.key] ?? null);
      if (v === null) continue;
      all.push(v);
      const list = bySector.get(r.sector);
      if (list) list.push(v);
      else bySector.set(r.sector, [v]);
    }
    all.sort((a, b) => a - b);
    for (const list of bySector.values()) list.sort((a, b) => a - b);
    dists.set(def.key, { all, bySector });
  }
  return dists;
}

function bound(sorted: number[], x: number, upper: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (upper ? sorted[mid] <= x : sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function refPercentile(sorted: number[], x: number): number {
  const n = sorted.length;
  if (n <= 1) return 50;
  const less = bound(sorted, x, false);
  const lessEq = bound(sorted, x, true);
  const rank = (less + lessEq - 1) / 2;
  return Math.max(0, Math.min(100, (rank / (n - 1)) * 100));
}

export function refScoreFactor(dists: RefDists, def: RefFactor, sector: string, raw: number | null): number | null {
  const v = rankValue(def, raw);
  const d = dists.get(def.key);
  if (v === null || !d) return null;
  const peers = def.market ? undefined : d.bySector.get(sector);
  const sample = peers && peers.length >= REF_MIN_PEERS ? peers : d.all;
  return sample.length === 0 ? null : refPercentile(sample, v);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function refComposite(groups: Record<string, number | null>, weights: Record<string, number> = REF_WEIGHTS): number | null {
  let sum = 0;
  let total = 0;
  for (const [g, w] of Object.entries(weights)) {
    const v = groups[g];
    if (v === null || v === undefined) continue;
    sum += v * w;
    total += w;
  }
  return total > 0 ? sum / total : null;
}

export function refSummarize(factors: Array<{ group: string; score: number | null }>, total: number): { groups: Record<string, number | null>; composite: number | null; coverage: number } {
  const groups: Record<string, number | null> = {};
  for (const g of Object.keys(REF_WEIGHTS)) {
    const scores = factors.filter((f) => f.group === g && f.score !== null).map((f) => f.score!);
    groups[g] = scores.length > 0 ? mean(scores) : null;
  }
  return { groups, composite: refComposite(groups), coverage: factors.filter((f) => f.score !== null).length / total };
}

/** The stock screen's selection (topNightly then the top 25) without onePerCompany. */
export function refTopStocks(cards: Array<{ symbol: string; composite: number | null; coverage: number }>, minCoverage = 0.6, top = 25): string[] {
  return cards
    .filter((c) => c.composite !== null && c.coverage >= minCoverage)
    .sort((a, b) => b.composite! - a.composite! || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .slice(0, top)
    .map((c) => c.symbol);
}
