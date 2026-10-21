import { db } from "../db.js";
import { isForeignSymbol } from "../history/universe.js";
import * as bulk from "../providers/fmp-bulk.js";
import type { CsvRow } from "../providers/fmp-bulk.js";
import { isConfigured } from "../providers/fmp-core.js";

// Whole-market FMP data from the bulk endpoints (see providers/fmp-bulk.ts),
// US listings only, in bulk_* tables. Each row keeps FMP's record as JSON in
// `data` (FMP's field names and types), plus typed copies of the fields the
// screen and the quote/heatmap paths read. Symbols are in the app's form
// (BRK.B).
//
// Daily datasets refresh after 6 AM New York time, weekly ones (statements)
// once seven days have passed, both checked every 15 minutes and at startup;
// a failed dataset waits an hour before the next try.

type Col = { name: string; field: string | ((row: CsvRow) => unknown) };

type Dataset = {
  name: string;
  table: string;
  schedule: "daily" | "weekly";
  /** Primary key columns, in addition to symbol. */
  key: string[];
  cols: Col[];
  /** Downloads for one run; profile-bulk is paged. */
  calls: (now: Date) => Array<{ path: string; params: Record<string, string | number>; paged?: true }>;
  /** Snapshot datasets drop the symbols a complete run no longer has; history (statements, surprises) keeps them. */
  snapshot: boolean;
};

const DAY_MS = 86_400_000;
const CHECK_EVERY_MS = 15 * 60_000;
const RETRY_AFTER_ERROR_MS = 3_600_000;
const REFRESH_HOUR_NY = 6;
const BATCH = 2_000;

const STATEMENT_PERIODS = ["FY", "Q1", "Q2", "Q3", "Q4"];

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function nyClock(at: Date): { y: number; m: number; d: number; h: number; offsetMs: number } {
  const p = Object.fromEntries(nyParts.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, offsetMs: wall - Math.floor(at.getTime() / 1000) * 1000 };
}

/** The latest 6 AM New York time at or before `now`. */
export function refreshBoundary(now: Date): Date {
  const c = nyClock(now);
  const sixToday = Date.UTC(c.y, c.m - 1, c.d, REFRESH_HOUR_NY) - c.offsetMs;
  return new Date(c.h >= REFRESH_HOUR_NY ? sixToday : sixToday - DAY_MS);
}

function nyYear(now: Date): number {
  return nyClock(now).y;
}

function statementCalls(path: string) {
  return (now: Date) => {
    const year = nyYear(now);
    // year + 1: fiscal years that run ahead of the calendar year (NVDA's FY2027 began in 2026).
    return [year + 1, year, year - 1].flatMap((y) => STATEMENT_PERIODS.map((period) => ({ path, params: { year: y, period } })));
  };
}

const statementCols: Col[] = [
  { name: "fiscal_year", field: "fiscalYear" },
  { name: "reported_currency", field: "reportedCurrency" },
];

