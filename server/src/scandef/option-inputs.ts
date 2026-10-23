import type { SetupInputs } from "../quant/option-score.js";
import type { Ctx } from "./dsl.js";
import { STOCK_GROUPS } from "./factors.js";

// Maps what the option scan knows about a symbol onto the option catalog's keys.

const bit = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0);
const SHARES_PER_CONTRACT = 100;

/** Whether the next report falls from today up to the expiry; null without an expiry or a known date. */
export function earningsBefore(i: Pick<SetupInputs, "metrics" | "nextEarnings" | "today">): boolean | null {
  const expiry = i.metrics?.atmExpiry;
  if (!expiry || !i.nextEarnings) return null;
  return i.nextEarnings >= i.today && i.nextEarnings <= expiry;
}

/** The ex-dividend date if it falls from today up to the contract's expiry. */
export function exDividendBefore(i: Pick<SetupInputs, "metrics" | "nextExDividend" | "today">): string | null {
  const expiry = i.metrics?.atmExpiry;
  const ex = i.nextExDividend;
  return expiry && ex && ex >= i.today && ex <= expiry ? ex : null;
}

function spreadPct(q: { bid: number | null; ask: number | null } | null | undefined): number | null {
  if (!q || q.bid === null || q.ask === null) return null;
  const mid = (q.bid + q.ask) / 2;
  return mid > 0 ? ((q.ask - q.bid) / mid) * 100 : null;
}

const dayDiff = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The catalog values (option scope) for one symbol's inputs. */
export function optionCtx(i: SetupInputs & { stockGroups?: Record<string, number | null> }): Ctx {
  const m = i.metrics;
  const st = i.stretch;
  const hv = m?.hv20 ?? null;
  const usual = hv !== null && hv > 0 ? (hv / Math.sqrt(252)) * 100 : (st?.dailyAtrPct ?? null);
  const usualOk = usual !== null && usual > 0 ? usual : null;
  const dayMove = st?.dayMovePct ?? null;
  const ex = exDividendBefore(i);
  const expiry = m?.atmExpiry ?? null;
  const ctx: Ctx = {
    m5: i.momentum.m5,
    m15: i.momentum.m15,
    h1: i.momentum.h1,
    d1: i.momentum.d1,
    price: m?.price ?? null,
    atm_iv: m?.atmIv ?? null,
    iv30: m?.iv30 ?? null,
    iv_rank: m?.ivRank ?? null,
    iv_percentile: m?.ivPercentile ?? null,
    iv_history_days: m?.ivHistoryDays ?? null,
    hv20: hv,
    implied_move_pct: m?.impliedMovePct ?? null,
    term_slope: m?.termSlope ?? null,
    put_call_volume_ratio: m?.putCallVolumeRatio ?? null,
    unusual_count: m ? m.unusual.length : null,
    atm_call_bid: m?.atmCallQuote?.bid ?? null,
    atm_call_ask: m?.atmCallQuote?.ask ?? null,
    atm_call_delta: m?.atmCallQuote?.delta ?? null,
    atm_call_spread_pct: spreadPct(m?.atmCallQuote),
    atm_put_bid: m?.atmPutQuote?.bid ?? null,
    atm_put_ask: m?.atmPutQuote?.ask ?? null,
    atm_put_delta: m?.atmPutQuote?.delta ?? null,
    atm_put_spread_pct: spreadPct(m?.atmPutQuote),
    rel_volume: i.relVolume,
    vwap_atr_distance: st?.vwapAtr ?? null,
    rsi_15m: st?.rsi15 ?? null,
    day_move_pct: dayMove,
    usual_day_move_pct: usualOk,
    day_move_vs_usual: dayMove !== null && usualOk !== null ? dayMove / usualOk : null,
    earnings_before_expiry: bit(earningsBefore(i)),
    ex_dividend_before_expiry: expiry && i.nextExDividend ? bit(ex !== null) : null,
    next_earnings: i.nextEarnings,
    next_ex_dividend: i.nextExDividend ?? null,
    atm_expiry: expiry,
    days_to_expiry: expiry ? dayDiff(i.today, expiry) : null,
    stock_composite: i.composite,
    shares_held: i.sharesHeld,
    contracts_covered: Math.floor(i.sharesHeld / SHARES_PER_CONTRACT),
    put_cash_required: m?.price != null ? m.price * 100 : null,
  };
  for (const g of STOCK_GROUPS) ctx[`${g}_score`] = i.stockGroups?.[g] ?? null;
  return ctx;
}
