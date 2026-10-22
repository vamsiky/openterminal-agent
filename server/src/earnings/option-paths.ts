import { mapWithConcurrency } from "../concurrency.js";
import { db } from "../db.js";
import { tradingDay } from "../history/time.js";
import { nyInstant } from "../live/session.js";
import { impliedVol, riskFreeRate } from "../options/black-scholes.js";
import { daysBetween } from "../options/selection.js";
import { ensureCalendar, isTradingDay, sessionClose } from "../providers/alpaca-calendar.js";
import { optionDailyBars, optionIntradayBars, type OptionDayBar } from "../providers/alpaca-options.js";
import { listContracts, type OptionContract } from "../providers/alpaca-trading.js";
import type { Anchor, ExpiryKind, Leg, OptionLegPath } from "./contracts.js";
import { earningsDb } from "./db.js";

// Historical option paths around earnings. For each confirmed event the
// strike ladder near the stock's entry prices is fetched as daily bars
// (expired contracts included, from Alpaca's inactive contract list), the
// ATM-ish contracts get 15-minute bars on T0-1, T0 and R, and then every
// (entry, expiry kind, leg) is turned into an OptionLegPath: the contract is
// picked at entry and its price is read at every later anchor through
// R:close. Nothing is re-centred.
//
// Prices are last trades, so thin contracts have gaps. Daily anchors use the
// day's close (or open for :open anchors); the 10:00 and 15:45 anchors use the
// close of the 15-minute bar ending then, else the last bar ending within 45
// minutes before, else null. A leg is only stored when it has a price at
// entry; the strike is the nearest one that traded at entry (looking at most
// two strikes away), so a dead strike does not drop the whole event.

export const DEFAULT_SINCE = "2024-02-01"; // Alpaca option bars start around Feb 2024
export const ENTRIES: Anchor[] = ["T0-20", "T0-10", "T0-5", "T0-2", "T0-1", "T0:10:00"];
export const TRACK_ORDER: Anchor[] = ["T0-20", "T0-10", "T0-5", "T0-2", "T0-1", "T0:open", "T0:10:00", "T0:15:45", "T0:close", "R:open", "R:close"];
export const LEGS: Leg[] = ["atm_call", "otm_call", "atm_put"];
export const EXPIRY_KINDS: ExpiryKind[] = ["event", "swing"];
const SWING_MIN_DAYS = 21;
const LISTING_DAYS = 80; // from R: covers the swing expiry on monthly-only names
const LADDER_NEIGHBORS = 3; // strikes each side of every entry spot that get daily bars
const BAR_BATCH = 200;
const SPARSE_MINUTES = 45;
const BAR_MINUTES = 15;
const SYMBOL_CONCURRENCY = 32; // the shared throttle, not latency, should be the limit
const TASK = "options";

const SPOT_COLUMN: Record<string, string> = {
  "T0-20": "t0_m20", "T0-10": "t0_m10", "T0-5": "t0_m5", "T0-2": "t0_m2", "T0-1": "t0_m1", "T0:10:00": "t0_1000", "T0:open": "t0_open", "T0:close": "t0_close",
};

export type Stats = { requests: number };
export type EventRef = { symbol: string; reportDate: string };
type EventRow = { symbol: string; report_date: string; t0: string; r: string };
type Bar = OptionDayBar;

// ---- calendar helpers --------------------------------------------------------

