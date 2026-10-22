"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, fmt, fmtBig } from "../../lib/api";
import { budgetSpent, type AgentsStatus } from "../../lib/agents";
import { ago, contractLabel } from "../../lib/ideas";
import {
  HORIZON_CHOICES, TIME_LABEL, countLine, defaultFilters, estimateReviewCost, eventReactionPct, fetchEvents, fetchReviews, fetchScreen,
  horizonOf, latestReviews, loadFilters, passesGates, reviewAll, reviewSymbol, saveFilters, screenQuery, sortSetups, surprisePct,
  type Dist, type EarningsFilters, type EarningsReview, type EarningsSetup, type EventStats, type Sort, type SortKey, type TimeFilter, type Verdict,
} from "../../lib/earningsScreen";
import { useTerminal } from "../../store/terminal";
import ErrorNote from "../ErrorNote";

const PAGE = 100;
const pct = (n: number | null | undefined, d = 1) => (typeof n === "number" ? `${n > 0 ? "+" : ""}${fmt(n, d)}%` : "—");
const signClass = (n: number | null | undefined) => (typeof n !== "number" || n === 0 ? "dim" : n > 0 ? "up" : "down");
const chipClass = (v: Verdict) => (v === "candidate" ? "up" : v === "conditional" ? "amber" : "down");

const COLUMNS: Array<[SortKey, string, boolean]> = [
  ["symbol", "Symbol", false], ["name", "Name", true], ["sector", "Sector", true], ["cap", "Cap", false], ["time", "Time", false],
  ["score", "Score", false], ["verdict", "Verdict", false], ["spread", "Contract / spread", false], ["implied", "Impl mv", false],
  ["surprise", "Last surprise", false], ["reaction", "Last react", false],
];

function DistLine({ label, d }: { label: string; d: Dist | null }) {
  return (
    <div>
      <span className="dim">{label} </span>
      {d && d.n > 0 ? <>median {pct(d.median)} · win {d.winRate === null ? "—" : fmt(d.winRate * 100, 0) + "%"} · n {d.n}</> : <span className="dim">no data</span>}
    </div>
  );
}

function StatsBlock({ title, s }: { title: string; s: EventStats | null }) {
  return (
    <div>
      <div className="amber">{title}{s ? ` (n ${s.n})` : ""}</div>
      {s ? <><DistLine label="Stock" d={s.stock} /><DistLine label="Call" d={s.call} /></> : <div className="dim">none</div>}
    </div>
  );
}

