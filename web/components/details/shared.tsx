"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiGet, fmt, fmtBig } from "../../lib/api";
import ErrorNote from "../ErrorNote";
import Chip from "../ui/Chip";

type Envelope<T> = { dataset: string; source: string; asOf: string; data: T };

const HOUR = 3_600_000;

/** A /api/research/:symbol/:dataset call, unwrapped from its envelope. */
export function useResearch<T>(symbol: string, dataset: string, query = "") {
  return useQuery({
    queryKey: ["details", symbol, dataset, query],
    queryFn: async () => (await apiGet<Envelope<T>>(`/api/research/${encodeURIComponent(symbol)}/${dataset}${query}`)).data,
    staleTime: HOUR / 4,
    retry: 0,
  });
}

/** Any other GET, as sent. */
export function useGet<T>(key: string, path: string) {
  return useQuery({ queryKey: ["details", key, path], queryFn: () => apiGet<T>(path), staleTime: HOUR / 4, retry: 0 });
}

/** Loading, error and no-data states for one query; `children` runs only with data that passed `isEmpty`. */
export function Async<T>({
  q, what, symbol, isEmpty, empty, children,
}: {
  q: UseQueryResult<T>;
  what: string;
  symbol: string;
  isEmpty?: (d: T) => boolean;
  /** Replaces the default "No {what} for {symbol}." */
  empty?: string;
  children: (d: NonNullable<T>) => ReactNode;
}) {
  if (q.error) return <ErrorNote error={q.error} />;
  if (q.isLoading) return <div className="dim">Loading {what} for {symbol}…</div>;
  const d = q.data;
  const none = d === undefined || d === null || (Array.isArray(d) && d.length === 0) || (isEmpty?.(d) ?? false);
  if (none) return <Message>{empty ?? `No ${what} for ${symbol}.`}</Message>;
  return <>{children(d as NonNullable<T>)}</>;
}

export function Message({ children }: { children: ReactNode }) {
  return <div className="msg">{children}</div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="dim text-[11px]">{children}</div>;
}

export function StatGrid({ items }: { items: Array<{ k: string; v: ReactNode; cls?: string }> }) {
  return (
    <div className="grid gap-x-[18px] text-[11px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
      {items.map((s) => (
        <div key={s.k} className="flex justify-between gap-3 py-[2px] border-b border-[#161616]">
          <span className="dim">{s.k}</span>
          <span className={`text-right ${s.cls ?? ""}`}>{s.v ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}

export type Column<R> = { label: string; left?: boolean; cls?: (r: R) => string; cell: (r: R) => ReactNode };

/** Table that scrolls inside its pane. */
export function DataTable<R>({ columns, rows, minWidth = 520, rowKey }: { columns: Array<Column<R>>; rows: R[]; minWidth?: number; rowKey?: (r: R, i: number) => string }) {
  const align = (left?: boolean) => (left ? "text-left" : "text-right");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]" style={{ minWidth }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={`${align(c.left)} px-1.5 py-1 font-normal text-[10px] uppercase text-[var(--text-dim)] whitespace-nowrap border-b border-[#262626]`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : i}>
              {columns.map((c) => (
                <td key={c.label} className={`${align(c.left)} px-1.5 py-[3px] border-b border-[#161616] ${c.left ? "" : "whitespace-nowrap"} ${c.cls?.(r) ?? ""}`}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Bars({ items }: { items: Array<{ label: string; value: number; text: string; color: string }> }) {
  const max = Math.max(...items.map((b) => Math.abs(b.value)), 0);
  return (
    <div className="flex flex-col gap-1 max-w-[640px]">
      {items.map((b) => (
        <div key={b.label} className="grid items-center gap-2 text-[11px]" style={{ gridTemplateColumns: "96px minmax(0, 1fr) 110px" }}>
          <span className="dim">{b.label}</span>
          <span className="h-2 bg-[#1b1b1b] rounded overflow-hidden">
            <span className="block h-2 rounded" style={{ width: `${max ? (Math.abs(b.value) / max) * 100 : 0}%`, background: b.color }} />
          </span>
          <span className="text-right">{b.text}</span>
        </div>
      ))}
    </div>
  );
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-21", "2026-10-21 08:00:00" or an ISO stamp as "Oct 21, 2026"; anything else as sent. */
export function dstr(s: string | null | undefined): string {
  const m = typeof s === "string" ? /^(\d{4})-(\d\d)-(\d\d)/.exec(s) : null;
  return m ? `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}` : s || "—";
}

/** A dollar amount in T/B/M, negatives with a minus sign. */
export function money(n: number | null | undefined): string {
  return typeof n === "number" && isFinite(n) ? `${n < 0 ? "-" : ""}$${fmtBig(Math.abs(n))}` : "—";
}

export const num2 = (n: number | null | undefined) => fmt(n);
export const count = (n: number | null | undefined) => (typeof n === "number" && isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
export const signed = (n: number | null | undefined, d = 2) => (typeof n === "number" && isFinite(n) ? `${n > 0 ? "+" : ""}${fmt(n, d)}%` : "—");
export const signCls = (n: number | null | undefined) => (typeof n !== "number" || n === 0 ? "dim" : n > 0 ? "up" : "down");

/** Only http(s) links are rendered as links. */
export function safeHref(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  const h = safeHref(href);
  return h ? <a href={h} target="_blank" rel="noopener noreferrer" className="hover:text-[var(--amber)] hover:underline">{children}</a> : <>{children}</>;
}

/** Sub-section chips under a details tab. */
export function SubTabs({ tabs, value, onChange, ariaLabel }: { tabs: Array<{ id: string; label: string }>; value: string; onChange: (id: string) => void; ariaLabel: string }) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1">
      {tabs.map((t) => <Chip key={t.id} on={t.id === value} onClick={() => onChange(t.id)}>{t.label}</Chip>)}
    </div>
  );
}
