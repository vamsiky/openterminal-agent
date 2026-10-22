// Earnings tab client: types copied from server/src/earnings/contracts.ts (the web app does not import server code),
// the filter model, query-string mapping, sorting and the typed calls to /api/earnings.
import { apiGet, apiPost } from "./api";

export type ReportTime = "bmo" | "amc" | "dmh";
export type Horizon = "intraday" | "week" | "month";
export type CapBucket = "micro" | "small" | "mid" | "large" | "mega";
export type Dist = { n: number; median: number | null; mean: number | null; p25: number | null; p75: number | null; winRate: number | null };
export type EventStats = {
  scope: { symbol: string | null; sector: string | null; capBucket: CapBucket | null };
  horizon: Horizon; time: ReportTime | "any";
  n: number; nOptions: number;
  stock: Dist; call: Dist | null; otmCall: Dist | null;
  callBeta: number | null; callAlpha: number | null;
  flatDayCall: number | null;
  impliedVsRealized: { medianImplied: number | null; medianRealized: number | null; ratio: number | null };
  reactions: { upShare: number | null; medianAbs: number | null; last4: number[] };
};
export type ScoreComponent = {
  key: "tradability" | "history" | "setup" | "demand" | "carry";
  points: number; max: number;
  value: Record<string, number | string | boolean | null>;
  reason: string;
};
export type Gate = { key: "spread" | "volume" | "no_options" | "unconfirmed_time" | "no_quote"; passed: boolean; reason: string };
export type Verdict = "candidate" | "conditional" | "pass";

export type EarningsSetup = {
  symbol: string; name: string | null; sector: string | null; industry: string | null; marketCap: number | null;
  upcoming: { reportDate: string; time: ReportTime | null; timeSource: "fmp" | "press_release" | null; fmpConfirmed: boolean | null;
              t0: string; epsEstimate: number | null; revenueEstimate: number | null; fiscalPeriod: string | null };
  horizon: Horizon; asOf: string;
  score: number; verdict: Verdict;
  components: ScoreComponent[]; gates: Gate[];
  contract: { occ: string; expiry: string; strike: number; bid: number | null; ask: number | null; mid: number | null; spreadPct: number | null;
              iv: number | null; delta: number | null; volume: number | null; openInterest: number | null; leverage: number | null;
              breakevenStockMovePct: number | null } | null;
  live: { price: number | null; impliedMovePct: number | null; eventPremium: number | null; ivVsTypicalAtAnchor: number | null };
  history: { own: EventStats | null; pooled: EventStats | null; blended: { callMedian: number | null; stockWinRate: number | null; k: number } };
  lastReport: { date: string; epsActual: number | null; epsEstimate: number | null; revenueActual: number | null; revenueEstimate: number | null; reactionPct: number | null } | null;
  revisions: { eps30d: number | null; eps90d: number | null; revenue30d: number | null };
  analyst: Array<{ date: string; firm: string | null; action: string; priceTarget: number | null }>;
  weightsVersion: string;
};

export type EarningsEventRow = {
  symbol: string; reportDate: string; time: ReportTime | null; t0: string | null; r: string | null;
  epsActual: number | null; epsEstimate: number | null; confirmed: boolean;
  stock: Partial<Record<string, number | null>> & { prevClose: number | null };
};

export type EarningsReview = {
  id: number; symbol: string; horizon: Horizon; reportDate: string; asOf: string;
  status: "ok" | "error"; statusReason: string | null;
  baseScore: number; adjustedScore: number | null; adjustment: number | null;
  verdict: "act" | "wait" | "pass" | null;
  newsFactors: Array<{ factor: string; direction: "+" | "-"; evidence: { claim: string; source: string; asOf: string | null }[] }>;
  entryConditions: string[]; exitPlan: string | null; risks: string[]; summary: string | null;
  costUsd: number; model: string | null;
};
export type ReviewQueued = { queued: number; skipped: number; estimatedCostUsd: number };

