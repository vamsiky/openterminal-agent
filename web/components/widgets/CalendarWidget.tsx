"use client";

import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { apiGet, fmt, fmtBig, pctClass } from "../../lib/api";
import ErrorNote from "../ErrorNote";
import EstimateRevisions from "../EstimateRevisions";
import { fetchCalendar, fmtDay, groupEarnings, inDays } from "../../lib/earnings";
import { useTerminal } from "../../store/terminal";

type EconEvent = {
  title: string;
  country: string;
  date: string;
  impact: "Low" | "Medium" | "High" | "Holiday";
  forecast: string | null;
  previous: string | null;
  actual: string | null;
};

const IMPACT_CLASS: Record<EconEvent["impact"], string> = {
  High: "down",
  Medium: "amber",
  Low: "dim",
  Holiday: "dim",
};

const TIMEZONES: Array<{ label: string; zone: string | undefined }> = [
  { label: "Local", zone: undefined },
  { label: "UTC", zone: "UTC" },
  { label: "New York", zone: "America/New_York" },
  { label: "Chicago", zone: "America/Chicago" },
  { label: "London", zone: "Europe/London" },
  { label: "Frankfurt", zone: "Europe/Berlin" },
  { label: "Tokyo", zone: "Asia/Tokyo" },
  { label: "Sydney", zone: "Australia/Sydney" },
];

