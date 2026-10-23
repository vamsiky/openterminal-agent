"use client";

import { Fragment, useMemo, useState } from "react";
import { ApiError, fmt } from "../../lib/api";
import {
  BANDS, chainStats, daysLeft, isItm, joinStrikes, mid, spotRowIndex, strikeBand, todayET, type Side, type StrikeRow,
} from "../../lib/chain";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import { delta, expiryLabel, greeksTitle, iv, px, vol } from "../details/chainFormat";
import { useChain } from "../details/useChain";
import Segmented from "../ui/Segmented";

const SIDES = [
  { id: "both", label: "Calls & puts" },
  { id: "calls", label: "Calls" },
  { id: "puts", label: "Puts" },
];
const RANGES = BANDS.map((b) => ({ id: String(b), label: `±${b * 100}%` }));

const ITM_CALL = "bg-[#0d2010]";
const ITM_PUT = "bg-[#200d0d]";
const th = "px-1.5 py-1 text-right font-normal text-[10px] uppercase text-[var(--text-dim)] whitespace-nowrap border-b border-[#262626]";
const td = "px-1.5 py-[3px] text-right whitespace-nowrap border-b border-[#161616]";
const strikeCls = `${td} !text-center font-bold amber bg-[#0f0f0f]`;

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-[2px] border-b border-[#161616]">
      <span className="dim">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}

function SpotRow({ symbol, spot, cols }: { symbol: string; spot: number | null; cols: number }) {
  return (
    <tr data-testid="spot-row">
      <td colSpan={cols} className="!text-center px-1.5 py-[3px] text-[11px] font-bold amber bg-[#1a1408] border-y border-[#7a5418]">
        ▲ {symbol} {fmt(spot)}
      </td>
    </tr>
  );
}

function BothSides({ rows, spot, symbol }: { rows: StrikeRow[]; spot: number | null; symbol: string }) {
  const at = spotRowIndex(rows, spot);
  return (
    <table className="w-full min-w-[720px] border-collapse text-[11px]">
      <thead>
        <tr>
          <th colSpan={6} className={`${th} !text-center up`}>Calls</th>
          <th className={th}></th>
          <th colSpan={6} className={`${th} !text-center down`}>Puts</th>
        </tr>
        <tr>
          {["Δ", "IV", "Volume", "Last", "Bid", "Ask"].map((h) => <th key={`c${h}`} className={th}>{h}</th>)}
          <th className={`${th} !text-center`}>Strike</th>
          {["Bid", "Ask", "Last", "Volume", "IV", "Δ"].map((h) => <th key={`p${h}`} className={th}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const cc = spot !== null && isItm("call", r.strike, spot) ? ITM_CALL : "";
          const pc = spot !== null && isItm("put", r.strike, spot) ? ITM_PUT : "";
          return (
            <Fragment key={r.strike}>
              {i === at && <SpotRow symbol={symbol} spot={spot} cols={13} />}
              <tr>
                <td className={`${td} ${cc}`} title={greeksTitle(r.call)}>{delta(r.call)}</td>
                <td className={`${td} ${cc} dim`}>{iv(r.call)}</td>
                <td className={`${td} ${cc}`}>{vol(r.call?.volume)}</td>
                <td className={`${td} ${cc}`}>{px(r.call?.lastPrice)}</td>
                <td className={`${td} ${cc}`}>{px(r.call?.bid)}</td>
                <td className={`${td} ${cc}`}>{px(r.call?.ask)}</td>
                <td className={strikeCls}>{fmt(r.strike)}</td>
                <td className={`${td} ${pc}`}>{px(r.put?.bid)}</td>
                <td className={`${td} ${pc}`}>{px(r.put?.ask)}</td>
                <td className={`${td} ${pc}`}>{px(r.put?.lastPrice)}</td>
                <td className={`${td} ${pc}`}>{vol(r.put?.volume)}</td>
                <td className={`${td} ${pc} dim`}>{iv(r.put)}</td>
                <td className={`${td} ${pc}`} title={greeksTitle(r.put)}>{delta(r.put)}</td>
              </tr>
            </Fragment>
          );
        })}
        {at === rows.length && <SpotRow symbol={symbol} spot={spot} cols={13} />}
      </tbody>
    </table>
  );
}

