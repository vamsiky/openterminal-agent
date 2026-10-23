"use client";

import { useState } from "react";
import { fmt } from "../../lib/api";
import EstimateRevisions from "../EstimateRevisions";
import { Async, Bars, DataTable, Note, StatGrid, count, dstr, money, signCls, signed, useGet, useResearch, type Column, SubTabs } from "./shared";

const SUBS = [
  { id: "forecast", label: "Forecast" },
  { id: "income", label: "Income statement" },
  { id: "balance", label: "Balance sheet" },
  { id: "cashflow", label: "Cash flow" },
  { id: "earnings", label: "Earnings history" },
];

type Estimate = {
  date: string; epsAvg: number | null; epsLow: number | null; epsHigh: number | null; revenueAvg: number | null; numAnalystsEps: number | null;
};
type Statement = Record<string, number | string | null | undefined> & { date: string; period?: string; fiscalYear?: string };
type History = {
  fiscalQtrEnd: string; fiscalPeriod?: string; upcoming?: boolean; dateReported: number; eps: number | null; consensusForecast: number | null;
  surprisePercent: number | null; dayAfterChangePercent: number | null;
};

type Metric = { label: string; value: (r: Statement) => string; cls?: (r: Statement) => string };
const n = (r: Statement, k: string) => (typeof r[k] === "number" ? (r[k] as number) : null);
const ratio = (a: number | null, b: number | null) => (a !== null && b ? `${fmt((a / b) * 100, 1)}%` : "—");
const neg = (k: string) => (r: Statement) => ((n(r, k) ?? 0) < 0 ? "down" : "");

const METRICS: Record<"income" | "balance" | "cashflow", Metric[]> = {
  income: [
    { label: "Revenue", value: (r) => money(n(r, "revenue")) },
    { label: "Gross profit", value: (r) => money(n(r, "grossProfit")) },
    { label: "Gross margin", value: (r) => ratio(n(r, "grossProfit"), n(r, "revenue")) },
    { label: "R&D", value: (r) => money(n(r, "researchAndDevelopmentExpenses")) },
    { label: "Operating income", value: (r) => money(n(r, "operatingIncome")), cls: neg("operatingIncome") },
    { label: "Net income", value: (r) => money(n(r, "netIncome")), cls: neg("netIncome") },
    { label: "EPS (diluted)", value: (r) => fmt(n(r, "epsDiluted")) },
  ],
  balance: [
    { label: "Total assets", value: (r) => money(n(r, "totalAssets")) },
    { label: "Total liabilities", value: (r) => money(n(r, "totalLiabilities")) },
    { label: "Cash & short-term inv.", value: (r) => money(n(r, "cashAndShortTermInvestments")) },
    { label: "Total debt", value: (r) => money(n(r, "totalDebt")) },
    { label: "Shareholders’ equity", value: (r) => money(n(r, "totalStockholdersEquity")), cls: neg("totalStockholdersEquity") },
    { label: "Debt / assets", value: (r) => ratio(n(r, "totalDebt"), n(r, "totalAssets")) },
  ],
  cashflow: [
    { label: "Operating cash flow", value: (r) => money(n(r, "operatingCashFlow")), cls: neg("operatingCashFlow") },
    { label: "Capital expenditure", value: (r) => money(n(r, "capitalExpenditure")) },
    { label: "Free cash flow", value: (r) => money(n(r, "freeCashFlow")), cls: (r) => ((n(r, "freeCashFlow") ?? 0) < 0 ? "down" : "up") },
    { label: "Buybacks", value: (r) => money(n(r, "commonStockRepurchased")) },
    { label: "Dividends paid", value: (r) => money(n(r, "netDividendsPaid")) },
  ],
};

const periodLabel = (r: Statement) => (r.period && r.fiscalYear ? `${r.period} ${r.fiscalYear}` : dstr(r.date));

