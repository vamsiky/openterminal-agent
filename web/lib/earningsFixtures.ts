// Typed fixtures for the Earnings tab tests (and a mocked API for visual checks).
import type { Dist, EarningsEventRow, EarningsReview, EarningsSetup, EventStats } from "./earningsScreen";

const dist = (median: number, winRate: number, n: number): Dist => ({ n, median, mean: median, p25: median - 3, p75: median + 4, winRate });
const stats = (scope: EventStats["scope"], n: number): EventStats => ({
  scope, horizon: "intraday", time: "amc", n, nOptions: n - 2,
  stock: dist(0.8, 0.62, n), call: dist(12, 0.58, n - 2), otmCall: dist(18, 0.45, n - 2),
  callBeta: 9, callAlpha: 1, flatDayCall: -4,
  impliedVsRealized: { medianImplied: 7, medianRealized: 5.5, ratio: 0.79 },
  reactions: { upShare: 0.6, medianAbs: 5.2, last4: [4, -2, 6, 3] },
});

export function setup(symbol: string, over: Partial<EarningsSetup> = {}): EarningsSetup {
  return {
    symbol, name: `${symbol} Corp`, sector: "Technology", industry: "Software", marketCap: 12e9,
    upcoming: { reportDate: "2026-10-22", time: "amc", timeSource: "fmp", fmpConfirmed: true, t0: "2026-10-22", epsEstimate: 1.1, revenueEstimate: 500e6, fiscalPeriod: "Q3" },
    horizon: "intraday", asOf: "2026-10-21T14:00:00Z", score: 72, verdict: "candidate",
    components: [
      { key: "tradability", points: 20, max: 25, value: { spreadPct: 5 }, reason: "Spread 5.0% on the Nov 20 $50 call." },
      { key: "history", points: 18, max: 30, value: {}, reason: "Blended call median +12% over 14 reports." },
      { key: "setup", points: 12, max: 20, value: {}, reason: "Above SMA20 and SMA50." },
      { key: "demand", points: 9, max: 15, value: {}, reason: "Last 4 reactions: 3 up." },
      { key: "carry", points: 6, max: 10, value: {}, reason: "Break-even move 1.1% vs half ATR 1.9%." },
    ],
    gates: [
      { key: "spread", passed: true, reason: "Spread 5.0% is under 15%." },
      { key: "volume", passed: true, reason: "Volume 320 is at least 50." },
    ],
    contract: { occ: "AAA261120C00050000", expiry: "2026-11-20", strike: 50, bid: 1.9, ask: 2.0, mid: 1.95, spreadPct: 5.1, iv: 0.62, delta: 0.52, volume: 320, openInterest: 900, leverage: 8, breakevenStockMovePct: 1.1 },
    live: { price: 49.8, impliedMovePct: 7.2, eventPremium: 0.8, ivVsTypicalAtAnchor: 0.95 },
    history: { own: stats({ symbol, sector: null, capBucket: null }, 14), pooled: stats({ symbol: null, sector: "Technology", capBucket: "large" }, 220), blended: { callMedian: 11.4, stockWinRate: 0.61, k: 5 } },
    lastReport: { date: "2026-07-22", epsActual: 1.2, epsEstimate: 1.0, revenueActual: 510e6, revenueEstimate: 490e6, reactionPct: 6.5 },
    revisions: { eps30d: 2.1, eps90d: 4.0, revenue30d: 1.0 },
    analyst: [{ date: "2026-10-10", firm: "Acme Securities", action: "upgrade", priceTarget: 60 }],
    weightsVersion: "earn-v1",
    ...over,
  };
}

export const FIXTURE_ROWS: EarningsSetup[] = [
  setup("AAA", { score: 72 }),
  setup("BBB", { score: 58, verdict: "conditional", sector: "Healthcare", marketCap: 3e9, upcoming: { ...setup("BBB").upcoming, time: "bmo" }, lastReport: { date: "2026-07-20", epsActual: 0.4, epsEstimate: 0.5, revenueActual: null, revenueEstimate: null, reactionPct: -3.2 } }),
  setup("CCC", {
    score: 80, verdict: "pass", marketCap: 40e9, contract: null, live: { price: 20, impliedMovePct: null, eventPremium: null, ivVsTypicalAtAnchor: null }, lastReport: null,
    gates: [{ key: "no_options", passed: false, reason: "No listed options." }],
  }),
  setup("DDD", { score: 40, verdict: "pass", upcoming: { ...setup("DDD").upcoming, time: null }, gates: [{ key: "unconfirmed_time", passed: false, reason: "Report time unconfirmed." }] }),
];

export const FIXTURE_EVENTS: EarningsEventRow[] = [
  { symbol: "AAA", reportDate: "2026-07-22", time: "amc", t0: "2026-07-22", r: "2026-07-23", epsActual: 1.2, epsEstimate: 1.0, confirmed: true, stock: { prevClose: 100, "T0:close": 100, "R:close": 106.5 } },
  { symbol: "AAA", reportDate: "2026-04-22", time: "amc", t0: "2026-04-22", r: "2026-04-23", epsActual: 0.9, epsEstimate: 1.0, confirmed: true, stock: { prevClose: 90, "T0:close": 90, "R:close": 87 } },
];

export function review(symbol: string, over: Partial<EarningsReview> = {}): EarningsReview {
  return {
    id: 7, symbol, horizon: "intraday", reportDate: "2026-10-22", asOf: "2026-10-21T15:00:00Z", status: "ok", statusReason: null,
    baseScore: 72, adjustedScore: 66, adjustment: -6, verdict: "wait",
    newsFactors: [{ factor: "Peer guided down", direction: "-", evidence: [{ claim: "Peer cut guidance", source: "Reuters", asOf: "2026-10-21" }] }],
    entryConditions: ["Opens above prior close"], exitPlan: "Sell by 15:45 ET", risks: ["Gap down"], summary: "Mixed tape.", costUsd: 0.09, model: "sonnet",
    ...over,
  };
}
