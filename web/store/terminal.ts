"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeSymbol } from "../lib/symbol";

export type WidgetType =
  | "quote"
  | "chart"
  | "watchlist"
  | "news"
  | "heatmap"
  | "screener"
  | "crypto"
  | "macro"
  | "options"
  | "portfolio"
  | "ai"
  | "calendar"
  | "insider"
  | "tv"
  | "recap";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  symbol?: string;
  linked: boolean; // follows the globally active symbol
};

export type Watchlist = { name: string; symbols: string[] };

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number };

type TerminalState = {
  activeSymbol: string;
  widgets: WidgetInstance[];
  layout: LayoutItem[];
  /** Every list, in display order. */
  watchlists: Watchlist[];
  activeWatchlist: string;
  /** Symbols of the active list (what the watchlist widget, calendar and palette use). */
  watchlist: string[];
  commandOpen: boolean;
  setActiveSymbol: (s: string) => void;
  setCommandOpen: (open: boolean) => void;
  addWidget: (type: WidgetType, symbol?: string) => void;
  removeWidget: (id: string) => void;
  setWidgetSymbol: (id: string, symbol: string) => void;
  toggleLinked: (id: string) => void;
  setLayout: (layout: LayoutItem[]) => void;
  addToWatchlist: (s: string) => void;
  removeFromWatchlist: (s: string) => void;
  setWatchlist: (symbols: string[]) => void;
  /** Replaces every list at once (used when the server's copy is loaded). */
  setWatchlists: (lists: Watchlist[]) => void;
  setActiveWatchlist: (name: string) => void;
  createWatchlist: (name: string) => void;
  deleteWatchlist: (name: string) => void;
  resetWorkspace: () => void;
};

const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "w-chart", type: "chart", linked: true },
  { id: "w-quote", type: "quote", linked: true },
  { id: "w-watchlist", type: "watchlist", linked: false },
  { id: "w-news", type: "news", linked: true },
  { id: "w-macro", type: "macro", linked: false },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "w-chart", x: 0, y: 0, w: 7, h: 12 },
  { i: "w-quote", x: 7, y: 0, w: 5, h: 6 },
  { i: "w-watchlist", x: 7, y: 6, w: 5, h: 6 },
  { i: "w-news", x: 0, y: 12, w: 7, h: 7 },
  { i: "w-macro", x: 7, y: 12, w: 5, h: 7 },
];

const SIZE_BY_TYPE: Record<WidgetType, { w: number; h: number }> = {
  quote: { w: 5, h: 6 },
  chart: { w: 7, h: 12 },
  watchlist: { w: 4, h: 7 },
  news: { w: 5, h: 8 },
  heatmap: { w: 7, h: 10 },
  screener: { w: 12, h: 9 },
  crypto: { w: 6, h: 9 },
  macro: { w: 5, h: 7 },
  options: { w: 12, h: 9 },
  portfolio: { w: 7, h: 8 },
  ai: { w: 5, h: 10 },
  calendar: { w: 12, h: 11 },
  insider: { w: 7, h: 9 },
  tv: { w: 6, h: 11 },
  recap: { w: 5, h: 12 },
};

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "SPY"];

/** Keeps `watchlist` in step with the active list, falling back to the first list. */
function withLists(lists: Watchlist[], active: string) {
  const current = lists.find((l) => l.name === active) ?? lists[0];
  return { watchlists: lists, activeWatchlist: current?.name ?? "default", watchlist: current?.symbols ?? [] };
}

function editActive(st: TerminalState, edit: (symbols: string[]) => string[]) {
  const lists = st.watchlists.length ? st.watchlists : [{ name: st.activeWatchlist, symbols: [] }];
  return withLists(
    lists.map((l) => (l.name === st.activeWatchlist ? { ...l, symbols: edit(l.symbols) } : l)),
    st.activeWatchlist
  );
}

export const useTerminal = create<TerminalState>()(
  persist(
    (set) => ({
      activeSymbol: "AAPL",
      widgets: DEFAULT_WIDGETS,
      layout: DEFAULT_LAYOUT,
      watchlists: [{ name: "default", symbols: DEFAULT_SYMBOLS }],
      activeWatchlist: "default",
      watchlist: DEFAULT_SYMBOLS,
      commandOpen: false,
      setActiveSymbol: (s) => {
        const sym = normalizeSymbol(s);
        if (sym) set({ activeSymbol: sym });
      },
      setCommandOpen: (open) => set({ commandOpen: open }),
      addWidget: (type, symbol) =>
        set((st) => {
          const id = `w-${type}-${Date.now()}`;
          const size = SIZE_BY_TYPE[type];
          const maxY = st.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
          return {
            widgets: [...st.widgets, { id, type, symbol, linked: !symbol }],
            layout: [...st.layout, { i: id, x: 0, y: maxY, ...size }],
          };
        }),
      removeWidget: (id) =>
        set((st) => ({
          widgets: st.widgets.filter((w) => w.id !== id),
          layout: st.layout.filter((l) => l.i !== id),
        })),
      setWidgetSymbol: (id, symbol) => {
        const sym = normalizeSymbol(symbol);
        if (!sym) return;
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, symbol: sym, linked: false } : w)),
        }));
      },
      toggleLinked: (id) =>
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, linked: !w.linked } : w)),
        })),
      setLayout: (layout) => set({ layout }),
      addToWatchlist: (s) => {
        const sym = normalizeSymbol(s);
        if (!sym) return;
        set((st) => editActive(st, (list) => (list.includes(sym) ? list : [...list, sym])));
      },
      removeFromWatchlist: (s) => set((st) => editActive(st, (list) => list.filter((x) => x !== s))),
      setWatchlist: (symbols) => set((st) => editActive(st, () => symbols)),
      setWatchlists: (lists) => set((st) => withLists(lists, st.activeWatchlist)),
      setActiveWatchlist: (name) => set((st) => withLists(st.watchlists, name)),
      createWatchlist: (name) =>
        set((st) =>
          st.watchlists.some((l) => l.name === name)
            ? withLists(st.watchlists, name)
            : withLists([...st.watchlists, { name, symbols: [] }], name)
        ),
      deleteWatchlist: (name) =>
        set((st) => {
          const rest = st.watchlists.filter((l) => l.name !== name);
          return withLists(rest.length ? rest : [{ name: "default", symbols: [] }], st.activeWatchlist);
        }),
      resetWorkspace: () => set({ widgets: DEFAULT_WIDGETS, layout: DEFAULT_LAYOUT }),
    }),
    {
      name: "openterminal-workspace",
      version: 1,
      // Version 0 kept a single list in `watchlist`; it becomes the "default" list.
      migrate: (persisted, version) => {
        const st = (persisted ?? {}) as Partial<TerminalState>;
        if (version < 1 && Array.isArray(st.watchlist)) {
          return { ...st, ...withLists([{ name: "default", symbols: st.watchlist }], "default") } as TerminalState;
        }
        return st as TerminalState;
      },
    }
  )
);

/** Symbol a widget should display: its own, or the active one when linked. */
export function useWidgetSymbol(widget: WidgetInstance): string {
  const active = useTerminal((s) => s.activeSymbol);
  return widget.linked ? active : widget.symbol ?? active;
}
