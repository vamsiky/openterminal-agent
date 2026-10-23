"use client";

import { useState } from "react";
import { fmt } from "../../lib/api";
import { Async, Bars, DataTable, ExtLink, Message, Note, StatGrid, count, dstr, money, signCls, signed, useGet, useResearch, type Column, SubTabs } from "./shared";

const SUBS = [
  { id: "analysts", label: "Analysts" },
  { id: "short", label: "Short selling" },
  { id: "inst", label: "Institutions" },
  { id: "flow", label: "Order flow" },
  { id: "etf", label: "ETF weighting" },
];

type Analysts = {
  priceTargetConsensus?: { targetHigh: number | null; targetLow: number | null; targetConsensus: number | null; targetMedian: number | null } | null;
  priceTargets?: Array<{ publishedDate: string; analystCompany: string | null; newsTitle: string; newsURL: string | null; priceTarget: number | null; priceWhenPosted: number | null }>;
  gradesConsensus?: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number; consensus: string } | null;
};
type Short = { date: string; shortVolume: number; totalVolume: number; shortVolumePercent: number };
type Holder = { investorName: string; sharesNumber: number | null; ownership: number | null; changeInSharesNumberPercentage: number | null; marketValue: number | null };
type Institutional = {
  year: number; quarter: number;
  summary?: {
    date: string; investorsHolding: number; investorsHoldingChange: number; ownershipPercent: number; ownershipPercentChange: number; numberOf13Fshares: number;
    newPositions: number; increasedPositions: number; reducedPositions: number; closedPositions: number; putCallRatio: number | null;
  } | null;
  holders?: Holder[];
};
type EtfWeight = { symbol: string; weightPercentage: number | null; marketValue: number | null };

function AnalystsView({ symbol }: { symbol: string }) {
  const q = useResearch<Analysts>(symbol, "analysts");
  const price = useGet<Array<{ price: number | null }>>(`quote:${symbol}`, `/api/quotes?symbols=${encodeURIComponent(symbol)}`);
  return (
    <Async q={q} what="analyst coverage" symbol={symbol} isEmpty={(d) => !d.gradesConsensus && !d.priceTargetConsensus && !d.priceTargets?.length}>
      {(d) => {
        const c = d.gradesConsensus, pt = d.priceTargetConsensus;
        const total = c ? c.strongBuy + c.buy + c.hold + c.sell + c.strongSell : 0;
        const spot = price.data?.[0]?.price ?? null;
        const upside = pt?.targetConsensus && spot ? (pt.targetConsensus / spot - 1) * 100 : null;
        const cols: Array<Column<NonNullable<Analysts["priceTargets"]>[number]>> = [
          { label: "Date", left: true, cls: () => "dim", cell: (t) => dstr(t.publishedDate) },
          { label: "Firm", left: true, cell: (t) => <ExtLink href={t.newsURL}>{t.analystCompany || t.newsTitle}</ExtLink> },
          { label: "Target", cell: (t) => fmt(t.priceTarget) },
          { label: "Price then", cls: () => "dim", cell: (t) => fmt(t.priceWhenPosted) },
        ];
        return (
          <>
            <StatGrid items={[
              { k: "Consensus", v: c ? `${c.consensus} (${total} analysts)` : "—" },
              { k: "Avg target", v: fmt(pt?.targetConsensus) },
              { k: "Upside", v: signed(upside), cls: signCls(upside) },
              { k: "Median target", v: fmt(pt?.targetMedian) },
              { k: "High target", v: fmt(pt?.targetHigh) },
              { k: "Low target", v: fmt(pt?.targetLow) },
            ]} />
            {c && total > 0 && (
              <Bars items={[
                ["Strong buy", c.strongBuy, "#22d36b"], ["Buy", c.buy, "#7bd88f"], ["Hold", c.hold, "#ffb84d"], ["Sell", c.sell, "#ff8a6b"], ["Strong sell", c.strongSell, "#ff5a5a"],
              ].map(([label, v, color]) => ({ label: label as string, value: v as number, text: `${v} · ${Math.round(((v as number) / total) * 100)}%`, color: color as string }))} />
            )}
            {d.priceTargets && d.priceTargets.length > 0 ? (
              <>
                <Note>Recent price-target changes</Note>
                <DataTable columns={cols} rows={d.priceTargets} minWidth={420} rowKey={(t, i) => `${t.publishedDate}-${i}`} />
              </>
            ) : (
              <Message>No recent price-target changes for {symbol}.</Message>
            )}
          </>
        );
      }}
    </Async>
  );
}

