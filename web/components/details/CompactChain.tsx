"use client";

import { Fragment, useMemo } from "react";
import { ApiError, fmt } from "../../lib/api";
import { chainStats, daysLeft, joinStrikes, nearestStrikes, spotRowIndex, todayET } from "../../lib/chain";
import { useTerminal } from "../../store/terminal";
import { delta, expiryLabel, px, vol } from "./chainFormat";
import { useChain } from "./useChain";

const th = "px-1.5 py-1 text-right font-normal text-[10px] uppercase text-[var(--text-dim)] whitespace-nowrap border-b border-[#262626]";
const td = "px-1.5 py-[3px] text-right whitespace-nowrap border-b border-[#161616]";

/** Nearest expiry after today, the 10 strikes closest to spot, and a button that opens the full chain. */
export default function CompactChain({ symbol }: { symbol: string }) {
  const openOrFocus = useTerminal((s) => s.openOrFocus);
  const { data, error, isLoading } = useChain(symbol);
  const rows = useMemo(() => (data ? nearestStrikes(joinStrikes(data.calls, data.puts), data.underlyingPrice, 10) : []), [data]);
  const stats = useMemo(() => (data ? chainStats(joinStrikes(data.calls, data.puts), data.underlyingPrice) : null), [data]);

  if (error) {
    const msg = (error as Error).message;
    if (error instanceof ApiError && error.status === 503) return <div className="msg">{msg}</div>;
    return <div className="down">Option chain unavailable for {symbol}: {msg}</div>;
  }
  if (isLoading || !data) return <div className="dim">Loading option chain for {symbol}…</div>;
  if (data.expirationDates.length === 0 || rows.length === 0) return <div className="msg">No listed options for {symbol}.</div>;

  const spot = data.underlyingPrice;
  const selected = data.selectedDate ?? data.expirationDates[0];
  const days = daysLeft(selected, todayET());
  const at = spotRowIndex(rows, spot);
  const spotRow = (
    <tr data-testid="spot-row">
      <td colSpan={9} className="!text-center px-1.5 py-[3px] text-[11px] font-bold amber bg-[#1a1408] border-y border-[#7a5418]">▲ {symbol} {fmt(spot)}</td>
    </tr>
  );
  const statList: Array<[string, string]> = [
    ["Expiry", `${expiryLabel(selected)} · ${days}d`],
    ["Spot", fmt(spot)],
    ["Implied move", stats?.straddle == null ? "—" : `±$${fmt(stats.straddle)} (±${fmt((stats.impliedMove ?? 0) * 100, 1)}%)`],
    ["ATM IV", stats?.atmIv == null ? "—" : `${fmt(stats.atmIv * 100, 0)}%`],
    ["Put/call volume", stats?.putCallRatio == null ? "—" : fmt(stats.putCallRatio)],
    ["Call volume", fmt(stats?.callVolume, 0)],
  ];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid gap-x-[18px] text-[11px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
        {statList.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 py-[2px] border-b border-[#161616]">
            <span className="dim">{k}</span>
            <span className="text-right">{v}</span>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] border-collapse text-[11px]">
          <thead>
            <tr>
              {["Call Δ", "Volume", "Bid", "Ask"].map((h) => <th key={`c${h}`} className={th}>{h}</th>)}
              <th className={`${th} !text-center`}>Strike</th>
              {["Bid", "Ask", "Volume", "Put Δ"].map((h) => <th key={`p${h}`} className={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={r.strike}>
                {i === at && spotRow}
                <tr>
                  <td className={td}>{delta(r.call)}</td>
                  <td className={td}>{vol(r.call?.volume)}</td>
                  <td className={td}>{px(r.call?.bid)}</td>
                  <td className={td}>{px(r.call?.ask)}</td>
                  <td className={`${td} !text-center font-bold amber bg-[#0f0f0f]`}>{fmt(r.strike)}</td>
                  <td className={td}>{px(r.put?.bid)}</td>
                  <td className={td}>{px(r.put?.ask)}</td>
                  <td className={td}>{vol(r.put?.volume)}</td>
                  <td className={td}>{delta(r.put)}</td>
                </tr>
              </Fragment>
            ))}
            {at === rows.length && spotRow}
          </tbody>
        </table>
      </div>
      <div className="dim text-[11px]">Nearest expiry, the 10 strikes closest to the price.</div>
      <div>
        <button className="chip on" onClick={() => openOrFocus("options", "window")}>Open full chain</button>
      </div>
    </div>
  );
}
