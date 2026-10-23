"use client";

import { useState } from "react";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import AnalysisTab from "../details/AnalysisTab";
import CompactChain from "../details/CompactChain";
import { BriefTab, CorporateTab } from "../details/CorpBriefTabs";
import FilingsTab from "../details/FilingsTab";
import FinancialsTab from "../details/FinancialsTab";
import { BondsTab, CommentsTab, NewsTab } from "../details/NewsTab";
import PillTabs from "../ui/PillTabs";

const TABS = [
  { id: "news", label: "News" },
  { id: "comments", label: "Comments" },
  { id: "options", label: "Options" },
  { id: "bonds", label: "Bonds" },
  { id: "fin", label: "Financials" },
  { id: "analysis", label: "Analysis" },
  { id: "filings", label: "Filings & releases" },
  { id: "corp", label: "Corporate actions" },
  { id: "brief", label: "Brief" },
];

export default function DetailsWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [tab, setTab] = useState("news");

  return (
    <div className="flex flex-col min-h-full font-sans-ui" data-widget={widget.id}>
      <div className="sticky top-0 z-[2] px-2 py-1.5 border-b border-[#262626] bg-[#0d0d0d]">
        <PillTabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Stock details sections" />
      </div>
      <div className="flex flex-col gap-2.5 px-3 py-2.5" key={`${symbol}-${tab}`}>
        {tab === "news" && <NewsTab symbol={symbol} />}
        {tab === "comments" && <CommentsTab symbol={symbol} />}
        {tab === "options" && <CompactChain symbol={symbol} />}
        {tab === "bonds" && <BondsTab symbol={symbol} />}
        {tab === "fin" && <FinancialsTab symbol={symbol} />}
        {tab === "analysis" && <AnalysisTab symbol={symbol} />}
        {tab === "filings" && <FilingsTab symbol={symbol} />}
        {tab === "corp" && <CorporateTab symbol={symbol} />}
        {tab === "brief" && <BriefTab symbol={symbol} />}
      </div>
    </div>
  );
}
