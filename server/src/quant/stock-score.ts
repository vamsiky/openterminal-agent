import { db } from "../db.js";
import { nyClock } from "../history/scheduler.js";
import { minuteBars } from "../history/store.js";
import { tradingDay } from "../history/time.js";
import { liveQuote } from "../live/feed.js";
import { nyInstant } from "../live/session.js";
import { LISTED_EXCHANGES } from "../research/bulk-store.js";
import { addDays, revisions } from "../estimates/store.js";
import type { FactorScore, Scorecard } from "../scan/contracts.js";
import { isUsListed, listedSymbols } from "./listings.js";
import { periodReturn, rollup, rsi, vwap, type Bar } from "./indicators.js";
import { STOCK_WEIGHTS, STOCK_WEIGHTS_VERSION, composite } from "./weights.js";

// Stock scorecards for a months horizon. Each factor is a percentile (0–100,
// higher is better) within the stock's FMP sector across every US stock with
// data, not only the universe. Group score = mean of its factor scores;
// composite = weighted mean of groups (weights.ts). The nightly pass scores
// every US stock from the bulk tables in memory and stores the day's cards;
// the 15-minute pass redoes the momentum group for the universe with live
// prices and adds intraday factors.

export type FactorDef = {
  key: string;
  group: string;
  label: string;
  /** Lower raw values score higher (P/E). */
  lowerBetter?: boolean;
  /** A zero or negative raw value is the worst possible (a P/E of -5 is not cheap). */
  positiveOnly?: boolean;
  /** Ranked against the whole US market, not the stock's sector (cross-sector strength). */
  market?: boolean;
};

export const FACTORS: FactorDef[] = [
  { key: "pe", group: "valuation", label: "P/E", lowerBetter: true, positiveOnly: true },
  { key: "ev_to_ebitda", group: "valuation", label: "EV/EBITDA", lowerBetter: true, positiveOnly: true },
  { key: "price_to_sales", group: "valuation", label: "price/sales", lowerBetter: true, positiveOnly: true },
  { key: "fcf_yield", group: "valuation", label: "free cash flow yield" },
  { key: "dcf_gap", group: "valuation", label: "discount to DCF value" },
  { key: "roic", group: "quality", label: "return on invested capital" },
  { key: "roe", group: "quality", label: "return on equity" },
  { key: "gross_margin", group: "quality", label: "gross margin" },
  { key: "operating_margin", group: "quality", label: "operating margin" },
  { key: "net_debt_to_ebitda", group: "quality", label: "net debt/EBITDA", lowerBetter: true },
  { key: "current_ratio", group: "quality", label: "current ratio" },
  { key: "growth_revenue", group: "growth", label: "revenue growth" },
  { key: "growth_eps", group: "growth", label: "EPS growth" },
  { key: "surprise_pct", group: "earnings", label: "last earnings surprise" },
  { key: "eps_rev_30d", group: "earnings", label: "30-day EPS estimate revision" },
  { key: "eps_rev_90d", group: "earnings", label: "90-day EPS estimate revision" },
  { key: "buy_share", group: "analysts", label: "share of buy ratings" },
  { key: "pt_upside", group: "analysts", label: "price-target upside" },
  { key: "rating_score", group: "analysts", label: "FMP rating" },
  { key: "ret_12_1", group: "momentum", label: "12-1 month return" },
  { key: "ret_6m", group: "momentum", label: "6-month return" },
  { key: "vs_sma50", group: "momentum", label: "price vs 50-day average" },
  { key: "vs_sma200", group: "momentum", label: "price vs 200-day average" },
  { key: "rsi14", group: "momentum", label: "RSI(14)" },
  { key: "rs_spy", group: "momentum", label: "6-month excess return over SPY, market-wide", market: true },
  { key: "rs_sector", group: "momentum", label: "3-month excess return over its sector ETF, market-wide", market: true },
];

/** Added to the momentum group by the 15-minute pass only; scored with fixed maps, not percentiles. */
export const LIVE_FACTORS: FactorDef[] = [
  { key: "price_vs_vwap", group: "momentum", label: "price vs VWAP" },
  { key: "rsi_15m", group: "momentum", label: "15-minute RSI" },
  { key: "rel_volume", group: "momentum", label: "relative volume" },
];

