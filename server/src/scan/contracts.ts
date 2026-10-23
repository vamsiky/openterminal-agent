// Types shared by the quant engine (scoring, ideas) and the options data layer.

export type UniverseMode = "watchlists" | "sector" | "market";
export type UniverseSettings = {
  mode: UniverseMode;
  watchlistIds: number[] | null; // watchlists mode; null = every watchlist
  sectors: string[];             // sector mode: FMP sector names, e.g. "Technology"
  industries: string[];          // optional narrowing in sector mode; [] = all
  minPrice: number;              // sector/market filters; default 5
  minAvgDollarVolume: number;    // default 20_000_000 (price * average_volume from bulk_profiles)
  requireOptions: boolean;       // default true in market mode
};

export type StockPosition = { kind: "stock"; symbol: string; quantity: number; cost: number | null; openedAt: string | null };
export type OptionPosition = {
  kind: "option"; occ: string; underlying: string; expiry: string; strike: number; right: "call" | "put";
  quantity: number; // contracts; negative = short
  cost: number | null; // premium per share, as brokers show it
  openedAt: string | null;
};
export type Position = StockPosition | OptionPosition;

/** Per-underlying options data from the 5-minute sweep plus the stream. Written by options/, read by quant/. */
export type OptionMetrics = {
  underlying: string;
  asOf: string;                  // ISO
  price: number | null;          // underlying price used
  atmExpiry: string | null;      // expiry of the streamed ATM pair
  atmCall: string | null;        // OCC symbols of the streamed pair
  atmPut: string | null;
  atmIv: number | null;          // annualised, 0.35 = 35%
  iv30: number | null;           // 30-day constant-maturity ATM IV (interpolated)
  ivRank: number | null;         // 0–100 over up to 252 trading days of iv30; null if < 20 days of history
  ivPercentile: number | null;   // 0–100, same window
  ivHistoryDays: number;
  hv20: number | null;           // 20-day close-to-close realised vol, annualised
  impliedMovePct: number | null; // ATM straddle mid / price * 100, for atmExpiry
  termSlope: number | null;      // iv(~60d) - iv(front), vol points
  putCallVolumeRatio: number | null;
  unusual: Array<{ occ: string; volume: number; openInterest: number | null; ratio: number | null }>; // volume >= 2x OI and >= 500
  atmCallQuote: { bid: number | null; ask: number | null; delta: number | null } | null;
  atmPutQuote: { bid: number | null; ask: number | null; delta: number | null } | null;
};

export type FactorScore = { key: string; group: string; value: number | null; score: number | null; change: number | null };
export type Scorecard = {
  symbol: string; asOf: string; sector: string | null; industry: string | null;
  composite: number | null;              // 0–100
  groups: Record<string, number | null>; // group -> 0–100
  factors: FactorScore[];
  coverage: number;                      // share of factors with data, 0–1
  weightsVersion: string;
};

export type OptionStrategy = "long_call" | "short_put" | "covered_call";
export type OptionSetup = { strategy: OptionStrategy; score: number; contract: string | null; reasons: string[] };
export type OptionScorecard = {
  underlying: string; asOf: string; score: number | null;
  momentum: { m5: number | null; m15: number | null; h1: number | null; d1: number | null }; // -100..100 trend scores
  metrics: OptionMetrics | null;
  earningsBeforeExpiry: boolean | null; nextEarnings: string | null;
  setups: OptionSetup[];
  /** Version of the option definition that produced the setups (absent on cards stored before Scan Lab). */
  definition?: string;
};

export type IdeaKind = "stock" | "option";
export type Idea = {
  id: number; kind: IdeaKind; symbol: string;
  strategy: "buy" | OptionStrategy;
  contract: string | null;
  score: number; rank: number; reasons: string[];
  firstSeen: string; lastSeen: string; status: "active" | "dropped" | "near";
  /** Option ideas: version of the option definition that produced the idea. */
  definition?: string | null;
};

/** Injected by index.ts so quant/ and options/ never import each other. */
export type QuantDeps = { optionMetrics: (symbols: string[]) => Map<string, OptionMetrics>; optionsStatus: () => unknown };
export type OptionsDeps = { underlyings: () => string[]; optionHoldings: () => OptionPosition[]; stockHoldings: () => StockPosition[] };