// ---- filters ----
export type HorizonChoice = "day" | "week" | "month";
export const HORIZON_CHOICES: Array<[HorizonChoice, string, Horizon]> = [
  ["day", "Report day", "intraday"],
  ["week", "Week ahead", "week"],
  ["month", "Month ahead", "month"],
];
export const horizonOf = (c: HorizonChoice): Horizon => HORIZON_CHOICES.find(([k]) => k === c)![2];
export const SESSIONS_AHEAD: Record<HorizonChoice, number> = { day: 1, week: 5, month: 20 };

export type TimeFilter = "any" | ReportTime;
export const TIME_LABEL: Record<ReportTime, string> = { bmo: "Before open", amc: "After close", dmh: "During market" };

export type EarningsFilters = {
  from: string; to: string; customRange: boolean;
  horizon: HorizonChoice; time: TimeFilter; sector: string;
  minCapB: string; maxCapB: string; minScore: string;
  verdict: "any" | Verdict; tradable: boolean;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The date `n` weekdays after `from` (holidays are not known to the client; the API treats the range as report dates). */
export function weekdaysAhead(from: Date, n: number): string {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return iso(d);
}

export function defaultFilters(now = new Date(), horizon: HorizonChoice = "day"): EarningsFilters {
  const day = weekdaysAhead(now, SESSIONS_AHEAD[horizon]);
  return { from: day, to: day, customRange: false, horizon, time: "any", sector: "", minCapB: "", maxCapB: "", minScore: "", verdict: "any", tradable: false };
}

const num = (s: string) => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
};

/** The screen parameters for the filters; also the `filter` of POST /review. */
export function screenParams(f: EarningsFilters): Record<string, string> {
  const p: Record<string, string> = { from: f.from, to: f.to, horizon: horizonOf(f.horizon) };
  if (f.time !== "any") p.time = f.time;
  if (f.sector.trim()) p.sector = f.sector.trim();
  const lo = num(f.minCapB), hi = num(f.maxCapB), ms = num(f.minScore);
  if (lo !== null) p.minCap = String(Math.round(lo * 1e9));
  if (hi !== null) p.maxCap = String(Math.round(hi * 1e9));
  if (ms !== null) p.minScore = String(ms);
  if (f.verdict !== "any") p.verdict = f.verdict;
  if (f.tradable) p.tradable = "1";
  return p;
}
export const screenQuery = (f: EarningsFilters) => new URLSearchParams(screenParams(f)).toString();

// ---- persistence (per viewer) ----
export const FILTERS_KEY = "openterminal.earnings.filters.v1";
export function loadFilters(now = new Date()): EarningsFilters {
  const base = defaultFilters(now);
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return base;
    const s = JSON.parse(raw) as Partial<EarningsFilters>;
    const horizon = HORIZON_CHOICES.some(([k]) => k === s.horizon) ? (s.horizon as HorizonChoice) : "day";
    const merged: EarningsFilters = { ...defaultFilters(now, horizon), ...s, horizon };
    // Dates are only kept when the viewer chose them; otherwise they follow the next session.
    if (!(s.customRange && typeof s.from === "string" && typeof s.to === "string")) {
      const d = defaultFilters(now, horizon);
      merged.from = d.from;
      merged.to = d.to;
      merged.customRange = false;
    }
    return merged;
  } catch {
    return base;
  }
}
export function saveFilters(f: EarningsFilters) {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
  } catch {
    /* storage blocked: filters just don't persist */
  }
}

// ---- derived values and sorting ----
export const passesGates = (s: EarningsSetup) => s.gates.every((g) => g.passed);
export const surprisePct = (s: EarningsSetup): number | null => {
  const r = s.lastReport;
  if (!r || r.epsActual === null || r.epsEstimate === null || r.epsEstimate === 0) return null;
  return ((r.epsActual - r.epsEstimate) / Math.abs(r.epsEstimate)) * 100;
};
export const countLine = (rows: EarningsSetup[]) => `${rows.length} reporting · ${rows.filter(passesGates).length} pass gates`;