export const DATASETS: Dataset[] = [
  {
    name: "profile",
    table: "bulk_profiles",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "profile-bulk", params: {}, paged: true }],
    cols: [
      { name: "company_name", field: "companyName" },
      { name: "exchange", field: "exchange" },
      { name: "sector", field: "sector" },
      { name: "industry", field: "industry" },
      { name: "country", field: "country" },
      { name: "currency", field: "currency" },
      { name: "price", field: "price" },
      { name: "market_cap", field: "marketCap" },
      { name: "beta", field: "beta" },
      { name: "average_volume", field: "averageVolume" },
      { name: "year_range", field: "range" },
      { name: "is_etf", field: "isEtf" },
      { name: "is_fund", field: "isFund" },
      { name: "is_adr", field: "isAdr" },
      { name: "is_actively_trading", field: "isActivelyTrading" },
    ],
  },
  {
    name: "ratios-ttm",
    table: "bulk_ratios_ttm",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "ratios-ttm-bulk", params: {} }],
    cols: [
      { name: "pe", field: "priceToEarningsRatioTTM" },
      { name: "peg", field: "priceToEarningsGrowthRatioTTM" },
      { name: "price_to_book", field: "priceToBookRatioTTM" },
      { name: "price_to_sales", field: "priceToSalesRatioTTM" },
      { name: "price_to_fcf", field: "priceToFreeCashFlowRatioTTM" },
      { name: "eps", field: "netIncomePerShareTTM" },
      { name: "dividend_yield", field: "dividendYieldTTM" },
      { name: "payout_ratio", field: "dividendPayoutRatioTTM" },
      { name: "gross_margin", field: "grossProfitMarginTTM" },
      { name: "operating_margin", field: "operatingProfitMarginTTM" },
      { name: "net_margin", field: "netProfitMarginTTM" },
      { name: "debt_to_equity", field: "debtToEquityRatioTTM" },
      { name: "current_ratio", field: "currentRatioTTM" },
    ],
  },
  {
    name: "key-metrics-ttm",
    table: "bulk_key_metrics_ttm",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "key-metrics-ttm-bulk", params: {} }],
    cols: [
      { name: "enterprise_value", field: "enterpriseValueTTM" },
      { name: "ev_to_ebitda", field: "evToEBITDATTM" },
      { name: "ev_to_sales", field: "evToSalesTTM" },
      { name: "net_debt_to_ebitda", field: "netDebtToEBITDATTM" },
      { name: "roe", field: "returnOnEquityTTM" },
      { name: "roa", field: "returnOnAssetsTTM" },
      { name: "roic", field: "returnOnInvestedCapitalTTM" },
      { name: "earnings_yield", field: "earningsYieldTTM" },
      { name: "fcf_yield", field: "freeCashFlowYieldTTM" },
    ],
  },
  {
    name: "rating",
    table: "bulk_ratings",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "rating-bulk", params: {} }],
    cols: [
      { name: "date", field: "date" },
      { name: "rating", field: "rating" },
      { name: "overall_score", field: (r) => bulk.ratingScore(r.rating) },
    ],
  },
  {
    name: "price-target-summary",
    table: "bulk_price_targets",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "price-target-summary-bulk", params: {} }],
    cols: [
      { name: "last_quarter_count", field: "lastQuarterCount" },
      { name: "last_quarter_avg", field: "lastQuarterAvgPriceTarget" },
      { name: "last_year_count", field: "lastYearCount" },
      { name: "last_year_avg", field: "lastYearAvgPriceTarget" },
    ],
  },
  {
    name: "upgrades-downgrades-consensus",
    table: "bulk_grades_consensus",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "upgrades-downgrades-consensus-bulk", params: {} }],
    cols: [
      { name: "strong_buy", field: "strongBuy" },
      { name: "buy", field: "buy" },
      { name: "hold", field: "hold" },
      { name: "sell", field: "sell" },
      { name: "strong_sell", field: "strongSell" },
      { name: "consensus", field: "consensus" },
    ],
  },
  {
    name: "earnings-surprises",
    table: "bulk_earnings_surprises",
    schedule: "daily",
    key: ["date"],
    snapshot: false,
    calls: (now) => [{ path: "earnings-surprises-bulk", params: { year: nyYear(now) } }],
    cols: [
      { name: "eps_actual", field: "epsActual" },
      { name: "eps_estimated", field: "epsEstimated" },
    ],
  },
  {
    name: "dcf",
    table: "bulk_dcf",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "dcf-bulk", params: {} }],
    cols: [
      { name: "date", field: "date" },
      { name: "dcf", field: "dcf" },
      { name: "stock_price", field: "Stock Price" },
    ],
  },
  {
    name: "peers",
    table: "bulk_peers",
    schedule: "daily",
    key: [],
    snapshot: true,
    calls: () => [{ path: "peers-bulk", params: {} }],
    cols: [{ name: "peers", field: "peers" }],
  },
  {
    name: "income-statement",
    table: "bulk_income_statements",
    schedule: "weekly",
    key: ["date", "period"],
    snapshot: false,
    calls: statementCalls("income-statement-bulk"),
    cols: [...statementCols, { name: "revenue", field: "revenue" }, { name: "net_income", field: "netIncome" }, { name: "eps_diluted", field: "epsDiluted" }],
  },
  {
    name: "balance-sheet-statement",
    table: "bulk_balance_sheets",
    schedule: "weekly",
    key: ["date", "period"],
    snapshot: false,
    calls: statementCalls("balance-sheet-statement-bulk"),
    cols: statementCols,
  },
  {
    name: "cash-flow-statement",
    table: "bulk_cash_flows",
    schedule: "weekly",
    key: ["date", "period"],
    snapshot: false,
    calls: statementCalls("cash-flow-statement-bulk"),
    cols: statementCols,
  },
  {
    // Not in the original list: the screen's EPS and revenue growth filters
    // need a prior fiscal year that the two statement years don't always hold.
    name: "income-statement-growth",
    table: "bulk_income_growth",
    schedule: "weekly",
    key: ["date", "period"],
    snapshot: false,
    calls: (now) => {
      const year = nyYear(now);
      return [year + 1, year, year - 1].map((y) => ({ path: "income-statement-growth-bulk", params: { year: y, period: "FY" } }));
    },
    cols: [...statementCols, { name: "growth_revenue", field: "growthRevenue" }, { name: "growth_eps", field: "growthEPS" }],
  },
];

