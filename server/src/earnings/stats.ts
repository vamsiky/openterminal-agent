import { db } from "../db.js";
import { impliedVol, riskFreeRate, yearsToExpiry } from "../options/black-scholes.js";
import { isTradingDay, sessionClose, sessionOpen } from "../providers/alpaca-calendar.js";
import type { Anchor, CapBucket, Dist, EventStats, Horizon, ReportTime } from "./contracts.js";
import { earningsDb } from "./db.js";

// EventStats per symbol and pooled, rebuilt in one pass over the confirmed events.
//
// Scope keys (the `stats.scope_key` column):
//   sym:WDC               one symbol
//   pool:<sector>:<cap>   sector x market-cap bucket (sector as FMP names it, e.g. pool:Technology:mid)
//   cap:<cap>             market-cap bucket alone
//   all                   every confirmed event
// Each scope is stored per horizon and per report time (bmo | amc | dmh | any).
//
// Definitions the contract leaves open:
// - Returns are entry -> T0:15:45 in percent: entry is T0:10:00 (intraday), T0-5 close (week), T0-20 close (month).
// - Call legs are the event-expiry legs tracked from that entry. For month the event expiry is the first expiry on or
//   after R, which from T0-20 is always 25+ days out, so it is the leg the scoring section names.
// - preDrift.t0OpenFrom10 is T0:open -> T0:10:00 (the first 30 minutes); preDrift.rCloseFromPrev is T0:close against the
//   close before T0 (the full report-day move; the name predates the T0/R convention).
// - reactions are T0:close -> R:close, i.e. the move through the announcement.
// - impliedVsRealized: implied = 0.8 x the leg's IV at T0:close x sqrt(years from T0 to its expiry), in percent (a straddle
//   approximation that includes the days after the event); realized = median |reaction|.
// - ivRamp[anchor] = median of (leg IV at anchor / leg IV at T0:close), for anchors at or after the entry.

export const HORIZONS: Horizon[] = ["intraday", "week", "month"];
export const TIMES = ["bmo", "amc", "dmh", "any"] as const;
const ENTRY: Record<Horizon, { anchor: Anchor; col: number }> = {
  intraday: { anchor: "T0:10:00", col: 0 },
  week: { anchor: "T0-5", col: 1 },
  month: { anchor: "T0-20", col: 2 },
};
const FLAT_STOCK_PCT = 0.6;
const RAMP_ANCHORS: Anchor[] = ["T0-20", "T0-10", "T0-5", "T0-2", "T0-1", "T0:open", "T0:10:00", "T0:15:45", "T0:close", "R:open", "R:close"];

export const capBucket = (marketCap: number | null | undefined): CapBucket | null => {
  if (marketCap === null || marketCap === undefined || !(marketCap > 0)) return null;
  if (marketCap < 300e6) return "micro";
  if (marketCap < 2e9) return "small";
  if (marketCap < 10e9) return "mid";
  if (marketCap < 200e9) return "large";
  return "mega";
};

export const symKey = (symbol: string) => `sym:${symbol}`;
export const poolKey = (sector: string, cap: CapBucket) => `pool:${sector}:${cap}`;
export const capKey = (cap: CapBucket) => `cap:${cap}`;
export const ALL_KEY = "all";

// ---- small statistics ----

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Quantile of an ascending array, linear interpolation. */
function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function dist(values: number[]): Dist {
  const n = values.length;
  if (n === 0) return { n: 0, median: null, mean: null, p25: null, p75: null, winRate: null };
  const s = Float64Array.from(values).sort();
  let sum = 0;
  let wins = 0;
  for (const v of values) {
    sum += v;
    if (v > 0) wins++;
  }
  return { n, median: r4(quantile(s, 0.5)), mean: r4(sum / n), p25: r4(quantile(s, 0.25)), p75: r4(quantile(s, 0.75)), winRate: r4(wins / n) };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return r4(quantile(Float64Array.from(values).sort(), 0.5));
}

/** Least squares y = a + b x; null under 5 points or with no spread in x. */
export function ols(xs: number[], ys: number[]): { alpha: number; beta: number } | null {
  const n = xs.length;
  if (n < 5) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx < 1e-12) return null;
  const beta = sxy / sxx;
  return { alpha: my - beta * mx, beta };
}

// ---- loading ----

type Columns = {
  n: number;
  symbol: string[];
  time: Array<ReportTime | null>;
  /** [horizon][event] stock %, call %, otm-call % (NaN when missing). */
  stock: Float64Array[];
  call: Float64Array[];
  otm: Float64Array[];
  open10: Float64Array;
  dayMove: Float64Array;
  reaction: Float64Array;
  /** Per horizon: event index -> { iv at each RAMP_ANCHORS (NaN when missing) , implied move % }. */
  ramps: Array<Map<number, { iv: Float64Array; implied: number }>>;
};

