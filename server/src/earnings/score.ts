import { db } from "../db.js";
import { addDays, revisions as computeRevisions, type HistoryPoint } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import { greeks, riskFreeRate, yearsToExpiry } from "../options/black-scholes.js";
import { chain as liveChain, expirations as liveExpirations } from "../providers/alpaca-options.js";
import { isTradingDay, sessionClose } from "../providers/alpaca-calendar.js";
import type { CapBucket, EarningsSetup, EventStats, Gate, Horizon, ReportTime, ScoreComponent } from "./contracts.js";
import { earningsDb } from "./db.js";
import { ALL_KEY, capBucket, capKey, median, poolKey, symKey } from "./stats.js";
import { BANDS, EARNINGS_WEIGHTS_VERSION, GATES, LOW_VOLUME_PENALTY, SETUP, WEIGHTS, type HorizonWeights } from "./weights.js";

// Earnings setups: the five-component score of a (symbol, horizon) for its next
// report. scoreSetup() is pure (inputs in, EarningsSetup out); the loaders below
// batch-read the earnings.db and terminal.db tables so a screen of the whole US
// list needs no network and no per-name round trips beyond a few lookups.

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number | null | undefined, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(digits));
const signed = (x: number | null | undefined, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`);

// ---- inputs ----

export type Candidate = {
  kind: "event" | "next";
  leg: "atm_call" | "otm_call";
  occ: string;
  expiry: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  iv: number | null;
  delta: number | null;
  volume: number | null;
  openInterest: number | null;
};

export type Tech = {
  /** Percent above (+) or below (-) the 20/50/200-day averages. */
  vs20: number | null;
  vs50: number | null;
  vs200: number | null;
  rsi: number | null;
  atrPct: number | null;
  /** The app's momentum group score, 0-100. */
  momentum: number | null;
};

export type ScoreInputs = {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  upcoming: EarningsSetup["upcoming"];
  horizon: Horizon;
  asOf: string;
  price: number | null;
  tech: Tech;
  candidates: Candidate[];
  /** Whether the symbol has listed options at all (any snapshot row ever, or option paths). */
  hasOptions: boolean;
  impliedMovePct: number | null;
  eventPremium: number | null;
  /** Median IV at this entry anchor over the name's past events (for ivVsTypicalAtAnchor). */
  typicalIv: number | null;
  own: EventStats | null;
  pooled: EventStats | null;
  lastReport: EarningsSetup["lastReport"];
  revisions: EarningsSetup["revisions"];
  analyst: EarningsSetup["analyst"];
};

// ---- contract choice ----

const spreadOf = (c: Candidate): number | null => {
  if (c.bid === null || c.ask === null || !(c.bid > 0) || !(c.ask > 0) || c.ask < c.bid) return null;
  return ((c.ask - c.bid) / ((c.bid + c.ask) / 2)) * 100;
};
const daysBetween = (a: string, b: string) => (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000;

/**
 * Intraday and week: the lowest-spread call among the event expiry's ATM and next-strike-up legs.
 * Month: the first expiry (event, else next) at least 25 days from entry; the lowest-spread leg of that expiry.
 */
export function chooseContract(candidates: Candidate[], horizon: Horizon, entryDate: string): Candidate | null {
  let pool = candidates.filter((c) => c.kind === "event");
  if (horizon === "month" && candidates.length > 0) {
    const far = candidates.filter((c) => daysBetween(entryDate, c.expiry) >= 25).sort((x, y) => (x.expiry < y.expiry ? -1 : x.expiry > y.expiry ? 1 : 0));
    if (far.length > 0) pool = far.filter((c) => c.expiry === far[0].expiry);
  }
  if (pool.length === 0) pool = candidates;
  let best: Candidate | null = null;
  let bestSpread = Infinity;
  for (const c of pool) {
    const s = spreadOf(c) ?? 1e9;
    if (s < bestSpread || (s === bestSpread && (c.volume ?? 0) > (best?.volume ?? 0))) {
      best = c;
      bestSpread = s;
    }
  }
  return best;
}

// ---- history blend ----

export function blend(ownN: number, own: number | null, pooled: number | null, prior: number, k: number): number | null {
  const p = pooled ?? prior;
  if (ownN <= 0 || own === null) return pooled ?? (ownN <= 0 ? null : own);
  return (ownN * own + k * p) / (ownN + k);
}

// ---- scoring ----

const comp = (key: ScoreComponent["key"], points: number, max: number, value: ScoreComponent["value"], reason: string): ScoreComponent => ({
  key,
  points: r1(clamp(points, 0, max)),
  max,
  value,
  reason,
});

export function scoreSetup(i: ScoreInputs): EarningsSetup {
  const w: HorizonWeights = WEIGHTS[i.horizon];
  const entryDate = i.asOf.slice(0, 10);
  const c = chooseContract(i.candidates, i.horizon, entryDate);
  const spread = c ? spreadOf(c) : null;
  const mid = c && c.bid !== null && c.ask !== null && c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : null;
  const leverage = c && c.delta !== null && mid !== null && i.price ? (c.delta * i.price) / mid : null;

  // tradability
  let tradPts = 0;
  let tradReason: string;
  if (!c) tradReason = i.hasOptions ? "No live quote in the last 4 days, so there is nothing to trade." : "No listed options for this name, so there is nothing to trade.";
  else if (spread === null) tradReason = `The ${c.expiry} ${c.strike} call has no usable two-sided quote.`;
  else {
    tradPts = w.max.tradability * (1 - spread / 30);
    const lowVol = (c.volume ?? 0) < GATES.minVolume;
    if (lowVol) tradPts -= LOW_VOLUME_PENALTY;
    tradReason = `The ${c.expiry} $${c.strike} call is ${fmt(spread)}% wide (${fmt(c.bid, 2)} / ${fmt(c.ask, 2)}) with ${c.volume ?? "unknown"} contracts traded today${lowVol ? ` (under ${GATES.minVolume}: -${LOW_VOLUME_PENALTY})` : ""}.`;
  }
  const tradability = comp("tradability", tradPts, w.max.tradability, { spreadPct: spread === null ? null : r1(spread), volume: c?.volume ?? null, expiry: c?.expiry ?? null }, tradReason);

  // history
  const ownCall = i.own?.call ?? null;
  const callN = ownCall?.n ?? 0;
  const blendedCall = blend(callN, ownCall?.median ?? null, i.pooled?.call?.median ?? null, 0, w.k);
  const ownStock = i.own?.stock ?? null;
  const stockN = ownStock?.n ?? 0;
  const blendedWin = blend(stockN, ownStock?.winRate ?? null, i.pooled?.stock.winRate ?? null, 0.5, w.k);
  const callPart = blendedCall === null ? (w.max.history - 10) / 2 : (w.max.history - 10) * clamp((blendedCall + 10) / 20, 0, 1);
  const winPart = (blendedWin ?? 0.5) * 10;
  const histReason =
    `${callN} past ${i.horizon} calls had a median of ${signed(ownCall?.median)}% (blended with peers ${signed(blendedCall)}%, k=${w.k}); ` +
    `the stock rose over this window on ${stockN > 0 ? Math.round((ownStock?.winRate ?? 0) * stockN) : 0} of ${stockN} past reports (blended win rate ${fmt((blendedWin ?? 0.5) * 100, 0)}%).`;
  const history = comp("history", callPart + winPart, w.max.history, { callMedian: ownCall?.median ?? null, callN, blendedCallMedian: blendedCall === null ? null : r2(blendedCall), stockWinRate: ownStock?.winRate ?? null, stockN, blendedWinRate: blendedWin === null ? null : r2(blendedWin) }, histReason);

  // setup
  const t = i.tech;
  const scale = w.max.setup / 20;
  let setupPts = 0;
  const above: string[] = [];
  [t.vs20, t.vs50, t.vs200].forEach((v, idx) => {
    if (v !== null && v > 0) {
      setupPts += SETUP.sma[idx] * scale;
      above.push(["20", "50", "200"][idx]);
    }
  });
  const mom = t.momentum === null ? 0 : (t.momentum / SETUP.momentumDiv) * scale;
  setupPts += mom;
  let rsiNote = "";
  if (t.rsi !== null) {
    const hot = SETUP.rsiHot.find(([lvl]) => t.rsi! > lvl);
    if (hot) {
      setupPts -= hot[1];
      rsiNote = ` RSI ${fmt(t.rsi, 0)} is stretched (-${hot[1]}).`;
    } else if (t.rsi < SETUP.rsiColdBelow) {
      setupPts -= SETUP.rsiColdPenalty;
      rsiNote = ` RSI ${fmt(t.rsi, 0)} is a falling knife (-${SETUP.rsiColdPenalty}).`;
    }
  }
  const setup = comp("setup", setupPts, w.max.setup, { vs20: t.vs20, vs50: t.vs50, vs200: t.vs200, rsi: t.rsi, momentum: t.momentum }, `Above its ${above.length ? above.join("/") + "-day average" + (above.length > 1 ? "s" : "") : "no key moving average"} (20d ${signed(t.vs20)}%, 50d ${signed(t.vs50)}%, 200d ${signed(t.vs200)}%), momentum score ${fmt(t.momentum, 0)}.${rsiNote}`);

  // demand
  const last4 = i.own?.reactions.last4 ?? [];
  const ups = last4.filter((x) => x > 0).length;
  const cutoff = addDays(entryDate, -w.analystDays);
  const analyst = i.analyst.filter((a) => a.date >= cutoff);
  const raised = analyst.some((a) => a.priceTarget !== null && /raise|up|increase|higher/i.test(a.action));
  const cut = analyst.some((a) => /cut|down|lower|reduce/i.test(a.action));
  const lr = i.lastReport;
  const epsBeat = lr && lr.epsActual !== null && lr.epsEstimate !== null ? lr.epsActual > lr.epsEstimate : null;
  const revBeat = lr && lr.revenueActual !== null && lr.revenueEstimate !== null ? lr.revenueActual > lr.revenueEstimate : null;
  const beats = (epsBeat ? 1 : 0) + (revBeat ? 1 : 0);
  const driftShare = i.own?.preDrift.rCloseFromPrev.winRate ?? i.pooled?.preDrift.rCloseFromPrev.winRate ?? null;
  const rev30 = i.revisions.eps30d;
  const rev90 = i.revisions.eps90d;
  let demandPts = ups * w.reaction;
  const parts = [`${ups} of the last ${last4.length} reactions were up (+${r1(ups * w.reaction)})`];
  const aPts = (raised ? w.analystRaise : 0) - (cut ? w.analystCut : 0);
  demandPts += aPts;
  parts.push(raised || cut ? `analyst targets ${raised ? "raised" : ""}${raised && cut ? " and " : ""}${cut ? "cut" : ""} in ${w.analystDays} days (${signed(aPts, 0)})` : `no analyst target change in ${w.analystDays} days`);
  const bPts = beats === 2 ? w.beatBoth : beats === 1 ? w.beatOne : 0;
  demandPts += bPts;
  parts.push(lr ? `last quarter ${beats === 2 ? "beat on EPS and revenue" : beats === 1 ? "beat on " + (epsBeat ? "EPS" : "revenue") + " only" : "did not beat"} (+${bPts})` : "no prior report on file");
  let revPts = 0;
  if (w.revEps30 > 0 || w.revEps90 > 0) {
    revPts = (rev30 === null ? 0 : clamp(rev30 / w.revFullPct, -1, 1) * w.revEps30) + (rev90 === null ? 0 : clamp(rev90 / w.revFullPct, -1, 1) * w.revEps90);
    demandPts += revPts;
    parts.push(`EPS consensus revised ${signed(rev30)}% in 30 days and ${signed(rev90)}% in 90 (${signed(revPts)})`);
  }
  const dPts = (driftShare ?? 0) * w.drift;
  demandPts += dPts;
  parts.push(`${driftShare === null ? "no" : fmt(driftShare * 100, 0) + "%"} of past report days closed above the prior close (+${r1(dPts)})`);
  const demand = comp("demand", demandPts, w.max.demand, { upReactionsOfLast4: ups, analystRaise: raised, analystCut: cut, epsBeat, revenueBeat: revBeat, eps30d: rev30, eps90d: rev90, driftUpShare: driftShare }, parts.join("; ") + ".");

  // carry
  const flatCall = i.own?.flatDayCall ?? i.pooled?.flatDayCall ?? null;
  let breakeven: number | null = null;
  let carryPts = 0;
  let decay: number | null = null;
  let target: number | null = null;
  let carryReason = "No contract with a quote and delta to measure break-even.";
  if (c && spread !== null && leverage !== null && leverage > 0) {
    const dte = Math.max(1, daysBetween(i.upcoming.t0, c.expiry) + w.entryLeadDays);
    const holdDays = i.horizon === "intraday" ? 0.27 : i.horizon === "week" ? 5 : 20;
    decay = flatCall !== null ? Math.max(0, -flatCall) : clamp(((holdDays / (2 * Math.max(dte, holdDays))) * 100), 1, i.horizon === "intraday" ? 8 : 20);
    breakeven = (spread + decay) / leverage;
    const iqr = (s: EventStats | null) => (s && s.stock.n >= 5 && s.stock.p25 !== null && s.stock.p75 !== null ? (s.stock.p75 - s.stock.p25) / 2 : null);
    const sessions = i.horizon === "intraday" ? 1 : i.horizon === "week" ? 5 : 20;
    target = i.horizon === "intraday" ? (t.atrPct === null ? null : t.atrPct / 2) : iqr(i.own) ?? iqr(i.pooled) ?? (t.atrPct === null ? null : (t.atrPct / 2) * Math.sqrt(sessions));
    const bePts = target && target > 0 ? w.carryBreakeven * (1 - breakeven / target) : 0;
    const ivx = c.iv !== null && i.typicalIv ? c.iv / i.typicalIv : null;
    const ivPts = w.carryIv > 0 ? (ivx === null ? w.carryIv / 2 : w.carryIv * clamp((1.2 - ivx) / 0.4, 0, 1)) : 0;
    carryPts = Math.max(0, bePts) + ivPts;
    carryReason =
      `Break-even stock move is ${fmt(breakeven, 2)}% ((${fmt(spread)}% spread + ${fmt(decay)}% expected decay) / ${fmt(leverage)}x leverage) against a typical move of ${fmt(target, 2)}%` +
      (w.carryIv > 0 ? `; implied vol is ${ivx === null ? "of unknown cheapness" : fmt(ivx, 2) + "x its usual level at this point"} (${r1(ivPts)}).` : ".");
  }
  const ivVsTypical = c && c.iv !== null && i.typicalIv ? r2(c.iv / i.typicalIv) : null;
  const carry = comp("carry", carryPts, w.max.carry, { breakevenPct: breakeven === null ? null : r2(breakeven), decayPct: decay === null ? null : r1(decay), leverage: leverage === null ? null : r1(leverage), targetMovePct: target === null ? null : r2(target), ivVsTypical }, carryReason);

  const components = [tradability, history, setup, demand, carry];
  const score = Math.round(components.reduce((a, x) => a + x.points, 0));

  const gates: Gate[] = [
    {
      key: "spread",
      passed: spread !== null && spread <= GATES.maxSpreadPct,
      reason: !c ? "No contract to measure." : spread === null ? "No two-sided quote." : `Spread ${fmt(spread)}% ${spread <= GATES.maxSpreadPct ? "is within" : "exceeds"} the ${GATES.maxSpreadPct}% limit.`,
    },
    {
      key: "volume",
      passed: c !== null && (c.volume ?? 0) >= GATES.minVolume,
      reason: !c ? "No contract to measure." : `${c.volume ?? 0} contracts traded today (minimum ${GATES.minVolume}).`,
    },
    { key: "no_options", passed: i.hasOptions || c !== null, reason: i.hasOptions || c ? "Listed options found." : "No listed options for this name (no snapshots or option history)." },
    { key: "unconfirmed_time", passed: i.upcoming.time !== null, reason: i.upcoming.time ? `Report time is ${i.upcoming.time.toUpperCase()} (${i.upcoming.timeSource ?? "unknown source"}).` : "Report time is unknown, so the last full session before the print is a guess." },
    { key: "no_quote", passed: c !== null && mid !== null, reason: c && mid !== null ? "Two-sided quote present." : c ? "No two-sided quote on the chosen contract." : "No live quote in the last 4 days." },
  ];
  const failed = gates.some((g) => !g.passed);
  const verdict: EarningsSetup["verdict"] = failed ? "pass" : score >= BANDS.candidate ? "candidate" : score >= BANDS.conditional ? "conditional" : "pass";

  return {
    symbol: i.symbol,
    name: i.name,
    sector: i.sector,
    industry: i.industry,
    marketCap: i.marketCap,
    upcoming: i.upcoming,
    horizon: i.horizon,
    asOf: i.asOf,
    score,
    verdict,
    components,
    gates,
    contract: c
      ? {
          occ: c.occ, expiry: c.expiry, strike: c.strike, bid: c.bid, ask: c.ask, mid: mid === null ? null : r2(mid),
          spreadPct: spread === null ? null : r1(spread), iv: c.iv, delta: c.delta, volume: c.volume, openInterest: c.openInterest,
          leverage: leverage === null ? null : r1(leverage), breakevenStockMovePct: breakeven === null ? null : r2(breakeven),
        }
      : null,
    live: { price: i.price, impliedMovePct: i.impliedMovePct, eventPremium: i.eventPremium, ivVsTypicalAtAnchor: ivVsTypical },
    history: { own: i.own, pooled: i.pooled, blended: { callMedian: blendedCall === null ? null : r2(blendedCall), stockWinRate: blendedWin === null ? null : r2(blendedWin), k: w.k } },
    lastReport: i.lastReport,
    revisions: i.revisions,
    analyst: i.analyst,
    weightsVersion: EARNINGS_WEIGHTS_VERSION,
  };
}

// ---- loading ----

export type UpcomingRow = {
  symbol: string; report_date: string; time: ReportTime | null; time_source: "fmp" | "press_release" | null; t0: string | null; r: string | null;
  fiscal_period: string | null; eps_estimate: number | null; revenue_estimate: number | null; fmp_confirmed_flag: number | null;
};
type Profile = { name: string | null; sector: string | null; industry: string | null; marketCap: number | null };

const jsonList = (xs: string[]) => JSON.stringify(xs);

function loadProfiles(symbols: string[]): Map<string, Profile> {
  const out = new Map<string, Profile>();
  try {
    for (const r of db.prepare("SELECT symbol, company_name, sector, industry, market_cap FROM bulk_profiles WHERE symbol IN (SELECT value FROM json_each(?))").iterate(jsonList(symbols)) as Iterable<any>) {
      out.set(r.symbol, { name: r.company_name, sector: r.sector, industry: r.industry, marketCap: r.market_cap });
    }
  } catch {
    // table not there yet
  }
  return out;
}

function loadTech(symbols: string[], today: string): Map<string, Tech & { close: number | null }> {
  const out = new Map<string, Tech & { close: number | null }>();
  const list = jsonList(symbols);
  const cards = new Map<string, { vs50: number | null; vs200: number | null; rsi: number | null; momentum: number | null }>();
  const read = (sql: string, ...args: unknown[]) => {
    try {
      for (const r of db.prepare(sql).iterate(...args) as Iterable<any>) {
        if (cards.has(r.symbol)) continue;
        let momentum: number | null = null;
        try {
          momentum = JSON.parse(r.groups)?.momentum ?? null;
        } catch { /* keep null */ }
        cards.set(r.symbol, { vs50: r.vs50 === null ? null : r.vs50 * 100, vs200: r.vs200 === null ? null : r.vs200 * 100, rsi: r.rsi, momentum });
      }
    } catch {
      // scorecards not there yet
    }
  };
  const cols = "symbol, groups, json_extract(factors, '$.vs_sma50[0]') AS vs50, json_extract(factors, '$.vs_sma200[0]') AS vs200, json_extract(factors, '$.rsi14[0]') AS rsi";
  read(`SELECT ${cols} FROM scorecards_live WHERE symbol IN (SELECT value FROM json_each(?))`, list);
  read(`SELECT ${cols} FROM scorecards WHERE day = (SELECT MAX(day) FROM scorecards) AND symbol IN (SELECT value FROM json_each(?))`, list);

  const bars = new Map<string, Array<[number, number, number]>>();
  for (const r of db.prepare("SELECT symbol, close, high, low FROM daily_bars WHERE symbol IN (SELECT value FROM json_each(?)) AND day >= ? ORDER BY symbol, day").raw(true).iterate(list, addDays(today, -45)) as Iterable<[string, number, number, number]>) {
    let b = bars.get(r[0]);
    if (!b) bars.set(r[0], (b = []));
    b.push([r[1], r[2], r[3]]);
  }
  for (const s of symbols) {
    const b = bars.get(s) ?? [];
    const card = cards.get(s);
    const close = b.length > 0 ? b[b.length - 1][0] : null;
    let vs20: number | null = null;
    if (b.length >= 20 && close) vs20 = (close / (b.slice(-20).reduce((a, x) => a + x[0], 0) / 20) - 1) * 100;
    let atrPct: number | null = null;
    if (b.length >= 15 && close) {
      let sum = 0;
      for (let k = b.length - 14; k < b.length; k++) sum += Math.max(b[k][1] - b[k][2], Math.abs(b[k][1] - b[k - 1][0]), Math.abs(b[k][2] - b[k - 1][0]));
      atrPct = (sum / 14 / close) * 100;
    }
    out.set(s, { vs20, vs50: card?.vs50 ?? null, vs200: card?.vs200 ?? null, rsi: card?.rsi ?? null, atrPct, momentum: card?.momentum ?? null, close });
  }
  return out;
}

type SnapRow = Record<string, any>;
function loadSnapshots(symbols: string[], sinceIso: string): Map<string, { event?: SnapRow; next?: SnapRow }> {
  const out = new Map<string, { event?: SnapRow; next?: SnapRow }>();
  const rows = earningsDb
    .prepare(
      `SELECT s.* FROM snapshots s JOIN (
         SELECT symbol, expiry_kind, MAX(ts) AS ts FROM snapshots WHERE ts >= ? AND symbol IN (SELECT value FROM json_each(?)) GROUP BY symbol, expiry_kind
       ) m ON s.symbol = m.symbol AND s.ts = m.ts AND s.expiry_kind = m.expiry_kind`
    )
    .all(sinceIso, jsonList(symbols)) as SnapRow[];
  for (const r of rows) {
    let slot = out.get(r.symbol);
    if (!slot) out.set(r.symbol, (slot = {}));
    if (r.expiry_kind === "event") slot.event = r;
    else if (r.expiry_kind === "next") slot.next = r;
  }
  return out;
}

/** Calls of one snapshot row: the ATM call and the next strike up, with stored deltas (Black-Scholes only where null). */
function snapCandidates(r: SnapRow, kind: "event" | "next", nowMs: number): Candidate[] {
  const out: Candidate[] = [];
  const delta = (stored: number | null, iv: number | null, strike: number): number | null => {
    if (stored !== null && stored !== undefined) return stored;
    if (!iv || !r.spot || !strike || !r.expiry) return null;
    try {
      return greeks({ right: "call", spot: r.spot, strike, t: yearsToExpiry(r.expiry, nowMs, sessionClose), rate: riskFreeRate(), vol: iv }).delta;
    } catch {
      return null;
    }
  };
  if (r.call_occ && r.expiry) {
    out.push({ kind, leg: "atm_call", occ: r.call_occ, expiry: r.expiry, strike: r.call_strike, bid: r.call_bid, ask: r.call_ask, iv: r.call_iv, delta: delta(r.call_delta, r.call_iv, r.call_strike), volume: r.call_volume, openInterest: r.call_oi });
  }
  if (r.otm_occ && r.expiry) {
    out.push({ kind, leg: "otm_call", occ: r.otm_occ, expiry: r.expiry, strike: r.otm_strike, bid: r.otm_bid, ask: r.otm_ask, iv: r.otm_iv, delta: delta(r.otm_delta, r.otm_iv, r.otm_strike), volume: r.otm_volume, openInterest: r.otm_oi });
  }
  return out;
}

function loadStats(keys: string[], horizon: Horizon): Map<string, EventStats> {
  const out = new Map<string, EventStats>();
  const want = [...new Set(keys)];
  for (const r of earningsDb.prepare("SELECT scope_key, time, json FROM stats WHERE horizon = ? AND scope_key IN (SELECT value FROM json_each(?))").iterate(horizon, jsonList(want)) as Iterable<{ scope_key: string; time: string; json: string }>) {
    out.set(`${r.scope_key}|${r.time}`, JSON.parse(r.json) as EventStats);
  }
  return out;
}

export type EnrichOptions = { now?: Date; live?: (symbol: string, row: UpcomingRow) => Promise<{ price: number | null; candidates: Candidate[] } | null> };

/** Everything scoreSetup needs for these upcoming rows, read in batches. */
export function gather(rows: UpcomingRow[], horizon: Horizon, now = new Date()): ScoreInputs[] {
  if (rows.length === 0) return [];
  const today = nyClock(now).date;
  const symbols = rows.map((r) => r.symbol);
  const profiles = loadProfiles(symbols);
  const tech = loadTech(symbols, today);
  const snaps = loadSnapshots(symbols, addDays(today, -4) + "T00:00:00Z");

  // Stats: own and the pool chain.
  const keys: string[] = [];
  for (const r of rows) {
    const p = profiles.get(r.symbol);
    const cap = capBucket(p?.marketCap);
    keys.push(symKey(r.symbol), ALL_KEY);
    if (cap) keys.push(capKey(cap));
    if (cap && p?.sector) keys.push(poolKey(p.sector, cap));
  }
  const stats = loadStats(keys, horizon);
  const pick = (key: string, time: ReportTime | null, minN: number): EventStats | null => {
    const t = time ? stats.get(`${key}|${time}`) : undefined;
    if (t && t.n >= minN) return t;
    return stats.get(`${key}|any`) ?? null;
  };

  const lastStmt = earningsDb.prepare(
    `SELECT e.report_date AS d, e.eps_actual, e.eps_estimate, e.revenue_actual, e.revenue_estimate, p.t0_close, p.r_close
     FROM events e LEFT JOIN stock_paths p ON p.symbol = e.symbol AND p.report_date = e.report_date
     WHERE e.symbol = ? AND e.report_date < ? AND e.confirmed = 1 AND e.t0 IS NOT NULL ORDER BY e.report_date DESC LIMIT 1`
  );

  // Analyst actions in the last 30 days.
  const analyst = new Map<string, EarningsSetup["analyst"]>();
  const symbolSet = new Set(symbols);
  for (const a of earningsDb.prepare("SELECT symbol, date, firm, action, price_target, prior_price_target FROM analyst_actions WHERE date >= ? ORDER BY date DESC").iterate(addDays(today, -30)) as Iterable<any>) {
    if (!symbolSet.has(a.symbol)) continue;
    let list = analyst.get(a.symbol);
    if (!list) analyst.set(a.symbol, (list = []));
    const raise = a.price_target !== null && a.prior_price_target !== null && a.price_target > a.prior_price_target;
    const cutIt = a.price_target !== null && a.prior_price_target !== null && a.price_target < a.prior_price_target;
    const action = /raise|cut|lower|up|down|increase|decrease|reduce/i.test(a.action) ? a.action : raise ? `${a.action} (target raised)` : cutIt ? `${a.action} (target cut)` : a.action;
    list.push({ date: a.date, firm: a.firm || null, action, priceTarget: a.price_target });
  }

  // Consensus revisions, from the terminal.db snapshots of the exact report dates.
  const minDate = rows.reduce((m, r) => (r.report_date < m ? r.report_date : m), rows[0].report_date);
  const maxDate = rows.reduce((m, r) => (r.report_date > m ? r.report_date : m), rows[0].report_date);
  const hist = new Map<string, HistoryPoint[]>();
  try {
    for (const h of db.prepare("SELECT symbol, report_date, captured_day AS day, eps_estimate AS eps, revenue_estimate AS revenue FROM estimate_snapshots WHERE report_date BETWEEN ? AND ? ORDER BY symbol, report_date, captured_day").iterate(minDate, maxDate) as Iterable<any>) {
      if (!symbolSet.has(h.symbol)) continue;
      const k = `${h.symbol}|${h.report_date}`;
      let l = hist.get(k);
      if (!l) hist.set(k, (l = []));
      l.push({ day: h.day, eps: h.eps, revenue: h.revenue });
    }
  } catch { /* table missing */ }

  // Typical IV at this horizon's entry anchor, per symbol.
  const entry = horizon === "intraday" ? "T0:10:00" : horizon === "week" ? "T0-5" : "T0-20";
  const ivs = new Map<string, number[]>();
  for (const r of earningsDb.prepare("SELECT symbol, iv_at_entry AS iv FROM option_paths WHERE entry = ? AND expiry_kind = 'event' AND leg = 'atm_call' AND iv_at_entry IS NOT NULL AND symbol IN (SELECT value FROM json_each(?))").iterate(entry, jsonList(symbols)) as Iterable<{ symbol: string; iv: number }>) {
    let l = ivs.get(r.symbol);
    if (!l) ivs.set(r.symbol, (l = []));
    l.push(r.iv);
  }

  const everSnap = earningsDb.prepare("SELECT 1 FROM snapshots WHERE symbol = ? LIMIT 1");
  const anyPath = earningsDb.prepare("SELECT 1 FROM option_paths WHERE symbol = ? LIMIT 1");
  return rows.map((row) => {
    const p = profiles.get(row.symbol);
    const cap = capBucket(p?.marketCap);
    const t = tech.get(row.symbol)!;
    const snap = snaps.get(row.symbol);
    const own = pick(symKey(row.symbol), row.time, 3);
    let pooled: EventStats | null = null;
    if (cap && p?.sector) {
      const cand = pick(poolKey(p.sector, cap), row.time, 20);
      if (cand && cand.n >= 20) pooled = cand;
    }
    if (!pooled && cap) pooled = pick(capKey(cap), row.time, 20);
    if (!pooled) pooled = pick(ALL_KEY, row.time, 20);

    const candidates: Candidate[] = [];
    if (snap?.event) candidates.push(...snapCandidates(snap.event, "event", now.getTime()));
    if (snap?.next) candidates.push(...snapCandidates(snap.next, "next", now.getTime()));
    const last = lastStmt.get(row.symbol, row.report_date) as any;
    const lastReport = last
      ? { date: last.d, epsActual: last.eps_actual, epsEstimate: last.eps_estimate, revenueActual: last.revenue_actual, revenueEstimate: last.revenue_estimate, reactionPct: last.t0_close && last.r_close ? Math.round((last.r_close / last.t0_close - 1) * 1e4) / 100 : null }
      : null;
    const rv = hist.get(`${row.symbol}|${row.report_date}`);
    const revs = rv ? computeRevisions(rv, today) : null;
    const asOf = snap?.event?.ts ?? snap?.next?.ts ?? now.toISOString();
    return {
      symbol: row.symbol,
      name: p?.name ?? null,
      sector: p?.sector ?? null,
      industry: p?.industry ?? null,
      marketCap: p?.marketCap ?? null,
      upcoming: { reportDate: row.report_date, time: row.time, timeSource: row.time_source, fmpConfirmed: row.fmp_confirmed_flag === null ? null : row.fmp_confirmed_flag === 1, t0: row.t0 ?? row.report_date, epsEstimate: row.eps_estimate, revenueEstimate: row.revenue_estimate, fiscalPeriod: row.fiscal_period },
      horizon,
      asOf,
      price: snap?.event?.spot ?? snap?.next?.spot ?? t.close,
      tech: t,
      candidates,
      hasOptions: candidates.length > 0 || everSnap.get(row.symbol) !== undefined || anyPath.get(row.symbol) !== undefined,
      impliedMovePct: snap?.event?.implied_move_pct ?? null,
      eventPremium: snap?.event?.event_premium ?? null,
      typicalIv: median(ivs.get(row.symbol) ?? []),
      own,
      pooled,
      lastReport,
      revisions: { eps30d: revs?.["30d"].eps ?? null, eps90d: revs?.["90d"].eps ?? null, revenue30d: revs?.["30d"].revenue ?? null },
      analyst: analyst.get(row.symbol) ?? [],
    };
  });
}

// ---- screen ----

export type ScreenParams = {
  from?: string; to?: string; horizon?: Horizon; time?: ReportTime; sector?: string; industry?: string;
  minCap?: number; maxCap?: number; minScore?: number; verdict?: EarningsSetup["verdict"]; tradable?: boolean;
  symbols?: string[]; sort?: ScreenSort; limit?: number;
};
export const SCREEN_SORTS = ["score", "symbol", "cap", "date", "spread", "impliedMove"] as const;
export type ScreenSort = (typeof SCREEN_SORTS)[number];

/** The session a trade made now would be about: today before the close on a trading day, else the next one. */
export function nextSession(now = new Date()): string {
  const ny = nyClock(now);
  let day = ny.date;
  if (!(isTradingDay(day) && ny.hour < 16)) day = addDays(day, 1);
  while (!isTradingDay(day)) day = addDays(day, 1);
  return day;
}

const UPCOMING_COLS = "symbol, report_date, time, time_source, t0, r, fiscal_period, eps_estimate, revenue_estimate, fmp_confirmed_flag";

/** Upcoming rows that match the date window (by report date or T0), one per symbol (the earliest). */
export function upcomingRows(p: { from?: string; to?: string; symbols?: string[]; time?: ReportTime }, now = new Date()): UpcomingRow[] {
  const from = p.from ?? nextSession(now);
  const to = p.to ?? (p.from ? p.from : from);
  const rows = earningsDb
    .prepare(`SELECT ${UPCOMING_COLS} FROM upcoming WHERE (report_date BETWEEN @from AND @to OR t0 BETWEEN @from AND @to) ORDER BY report_date, symbol`)
    .all({ from, to }) as UpcomingRow[];
  const seen = new Set<string>();
  const set = p.symbols ? new Set(p.symbols.map((s) => s.toUpperCase())) : null;
  return rows.filter((r) => {
    if (seen.has(r.symbol) || (set && !set.has(r.symbol)) || (p.time && r.time !== p.time)) return false;
    seen.add(r.symbol);
    return true;
  });
}

export function screen(params: ScreenParams, now = new Date()): EarningsSetup[] {
  const horizon = params.horizon ?? "intraday";
  let rows = upcomingRows(params, now);
  // Cheap profile filters before scoring.
  if (params.sector || params.industry || params.minCap !== undefined || params.maxCap !== undefined) {
    const prof = loadProfiles(rows.map((r) => r.symbol));
    rows = rows.filter((r) => {
      const p = prof.get(r.symbol);
      if (params.sector && p?.sector?.toLowerCase() !== params.sector.toLowerCase()) return false;
      if (params.industry && p?.industry?.toLowerCase() !== params.industry.toLowerCase()) return false;
      if (params.minCap !== undefined && !(p?.marketCap !== null && p?.marketCap !== undefined && p.marketCap >= params.minCap)) return false;
      if (params.maxCap !== undefined && !(p?.marketCap !== null && p?.marketCap !== undefined && p.marketCap <= params.maxCap)) return false;
      return true;
    });
  }
  let out = gather(rows, horizon, now).map(scoreSetup);
  if (params.minScore !== undefined) out = out.filter((s) => s.score >= params.minScore!);
  if (params.verdict) out = out.filter((s) => s.verdict === params.verdict);
  if (params.tradable) out = out.filter((s) => s.gates.every((g) => g.passed));
  const sort = params.sort ?? "score";
  const key: Record<ScreenSort, (s: EarningsSetup) => number | string> = {
    score: (s) => -s.score,
    symbol: (s) => s.symbol,
    cap: (s) => -(s.marketCap ?? -1),
    date: (s) => s.upcoming.reportDate,
    spread: (s) => s.contract?.spreadPct ?? 1e9,
    impliedMove: (s) => -(s.live.impliedMovePct ?? -1),
  };
  const k = key[sort];
  out.sort((a, b) => {
    const x = k(a);
    const y = k(b);
    return (x < y ? -1 : x > y ? 1 : 0) || -(a.score - b.score) || (a.symbol < b.symbol ? -1 : 1);
  });
  return params.limit ? out.slice(0, params.limit) : out;
}

// ---- one setup ----

/**
 * The setup for a symbol's next report. Reads the latest stored snapshot; with none (and only here, never in screen)
 * asks Alpaca for the live chain of the event and next expiries.
 */
export async function setupFor(symbol: string, horizon: Horizon, opts: EnrichOptions = {}): Promise<EarningsSetup | null> {
  const now = opts.now ?? new Date();
  const sym = symbol.toUpperCase();
  const today = nyClock(now).date;
  const row = earningsDb
    .prepare(`SELECT ${UPCOMING_COLS} FROM upcoming WHERE symbol = ? AND report_date >= ? ORDER BY report_date LIMIT 1`)
    .get(sym, addDays(today, -1)) as UpcomingRow | undefined;
  if (!row) return null;
  const [input] = gather([row], horizon, now);
  if (input.candidates.length === 0) {
    try {
      const live = await (opts.live ?? liveCandidates)(sym, row);
      if (live) {
        input.candidates = live.candidates;
        input.price = live.price ?? input.price;
        input.asOf = now.toISOString();
      }
    } catch {
      // no live data: the setup reports no_options / no_quote
    }
  }
  return scoreSetup(input);
}

/** Live fallback: ATM and next-strike-up calls of the event expiry (first on or after R) and the next expiry after it. */
async function liveCandidates(symbol: string, row: UpcomingRow): Promise<{ price: number | null; candidates: Candidate[] } | null> {
  const r = row.r ?? row.report_date;
  const expiries = await liveExpirations(symbol);
  const event = expiries.find((e) => e >= r);
  const next = event ? expiries.find((e) => e > event) : undefined;
  const out: Candidate[] = [];
  let price: number | null = null;
  for (const [kind, expiry] of [["event", event], ["next", next]] as const) {
    if (!expiry) continue;
    const ch = await liveChain(symbol, { expiry });
    price = ch.underlyingPrice ?? price;
    if (!ch.underlyingPrice) continue;
    const calls = ch.calls.filter((x) => x.strike !== null && x.contract);
    const atm = [...calls].sort((a, b) => Math.abs(a.strike! - ch.underlyingPrice!) - Math.abs(b.strike! - ch.underlyingPrice!))[0];
    const otm = calls.filter((x) => atm && x.strike! > atm.strike!)[0];
    for (const [leg, x] of [["atm_call", atm], ["otm_call", otm]] as const) {
      if (x) out.push({ kind, leg, occ: x.contract, expiry, strike: x.strike!, bid: x.bid, ask: x.ask, iv: x.impliedVolatility, delta: x.delta, volume: x.volume, openInterest: x.openInterest });
    }
  }
  return out.length > 0 ? { price, candidates: out } : null;
}

export type { CapBucket };
