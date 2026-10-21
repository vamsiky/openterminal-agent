"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiPost, fmt } from "../../lib/api";
import { budgetSpent, verdictLabel, type AgentsStatus, type Case, type Thesis } from "../../lib/agents";
import { ago, strategyLabel, type Idea } from "../../lib/ideas";
import ErrorNote from "../ErrorNote";

/** The idea's latest thesis, or null when none exists (404). Tries the idea id first, then the symbol/strategy/contract. */
async function fetchThesis(idea: Idea): Promise<Thesis | null> {
  const tryGet = async (query: string) => {
    try {
      return await apiGet<Thesis>(`/api/agents/theses/latest?${query}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  };
  const byId = await tryGet(`ideaId=${idea.id}`);
  if (byId) return byId;
  const q = new URLSearchParams({ symbol: idea.symbol, strategy: idea.strategy });
  if (idea.contract) q.set("contract", idea.contract);
  return tryGet(q.toString());
}

const money = (n: number | null | undefined) => (typeof n === "number" ? "$" + fmt(n) : "—");

function CaseView({ c, label }: { c: Case | null; label: string }) {
  if (!c) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer amber">{label} case</summary>
      <div className="pl-2">
        <div>{c.summary}</div>
        <ul className="list-disc pl-4">
          {c.points.map((p, i) => (
            <li key={i}>
              {p.point}
              {p.evidence.map((e, j) => (
                <div key={j} className="dim text-[10px]" title={e.claim}>
                  {e.claim} ({e.source}{e.asOf ? `, ${e.asOf}` : ""})
                </div>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="dim">{label}</span>
      <span>{children}</span>
    </>
  );
}

function Body({ t, idea }: { t: Thesis; idea: Idea }) {
  const chipClass = t.verdict === "act" ? "up" : t.verdict === "pass" ? "down" : "amber";
  const rejected = t.status !== "ok";
  return (
    <div className={rejected ? "opacity-60" : ""}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${chipClass} border border-current px-1`}>{rejected && t.status === "error" ? "Analysis failed" : verdictLabel(t.verdict, strategyLabel(idea.strategy))}</span>
        {t.confidence !== null && <span>Confidence {fmt(t.confidence, 0)}%</span>}
        {t.horizon && <span className="dim">Horizon {t.horizon}</span>}
      </div>
      {rejected && <div className="down mt-1">{t.status === "rejected" ? "Rejected: " : ""}{t.statusReason ?? "no reason given"}</div>}
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mt-1">
        {t.entry && (
          <Row label="Entry">
            {t.entry.low !== null || t.entry.high !== null ? `${money(t.entry.low)} – ${money(t.entry.high)}` : ""} {t.entry.note}
          </Row>
        )}
        {t.target && <Row label="Target">{t.target.price !== null ? money(t.target.price) : ""} {t.target.note}</Row>}
        {t.invalidation && <Row label="Invalidation">{t.invalidation.price !== null ? money(t.invalidation.price) : ""} {t.invalidation.condition}</Row>}
        {t.exitPlan && <Row label="Exit plan">{t.exitPlan}</Row>}
        {t.catalysts.length > 0 && (
          <Row label="Catalysts">
            {t.catalysts.map((c, i) => <div key={i}><span className="dim">{c.date ?? "undated"}</span> {c.event}</div>)}
          </Row>
        )}
        {t.risks.length > 0 && <Row label="Risks">{t.risks.map((r, i) => <div key={i}>{r}</div>)}</Row>}
        {t.summary && <Row label="Judge">{t.summary}</Row>}
      </div>
      <CaseView c={t.bull} label="Bull" />
      <CaseView c={t.bear} label="Bear" />
      <div className="dim text-[10px] mt-1">Advice only, not an order · analysed {ago(t.asOf)} · cost ${fmt(t.costUsd, 2)}</div>
    </div>
  );
}

export default function ThesisView({ idea, agents }: { idea: Idea; agents: AgentsStatus | undefined }) {
  const client = useQueryClient();
  const [queued, setQueued] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const thesis = useQuery({
    queryKey: ["thesis", idea.id],
    queryFn: () => fetchThesis(idea),
    staleTime: 30_000,
    // While an analysis is queued, poll until the thesis arrives.
    refetchInterval: (q) => (queued && !q.state.data ? 5_000 : false),
  });

  const analyse = async () => {
    setNote(null);
    try {
      await apiPost("/api/agents/analyze", { symbol: idea.symbol, strategy: idea.strategy, contract: idea.contract ?? undefined, ideaId: idea.id });
      setQueued(true);
      setNote("Queued: the analysis usually takes a minute or two.");
      client.invalidateQueries({ queryKey: ["agents-status"] });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409) {
        setQueued(true);
        setNote("Already queued or running.");
      } else if (status === 402) setNote("Daily AI budget reached; try again tomorrow.");
      else if (status === 503) setNote("AI agents are disabled.");
      else setNote(`Analyse failed: ${(err as Error).message}`);
    }
  };

  if (thesis.isLoading) return <div className="dim p-1">Loading thesis…</div>;
  if (thesis.error) return <ErrorNote error={thesis.error} />;
  if (thesis.data) {
    return (
      <div className="p-1 border-t border-[var(--border)] mt-1">
        <Body t={thesis.data} idea={idea} />
      </div>
    );
  }
  const noBudget = budgetSpent(agents);
  const off = agents?.enabled === false;
  const disabled = queued || noBudget || off;
  const reason = off ? "AI agents are disabled." : noBudget ? "Daily AI budget reached." : null;
  return (
    <div className="p-1 border-t border-[var(--border)] mt-1 flex items-center gap-2">
      <span className="dim">{queued ? "Analysing…" : "Not analysed yet"}</span>
      <button className="term-btn" disabled={disabled} onClick={analyse} title={reason ?? "Run the bull, bear and judge agents on this idea"}>
        {queued ? "Queued" : "Analyse"}
      </button>
      {(note || reason) && <span className="dim">{note ?? reason}</span>}
    </div>
  );
}