const pct = (to: number | null, from: number | null): number => (to !== null && from !== null && to > 0 && from > 0 ? (to / from - 1) * 100 : NaN);

let tradingDays: string[] = [];
let tradingIndex = new Map<string, number>();
function buildTradingDays(from: string, to: string): void {
  tradingDays = [];
  tradingIndex = new Map();
  const d = new Date(from + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 40);
  const end = new Date(to + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + 40);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (isTradingDay(day)) {
      tradingIndex.set(day, tradingDays.length);
      tradingDays.push(day);
    }
  }
}

/** Epoch ms of an anchor for an event whose T0 and R sessions are given, or null. */
function anchorTime(anchor: Anchor, t0: string, r: string | null): number | null {
  const offset = /^T0-(\d+)$/.exec(anchor);
  if (offset) {
    const i = tradingIndex.get(t0);
    const day = i === undefined ? undefined : tradingDays[i - Number(offset[1])];
    return day ? sessionClose(day) : null;
  }
  switch (anchor) {
    case "T0:open": return sessionOpen(t0);
    case "T0:10:00": return sessionOpen(t0) + 30 * 60_000;
    case "T0:15:45": return sessionClose(t0) - 15 * 60_000;
    case "T0:close": return sessionClose(t0);
    case "R:open": return r ? sessionOpen(r) : null;
    case "R:close": return r ? sessionClose(r) : null;
    default: return null;
  }
}

const STOCK_COL: Record<string, number> = {
  "T0-20": 1, "T0-10": 2, "T0-5": 3, "T0-2": 4, "T0-1": 5, "T0:open": 6, "T0:10:00": 7, "T0:15:45": 8, "T0:close": 9, "R:open": 10, "R:close": 11,
};

function load(): Columns {
  const rows = earningsDb
    .prepare(
      `SELECT e.symbol, e.report_date, e.time, e.t0, e.r,
              p.t0_m20, p.t0_m10, p.t0_m5, p.t0_m2, p.t0_m1, p.t0_open, p.t0_1000, p.t0_1545, p.t0_close, p.r_open, p.r_close, p.prev_close
       FROM events e JOIN stock_paths p ON p.symbol = e.symbol AND p.report_date = e.report_date
       WHERE e.confirmed = 1 AND e.t0 IS NOT NULL ORDER BY e.symbol, e.report_date`
    )
    .raw(true)
    .all() as Array<[string, string, ReportTime | null, string | null, string | null, ...Array<number | null>]>;
  const n = rows.length;
  const c: Columns = {
    n,
    symbol: new Array(n),
    time: new Array(n),
    stock: HORIZONS.map(() => new Float64Array(n).fill(NaN)),
    call: HORIZONS.map(() => new Float64Array(n).fill(NaN)),
    otm: HORIZONS.map(() => new Float64Array(n).fill(NaN)),
    open10: new Float64Array(n).fill(NaN),
    dayMove: new Float64Array(n).fill(NaN),
    reaction: new Float64Array(n).fill(NaN),
    ramps: HORIZONS.map(() => new Map()),
  };

  // Option legs of the event expiry, keyed symbol|report_date|entry.
  const legs = new Map<string, { atm?: LegRow; otm?: LegRow }>();
  const legStmt = earningsDb.prepare(
    `SELECT symbol, report_date, entry, leg, expiry, strike, prices FROM option_paths
     WHERE expiry_kind = 'event' AND leg IN ('atm_call','otm_call') AND entry IN ('T0:10:00','T0-5','T0-20')`
  );
  for (const r of legStmt.iterate() as Iterable<{ symbol: string; report_date: string; entry: string; leg: string; expiry: string; strike: number; prices: string }>) {
    const key = `${r.symbol}|${r.report_date}|${r.entry}`;
    let slot = legs.get(key);
    if (!slot) legs.set(key, (slot = {}));
    const row = { expiry: r.expiry, strike: r.strike, prices: r.prices };
    if (r.leg === "atm_call") slot.atm = row;
    else slot.otm = row;
  }

  if (n > 0) {
    let lo = rows[0][1];
    let hi = rows[0][1];
    for (const r of rows) {
      if (r[1] < lo) lo = r[1];
      if (r[1] > hi) hi = r[1];
    }
    buildTradingDays(lo, hi);
  }
  const rate = riskFreeRate();

  for (let i = 0; i < n; i++) {
    const [symbol, reportDate, time, t0, rDay] = rows[i];
    const p = rows[i].slice(5) as Array<number | null>; // t0_m20 .. prev_close in select order
    const [m20, m10, m5, m2, m1, open, p1000, p1545, close, rOpen, rClose, prev] = p;
    const price = [m20, m10, m5, m2, m1, open, p1000, p1545, close, rOpen, rClose];
    c.symbol[i] = symbol;
    c.time[i] = time;
    c.open10[i] = pct(p1000, open);
    c.dayMove[i] = pct(close, prev);
    c.reaction[i] = pct(rClose, close);
    const entryPx = [p1000, m5, m20];
    for (let h = 0; h < 3; h++) {
      const horizon = HORIZONS[h];
      c.stock[h][i] = pct(p1545, entryPx[h]);
      const slot = legs.get(`${symbol}|${reportDate}|${ENTRY[horizon].anchor}`);
      if (!slot) continue;
      for (const [leg, arr] of [[slot.atm, c.call[h]], [slot.otm, c.otm[h]]] as const) {
        if (!leg) continue;
        const prices = JSON.parse(leg.prices) as Partial<Record<Anchor, number | null>>;
        arr[i] = pct(prices["T0:15:45"] ?? null, prices[ENTRY[horizon].anchor] ?? null);
      }
      if (slot.atm && t0) {
        const prices = JSON.parse(slot.atm.prices) as Partial<Record<Anchor, number | null>>;
        const ivAt = (anchor: Anchor): number => {
          const opt = prices[anchor];
          const spot = price[STOCK_COL[anchor] - 1];
          const at = anchorTime(anchor, t0, rDay);
          if (!opt || !(opt > 0) || !spot || at === null) return NaN;
          const t = yearsToExpiry(slot.atm!.expiry, at, sessionClose);
          return impliedVol({ right: "call", spot, strike: slot.atm!.strike, t, rate }, opt) ?? NaN;
        };
        const ivClose = ivAt("T0:close");
        if (ivClose > 0) {
          const iv = new Float64Array(RAMP_ANCHORS.length).fill(NaN);
          const first = RAMP_ANCHORS.indexOf(ENTRY[horizon].anchor);
          for (let a = first; a < RAMP_ANCHORS.length; a++) iv[a] = RAMP_ANCHORS[a] === "T0:close" ? ivClose : ivAt(RAMP_ANCHORS[a]);
          const years = yearsToExpiry(slot.atm.expiry, sessionClose(t0), sessionClose);
          c.ramps[h].set(i, { iv, implied: 0.8 * ivClose * Math.sqrt(years) * 100 });
        }
      }
    }
  }
  return c;
}

