import { BUILTIN_FACTORS, BUILTIN_LIVE_FACTORS, GROUP_LABELS, STOCK_GROUPS } from "./factors.js";

// The data catalog: every field a definition may reference, per scope. It is the only way data
// enters the DSL, so adding a field is a code change (the engine must also supply it per symbol).

export type Scope = "stock" | "option";
export type Unit = "score_0_100" | "score_pm100" | "pct" | "ratio" | "x" | "usd" | "days" | "date" | "bool" | "count" | "text";
export type CatalogField = {
  key: string;
  scope: Scope;
  label: string;
  unit: Unit;
  description: string;
  source: string;
  group: string;
};

/** Units whose values can enter arithmetic and comparisons; dates and text only appear in sentences. */
export const NUMERIC_UNITS: ReadonlySet<Unit> = new Set(["score_0_100", "score_pm100", "pct", "ratio", "x", "usd", "days", "bool", "count"]);

type FactorMeta = { unit: Unit; description: string; source: string };
const FMP_RATIOS = "FMP ratios, nightly";
const FMP_METRICS = "FMP key metrics, nightly";
const DAILY = "Daily bars, nightly and every 15 min";
const FACTOR_META: Record<string, FactorMeta> = {
  pe: { unit: "x", description: "Price-to-earnings ratio (trailing twelve months).", source: FMP_RATIOS },
  ev_to_ebitda: { unit: "x", description: "Enterprise value divided by EBITDA.", source: FMP_METRICS },
  price_to_sales: { unit: "x", description: "Price-to-sales ratio (trailing twelve months).", source: FMP_RATIOS },
  fcf_yield: { unit: "pct", description: "Free cash flow yield, as a fraction (0.05 = 5%).", source: FMP_METRICS },
  dcf_gap: { unit: "pct", description: "How far the price sits below FMP's DCF value, as a fraction (0.2 = 20% below).", source: "FMP DCF, nightly" },
  roic: { unit: "pct", description: "Return on invested capital, as a fraction.", source: FMP_METRICS },
  roe: { unit: "pct", description: "Return on equity, as a fraction.", source: FMP_METRICS },
  gross_margin: { unit: "pct", description: "Gross margin, as a fraction.", source: FMP_RATIOS },
  operating_margin: { unit: "pct", description: "Operating margin, as a fraction.", source: FMP_RATIOS },
  net_debt_to_ebitda: { unit: "x", description: "Net debt divided by EBITDA.", source: FMP_METRICS },
  current_ratio: { unit: "ratio", description: "Current assets divided by current liabilities.", source: FMP_RATIOS },
  growth_revenue: { unit: "pct", description: "Revenue growth over the last fiscal year, as a fraction.", source: "FMP income growth, nightly" },
  growth_eps: { unit: "pct", description: "EPS growth over the last fiscal year, as a fraction.", source: "FMP income growth, nightly" },
  surprise_pct: { unit: "pct", description: "Last earnings surprise against the estimate, in percent (5 = 5% beat); only if reported within 200 days.", source: "FMP earnings surprises, nightly" },
  eps_rev_30d: { unit: "pct", description: "Change in the next-report EPS estimate over 30 days, in percent.", source: "Stored estimate snapshots, nightly" },
  eps_rev_90d: { unit: "pct", description: "Change in the next-report EPS estimate over 90 days, in percent.", source: "Stored estimate snapshots, nightly" },
  buy_share: { unit: "pct", description: "Share of analyst ratings that are buy or strong buy, as a fraction.", source: "FMP grades consensus, nightly" },
  pt_upside: { unit: "pct", description: "Average analyst price target above the price, as a fraction.", source: "FMP price targets, nightly" },
  rating_score: { unit: "count", description: "FMP's overall rating score (1 to 5).", source: "FMP ratings, nightly" },
  ret_12_1: { unit: "pct", description: "Return from 12 months ago to one month ago, as a fraction.", source: DAILY },
  ret_6m: { unit: "pct", description: "Return over the last 6 months (126 trading days), as a fraction.", source: DAILY },
  vs_sma50: { unit: "pct", description: "Price above its 50-day average, as a fraction.", source: DAILY },
  vs_sma200: { unit: "pct", description: "Price above its 200-day average, as a fraction.", source: DAILY },
  rsi14: { unit: "ratio", description: "14-day RSI (0 to 100).", source: DAILY },
  rs_spy: { unit: "pct", description: "6-month return minus SPY's, as a fraction.", source: DAILY },
  rs_sector: { unit: "pct", description: "3-month return minus its sector ETF's, as a fraction.", source: DAILY },
  price_vs_vwap: { unit: "pct", description: "Price above today's VWAP, in percent (1 = 1% above).", source: "Minute bars, every 15 min in the session" },
  rsi_15m: { unit: "ratio", description: "RSI(14) of the 15-minute bars (0 to 100).", source: "Minute bars, every 15 min in the session" },
  rel_volume: { unit: "x", description: "Volume so far today against the normal volume for this time of day.", source: "Minute and daily bars, every 15 min in the session" },
};

