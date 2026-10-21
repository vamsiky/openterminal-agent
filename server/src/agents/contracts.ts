// Types shared by the agents (server), their routes and the web thesis view.

export type AgentName = "macro" | "bull" | "bear" | "judge" | "brief";
export type Evidence = { claim: string; source: string; asOf: string | null }; // source = tool name + section, e.g. "fundamentals:estimates"

export type RegimeFlags = {
  rates: "rising" | "falling" | "flat" | "unknown";
  risk: "on" | "off" | "neutral" | "unknown";
  volatility: "low" | "normal" | "elevated" | "high" | "unknown";
  dollar: "strong" | "weak" | "flat" | "unknown";
  oil: "rising" | "falling" | "flat" | "unknown";
};
export type MacroReport = {
  id: number; asOf: string; session: "pre" | "post" | "adhoc";
  regime: RegimeFlags; summary: string;
  events: Array<{ time: string | null; event: string; importance: "high" | "medium" | "low" }>;
  risks: string[]; evidence: Evidence[]; costUsd: number;
};

export type CasePoint = { point: string; evidence: Evidence[] };
export type Case = { side: "bull" | "bear"; summary: string; points: CasePoint[]; costUsd: number };

export type ThesisStrategy = "buy" | "long_call" | "short_put" | "covered_call";
export type Verdict = "act" | "wait" | "pass";
export type Thesis = {
  id: number; ideaId: number | null; symbol: string; kind: "stock" | "option";
  strategy: ThesisStrategy; contract: string | null; asOf: string;
  status: "ok" | "rejected" | "error"; statusReason: string | null;
  verdict: Verdict | null; confidence: number | null; // 0–100
  horizon: string | null;                             // e.g. "3–6 months", "1–5 days"
  entry: { low: number | null; high: number | null; note: string } | null;
  target: { price: number | null; note: string } | null;
  invalidation: { price: number | null; condition: string } | null;
  exitPlan: string | null;                            // options: premium profit-take / stop / roll; stock: trim/exit rules
  catalysts: Array<{ date: string | null; event: string }>;
  risks: string[];
  summary: string | null;                             // judge's reasoning in a few sentences
  bull: Case | null; bear: Case | null;
  evidence: Evidence[];
  inputs: { scorecardAsOf: string | null; optionScorecardAsOf: string | null; macroId: number | null; ideaScore: number | null };
  models: { bull: string | null; bear: string | null; judge: string | null };
  costUsd: number;
};

export type Brief = { id: number; day: string; asOf: string; markdown: string; macroId: number | null; thesisIds: number[]; costUsd: number };

export type AgentsStatus = {
  enabled: boolean;
  today: { day: string; spentUsd: number; budgetUsd: number; runs: number; skippedForBudget: number };
  queue: Array<{ symbol: string; strategy: ThesisStrategy; reason: string; queuedAt: string }>;
  running: Array<{ agent: AgentName; symbol: string | null; startedAt: string }>;
  lastMacro: { id: number; asOf: string } | null;
  lastBrief: { id: number; day: string } | null;
};
