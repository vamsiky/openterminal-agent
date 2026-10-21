"use client";

import { EXTENDED_SESSIONS, fmt, fmtChange, fmtPct, pctClass, type Quote, type SessionPrice } from "../lib/api";
import Flash from "./Flash";

function sessionTitle(label: string, s: SessionPrice): string {
  const at = new Date(s.time).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return `${label}: ${fmt(s.price)} ${fmtChange(s.change, s.changePercent)} vs the last regular close · ${s.live ? "live" : `last trade ${at}`}`;
}

/** Regular-session price with its dollar and percent change from the previous close. */
export function RegularPrice({ quote, size = "text-xl" }: { quote: Quote; size?: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <Flash value={quote.price} className={`${size} font-bold`}>{fmt(quote.price)}</Flash>
      <Flash value={quote.change} className={`${pctClass(quote.change)} text-sm`}>
        {fmtChange(quote.change, quote.changePercent)}
      </Flash>
    </span>
  );
}

/** After hours, overnight and pre-market since the last regular close; sessions with no trades are left out. */
export function ExtendedPrices({ quote, className = "" }: { quote: Quote; className?: string }) {
  const rows = EXTENDED_SESSIONS.flatMap(({ key, label }) => {
    const s = quote.extended?.[key];
    return s ? [{ key, label, s }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] ${className}`}>
      {rows.map(({ key, label, s }) => (
        <span key={key} className="flex items-baseline gap-1.5" title={sessionTitle(label, s)}>
          <span className="dim">{label}</span>
          {s.live && <span className="up text-[8px]">●</span>}
          <Flash value={s.price} className="font-bold">{fmt(s.price)}</Flash>
          <span className={pctClass(s.change)}>{fmtChange(s.change, s.changePercent)}</span>
        </span>
      ))}
    </div>
  );
}

/** One watchlist cell: the session's price and percent change, or a dash. */
export function SessionCell({ quote, session, label }: { quote: Quote | undefined; session: keyof NonNullable<Quote["extended"]>; label: string }) {
  const s = quote?.extended?.[session];
  if (!s) return <td className="dim">—</td>;
  return (
    <td title={sessionTitle(label, s)}>
      <Flash value={s.price}>{fmt(s.price)}</Flash>{" "}
      <span className={pctClass(s.changePercent)}>{fmtPct(s.changePercent)}</span>
    </td>
  );
}