const stock = (key: string, label: string, unit: Unit, description: string, source: string, group: string): CatalogField => ({ key, scope: "stock", label, unit, description, source, group });
const option = (key: string, label: string, unit: Unit, description: string, source: string, group: string): CatalogField => ({ key, scope: "option", label, unit, description, source, group });

const STOCK_FIELDS: CatalogField[] = [];
for (const f of [...BUILTIN_FACTORS, ...BUILTIN_LIVE_FACTORS]) {
  const meta = FACTOR_META[f.key];
  const group = GROUP_LABELS[f.group];
  const live = BUILTIN_LIVE_FACTORS.includes(f);
  STOCK_FIELDS.push(stock(f.key, f.label, meta.unit, meta.description, meta.source, group));
  STOCK_FIELDS.push(
    stock(
      `${f.key}_score`,
      `${f.label} (score)`,
      "score_0_100",
      live ? `0 to 100 score of ${f.label} on a fixed map (higher is better).` : `Percentile 0 to 100 of ${f.label} against ${f.market ? "the whole market" : "sector peers"} (higher is better).`,
      meta.source,
      group
    )
  );
}
for (const g of STOCK_GROUPS) {
  STOCK_FIELDS.push(stock(`${g}_score`, `${GROUP_LABELS[g]} score`, "score_0_100", `Mean of the ${GROUP_LABELS[g]} factor scores, 0 to 100.`, "Stock scorecard, nightly and every 15 min", "Scores"));
}
STOCK_FIELDS.push(
  stock("composite", "Stock score", "score_0_100", "Weighted mean of the group scores, 0 to 100.", "Stock scorecard, nightly and every 15 min", "Scores"),
  stock("coverage", "Data coverage", "pct", "Share of the included factors that have data, as a fraction (0.6 = 60%).", "Stock scorecard, nightly and every 15 min", "Scores"),
  stock("price", "Price", "usd", "Last price.", "FMP profile, nightly", "Basics"),
  stock("sector", "Sector", "text", "FMP sector name.", "FMP profile, nightly", "Basics"),
  stock("next_earnings_days", "Days to next earnings", "days", "Calendar days until the next report; empty when none is known.", "Earnings calendar", "Basics")
);

