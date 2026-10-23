"use client";

import { useState } from "react";
import { fmt, fmtBig } from "../../lib/api";
import { CODE_LABEL, roleOf, sideCls, type InsiderTx } from "./FilingsTab";
import { Async, DataTable, Message, StatGrid, count, dstr, useGet, useResearch, type Column, SubTabs } from "./shared";

type Profile = {
  profile?: {
    companyName?: string; sector?: string; industry?: string; ceo?: string; fullTimeEmployees?: string | number | null; ipoDate?: string; city?: string; state?: string;
    country?: string; beta?: number | null; description?: string; lastDividend?: number | null; price?: number | null; website?: string;
  } | null;
  executives?: Array<{ title: string; name: string; pay?: unknown; currencyPay?: string; active?: boolean; titleSince?: unknown }>;
};

const CORP = [
  { id: "div", label: "Dividends" },
  { id: "splits", label: "Splits" },
  { id: "insider", label: "Insider activity" },
];
const BRIEF = [
  { id: "profile", label: "Profile" },
  { id: "execs", label: "Key executives" },
];

const noProfile = (d: Profile) => !d.profile;

function Dividends({ symbol }: { symbol: string }) {
  const q = useResearch<Profile>(symbol, "profile");
  return (
    <Async q={q} what="company profile" symbol={symbol} isEmpty={noProfile}>
      {(d) => {
        const div = d.profile?.lastDividend ?? 0;
        const price = d.profile?.price ?? null;
        if (!(div > 0)) return <Message>{symbol} doesn’t pay a dividend.</Message>;
        return (
          <>
            <StatGrid items={[
              { k: "Annual dividend", v: `$${fmt(div)}` },
              { k: "Yield", v: price ? `${fmt((div / price) * 100)}%` : "—" },
            ]} />
            <Message>The dividend history (ex-dates and pay dates) isn’t loaded yet.</Message>
          </>
        );
      }}
    </Async>
  );
}

function Insiders({ symbol }: { symbol: string }) {
  const q = useGet<InsiderTx[]>(`insider:${symbol}`, `/api/insider/${encodeURIComponent(symbol)}`);
  const cols: Array<Column<InsiderTx>> = [
    { label: "Date", left: true, cls: () => "dim", cell: (t) => dstr(t.transactionDate) },
    { label: "Insider", left: true, cell: (t) => t.ownerName },
    { label: "Role", left: true, cls: () => "dim", cell: roleOf },
    { label: "Type", left: true, cls: sideCls, cell: (t) => CODE_LABEL[t.transactionCode] ?? t.transactionCode },
    { label: "Shares", cell: (t) => fmtBig(t.shares) },
    { label: "Price", cls: () => "dim", cell: (t) => (t.pricePerShare ? fmt(t.pricePerShare) : "—") },
  ];
  return (
    <Async q={q} what="insider trades" symbol={symbol} empty={`No insider trades reported for ${symbol}.`}>
      {(rows) => <DataTable columns={cols} rows={rows} minWidth={600} rowKey={(t, i) => `${t.transactionDate}-${t.ownerName}-${i}`} />}
    </Async>
  );
}

export function CorporateTab({ symbol }: { symbol: string }) {
  const [sub, setSub] = useState("insider");
  return (
    <>
      <SubTabs tabs={CORP} value={sub} onChange={setSub} ariaLabel="Corporate actions sections" />
      {sub === "div" && <Dividends symbol={symbol} />}
      {sub === "splits" && <Message>Split history isn’t loaded yet. Price charts are already split-adjusted.</Message>}
      {sub === "insider" && <Insiders symbol={symbol} />}
    </>
  );
}

export function BriefTab({ symbol }: { symbol: string }) {
  const [sub, setSub] = useState("profile");
  const q = useResearch<Profile>(symbol, "profile");
  return (
    <>
      <SubTabs tabs={BRIEF} value={sub} onChange={setSub} ariaLabel="Brief sections" />
      <Async q={q} what="company profile" symbol={symbol} isEmpty={noProfile}>
        {(d) => {
          const p = d.profile!;
          if (sub === "execs") {
            const execs = (d.executives ?? []).filter((e) => e.active !== false);
            if (execs.length === 0) return <Message>No key executives listed for {symbol}.</Message>;
            const cols: Array<Column<NonNullable<Profile["executives"]>[number]>> = [
              { label: "Name", left: true, cell: (e) => e.name },
              { label: "Title", left: true, cls: () => "dim", cell: (e) => e.title },
            ];
            return <DataTable columns={cols} rows={execs} minWidth={320} rowKey={(e, i) => `${e.name}-${i}`} />;
          }
          return (
            <>
              <StatGrid items={[
                { k: "Company", v: p.companyName },
                { k: "Sector", v: p.sector },
                { k: "Industry", v: p.industry },
                { k: "CEO", v: p.ceo || "—" },
                { k: "Employees", v: p.fullTimeEmployees ? count(Number(p.fullTimeEmployees)) : "—" },
                { k: "IPO date", v: dstr(p.ipoDate) },
                { k: "Headquarters", v: [p.city, p.state, p.country].filter(Boolean).join(", ") || "—" },
                { k: "Beta", v: p.beta == null ? "—" : fmt(p.beta) },
              ]} />
              {p.description && <p className="m-0 max-w-[900px] font-sans-ui text-[13px] leading-[1.55] text-[#cfcfcf]">{p.description}</p>}
            </>
          );
        }}
      </Async>
    </>
  );
}
