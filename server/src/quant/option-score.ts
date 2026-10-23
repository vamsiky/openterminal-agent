import { db } from "../db.js";
import { calendarFor } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import { minuteBars } from "../history/store.js";
import { tradingDay } from "../history/time.js";
import type { OptionMetrics, OptionScorecard, OptionSetup } from "../scan/contracts.js";
import { atr, ema, rollup, rsi, vwap, type Bar } from "./indicators.js";
import { hourlySeries } from "./hourly.js";
import { nextExDividends } from "./dividends.js";
import { sharesHeld } from "./positions.js";
import { compositeMap, getLiveScorecard, groupScoreMap, loadDaily } from "./stock-score.js";
import { activeOption, getActive } from "../scandef/store.js";
import { evaluateOption, type OptionEvaluation } from "../scandef/engine.js";
import { earningsBefore, optionCtx } from "../scandef/option-inputs.js";

// Option scorecards: intraday-to-swing momentum of the underlying plus three
// heuristic setups (buy a call, sell a cash-secured put, sell a covered call)
// scored from momentum, IV and the stock scorecard. These are screens for the
// user's eyes, not trading signals; every setup spells out its reasons.

// ---- thresholds ----
// The setup rules (gates, scoring terms, penalties, IV thresholds) live in the active option
// definition (scandef/builtins.ts has option-v1, which holds today's numbers).

/** option-v1's penalties, kept for reference and tests: the engine reads them from the definition. */
export const EARNINGS_PENALTY = { long_call: 25, short_put: 15, covered_call: 10 } as const;
export const EX_DIVIDEND_PENALTY = { covered_call: 30, short_put: 3 } as const;
/** Minute-bar history used for the intraday trend scores (calendar days). */
const LOOKBACK_DAYS = 8;
const HISTORY_DAYS = 30;
/** Bars needed for EMA21 to mean something. */
const MIN_BARS = 22;

db.exec(`
CREATE TABLE IF NOT EXISTS option_scorecards (
  underlying TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  score REAL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS option_scorecards_history (
  underlying TEXT NOT NULL,
  ts TEXT NOT NULL,
  score REAL,
  strategy TEXT,
  m15 REAL,
  h1 REAL,
  d1 REAL,
  PRIMARY KEY (underlying, ts)
) WITHOUT ROWID;
`);

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Trend score -100..100 for a series of bars (oldest first): EMA9 against
 * EMA21 (40%), EMA9's slope over three bars (20%), RSI14 around 50 (20%) and,
 * when a session VWAP is given, price against it (20%). Distances are in
 * units of ATR(14)/price so a quiet stock and a wild one read alike. Null
 * with fewer than 22 bars.
 */
export function trendScore(bars: Bar[], sessionVwap: number | null = null): number | null {
  if (bars.length < MIN_BARS) return null;
  const close = bars[bars.length - 1].close;
  const a = atr(bars, 14);
  const vol = a.length > 0 && close > 0 ? a[a.length - 1].value / close : 0;
  if (!(vol > 0)) return null;
  const e9 = ema(bars, 9);
  const e21 = ema(bars, 21);
  const r = rsi(bars, 14);
  if (e9.length < 4 || e21.length === 0 || r.length === 0) return null;
  const fast = e9[e9.length - 1].value;
  const parts: Array<[number, number]> = [
    [0.4, clamp((fast - e21[e21.length - 1].value) / close / vol / 2, -1, 1)],
    [0.2, clamp((fast - e9[e9.length - 4].value) / close / vol / 2, -1, 1)],
    [0.2, clamp((r[r.length - 1].value - 50) / 30, -1, 1)],
  ];
  if (sessionVwap !== null && sessionVwap > 0) parts.push([0.2, clamp((close / sessionVwap - 1) / vol / 2, -1, 1)]);
  const weight = parts.reduce((sum, p) => sum + p[0], 0);
  return round1((parts.reduce((sum, p) => sum + p[0] * p[1], 0) / weight) * 100);
}

export type Momentum = OptionScorecard["momentum"];

/**
 * The four timeframes from minute bars (oldest first, several sessions),
 * daily bars and the hourly series (cached hours plus today's). The intraday
 * ones include price against today's VWAP. When the hourly series is too short
 * (nothing cached yet) the minute bars are rolled up instead.
 */