/** The trading day `n` sessions from `day` (negative = earlier). `day` itself may be a non-session. */
export function addSessions(day: string, n: number): string {
  let d = Date.parse(`${day}T00:00:00Z`);
  const step = n < 0 ? -86_400_000 : 86_400_000;
  let left = Math.abs(n);
  while (left > 0) {
    d += step;
    if (isTradingDay(new Date(d).toISOString().slice(0, 10))) left--;
  }
  return new Date(d).toISOString().slice(0, 10);
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The session an anchor refers to, and how its price is read. */
export function anchorDay(anchor: Anchor, t0: string, r: string): { day: string; kind: "open" | "close" | "1000" | "1545" } {
  const m = anchor.match(/^T0-(\d+)$/);
  if (m) return { day: addSessions(t0, -Number(m[1])), kind: "close" };
  switch (anchor) {
    case "T0:open": return { day: t0, kind: "open" };
    case "T0:10:00": return { day: t0, kind: "1000" };
    case "T0:15:45": return { day: t0, kind: "1545" };
    case "T0:close": return { day: t0, kind: "close" };
    case "R:open": return { day: r, kind: "open" };
    default: return { day: r, kind: "close" }; // R:close (R+5 and R+20 are not option anchors)
  }
}

// ---- pure selection and pricing ---------------------------------------------

/**
 * Price from a day's 15-minute bars at `targetEndMs`: the close of the bar
 * ending then, else of the last bar ending within 45 minutes before it.
 */
export function intradayPrice(bars: Bar[] | undefined, targetEndMs: number): number | null {
  let best: { end: number; c: number } | null = null;
  for (const b of bars ?? []) {
    const end = Date.parse(b.t) + BAR_MINUTES * 60_000;
    if (end > targetEndMs || end < targetEndMs - SPARSE_MINUTES * 60_000) continue;
    if (!best || end > best.end) best = { end, c: b.c };
  }
  return best ? best.c : null;
}

/** First date in `expiries` on or after `date`. */
export function firstExpiryOnOrAfter(expiries: string[], date: string): string | null {
  return [...expiries].sort().find((e) => e >= date) ?? null;
}

/** Event expiry: first listed on or after R. Swing: first at least 21 calendar days after R. */
export function pickExpiries(expiries: string[], r: string): Record<ExpiryKind, string | null> {
  return { event: firstExpiryOnOrAfter(expiries, r), swing: firstExpiryOnOrAfter(expiries, addDays(r, SWING_MIN_DAYS)) };
}

/**
 * Strike for a leg. ATM legs: the strike nearest spot (ties go lower) that has
 * a price at entry, looking at the nearest three. otm_call: the next strike
 * above the ATM call's with a price, looking at two.
 */
export function selectStrike(strikes: number[], spot: number, leg: Leg, hasPrice: (strike: number) => boolean, atmCallStrike?: number): number | null {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  if (leg === "otm_call") {
    if (atmCallStrike === undefined) return null;
    return sorted.filter((s) => s > atmCallStrike).slice(0, 2).find(hasPrice) ?? null;
  }
  const byDistance = [...sorted].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b);
  return byDistance.slice(0, 3).find(hasPrice) ?? null;
}

type Chain = { occ: Map<string, Map<number, string>> }; // `${expiry}|${type}` -> strike -> occ

function buildChain(contracts: OptionContract[]): Chain {
  const occ = new Map<string, Map<number, string>>();
  for (const c of contracts) {
    const k = `${c.expiry}|${c.type}`;
    if (!occ.has(k)) occ.set(k, new Map());
    occ.get(k)!.set(c.strike, c.occ);
  }
  return { occ };
}

const strikesOf = (chain: Chain, expiry: string, type: "call" | "put"): number[] => [...(chain.occ.get(`${expiry}|${type}`)?.keys() ?? [])].sort((a, b) => a - b);

/** Strikes within `n` of the one nearest `spot`. */
function nearStrikes(strikes: number[], spot: number, n: number): number[] {
  if (strikes.length === 0) return [];
  let idx = 0;
  strikes.forEach((s, i) => {
    if (Math.abs(s - spot) < Math.abs(strikes[idx] - spot)) idx = i;
  });
  return strikes.slice(Math.max(0, idx - n), idx + n + 1);
}

export type Lookup = {
  daily: (occ: string, day: string) => Bar | undefined;
  intraday: (occ: string, day: string) => Bar[] | undefined;
};

/** A contract's price at an anchor, from the daily or intraday bars. */
export function priceAt(lookup: Lookup, occ: string, anchor: Anchor, t0: string, r: string): number | null {
  const { day, kind } = anchorDay(anchor, t0, r);
  if (kind === "close") return lookup.daily(occ, day)?.c ?? null;
  if (kind === "open") return lookup.daily(occ, day)?.o ?? null;
  return intradayPrice(lookup.intraday(occ, day), nyInstant(day, kind === "1000" ? 10 : 15, kind === "1000" ? 0 : 45));
}