function Forecast({ symbol }: { symbol: string }) {
  const q = useResearch<{ estimates: Estimate[] }>(symbol, "estimates");
  return (
    <Async q={q} what="analyst estimates" symbol={symbol} isEmpty={(d) => !d.estimates?.length}>
      {(d) => {
        const cols: Array<Column<Estimate>> = [
          { label: "Fiscal year end", left: true, cell: (e) => dstr(e.date) },
          { label: "EPS (avg)", cell: (e) => fmt(e.epsAvg) },
          { label: "EPS range", cls: () => "dim", cell: (e) => `${fmt(e.epsLow)} – ${fmt(e.epsHigh)}` },
          { label: "Revenue (avg)", cell: (e) => money(e.revenueAvg) },
          { label: "Analysts", cls: () => "dim", cell: (e) => count(e.numAnalystsEps) },
        ];
        return (
          <>
            <EstimateRevisions symbol={symbol} />
            <Note>Annual consensus by fiscal year end · FMP</Note>
            <DataTable columns={cols} rows={d.estimates} rowKey={(e) => e.date} />
            <Bars items={d.estimates.map((e) => ({ label: `FY ${e.date.slice(0, 4)}`, value: e.revenueAvg ?? 0, text: money(e.revenueAvg), color: "#6b8cff" }))} />
          </>
        );
      }}
    </Async>
  );
}

function Statements({ symbol, type }: { symbol: string; type: "income" | "balance" | "cashflow" }) {
  const q = useResearch<Statement[]>(symbol, "statements", `?type=${type}&period=quarter`);
  const what = type === "income" ? "income statements" : type === "balance" ? "balance sheets" : "cash-flow statements";
  return (
    <Async q={q} what={what} symbol={symbol}>
      {(rows) => {
        const periods = [...rows].sort((a, b) => b.date.localeCompare(a.date));
        const cols: Array<Column<Metric>> = [
          { label: "Metric", left: true, cell: (m) => m.label },
          ...periods.map((p) => ({ label: periodLabel(p), cls: (m: Metric) => m.cls?.(p) ?? "", cell: (m: Metric) => m.value(p) })),
        ];
        return (
          <>
            <Note>Last {periods.length} quarters · FMP</Note>
            <DataTable columns={cols} rows={METRICS[type]} minWidth={120 + periods.length * 90} rowKey={(m) => m.label} />
            {type === "income" && (
              <Bars items={[...periods].reverse().map((p) => ({ label: periodLabel(p), value: n(p, "revenue") ?? 0, text: money(n(p, "revenue")), color: "#ff9900" }))} />
            )}
          </>
        );
      }}
    </Async>
  );
}

function EarningsHistory({ symbol }: { symbol: string }) {
  const q = useGet<History[]>(`earnings-history:${symbol}`, `/api/earnings-history/${encodeURIComponent(symbol)}`);
  return (
    <Async q={q} what="earnings history" symbol={symbol} isEmpty={(d) => !d.some((e) => !e.upcoming)}>
      {(all) => {
        const past = all.filter((e) => !e.upcoming);
        const next = all.find((e) => e.upcoming);
        const cols: Array<Column<History>> = [
          { label: "Quarter end", left: true, cell: (e) => dstr(e.fiscalQtrEnd) },
          { label: "EPS", cell: (e) => fmt(e.eps) },
          { label: "Estimate", cls: () => "dim", cell: (e) => fmt(e.consensusForecast) },
          { label: "Surprise", cls: (e) => signCls(e.surprisePercent), cell: (e) => signed(e.surprisePercent) },
          { label: "Next-day move", cls: (e) => signCls(e.dayAfterChangePercent), cell: (e) => signed(e.dayAfterChangePercent) },
        ];
        return (
          <>
            {next && (
              <StatGrid items={[
                { k: "Next report", v: dstr(new Date(next.dateReported * 1000).toISOString()) },
                { k: "EPS estimate", v: fmt(next.consensusForecast) },
              ]} />
            )}
            <Note>Reported EPS against consensus, and the stock’s move the next day</Note>
            <DataTable columns={cols} rows={past} rowKey={(e) => String(e.dateReported)} />
          </>
        );
      }}
    </Async>
  );
}

export default function FinancialsTab({ symbol }: { symbol: string }) {
  const [sub, setSub] = useState("income");
  return (
    <>
      <SubTabs tabs={SUBS} value={sub} onChange={setSub} ariaLabel="Financials sections" />
      {sub === "forecast" && <Forecast symbol={symbol} />}
      {(sub === "income" || sub === "balance" || sub === "cashflow") && <Statements symbol={symbol} type={sub} />}
      {sub === "earnings" && <EarningsHistory symbol={symbol} />}
    </>
  );
}
