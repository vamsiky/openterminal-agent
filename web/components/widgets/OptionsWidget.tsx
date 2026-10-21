"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, fmt, fmtBig, fmtIv } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

type OptionRow = {
  strike: number | null; lastPrice: number | null; bid: number | null; ask: number | null;
  volume: number | null; openInterest: number | null; impliedVolatility?: number | null; inTheMoney: boolean;
  delta?: number | null; gamma?: number | null; theta?: number | null; vega?: number | null; rho?: number | null;
};
type Chain = {
  symbol: string; underlyingPrice: number | null; expirationDates: string[];
  selectedDate: string | null; calls: OptionRow[]; puts: OptionRow[];
};

function greeksTitle(r: OptionRow | undefined): string | undefined {
  if (!r || r.delta == null) return undefined;
  return `Δ ${fmt(r.delta, 3)} · Γ ${fmt(r.gamma, 4)} · Θ ${fmt(r.theta, 3)} · V ${fmt(r.vega, 3)} · ρ ${fmt(r.rho, 3)}`;
}

/** One side of a strike row. Open interest is currently always null (Alpaca's data host doesn't carry it). */
function SideCells({ row, itm }: { row: OptionRow | undefined; itm: string }) {
  const cls = row?.inTheMoney ? itm : "";
  return (
    <>
      <td className={cls}>{fmt(row?.lastPrice)}</td>
      <td className={cls}>{fmt(row?.bid)}</td>
      <td className={cls}>{fmt(row?.ask)}</td>
      <td className={cls}>{fmtBig(row?.volume)}</td>
      <td className={cls}>{fmtBig(row?.openInterest)}</td>
      <td className={cls}>{fmtIv(row?.impliedVolatility)}</td>
      <td className={cls} title={greeksTitle(row)}>{fmt(row?.delta)}</td>
    </>
  );
}

export default function OptionsWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [expiry, setExpiry] = useState<string | undefined>();

  const { data, error, isLoading } = useQuery({
    queryKey: ["options", symbol, expiry],
    queryFn: () => apiGet<Chain>(`/api/options/${encodeURIComponent(symbol)}${expiry ? `?expiry=${encodeURIComponent(expiry)}` : ""}`),
    refetchInterval: 20_000,
    retry: 0,
  });

  if (error) {
    // 503 (no Alpaca keys) carries its own explanation; show it as-is.
    const msg = (error as Error).message;
    if (error instanceof ApiError && error.status === 503) return <div className="p-2 dim">{msg}</div>;
    return (
      <div className="p-2">
        <div className="down">Option chain unavailable for {symbol}</div>
        <div className="dim">{msg}</div>
      </div>
    );
  }
  if (isLoading || !data) return <div className="p-2 dim">Loading option chain…</div>;

  const byStrike = new Map<number, { call?: OptionRow; put?: OptionRow }>();
  for (const c of data.calls) if (c.strike !== null) byStrike.set(c.strike, { ...byStrike.get(c.strike), call: c });
  for (const p of data.puts) if (p.strike !== null) byStrike.set(p.strike, { ...byStrike.get(p.strike), put: p });
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);

  return (
    <div>
      <div className="flex gap-2 items-center p-1">
        <span className="dim">Underlying</span>
        <span className="amber font-bold">{fmt(data.underlyingPrice)}</span>
        <span className="dim ml-2">Expiry</span>
        <select
          value={expiry ?? data.selectedDate ?? ""}
          onChange={(e) => setExpiry(e.target.value)}
        >
          {data.expirationDates.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th colSpan={7} className="!text-center up">CALLS</th>
            <th className="!text-center">STRIKE</th>
            <th colSpan={7} className="!text-center down">PUTS</th>
          </tr>
          <tr>
            <th>Last</th><th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>IV</th><th title="Delta">Δ</th>
            <th></th>
            <th>Last</th><th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th><th>IV</th><th title="Delta">Δ</th>
          </tr>
        </thead>
        <tbody>
          {strikes.map((strike) => {
            const { call, put } = byStrike.get(strike)!;
            return (
              <tr key={strike}>
                <SideCells row={call} itm="bg-[#0d2010]" />
                <td className="!text-center font-bold amber">{fmt(strike)}</td>
                <SideCells row={put} itm="bg-[#200d0d]" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
