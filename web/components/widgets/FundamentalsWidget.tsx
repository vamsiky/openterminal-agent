"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, fmtBig, fmtPct, pctClass, type Quote } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import ErrorNote from "../ErrorNote";
import EstimateRevisions from "../EstimateRevisions";

type Envelope<T> = { symbol?: string; dataset: string; source: string; asOf: string; data: T };
type Row = Record<string, number | string | null | undefined>;
type Period = "quarter" | "annual" | "ttm";

const TABS = ["Statements", "Metrics", "Estimates", "Analysts", "Ownership"] as const;
type Tab = (typeof TABS)[number];

const HOUR = 3_600_000;
const QUARTER_HOUR = 900_000;

function useResearch<T>(symbol: string, dataset: string, query: string, staleTime: number, enabled = true) {
  return useQuery({
    queryKey: ["research", symbol, dataset, query],
    queryFn: async () => (await apiGet<Envelope<T>>(`/api/research/${encodeURIComponent(symbol)}/${dataset}${query}`)).data,
    staleTime,
    enabled,
  });
}

const Loading = ({ what, symbol }: { what: string; symbol: string }) => <div className="p-2 dim">Loading {what} for {symbol}…</div>;
const Empty = ({ what, symbol }: { what: string; symbol: string }) => <div className="p-2 dim">No {what} for {symbol}.</div>;

// ---------- formatting ----------

type Kind = "big" | "eps" | "pct" | "x" | "num" | "days";

/** One cell: percent kinds take FMP's fractions (0.25 = 25%), multiples get an "x". Missing values are dashes. */
export function fmtValue(v: number | string | null | undefined, kind: Kind): string {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  switch (kind) {
    case "big": return fmtBig(v);
    case "eps": return fmt(v);
    case "pct": return fmt(v * 100, 1) + "%";
    case "x": return fmt(v, 2) + "x";
    case "days": return fmt(v, 0);
    case "num": return fmt(v);
  }
}

/** Year-over-year change as a fraction; null when there is no usable base (zero, missing, or a sign flip). */
export function yoy(cur: unknown, prior: unknown): number | null {
  if (typeof cur !== "number" || typeof prior !== "number" || !prior) return null;
  return (cur - prior) / Math.abs(prior);
}

/** Negative amounts and margins read red; neutral for ratios where sign carries no judgement. */
const signClass = (v: unknown, signed: boolean) => (signed && typeof v === "number" && v < 0 ? "down" : "");

function periodLabel(r: Row, period: Period): string {
  if (period === "annual") return `FY${r.fiscalYear ?? String(r.date ?? "").slice(0, 4)}`;
  if (period === "ttm") return String(r.date ?? "TTM");
  return `${r.fiscalYear ?? ""} ${r.period ?? ""}`.trim() || String(r.date ?? "—");
}

// ---------- Statements ----------

type StatementType = "income" | "balance" | "cashflow";
const STATEMENT_LABELS: Record<StatementType, string> = { income: "Income", balance: "Balance", cashflow: "Cash flow" };

const LINES: Record<StatementType, Array<[string, string, Kind?]>> = {
  income: [
    ["revenue", "Revenue"],
    ["costOfRevenue", "Cost of revenue"],
    ["grossProfit", "Gross profit"],
    ["researchAndDevelopmentExpenses", "R&D"],
    ["sellingGeneralAndAdministrativeExpenses", "SG&A"],
    ["operatingExpenses", "Opex"],
    ["operatingIncome", "Operating income"],
    ["ebitda", "EBITDA"],
    ["interestExpense", "Interest expense"],
    ["incomeBeforeTax", "Pre-tax income"],
    ["incomeTaxExpense", "Income tax"],
    ["netIncome", "Net income"],
    ["epsDiluted", "EPS diluted", "eps"],
    ["weightedAverageShsOutDil", "Diluted shares"],
  ],
  balance: [
    ["cashAndShortTermInvestments", "Cash & ST inv."],
    ["netReceivables", "Receivables"],
    ["inventory", "Inventory"],
    ["totalCurrentAssets", "Current assets"],
    ["propertyPlantEquipmentNet", "PP&E net"],
    ["goodwillAndIntangibleAssets", "Goodwill & intang."],
    ["totalAssets", "Total assets"],
    ["totalPayables", "Payables"],
    ["shortTermDebt", "ST debt"],
    ["deferredRevenue", "Deferred revenue"],
    ["totalCurrentLiabilities", "Current liabilities"],
    ["longTermDebt", "LT debt"],
    ["totalLiabilities", "Total liabilities"],
    ["totalStockholdersEquity", "Equity"],
    ["totalDebt", "Total debt"],
    ["netDebt", "Net debt"],
  ],
  cashflow: [
    ["netIncome", "Net income"],
    ["depreciationAndAmortization", "D&A"],
    ["stockBasedCompensation", "Stock comp"],
    ["changeInWorkingCapital", "Working capital chg"],
    ["operatingCashFlow", "Operating cash flow"],
    ["capitalExpenditure", "Capex"],
    ["freeCashFlow", "Free cash flow"],
    ["netCashProvidedByInvestingActivities", "Investing cash flow"],
    ["commonStockRepurchased", "Buybacks"],
    ["netDividendsPaid", "Dividends"],
    ["netCashProvidedByFinancingActivities", "Financing cash flow"],
    ["netChangeInCash", "Net change in cash"],
  ],
};

