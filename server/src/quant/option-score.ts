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
import { compositeMap, getLiveScorecard, loadDaily } from "./stock-score.js";

// Option scorecards: intraday-to-swing momentum of the underlying plus three
// heuristic setups (buy a call, sell a cash-secured put, sell a covered call)
// scored from momentum, IV and the stock scorecard. These are screens for the
// user's eyes, not trading signals; every setup spells out its reasons.

// ---- thresholds (all in one place) ----

/** Momentum score (-100..100) at or above which a timeframe counts as strongly up. */
export const STRONG_MOMENTUM = 40;
/** |momentum| at or below this counts as flat, for covered calls. */
export const FLAT_MOMENTUM = 20;
/** Daily trend (-100..100) needed to buy a call: a real uptrend, not just "not down". */
export const D1_MIN_LONG_CALL = 25;
/** A long call is stretched when price is more than this many 15-minute ATRs above the session VWAP. */
export const STRETCH_VWAP_ATR = 2;
/** ...or the 15-minute RSI(14) is above this. */
export const STRETCH_RSI_15M = 75;
/** ...or today's gain from the previous close is more than this multiple of the stock's normal daily move. */
export const STRETCH_DAY_MOVE_MULT = 1.5;
/** Points taken off per stretch condition met, up to STRETCH_PENALTY_CAP. */
export const STRETCH_PENALTY = 10;
export const STRETCH_PENALTY_CAP = 30;
/** A daily trend at or below this blocks selling a put ("not strongly negative"). */
export const D1_STRONGLY_NEGATIVE = -50;
/** Relative volume (time-of-day adjusted) counted as high. */
export const REL_VOLUME_HIGH = 1.5;
/** IV rank at or below this is cheap, at or above IV_RANK_RICH is rich (0–100). */
export const IV_RANK_CHEAP = 30;
export const IV_RANK_RICH = 60;
/** Without an IV rank: iv30 up to this multiple of hv20 is "not expensive" for buying. */
export const IV_VS_HV_NOT_EXPENSIVE = 1.2;
/** Without an IV rank: iv30 above this multiple of hv20 is "rich" for selling. */
export const IV_VS_HV_RICH = 1.0;
/** Stock composite (0–100) needed to be happy to be assigned shares on a short put. */
export const WOULD_OWN_COMPOSITE = 60;
/** Shares per option contract needed for a covered call. */
export const SHARES_PER_CONTRACT = 100;
/** Points taken off a setup when earnings fall before its expiry. */
export const EARNINGS_PENALTY = { long_call: 25, short_put: 15, covered_call: 10 } as const;
/** Points taken off when an ex-dividend date falls before expiry: early assignment risk for a short call, a small note for a short put. */
export const EX_DIVIDEND_PENALTY = { covered_call: 30, short_put: 3 } as const;
/** Every setup that passes its gates starts here and earns the rest from its factors. */
const SETUP_BASE = 40;
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

/** The stretch conditions met, as words with their values, and the points they cost. */
export function stretchCheck(st: Stretch | undefined, hv20: number | null): { penalty: number; text: string | null } {
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
  today: string;
};

const pct = (x: number) => `${Math.round(x)}`;

/** 0 (rich) .. 1 (cheap) from IV rank, or from iv30 against hv20 when there is no rank; null when neither is known. */
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

/** 0..1 how rich IV is for selling; null when unknown. */
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
  // Without an expiry, or without a known report date, nothing can be said either way.
  if (!expiry || !i.nextEarnings) return { before: null, text: null };
  const before = i.nextEarnings >= i.today && i.nextEarnings <= expiry;
  return { before, text: before ? `earnings on ${i.nextEarnings} fall before the ${expiry} expiry` : null };
}

/** The ex-dividend date if it falls from today up to the contract's expiry. */
function exDividendBefore(i: SetupInputs): string | null {
  const expiry = i.metrics?.atmExpiry;
  const ex = i.nextExDividend;
  return expiry && ex && ex >= i.today && ex <= expiry ? ex : null;
}

/** The three setups that pass their gates, best first. */
export function buildSetups(i: SetupInputs): OptionSetup[] {
  const m = i.metrics;
  if (!m) return [];
  const { m15, h1, d1 } = i.momentum;
  const earn = earningsNote(i);
  const out: OptionSetup[] = [];

  // Buy a call: momentum up on the 15-minute and hourly charts and a real daily uptrend.
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
      const stretched = stretchCheck(i.stretch, m.hv20);
      if (stretched.text) {
        score -= stretched.penalty;
        reasons.push(stretched.text);
      }
      out.push({ strategy: "long_call", score: round1(clamp(score, 0, 100)), contract: m.atmCall, reasons });
    }
  }

  // Sell a cash-secured put: a stock worth owning, rich IV, not falling hard.
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

  // Sell a covered call: only against shares held, rich IV, no momentum to give away.
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

const toBar = (d: { close: number; volume: number }): Bar => ({ open: d.close, high: d.close, low: d.close, close: d.close, volume: d.volume });

export type OptionScanResult = { scored: number; durationMs: number };

/** Scores every symbol that has a stock universe slot, using the metrics the options layer holds right now. */
export function runOptionScan(symbols: string[], optionMetrics: (symbols: string[]) => Map<string, OptionMetrics>, now = new Date()): OptionScanResult {
  const started = Date.now();
  const today = nyClock(now).date;
  const metrics = optionMetrics(symbols);
  const composites = compositeMap(symbols);
  const nowSec = Math.floor(now.getTime() / 1000);
  const exDivs = nextExDividends(symbols, today);
  const earnings = new Map(calendarFor(symbols, today).map((e) => [e.symbol, e.nextEarningsDate ? new Date(e.nextEarningsDate * 1000).toISOString().slice(0, 10) : null]));
  const asOf = now.toISOString();

  const put = db.prepare("INSERT OR REPLACE INTO option_scorecards (underlying, as_of, score, data) VALUES (?, ?, ?, ?)");
  const hist = db.prepare("INSERT OR REPLACE INTO option_scorecards_history (underlying, ts, score, strategy, m15, h1, d1) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let scored = 0;
  const cards: OptionScorecard[] = [];
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
    const setups = buildSetups({ momentum, metrics: m, composite: composites.get(symbol) ?? null, relVolume: rv, sharesHeld: sharesHeld(symbol), nextEarnings, nextExDividend: exDivs.get(symbol) ?? null, stretch, today });
    const earn = m ? earningsNote({ momentum, metrics: m, composite: null, relVolume: null, sharesHeld: 0, nextEarnings, today }) : { before: null };
    cards.push({
      underlying: symbol,
      asOf,
      score: setups.length > 0 ? setups[0].score : null,
      momentum,
      metrics: m,
      earningsBeforeExpiry: earn.before,
      nextEarnings,
      setups,
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
  return { scored, durationMs: Date.now() - started };
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