function fmtEventTime(date: string, zone: string | undefined): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    timeZone: zone,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function EconomicTab() {
  const [minImpact, setMinImpact] = useState<"all" | "medium">("medium");
  const [tz, setTz] = useState<string>("Local");

  const { data = [], isLoading, error } = useQuery({
    queryKey: ["econ-calendar"],
    queryFn: () => apiGet<EconEvent[]>("/api/econ-calendar"),
    refetchInterval: 300_000,
  });

  const events = useMemo(
    () => (minImpact === "all" ? data : data.filter((e) => e.impact === "High" || e.impact === "Medium")),
    [data, minImpact]
  );

  if (error) return <ErrorNote error={error} />;
  if (isLoading) return <div className="p-2 dim">Loading calendar…</div>;

  const zone = TIMEZONES.find((t) => t.label === tz)?.zone;

  return (
    <div>
      <div className="flex gap-1 p-1 items-center flex-wrap">
        <button className={`term-btn ${minImpact === "medium" ? "active" : ""}`} onClick={() => setMinImpact("medium")}>
          HIGH+MED
        </button>
        <button className={`term-btn ${minImpact === "all" ? "active" : ""}`} onClick={() => setMinImpact("all")}>
          ALL
        </button>
        <span className="w-2" />
        <select
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          className="term-btn !py-0.5 bg-[var(--panel)] cursor-pointer"
        >
          {TIMEZONES.map((t) => (
            <option key={t.label} value={t.label}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ccy</th>
            <th>Event</th>
            <th>Forecast</th>
            <th>Previous</th>
            <th>Actual</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.title}-${e.date}-${i}`}>
              <td className="!text-left dim whitespace-nowrap">
                {fmtEventTime(e.date, zone)}
              </td>
              <td>{e.country}</td>
              <td className={`!text-left ${IMPACT_CLASS[e.impact] ?? "dim"}`}>{e.title}</td>
              <td>{e.forecast ?? "—"}</td>
              <td className="dim">{e.previous ?? "—"}</td>
              <td className={e.actual ? "text-[var(--text)]" : "dim"}>{e.actual ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && <div className="p-3 dim">No events in the next two weeks.</div>}
    </div>
  );
}

const fmtDate = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleDateString("en-US") : "—");

type EarningsHistoryRow = {
  fiscalQtrEnd: string;
  fiscalPeriod?: string;
  upcoming?: boolean;
  dateReported: number;
  eps: number | null;
  consensusForecast: number | null;
  surprisePercent: number | null;
  dayAfterChangePercent: number | null;
  revenue?: number | null;
  revenueEstimate?: number | null;
};

/** "Q2 FY2027" + "2026-07-26" → "Q2 FY27 · Jul 26"; falls back to whichever part exists. */
function quarterLabel(row: EarningsHistoryRow): string {
  const period = row.fiscalPeriod?.replace(/FY\d\d(\d\d)$/, "FY$1") ?? "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.fiscalQtrEnd);
  const end = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  return [period, end].filter(Boolean).join(" · ") || "—";
}

/** Actual vs forecast: beat = green, miss = red, in-line = white. */
function surpriseClass(row: EarningsHistoryRow): string {
  if (row.eps === null || row.consensusForecast === null) return "dim";
  if (row.eps > row.consensusForecast) return "up";
  if (row.eps < row.consensusForecast) return "down";
  return "text-[var(--text)]";
}

function EarningsHistoryRows({ symbol }: { symbol: string }) {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["earnings-history", symbol],
    queryFn: () => apiGet<EarningsHistoryRow[]>(`/api/earnings-history/${encodeURIComponent(symbol)}`),
    staleTime: 3_600_000,
  });

  if (error) return <ErrorNote error={error} />;
  if (isLoading) return <div className="p-2 dim">Loading history for {symbol}…</div>;
  if (data.length === 0) return <div className="p-2 dim">No earnings history for {symbol}.</div>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Quarter</th>
          <th>Reported</th>
          <th>Forecast</th>
          <th>Actual</th>
          <th>Surprise</th>
          <th>Revenue</th>
          <th>Day After</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) =>
          row.upcoming ? (
            <tr key={row.dateReported}>
              <td colSpan={7} className="!text-left amber">
                Next: {fmtDate(row.dateReported)} · EPS est {money(row.consensusForecast)} · Rev est{" "}
                {row.revenueEstimate != null ? `$${fmtBig(row.revenueEstimate)}` : "—"}
                <EstimateRevisions symbol={symbol} className="ml-3" />
              </td>
            </tr>
          ) : (
          <tr key={row.dateReported}>
            <td className="!text-left dim">{quarterLabel(row)}</td>
            <td className="!text-left dim">{fmtDate(row.dateReported)}</td>
            <td className="dim">{money(row.consensusForecast)}</td>
            <td className={surpriseClass(row)}>{money(row.eps)}</td>
            <td className={surpriseClass(row)}>{row.surprisePercent != null ? `${fmt(row.surprisePercent, 1)}%` : "—"}</td>
            <td className="dim" title={`Estimate ${fmtBig(row.revenueEstimate)}`}>{fmtBig(row.revenue)}</td>
            <td className={pctClass(row.dayAfterChangePercent)}>
              {row.dayAfterChangePercent != null ? `${fmt(row.dayAfterChangePercent, 1)}%` : "—"}
            </td>
          </tr>
          )
        )}
      </tbody>
    </table>
  );
}

const money = (n: number | null | undefined) => (n != null ? `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}` : "—");

function EarningsTab() {
  const watchlist = useTerminal((s) => s.watchlist);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ["calendar", watchlist],
    queryFn: () => fetchCalendar(watchlist),
    enabled: watchlist.length > 0,
    staleTime: 900_000,
    refetchOnWindowFocus: true,
  });

  const groups = useMemo(() => groupEarnings(data, new Date()), [data]);

  if (error) return <ErrorNote error={error} />;
  if (isLoading) return <div className="p-2 dim">Loading earnings…</div>;

  const header = (label: string, dim = false) => (
    <tr key={`h-${label}`}>
      <td colSpan={5} className={`!text-left uppercase text-[10px] tracking-wide pt-2 ${dim ? "dim" : "amber"}`}>
        {label}
      </td>
    </tr>
  );
  const detail = (symbol: string) =>
    expanded === symbol && (
      <tr key={`d-${symbol}`}>
        <td colSpan={5} className="!text-left p-0">
          <EarningsHistoryRows symbol={symbol} />
        </td>
      </tr>
    );
  const toggle = (symbol: string) => () => setExpanded(expanded === symbol ? null : symbol);
  const symbolCell = (symbol: string) => <td className="!text-left text-[var(--text)] font-bold underline decoration-1">{symbol}</td>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th></th>
          <th className="!text-left">Sym</th>
          <th>EPS est</th>
          <th>Rev est</th>
        </tr>
      </thead>
      <tbody>
        {groups.upcoming.map((g) => (
          <Fragment key={g.label}>
            {header(g.label)}
            {g.rows.map((e) => (
              <Fragment key={e.symbol}>
                <tr onClick={toggle(e.symbol)} className="cursor-pointer" title="Click for earnings history">
                  <td className="!text-left whitespace-nowrap">{fmtDay(e.nextEarningsDate!)}</td>
                  <td className="dim whitespace-nowrap">{inDays(e.days)}</td>
                  {symbolCell(e.symbol)}
                  <td title="EPS estimate">{money(e.epsForecast)}</td>
                  <td className="dim" title="Revenue estimate">{e.revenueForecast != null ? `$${fmtBig(e.revenueForecast)}` : "—"}</td>
                </tr>
                {detail(e.symbol)}
              </Fragment>
            ))}
          </Fragment>
        ))}
        {groups.reported.length > 0 && header("Reported (last 7 days)")}
        {groups.reported.map((e) => {
          const cls = pctClass(e.lastSurprisePercent);
          return (
            <Fragment key={`r-${e.symbol}`}>
              <tr onClick={toggle(e.symbol)} className="cursor-pointer" title="Click for earnings history">
                <td className="!text-left whitespace-nowrap dim">{fmtDay(e.lastEarningsDate!)}</td>
                <td className="dim whitespace-nowrap">{-e.days}d ago</td>
                {symbolCell(e.symbol)}
                <td className={cls} title="EPS actual vs estimate">
                  {money(e.lastEps)} <span className="dim">vs {money(e.lastEpsEstimate)}</span>
                </td>
                <td className={cls} title="Surprise">{e.lastSurprisePercent != null ? `${fmt(e.lastSurprisePercent, 1)}%` : "—"}</td>
              </tr>
              {detail(e.symbol)}
            </Fragment>
          );
        })}
        {groups.noDate.length > 0 && header("No date", true)}
        {groups.noDate.map((e) => (
          <Fragment key={`n-${e.symbol}`}>
            <tr onClick={toggle(e.symbol)} className="cursor-pointer dim" title="Click for earnings history">
              <td className="!text-left">—</td>
              <td />
              {symbolCell(e.symbol)}
              <td />
              <td />
            </tr>
            {detail(e.symbol)}
          </Fragment>
        ))}
        {data.length === 0 && (
          <tr>
            <td colSpan={5} className="dim p-3">
              No upcoming earnings data for your watchlist.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default function CalendarWidget() {
  const [tab, setTab] = useState<"econ" | "earnings">("econ");

  return (
    <div>
      <div className="flex gap-1 p-1">
        <button className={`term-btn ${tab === "econ" ? "active" : ""}`} onClick={() => setTab("econ")}>
          ECONOMIC
        </button>
        <button className={`term-btn ${tab === "earnings" ? "active" : ""}`} onClick={() => setTab("earnings")}>
          EARNINGS
        </button>
      </div>
      {tab === "econ" ? <EconomicTab /> : <EarningsTab />}
    </div>
  );
}