const SHOWN = 8;
/** Periods back that a year-over-year comparison needs. */
const YOY_LAG: Record<Period, number> = { quarter: 4, annual: 1, ttm: 4 };

function StatementsTab({ symbol }: { symbol: string }) {
  const [type, setType] = useState<StatementType>("income");
  const [period, setPeriod] = useState<Period>("quarter");
  const limit = SHOWN + YOY_LAG[period];
  const { data, error, isLoading } = useResearch<Row[]>(symbol, "statements", `?type=${type}&period=${period}&limit=${limit}`, HOUR);

  return (
    <div>
      <div className="flex gap-1 p-1 items-center">
        {(Object.keys(STATEMENT_LABELS) as StatementType[]).map((t) => (
          <button key={t} className={`term-btn ${type === t ? "active" : ""}`} onClick={() => setType(t)}>{STATEMENT_LABELS[t]}</button>
        ))}
        <span className="mx-1 dim">|</span>
        {(["quarter", "annual", "ttm"] as Period[]).map((p) => (
          <button key={p} className={`term-btn ${period === p ? "active" : ""}`} onClick={() => setPeriod(p)}>
            {p === "quarter" ? "Q" : p === "annual" ? "FY" : "TTM"}
          </button>
        ))}
        <span className="dim text-[10px] ml-auto">hover: YoY</span>
      </div>
      {error ? <ErrorNote error={error} /> : isLoading || !data ? <Loading what="statements" symbol={symbol} /> : data.length === 0 ? <Empty what="statements" symbol={symbol} /> : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>{data[0]?.reportedCurrency ?? "USD"}</th>
                {data.slice(0, SHOWN).map((r) => <th key={String(r.date)} title={String(r.date)}>{periodLabel(r, period)}</th>)}
              </tr>
            </thead>
            <tbody>
              {LINES[type].map(([key, label, kind = "big"]) => (
                <tr key={key}>
                  <td className="dim">{label}</td>
                  {data.slice(0, SHOWN).map((r, i) => {
                    const change = yoy(r[key], data[i + YOY_LAG[period]]?.[key]);
                    return (
                      <td
                        key={String(r.date)}
                        className={signClass(r[key], true)}
                        title={change === null ? "YoY —" : `YoY ${fmtPct(change * 100)}`}
                      >
                        {fmtValue(r[key], kind)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Metrics ----------

type MetricRow = { date?: string; fiscalYear?: string; period?: string; keyMetrics: Row | null; ratios: Row | null };
type Metric = { src: "keyMetrics" | "ratios"; key: string; label: string; kind: Kind; signed?: boolean };

const METRIC_GROUPS: Array<{ title: string; items: Metric[] }> = [
  {
    title: "Valuation",
    items: [
      { src: "ratios", key: "priceToEarningsRatio", label: "P/E", kind: "x" },
      { src: "ratios", key: "priceToSalesRatio", label: "P/S", kind: "x" },
      { src: "ratios", key: "priceToBookRatio", label: "P/B", kind: "x" },
      { src: "ratios", key: "priceToFreeCashFlowRatio", label: "P/FCF", kind: "x" },
      { src: "keyMetrics", key: "evToSales", label: "EV/Sales", kind: "x" },
      { src: "keyMetrics", key: "evToEBITDA", label: "EV/EBITDA", kind: "x" },
      { src: "keyMetrics", key: "earningsYield", label: "Earnings yield", kind: "pct", signed: true },
      { src: "keyMetrics", key: "freeCashFlowYield", label: "FCF yield", kind: "pct", signed: true },
    ],
  },
  {
    title: "Profitability",
    items: [
      { src: "ratios", key: "grossProfitMargin", label: "Gross margin", kind: "pct", signed: true },
      { src: "ratios", key: "operatingProfitMargin", label: "Operating margin", kind: "pct", signed: true },
      { src: "ratios", key: "netProfitMargin", label: "Net margin", kind: "pct", signed: true },
      { src: "keyMetrics", key: "returnOnEquity", label: "ROE", kind: "pct", signed: true },
      { src: "keyMetrics", key: "returnOnAssets", label: "ROA", kind: "pct", signed: true },
      { src: "keyMetrics", key: "returnOnInvestedCapital", label: "ROIC", kind: "pct", signed: true },
    ],
  },
  {
    title: "Leverage",
    items: [
      { src: "ratios", key: "debtToEquityRatio", label: "Debt/Equity", kind: "x", signed: true },
      { src: "ratios", key: "debtToAssetsRatio", label: "Debt/Assets", kind: "x" },
      { src: "keyMetrics", key: "netDebtToEBITDA", label: "Net debt/EBITDA", kind: "x", signed: true },
      { src: "ratios", key: "interestCoverageRatio", label: "Interest coverage", kind: "x", signed: true },
    ],
  },
  {
    title: "Liquidity",
    items: [
      { src: "ratios", key: "currentRatio", label: "Current ratio", kind: "x" },
      { src: "ratios", key: "quickRatio", label: "Quick ratio", kind: "x" },
      { src: "ratios", key: "cashRatio", label: "Cash ratio", kind: "x" },
      { src: "keyMetrics", key: "cashConversionCycle", label: "Cash conv. days", kind: "days", signed: true },
    ],
  },
];

/** The TTM rows keep FMP's `TTM` key suffix, except a few such as marketCap. */
function metricValue(row: MetricRow, m: Metric, ttm: boolean) {
  const src = row[m.src];
  return ttm ? (src?.[`${m.key}TTM`] ?? src?.[m.key]) : src?.[m.key];
}

function MetricsTab({ symbol }: { symbol: string }) {
  const ttm = useResearch<MetricRow[]>(symbol, "metrics", "?period=ttm", HOUR);
  const qtr = useResearch<MetricRow[]>(symbol, "metrics", `?period=quarter&limit=${SHOWN}`, HOUR);

  const error = ttm.error ?? qtr.error;
  if (error) return <ErrorNote error={error} />;
  if (ttm.isLoading || qtr.isLoading) return <Loading what="metrics" symbol={symbol} />;
  const quarters = qtr.data ?? [];
  const ttmRow = ttm.data?.[0];
  if (!ttmRow && quarters.length === 0) return <Empty what="metrics" symbol={symbol} />;

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th />
            {ttmRow && <th className="amber">TTM</th>}
            {quarters.map((r) => <th key={String(r.date)} title={String(r.date)}>{periodLabel(r as Row, "quarter")}</th>)}
          </tr>
        </thead>
        {METRIC_GROUPS.map((g) => (
          <tbody key={g.title}>
            <tr><td colSpan={2 + quarters.length} className="amber !text-left text-[10px] uppercase pt-2">{g.title}</td></tr>
            {g.items.map((m) => (
              <tr key={m.key}>
                <td className="dim">{m.label}</td>
                {ttmRow && <MetricCell m={m} v={metricValue(ttmRow, m, true)} />}
                {quarters.map((r) => <MetricCell key={String(r.date)} m={m} v={metricValue(r, m, false)} />)}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function MetricCell({ m, v }: { m: Metric; v: unknown }) {
  return <td className={signClass(v, m.signed ?? false)}>{fmtValue(v as number, m.kind)}</td>;
}

// ---------- Estimates ----------

type EstimateRow = {
  date: string;
  revenueLow: number | null; revenueAvg: number | null; revenueHigh: number | null;
  epsLow: number | null; epsAvg: number | null; epsHigh: number | null;
  numAnalystsEps: number | null; numAnalystsRevenue: number | null;
};

function EstimateTable({ title, rows }: { title: string; rows: EstimateRow[] }) {
  return (
    <table className="data-table mb-2">
      <thead>
        <tr>
          <th>{title}</th>
          <th>EPS low</th><th>EPS avg</th><th>EPS high</th>
          <th>Rev low</th><th>Rev avg</th><th>Rev high</th>
          <th title="Analysts on EPS / revenue">#</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.date}>
            <td className="dim">{r.date}</td>
            <td>{fmt(r.epsLow)}</td><td className="font-bold">{fmt(r.epsAvg)}</td><td>{fmt(r.epsHigh)}</td>
            <td>{fmtBig(r.revenueLow)}</td><td className="font-bold">{fmtBig(r.revenueAvg)}</td><td>{fmtBig(r.revenueHigh)}</td>
            <td className="dim">{r.numAnalystsEps ?? "—"}/{r.numAnalystsRevenue ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EstimatesTab({ symbol }: { symbol: string }) {
  const q = useResearch<{ estimates: EstimateRow[] }>(symbol, "estimates", "?period=quarter&limit=6", QUARTER_HOUR);
  const a = useResearch<{ estimates: EstimateRow[] }>(symbol, "estimates", "?period=annual&limit=4", QUARTER_HOUR);

  const error = q.error ?? a.error;
  if (error) return <ErrorNote error={error} />;
  if (q.isLoading || a.isLoading) return <Loading what="estimates" symbol={symbol} />;
  const quarters = q.data?.estimates ?? [];
  const years = a.data?.estimates ?? [];

  return (
    <div className="p-1">
      <div className="mb-2"><EstimateRevisions symbol={symbol} /></div>
      {quarters.length === 0 && years.length === 0 ? <Empty what="analyst estimates" symbol={symbol} /> : (
        <div className="overflow-x-auto">
          {quarters.length > 0 && <EstimateTable title="Quarter" rows={quarters} />}
          {years.length > 0 && <EstimateTable title="Year" rows={years} />}
        </div>
      )}
    </div>
  );
}

// ---------- Analysts ----------

type AnalystsData = {
  priceTargetSummary: { lastMonthCount: number; lastMonthAvgPriceTarget: number; lastQuarterCount: number; lastQuarterAvgPriceTarget: number; lastYearCount: number; lastYearAvgPriceTarget: number } | null;
  priceTargetConsensus: { targetHigh: number; targetLow: number; targetConsensus: number; targetMedian: number } | null;
  grades: Array<{ date: string; gradingCompany: string; previousGrade: string; newGrade: string; action: string }>;
  gradesConsensus: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number; consensus: string } | null;
};

const ACTION_CLASS: Record<string, string> = { upgrade: "up", downgrade: "down" };

function AnalystsTab({ symbol }: { symbol: string }) {
  const { data, error, isLoading } = useResearch<AnalystsData>(symbol, "analysts", "?limit=15", QUARTER_HOUR);
  const { data: quote } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${encodeURIComponent(symbol)}`))[0] ?? null,
    staleTime: 30_000,
  });

  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <Loading what="analyst data" symbol={symbol} />;
  const { priceTargetConsensus: pt, priceTargetSummary: sum, gradesConsensus: gc, grades } = data;
  if (!pt && !sum && !gc && grades.length === 0) return <Empty what="analyst coverage" symbol={symbol} />;

  const price = quote?.price ?? null;
  const upside = (target: number | null | undefined) => (price && target ? (target / price - 1) * 100 : null);
  const targets: Array<[string, number | undefined]> = pt
    ? [["Low", pt.targetLow], ["Median", pt.targetMedian], ["Consensus", pt.targetConsensus], ["High", pt.targetHigh]]
    : [];
  const votes: Array<[string, number, string]> = gc
    ? [["Strong buy", gc.strongBuy, "up"], ["Buy", gc.buy, "up"], ["Hold", gc.hold, "dim"], ["Sell", gc.sell, "down"], ["Strong sell", gc.strongSell, "down"]]
    : [];

  return (
    <div className="p-1">
      {gc && (
        <div className="mb-2 text-[11px]">
          <span className="dim">Consensus</span> <span className="font-bold amber">{gc.consensus}</span>
          {votes.map(([label, n, cls]) => <span key={label}>{" · "}<span className="dim">{label}</span> <span className={cls}>{n}</span></span>)}
        </div>
      )}
      {pt && (
        <table className="data-table mb-2">
          <thead><tr><th>Price target</th><th>Target</th><th>vs {price === null ? "price" : fmt(price)}</th></tr></thead>
          <tbody>
            {targets.map(([label, t]) => (
              <tr key={label}>
                <td className="dim">{label}</td>
                <td>{fmt(t)}</td>
                <td className={pctClass(upside(t))}>{upside(t) === null ? "—" : fmtPct(upside(t))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sum && (
        <div className="mb-2 text-[11px]">
          <span className="dim">Avg target by window</span>
          {([["1M", sum.lastMonthAvgPriceTarget, sum.lastMonthCount], ["3M", sum.lastQuarterAvgPriceTarget, sum.lastQuarterCount], ["12M", sum.lastYearAvgPriceTarget, sum.lastYearCount]] as const).map(([w, avg, n]) => (
            <span key={w}>{" · "}<span className="dim">{w}</span> {fmt(avg)} <span className="dim">({n})</span></span>
          ))}
        </div>
      )}
      {grades.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Date</th><th className="!text-left">Firm</th><th>Action</th><th>From</th><th>To</th></tr></thead>
          <tbody>
            {grades.map((g, i) => (
              <tr key={`${g.date}-${g.gradingCompany}-${i}`}>
                <td className="dim">{g.date}</td>
                <td className="!text-left">{g.gradingCompany}</td>
                <td className={ACTION_CLASS[g.action?.toLowerCase()] ?? "dim"}>{g.action}</td>
                <td className="dim">{g.previousGrade || "—"}</td>
                <td>{g.newGrade}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Ownership ----------

type Institutional = {
  year: number;
  quarter: number;
  summary: {
    investorsHolding: number; investorsHoldingChange: number;
    ownershipPercent: number; ownershipPercentChange: number;
    numberOf13Fshares: number; numberOf13FsharesChange: number;
    newPositions: number; closedPositions: number; increasedPositions: number; reducedPositions: number;
  } | null;
  holders: Array<{ investorName: string; sharesNumber: number; changeInSharesNumberPercentage: number | null; ownership: number | null; marketValue: number | null }>;
};

type InsiderTrade = {
  transactionDate: string; transactionType: string; reportingName: string; typeOfOwner: string;
  securitiesTransacted: number | null; price: number | null;
};

type CongressTrade = { transactionDate: string | null; disclosureDate: string; chamber: string; firstName: string; lastName: string; type: string; amount: string };

const INSIDER_WINDOW_DAYS = 90;

/** Open-market buys and sales in the window, as a net dollar value; grants, gifts and tax withholding are left out. */
export function insiderSummary(trades: InsiderTrade[], now = Date.now()) {
  const cutoff = new Date(now - INSIDER_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const recent = trades.filter((t) => t.transactionDate >= cutoff);
  const value = (t: InsiderTrade) => (t.securitiesTransacted ?? 0) * (t.price ?? 0);
  const bought = recent.filter((t) => t.transactionType.startsWith("P")).reduce((s, t) => s + value(t), 0);
  const sold = recent.filter((t) => t.transactionType.startsWith("S")).reduce((s, t) => s + value(t), 0);
  return { recent, bought, sold, net: bought - sold };
}

function OwnershipTab({ symbol }: { symbol: string }) {
  const inst = useResearch<Institutional>(symbol, "institutional", "", QUARTER_HOUR);
  const ins = useResearch<{ trades: InsiderTrade[] }>(symbol, "insiders", "?limit=200", QUARTER_HOUR);
  const cong = useResearch<CongressTrade[]>(symbol, "congress", "?limit=20", QUARTER_HOUR);

  const error = inst.error ?? ins.error ?? cong.error;
  if (error) return <ErrorNote error={error} />;
  if (inst.isLoading || ins.isLoading || cong.isLoading) return <Loading what="ownership" symbol={symbol} />;

  const s = inst.data?.summary;
  const holders = (inst.data?.holders ?? []).slice(0, 10);
  const insiders = insiderSummary(ins.data?.trades ?? []);
  const congress = cong.data ?? [];
  const trades = insiders.recent.filter((t) => /^[PS]/.test(t.transactionType));
  if (!s && holders.length === 0 && insiders.recent.length === 0 && congress.length === 0) return <Empty what="ownership data" symbol={symbol} />;

  return (
    <div className="p-1">
      {s && (
        <div className="mb-2 text-[11px]">
          <span className="dim">13F {inst.data?.year} Q{inst.data?.quarter}</span>
          {" · "}<span className="dim">holders</span> {fmt(s.investorsHolding, 0)} <span className={pctClass(s.investorsHoldingChange)}>({s.investorsHoldingChange > 0 ? "+" : ""}{fmt(s.investorsHoldingChange, 0)})</span>
          {" · "}<span className="dim">owned</span> {fmt(s.ownershipPercent, 1)}% <span className={pctClass(s.ownershipPercentChange)}>({fmtPct(s.ownershipPercentChange)})</span>
          {" · "}<span className="dim">shares</span> {fmtBig(s.numberOf13Fshares)} <span className={pctClass(s.numberOf13FsharesChange)}>({fmtBig(s.numberOf13FsharesChange)})</span>
          <div className="dim">
            new <span className="up">{s.newPositions}</span> · added <span className="up">{s.increasedPositions}</span> · reduced <span className="down">{s.reducedPositions}</span> · closed <span className="down">{s.closedPositions}</span>
          </div>
        </div>
      )}
      {holders.length > 0 && (
        <table className="data-table mb-2">
          <thead><tr><th>Top holders</th><th>Shares</th><th>QoQ</th><th>Value</th></tr></thead>
          <tbody>
            {holders.map((h) => (
              <tr key={h.investorName}>
                <td className="!text-left truncate max-w-[200px]" title={h.investorName}>{h.investorName}</td>
                <td>{fmtBig(h.sharesNumber)}</td>
                <td className={pctClass(h.changeInSharesNumberPercentage)}>{h.changeInSharesNumberPercentage == null ? "—" : fmtPct(h.changeInSharesNumberPercentage)}</td>
                <td className="dim">{fmtBig(h.marketValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mb-1 text-[11px]">
        <span className="dim">Insiders, last {INSIDER_WINDOW_DAYS}d (open market)</span>
        {" · "}<span className="dim">bought</span> <span className="up">${fmtBig(insiders.bought)}</span>
        {" · "}<span className="dim">sold</span> <span className="down">${fmtBig(insiders.sold)}</span>
        {" · "}<span className="dim">net</span> <span className={pctClass(insiders.net)}>{insiders.net > 0 ? "+" : insiders.net < 0 ? "-" : ""}${fmtBig(Math.abs(insiders.net))}</span>
      </div>
      {trades.length === 0 ? <div className="dim mb-2">No open-market insider trades in the window.</div> : (
        <table className="data-table mb-2">
          <thead><tr><th>Date</th><th className="!text-left">Insider</th><th>Type</th><th>Shares</th><th>Price</th></tr></thead>
          <tbody>
            {trades.slice(0, 10).map((t, i) => (
              <tr key={`${t.reportingName}-${t.transactionDate}-${i}`}>
                <td className="dim">{t.transactionDate}</td>
                <td className="!text-left truncate max-w-[160px]" title={t.typeOfOwner}>{t.reportingName}</td>
                <td className={t.transactionType.startsWith("P") ? "up" : "down"}>{t.transactionType.startsWith("P") ? "Buy" : "Sale"}</td>
                <td>{fmtBig(t.securitiesTransacted)}</td>
                <td>{fmt(t.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mb-1 text-[11px] dim">Congress trades</div>
      {congress.length === 0 ? <div className="dim">No recent Congress trades.</div> : (
        <table className="data-table">
          <thead><tr><th>Date</th><th className="!text-left">Member</th><th>Type</th><th>Amount</th></tr></thead>
          <tbody>
            {congress.slice(0, 10).map((c, i) => (
              <tr key={`${c.lastName}-${c.disclosureDate}-${i}`}>
                <td className="dim">{c.transactionDate ?? c.disclosureDate}</td>
                <td className="!text-left">{c.firstName} {c.lastName} <span className="dim">({c.chamber === "senate" ? "S" : "H"})</span></td>
                <td className={/purchase/i.test(c.type) ? "up" : /sale/i.test(c.type) ? "down" : "dim"}>{c.type}</td>
                <td className="dim">{c.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Widget ----------

export default function FundamentalsWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [tab, setTab] = useState<Tab>("Statements");

  return (
    <div>
      <div className="flex gap-1 p-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button key={t} className={`term-btn ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === "Statements" && <StatementsTab symbol={symbol} />}
      {tab === "Metrics" && <MetricsTab symbol={symbol} />}
      {tab === "Estimates" && <EstimatesTab symbol={symbol} />}
      {tab === "Analysts" && <AnalystsTab symbol={symbol} />}
      {tab === "Ownership" && <OwnershipTab symbol={symbol} />}
    </div>
  );
}