for (const d of DATASETS) {
  const keyCols = ["symbol", ...d.key];
  db.exec(`CREATE TABLE IF NOT EXISTS ${d.table} (
  symbol TEXT NOT NULL,
  ${d.key.map((k) => `${k} TEXT NOT NULL,`).join("\n  ")}
  ${d.cols.filter((c) => !d.key.includes(c.name)).map((c) => `${c.name},`).join("\n  ")}
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (${keyCols.join(", ")})
)`);
}
db.exec(`
CREATE INDEX IF NOT EXISTS bulk_profiles_market_cap ON bulk_profiles (market_cap);
CREATE TABLE IF NOT EXISTS bulk_datasets (
  name TEXT PRIMARY KEY,
  row_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  error_at TEXT
);
`);

// ---- refresh ----

function sqlValue(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return typeof v === "number" || typeof v === "string" ? v : JSON.stringify(v);
}

/** Upsert one batch of FMP rows (already US-filtered) into the dataset's table. */
export function upsertRows(d: Dataset, rows: CsvRow[], at: string): number {
  const cols = ["symbol", ...d.key, ...d.cols.map((c) => c.name).filter((n) => !d.key.includes(n)), "data", "updated_at"];
  const keyCols = new Set(["symbol", ...d.key]);
  const stmt = db.prepare(
    `INSERT INTO ${d.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON CONFLICT (${[...keyCols].join(", ")}) DO UPDATE SET ${cols.filter((c) => !keyCols.has(c)).map((c) => `${c} = excluded.${c}`).join(", ")}`
  );
  const byName = new Map(d.cols.map((c) => [c.name, c]));
  let n = 0;
  db.transaction(() => {
    for (const row of rows) {
      const symbol = bulk.appSymbol(row.symbol);
      const keys = d.key.map((k) => sqlValue(row[byName.get(k)?.field as string] ?? row[k]));
      if (!symbol || keys.some((k) => k === null)) continue;
      const values = d.cols.filter((c) => !d.key.includes(c.name)).map((c) => sqlValue(typeof c.field === "function" ? c.field(row) : row[c.field]));
      stmt.run(symbol, ...keys, ...values, JSON.stringify({ ...row, symbol }), at);
      n++;
    }
  })();
  return n;
}

function usSymbols(): Set<string> {
  return new Set((db.prepare("SELECT symbol FROM bulk_profiles").all() as Array<{ symbol: string }>).map((r) => r.symbol));
}

export type RunResult = { dataset: string; rows: number; bytes: number; calls: number; durationMs: number; error?: string };