function ReviewView({ r }: { r: EarningsReview }) {
  if (r.status === "error") return <div className="down p-1">Review failed: {r.statusReason ?? "no reason given"}</div>;
  const cls = r.verdict === "act" ? "up" : r.verdict === "pass" ? "down" : "amber";
  return (
    <div className="p-1 border-t border-[var(--border)] mt-1" data-testid="review">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${cls} border border-current px-1`}>{r.verdict ? r.verdict.toUpperCase() : "NO VERDICT"}</span>
        <span>
          Score {fmt(r.baseScore, 0)}
          {r.adjustedScore !== null && <> → <b>{fmt(r.adjustedScore, 0)}</b> <span className={signClass(r.adjustment)}>({r.adjustment !== null && r.adjustment > 0 ? "+" : ""}{r.adjustment})</span></>}
        </span>
      </div>
      {r.summary && <div className="mt-1">{r.summary}</div>}
      {r.newsFactors.length > 0 && (
        <ul className="list-disc pl-4 mt-1">
          {r.newsFactors.map((f, i) => (
            <li key={i}>
              <span className={f.direction === "+" ? "up" : "down"}>{f.direction}</span> {f.factor}
              {f.evidence.map((e, j) => <div key={j} className="dim text-[10px]">{e.claim} ({e.source}{e.asOf ? `, ${e.asOf}` : ""})</div>)}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mt-1">
        {r.entryConditions.length > 0 && <><span className="dim">Entry if</span><span>{r.entryConditions.map((c, i) => <div key={i}>{c}</div>)}</span></>}
        {r.exitPlan && <><span className="dim">Exit plan</span><span>{r.exitPlan}</span></>}
        {r.risks.length > 0 && <><span className="dim">Risks</span><span>{r.risks.map((c, i) => <div key={i}>{c}</div>)}</span></>}
      </div>
      <div className="dim text-[10px] mt-1">Advice only, not an order · reviewed {ago(r.asOf)} · cost ${fmt(r.costUsd, 2)}</div>
    </div>
  );
}

function Detail({ s, review, reviewState, blocked, onReview }: {
  s: EarningsSetup; review: EarningsReview | undefined; reviewState: string | null; blocked: string | null; onReview: () => void;
}) {
  const events = useQuery({ queryKey: ["earnings-events", s.symbol], queryFn: () => fetchEvents(s.symbol), staleTime: 300_000 });
  const c = s.contract;
  const busy = reviewState === "queued" || reviewState === "running";
  return (
    <div className="p-1 whitespace-normal text-left" data-testid={`detail-${s.symbol}`}>
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-0.5 items-center max-w-xl">
        {s.components.map((k) => (
          <Fragment key={k.key}>
            <span className="dim capitalize">{k.key}</span>
            <span className="h-1.5 bg-[#1a1a1a]"><span className="block h-full bg-[var(--amber)]" style={{ width: `${k.max ? Math.max(0, Math.min(100, (k.points / k.max) * 100)) : 0}%` }} /></span>
            <span className="text-right">{fmt(k.points, 0)}/{k.max}</span>
            <span className="col-span-3 dim text-[10px] -mt-0.5">{k.reason}</span>
          </Fragment>
        ))}
      </div>
      <div className="mt-1">
        {s.gates.map((g) => (
          <div key={g.key}><span className={g.passed ? "up" : "down"}>{g.passed ? "Passed" : "Failed"}</span> <span className="dim">{g.key.replace("_", " ")}:</span> {g.reason}</div>
        ))}
      </div>
      {c && (
        <div className="mt-1 dim">
          {contractLabel(c.occ)} · bid {fmt(c.bid)} / ask {fmt(c.ask)} · IV {c.iv === null ? "—" : fmt(c.iv * 100, 0) + "%"} · delta {c.delta === null ? "—" : fmt(c.delta)} · vol {c.volume ?? "—"} · OI {c.openInterest ?? "—"} · break-even {pct(c.breakevenStockMovePct)}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
        <StatsBlock title="Own history" s={s.history.own} />
        <StatsBlock title="Pooled (sector x cap)" s={s.history.pooled} />
        <div>
          <div className="amber">Blended (k {s.history.blended.k})</div>
          <div><span className="dim">Call median </span>{pct(s.history.blended.callMedian)}</div>
          <div><span className="dim">Stock win rate </span>{s.history.blended.stockWinRate === null ? "—" : fmt(s.history.blended.stockWinRate * 100, 0) + "%"}</div>
        </div>
      </div>
      <div className="mt-2">
        <div className="amber">Recent events</div>
        {events.isLoading ? <div className="dim">Loading events…</div> : events.error ? <ErrorNote error={events.error} /> : (events.data ?? []).length === 0 ? <div className="dim">No past events.</div> : (
          <table className="data-table max-w-xl">
            <thead><tr><th>Date</th><th>Time</th><th>EPS act / est</th><th>Reaction</th></tr></thead>
            <tbody>
              {(events.data ?? []).slice(0, 8).map((e) => {
                const rx = eventReactionPct(e);
                return (
                  <tr key={e.reportDate} style={{ cursor: "default" }}>
                    <td>{e.reportDate}</td><td>{e.time ? TIME_LABEL[e.time] : "?"}</td>
                    <td>{e.epsActual === null ? "—" : fmt(e.epsActual)} / {e.epsEstimate === null ? "—" : fmt(e.epsEstimate)}</td>
                    <td className={signClass(rx)}>{pct(rx)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {s.analyst.length > 0 && (
        <div className="mt-2">
          <div className="amber">Analyst actions (30d)</div>
          {s.analyst.map((a, i) => <div key={i}><span className="dim">{a.date}</span> {a.firm ?? "—"} {a.action}{a.priceTarget !== null ? ` · PT $${fmt(a.priceTarget, 0)}` : ""}</div>)}
        </div>
      )}
      <div className="mt-2 dim">
        Revisions: EPS 30d {pct(s.revisions.eps30d)} · EPS 90d {pct(s.revisions.eps90d)} · revenue 30d {pct(s.revisions.revenue30d)} · weights {s.weightsVersion}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button className="term-btn" disabled={busy || !!blocked} title={blocked ?? "Run the earnings agent on this name"} onClick={onReview}>
          {reviewState === "running" ? "Running…" : reviewState === "queued" ? "Queued" : review ? "Review again" : "Review"}
        </button>
        {blocked && <span className="dim">{blocked}</span>}
        {reviewState === "done" && !blocked && <span className="dim">Done</span>}
      </div>
      {review && <ReviewView r={review} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex items-center gap-1"><span className="dim">{label}</span>{children}</label>;
}

export default function EarningsTab({ agents }: { agents: AgentsStatus | undefined }) {
  const client = useQueryClient();
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [f, setFilters] = useState<EarningsFilters>(() => defaultFilters());
  const [hydrated, setHydrated] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: "score", dir: "desc" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [overBudget, setOverBudget] = useState(false);
  // Symbols whose review was queued from here; value = the review id on screen at that time.
  const [waiting, setWaiting] = useState<Record<string, number>>({});

  useEffect(() => {
    setFilters(loadFilters());
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) saveFilters(f);
  }, [f, hydrated]);

  const horizon = horizonOf(f.horizon);
  const screen = useQuery({ queryKey: ["earnings-screen", screenQuery(f)], queryFn: () => fetchScreen(f), enabled: hydrated, staleTime: 30_000 });
  const reviewsQ = useQuery({
    queryKey: ["earnings-reviews", horizon],
    queryFn: () => fetchReviews(horizon),
    enabled: hydrated,
    refetchInterval: Object.keys(waiting).length ? 5_000 : 60_000,
  });
  const reviews = useMemo(() => latestReviews(reviewsQ.data), [reviewsQ.data]);

  const rows = useMemo(() => sortSetups(screen.data ?? [], sort), [screen.data, sort]);
  const edit = (patch: Partial<EarningsFilters>) => { setFilters((cur) => ({ ...cur, ...patch })); setShown(PAGE); setExpanded(null); setConfirming(false); };
  const setHorizon = (h: EarningsFilters["horizon"]) => {
    if (f.customRange) edit({ horizon: h });
    else { const d = defaultFilters(new Date(), h); edit({ horizon: h, from: d.from, to: d.to }); }
  };
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "symbol" || key === "name" || key === "sector" ? "asc" : "desc" }));

  const reviewFor = (s: EarningsSetup) => reviews.get(`${s.symbol}|${s.upcoming.reportDate}`);
  const stateFor = (s: EarningsSetup): string | null => {
    const r = reviewFor(s);
    const base = waiting[s.symbol];
    if (agents?.running?.some((x) => x.symbol === s.symbol)) return "running";
    if (base !== undefined && (!r || r.id <= base)) return "queued";
    if (agents?.queue?.some((x) => x.symbol === s.symbol)) return "queued";
    return r ? "done" : null;
  };
  // Stop polling once every awaited review has arrived.
  useEffect(() => {
    const pending = Object.entries(waiting).filter(([sym, base]) => {
      const r = [...reviews.entries()].find(([k]) => k.startsWith(`${sym}|`))?.[1];
      return !r || r.id <= base;
    });
    if (pending.length !== Object.keys(waiting).length) setWaiting(Object.fromEntries(pending));
  }, [reviews, waiting]);

  const blocked = agents?.enabled === false ? "AI agents are disabled." : overBudget || budgetSpent(agents) ? "Daily AI budget reached." : null;
  const queue = (symbols: string[]) => {
    setWaiting((w) => {
      const next = { ...w };
      for (const sym of symbols) next[sym] = Math.max(0, ...[...reviews.entries()].filter(([k]) => k.startsWith(`${sym}|`)).map(([, r]) => r.id));
      return next;
    });
    client.invalidateQueries({ queryKey: ["agents-status"] });
  };
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 402) { setOverBudget(true); setNote("Daily AI budget reached; try again tomorrow."); }
    else if (err instanceof ApiError && err.status === 503) setNote("AI agents are disabled.");
    else setNote(`Review failed: ${(err as Error).message}`);
  };
  const reviewOne = async (s: EarningsSetup) => {
    setNote(null);
    try {
      const res = await reviewSymbol(s.symbol, horizon);
      if (res.queued > 0) queue([s.symbol]);
      setNote(res.queued > 0 ? `Queued ${s.symbol}.` : `${s.symbol} skipped (already reviewed or queued).`);
    } catch (err) { fail(err); }
  };
  const confirmAll = async () => {
    setConfirming(false);
    setNote(null);
    try {
      const res = await reviewAll(f);
      if (res.queued > 0) queue(rows.filter(passesGates).map((s) => s.symbol));
      setNote(`Queued ${res.queued}, skipped ${res.skipped} · estimated cost $${fmt(res.estimatedCostUsd, 2)}.`);
    } catch (err) { fail(err); }
  };

  const passing = rows.filter(passesGates).length;
  const visible = rows.slice(0, shown);

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 p-1 border-b border-[var(--border)]">
        <Field label="From"><input type="date" aria-label="From date" value={f.from} onChange={(e) => edit({ from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to, customRange: true })} /></Field>
        <Field label="To"><input type="date" aria-label="To date" value={f.to} min={f.from} onChange={(e) => edit({ to: e.target.value, customRange: true })} /></Field>
        <span className="flex gap-1">
          {HORIZON_CHOICES.map(([k, label]) => (
            <button key={k} className={`term-btn ${f.horizon === k ? "active" : ""}`} onClick={() => setHorizon(k)}>{label}</button>
          ))}
        </span>
        <Field label="Time">
          <select aria-label="Report time" value={f.time} onChange={(e) => edit({ time: e.target.value as TimeFilter })}>
            <option value="any">Any</option><option value="bmo">Before open</option><option value="amc">After close</option><option value="dmh">During market</option>
          </select>
        </Field>
        <Field label="Sector"><input aria-label="Sector" size={10} value={f.sector} placeholder="any" onChange={(e) => edit({ sector: e.target.value })} /></Field>
        <Field label="Cap $B"><input aria-label="Min cap" size={4} inputMode="decimal" value={f.minCapB} placeholder="min" onChange={(e) => edit({ minCapB: e.target.value })} />
          <input aria-label="Max cap" size={4} inputMode="decimal" value={f.maxCapB} placeholder="max" onChange={(e) => edit({ maxCapB: e.target.value })} /></Field>
        <Field label="Min score"><input aria-label="Min score" size={3} inputMode="numeric" value={f.minScore} onChange={(e) => edit({ minScore: e.target.value })} /></Field>
        <Field label="Verdict">
          <select aria-label="Verdict" value={f.verdict} onChange={(e) => edit({ verdict: e.target.value as EarningsFilters["verdict"] })}>
            <option value="any">Any</option><option value="candidate">Candidate</option><option value="conditional">Conditional</option><option value="pass">Pass</option>
          </select>
        </Field>
        <label className="flex items-center gap-1"><input type="checkbox" aria-label="Tradable only" checked={f.tradable} onChange={(e) => edit({ tradable: e.target.checked })} /><span>Tradable only</span></label>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-2 py-1">
        <span data-testid="count">{screen.data ? countLine(screen.data) : "—"}</span>
        <button className="term-btn" disabled={!!blocked || passing === 0 || confirming} title={blocked ?? "Run the earnings agent on every shown name that passes the gates"} onClick={() => setConfirming(true)}>Review all shown</button>
        {blocked && <span className="dim">{blocked}</span>}
        {confirming && (
          <span className="flex items-center gap-2 border border-[var(--amber)] px-1" role="alertdialog" aria-label="Confirm review all">
            Review {passing} names, estimated up to ${fmt(estimateReviewCost(rows), 2)}?
            <button className="term-btn" onClick={confirmAll}>Confirm</button>
            <button className="term-btn" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
        {note && <span className="dim">{note}</span>}
      </div>
      <div className="flex-1 overflow-auto">
        {!hydrated || screen.isLoading ? <div className="p-2 dim">Loading earnings…</div>
          : screen.error ? <ErrorNote error={screen.error} />
          : rows.length === 0 ? <div className="p-2 dim">No reports match these filters.</div>
          : (
            <table className="data-table">
              <thead>
                <tr>
                  {COLUMNS.map(([key, label, left]) => (
                    <th key={key} style={left ? { textAlign: "left" } : undefined} onClick={() => sortBy(key)} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                      {label}{sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => {
                  const open = expanded === s.symbol;
                  const sp = surprisePct(s);
                  const rs = stateFor(s);
                  const r = s.lastReport;
                  return (
                    <Fragment key={s.symbol}>
                      <tr onClick={() => setExpanded(open ? null : s.symbol)} data-testid={`row-${s.symbol}`}>
                        <td><button className="amber" onClick={(e) => { e.stopPropagation(); setActiveSymbol(s.symbol); }} title={`Select ${s.symbol}`}>{s.symbol}</button></td>
                        <td style={{ textAlign: "left", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{s.name ?? "—"}</td>
                        <td style={{ textAlign: "left" }} className="dim">{s.sector ?? "—"}</td>
                        <td>{s.marketCap === null ? "—" : fmtBig(s.marketCap)}</td>
                        <td title={s.upcoming.timeSource ? `Source: ${s.upcoming.timeSource}${s.upcoming.timeBasis ? ` (${s.upcoming.timeBasis})` : ""}` : "Time unknown"}>{s.upcoming.time ? TIME_LABEL[s.upcoming.time] : "?"}</td>
                        <td>{fmt(s.score, 0)}</td>
                        <td><span className={`${chipClass(s.verdict)} border border-current px-1`}>{s.verdict}</span></td>
                        <td>{s.contract ? `${contractLabel(s.contract.occ)} · ${s.contract.spreadPct === null ? "—" : fmt(s.contract.spreadPct, 1) + "%"}` : <span className="dim">no options</span>}</td>
                        <td>{s.live.impliedMovePct === null ? "—" : fmt(s.live.impliedMovePct, 1) + "%"}</td>
                        <td title={r ? `EPS ${r.epsActual ?? "—"} vs ${r.epsEstimate ?? "—"}` : undefined} className={signClass(sp)}>
                          {r && r.epsActual !== null ? `${fmt(r.epsActual)} vs ${r.epsEstimate === null ? "—" : fmt(r.epsEstimate)}` : "—"}
                        </td>
                        <td className={signClass(r?.reactionPct)}>{pct(r?.reactionPct)}</td>
                        <td className="dim">{rs ?? ""}</td>
                      </tr>
                      {open && (
                        <tr style={{ cursor: "default" }}>
                          <td colSpan={COLUMNS.length + 1} style={{ textAlign: "left", whiteSpace: "normal" }}>
                            <Detail s={s} review={reviewFor(s)} reviewState={rs} blocked={blocked} onReview={() => reviewOne(s)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        {rows.length > shown && (
          <div className="p-2 text-center">
            <button className="term-btn" onClick={() => setShown((n) => n + PAGE)}>Show more ({rows.length - shown} left)</button>
          </div>
        )}
      </div>
    </div>
  );
}
