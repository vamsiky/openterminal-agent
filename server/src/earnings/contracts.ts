// Types shared by the earnings store (server), its routes, MCP tools, the earnings agent and the web tab.

export type ReportTime = "bmo" | "amc" | "dmh";
export type Horizon = "intraday" | "week" | "month";
export type Anchor =
  | "T0-20" | "T0-10" | "T0-5" | "T0-2" | "T0-1"
  | "T0:open" | "T0:10:00" | "T0:15:45" | "T0:close"
  | "R:open" | "R:close" | "R+5" | "R+20";
export type ExpiryKind = "event" | "swing";
export type Leg = "atm_call" | "otm_call" | "atm_put";

export type EarningsEvent = {
  symbol: string; reportDate: string;               // YYYY-MM-DD (corrected date when date_shifted)
  time: ReportTime | null; timeSource: "fmp" | "press_release" | null;
  t0: string | null; r: string | null;              // session dates
  fiscalPeriod: string | null; fiscalYear: number | null; periodEnding: string | null;
  epsActual: number | null; epsEstimate: number | null; revenueActual: number | null; revenueEstimate: number | null;
  confirmed: boolean; checks: { fmp: boolean; transcript: boolean; pressRelease: boolean; volume: boolean };
  reason: "ok" | "unconfirmed" | "date_shifted" | "no_bars" | null;
  fmpConfirmedFlag: boolean | null;                 // FMP's own `confirmed` (meaningful for upcoming dates)
};

export type StockPath = Partial<Record<Anchor, number | null>> & { prevClose: number | null; rVolumeRatio: number | null; atr14Pct: number | null };

export type OptionLegPath = {
  entry: Anchor; expiryKind: ExpiryKind; leg: Leg;
  contract: string; expiry: string; strike: number;
  spotAtEntry: number;
  prices: Partial<Record<Anchor, number | null>>;   // the contract's price at entry and every later anchor through R:close
  ivAtEntry: number | null;                         // from the price with the repo's black-scholes IV solver
  priceSource: "trade" | "quote";                   // historical bars = last trades; live snapshots = quote mids
  volumeAtEntryDay: number | null;
};

export type EventStats = {
  scope: { symbol: string | null; sector: string | null; capBucket: CapBucket | null };
  horizon: Horizon; time: ReportTime | "any";
  n: number; nOptions: number;
  stock: Dist; call: Dist | null; otmCall: Dist | null; // % returns entry→exit; call legs use expiryKind "event"
  callBeta: number | null; callAlpha: number | null;    // OLS: call% = alpha + beta·stock%
  flatDayCall: number | null;                           // median call% when |stock%| < 0.6
  preDrift: { t0OpenFrom10: Dist; rCloseFromPrev: Dist }; // first-30-min and full-day patterns
  impliedVsRealized: { medianImplied: number | null; medianRealized: number | null; ratio: number | null };
  ivRamp: Partial<Record<Anchor, number | null>>;      // median ATM event-expiry IV at each anchor ÷ IV at T0:close
  reactions: { upShare: number | null; medianAbs: number | null; last4: number[] };
};
export type Dist = { n: number; median: number | null; mean: number | null; p25: number | null; p75: number | null; winRate: number | null };
export type CapBucket = "micro" | "small" | "mid" | "large" | "mega"; // <300M, <2B, <10B, <200B, ≥200B

export type ScoreComponent = {
  key: "tradability" | "history" | "setup" | "demand" | "carry";
  points: number; max: number;
  value: Record<string, number | string | boolean | null>; // the inputs used
  reason: string;                                          // one plain-English sentence with the numbers
};
/** Where the report time came from: the upcoming row's own FMP time, the majority of the name's past FMP times, or press-release inference. */
export type TimeBasis = "upcoming" | "history" | "press_release";

export type Gate = { key: "spread" | "volume" | "no_options" | "unconfirmed_time" | "no_quote"; passed: boolean; reason: string };

export type EarningsSetup = {
  symbol: string; name: string | null; sector: string | null; industry: string | null; marketCap: number | null;
  upcoming: { reportDate: string; time: ReportTime | null; timeSource: "fmp" | "press_release" | null; timeBasis?: TimeBasis | null; fmpConfirmed: boolean | null;
              t0: string; epsEstimate: number | null; revenueEstimate: number | null; fiscalPeriod: string | null };
  horizon: Horizon; asOf: string;
  score: number; verdict: "candidate" | "conditional" | "pass"; // ≥70 candidate, 55–69 conditional, else or any failed gate → pass
  components: ScoreComponent[]; gates: Gate[];
  contract: { occ: string; expiry: string; strike: number; bid: number | null; ask: number | null; mid: number | null; spreadPct: number | null;
              iv: number | null; delta: number | null; volume: number | null; openInterest: number | null; leverage: number | null;
              breakevenStockMovePct: number | null } | null;
  live: { price: number | null; impliedMovePct: number | null; eventPremium: number | null; ivVsTypicalAtAnchor: number | null };
  history: { own: EventStats | null; pooled: EventStats | null; blended: { callMedian: number | null; stockWinRate: number | null; k: number } };
  lastReport: { date: string; epsActual: number | null; epsEstimate: number | null; revenueActual: number | null; revenueEstimate: number | null; reactionPct: number | null } | null;
  revisions: { eps30d: number | null; eps90d: number | null; revenue30d: number | null };   // % change of the consensus for this report
  analyst: Array<{ date: string; firm: string | null; action: string; priceTarget: number | null }>; // last 30 days
  weightsVersion: string;
};

export type EarningsReview = {
  id: number; symbol: string; horizon: Horizon; reportDate: string; asOf: string;
  status: "ok" | "error"; statusReason: string | null;
  baseScore: number; adjustedScore: number | null; adjustment: number | null; // |adjustment| ≤ 15, set by the agent with reasons
  verdict: "act" | "wait" | "pass" | null;
  newsFactors: Array<{ factor: string; direction: "+" | "-"; evidence: { claim: string; source: string; asOf: string | null }[] }>;
  entryConditions: string[]; exitPlan: string | null; risks: string[]; summary: string | null;
  costUsd: number; model: string | null;
};

export type EarningsStatus = {
  backfill: { phase: "idle" | "events" | "stock" | "options" | "done"; phases: Record<"events" | "stock" | "options", { done: number; total: number; finishedAt: string | null }>; symbolsDone: number; symbolsTotal: number; eventsStored: number; eventsConfirmed: number; optionEvents: number; startedAt: string | null; updatedAt: string | null; errors: number };
  nightly: { lastRun: string | null; newEvents: number };
  snapshots: { lastRun: string | null; namesTracked: number; rowsToday: number };
  db: { sizeBytes: number };
};