/** Download one dataset and upsert its US rows. Calls that fail are skipped; the run then counts as failed. */
export async function runDataset(d: Dataset, now = new Date()): Promise<RunResult> {
  const started = Date.now();
  const at = now.toISOString();
  // Other datasets follow profile-bulk's US listings; before the first
  // profile download, anything without a foreign suffix passes.
  const known = d.name === "profile" ? null : usSymbols();
  const keep = (row: CsvRow) =>
    d.name === "profile" ? bulk.isUsListing(row) : known!.size > 0 ? known!.has(bulk.appSymbol(row.symbol)) : !isForeignSymbol(bulk.appSymbol(row.symbol));

  let rows = 0;
  let bytes = 0;
  let calls = 0;
  let error: string | undefined;
  let pending: CsvRow[] = [];
  const flush = () => {
    rows += upsertRows(d, pending, at);
    pending = [];
  };
  const onRow = (row: CsvRow) => {
    if (!keep(row)) return;
    pending.push(row);
    if (pending.length >= BATCH) flush();
  };
  for (const call of d.calls(now)) {
    try {
      const got = call.paged ? await bulk.downloadParts(call.path, onRow) : await bulk.download(call.path, call.params, onRow);
      bytes += got.bytes;
      calls += got.calls;
    } catch (err) {
      calls++;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      flush();
    }
  }
  if (!error && d.snapshot && rows > 0) db.prepare(`DELETE FROM ${d.table} WHERE updated_at < ?`).run(at);

  const durationMs = Date.now() - started;
  if (error) {
    db.prepare(
      `INSERT INTO bulk_datasets (name, row_count, bytes, calls, duration_ms, updated_at, error, error_at) VALUES (?, 0, 0, 0, 0, '', ?, ?)
       ON CONFLICT (name) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`
    ).run(d.name, error, at);
  } else {
    db.prepare(
      `INSERT INTO bulk_datasets (name, row_count, bytes, calls, duration_ms, updated_at, error, error_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (name) DO UPDATE SET row_count = excluded.row_count, bytes = excluded.bytes, calls = excluded.calls,
         duration_ms = excluded.duration_ms, updated_at = excluded.updated_at, error = NULL, error_at = NULL`
    ).run(d.name, rows, bytes, calls, durationMs, at);
  }
  return { dataset: d.name, rows, bytes, calls, durationMs, ...(error ? { error } : {}) };
}

/** Whether a dataset needs a refresh: never loaded, loaded before the last 6 AM New York (weekly: 6 days before that), and not failed in the last hour. */
export function isDue(d: Dataset, now: Date, status = datasetRow(d.name)): boolean {
  if (status?.error_at && now.getTime() - Date.parse(status.error_at) < RETRY_AFTER_ERROR_MS) return false;
  if (!status?.updated_at) return true;
  const boundary = refreshBoundary(now).getTime() - (d.schedule === "weekly" ? 6 * DAY_MS : 0);
  return Date.parse(status.updated_at) < boundary;
}

type DatasetRow = { name: string; row_count: number; bytes: number; calls: number; duration_ms: number; updated_at: string; error: string | null; error_at: string | null };

function datasetRow(name: string): DatasetRow | undefined {
  return db.prepare("SELECT * FROM bulk_datasets WHERE name = ?").get(name) as DatasetRow | undefined;
}

/** Refresh every due dataset, profiles first (the others filter on them). */
export async function runDue(now = new Date()): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const d of DATASETS) {
    if (!isDue(d, now)) continue;
    const r = await runDataset(d, now);
    const mb = (r.bytes / 1e6).toFixed(1);
    if (r.error) console.error(`[bulk] ${r.dataset}: failed after ${r.rows} rows (${r.calls} calls, ${mb} MB, ${(r.durationMs / 1000).toFixed(1)} s): ${r.error}`);
    else console.log(`[bulk] ${r.dataset}: ${r.rows} rows (${r.calls} calls, ${mb} MB) in ${(r.durationMs / 1000).toFixed(1)} s`);
    out.push(r);
  }
  return out;
}

export function startBulkJobs(): void {
  if (!isConfigured()) {
    console.log("[bulk] FMP_API_KEY is not set; bulk datasets disabled.");
    return;
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDue();
    } catch (err) {
      console.error("[bulk] refresh failed:", err);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, CHECK_EVERY_MS).unref();
  void tick();
}

// ---- reads ----

export type DatasetStatus = {
  dataset: string;
  table: string;
  schedule: "daily" | "weekly";
  rows: number;
  lastRunRows: number | null;
  bytes: number | null;
  calls: number | null;
  durationMs: number | null;
  updatedAt: string | null;
  error: string | null;
  errorAt: string | null;
};

