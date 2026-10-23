"use client";

import { Fragment, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { apiGet, fmt } from "../../lib/api";
import { ago, contractLabel, GROUP_LABELS, strategyLabel, type Idea, type ScanRun, type ScanStatus, type ScorecardResponse } from "../../lib/ideas";
import { useTerminal } from "../../store/terminal";
import ErrorNote from "../ErrorNote";
import Chip from "../ui/Chip";
import { agentsLine, type AgentsStatus } from "../../lib/agents";
import EarningsTab from "./EarningsTab";
import BriefView from "./BriefView";
import IdeasSettings from "./IdeasSettings";
import ThesisView from "./ThesisView";

type Kind = "stock" | "option";
type Tab = Kind | "brief" | "earnings";
type IdeasResponse = { asOf: string | null; ideas: Idea[] };

const REFRESH: Record<Kind, number> = { option: 60_000, stock: 300_000 };

const scorecardKey = (symbol: string) => ["scorecard", symbol];
const fetchScorecard = (symbol: string) => apiGet<ScorecardResponse>(`/api/scan/scorecard/${encodeURIComponent(symbol)}`);

const runTime = (r: ScanRun | null | undefined) => r?.finished_at ?? r?.started_at ?? "";

/** The most recently finished of the named jobs. */
export function lastRun(runs: ScanStatus["runs"] | undefined, jobs: string[]): ScanRun | null {
  const hits = jobs.map((j) => runs?.[j]).filter((r): r is ScanRun => !!r);
  return hits.sort((a, b) => runTime(b).localeCompare(runTime(a)))[0] ?? null;
}

function streamText(o: NonNullable<ScanStatus["options"]>): string {
  if (o.inWindow === false) return "option stream closed (market hours only)";
  if (!o.connected) return "option stream offline";
  if (o.limited != null) return `${o.subscribed} of ${o.targets ?? o.subscribed} contracts streamed (Alpaca limit)`;
  return `${o.subscribed} contracts streamed`;
}

function StatusLine({ status, agents }: { status: ScanStatus | undefined; agents: AgentsStatus | undefined }) {
  if (!status && !agents) return null;
  const stock = lastRun(status?.runs, ["stock-nightly", "stock-intraday"]);
  const opt = lastRun(status?.runs, ["option-scan"]);
  const o = status?.options ?? null;
  return (
    <div className="px-2 py-0.5 dim text-[10px] border-t border-[var(--border)] break-words">
      {agents && <>{agentsLine(agents)} · </>}
      Stock scan {ago(runTime(stock) || null)} · Options sweep {ago(runTime(opt) || null)} ·{" "}
      {o ? streamText(o) : "option stream n/a"}
      {o?.lastError && o.inWindow !== false && o.limited == null ? <span className="down"> · {o.lastError}</span> : null}
    </div>
  );
}

function ScoreBars({ symbol }: { symbol: string }) {
  const { data, error, isLoading } = useQuery({ queryKey: scorecardKey(symbol), queryFn: () => fetchScorecard(symbol), staleTime: 60_000 });
  if (isLoading) return <div className="dim p-1">Loading scorecard…</div>;
  if (error) return <ErrorNote error={error} />;
  const card = data?.live ?? data?.stock;
  if (!card) return <div className="dim p-1">No scorecard for {symbol} yet.</div>;
  return (
    <div className="p-1 grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-0.5 items-center max-w-md">
      {GROUP_LABELS.map(([key, label]) => {
        const v = card.groups[key];
        return (
          <Fragment key={key}>
            <span className="dim">{label}</span>
            <span className="h-1.5 bg-[#1a1a1a]">
              {typeof v === "number" && <span className="block h-full bg-[var(--amber)]" style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />}
            </span>
            <span className="text-right">{typeof v === "number" ? fmt(v, 0) : "—"}</span>
          </Fragment>
        );
      })}
      <span className="dim col-span-3 text-[10px]">
        Composite {card.composite === null ? "—" : fmt(card.composite, 0)} · coverage {fmt(card.coverage * 100, 0)}% · {card.weightsVersion}
        {card.sector ? ` · ${card.sector}` : ""}
      </span>
    </div>
  );
}

function Reasons({ reasons, open }: { reasons: string[]; open: boolean }) {
  if (!reasons.length) return <span className="dim">—</span>;
  return (
    <span title={reasons.join("\n")}>
      {reasons[0]}
      {reasons.length > 1 && !open && <span className="dim"> +{reasons.length - 1}</span>}
    </span>
  );
}

export default function IdeasWidget() {
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [tab, setTab] = useState<Tab>("stock");
  const kind: Kind = tab === "option" ? "option" : "stock";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const ideas = useQuery({
    queryKey: ["ideas", kind],
    queryFn: () => apiGet<IdeasResponse>(`/api/scan/ideas?kind=${kind}&status=active&limit=50`),
    refetchInterval: REFRESH[kind],
    enabled: tab === "stock" || tab === "option",
  });
  const agents = useQuery({ queryKey: ["agents-status"], queryFn: () => apiGet<AgentsStatus>("/api/agents/status"), refetchInterval: 30_000, retry: false });
  const status = useQuery({ queryKey: ["scan-status"], queryFn: () => apiGet<ScanStatus>("/api/scan/status"), refetchInterval: 60_000 });

  const rows = ideas.data?.ideas ?? [];
  const optionSymbols = kind === "option" ? [...new Set(rows.map((r) => r.symbol))] : [];
  const cards = useQueries({
    queries: optionSymbols.map((s) => ({ queryKey: scorecardKey(s), queryFn: () => fetchScorecard(s), staleTime: 60_000 })),
  });
  const optionCard = (symbol: string) => cards[optionSymbols.indexOf(symbol)]?.data?.options ?? null;

  const cols = kind === "option" ? 9 : 5;

  return (
    <div className="flex flex-col h-full w-full min-w-0 overflow-x-hidden text-[11px]">
      <div className="flex flex-wrap items-center gap-1 p-1">
        {([["stock", "Stocks"], ["option", "Options"], ["brief", "Brief"], ["earnings", "Earnings"]] as const).map(([id, label]) => (
          <Chip key={id} on={tab === id} onClick={() => { setTab(id); setExpanded(null); }}>{label}</Chip>
        ))}
        <span className="dim ml-1 flex-1 basis-[120px] min-w-0 truncate">Candidates only, not orders{ideas.data?.asOf ? ` · as of ${ago(ideas.data.asOf)}` : ""}</span>
        <Chip on={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} title="Universe and positions">Settings</Chip>
      </div>
      {settingsOpen && <IdeasSettings />}
      <div className="flex-1 min-w-0 overflow-auto" style={{ containerType: "inline-size" }}>
        {tab === "earnings" ? (
          <EarningsTab agents={agents.data} />
        ) : tab === "brief" ? (
          <BriefView />
        ) : ideas.isLoading ? (
          <div className="p-2 dim">Loading ideas…</div>
        ) : ideas.error ? (
          <ErrorNote error={ideas.error} />
        ) : rows.length === 0 ? (
          <div className="p-2 dim">
            No {kind} ideas yet. {kind === "stock" ? "The stock screen runs at 07:00 and 16:30 ET." : "Option setups appear in market hours once the sweep has run."}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Symbol</th>
                <th>Score</th>
                {kind === "option" && <th>Strategy</th>}
                {kind === "option" && <th>Contract</th>}
                {kind === "option" && <th>IV rk</th>}
                {kind === "option" && <th>Impl mv</th>}
                {kind === "option" && <th>Earn</th>}
                <th style={{ textAlign: "left" }}>Why</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const oc = kind === "option" ? optionCard(r.symbol) : null;
                const open = expanded === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr onClick={() => setExpanded(open ? null : r.id)}>
                      <td>{r.rank}</td>
                      <td>
                        <button className="amber" onClick={(e) => { e.stopPropagation(); setActiveSymbol(r.symbol); }} title={`Select ${r.symbol}`}>{r.symbol}</button>
                      </td>
                      <td>{fmt(r.score, 0)}</td>
                      {kind === "option" && <td>{strategyLabel(r.strategy)}</td>}
                      {kind === "option" && <td>{contractLabel(r.contract)}</td>}
                      {kind === "option" && <td>{oc?.metrics?.ivRank == null ? "—" : fmt(oc.metrics.ivRank, 0)}</td>}
                      {kind === "option" && <td>{oc?.metrics?.impliedMovePct == null ? "—" : fmt(oc.metrics.impliedMovePct, 1) + "%"}</td>}
                      {kind === "option" && (
                        <td className={oc?.earningsBeforeExpiry ? "down" : "dim"} title={oc?.nextEarnings ? `Next earnings ${oc.nextEarnings}` : undefined}>
                          {oc?.earningsBeforeExpiry == null ? "—" : oc.earningsBeforeExpiry ? "Yes" : "No"}
                        </td>
                      )}
                      <td style={{ textAlign: "left", whiteSpace: open ? "normal" : "nowrap", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                        <Reasons reasons={r.reasons} open={open} />
                      </td>
                      <td className="dim">{ago(r.firstSeen)}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={cols + 2} style={{ textAlign: "left", whiteSpace: "normal" }}>
                          <div style={{ position: "sticky", left: 0, width: "min(100cqw, 640px)" }}>
                          {r.reasons.length > 1 && (
                            <ul className="p-1 list-disc pl-4">
                              {r.reasons.map((x, i) => <li key={i}>{x}</li>)}
                            </ul>
                          )}
                          <ScoreBars symbol={r.symbol} />
                          <ThesisView idea={r} agents={agents.data} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <StatusLine status={status.data} agents={agents.data} />
    </div>
  );
}
