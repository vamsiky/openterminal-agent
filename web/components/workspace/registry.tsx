"use client";

import type { ComponentType } from "react";
import { SYMBOL_AWARE, type WidgetInstance, type WidgetType } from "../../store/terminal";
import QuoteWidget from "../widgets/QuoteWidget";
import ChartWidget from "../widgets/ChartWidget";
import WatchlistWidget from "../widgets/WatchlistWidget";
import NewsWidget from "../widgets/NewsWidget";
import HeatmapWidget from "../widgets/HeatmapWidget";
import ScreenerWidget from "../widgets/ScreenerWidget";
import CryptoWidget from "../widgets/CryptoWidget";
import MacroWidget from "../widgets/MacroWidget";
import OptionsWidget from "../widgets/OptionsWidget";
import PortfolioWidget from "../widgets/PortfolioWidget";
import AiWidget from "../widgets/AiWidget";
import CalendarWidget from "../widgets/CalendarWidget";
import InsiderWidget from "../widgets/InsiderWidget";
import IdeasWidget from "../widgets/IdeasWidget";
import FundamentalsWidget from "../widgets/FundamentalsWidget";
import TvWidget from "../widgets/TvWidget";
import RecapWidget from "../widgets/RecapWidget";
import DetailsWidget from "../widgets/DetailsWidget";
import ResearchWidget from "../widgets/ResearchWidget";
import ScanLabWidget from "../widgets/ScanLabWidget";

export type WidgetGroup = "Markets" | "Research" | "Ideas & trading" | "Tools";

export type WidgetDef = {
  label: string;
  /** SVG path data for a 16x16 stroke icon. */
  icon: string;
  group: WidgetGroup;
  symbolAware: boolean;
  /** Alt+<digit> adds the widget as a tab in the focused pane. */
  shortcut?: string;
  component: ComponentType<{ widget: WidgetInstance }>;
};

const def = (
  label: string, icon: string, group: WidgetGroup, type: WidgetType, component: WidgetDef["component"], shortcut?: string
): WidgetDef => ({ label, icon, group, symbolAware: SYMBOL_AWARE.has(type), shortcut, component });

export const WIDGETS: Record<WidgetType, WidgetDef> = {
  chart: def("Chart", "M2 13l4-5 3 2 5-6", "Markets", "chart", ChartWidget, "1"),
  quote: def("Quote", "M3 3h10v10H3zM5.5 6.5h5M5.5 9.5h3", "Markets", "quote", QuoteWidget, "2"),
  watchlist: def("Watchlist grid", "M5 4h9M5 8h9M5 12h9M2 4h.5M2 8h.5M2 12h.5", "Markets", "watchlist", WatchlistWidget),
  heatmap: def("Heatmap", "M2 2h5v6H2zM9 2h5v3H9zM9 7h5v7H9zM2 10h5v4H2z", "Markets", "heatmap", HeatmapWidget, "5"),
  macro: def("Macro", "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2.2 2.2 2.2 9.8 0 12M8 2c-2.2 2.2-2.2 9.8 0 12", "Markets", "macro", MacroWidget),
  crypto: def("Crypto", "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM6.5 5.5h2.3a1.3 1.3 0 0 1 0 2.5H6.5zM6.5 8h2.7a1.3 1.3 0 0 1 0 2.5H6.5zM6.5 4.5v7", "Markets", "crypto", CryptoWidget, "6"),
  details: def("Stock details", "M2 3h12v10H2zM2 6h12M5 6v7", "Research", "details", DetailsWidget),
  research: def("Research & reports", "M3 2h7l3 3v9H3zM5.5 8h5M5.5 11h3M10 2v3h3", "Research", "research", ResearchWidget),
  news: def("News", "M3 3h8v10H3zM11 6h2v7h-2M5 6h4M5 8.5h4M5 11h2", "Research", "news", NewsWidget, "3"),
  fundamentals: def("Fundamentals", "M3.5 13V8M7.5 13V4M11.5 13V6.5M2 13.5h12", "Research", "fundamentals", FundamentalsWidget),
  insider: def("Insider", "M8 3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5", "Research", "insider", InsiderWidget),
  calendar: def("Calendar", "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3", "Research", "calendar", CalendarWidget),
  recap: def("Market recap", "M4 2h5.5L12 4.5V14H4zM6 7.5h4M6 10h4", "Research", "recap", RecapWidget),
  ideas: def("Ideas", "M8 2a4 4 0 0 1 2.4 7.2V11H5.6V9.2A4 4 0 0 1 8 2zM6 13.5h4", "Ideas & trading", "ideas", IdeasWidget),
  options: def("Option chain", "M2 4.5h12M2 8h12M2 11.5h12M8 2.5v11", "Ideas & trading", "options", OptionsWidget, "7"),
  screener: def("Screener", "M2 3h12l-4.5 5.5V13l-3-1.5V8.5z", "Ideas & trading", "screener", ScreenerWidget, "4"),
  portfolio: def("Portfolio", "M2 5h12v8H2zM6 5V3h4v2M2 8.5h12", "Ideas & trading", "portfolio", PortfolioWidget, "8"),
  scanlab: def("Scan Lab", "M6 2h4M6.8 2v4L3.5 12a1.2 1.2 0 0 0 1.1 1.8h6.8A1.2 1.2 0 0 0 12.5 12L9.2 6V2M5 10h6", "Ideas & trading", "scanlab", ScanLabWidget),
  ai: def("AI assist", "M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z", "Tools", "ai", AiWidget, "9"),
  tv: def("Live TV", "M2 3.5h12v8H2zM6 14h4M8 11.5V14", "Tools", "tv", TvWidget),
};

export const GROUPS: Array<{ name: WidgetGroup; types: WidgetType[] }> = [
  { name: "Markets", types: ["chart", "quote", "watchlist", "heatmap", "macro", "crypto"] },
  { name: "Research", types: ["details", "research", "news", "fundamentals", "insider", "calendar", "recap"] },
  { name: "Ideas & trading", types: ["ideas", "scanlab", "options", "screener", "portfolio"] },
  { name: "Tools", types: ["ai", "tv"] },
];

export const SHORTCUTS: Record<string, WidgetType> = Object.fromEntries(
  (Object.entries(WIDGETS) as Array<[WidgetType, WidgetDef]>)
    .filter(([, d]) => d.shortcut)
    .map(([t, d]) => [d.shortcut!, t])
);