export function datasets(): DatasetStatus[] {
  return DATASETS.map((d) => {
    const s = datasetRow(d.name);
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${d.table}`).get() as { n: number };
    return {
      dataset: d.name,
      table: d.table,
      schedule: d.schedule,
      rows: n,
      lastRunRows: s?.updated_at ? s.row_count : null,
      bytes: s?.updated_at ? s.bytes : null,
      calls: s?.updated_at ? s.calls : null,
      durationMs: s?.updated_at ? s.duration_ms : null,
      updatedAt: s?.updated_at || null,
      error: s?.error ?? null,
      errorAt: s?.error_at ?? null,
    };
  });
}

export type BulkProfile = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  price: number | null;
  marketCap: number | null;
  sharesOutstanding: number | null;
  beta: number | null;
  avgVolume: number | null;
  week52Low: number | null;
  week52High: number | null;
  /** From ratios-ttm. */
  pe: number | null;
  eps: number | null;
  /** Fraction, e.g. 0.0024 for 0.24%. */
  dividendYield: number | null;
};

type ProfileJoin = {
  symbol: string;
  company_name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  price: number | null;
  market_cap: number | null;
  beta: number | null;
  average_volume: number | null;
  year_range: string | null;
  pe: number | null;
  eps: number | null;
  dividend_yield: number | null;
};

function yearRange(range: string | null): { week52Low: number | null; week52High: number | null } {
  const m = range?.match(/^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/);
  return { week52Low: m ? Number(m[1]) : null, week52High: m ? Number(m[2]) : null };
}

/** Profile and TTM ratio fields of the given symbols; symbols not in bulk_profiles are left out. */
export function profiles(symbols: string[]): Map<string, BulkProfile> {
  const out = new Map<string, BulkProfile>();
  if (symbols.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT p.symbol, p.company_name, p.exchange, p.sector, p.industry, p.price, p.market_cap, p.beta, p.average_volume, p.year_range,
              r.pe, r.eps, r.dividend_yield
       FROM bulk_profiles p LEFT JOIN bulk_ratios_ttm r ON r.symbol = p.symbol
       WHERE p.symbol IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify(symbols)) as ProfileJoin[];
  for (const r of rows) {
    out.set(r.symbol, {
      symbol: r.symbol,
      name: r.company_name,
      exchange: r.exchange,
      sector: r.sector,
      industry: r.industry,
      price: r.price,
      marketCap: r.market_cap,
      sharesOutstanding: r.market_cap && r.price ? Math.round(r.market_cap / r.price) : null,
      beta: r.beta,
      avgVolume: r.average_volume,
      ...yearRange(r.year_range),
      pe: r.pe,
      eps: r.eps,
      dividendYield: r.dividend_yield,
    });
  }
  return out;
}

/** Stocks only: no ETFs, funds or listings that stopped trading. */
const STOCKS = "p.is_etf = 0 AND p.is_fund = 0 AND p.is_actively_trading = 1";
/** The exchanges, not OTC. */
export const LISTED_EXCHANGES = ["NASDAQ", "NYSE", "AMEX", "CBOE"];

/** The `n` biggest exchange-listed US stocks by market cap, biggest first. */
export function topByMarketCap(n: number): string[] {
  const rows = db
    .prepare(
      `SELECT p.symbol FROM bulk_profiles p
       WHERE ${STOCKS} AND p.exchange IN (SELECT value FROM json_each(?)) AND p.market_cap > 0
       ORDER BY p.market_cap DESC LIMIT ?`
    )
    .all(JSON.stringify(LISTED_EXCHANGES), n) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

// ---- screen ----

/**
 * Screen fields: name -> SQL expression over the joined bulk tables. Names are
 * FMP's, except two: upsidePercent, the average price target over the price
 * in percent (last quarter's average, else last year's), and
 * growthFiscalYear, the fiscal year growthRevenue and growthEPS come from.
 */
const UPSIDE = `(CASE WHEN p.price > 0 THEN ROUND((COALESCE(CASE WHEN t.last_quarter_count > 0 THEN t.last_quarter_avg END, CASE WHEN t.last_year_count > 0 THEN t.last_year_avg END) / p.price - 1) * 100, 2) END)`;

export const SCREEN_FIELDS = {
  symbol: { sql: "p.symbol", numeric: false },
  companyName: { sql: "p.company_name", numeric: false },
  exchange: { sql: "p.exchange", numeric: false },
  sector: { sql: "p.sector", numeric: false },
  industry: { sql: "p.industry", numeric: false },
  country: { sql: "p.country", numeric: false },
  isAdr: { sql: "p.is_adr", numeric: false },
  price: { sql: "p.price", numeric: true },
  marketCap: { sql: "p.market_cap", numeric: true },
  beta: { sql: "p.beta", numeric: true },
  averageVolume: { sql: "p.average_volume", numeric: true },
  priceToEarningsRatioTTM: { sql: "r.pe", numeric: true },
  priceToEarningsGrowthRatioTTM: { sql: "r.peg", numeric: true },
  priceToBookRatioTTM: { sql: "r.price_to_book", numeric: true },
  priceToSalesRatioTTM: { sql: "r.price_to_sales", numeric: true },
  priceToFreeCashFlowRatioTTM: { sql: "r.price_to_fcf", numeric: true },
  netIncomePerShareTTM: { sql: "r.eps", numeric: true },
  dividendYieldTTM: { sql: "r.dividend_yield", numeric: true },
  dividendPayoutRatioTTM: { sql: "r.payout_ratio", numeric: true },
  grossProfitMarginTTM: { sql: "r.gross_margin", numeric: true },
  operatingProfitMarginTTM: { sql: "r.operating_margin", numeric: true },
  netProfitMarginTTM: { sql: "r.net_margin", numeric: true },
  debtToEquityRatioTTM: { sql: "r.debt_to_equity", numeric: true },
  currentRatioTTM: { sql: "r.current_ratio", numeric: true },
  enterpriseValueTTM: { sql: "k.enterprise_value", numeric: true },
  evToEBITDATTM: { sql: "k.ev_to_ebitda", numeric: true },
  evToSalesTTM: { sql: "k.ev_to_sales", numeric: true },
  netDebtToEBITDATTM: { sql: "k.net_debt_to_ebitda", numeric: true },
  returnOnEquityTTM: { sql: "k.roe", numeric: true },
  returnOnAssetsTTM: { sql: "k.roa", numeric: true },
  returnOnInvestedCapitalTTM: { sql: "k.roic", numeric: true },
  earningsYieldTTM: { sql: "k.earnings_yield", numeric: true },
  freeCashFlowYieldTTM: { sql: "k.fcf_yield", numeric: true },
  growthRevenue: { sql: "g.growth_revenue", numeric: true },
  growthEPS: { sql: "g.growth_eps", numeric: true },
  growthFiscalYear: { sql: "g.fiscal_year", numeric: false },
  rating: { sql: "rt.rating", numeric: false },
  overallScore: { sql: "rt.overall_score", numeric: true },
  lastQuarterAvgPriceTarget: { sql: "t.last_quarter_avg", numeric: true },
  lastYearAvgPriceTarget: { sql: "t.last_year_avg", numeric: true },
  upsidePercent: { sql: UPSIDE, numeric: true },
  consensus: { sql: "c.consensus", numeric: false },
  dcf: { sql: "d.dcf", numeric: true },
} as const;

export type ScreenField = keyof typeof SCREEN_FIELDS;
export const SCREEN_FIELD_NAMES = Object.keys(SCREEN_FIELDS) as ScreenField[];
export const SORTABLE_FIELDS = SCREEN_FIELD_NAMES.filter((f) => SCREEN_FIELDS[f].numeric);

/** Always returned. */
export const BASE_FIELDS: ScreenField[] = ["symbol", "companyName", "sector", "industry", "exchange", "price", "marketCap"];

export type ScreenQuery = {
  sector?: string;
  industry?: string;
  exchange?: string[];
  marketCapMin?: number;
  marketCapMax?: number;
  peMin?: number;
  peMax?: number;
  epsGrowthMin?: number;
  revenueGrowthMin?: number;
  dividendYieldMin?: number;
  betaMax?: number;
  ratingMin?: number;
  upsideMin?: number;
  sort: ScreenField;
  order: "asc" | "desc";
  limit: number;
  fields?: ScreenField[];
};

/** Numeric filters: query param -> [field, comparison]. */
const RANGE_FILTERS: Array<[keyof ScreenQuery, ScreenField, ">=" | "<="]> = [
  ["marketCapMin", "marketCap", ">="],
  ["marketCapMax", "marketCap", "<="],
  ["peMin", "priceToEarningsRatioTTM", ">="],
  ["peMax", "priceToEarningsRatioTTM", "<="],
  ["epsGrowthMin", "growthEPS", ">="],
  ["revenueGrowthMin", "growthRevenue", ">="],
  ["dividendYieldMin", "dividendYieldTTM", ">="],
  ["betaMax", "beta", "<="],
  ["ratingMin", "overallScore", ">="],
  ["upsideMin", "upsidePercent", ">="],
];

/**
 * The screen's SQL. Field names and the sort come only from SCREEN_FIELDS
 * (the route validates them too), and every value is a bound parameter.
 */
export function buildScreen(q: ScreenQuery): { sql: string; args: Array<string | number>; fields: ScreenField[] } {
  for (const f of [q.sort, ...(q.fields ?? [])]) if (!(f in SCREEN_FIELDS)) throw new Error(`unknown field ${f}`);
  if (!SCREEN_FIELDS[q.sort].numeric) throw new Error(`cannot sort by ${q.sort}`);

  const where = [STOCKS, "p.exchange IN (SELECT value FROM json_each(?))"];
  const args: Array<string | number> = [JSON.stringify(q.exchange?.length ? q.exchange : LISTED_EXCHANGES)];
  const used = new Set<ScreenField>();
  if (q.sector) {
    where.push("p.sector = ? COLLATE NOCASE");
    args.push(q.sector);
  }
  if (q.industry) {
    where.push("p.industry = ? COLLATE NOCASE");
    args.push(q.industry);
  }
  for (const [param, field, op] of RANGE_FILTERS) {
    const v = q[param];
    if (typeof v !== "number") continue;
    where.push(`${SCREEN_FIELDS[field].sql} ${op} ?`);
    args.push(v);
    used.add(field);
  }

  const fields = [...new Set<ScreenField>([...BASE_FIELDS, ...(q.fields ?? []), ...used, q.sort])];
  const sort = SCREEN_FIELDS[q.sort].sql;
  const sql = `SELECT ${fields.map((f) => `${SCREEN_FIELDS[f].sql} AS "${f}"`).join(", ")}
FROM bulk_profiles p
LEFT JOIN bulk_ratios_ttm r ON r.symbol = p.symbol
LEFT JOIN bulk_key_metrics_ttm k ON k.symbol = p.symbol
LEFT JOIN bulk_ratings rt ON rt.symbol = p.symbol
LEFT JOIN bulk_price_targets t ON t.symbol = p.symbol
LEFT JOIN bulk_grades_consensus c ON c.symbol = p.symbol
LEFT JOIN bulk_dcf d ON d.symbol = p.symbol
LEFT JOIN (
  SELECT symbol, fiscal_year, growth_revenue, growth_eps,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS n
  FROM bulk_income_growth WHERE period = 'FY'
) g ON g.symbol = p.symbol AND g.n = 1
WHERE ${where.join("\n  AND ")}
ORDER BY ${sort} IS NULL, ${sort} ${q.order === "asc" ? "ASC" : "DESC"}, p.symbol
LIMIT ?`;
  args.push(q.limit);
  return { sql, args, fields };
}

/** Run a screen; asOf is the oldest last update among the daily datasets it reads. */
export function screen(q: ScreenQuery): { asOf: string | null; rows: Array<Record<string, unknown>> } {
  const { sql, args } = buildScreen(q);
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  for (const row of rows) if ("isAdr" in row) row.isAdr = row.isAdr === null ? null : row.isAdr === 1;
  const daily = DATASETS.filter((d) => d.schedule === "daily" && d.name !== "earnings-surprises" && d.name !== "peers").map((d) => d.name);
  const { asOf } = db
    .prepare(`SELECT MIN(updated_at) AS asOf FROM bulk_datasets WHERE updated_at != '' AND name IN (SELECT value FROM json_each(?))`)
    .get(JSON.stringify(daily)) as { asOf: string | null };
  return { asOf, rows };
}