function OneSide({ rows, spot, symbol, side }: { rows: StrikeRow[]; spot: number | null; symbol: string; side: "calls" | "puts" }) {
  const at = spotRowIndex(rows, spot);
  const kind = side === "calls" ? "call" : "put";
  return (
    <table className="w-full min-w-[560px] border-collapse text-[11px]">
      <thead>
        <tr>
          <th className={`${th} !text-center`}>Strike</th>
          {["Bid", "Ask", "Mid", "Last", "Volume", "IV", "Δ", "Θ / day"].map((h) => <th key={h} className={th}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const o = side === "calls" ? r.call : r.put;
          const shade = spot !== null && isItm(kind, r.strike, spot) ? (side === "calls" ? ITM_CALL : ITM_PUT) : "";
          const m = mid(o);
          return (
            <Fragment key={r.strike}>
              {i === at && <SpotRow symbol={symbol} spot={spot} cols={9} />}
              <tr>
                <td className={strikeCls}>{fmt(r.strike)}</td>
                <td className={`${td} ${shade}`}>{px(o?.bid)}</td>
                <td className={`${td} ${shade}`}>{px(o?.ask)}</td>
                <td className={`${td} ${shade}`}>{px(m)}</td>
                <td className={`${td} ${shade}`}>{px(o?.lastPrice)}</td>
                <td className={`${td} ${shade}`}>{vol(o?.volume)}</td>
                <td className={`${td} ${shade} dim`}>{iv(o)}</td>
                <td className={`${td} ${shade}`} title={greeksTitle(o)}>{delta(o)}</td>
                <td className={`${td} ${shade}`}>{o?.theta == null ? "—" : fmt(o.theta)}</td>
              </tr>
            </Fragment>
          );
        })}
        {at === rows.length && <SpotRow symbol={symbol} spot={spot} cols={9} />}
      </tbody>
    </table>
  );
}

const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false }).format(ms);

export default function OptionsWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [expiry, setExpiry] = useState<string | undefined>();
  const [band, setBand] = useState<string>(String(BANDS[0]));
  const [side, setSide] = useState<Side>("both");
  const { data, error, isLoading, dataUpdatedAt } = useChain(symbol, expiry);

  const all = useMemo(() => (data ? joinStrikes(data.calls, data.puts) : []), [data]);
  const spot = data?.underlyingPrice ?? null;
  const rows = useMemo(() => strikeBand(all, spot, Number(band)), [all, spot, band]);
  const stats = useMemo(() => chainStats(all, spot), [all, spot]);

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
  if (data.expirationDates.length === 0) return <div className="p-2"><div className="msg">No listed options for {symbol}.</div></div>;

  const selected = data.selectedDate ?? data.expirationDates[0];
  const today = todayET();
  const days = daysLeft(selected, today);
  const pct = (v: number | null) => (v === null ? "—" : `${fmt(v * 100, 1)}%`);
  const statList: Array<[string, string]> = [
    ["Spot", fmt(spot)],
    ["Expiry", `${expiryLabel(selected)} · ${days} ${days === 1 ? "day" : "days"}`],
    ["ATM strike", stats.atm === null ? "—" : fmt(stats.atm)],
    ["ATM straddle", stats.straddle === null ? "—" : `$${fmt(stats.straddle)}`],
    ["Implied move", stats.straddle === null ? "—" : `±$${fmt(stats.straddle)} (±${pct(stats.impliedMove)})`],
    ["ATM IV", stats.atmIv === null ? "—" : `${fmt(stats.atmIv * 100, 0)}%`],
    ["Call volume", fmt(stats.callVolume, 0)],
    ["Put volume", fmt(stats.putVolume, 0)],
    ["Put/call volume", stats.putCallRatio === null ? "—" : fmt(stats.putCallRatio)],
  ];

  return (
    <div className="flex flex-col gap-2.5 px-2.5 py-2 font-sans-ui">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="amber font-bold">{symbol}</span>
        <span className="dim text-[11px]">option chain</span>
        <span className="inline-flex items-center gap-1 text-[10px] font-bold up" title="Refreshes every 15 seconds">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--up)]" />LIVE
        </span>
        <span className="dim text-[11px]">{dataUpdatedAt ? `Updated ${clock(dataUpdatedAt)} ET` : ""}</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="dim text-[10px] w-[52px] shrink-0">EXPIRY</span>
        <div className="overflow-x-auto min-w-0" data-testid="expiry-scroll">
          <Segmented
            ariaLabel="Expiry"
            value={selected}
            onChange={setExpiry}
            options={data.expirationDates.map((d) => ({ id: d, label: `${expiryLabel(d)} · ${daysLeft(d, today)}d` }))}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="dim text-[10px] w-[52px] shrink-0">STRIKES</span>
        <Segmented ariaLabel="Strike range" value={band} onChange={setBand} options={RANGES} />
        <span className="dim text-[10px] ml-2">SHOW</span>
        <Segmented ariaLabel="Calls or puts" value={side} onChange={(s) => setSide(s as Side)} options={SIDES} />
      </div>

      <div className="grid gap-x-[18px] text-[11px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {statList.map(([k, v]) => <Stat key={k} k={k} v={v} />)}
      </div>

      {rows.length === 0 ? (
        <div className="msg">No strikes within this range for {expiryLabel(selected)}.</div>
      ) : (
        <div className="overflow-x-auto">
          {side === "both" ? <BothSides rows={rows} spot={spot} symbol={symbol} /> : <OneSide rows={rows} spot={spot} symbol={symbol} side={side} />}
        </div>
      )}
      <div className="dim text-[11px] leading-normal max-w-[760px]">
        {data.expirationDates.length} expiries are listed for {symbol}. Open interest isn’t in Alpaca’s feed, so it isn’t shown.
      </div>
    </div>
  );
}
