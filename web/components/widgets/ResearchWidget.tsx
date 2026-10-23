"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError, apiGet, apiPost, fmt, fmtBig } from "../../lib/api";
import { budgetSpent, verdictLabel, type AgentsStatus, type Thesis } from "../../lib/agents";
import type { EarningsReview, EarningsSetup, Horizon } from "../../lib/earningsScreen";
import { TIME_LABEL } from "../../lib/earningsScreen";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import ErrorNote from "../ErrorNote";
import { dstr, signCls, signed } from "../details/shared";

const HORIZONS: Array<[Horizon, string]> = [["intraday", "Report day"], ["week", "Week before"], ["month", "Month before"]];
const verdictCls = (v: string) => (v === "candidate" || v === "act" ? "up" : v === "conditional" || v === "wait" ? "amber" : "dim");
const LABEL = "dim flex-none";

type History = { fiscalQtrEnd: string; upcoming?: boolean; surprisePercent: number | null; dayAfterChangePercent: number | null };

async function fetchSetups(symbol: string): Promise<EarningsSetup[]> {
  const one = (h: Horizon) =>
    apiGet<EarningsSetup>(`/api/earnings/setup/${encodeURIComponent(symbol)}?horizon=${h}`).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
  return (await Promise.all(HORIZONS.map(([h]) => one(h)))).filter((s): s is EarningsSetup => !!s?.upcoming);
}

function Card({ title, badge, badgeCls = "dim", children }: { title: string; badge?: string; badgeCls?: string; children: ReactNode }) {
  return (
    <article className="flex flex-col gap-2 p-3 rounded-lg border border-[#262626] bg-[#0d0d0d]">
      <div className="flex justify-between items-baseline gap-2">
        <h3 className="m-0 text-[13px] font-semibold text-[#ededed]">{title}</h3>
        {badge && <span className={`text-[11px] whitespace-nowrap ${badgeCls}`}>{badge}</span>}
      </div>
      {children}
    </article>
  );
}

function Stats({ rows }: { rows: Array<{ k: string; v: ReactNode; cls?: string }> }) {
  return (
    <div className="flex flex-col text-xs">
      {rows.map((r) => (
        <div key={r.k} className="flex justify-between gap-3 py-[2px] border-b border-[#161616]">
          <span className={LABEL}>{r.k}</span>
          <span className={`text-right ${r.cls ?? ""}`}>{r.v}</span>
        </div>
      ))}
    </div>
  );
}

const Text = ({ children }: { children: ReactNode }) => <p className="m-0 text-xs leading-normal text-[#cfcfcf]">{children}</p>;
const Bullets = ({ items }: { items: string[] }) => (
  <ul className="m-0 pl-[18px] flex flex-col gap-1">
    {items.map((b, i) => <li key={i} className="text-xs leading-normal text-[#cfcfcf]">{b}</li>)}
  </ul>
);
const Msg = ({ children }: { children: ReactNode }) => <div className="msg">{children}</div>;

function SetupCard({ symbol }: { symbol: string }) {
  const q = useQuery({ queryKey: ["research-setup", symbol], queryFn: () => fetchSetups(symbol), staleTime: 60_000, retry: 0 });
  if (q.error) return <Card title="Earnings setup"><ErrorNote error={q.error} /></Card>;
  if (q.isLoading) return <Card title="Earnings setup"><div className="dim text-xs">Loading earnings setup for {symbol}…</div></Card>;
  const setups = q.data ?? [];
  const lead = setups.find((s) => s.horizon === "intraday") ?? setups[0];
  if (!lead) {
    return (
      <Card title="Earnings setup" badge="No upcoming report">
        <Msg>The earnings store has no upcoming report for {symbol}, so there is no setup score yet.</Msg>
      </Card>
    );
  }
  const u = lead.upcoming;
  const failed = lead.gates.filter((g) => !g.passed);
  return (
    <Card title="Earnings setup" badge={`${dstr(u.reportDate)} · ${u.time ? u.time.toUpperCase() : "?"}`} badgeCls="amber">
      <Stats
        rows={[
          ...HORIZONS.flatMap(([h, label]) => {
            const s = setups.find((x) => x.horizon === h);
            return s ? [{ k: label, v: `${fmt(s.score, 0)} · ${s.verdict}`, cls: verdictCls(s.verdict) }] : [];
          }),
          ...(u.time ? [{ k: "Reports", v: TIME_LABEL[u.time] }] : []),
        ]}
      />
      {u.epsEstimate != null && (
        <Text>
          EPS estimate {fmt(u.epsEstimate)}{u.revenueEstimate ? `, revenue ${fmtBig(u.revenueEstimate)}` : ""}{u.fiscalPeriod ? ` (${u.fiscalPeriod})` : ""}.
        </Text>
      )}
      {failed.length > 0 && <Text>Fails gates: {failed.map((g) => g.key.replace(/_/g, " ")).join(", ")}.</Text>}
      <Bullets items={[...failed.map((g) => g.reason), ...lead.components.map((c) => c.reason)].filter(Boolean)} />
    </Card>
  );
}

