import { Router } from "express";
import { db } from "../../db.js";
import { tradingDay } from "../../history/time.js";
import { addDays, calendarFor, history, revisions } from "../../estimates/store.js";
import { timingsFor } from "../../estimates/timing.js";
import * as bulk from "../../research/bulk-store.js";
import { newestStoredDate } from "../../research/transcripts-store.js";
import * as fmp from "../../providers/fmp.js";
import { cached, FmpError, fmpSymbol, get } from "../../providers/fmp-core.js";
import * as content from "../../providers/fmp-content.js";
import * as fundamentals from "../../providers/fmp-fundamentals.js";
import * as market from "../../providers/fmp-market.js";
import * as ownership from "../../providers/fmp-ownership.js";
import { getQuotes } from "../market.js";
import { envelope, parseSymbol } from "./common.js";

// GET /api/research/:symbol: one snapshot an analysis agent calls first.
// Sections are built in parallel from the providers and local tables (not
// through the HTTP routes); one that fails or is still running at the deadline
// becomes { error } and the rest return as usual.

export const router = Router();

/** Words that name a route group; mounted last, so without this /market would be read as a symbol. */
const RESERVED = new Set(["MARKET", "SCREEN", "DATASETS"]);
export const DEADLINE_MS = 3_000;
const WINDOW_DAYS = 90;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

type Failed = { error: string };
type Row = Record<string, any>;

function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const key = process.env.FMP_API_KEY?.trim();
  return key ? raw.split(key).join("[redacted]") : raw;
}