function ShortView({ symbol }: { symbol: string }) {
  const q = useGet<Short | null>(`short:${symbol}`, `/api/short-volume/${encodeURIComponent(symbol)}`);
  return (
    <Async q={q} what="short-sale data" symbol={symbol}>
      {(s) => (
        <>
          <StatGrid items={[
            { k: "Short share of volume", v: `${fmt(s.shortVolumePercent, 1)}%` },
            { k: "Short volume", v: count(s.shortVolume) },
            { k: "Total volume (FINRA)", v: count(s.totalVolume) },
            { k: "Date", v: dstr(`${s.date.slice(0, 4)}-${s.date.slice(4, 6)}-${s.date.slice(6, 8)}`) },
          ]} />
          <Message>Short interest and days to cover (FINRA’s twice-monthly report) aren’t loaded yet. This is daily short-sale volume from FINRA’s reporting facilities.</Message>
        </>
      )}
    </Async>
  );
}

function Institutions({ symbol }: { symbol: string }) {
  const q = useResearch<Institutional>(symbol, "institutional");
  return (
    <Async q={q} what="13F holdings data" symbol={symbol} isEmpty={(d) => !d.summary && !d.holders?.length} empty={`No 13F holdings data for ${symbol}.`}>
      {(d) => {
        const s = d.summary;
        const cols: Array<Column<Holder>> = [
          { label: "Holder", left: true, cell: (h) => h.investorName },
          { label: "Shares", cell: (h) => count(h.sharesNumber) },
          { label: "% owned", cell: (h) => (h.ownership == null ? "—" : `${fmt(h.ownership)}%`) },
          { label: "Change", cls: (h) => signCls(h.changeInSharesNumberPercentage), cell: (h) => signed(h.changeInSharesNumberPercentage) },
          { label: "Value", cls: () => "dim", cell: (h) => money(h.marketValue) },
        ];
        return (
          <>
            {s && (
              <StatGrid items={[
                { k: "Institutions", v: `${count(s.investorsHolding)} (${s.investorsHoldingChange >= 0 ? "+" : ""}${s.investorsHoldingChange})` },
                { k: "Owned by institutions", v: `${fmt(s.ownershipPercent, 1)}%` },
                { k: "Change in ownership", v: signed(s.ownershipPercentChange), cls: signCls(s.ownershipPercentChange) },
                { k: "Shares held", v: count(s.numberOf13Fshares) },
                { k: "New / increased", v: `${s.newPositions} / ${s.increasedPositions}` },
                { k: "Reduced / closed", v: `${s.reducedPositions} / ${s.closedPositions}` },
                { k: "13F put/call ratio", v: s.putCallRatio == null ? "—" : fmt(s.putCallRatio) },
                { k: "As of", v: dstr(s.date) },
              ]} />
            )}
            {d.holders && d.holders.length > 0 ? (
              <>
                <Note>Largest holders from 13F filings</Note>
                <DataTable columns={cols} rows={d.holders} rowKey={(h, i) => `${h.investorName}-${i}`} />
              </>
            ) : (
              <Message>No individual holders reported for {symbol}.</Message>
            )}
          </>
        );
      }}
    </Async>
  );
}

function EtfView({ symbol }: { symbol: string }) {
  const q = useResearch<EtfWeight[]>(symbol, "etf-exposure", "?limit=25");
  return (
    <Async q={q} what="ETF weights" symbol={symbol} empty={`No ETF holds a reported weight in ${symbol}.`}>
      {(rows) => {
        const cols: Array<Column<EtfWeight>> = [
          { label: "ETF", left: true, cls: () => "amber", cell: (e) => e.symbol },
          { label: "Weight", cell: (e) => (e.weightPercentage == null ? "—" : `${fmt(e.weightPercentage)}%`) },
          { label: "Market value", cls: () => "dim", cell: (e) => money(e.marketValue) },
        ];
        return (
          <>
            <Note>ETFs with the highest weight in {symbol}</Note>
            <DataTable columns={cols} rows={rows} minWidth={360} rowKey={(e) => e.symbol} />
          </>
        );
      }}
    </Async>
  );
}

export default function AnalysisTab({ symbol }: { symbol: string }) {
  const [sub, setSub] = useState("analysts");
  return (
    <>
      <SubTabs tabs={SUBS} value={sub} onChange={setSub} ariaLabel="Analysis sections" />
      {sub === "analysts" && <AnalystsView symbol={symbol} />}
      {sub === "short" && <ShortView symbol={symbol} />}
      {sub === "inst" && <Institutions symbol={symbol} />}
      {sub === "flow" && (
        <Message>Order flow (large, medium and small buy and sell money) isn’t computed by the app. It needs every trade classified by size, which could be derived from the SIP trade feed later.</Message>
      )}
      {sub === "etf" && <EtfView symbol={symbol} />}
    </>
  );
}
