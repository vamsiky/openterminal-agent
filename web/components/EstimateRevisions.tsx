"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, fmtBig, fmtPct, pctClass } from "../lib/api";

type Change = { eps: number | null; revenue: number | null };
export type EstimateRevisionsData = {
  symbol: string;
  next: { reportDate: string; eps: number | null; revenue: number | null } | null;
  history: Array<{ day: string; eps: number | null; revenue: number | null }>;
  revisions: Record<"7d" | "30d" | "60d" | "90d", Change>;
};

const WINDOWS = ["7d", "30d", "60d", "90d"] as const;

/** One line of consensus-estimate revisions for the symbol's next report; renders nothing when the API has no data or errors. */
export default function EstimateRevisions({ symbol, className = "" }: { symbol: string; className?: string }) {
  const { data } = useQuery({
    queryKey: ["estimates", symbol],
    queryFn: () => apiGet<EstimateRevisionsData>(`/api/estimates/${encodeURIComponent(symbol)}`),
    refetchInterval: 3_600_000,
    retry: false,
  });
  if (!data?.next || data.next.eps === null) return null;

  const shown = WINDOWS.filter((w) => data.revisions[w].eps !== null);
  const since = data.history[0]?.day;
  const title = [
    `Next report ${data.next.reportDate}${data.next.revenue !== null ? ` · revenue est ${fmtBig(data.next.revenue)}` : ""}`,
    ...data.history.map((p) => `${p.day}: EPS ${fmt(p.eps)}${p.revenue !== null ? ` · rev ${fmtBig(p.revenue)}` : ""}`),
  ].join("\n");

  return (
    <span className={`text-[11px] ${className}`} title={title}>
      <span className="dim">EPS est</span> <span className="font-bold">{fmt(data.next.eps)}</span>
      {shown.map((w) => (
        <span key={w}>
          {" · "}
          <span className="dim">{w}</span> <span className={pctClass(data.revisions[w].eps)}>{fmtPct(data.revisions[w].eps)}</span>
        </span>
      ))}
      {data.revisions["30d"].eps === null && since && <span className="dim"> · tracking since {since}</span>}
    </span>
  );
}
