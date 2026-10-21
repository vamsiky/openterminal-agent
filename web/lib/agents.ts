// Response shapes of /api/agents, copied from server/src/agents/contracts.ts (the web app does not import server code).

export type Evidence = { claim: string; source: string; asOf: string | null };
export type CasePoint = { point: string; evidence: Evidence[] };
export type Case = { side: "bull" | "bear"; summary: string; points: CasePoint[]; costUsd: number };
export type Verdict = "act" | "wait" | "pass";
export type Thesis = {
  id: number;
  ideaId: number | null;
  symbol: string;
  kind: "stock" | "option";
  strategy: "buy" | "long_call" | "short_put" | "covered_call";
  contract: string | null;
  asOf: string;
  status: "ok" | "rejected" | "error";
  statusReason: string | null;
  verdict: Verdict | null;
  confidence: number | null;
  horizon: string | null;
  entry: { low: number | null; high: number | null; note: string } | null;
  target: { price: number | null; note: string } | null;
  invalidation: { price: number | null; condition: string } | null;
  exitPlan: string | null;
  catalysts: Array<{ date: string | null; event: string }>;
  risks: string[];
  summary: string | null;
  bull: Case | null;
  bear: Case | null;
  evidence: Evidence[];
  costUsd: number;
};
export type Brief = { id: number; day: string; asOf: string; markdown: string; macroId: number | null; thesisIds: number[]; costUsd: number };
export type AgentsStatus = {
  enabled: boolean;
  /** "claude_login" when runs use the user's Claude login instead of an API key. */
  auth?: string;
  today: { day: string; spentUsd: number; budgetUsd: number; runs: number; skippedForBudget: number };
  queue: Array<{ symbol: string; strategy: string; reason: string; queuedAt: string }>;
  running: Array<{ agent: string; symbol: string | null; startedAt: string }>;
};

/** "Act: Sell put", "Wait", "Pass"; strategy wording as in the Ideas table. */
export function verdictLabel(verdict: Verdict | null, strategyLabel: string): string {
  if (verdict === "act") return `Act: ${strategyLabel}`;
  if (verdict === "wait") return "Wait";
  if (verdict === "pass") return "Pass";
  return "No verdict";
}

/** Footer text, e.g. "AI today $1.84 / $5.00 · 3 queued · 1 running (Claude login)". */
export function agentsLine(s: AgentsStatus): string {
  if (!s.enabled) return "AI agents off";
  if (!s.today) return "AI agents on";
  const usd = (n: number) => `$${n.toFixed(2)}`;
  let out = `AI today ${usd(s.today.spentUsd)} / ${usd(s.today.budgetUsd)}`;
  if ((s.queue?.length ?? 0)) out += ` · ${(s.queue?.length ?? 0)} queued`;
  if ((s.running?.length ?? 0)) out += ` · ${(s.running?.length ?? 0)} running`;
  if (s.auth === "claude_login") out += " (Claude login)";
  return out;
}

export const budgetSpent = (s: AgentsStatus | undefined) => !!s?.today && s.today.spentUsd >= s.today.budgetUsd;