export function momentumOf(minute: Bar[], daily: Bar[], hourly?: Bar[]): Momentum {
  const lastDay = minute.length > 0 ? tradingDay(minute[minute.length - 1].ts ?? 0) : null;
  const today = lastDay ? minute.filter((b) => tradingDay(b.ts ?? 0) === lastDay) : [];
  const v = vwap(today);
  const sessionVwap = v.length > 0 ? v[v.length - 1].value : null;
  const score = (minutes: number) => trendScore(rollup(minute, minutes), sessionVwap);
  return { m5: score(5), m15: score(15), h1: (hourly && trendScore(hourly, sessionVwap)) ?? score(60), d1: trendScore(daily) };
}

export type Stretch = {
  /** (price - session VWAP) / ATR(14) of the 15-minute bars. */
  vwapAtr: number | null;
  rsi15: number | null;
  /** Today's change from the previous close, percent. */
  dayMovePct: number | null;
  /** Daily ATR(14) as percent of price: the normal move when hv20 is unknown. */
  dailyAtrPct: number | null;
};

/** Where the stock stands today: the last minute close against VWAP, 15-minute RSI and the previous daily close. */
export function stretchOf(minute: Bar[], dailyCloses: Bar[], prevClose: number | null): Stretch {
  const none: Stretch = { vwapAtr: null, rsi15: null, dayMovePct: null, dailyAtrPct: null };
  const last = minute[minute.length - 1];
  if (!last) return none;
  const day = tradingDay(last.ts ?? 0);
  const v = vwap(minute.filter((b) => tradingDay(b.ts ?? 0) === day));
  const r15 = rollup(minute, 15);
  const a = atr(r15, 14);
  const r = r15.length >= 16 ? rsi(r15, 14) : [];
  const da = atr(dailyCloses, 14);
  const price = last.close;
  return {
    vwapAtr: v.length > 0 && a.length > 0 && a[a.length - 1].value > 0 ? (price - v[v.length - 1].value) / a[a.length - 1].value : null,
    rsi15: r.length > 0 ? r[r.length - 1].value : null,
    dayMovePct: prevClose ? (price / prevClose - 1) * 100 : null,
    dailyAtrPct: da.length > 0 && price > 0 ? (da[da.length - 1].value / price) * 100 : null,
  };
}

export type SetupInputs = {
  momentum: Momentum;
  metrics: OptionMetrics | null;
  /** Stock scorecard composite, 0–100. */
  composite: number | null;
  relVolume: number | null;
  sharesHeld: number;
  /** Next report date (YYYY-MM-DD) or null when unknown. */
  nextEarnings: string | null;
  /** Next ex-dividend date (YYYY-MM-DD) within the calendar's window, or null. */
  nextExDividend?: string | null;
  /** How far the stock has run today, for the long call's stretch check; nulls skip a condition. */
  stretch?: Stretch;
  /** The stock scorecard's group scores, for definitions that gate on them. */
  stockGroups?: Record<string, number | null>;
  today: string;
};

/** The three setups that pass their gates in the active option definition, best first. */
export function buildSetups(i: SetupInputs): OptionSetup[] {
  return evaluateSetups(i).setups;
}

/** buildSetups with the per-strategy trace (which gates passed, terms applied), from the active option definition. */
export function evaluateSetups(i: SetupInputs, def = activeOption()): OptionEvaluation {
  const m = i.metrics;
  return evaluateOption(def, { ctx: optionCtx(i), hasData: m !== null, contracts: { atm_call: m?.atmCall ?? null, atm_put: m?.atmPut ?? null } });
}

const toBar = (d: { close: number; volume: number }): Bar => ({ open: d.close, high: d.close, low: d.close, close: d.close, volume: d.volume });

export type OptionScanResult = {
  scored: number;
  durationMs: number;
  /** When the pass ran (the as-of of the stored scorecards). */
  asOf: string;
  /** The version of the option definition that scored this pass. */
  definition: string;
  /** What each symbol was scored from, and how each strategy fared (gates passed, terms applied). */
  symbols: Array<{ symbol: string; inputs: SetupInputs; evaluation: OptionEvaluation }>;
};