type LegRow = { expiry: string; strike: number; prices: string };

// ---- stats for one group ----

function finite(col: Float64Array, idx: number[]): number[] {
  const out: number[] = [];
  for (const i of idx) if (!Number.isNaN(col[i])) out.push(col[i]);
  return out;
}

function statsFor(c: Columns, h: number, idx: number[], scope: EventStats["scope"], time: EventStats["time"], withLast4: boolean): EventStats | null {
  const stockIdx = idx.filter((i) => !Number.isNaN(c.stock[h][i]));
  if (stockIdx.length === 0) return null;
  const stock = finite(c.stock[h], idx);
  const call = finite(c.call[h], idx);
  const otm = finite(c.otm[h], idx);

  const xs: number[] = [];
  const ys: number[] = [];
  const flat: number[] = [];
  for (const i of idx) {
    const s = c.stock[h][i];
    const k = c.call[h][i];
    if (Number.isNaN(s) || Number.isNaN(k)) continue;
    xs.push(s);
    ys.push(k);
    if (Math.abs(s) < FLAT_STOCK_PCT) flat.push(k);
  }
  const fit = ols(xs, ys);

  const ramp = new Map<Anchor, number[]>();
  const implied: number[] = [];
  const realized: number[] = [];
  for (const i of idx) {
    const r = c.ramps[h].get(i);
    if (!r) continue;
    implied.push(r.implied);
    const rx = c.reaction[i];
    if (!Number.isNaN(rx)) realized.push(Math.abs(rx));
    const close = r.iv[RAMP_ANCHORS.indexOf("T0:close")];
    RAMP_ANCHORS.forEach((a, k) => {
      if (Number.isNaN(r.iv[k])) return;
      let list = ramp.get(a);
      if (!list) ramp.set(a, (list = []));
      list.push(r.iv[k] / close);
    });
  }
  const ivRamp: EventStats["ivRamp"] = {};
  for (const a of RAMP_ANCHORS) {
    const list = ramp.get(a);
    if (list && list.length >= 3) ivRamp[a] = median(list);
  }
  const medImplied = median(implied);
  const medRealized = median(realized);

  const reactions = idx.filter((i) => !Number.isNaN(c.reaction[i]));
  const rx = reactions.map((i) => c.reaction[i]);
  return {
    scope,
    horizon: HORIZONS[h],
    time,
    n: stock.length,
    nOptions: call.length,
    stock: dist(stock),
    call: call.length > 0 ? dist(call) : null,
    otmCall: otm.length > 0 ? dist(otm) : null,
    callBeta: fit ? r4(fit.beta) : null,
    callAlpha: fit ? r4(fit.alpha) : null,
    flatDayCall: flat.length >= 3 ? median(flat) : null,
    preDrift: { t0OpenFrom10: dist(finite(c.open10, idx)), rCloseFromPrev: dist(finite(c.dayMove, idx)) },
    impliedVsRealized: {
      medianImplied: medImplied,
      medianRealized: medRealized,
      ratio: medImplied !== null && medRealized !== null && medRealized > 0 ? r4(medImplied / medRealized) : null,
    },
    ivRamp,
    reactions: {
      upShare: rx.length > 0 ? r4(rx.filter((v) => v > 0).length / rx.length) : null,
      medianAbs: median(rx.map(Math.abs)),
      last4: withLast4 ? reactions.slice(-4).map((i) => r4(c.reaction[i])) : [],
    },
  };
}