export type EventInput = {
  symbol: string;
  reportDate: string;
  t0: string;
  r: string;
  spots: Partial<Record<Anchor, number | null>>; // from stock_paths
};

/** Every OptionLegPath for an event from its contract chain and bars. Pure. */
export function buildLegPaths(ev: EventInput, contracts: OptionContract[], lookup: Lookup, rate = riskFreeRate()): OptionLegPath[] {
  const chain = buildChain(contracts);
  const expiries = pickExpiries([...new Set(contracts.map((c) => c.expiry))], ev.r);
  const out: OptionLegPath[] = [];
  for (const kind of EXPIRY_KINDS) {
    const expiry = expiries[kind];
    if (!expiry) continue;
    for (const entry of ENTRIES) {
      const spot = ev.spots[entry];
      if (spot == null || !(spot > 0)) continue;
      const tracked = TRACK_ORDER.slice(TRACK_ORDER.indexOf(entry));
      const entryDay = anchorDay(entry, ev.t0, ev.r).day;
      const chosen = new Map<Leg, { occ: string; strike: number }>();
      for (const leg of LEGS) {
        const type = leg === "atm_put" ? "put" : "call";
        const map = chain.occ.get(`${expiry}|${type}`);
        if (!map) continue;
        const strike = selectStrike(strikesOf(chain, expiry, type), spot, leg, (s) => priceAt(lookup, map.get(s)!, entry, ev.t0, ev.r) !== null, chosen.get("atm_call")?.strike);
        if (strike === null) continue;
        chosen.set(leg, { occ: map.get(strike)!, strike });
        const occ = map.get(strike)!;
        const prices: Partial<Record<Anchor, number | null>> = {};
        for (const a of tracked) prices[a] = priceAt(lookup, occ, a, ev.t0, ev.r);
        const entryPrice = prices[entry]!;
        const { day, kind: k } = anchorDay(entry, ev.t0, ev.r);
        const at = k === "1000" ? nyInstant(day, 10) : sessionClose(day);
        const years = Math.max(sessionClose(expiry) - at, 60_000) / (365 * 86_400_000);
        const iv = impliedVol({ right: type, spot, strike, t: years, rate }, entryPrice);
        out.push({
          entry, expiryKind: kind, leg, contract: occ, expiry, strike, spotAtEntry: spot,
          prices, ivAtEntry: iv, priceSource: "trade", volumeAtEntryDay: lookup.daily(occ, entryDay)?.v ?? null,
        });
      }
    }
  }
  return out;
}

// ---- storage -----------------------------------------------------------------