export type SortKey = "symbol" | "name" | "sector" | "cap" | "time" | "score" | "verdict" | "spread" | "implied" | "surprise" | "reaction";
export type Sort = { key: SortKey; dir: "asc" | "desc" };
const VERDICT_RANK: Record<Verdict, number> = { candidate: 2, conditional: 1, pass: 0 };
const TIME_RANK: Record<string, number> = { bmo: 0, dmh: 1, amc: 2 };
function sortValue(s: EarningsSetup, key: SortKey): string | number | null {
  switch (key) {
    case "symbol": return s.symbol;
    case "name": return s.name?.toLowerCase() ?? null;
    case "sector": return s.sector?.toLowerCase() ?? null;
    case "cap": return s.marketCap;
    case "time": return s.upcoming.time ? TIME_RANK[s.upcoming.time] : null;
    case "score": return s.score;
    case "verdict": return VERDICT_RANK[s.verdict];
    case "spread": return s.contract?.spreadPct ?? null;
    case "implied": return s.live.impliedMovePct;
    case "surprise": return surprisePct(s);
    case "reaction": return s.lastReport?.reactionPct ?? null;
  }
}
/** Sorted copy; missing values always go last, ties break on symbol. */
export function sortSetups(rows: EarningsSetup[], sort: Sort): EarningsSetup[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
    if (x === null && y === null) return a.symbol.localeCompare(b.symbol);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return c !== 0 ? sign * c : a.symbol.localeCompare(b.symbol);
  });
}

/** Reaction of an event: reaction-session close against the close before the announcement, in %. */
export function eventReactionPct(e: EarningsEventRow): number | null {
  const base = e.stock["T0:close"] ?? e.stock.prevClose;
  const after = e.stock["R:close"];
  return typeof base === "number" && typeof after === "number" && base !== 0 ? ((after - base) / base) * 100 : null;
}

// ---- review state ----
/** Latest review for each symbol, only those for the row's report date. */
export function latestReviews(reviews: EarningsReview[] | undefined): Map<string, EarningsReview> {
  const out = new Map<string, EarningsReview>();
  for (const r of reviews ?? []) {
    const key = `${r.symbol}|${r.reportDate}`;
    const cur = out.get(key);
    if (!cur || r.id > cur.id) out.set(key, r);
  }
  return out;
}
/** Default per-run cap (EARNINGS_REVIEW_MAX_USD); the confirmation figure is an upper bound built from it. */
export const REVIEW_COST_CAP_USD = 0.15;
export const estimateReviewCost = (rows: EarningsSetup[]) => rows.filter(passesGates).length * REVIEW_COST_CAP_USD;

// ---- calls ----
export const fetchScreen = (f: EarningsFilters) => apiGet<EarningsSetup[]>(`/api/earnings/screen?${screenQuery(f)}`);
export const fetchSetup = (symbol: string, horizon: Horizon) => apiGet<EarningsSetup>(`/api/earnings/setup/${encodeURIComponent(symbol)}?horizon=${horizon}`);
export const fetchEvents = (symbol: string, from?: string) =>
  apiGet<EarningsEventRow[]>(`/api/earnings/events/${encodeURIComponent(symbol)}${from ? `?from=${from}` : ""}`);
export const fetchReviews = (horizon: Horizon) => apiGet<EarningsReview[]>(`/api/earnings/reviews?horizon=${horizon}`);
export const reviewSymbol = (symbol: string, horizon: Horizon) => apiPost<ReviewQueued>("/api/earnings/review", { horizon, symbols: [symbol] });
export const reviewAll = (f: EarningsFilters) => apiPost<ReviewQueued>("/api/earnings/review", { horizon: horizonOf(f.horizon), filter: screenParams(f) });