export const GROUP_LABELS: Record<string, string> = {
  valuation: "valuation",
  quality: "quality",
  growth: "growth",
  earnings: "earnings",
  analysts: "analyst view",
  momentum: "momentum",
};

const FACTOR_BY_KEY = new Map([...FACTORS, ...LIVE_FACTORS].map((f) => [f.key, f]));
export const factorLabel = (key: string) => FACTOR_BY_KEY.get(key)?.label ?? key;

/** FMP sector -> SPDR sector ETF. */
export const SECTOR_ETF: Record<string, string> = {
  Technology: "XLK",
  "Financial Services": "XLF",
  Energy: "XLE",
  Healthcare: "XLV",
  "Consumer Cyclical": "XLY",
  "Consumer Defensive": "XLP",
  Industrials: "XLI",
  "Basic Materials": "XLB",
  Utilities: "XLU",
  "Real Estate": "XLRE",
  "Communication Services": "XLC",
};

const MIN_PEERS = 5; // sector peers with a value needed to score within the sector
const FACTORS_KEPT_DAYS = 45; // older cards keep composite and groups, not the factor detail
const CHANGE_DAYS = 28; // calendar days for "20 trading days ago"
const STALE_BAR_DAYS = 7; // a stock whose last daily bar is older than this has no momentum

db.exec(`
CREATE TABLE IF NOT EXISTS scorecards (
  day TEXT NOT NULL,
  symbol TEXT NOT NULL,
  sector TEXT,
  industry TEXT,
  composite REAL,
  groups TEXT NOT NULL,
  factors TEXT,                -- { key: [value, score, change] }; NULL once older than ${FACTORS_KEPT_DAYS} days
  coverage REAL NOT NULL,
  weights_version TEXT NOT NULL,
  PRIMARY KEY (day, symbol)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS scorecards_symbol ON scorecards (symbol, day);
CREATE TABLE IF NOT EXISTS scorecards_live (
  symbol TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  sector TEXT,
  industry TEXT,
  composite REAL,
  groups TEXT NOT NULL,
  factors TEXT NOT NULL,
  coverage REAL NOT NULL,
  weights_version TEXT NOT NULL,
  rank INTEGER
);
`);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, digits: number): number | null => (v === null ? null : Number(v.toPrecision(digits)));

// ---- percentiles ----

type Dist = { all: number[]; bySector: Map<string, number[]> };
export type Dists = Map<string, Dist>;

/** The value ranked by the percentile: higher is always better; null = no data. */
function rankValue(def: FactorDef, raw: number | null): number | null {
  if (raw === null) return null;
  if (def.positiveOnly && raw <= 0) return -1e18;
  return def.lowerBetter ? -raw : raw;
}