const upsertLadder = earningsDb.prepare("INSERT OR REPLACE INTO option_ladder_bars (occ, day, open, high, low, close, volume, vwap, trades) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
const upsertIntraday = earningsDb.prepare("INSERT OR REPLACE INTO option_intraday_bars (occ, ts, open, high, low, close, volume, trades) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const upsertPath = earningsDb.prepare(`INSERT OR REPLACE INTO option_paths
  (symbol, report_date, entry, expiry_kind, leg, contract, expiry, strike, spot_at_entry, prices, iv_at_entry, price_source, volume_at_entry_day, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

function saveLadder(bars: Record<string, Bar[]>, window: Map<string, [string, string]>): number {
  let n = 0;
  earningsDb.transaction(() => {
    for (const [occ, list] of Object.entries(bars)) {
      const w = window.get(occ);
      for (const b of list) {
        const day = tradingDay(b.t);
        if (w && (day < w[0] || day > w[1])) continue; // outside every event window that owns this contract
        upsertLadder.run(occ, day, b.o, b.h, b.l, b.c, b.v, b.vw ?? null, b.n ?? null);
        n++;
      }
    }
  })();
  return n;
}

function saveIntraday(bars: Record<string, Bar[]>): void {
  earningsDb.transaction(() => {
    for (const [occ, list] of Object.entries(bars)) {
      for (const b of list) upsertIntraday.run(occ, new Date(b.t).toISOString(), b.o, b.h, b.l, b.c, b.v, b.n ?? null);
    }
  })();
}

function savePaths(ev: EventInput, paths: OptionLegPath[]): void {
  earningsDb.transaction(() => {
    earningsDb.prepare("DELETE FROM option_paths WHERE symbol = ? AND report_date = ? AND price_source = 'trade'").run(ev.symbol, ev.reportDate);
    for (const p of paths) {
      upsertPath.run(ev.symbol, ev.reportDate, p.entry, p.expiryKind, p.leg, p.contract, p.expiry, p.strike, p.spotAtEntry, JSON.stringify(p.prices), p.ivAtEntry, p.priceSource, p.volumeAtEntryDay);
    }
  })();
}

function loadLookup(occs: string[], [lo, hi]: [string, string], days: string[]): Lookup {
  const daily = new Map<string, Bar>();
  const intra = new Map<string, Bar[]>();
  const dRows = earningsDb.prepare("SELECT occ, day, open, high, low, close, volume, vwap, trades FROM option_ladder_bars WHERE occ = ? AND day >= ? AND day <= ?");
  const iRows = earningsDb.prepare("SELECT ts, open, high, low, close, volume, trades FROM option_intraday_bars WHERE occ = ? AND ts >= ? AND ts <= ? ORDER BY ts");
  for (const occ of occs) {
    for (const r of dRows.all(occ, lo, hi) as any[]) daily.set(`${occ}|${r.day}`, { t: r.day, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume ?? 0, n: r.trades ?? undefined, vw: r.vwap ?? undefined });
    for (const day of days) {
      const rows = iRows.all(occ, new Date(nyInstant(day, 9, 0)).toISOString(), new Date(nyInstant(day, 16, 30)).toISOString()) as any[];
      if (rows.length) intra.set(`${occ}|${day}`, rows.map((r) => ({ t: r.ts, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume ?? 0, n: r.trades ?? undefined })));
    }
  }
  return { daily: (occ, day) => daily.get(`${occ}|${day}`), intraday: (occ, day) => intra.get(`${occ}|${day}`) };
}

// ---- fetching ----------------------------------------------------------------

async function ensureYears(...days: string[]): Promise<void> {
  for (const y of new Set(days.map((d) => Number(d.slice(0, 4))))) await ensureCalendar(y);
}

const quarterOf = (day: string): string => `${day.slice(0, 4)}Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;

/** Strike range for a stretch of days: daily_bars low/high with a wide margin, else the event spots. */
function strikeBand(symbol: string, from: string, to: string, spots: number[]): [number, number] {
  let row: { lo: number | null; hi: number | null } | undefined;
  try {
    row = db.prepare("SELECT MIN(low) lo, MAX(high) hi FROM daily_bars WHERE symbol = ? AND day >= ? AND day <= ?").get(symbol, from, to) as typeof row;
  } catch {
    row = undefined; // no daily_bars table (a bare test database)
  }
  const lo = Math.min(...spots) * 0.88;
  const hi = Math.max(...spots) * 1.12;
  if (row?.lo && row?.hi) return [Math.min(lo, row.lo * 0.85), Math.max(hi, row.hi * 1.15)];
  return [lo, hi];
}

/** Contracts of a symbol for the events of one expiry quarter: one listing (all pages) per status, not one per event. */
async function listChunk(symbol: string, evs: EventInput[], stats: Stats): Promise<OptionContract[]> {
  const spots = evs.flatMap(spotsOf);
  const [lo, hi] = strikeBand(symbol, addSessions(evs[0].t0, -25), addSessions(evs[evs.length - 1].r, 1), spots);
  const base = {
    underlying: symbol,
    expiryGte: evs.reduce((m, e) => (e.r < m ? e.r : m), evs[0].r),
    expiryLte: addDays(evs.reduce((m, e) => (e.r > m ? e.r : m), evs[0].r), LISTING_DAYS),
    strikeGte: Math.floor(lo),
    strikeLte: Math.ceil(hi),
  };
  const today = new Date().toISOString().slice(0, 10);
  const inactive = await listContracts({ ...base, status: "inactive" }, stats, 30, false);
  const active = base.expiryLte >= today ? await listContracts({ ...base, status: "active" }, stats, 30, false) : [];
  const seen = new Map<string, OptionContract>();
  for (const c of [...inactive, ...active]) seen.set(c.occ, c);
  return [...seen.values()];
}

const spotsOf = (ev: EventInput): number[] =>
  ENTRIES.map((e) => ev.spots[e]).concat(ev.spots["T0:close"]).filter((v): v is number => typeof v === "number" && v > 0);

type Plan = {
  ev: EventInput;
  contracts: OptionContract[];
  chain: Chain;
  expiries: Record<ExpiryKind, string | null>;
  ladder: string[];
  startDay: string;
  endDay: string;
};

/** The contracts, expiries and ladder OCCs one event needs, from its chunk's listing. */
function planEvent(ev: EventInput, listing: OptionContract[], neighbors: number | "all"): Plan | null {
  const spotVals = spotsOf(ev);
  if (spotVals.length === 0) return null;
  const lo = Math.min(...spotVals) * 0.88;
  const hi = Math.max(...spotVals) * 1.12;
  const until = addDays(ev.r, LISTING_DAYS);
  const contracts = listing.filter((c) => c.expiry >= ev.r && c.expiry <= until && c.strike >= lo && c.strike <= hi);
  if (contracts.length === 0) return null;
  const chain = buildChain(contracts);
  const expiries = pickExpiries([...new Set(contracts.map((c) => c.expiry))], ev.r);
  const ladder = new Set<string>();
  for (const kind of EXPIRY_KINDS) {
    const expiry = expiries[kind];
    if (!expiry) continue;
    for (const type of ["call", "put"] as const) {
      const strikes = strikesOf(chain, expiry, type);
      const map = chain.occ.get(`${expiry}|${type}`);
      if (!map) continue;
      const wanted = neighbors === "all" ? strikes : spotVals.flatMap((s) => nearStrikes(strikes, s, neighbors));
      for (const s of wanted) ladder.add(map.get(s)!);
    }
  }
  return { ev, contracts, chain, expiries, ladder: [...ladder], startDay: addSessions(ev.t0, -25), endDay: addSessions(ev.r, 1) };
}

/**
 * Daily bars for the ladders of many events in as few requests as possible:
 * events (in date order) share a request while the OCC count stays under the
 * batch size and the date span under 150 days. Returns the keys of events
 * whose bars could not be fetched.
 */
async function fetchLadders(plans: Plan[], stats: Stats): Promise<Set<Plan>> {
  const failed = new Set<Plan>();
  const sorted = [...plans].sort((a, b) => a.startDay.localeCompare(b.startDay));
  let batch: Plan[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const group = batch;
    batch = [];
    const window = new Map<string, [string, string]>();
    for (const p of group) {
      for (const occ of p.ladder) {
        const w = window.get(occ);
        window.set(occ, w ? [w[0] < p.startDay ? w[0] : p.startDay, w[1] > p.endDay ? w[1] : p.endDay] : [p.startDay, p.endDay]);
      }
    }
    const occs = [...window.keys()];
    const start = group.reduce((m, p) => (p.startDay < m ? p.startDay : m), group[0].startDay);
    const end = group.reduce((m, p) => (p.endDay > m ? p.endDay : m), group[0].endDay);
    try {
      for (let i = 0; i < occs.length; i += BAR_BATCH) {
        const bars = await optionDailyBars(occs.slice(i, i + BAR_BATCH), start, addDays(end, 1), stats);
        saveLadder(bars, window);
      }
    } catch (err) {
      console.warn(`[option-paths] ladder bars ${group[0].ev.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      for (const p of group) failed.add(p);
    }
  };
  let count = 0;
  for (const p of sorted) {
    const span = batch.length ? daysBetween(batch[0].startDay, p.endDay) : 0;
    if (batch.length && (count + p.ladder.length > BAR_BATCH || span > 150)) {
      await flush();
      count = 0;
    }
    batch.push(p);
    count += p.ladder.length;
  }
  await flush();
  return failed;
}

/** Intraday bars and paths for one planned event, after its ladder is stored. Returns the legs stored. */
async function finishEvent(plan: Plan, stats: Stats): Promise<number> {
  const { ev, contracts, chain, expiries, ladder, startDay, endDay } = plan;
  // ATM-1..ATM+1 calls and the ATM put at the T0 morning spot, plus the contracts that daily entries picked.
  const t1 = addSessions(ev.t0, -1);
  const intraDays = [...new Set([t1, ev.t0, ev.r])];
  const setA = new Set<string>();
  const spotT0 = ev.spots["T0:10:00"] ?? ev.spots["T0:open"] ?? ev.spots["T0:close"];
  if (spotT0) {
    for (const kind of EXPIRY_KINDS) {
      const expiry = expiries[kind];
      if (!expiry) continue;
      for (const s of nearStrikes(strikesOf(chain, expiry, "call"), spotT0, 1)) setA.add(chain.occ.get(`${expiry}|call`)!.get(s)!);
      const [put] = nearStrikes(strikesOf(chain, expiry, "put"), spotT0, 0);
      if (put !== undefined) setA.add(chain.occ.get(`${expiry}|put`)!.get(put)!);
    }
  }
  const dailyOnly = buildLegPaths({ ...ev, spots: { ...ev.spots, "T0:10:00": null } }, contracts, loadLookup(ladder, [startDay, endDay], []));
  for (const p of dailyOnly) if (p.expiryKind === "event") setA.add(p.contract);
  // T0-1, T0 and R are consecutive sessions, so one request covers all three days.
  const occs = [...setA];
  for (let i = 0; i < occs.length; i += BAR_BATCH) saveIntraday(await optionIntradayBars(occs.slice(i, i + BAR_BATCH), intraDays[0], "15Min", stats, 20, intraDays[intraDays.length - 1]));
  const lookup = loadLookup([...new Set([...ladder, ...setA])], [startDay, endDay], intraDays);
  const paths = buildLegPaths(ev, contracts, lookup);
  savePaths(ev, paths);
  return paths.length;
}

type SymbolOutcome = { legs: Map<string, number>; failed: Set<string> };

/**
 * Fetch and build the option paths of several events of one symbol. Contract
 * listings are per expiry quarter, ladder bars are shared across events, and
 * an event whose requests failed is reported in `failed` and not written.
 */
async function processSymbolEvents(symbol: string, evs: EventInput[], neighbors: number | "all", stats: Stats): Promise<SymbolOutcome> {
  const out: SymbolOutcome = { legs: new Map(), failed: new Set() };
  if (evs.length === 0) return out;
  await ensureYears(addDays(evs[0].t0, -45), addDays(evs[evs.length - 1].r, 3));
  const chunks = new Map<string, EventInput[]>();
  for (const ev of [...evs].sort((a, b) => a.r.localeCompare(b.r))) {
    const q = quarterOf(ev.r);
    if (!chunks.has(q)) chunks.set(q, []);
    chunks.get(q)!.push(ev);
  }
  const plans: Plan[] = [];
  for (const group of chunks.values()) {
    try {
      const listing = await listChunk(symbol, group, stats);
      for (const ev of group) {
        const plan = planEvent(ev, listing, neighbors);
        if (plan) plans.push(plan);
        else out.legs.set(ev.reportDate, 0);
      }
    } catch (err) {
      console.warn(`[option-paths] ${symbol} contracts: ${err instanceof Error ? err.message : String(err)}`);
      for (const ev of group) out.failed.add(ev.reportDate);
    }
  }
  const badLadder = await fetchLadders(plans, stats);
  for (const plan of plans) {
    if (badLadder.has(plan)) {
      out.failed.add(plan.ev.reportDate);
      continue;
    }
    try {
      out.legs.set(plan.ev.reportDate, await finishEvent(plan, stats));
    } catch (err) {
      out.failed.add(plan.ev.reportDate);
      console.warn(`[option-paths] ${symbol} ${plan.ev.reportDate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ---- drivers -----------------------------------------------------------------

function eventInputs(rows: EventRow[]): EventInput[] {
  const sp = earningsDb.prepare("SELECT * FROM stock_paths WHERE symbol = ? AND report_date = ?");
  const out: EventInput[] = [];
  for (const row of rows) {
    const s = sp.get(row.symbol, row.report_date) as Record<string, number | null> | undefined;
    if (!s) continue;
    const spots: EventInput["spots"] = {};
    for (const [anchor, col] of Object.entries(SPOT_COLUMN)) spots[anchor as Anchor] = s[col] ?? null;
    out.push({ symbol: row.symbol, reportDate: row.report_date, t0: row.t0, r: row.r, spots });
  }
  return out;
}

const hasPaths = (symbol: string, reportDate: string): boolean =>
  earningsDb.prepare("SELECT 1 FROM option_paths WHERE symbol = ? AND report_date = ? LIMIT 1").get(symbol, reportDate) !== undefined;

/**
 * Option paths for the confirmed events of `symbols` with R on or after
 * `since` (default 2024-02-01). Resumable: a symbol finished earlier is
 * skipped unless it has newer events, and events that already have paths are
 * skipped. Idempotent: bars and paths are upserts.
 */
export async function backfillOptions(
  symbols: string[],
  opts: { since?: string; ladderNeighbors?: number | "all"; concurrency?: number } = {}
): Promise<{ events: number; legs: number; requests: number; errors: number }> {
  const since = opts.since ?? DEFAULT_SINCE;
  const stats: Stats = { requests: 0 };
  let events = 0;
  let legs = 0;
  let errors = 0;
  const progress = earningsDb.prepare("SELECT status, detail FROM backfill_progress WHERE task = ? AND symbol = ?");
  const mark = earningsDb.prepare(`INSERT INTO backfill_progress (task, symbol, status, detail, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(task, symbol) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at`);

  await mapWithConcurrency([...new Set(symbols.map((s) => s.toUpperCase()))], opts.concurrency ?? SYMBOL_CONCURRENCY, async (symbol) => {
    const rows = earningsDb
      .prepare("SELECT symbol, report_date, t0, r FROM events WHERE symbol = ? AND confirmed = 1 AND t0 IS NOT NULL AND r IS NOT NULL AND r >= ? ORDER BY report_date")
      .all(symbol, since) as EventRow[];
    const prev = progress.get(TASK, symbol) as { status: string; detail: string | null } | undefined;
    const through = prev?.status === "done" ? (JSON.parse(prev.detail ?? "{}").through as string | undefined) : undefined;
    const todo = rows.filter((e) => !(through && e.report_date <= through) && !hasPaths(e.symbol, e.report_date));
    const out = await processSymbolEvents(symbol, eventInputs(todo), opts.ladderNeighbors ?? LADDER_NEIGHBORS, stats);
    const failed = out.failed.size;
    errors += failed;
    for (const n of out.legs.values()) {
      if (n > 0) events++;
      legs += n;
    }
    mark.run(TASK, symbol, failed ? "error" : "done", JSON.stringify({ through: rows.length ? rows[rows.length - 1].report_date : (through ?? null), failed }));
  });
  return { events, legs, requests: stats.requests, errors };
}

/** Rebuild option paths for specific events (the nightly hook for new reports): refetches their bars. */
export async function buildOptionPathsFor(events: EventRef[]): Promise<void> {
  const stats: Stats = { requests: 0 };
  const sel = earningsDb.prepare("SELECT symbol, report_date, t0, r FROM events WHERE symbol = ? AND report_date = ? AND confirmed = 1 AND t0 IS NOT NULL AND r IS NOT NULL");
  const rows = events.map((e) => sel.get(e.symbol.toUpperCase(), e.reportDate) as EventRow | undefined).filter((r): r is EventRow => !!r);
  const bySymbol = new Map<string, EventInput[]>();
  for (const ev of eventInputs(rows)) bySymbol.set(ev.symbol, [...(bySymbol.get(ev.symbol) ?? []), ev]);
  for (const [symbol, evs] of bySymbol) {
    const out = await processSymbolEvents(symbol, evs, LADDER_NEIGHBORS, stats);
    for (const d of out.failed) console.warn(`[option-paths] ${symbol} ${d}: failed, will be retried by the next run`);
  }
}

export { buildChain, nearStrikes };