/** Scores every symbol that has a stock universe slot, using the metrics the options layer holds right now. */
export function runOptionScan(symbols: string[], optionMetrics: (symbols: string[]) => Map<string, OptionMetrics>, now = new Date()): OptionScanResult {
  const started = Date.now();
  const today = nyClock(now).date;
  const metrics = optionMetrics(symbols);
  const composites = compositeMap(symbols);
  const groups = groupScoreMap(symbols);
  const def = getActive("option");
  const nowSec = Math.floor(now.getTime() / 1000);
  const exDivs = nextExDividends(symbols, today);
  const earnings = new Map(calendarFor(symbols, today).map((e) => [e.symbol, e.nextEarningsDate ? new Date(e.nextEarningsDate * 1000).toISOString().slice(0, 10) : null]));
  const asOf = now.toISOString();

  const put = db.prepare("INSERT OR REPLACE INTO option_scorecards (underlying, as_of, score, data) VALUES (?, ?, ?, ?)");
  const hist = db.prepare("INSERT OR REPLACE INTO option_scorecards_history (underlying, ts, score, strategy, m15, h1, d1) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let scored = 0;
  const cards: OptionScorecard[] = [];
  const detail: OptionScanResult["symbols"] = [];
  for (const symbol of symbols) {
    const minute = minuteBars(symbol, nowSec - LOOKBACK_DAYS * 86_400, nowSec + 60).map((b) => ({ ...b }) as Bar);
    const daily = loadDaily(symbol);
    const dailyBars = daily.closes.map((c, i) => ({ ...toBar({ close: c, volume: daily.volumes[i] }), time: i }));
    // Today's running price joins the daily series until its own daily bar exists.
    const lastMinute = minute[minute.length - 1];
    if (lastMinute && daily.days.length > 0 && daily.days[daily.days.length - 1] < today && tradingDay(lastMinute.ts ?? 0) === today) {
      dailyBars.push({ time: dailyBars.length, open: lastMinute.close, high: lastMinute.close, low: lastMinute.close, close: lastMinute.close, volume: 0 });
    }
    const prevIdx = daily.days.findIndex((d) => d >= today);
    const prevClose = (prevIdx < 0 ? daily.closes.length : prevIdx) > 0 ? daily.closes[(prevIdx < 0 ? daily.closes.length : prevIdx) - 1] : null;
    const stretch = tradingDay(lastMinute?.ts ?? 0) === today ? stretchOf(minute, dailyBars.slice(0, daily.closes.length), prevClose) : undefined;
    const momentum = momentumOf(minute, dailyBars, hourlySeries(symbol, minute, today, nowSec));
    const m = metrics.get(symbol) ?? null;
    const nextEarnings = earnings.get(symbol) ?? null;
    const live = getLiveScorecard(symbol);
    const rv = live?.factors.find((f) => f.key === "rel_volume")?.value ?? null;
    const inputs: SetupInputs = { momentum, metrics: m, composite: composites.get(symbol) ?? null, relVolume: rv, sharesHeld: sharesHeld(symbol), nextEarnings, nextExDividend: exDivs.get(symbol) ?? null, stretch, stockGroups: groups.get(symbol), today };
    const evaluation = evaluateSetups(inputs, def.definition);
    const setups = evaluation.setups;
    detail.push({ symbol, inputs, evaluation });
    cards.push({
      underlying: symbol,
      asOf,
      score: setups.length > 0 ? setups[0].score : null,
      momentum,
      metrics: m,
      earningsBeforeExpiry: m ? earningsBefore({ metrics: m, nextEarnings, today }) : null,
      nextEarnings,
      setups,
      definition: def.version,
    });
    scored++;
  }
  db.transaction(() => {
    for (const c of cards) {
      put.run(c.underlying, asOf, c.score, JSON.stringify(c));
      hist.run(c.underlying, asOf, c.score, c.setups[0]?.strategy ?? null, c.momentum.m15, c.momentum.h1, c.momentum.d1);
    }
    db.prepare("DELETE FROM option_scorecards WHERE underlying NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(symbols));
    db.prepare("DELETE FROM option_scorecards_history WHERE ts < ?").run(new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString());
  })();
  return { scored, durationMs: Date.now() - started, asOf, definition: def.version, symbols: detail };
}

export function getOptionScorecard(symbol: string): OptionScorecard | null {
  const r = db.prepare("SELECT data FROM option_scorecards WHERE underlying = ?").get(symbol) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as OptionScorecard) : null;
}

export function allOptionScorecards(): OptionScorecard[] {
  return (db.prepare("SELECT data FROM option_scorecards").all() as Array<{ data: string }>).map((r) => JSON.parse(r.data) as OptionScorecard);
}

/** Latest option score per underlying that has one. */
export function optionScores(): Map<string, number> {
  const rows = db.prepare("SELECT underlying, score FROM option_scorecards WHERE score IS NOT NULL").all() as Array<{ underlying: string; score: number }>;
  return new Map(rows.map((r) => [r.underlying, r.score]));
}
