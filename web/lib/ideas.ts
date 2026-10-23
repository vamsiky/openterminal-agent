// Response shapes of /api/scan and /api/positions, copied from server/src/scan/contracts.ts (the web app does not import server code).

export type UniverseMode = "watchlists" | "sector" | "market";
export type UniverseSettings = {
  mode: UniverseMode;
  watchlistIds: number[] | null;
  sectors: string[];
  industries: string[];
  minPrice: number;
  minAvgDollarVolume: number;
  requireOptions: boolean;
};

export type OptionStrategy = "long_call" | "short_put" | "covered_call";
export type Idea = {
  id: number;
  kind: "stock" | "option";
  symbol: string;
  strategy: "buy" | OptionStrategy;
  contract: string | null;
  score: number;
  rank: number;
  reasons: string[];
  firstSeen: string;
  lastSeen: string;
  status: "active" | "dropped" | "near";
};

export type FactorScore = { key: string; group: string; value: number | null; score: number | null; change: number | null };
export type Scorecard = {
  symbol: string;
  asOf: string;
  sector: string | null;
  industry: string | null;
  composite: number | null;
  groups: Record<string, number | null>;
  factors: FactorScore[];
  coverage: number;
  weightsVersion: string;
};

export type OptionMetricsLite = {
  ivRank: number | null;
  impliedMovePct: number | null;
  atmExpiry: string | null;
};
export type OptionScorecard = {
  underlying: string;
  asOf: string;
  score: number | null;
  metrics: OptionMetricsLite | null;
  earningsBeforeExpiry: boolean | null;
  nextEarnings: string | null;
};
export type ScorecardResponse = { stock: Scorecard | null; live: Scorecard | null; options: OptionScorecard | null };

export type ScanRun = { started_at: string; finished_at: string | null; status: string; symbols: number | null; duration_ms: number | null; error: string | null };
export type ScanStatus = {
  runs: Record<string, ScanRun | null>;
  options: { connected: boolean; subscribed: number; targets?: number; limited?: number | null; inWindow?: boolean; lastError: string | null } | null;
};

export type Position = { kind: "stock"; symbol: string } | { kind: "option"; occ: string; underlying: string };
export type PositionsResponse = { importedAt: string | null; positions: Position[] };
export type ImportError = { line: number; message: string };

export const STRATEGY_LABEL: Record<OptionStrategy, string> = {
  long_call: "Buy call",
  short_put: "Sell put",
  covered_call: "Sell covered call",
};

export const strategyLabel = (s: Idea["strategy"]) => (s === "buy" ? "Buy" : STRATEGY_LABEL[s]);

/** OCC symbol as "Nov 21 '26 $150 C"; anything unparseable is shown as sent. */
export function contractLabel(occ: string | null): string {
  if (!occ) return "—";
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
  if (!m) return occ;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const strike = Number(m[6]) / 1000;
  return `${months[Number(m[3]) - 1]} ${Number(m[4])} '${m[2]} $${strike} ${m[5]}`;
}

/** Group keys in display order with short labels. */
export const GROUP_LABELS: Array<[string, string]> = [
  ["valuation", "Valuation"],
  ["quality", "Quality"],
  ["growth", "Growth"],
  ["earnings", "Earnings"],
  ["analysts", "Analysts"],
  ["momentum", "Momentum"],
];

/** "3m ago" style age of an ISO / SQLite timestamp; "—" when missing. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(" ", "T") + "Z");
  if (!isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