/** Runs one part; a throw becomes { error }. */
async function guard<T>(run: () => T | Promise<T>): Promise<T | Failed> {
  try {
    return await run();
  } catch (err) {
    return { error: message(err) };
  }
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
/** Percent change, (now - old) / |old|; null without a usable old value. */
const pctChange = (now: number | null, old: number | null): number | null => (now === null || old === null || old === 0 ? null : round(((now - old) / Math.abs(old)) * 100));

/** A copy of the row without its `symbol` (the caller knows it). */
function withoutSymbol(row: Row): Row {
  const copy = { ...row };
  delete copy.symbol;
  return copy;
}

function ignorePlan<T>(fallback: T) {
  return (err: unknown): T => {
    if (err instanceof FmpError && (err.status === 402 || err.status === 403)) return fallback;
    throw err;
  };
}

// ---- sections ----

async function quoteSection(symbol: string) {
  const q = (await getQuotes([symbol]))[0];
  if (!q) throw new Error("no quote from any provider");
  const { price, change, changePercent, previousClose, open, high, low, volume, avgVolume, marketCap, week52High, week52Low, marketState, time, source, asOf, extended, currency } = q;
  return { price, change, changePercent, previousClose, open, high, low, volume, avgVolume, marketCap, week52High, week52Low, currency, marketState, time, source, asOf, extended: extended ?? null };
}

async function profileSection(symbol: string) {
  const [row, float] = await Promise.all([
    Promise.resolve(bulk.profiles([symbol]).get(symbol)),
    ownership.getFloat(symbol).catch(() => null),
  ]);
  const floatPart = { floatShares: float?.floatShares ?? null, freeFloatPercent: float?.freeFloat ?? null, sharesOutstanding: float?.outstandingShares ?? null };
  if (row) {
    return { name: row.name, exchange: row.exchange, sector: row.sector, industry: row.industry, marketCap: row.marketCap, beta: row.beta, ...floatPart, source: "bulk" };
  }
  const p = (await market.companyProfile(symbol)).profile;
  if (!p) throw new Error("no profile");
  return { name: p.companyName ?? null, exchange: p.exchange ?? null, sector: p.sector ?? null, industry: p.industry ?? null, marketCap: numberOrNull(p.marketCap), beta: numberOrNull(p.beta), ...floatPart, source: "fmp" };
}

type ValuationRow = { pe: number | null; price_to_sales: number | null; ev_to_ebitda: number | null; fcf_yield: number | null; dcf: number | null; dcf_price: number | null; dcf_date: string | null; price: number | null };

async function valuationSection(symbol: string, livePrice: Promise<number | null>) {
  const r = db
    .prepare(
      `SELECT r.pe AS pe, r.price_to_sales AS price_to_sales, k.ev_to_ebitda AS ev_to_ebitda, k.fcf_yield AS fcf_yield,
              d.dcf AS dcf, d.stock_price AS dcf_price, d.date AS dcf_date, p.price AS price
       FROM bulk_profiles p
       LEFT JOIN bulk_ratios_ttm r ON r.symbol = p.symbol
       LEFT JOIN bulk_key_metrics_ttm k ON k.symbol = p.symbol
       LEFT JOIN bulk_dcf d ON d.symbol = p.symbol
       WHERE p.symbol = ?`
    )
    .get(symbol) as ValuationRow | undefined;
  let v: Omit<ValuationRow, "price"> & { source: string };
  let bulkPrice = r?.price ?? null;
  if (r && (r.pe !== null || r.ev_to_ebitda !== null || r.dcf !== null)) {
    v = { ...r, source: "bulk" };
  } else {
    const [m, d] = await Promise.all([fundamentals.metrics(symbol, "ttm", 1, {}), fundamentals.valuation(symbol)]);
    const ratios = (m.data[0]?.ratios ?? {}) as Row;
    const keyMetrics = (m.data[0]?.keyMetrics ?? {}) as Row;
    v = {
      pe: numberOrNull(ratios.priceToEarningsRatioTTM),
      price_to_sales: numberOrNull(ratios.priceToSalesRatioTTM),
      ev_to_ebitda: numberOrNull(keyMetrics.evToEBITDATTM),
      fcf_yield: numberOrNull(keyMetrics.freeCashFlowYieldTTM),
      dcf: numberOrNull(d.data.dcf?.dcf),
      dcf_price: numberOrNull(d.data.dcf?.["Stock Price"]),
      dcf_date: typeof d.data.dcf?.date === "string" ? d.data.dcf.date : null,
      source: "fmp",
    };
    bulkPrice = v.dcf_price;
  }
  const price = (await livePrice) ?? bulkPrice;
  return {
    pe: v.pe,
    evToEbitda: v.ev_to_ebitda,
    priceToSales: v.price_to_sales,
    fcfYield: v.fcf_yield,
    dcf: v.dcf,
    dcfDate: v.dcf_date,
    price,
    dcfVsPricePercent: v.dcf !== null && price ? round((v.dcf / price - 1) * 100) : null,
    source: v.source,
  };
}

type Quarter = { date: string; fiscalYear: string | null; period: string | null; revenue: number | null; epsDiluted: number | null };

function quarterlyIncome(symbol: string): Quarter[] {
  const rows = db
    .prepare("SELECT date, fiscal_year, period, revenue, eps_diluted FROM bulk_income_statements WHERE symbol = ? AND period LIKE 'Q%' ORDER BY date DESC LIMIT 8")
    .all(symbol) as Array<{ date: string; fiscal_year: string | number | null; period: string; revenue: number | null; eps_diluted: number | null }>;
  return rows.map((r) => ({ date: r.date, fiscalYear: r.fiscal_year === null ? null : String(r.fiscal_year), period: r.period, revenue: r.revenue, epsDiluted: r.eps_diluted }));
}

/** Period end of the newest reported quarter, from FMP's earnings history; null when unknown. */
const lastReportedEnd = (earnings: Promise<EarningsRows>) =>
  earnings.then((rows) => rows.find((r) => !r.upcoming && r.fiscalQtrEnd)?.fiscalQtrEnd ?? null).catch(() => null);

async function growthSection(symbol: string, earnings: Promise<EarningsRows>) {
  let quarters = quarterlyIncome(symbol);
  let source = "bulk";
  // The bulk files are keyed by fiscal year and hold only the current and previous calendar year's (NVDA's FY2027 is missing), so
  // they can lag the latest report or lack the prior-year quarters; FMP's per-symbol statements are then used.
  const reportedEnd = await lastReportedEnd(earnings);
  if (quarters.length < 8 || (reportedEnd !== null && quarters[0].date < reportedEnd)) {
    try {
      const rows = (await fundamentals.statements(symbol, "income", "quarter", 8, {})).data;
      quarters = rows.map((r) => ({ date: String(r.date), fiscalYear: r.fiscalYear === undefined ? null : String(r.fiscalYear), period: typeof r.period === "string" ? r.period : null, revenue: numberOrNull(r.revenue), epsDiluted: numberOrNull(r.epsDiluted) }));
      source = "fmp";
    } catch (err) {
      if (quarters.length === 0) throw err;
      source = "bulk (may lag the latest report)";
    }
  }
  // The same quarter a year earlier: the row ending 350-380 days before.
  const yearAgo = (q: Quarter) => {
    const t = Date.parse(q.date);
    return quarters.find((o) => {
      const d = (t - Date.parse(o.date)) / DAY_MS;
      return d >= 350 && d <= 380;
    });
  };
  return {
    quarters: quarters.slice(0, 4).map((q) => {
      const prior = yearAgo(q);
      return { ...q, revenueYoYPercent: pctChange(q.revenue, prior?.revenue ?? null), epsDilutedYoYPercent: pctChange(q.epsDiluted, prior?.epsDiluted ?? null) };
    }),
    source,
  };
}

type EarningsRows = Awaited<ReturnType<typeof fmp.earnings>>;

/** Close-to-close reaction around a report: a before-open report moves that day, any other the day after. */
function reaction(candles: Awaited<ReturnType<typeof fmp.historical>>, reported: number, timing: string | null) {
  const before = timing === "bmo";
  const idx = candles.findIndex((c) => c.time >= reported);
  if (idx < 0 || candles[idx].time - reported > 3 * 86_400) return null;
  const [from, to] = before ? [candles[idx - 1], candles[idx]] : [candles[idx], candles[idx + 1]];
  if (!from || !to) return null;
  return { dayAfterChangePercent: round(((to.close - from.close) / from.close) * 100), reactionBasis: before ? "report day close vs previous close" : "next day close vs report day close" };
}

async function earningsSection(symbol: string, earnings: Promise<EarningsRows>, today: string) {
  const sym = fmpSymbol(symbol);
  const rows = await earnings;
  const lastRow = rows.find((r) => !r.upcoming);
  const upcoming = rows.find((r) => r.upcoming);
  const timingRow = timingsFor([sym]).get(sym);
  const timing = timingRow?.timing ?? null;

  let last = null;
  if (lastRow) {
    const reported = day(lastRow.dateReported);
    const candles = await fmp.historical(symbol, addDays(reported, -7), addDays(reported, 7)).catch(() => []);
    last = {
      date: reported,
      fiscalPeriod: lastRow.fiscalPeriod ?? null,
      fiscalQtrEnd: lastRow.fiscalQtrEnd || null,
      epsActual: lastRow.eps,
      epsEstimate: lastRow.consensusForecast,
      epsSurprisePercent: lastRow.surprisePercent === null ? null : round(lastRow.surprisePercent),
      revenueActual: lastRow.revenue,
      revenueEstimate: lastRow.revenueEstimate,
      ...(reaction(candles, lastRow.dateReported, timing) ?? { dayAfterChangePercent: null, reactionBasis: null }),
    };
  }

  const cal = calendarFor([sym], today)[0];
  const nextDate = cal?.nextEarningsDate ? day(cal.nextEarningsDate) : upcoming ? day(upcoming.dateReported) : null;
  const points = nextDate ? history(sym, nextDate) : [];
  const next = nextDate
    ? {
        date: nextDate,
        timing,
        timingBasis: timingRow?.timing ? { matched: timingRow.matched, total: timingRow.total } : null,
        epsEstimate: cal?.nextEarningsDate ? cal.epsForecast : (upcoming?.consensusForecast ?? null),
        revenueEstimate: cal?.nextEarningsDate ? cal.revenueForecast : (upcoming?.revenueEstimate ?? null),
        revisions: revisions(points, today),
        revisionsTrackedSince: points[0]?.day ?? null,
      }
    : null;
  return { last, next };
}

async function estimatesSection(symbol: string, earnings: Promise<EarningsRows>, today: string) {
  // Periods that already reported drop out; FMP's list starts at the nearest period that may be unreported.
  const reportedEnd = (await lastReportedEnd(earnings)) ?? quarterlyIncome(symbol)[0]?.date ?? addDays(today, -100);
  const pick = (r: Row) => ({
    date: r.date,
    epsAvg: r.epsAvg,
    epsLow: r.epsLow,
    epsHigh: r.epsHigh,
    revenueAvg: r.revenueAvg,
    revenueLow: r.revenueLow,
    revenueHigh: r.revenueHigh,
    ebitdaAvg: r.ebitdaAvg,
    netIncomeAvg: r.netIncomeAvg,
    numAnalystsEps: r.numAnalystsEps,
    numAnalystsRevenue: r.numAnalystsRevenue,
  });
  const [quarters, years] = await Promise.all([
    fundamentals.analystEstimates(symbol, "quarter", 8, {}, today),
    fundamentals.analystEstimates(symbol, "annual", 4, {}, today),
  ]);
  const fresh = (rows: Row[]) => rows.filter((r) => String(r.date) > reportedEnd).slice(0, 2).map(pick);
  return { quarters: fresh(quarters.data), fiscalYears: fresh(years.data) };
}

type BulkAnalysts = { consensus: Row | null; targets: Row | null; rating: Row | null };

function bulkAnalysts(symbol: string): BulkAnalysts {
  const one = (sql: string) => (db.prepare(sql).get(symbol) as Row | undefined) ?? null;
  return {
    consensus: one("SELECT strong_buy AS strongBuy, buy, hold, sell, strong_sell AS strongSell, consensus FROM bulk_grades_consensus WHERE symbol = ?"),
    targets: one("SELECT last_quarter_count AS lastQuarterCount, last_quarter_avg AS lastQuarterAvg, last_year_count AS lastYearCount, last_year_avg AS lastYearAvg FROM bulk_price_targets WHERE symbol = ?"),
    rating: one("SELECT rating, overall_score AS overallScore FROM bulk_ratings WHERE symbol = ?"),
  };
}

async function recentGrades(symbol: string, limit: number): Promise<Row[]> {
  const rows = await cached(`summary:grades:${symbol}:${limit}`, HOUR, async () => {
    const raw = await get("grades", { symbol, limit }).catch(ignorePlan([]));
    return Array.isArray(raw) ? raw : [];
  });
  return rows.slice(0, limit).map(withoutSymbol);
}

async function analystsSection(symbol: string, livePrice: Promise<number | null>) {
  const b = bulkAnalysts(symbol);
  if (!b.consensus && !b.targets) {
    const a = (await fundamentals.analysts(symbol, 5, {})).data;
    const s = a.priceTargetSummary;
    return {
      consensus: a.gradesConsensus ? withoutSymbol(a.gradesConsensus) : null,
      rating: a.ratingsSnapshot ? { rating: a.ratingsSnapshot.rating, overallScore: a.ratingsSnapshot.overallScore } : null,
      priceTarget: s ? { lastQuarterCount: s.lastQuarterCount, lastQuarterAvg: s.lastQuarterAvgPriceTarget, lastYearCount: s.lastYearCount, lastYearAvg: s.lastYearAvgPriceTarget, ...(a.priceTargetConsensus ? { high: a.priceTargetConsensus.targetHigh, low: a.priceTargetConsensus.targetLow, consensus: a.priceTargetConsensus.targetConsensus, median: a.priceTargetConsensus.targetMedian } : {}), upsidePercent: null } : null,
      recentGrades: a.grades.slice(0, 5).map(withoutSymbol),
      source: "fmp",
    };
  }
  const [grades, price] = await Promise.all([recentGrades(symbol, 5), livePrice]);
  const target = b.targets ? (b.targets.lastQuarterCount > 0 ? b.targets.lastQuarterAvg : b.targets.lastYearAvg) : null;
  return {
    consensus: b.consensus,
    rating: b.rating,
    priceTarget: b.targets ? { ...b.targets, upsidePercent: target && price ? round((target / price - 1) * 100) : null } : null,
    recentGrades: grades,
    source: "bulk",
  };
}

const INSIDER_LIMIT = 300;

async function insiderPart(symbol: string, since: string) {
  const { trades } = await ownership.getInsiders(symbol, INSIDER_LIMIT);
  const inWindow = trades.filter((t) => typeof t.transactionDate === "string" && t.transactionDate >= since);
  const side = (prefix: string) => {
    const list = inWindow.filter((t) => String(t.transactionType ?? "").startsWith(prefix));
    const shares = list.reduce((s, t) => s + (numberOrNull(t.securitiesTransacted) ?? 0), 0);
    const value = list.reduce((s, t) => s + (numberOrNull(t.securitiesTransacted) ?? 0) * (numberOrNull(t.price) ?? 0), 0);
    return { transactions: list.length, shares, value: Math.round(value) };
  };
  const buys = side("P-");
  const sells = side("S-");
  const oldest = trades.at(-1)?.transactionDate;
  return {
    windowDays: WINDOW_DAYS,
    basis: "open-market purchases (P-Purchase) and sales (S-Sale) by transaction date; awards, gifts and tax withholding excluded",
    buys,
    sells,
    netShares: buys.shares - sells.shares,
    netValue: buys.value - sells.value,
    truncated: trades.length >= INSIDER_LIMIT && typeof oldest === "string" && oldest >= since,
  };
}

async function congressPart(symbol: string, since: string) {
  const trades = (await ownership.getCongress(symbol, 100)).filter((t) => typeof t.transactionDate === "string" && t.transactionDate >= since);
  const kind = (t: Row) => (String(t.type ?? "").startsWith("Purchase") ? "buy" : String(t.type ?? "").startsWith("Sale") ? "sell" : "other");
  return {
    windowDays: WINDOW_DAYS,
    purchases: trades.filter((t) => kind(t) === "buy").length,
    sales: trades.filter((t) => kind(t) === "sell").length,
    trades: trades.slice(0, 5).map((t) => ({
      chamber: t.chamber,
      name: [t.firstName, t.lastName].filter(Boolean).join(" "),
      type: t.type,
      amount: t.amount,
      transactionDate: t.transactionDate,
      disclosureDate: t.disclosureDate,
      disclosureLagDays: t.disclosureLagDays,
    })),
  };
}

async function ownershipSection(symbol: string, today: string) {
  const since = addDays(today, -WINDOW_DAYS);
  const [institutional, insiders, congress] = await Promise.all([
    guard(async () => {
      const { year, quarter, summary } = await ownership.getInstitutional(symbol);
      if (!summary) return null;
      const pick = ["date", "investorsHolding", "investorsHoldingChange", "numberOf13Fshares", "numberOf13FsharesChange", "ownershipPercent", "ownershipPercentChange", "newPositions", "increasedPositions", "reducedPositions", "closedPositions"];
      return { year, quarter, ...Object.fromEntries(pick.map((k) => [k, (summary as Row)[k] ?? null])) };
    }),
    guard(() => insiderPart(symbol, since)),
    guard(() => congressPart(symbol, since)),
  ]);
  return { institutional, insiders, congress };
}

async function recentSection(symbol: string) {
  const [releases, transcript] = await Promise.all([
    content.pressReleases(symbol, 5),
    content
      .transcriptDates(symbol)
      .then((d) => d[0] ?? null)
      .catch(() => null),
  ]);
  const stored = transcript ? null : newestStoredDate(symbol);
  return {
    pressReleases: releases.slice(0, 5).map((r) => ({ publishedDate: r.publishedDate, title: r.title, publisher: r.publisher })),
    latestTranscript: transcript ?? (stored ? { date: stored } : null),
  };
}

async function contextSection(symbol: string) {
  const profile = bulk.profiles([symbol]).get(symbol);
  const peerRow = db.prepare("SELECT peers FROM bulk_peers WHERE symbol = ?").get(symbol) as { peers: string } | undefined;
  const listed = (peerRow?.peers ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const peerSymbols = listed.length > 0 ? listed : (await fundamentals.peers(symbol)).data.map((p) => String(p.symbol));
  const known = bulk.profiles(peerSymbols);
  const top = [...known.values()].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, 6).map((p) => p.symbol);

  const [peers, sector] = await Promise.all([
    top.length === 0 ? [] : fmp.quotes(top).then((m) => top.map((s) => ({ symbol: s, changePercent: m.get(s)?.changePercent ?? null }))),
    guard(async () => {
      if (!profile?.sector) throw new Error("no sector for symbol");
      const exchange = profile.exchange === "NASDAQ" ? "NASDAQ" : "NYSE";
      const snapshot = await market.sectors(exchange);
      const row = snapshot.rows.find((r) => String(r.sector).toLowerCase() === profile.sector!.toLowerCase());
      if (!row) throw new Error(`no ${exchange} snapshot for ${profile.sector}`);
      return { name: profile.sector, exchange, date: snapshot.date, averageChangePercent: numberOrNull(row.averageChange), pe: numberOrNull(row.pe) };
    }),
  ]);
  const changes = peers.map((p) => p.changePercent).filter((c): c is number => c !== null);
  return { sector, peers, peersAverageChangePercent: changes.length > 0 ? round(changes.reduce((a, b) => a + b, 0) / changes.length) : null };
}

export function linksFor(symbol: string): Record<string, string | string[]> {
  const r = `/api/research/${symbol}`;
  return {
    quote: `/api/quotes?symbols=${symbol}`,
    profile: `${r}/profile`,
    valuation: [`${r}/valuation`, `${r}/metrics?period=ttm`],
    growth: [`${r}/growth?period=quarter`, `${r}/statements?type=income&period=quarter`],
    earnings: [`/api/earnings-history/${symbol}`, `/api/calendar?symbols=${symbol}`, `/api/estimates/${symbol}`],
    estimates: `${r}/estimates?period=quarter`,
    analysts: `${r}/analysts`,
    ownership: [`${r}/institutional`, `${r}/insiders`, `${r}/congress`, `${r}/float`],
    recent: [`${r}/press-releases`, `${r}/news`, `${r}/transcripts`, `${r}/filings`],
    context: [`${r}/peers`, "/api/research/market/sectors"],
  };
}

// ---- assembly ----

export async function buildSummary(symbol: string, o: { deadlineMs?: number; now?: Date } = {}) {
  const deadlineMs = o.deadlineMs ?? DEADLINE_MS;
  const today = tradingDay((o.now ?? new Date()).toISOString());

  // Shared by sections that need them; a failure surfaces in each section that awaits it.
  const quote = quoteSection(symbol);
  quote.catch(() => undefined);
  const livePrice = quote.then((q) => q.price).catch(() => null);
  const earnings = fmp.earnings(symbol, 8, o.now);
  earnings.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Failed>((resolve) => {
    timer = setTimeout(() => resolve({ error: `timed out after ${deadlineMs} ms` }), deadlineMs);
  });
  const section = <T>(run: () => T | Promise<T>): Promise<T | Failed> => Promise.race([guard(run), late]);

  const [q, profile, valuation, growth, earn, estimates, analysts, own, recent, context] = await Promise.all([
    section(() => quote),
    section(() => profileSection(symbol)),
    section(() => valuationSection(symbol, livePrice)),
    section(() => growthSection(symbol, earnings)),
    section(() => earningsSection(symbol, earnings, today)),
    section(() => estimatesSection(symbol, earnings, today)),
    section(() => analystsSection(symbol, livePrice)),
    section(() => ownershipSection(symbol, today)),
    section(() => recentSection(symbol)),
    section(() => contextSection(symbol)),
  ]);
  clearTimeout(timer);

  return { quote: q, profile, valuation, growth, earnings: earn, estimates, analysts, ownership: own, recent, context, links: linksFor(symbol) };
}

router.get("/:symbol", async (req, res) => {
  if (RESERVED.has(String(req.params.symbol).toUpperCase())) {
    res.status(400).json({ error: `"${req.params.symbol}" is not a symbol: see /api/research/market/... and /api/research/screen` });
    return;
  }
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  res.json(envelope({ symbol, dataset: "summary", data: await buildSummary(symbol) }));
});