function buildDists(rows: Array<{ sector: string; raw: Record<string, number | null> }>): Dists {
  const dists: Dists = new Map();
  for (const def of FACTORS) {
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

/** Rank-based percentile 0–100 of x in a sorted sample; ties share their average rank. */
export function percentile(sorted: number[], x: number): number {
  const n = sorted.length;
  if (n <= 1) return 50;
  const less = bound(sorted, x, false);
  const lessEq = bound(sorted, x, true);
  const rank = (less + lessEq - 1) / 2; // 0-based average rank
  return Math.max(0, Math.min(100, (rank / (n - 1)) * 100));
}

function scoreFactor(dists: Dists, def: FactorDef, sector: string, raw: number | null): number | null {
  const v = rankValue(def, raw);
  const d = dists.get(def.key);
  if (v === null || !d) return null;
  const peers = def.market ? undefined : d.bySector.get(sector);
  const sample = peers && peers.length >= MIN_PEERS ? peers : d.all;
  return sample.length === 0 ? null : percentile(sample, v);
}

// ---- inputs ----

type Fund = { symbol: string; sector: string; industry: string | null; price: number | null; raw: Record<string, number | null> };

/** Nothing but real stocks on the exchanges, as in the screen. */
const STOCKS = "p.is_etf = 0 AND p.is_fund = 0 AND p.is_actively_trading = 1 AND p.exchange IN (SELECT value FROM json_each(?)) AND p.price > 0";

type FundRow = Record<string, unknown> & { symbol: string; sector: string | null; industry: string | null };

function loadFundamentals(today: string): Fund[] {
  const rows = db
    .prepare(
      `SELECT p.symbol, p.sector, p.industry, p.price,
              r.pe, r.price_to_sales, r.gross_margin, r.operating_margin, r.current_ratio,
              k.ev_to_ebitda, k.fcf_yield, k.roic, k.roe, k.net_debt_to_ebitda,
              d.dcf, g.growth_revenue, g.growth_eps,
              s.eps_actual, s.eps_estimated, s.date AS surprise_date,
              c.strong_buy, c.buy, c.hold, c.sell, c.strong_sell,
              t.last_quarter_count, t.last_quarter_avg, t.last_year_count, t.last_year_avg,
              rt.overall_score
       FROM bulk_profiles p
       LEFT JOIN bulk_ratios_ttm r ON r.symbol = p.symbol
       LEFT JOIN bulk_key_metrics_ttm k ON k.symbol = p.symbol
       LEFT JOIN bulk_dcf d ON d.symbol = p.symbol
       LEFT JOIN bulk_ratings rt ON rt.symbol = p.symbol
       LEFT JOIN bulk_price_targets t ON t.symbol = p.symbol
       LEFT JOIN bulk_grades_consensus c ON c.symbol = p.symbol
       LEFT JOIN (SELECT symbol, growth_revenue, growth_eps, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS n
                  FROM bulk_income_growth WHERE period = 'FY') g ON g.symbol = p.symbol AND g.n = 1
       LEFT JOIN (SELECT symbol, date, eps_actual, eps_estimated, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS n
                  FROM bulk_earnings_surprises WHERE eps_actual IS NOT NULL AND eps_estimated IS NOT NULL AND date <= ?) s
         ON s.symbol = p.symbol AND s.n = 1
       WHERE ${STOCKS}`
    )
    .all(today, JSON.stringify(LISTED_EXCHANGES)) as FundRow[];

  const listed = listedSymbols();
  const revs = loadRevisions(today);
  const oldest = addDays(today, -200); // a surprise older than two quarters says little about now
  return rows.filter((r) => isUsListed(r.symbol, listed)).map((r) => {
    const price = num(r.price);
    const dcf = num(r.dcf);
    const est = num(r.eps_estimated);
    const act = num(r.eps_actual);
    const surprise = est !== null && act !== null && est !== 0 && String(r.surprise_date) >= oldest ? ((act - est) / Math.abs(est)) * 100 : null;
    const ratings = ["strong_buy", "buy", "hold", "sell", "strong_sell"].map((k) => num(r[k]));
    const total = ratings.every((x) => x === null) ? 0 : ratings.reduce<number>((a, x) => a + (x ?? 0), 0);
    const target = (num(r.last_quarter_count) ?? 0) > 0 ? num(r.last_quarter_avg) : (num(r.last_year_count) ?? 0) > 0 ? num(r.last_year_avg) : null;
    const rev = revs.get(r.symbol);
    return {
      symbol: r.symbol,
      sector: r.sector ?? "",
      industry: r.industry,
      price,
      raw: {
        pe: num(r.pe),
        ev_to_ebitda: num(r.ev_to_ebitda),
        price_to_sales: num(r.price_to_sales),
        fcf_yield: num(r.fcf_yield),
        dcf_gap: dcf !== null && dcf > 0 && price ? (dcf - price) / price : null,
        roic: num(r.roic),
        roe: num(r.roe),
        gross_margin: num(r.gross_margin),
        operating_margin: num(r.operating_margin),
        net_debt_to_ebitda: num(r.net_debt_to_ebitda),
        current_ratio: num(r.current_ratio),
        growth_revenue: num(r.growth_revenue),
        growth_eps: num(r.growth_eps),
        surprise_pct: surprise,
        eps_rev_30d: rev?.d30 ?? null,
        eps_rev_90d: rev?.d90 ?? null,
        buy_share: total > 0 ? ((ratings[0] ?? 0) + (ratings[1] ?? 0)) / total : null,
        pt_upside: target !== null && price ? target / price - 1 : null,
        rating_score: num(r.overall_score),
      },
    };
  });
}

/** EPS estimate revisions (percent) for each symbol's next report, from the stored estimate history. */
function loadRevisions(today: string): Map<string, { d30: number | null; d90: number | null }> {
  const rows = db
    .prepare(
      "SELECT symbol, report_date, captured_day AS day, eps_estimate AS eps, revenue_estimate AS revenue FROM estimate_snapshots WHERE report_date >= ? ORDER BY symbol, report_date, captured_day"
    )
    .all(today) as Array<{ symbol: string; report_date: string; day: string; eps: number | null; revenue: number | null }>;
  const out = new Map<string, { d30: number | null; d90: number | null }>();
  let i = 0;
  while (i < rows.length) {
    // The first report date of a symbol is its next one.
    let j = i;
    while (j < rows.length && rows[j].symbol === rows[i].symbol && rows[j].report_date === rows[i].report_date) j++;
    const rev = revisions(rows.slice(i, j), today);
    out.set(rows[i].symbol, { d30: rev["30d"].eps, d90: rev["90d"].eps });
    while (j < rows.length && rows[j].symbol === rows[i].symbol) j++;
    i = j;
  }
  return out;
}

const dailyStmt = db.prepare("SELECT day, close, volume FROM daily_bars WHERE symbol = ? ORDER BY day DESC LIMIT 275");

export type Daily = { days: string[]; closes: number[]; volumes: number[] };

/** Up to 275 recent daily bars, oldest first. */
export function loadDaily(symbol: string): Daily {
  const rows = dailyStmt.all(symbol) as Array<{ day: string; close: number; volume: number }>;
  rows.reverse();
  return { days: rows.map((r) => r.day), closes: rows.map((r) => r.close), volumes: rows.map((r) => r.volume) };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

type Bench = { spy6m: number | null; etf3m: Map<string, number | null> };

function loadBench(): Bench {
  const back = (s: string, days: number) => periodReturn(loadDaily(s).closes, days);
  return { spy6m: back("SPY", 126), etf3m: new Map(Object.values(SECTOR_ETF).map((e) => [e, back(e, 63)])) };
}

/** Momentum factors from closes (oldest first, the last being the price in force). */
export function momentumRaw(closes: number[], sector: string, bench: Bench): Record<string, number | null> {
  const n = closes.length;
  const price = closes[n - 1];
  const sma = (len: number) => (n >= len ? mean(closes.slice(n - len)) : null);
  const s50 = sma(50);
  const s200 = sma(200);
  const r12 = n >= 253 && closes[n - 253] > 0 ? closes[n - 22] / closes[n - 253] - 1 : null;
  const r6 = periodReturn(closes, 126);
  const bars: Bar[] = closes.slice(-120).map((c) => ({ open: c, high: c, low: c, close: c, volume: 0 }));
  const r = n >= 30 ? rsi(bars, 14) : [];
  const etf = SECTOR_ETF[sector];
  const r3 = periodReturn(closes, 63);
  const etf3 = etf ? bench.etf3m.get(etf) ?? null : null;
  return {
    ret_12_1: r12,
    ret_6m: r6,
    vs_sma50: s50 ? price / s50 - 1 : null,
    vs_sma200: s200 ? price / s200 - 1 : null,
    rsi14: r.length > 0 ? r[r.length - 1].value : null,
    rs_spy: r6 !== null && bench.spy6m !== null ? r6 - bench.spy6m : null,
    rs_sector: r3 !== null && etf3 !== null ? r3 - etf3 : null,
  };
}

// ---- cards ----

type Compact = Record<string, [number | null, number | null, number | null]>;

function pack(factors: FactorScore[]): Compact {
  const out: Compact = {};
  for (const f of factors) out[f.key] = [round(f.value, 6), round(f.score, 4), round(f.change, 4)];
  return out;
}

function unpack(compact: Compact | null): FactorScore[] {
  if (!compact) return [];
  return [...FACTORS, ...LIVE_FACTORS]
    .filter((d) => compact[d.key])
    .map((d) => ({ key: d.key, group: d.group, value: compact[d.key][0], score: compact[d.key][1], change: compact[d.key][2] }));
}

function summarize(factors: FactorScore[], total: number): { groups: Record<string, number | null>; composite: number | null; coverage: number } {
  const groups: Record<string, number | null> = {};
  for (const g of Object.keys(STOCK_WEIGHTS)) {
    const scores = factors.filter((f) => f.group === g && f.score !== null).map((f) => f.score!);
    groups[g] = scores.length > 0 ? mean(scores) : null;
  }
  return { groups, composite: composite(groups), coverage: factors.filter((f) => f.score !== null).length / total };
}

type Cache = { builtAt: number; day: string; dists: Dists; bench: Bench };
let cache: Cache | null = null;

export type Computed = { cards: Scorecard[]; dists: Dists; bench: Bench };

/** Scores every US stock with a profile. Pure reads; nothing is written. */
export function computeScorecards(day: string): Computed {
  const funds = loadFundamentals(day);
  const bench = loadBench();
  const spyDays = loadDaily("SPY").days;
  const newest = spyDays[spyDays.length - 1] ?? day;
  const oldestOk = addDays(newest, -STALE_BAR_DAYS);

  const rows = funds.map((f) => {
    const daily = loadDaily(f.symbol);
    const fresh = daily.days.length > 0 && daily.days[daily.days.length - 1] >= oldestOk;
    return { f, raw: { ...f.raw, ...(fresh ? momentumRaw(daily.closes, f.sector, bench) : {}) } };
  });
  const dists = buildDists(rows.map((r) => ({ sector: r.f.sector, raw: r.raw })));
  const asOf = new Date().toISOString();
  const cards = rows.map(({ f, raw }): Scorecard => {
    const factors = FACTORS.map((def) => ({ key: def.key, group: def.group, value: raw[def.key] ?? null, score: scoreFactor(dists, def, f.sector, raw[def.key] ?? null), change: null }));
    const s = summarize(factors, FACTORS.length);
    return { symbol: f.symbol, asOf, sector: f.sector || null, industry: f.industry, composite: s.composite, groups: s.groups, factors, coverage: s.coverage, weightsVersion: STOCK_WEIGHTS_VERSION };
  });
  return { cards, dists, bench };
}

/** Fills each factor's `change` from the card nearest to 20 trading days before `day`, when one exists. */
function addChanges(cards: Scorecard[], day: string): void {
  const prior = db.prepare("SELECT MAX(day) AS d FROM scorecards WHERE day <= ? AND day >= ?").get(addDays(day, -CHANGE_DAYS), addDays(day, -CHANGE_DAYS - 14)) as { d: string | null };
  if (!prior.d) return;
  const old = new Map<string, Compact>();
  for (const r of db.prepare("SELECT symbol, factors FROM scorecards WHERE day = ? AND factors IS NOT NULL").iterate(prior.d) as Iterable<{ symbol: string; factors: string }>) {
    old.set(r.symbol, JSON.parse(r.factors));
  }
  for (const c of cards) {
    const was = old.get(c.symbol);
    if (!was) continue;
    for (const f of c.factors) {
      const before = was[f.key]?.[1];
      if (f.score !== null && before !== null && before !== undefined) f.change = f.score - before;
    }
  }
}

const upsertCard = db.prepare(
  `INSERT OR REPLACE INTO scorecards (day, symbol, sector, industry, composite, groups, factors, coverage, weights_version)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

export type NightlyResult = { day: string; scored: number; withComposite: number; durationMs: number };

/** The nightly pass: score every US stock, store the day's cards, trim old factor detail. */
export function runNightlyScorecards(now = new Date()): NightlyResult {
  const started = Date.now();
  const day = nyClock(now).date;
  const { cards, dists, bench } = computeScorecards(day);
  addChanges(cards, day);
  db.transaction(() => {
    for (const c of cards) {
      upsertCard.run(day, c.symbol, c.sector, c.industry, round(c.composite, 5), JSON.stringify(c.groups), JSON.stringify(pack(c.factors)), round(c.coverage, 3), c.weightsVersion);
    }
    db.prepare("UPDATE scorecards SET factors = NULL WHERE factors IS NOT NULL AND day < ?").run(addDays(day, -FACTORS_KEPT_DAYS));
  })();
  cache = { builtAt: Date.now(), day, dists, bench };
  return { day, scored: cards.length, withComposite: cards.filter((c) => c.composite !== null).length, durationMs: Date.now() - started };
}

type CardRow = {
  symbol: string;
  sector: string | null;
  industry: string | null;
  composite: number | null;
  groups: string;
  factors: string | null;
  coverage: number;
  weights_version: string;
  day?: string;
  as_of?: string;
  rank?: number | null;
};

function toCard(r: CardRow): Scorecard {
  return {
    symbol: r.symbol,
    asOf: r.as_of ?? r.day ?? "",
    sector: r.sector,
    industry: r.industry,
    composite: r.composite,
    groups: JSON.parse(r.groups),
    factors: unpack(r.factors ? JSON.parse(r.factors) : null),
    coverage: r.coverage,
    weightsVersion: r.weights_version,
  };
}

export function latestScorecardDay(): string | null {
  return (db.prepare("SELECT MAX(day) AS d FROM scorecards").get() as { d: string | null }).d;
}

/** The latest nightly card. */
export function getStockScorecard(symbol: string): Scorecard | null {
  const r = db.prepare("SELECT * FROM scorecards WHERE symbol = ? ORDER BY day DESC LIMIT 1").get(symbol) as CardRow | undefined;
  return r ? toCard(r) : null;
}

export function getLiveScorecard(symbol: string): (Scorecard & { rank: number | null }) | null {
  const r = db.prepare("SELECT * FROM scorecards_live WHERE symbol = ?").get(symbol) as CardRow | undefined;
  return r ? { ...toCard(r), rank: r.rank ?? null } : null;
}

/** Latest composite per symbol: the live card if there is one, else the nightly. */
export function compositeMap(symbols: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (symbols.length === 0) return out;
  const json = JSON.stringify(symbols);
  const day = latestScorecardDay();
  if (day) {
    for (const r of db.prepare("SELECT symbol, composite FROM scorecards WHERE day = ? AND composite IS NOT NULL AND symbol IN (SELECT value FROM json_each(?))").all(day, json) as Array<{ symbol: string; composite: number }>) {
      out.set(r.symbol, r.composite);
    }
  }
  for (const r of db.prepare("SELECT symbol, composite FROM scorecards_live WHERE composite IS NOT NULL AND symbol IN (SELECT value FROM json_each(?))").all(json) as Array<{ symbol: string; composite: number }>) {
    out.set(r.symbol, r.composite);
  }
  return out;
}

/** Cards of the latest nightly day for these symbols, composite order (best first), with at least `minCoverage`. */
export function topNightly(symbols: string[], minCoverage: number, limit: number): Scorecard[] {
  const day = latestScorecardDay();
  if (!day || symbols.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM scorecards WHERE day = ? AND composite IS NOT NULL AND coverage >= ? AND symbol IN (SELECT value FROM json_each(?))
       ORDER BY composite DESC, symbol LIMIT ?`
    )
    .all(day, minCoverage, JSON.stringify(symbols), limit) as CardRow[];
  return rows.map(toCard);
}

// ---- intraday ----

const MARKET_MINUTES = 390;
const INTRADAY_FRESH_SECONDS = 20 * 60; // minute bars older than this mean the market is closed or the feed is behind

let curve: { day: string; fraction: number[] } | null = null;

/** Share of a day's volume traded by each minute of the session, averaged over SPY's last 20 sessions (linear without data). */
function volumeCurve(day: string, openSec: number): number[] {
  if (curve?.day === day) return curve.fraction;
  const bars = minuteBars("SPY", openSec - 35 * 86_400, openSec - 1, 20_000);
  const perDay = new Map<number, number[]>();
  for (const b of bars) {
    const dayOpen = nyInstant(tradingDay(b.ts), 9, 30) / 1000;
    const m = Math.floor((b.ts - dayOpen) / 60);
    if (m < 0 || m >= MARKET_MINUTES) continue;
    const arr = perDay.get(dayOpen) ?? new Array<number>(MARKET_MINUTES).fill(0);
    arr[m] += b.volume;
    perDay.set(dayOpen, arr);
  }
  const days = [...perDay.values()].filter((a) => a.reduce((x, y) => x + y, 0) > 0).slice(-20);
  const fraction = new Array<number>(MARKET_MINUTES).fill(0);
  if (days.length === 0) fraction.forEach((_, i) => (fraction[i] = (i + 1) / MARKET_MINUTES));
  else {
    for (const a of days) {
      const total = a.reduce((x, y) => x + y, 0);
      let cum = 0;
      a.forEach((v, i) => {
        cum += v;
        fraction[i] += cum / total / days.length;
      });
    }
  }
  curve = { day, fraction };
  return fraction;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

type LiveInputs = { price: number | null; vwapPct: number | null; rsi15: number | null; relVolume: number | null; prevClose: number | null };

/** Price, VWAP gap, 15-minute RSI and time-of-day-adjusted volume for one symbol; nulls when today's minute bars are missing or stale. */
function liveInputs(symbol: string, daily: Daily, today: string, now: Date): LiveInputs {
  const openSec = nyInstant(today, 9, 30) / 1000;
  const bars = minuteBars(symbol, openSec - 8 * 86_400, openSec + 86_400);
  const todayBars = bars.filter((b) => b.ts >= openSec && b.ts < openSec + MARKET_MINUTES * 60);
  const lastBar = todayBars[todayBars.length - 1];
  const fresh = lastBar !== undefined && now.getTime() / 1000 - lastBar.ts <= INTRADAY_FRESH_SECONDS + 60;
  const closedIdx = daily.days.findIndex((d) => d >= today);
  const closed = closedIdx < 0 ? daily.days.length : closedIdx;
  const prevClose = closed > 0 ? daily.closes[closed - 1] : null;
  const price = liveQuote(symbol, symbol, now)?.price ?? lastBar?.close ?? null;
  if (!fresh || price === null) return { price, vwapPct: null, rsi15: null, relVolume: null, prevClose };

  const vw = vwap(todayBars);
  const vwNow = vw.length > 0 ? vw[vw.length - 1].value : null;
  const r15 = rollup(bars, 15);
  const rs = r15.length >= 16 ? rsi(r15, 14) : [];
  const vols = daily.volumes.slice(Math.max(0, closed - 20), closed);
  const avg = vols.length >= 10 ? mean(vols) : 0;
  const m = Math.min(MARKET_MINUTES - 1, Math.max(0, Math.floor((lastBar.ts - openSec) / 60)));
  const frac = volumeCurve(today, openSec)[m];
  const cum = todayBars.reduce((a, b) => a + b.volume, 0);
  return {
    price,
    vwapPct: vwNow ? (price / vwNow - 1) * 100 : null,
    rsi15: rs.length > 0 ? rs[rs.length - 1].value : null,
    relVolume: avg > 0 && frac > 0.02 ? cum / (avg * frac) : null,
    prevClose,
  };
}

export type IntradayResult = { scored: number; durationMs: number };

/**
 * The 15-minute pass for the universe: momentum recomputed with live prices
 * plus intraday factors, then composites and ranks. Other groups come from
 * the latest nightly card, so symbols without one are skipped.
 */
export function runIntradayStockScan(symbols: string[], now = new Date()): IntradayResult {
  const started = Date.now();
  const today = nyClock(now).date;
  if (!cache || Date.now() - cache.builtAt > 24 * 3_600_000) {
    const c = computeScorecards(today);
    cache = { builtAt: Date.now(), day: today, dists: c.dists, bench: c.bench };
  }
  const { dists } = cache;
  // Benchmarks move intraday too.
  const livePrice = (s: string, daily: Daily) => liveQuote(s, s, now)?.price ?? daily.closes[daily.closes.length - 1];
  const bench: Bench = { spy6m: null, etf3m: new Map() };
  const withLive = (s: string, days: number): number | null => {
    const d = loadDaily(s);
    if (d.closes.length === 0) return null;
    const p = livePrice(s, d);
    const closes = d.days[d.days.length - 1] >= today ? [...d.closes.slice(0, -1), p] : [...d.closes, p];
    return periodReturn(closes, days);
  };
  bench.spy6m = withLive("SPY", 126);
  for (const e of Object.values(SECTOR_ETF)) bench.etf3m.set(e, withLive(e, 63));

  const day = latestScorecardDay();
  const nightly = new Map<string, CardRow>();
  if (day && symbols.length > 0) {
    for (const r of db.prepare("SELECT * FROM scorecards WHERE day = ? AND symbol IN (SELECT value FROM json_each(?))").all(day, JSON.stringify(symbols)) as CardRow[]) nightly.set(r.symbol, r);
  }

  const out: Array<{ card: Scorecard }> = [];
  for (const symbol of symbols) {
    const row = nightly.get(symbol);
    if (!row || !row.factors) continue;
    const sector = row.sector ?? "";
    const daily = loadDaily(symbol);
    const li = liveInputs(symbol, daily, today, now);
    const factors = unpack(JSON.parse(row.factors));
    const byKey = new Map(factors.map((f) => [f.key, f]));
    if (li.price !== null && daily.closes.length > 0) {
      const closes = daily.days[daily.days.length - 1] >= today ? [...daily.closes.slice(0, -1), li.price] : [...daily.closes, li.price];
      const raw = momentumRaw(closes, sector, bench);
      for (const def of FACTORS.filter((f) => f.group === "momentum")) {
        const f = byKey.get(def.key);
        if (!f) continue;
        f.value = raw[def.key] ?? null;
        f.score = scoreFactor(dists, def, sector, f.value);
        f.change = null;
      }
    }
    // Fixed maps: a 2% gap to VWAP spans the range, RSI is its own scale, volume only counts in the direction of the day.
    const up = li.prevClose !== null && li.price !== null ? li.price >= li.prevClose : true;
    const extra: FactorScore[] = [
      { key: "price_vs_vwap", group: "momentum", value: round(li.vwapPct, 4), score: li.vwapPct === null ? null : clamp(50 + 25 * li.vwapPct), change: null },
      { key: "rsi_15m", group: "momentum", value: round(li.rsi15, 4), score: li.rsi15, change: null },
      { key: "rel_volume", group: "momentum", value: round(li.relVolume, 4), score: li.relVolume === null ? null : clamp(50 + (up ? 1 : -1) * (Math.min(li.relVolume, 3) - 1) * 25), change: null },
    ];
    const all = [...factors.filter((f) => !extra.some((e) => e.key === f.key)), ...extra];
    const s = summarize(all, FACTORS.length + LIVE_FACTORS.length);
    out.push({
      card: { symbol, asOf: now.toISOString(), sector: row.sector, industry: row.industry, composite: s.composite, groups: s.groups, factors: all, coverage: s.coverage, weightsVersion: STOCK_WEIGHTS_VERSION },
    });
  }

  const ranked = out.filter((o) => o.card.composite !== null).sort((a, b) => b.card.composite! - a.card.composite!);
  const rank = new Map(ranked.map((o, i) => [o.card.symbol, i + 1]));
  const put = db.prepare(
    `INSERT OR REPLACE INTO scorecards_live (symbol, as_of, sector, industry, composite, groups, factors, coverage, weights_version, rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM scorecards_live WHERE symbol NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(symbols));
    for (const { card: c } of out) {
      put.run(c.symbol, c.asOf, c.sector, c.industry, round(c.composite, 5), JSON.stringify(c.groups), JSON.stringify(pack(c.factors)), round(c.coverage, 3), c.weightsVersion, rank.get(c.symbol) ?? null);
    }
  })();
  return { scored: out.length, durationMs: Date.now() - started };
}
