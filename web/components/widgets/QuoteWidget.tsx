"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, fmt, fmtBig, sourceLabel, type Quote } from "../../lib/api";
import { useTerminal, useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import ErrorNote from "../ErrorNote";
import Chip from "../ui/Chip";
import { ExtendedPrices } from "../SessionPrices";
import Flash from "../Flash";

type ShortVolume = { date: string; shortVolume: number; shortExemptVolume: number; totalVolume: number; shortVolumePercent: number };
type Setup = { upcoming: { reportDate: string; time: string | null }; score: number; verdict: string };
type Estimates = { next: { reportDate: string } | null };

const TIME_LABEL: Record<string, string> = { bmo: "BMO", amc: "AMC", dmh: "Market hours" };

function reportDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const sign = (n: number | null | undefined) => (n != null && n > 0 ? "+" : n != null && n < 0 ? "−" : "");
const signed = (n: number | null | undefined, suffix = "") => (n == null ? "—" : `${sign(n)}${fmt(Math.abs(n))}${suffix}`);

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-[#161616] py-[3px]">
      <span className="dim">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
}

export default function QuoteWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const openOrFocus = useTerminal((s) => s.openOrFocus);
  const [more, setMore] = useState(false);
  const { data, error } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${encodeURIComponent(symbol)}`))[0],
    refetchInterval: 1_000,
  });
  // FINRA's Reg SHO file only updates once a day (next-morning), so no point polling it fast.
  const { data: shortVol } = useQuery({
    queryKey: ["short-volume", symbol],
    queryFn: () => apiGet<ShortVolume | null>(`/api/short-volume/${encodeURIComponent(symbol)}`),
    staleTime: 3_600_000,
  });
  // 404 means no upcoming report in the earnings universe; fall back to the estimates calendar for the date.
  const { data: setup, isFetched: setupDone } = useQuery({
    queryKey: ["earnings-setup", symbol],
    queryFn: () => apiGet<Setup>(`/api/earnings/setup/${encodeURIComponent(symbol)}`),
    staleTime: 300_000,
    retry: false,
  });
  const { data: est } = useQuery({
    queryKey: ["estimates", symbol],
    queryFn: () => apiGet<Estimates>(`/api/estimates/${encodeURIComponent(symbol)}`),
    enabled: setupDone && !setup,
    staleTime: 300_000,
    retry: false,
  });

  if (error) return <ErrorNote error={error} />;
  if (!data) return <div className="p-2 dim">Loading {symbol}…</div>;

  const range = data.high != null && data.low != null && data.previousClose ? ((data.high - data.low) / data.previousClose) * 100 : null;
  const stats: Array<[string, string]> = [
    ["Open", fmt(data.open)],
    ["Prev close", fmt(data.previousClose)],
    ["High", fmt(data.high)],
    ["Low", fmt(data.low)],
    ["Volume", fmtBig(data.volume)],
    ["Avg vol 3M", fmtBig(data.avgVolume)],
    ["% Range", range == null ? "—" : fmt(range) + "%"],
    ["Mkt cap", fmtBig(data.marketCap)],
    ["52W high", fmt(data.week52High)],
    ["52W low", fmt(data.week52Low)],
    ["P/E (TTM)", fmt(data.pe)],
    ["EPS (TTM)", fmt(data.eps)],
  ];
  const moreStats: Array<[string, string]> = [
    ["Bid", fmt(data.bid)],
    ["Ask", fmt(data.ask)],
    ["Beta", fmt(data.beta)],
    ["Div yield", data.dividendYield != null ? fmt(data.dividendYield * 100) + "%" : "—"],
    ["Shares out", fmtBig(data.sharesOutstanding)],
    ...(shortVol ? ([["Short vol %", fmt(shortVol.shortVolumePercent, 1) + "%"]] as Array<[string, string]>) : []),
  ];

  const reportDate = setup?.upcoming.reportDate ?? est?.next?.reportDate ?? null;
  const reportTime = setup?.upcoming.time ? TIME_LABEL[setup.upcoming.time] : null;
  const nextReport = reportDate ? `${reportDay(reportDate)}${reportTime ? ` · ${reportTime}` : ""}` : setupDone ? "—" : "…";
  const setupText = setup ? `${setup.verdict} · ${setup.score}` : setupDone ? "—" : "…";

  return (
    <div className="p-3 flex flex-col gap-2 text-[11px]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-bold text-xs">{data.symbol}</span>
        <span className="dim">{[data.exchange, data.name].filter(Boolean).join(" · ")}</span>
        <span className="dim text-[10px] ml-auto"><Freshness quote={data} /></span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <Flash value={data.price} className={`${data.change != null && data.change < 0 ? "down" : "up"} text-[30px] font-bold tracking-tight`}>{fmt(data.price)}</Flash>
        <span className={`${data.change != null && data.change < 0 ? "down" : "up"} flex flex-col text-xs`}>
          <span>{signed(data.change)}</span>
          <span>{signed(data.changePercent, "%")}</span>
        </span>
      </div>
      <ExtendedPrices quote={data} className="flex-col" />
      <div className="grid grid-cols-2 gap-x-4">
        {stats.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        {more && moreStats.map(([k, v]) => <Row key={k} k={k} v={v} />)}
      </div>
      <Chip className="self-center" onClick={() => setMore((m) => !m)}>{more ? "Fewer statistics" : "More statistics"}</Chip>
      <button
        className="flex flex-wrap justify-between gap-x-4 gap-y-1 border border-[#262626] bg-[#0d0d0d] p-2 text-left hover:border-[#4a3a20] cursor-pointer"
        onClick={() => openOrFocus("research", "tab")}
        title="Open Research & reports"
      >
        <span className="flex gap-2 whitespace-nowrap"><span className="dim">Next report</span><span className="amber">{nextReport}</span></span>
        <span className="flex gap-2 whitespace-nowrap"><span className="dim">Earnings setup</span><span>{setupText}</span></span>
      </button>
    </div>
  );
}

/** Where the price came from: live from Alpaca, Alpaca's last trade time, or another source (FMP, Stooq, FRED, ECB). */
export function Freshness({ quote }: { quote: Quote }) {
  if (quote.source !== "alpaca") return <span title="delayed or daily data, cached briefly">{sourceLabel(quote.source)}</span>;
  if (quote.live) return <span className="up" title="every trade from Alpaca's live stream">● Live</span>;
  const at = quote.asOf ? new Date(quote.asOf).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "—";
  return <span style={{ color: "var(--amber)" }} title="regular-session price as of this time; extended hours are listed separately">● As of {at}</span>;
}