const NOW5 = "Alpaca option snapshots, every 5 min";
const MOM = "Minute, hourly and daily bars, every 5 min";
const STK = "Stock scorecard";
const OPTION_FIELDS: CatalogField[] = [
  option("m5", "5-minute momentum", "score_pm100", "Trend score of the 5-minute chart: -100 (down) to 100 (up).", MOM, "Momentum"),
  option("m15", "15-minute momentum", "score_pm100", "Trend score of the 15-minute chart: -100 (down) to 100 (up).", MOM, "Momentum"),
  option("h1", "Hourly momentum", "score_pm100", "Trend score of the hourly chart: -100 (down) to 100 (up).", MOM, "Momentum"),
  option("d1", "Daily trend", "score_pm100", "Trend score of the daily chart: -100 (down) to 100 (up).", MOM, "Momentum"),
  option("price", "Stock price", "usd", "Price of the underlying stock.", NOW5, "Underlying"),
  option("atm_iv", "At-the-money IV", "pct", "Implied volatility of the at-the-money contract, as a fraction (0.35 = 35%).", NOW5, "Volatility"),
  option("iv30", "30-day IV", "pct", "Constant-maturity 30-day at-the-money IV, as a fraction.", NOW5, "Volatility"),
  option("iv_rank", "IV rank", "score_0_100", "Where 30-day IV sits between its 1-year low and high, 0 to 100; empty until 20 days of history.", "IV history, every 5 min", "Volatility"),
  option("iv_percentile", "IV percentile", "score_0_100", "Share of the past year with lower 30-day IV, 0 to 100; empty until 20 days of history.", "IV history, every 5 min", "Volatility"),
  option("iv_history_days", "IV history", "days", "Days of 30-day IV history stored for this stock.", "IV history, every 5 min", "Volatility"),
  option("hv20", "20-day realised volatility", "pct", "Annualised close-to-close volatility over 20 days, as a fraction.", "Daily bars", "Volatility"),
  option("implied_move_pct", "Implied move", "pct", "At-the-money straddle price as a percent of the stock price, for the contract's expiry (5 = 5%).", NOW5, "Volatility"),
  option("term_slope", "Term slope", "ratio", "IV about 60 days out minus front IV, in volatility points.", NOW5, "Volatility"),
  option("put_call_volume_ratio", "Put/call volume ratio", "ratio", "Put volume divided by call volume across the chain.", NOW5, "Volume"),
  option("unusual_count", "Unusual contracts", "count", "Contracts trading at 2x open interest or more, with at least 500 contracts.", NOW5, "Volume"),
  option("atm_call_bid", "ATM call bid", "usd", "Bid of the at-the-money call.", NOW5, "Quotes"),
  option("atm_call_ask", "ATM call ask", "usd", "Ask of the at-the-money call.", NOW5, "Quotes"),
  option("atm_call_delta", "ATM call delta", "ratio", "Delta of the at-the-money call.", NOW5, "Quotes"),
  option("atm_call_spread_pct", "ATM call spread", "pct", "Call bid-ask spread as a percent of its mid (derived).", NOW5, "Quotes"),
  option("atm_put_bid", "ATM put bid", "usd", "Bid of the at-the-money put.", NOW5, "Quotes"),
  option("atm_put_ask", "ATM put ask", "usd", "Ask of the at-the-money put.", NOW5, "Quotes"),
  option("atm_put_delta", "ATM put delta", "ratio", "Delta of the at-the-money put.", NOW5, "Quotes"),
  option("atm_put_spread_pct", "ATM put spread", "pct", "Put bid-ask spread as a percent of its mid (derived).", NOW5, "Quotes"),
  option("rel_volume", "Relative volume", "x", "Volume so far today against the normal volume for this time of day.", "Minute and daily bars, every 15 min", "Volume"),
  option("vwap_atr_distance", "Distance above VWAP", "x", "Price minus today's VWAP, in 15-minute ATRs.", MOM, "Stretch"),
  option("rsi_15m", "15-minute RSI", "ratio", "RSI(14) of the 15-minute bars (0 to 100).", MOM, "Stretch"),
  option("day_move_pct", "Today's move", "pct", "Change from the previous close, in percent (3 = up 3%).", MOM, "Stretch"),
  option("usual_day_move_pct", "Usual daily move", "pct", "Normal daily move in percent: 20-day volatility over sqrt(252), else the daily ATR.", MOM, "Stretch"),
  option("day_move_vs_usual", "Today's move vs usual", "x", "Today's move divided by the usual daily move (1.5 = 1.5x its usual size).", MOM, "Stretch"),
  option("earnings_before_expiry", "Earnings before expiry", "bool", "True when the next report falls from today up to the contract's expiry; empty when unknown.", "Earnings calendar", "Events"),
  option("ex_dividend_before_expiry", "Ex-dividend before expiry", "bool", "True when an ex-dividend date falls from today up to the contract's expiry.", "FMP dividends, nightly", "Events"),
  option("next_earnings", "Next earnings date", "date", "Date of the next report.", "Earnings calendar", "Events"),
  option("next_ex_dividend", "Next ex-dividend date", "date", "Date of the next ex-dividend.", "FMP dividends, nightly", "Events"),
  option("atm_expiry", "Contract expiry", "date", "Expiry of the at-the-money pair the scan judges.", NOW5, "Contract"),
  option("days_to_expiry", "Days to expiry", "days", "Calendar days from today to the contract's expiry.", NOW5, "Contract"),
  option("stock_composite", "Stock score", "score_0_100", "The underlying's stock score, 0 to 100.", STK, "Stock score"),
  ...STOCK_GROUPS.map((g) => option(`${g}_score`, `Stock ${GROUP_LABELS[g]} score`, "score_0_100", `The underlying's ${GROUP_LABELS[g]} group score, 0 to 100.`, STK, "Stock score")),
  option("shares_held", "Shares held", "count", "Shares of the underlying in your positions.", "Positions", "Position"),
  option("contracts_covered", "Contracts covered", "count", "Whole 100-share lots held, so the number of covered calls you could write.", "Positions", "Position"),
  option("put_cash_required", "Cash to secure a put", "usd", "Cash needed to be assigned 100 shares at about the current price (derived).", NOW5, "Position"),
];

export const CATALOG: CatalogField[] = [...STOCK_FIELDS, ...OPTION_FIELDS];

const BY_SCOPE: Record<Scope, Map<string, CatalogField>> = {
  stock: new Map(STOCK_FIELDS.map((f) => [f.key, f])),
  option: new Map(OPTION_FIELDS.map((f) => [f.key, f])),
};

/** The fields of one scope, or every field. */
export function catalog(scope?: Scope): CatalogField[] {
  return scope ? CATALOG.filter((f) => f.scope === scope) : CATALOG;
}

export function catalogField(scope: Scope, key: string): CatalogField | undefined {
  return BY_SCOPE[scope].get(key);
}