function ReviewCard({ r }: { r: EarningsReview }) {
  const score = r.adjustedScore ?? r.baseScore;
  return (
    <Card title={`Earnings review · ${HORIZONS.find(([h]) => h === r.horizon)?.[1] ?? r.horizon}`} badge={dstr(r.asOf)}>
      {r.status === "error" ? (
        <Msg>The review failed{r.statusReason ? `: ${r.statusReason}` : "."}</Msg>
      ) : (
        <>
          <Stats rows={[
            { k: "Verdict", v: r.verdict ?? "—", cls: r.verdict ? verdictCls(r.verdict) : "dim" },
            { k: "Score", v: `${fmt(score, 0)}${r.adjustment ? ` (${r.adjustment > 0 ? "+" : ""}${fmt(r.adjustment, 0)} from AI)` : ""}` },
            { k: "Report date", v: dstr(r.reportDate) },
          ]} />
          {r.summary && <Text>{r.summary}</Text>}
          <Bullets items={[...r.entryConditions.map((c) => `Entry: ${c}`), ...(r.exitPlan ? [`Exit: ${r.exitPlan}`] : []), ...r.risks.map((x) => `Risk: ${x}`)]} />
        </>
      )}
    </Card>
  );
}

function ThesisCard({ t }: { t: Thesis }) {
  const label = t.strategy === "buy" ? "Buy shares" : t.strategy.replace(/_/g, " ");
  return (
    <Card title={`AI thesis · ${label}`} badge={dstr(t.asOf)}>
      {t.status !== "ok" ? (
        <Msg>{t.status === "rejected" ? "The judge rejected this idea" : "The analysis failed"}{t.statusReason ? `: ${t.statusReason}` : "."}</Msg>
      ) : (
        <>
          <Stats rows={[
            { k: "Verdict", v: verdictLabel(t.verdict, label), cls: t.verdict ? verdictCls(t.verdict) : "dim" },
            { k: "Confidence", v: t.confidence == null ? "—" : `${t.confidence}%` },
            { k: "Horizon", v: t.horizon ?? "—" },
          ]} />
          {t.summary && <Text>{t.summary}</Text>}
          <Bullets items={[t.bull?.summary ? `Bull: ${t.bull.summary}` : "", t.bear?.summary ? `Bear: ${t.bear.summary}` : ""].filter(Boolean)} />
        </>
      )}
    </Card>
  );
}