// ---- rebuild ----

/** Recomputes every EventStats row from confirmed events. Single pass over the tables, prepared statements. */
export function rebuildStats(): { scopes: number; ms: number } {
  const started = Date.now();
  const c = load();

  const profiles = new Map<string, { sector: string | null; cap: CapBucket | null }>();
  try {
    for (const r of db.prepare("SELECT symbol, sector, market_cap FROM bulk_profiles").iterate() as Iterable<{ symbol: string; sector: string | null; market_cap: number | null }>) {
      profiles.set(r.symbol, { sector: r.sector || null, cap: capBucket(r.market_cap) });
    }
  } catch {
    // bulk_profiles not created yet: only symbol and "all" scopes.
  }

  // Group key -> event indices. Key is `${scopeKey}\t${time}`.
  const groups = new Map<string, number[]>();
  const add = (key: string, time: string, i: number) => {
    const k = `${key}\t${time}`;
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  };
  for (let i = 0; i < c.n; i++) {
    const p = profiles.get(c.symbol[i]);
    const keys = [symKey(c.symbol[i]), ALL_KEY];
    if (p?.cap) keys.push(capKey(p.cap));
    if (p?.cap && p.sector) keys.push(poolKey(p.sector, p.cap));
    for (const k of keys) {
      add(k, "any", i);
      if (c.time[i]) add(k, c.time[i]!, i);
    }
  }

  const insert = earningsDb.prepare("INSERT OR REPLACE INTO stats (scope_key, horizon, time, json, n) VALUES (?, ?, ?, ?, ?)");
  let scopes = 0;
  const symbolsOf = new Map<string, string>();
  for (const s of new Set(c.symbol)) symbolsOf.set(symKey(s), s);
  earningsDb.transaction(() => {
    earningsDb.exec("DELETE FROM stats");
    for (const [gk, idx] of groups) {
      const [key, time] = gk.split("\t");
      const symbol = symbolsOf.get(key) ?? null;
      const p = symbol ? profiles.get(symbol) : undefined;
      let scope: EventStats["scope"];
      if (symbol) scope = { symbol, sector: p?.sector ?? null, capBucket: p?.cap ?? null };
      else if (key.startsWith("pool:")) {
        const [, sector, cap] = key.split(":");
        scope = { symbol: null, sector, capBucket: cap as CapBucket };
      } else if (key.startsWith("cap:")) scope = { symbol: null, sector: null, capBucket: key.slice(4) as CapBucket };
      else scope = { symbol: null, sector: null, capBucket: null };
      for (let h = 0; h < 3; h++) {
        const st = statsFor(c, h, idx, scope, time as EventStats["time"], symbol !== null);
        if (!st) continue;
        insert.run(key, HORIZONS[h], time, JSON.stringify(st), st.n);
        scopes++;
      }
    }
  })();
  return { scopes, ms: Date.now() - started };
}

// ---- reading ----

const readStmt = earningsDb.prepare("SELECT json FROM stats WHERE scope_key = ? AND horizon = ? AND time = ?");

export function getStats(scopeKey: string, horizon: Horizon, time: EventStats["time"] = "any"): EventStats | null {
  const r = readStmt.get(scopeKey, horizon, time) as { json: string } | undefined;
  return r ? (JSON.parse(r.json) as EventStats) : null;
}
