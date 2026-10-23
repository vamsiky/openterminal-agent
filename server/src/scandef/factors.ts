// The stock factors the nightly and intraday passes compute. This is the built-in baseline:
// stock definitions switch them on and off and change their direction and ranking.

export type FactorBase = {
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

export const STOCK_GROUPS = ["valuation", "quality", "growth", "earnings", "analysts", "momentum"] as const;
export type StockGroup = (typeof STOCK_GROUPS)[number];

export const GROUP_LABELS: Record<string, string> = {
  valuation: "valuation",
  quality: "quality",
  growth: "growth",
  earnings: "earnings",
  analysts: "analyst view",
  momentum: "momentum",
};

export const BUILTIN_FACTORS: FactorBase[] = [
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
  { key: "rs_spy", group: "momentum", label: "6-month excess return over SPY", market: true },
  { key: "rs_sector", group: "momentum", label: "3-month excess return over its sector ETF", market: true },
];

/** Added to the momentum group by the 15-minute pass only; scored with fixed maps, not percentiles. */
export const BUILTIN_LIVE_FACTORS: FactorBase[] = [
  { key: "price_vs_vwap", group: "momentum", label: "price vs VWAP" },
  { key: "rsi_15m", group: "momentum", label: "15-minute RSI" },
  { key: "rel_volume", group: "momentum", label: "relative volume" },
];