function AnalysisCards({ symbol }: { symbol: string }) {
  const client = useQueryClient();
  const [requested, setRequested] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const reviews = useQuery({
    queryKey: ["research-reviews", symbol],
    queryFn: () => apiGet<EarningsReview[]>(`/api/earnings/reviews?symbol=${encodeURIComponent(symbol)}&limit=5`),
    staleTime: 60_000,
    retry: 0,
  });
  const theses = useQuery({
    queryKey: ["research-theses", symbol],
    queryFn: () => apiGet<Thesis[]>(`/api/agents/theses?symbol=${encodeURIComponent(symbol)}&limit=5`),
    staleTime: 30_000,
    retry: 0,
    // While a request is queued, poll until the thesis shows up.
    refetchInterval: (q) => (requested && !q.state.data?.length ? 5_000 : false),
  });
  const agents = useQuery({ queryKey: ["agents-status"], queryFn: () => apiGet<AgentsStatus>("/api/agents/status"), staleTime: 30_000, retry: 0 });

  if (reviews.error || theses.error) return <Card title="AI analysis"><ErrorNote error={reviews.error ?? theses.error} /></Card>;
  if (reviews.isLoading || theses.isLoading) return <Card title="AI analysis"><div className="dim text-xs">Loading AI analysis for {symbol}…</div></Card>;

  const rv = (reviews.data ?? []).filter((r) => r.status === "ok" || r.statusReason);
  const th = theses.data ?? [];
  if (rv.length + th.length > 0) {
    return <>{rv.slice(0, 3).map((r) => <ReviewCard key={`r${r.id}`} r={r} />)}{th.slice(0, 3).map((t) => <ThesisCard key={`t${t.id}`} t={t} />)}</>;
  }

  const off = agents.data?.enabled === false;
  const spent = budgetSpent(agents.data);
  const blocked = off ? "AI agents are disabled." : spent ? "Daily AI budget reached." : null;

  const request = async () => {
    setNote(null);
    try {
      await apiPost("/api/agents/analyze", { symbol, strategy: "buy" });
      setRequested(true);
      setNote("Analysis queued: bull, bear and judge agents. It usually takes a minute or two.");
      client.invalidateQueries({ queryKey: ["agents-status"] });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409) {
        setRequested(true);
        setNote("Already queued or running.");
      } else if (status === 402) setNote("Daily AI budget reached; try again tomorrow.");
      else if (status === 503) setNote("AI agents are disabled.");
      else setNote(`Request failed: ${(err as Error).message}`);
    }
  };

  return (
    <Card title="AI analysis" badge="None yet">
      <Msg>{note ?? blocked ?? `No AI analysis or options report for ${symbol} yet.`}</Msg>
      {!requested && (
        <button className="chip on self-start !px-2.5 !py-[5px] !rounded-md" disabled={!!blocked} title={blocked ?? "Run the bull, bear and judge agents on a stock thesis for this symbol"} onClick={request}>
          Request analysis
        </button>
      )}
    </Card>
  );
}

function TrackRecord({ symbol }: { symbol: string }) {
  const q = useQuery({ queryKey: ["research-history", symbol], queryFn: () => apiGet<History[]>(`/api/earnings-history/${encodeURIComponent(symbol)}`), staleTime: 300_000, retry: 0 });
  if (q.error) return <Card title="Earnings track record"><ErrorNote error={q.error} /></Card>;
  if (q.isLoading) return <Card title="Earnings track record"><div className="dim text-xs">Loading earnings history for {symbol}…</div></Card>;
  const past = (q.data ?? []).filter((e) => !e.upcoming).slice(0, 4);
  if (past.length === 0) return <Card title="Earnings track record" badge="None"><Msg>No earnings history for {symbol}.</Msg></Card>;
  return (
    <Card title="Earnings track record" badge={`last ${past.length}`}>
      <Stats rows={past.map((e) => ({
        k: `${dstr(e.fiscalQtrEnd).replace(/, \d{4}$/, "")} qtr`,
        v: `EPS ${signed(e.surprisePercent, 1)} vs est · next day ${signed(e.dayAfterChangePercent, 1)}`,
        cls: signCls(e.dayAfterChangePercent),
      }))} />
    </Card>
  );
}

export default function ResearchWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  return (
    <div className="flex flex-col gap-2.5 p-2.5 font-sans-ui" data-widget={widget.id}>
      <div className="text-xs text-[#9a9a9a]">
        Reports and analysis for <span className="amber font-mono">{symbol}</span>
      </div>
      <SetupCard symbol={symbol} />
      <AnalysisCards symbol={symbol} />
      <TrackRecord symbol={symbol} />
    </div>
  );
}
