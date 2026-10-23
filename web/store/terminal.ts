"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { FULL, SNAP_PRESETS, sanitizeRect, splitRect, tileRects, type Rect } from "../lib/layout";
import { isForeignSymbol, normalizeSymbol } from "../lib/symbol";
import { beat, clearBeat, openWidgetWindow } from "../lib/windows";

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
  | "fundamentals"
  | "tv"
  | "recap"
  | "ideas"
  | "details"
  | "research";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  symbol?: string;
  linked: boolean; // follows the globally active symbol
};

export type Watchlist = { name: string; symbols: string[] };

export type Pane = {
  id: string;
  /** Fractions of the workspace. */
  rect: Rect;
  /** Stacking order only; the pane's position in `panes` never changes on focus. */
  z: number;
  tabs: WidgetInstance[];
  activeTab: string | null;
  /** Set while maximized: where to go back to. */
  restore?: Rect;
};

export type OpenMode = "tab" | "right" | "below" | "window";

type TerminalState = {
  activeSymbol: string;
  /** Last 20 symbols opened with `openSymbol`, newest first. */
  recent: string[];
  panes: Pane[];
  focusedPane: string | null;
  /** Widgets living in their own browser window (route /window?w=<id>). */
  windows: WidgetInstance[];
  /** Every list, in display order. */
  watchlists: Watchlist[];
  activeWatchlist: string;
  /** Symbols of the active list (what the watchlist widget, calendar and palette use). */
  watchlist: string[];
  railOpen: boolean;
  watchlistOpen: boolean;
  watchlistWidth: number;
  commandOpen: boolean;
  setActiveSymbol: (s: string) => void;
  /** Sets the active symbol, records it in `recent`, and makes sure a chart and a quote are open. */
  openSymbol: (s: string) => void;
  setCommandOpen: (open: boolean) => void;
  /** Focuses an existing tab of `type`, otherwise adds one by `mode`. 'window' always targets a window. */
  openOrFocus: (type: WidgetType, mode: OpenMode) => void;
  /** Always creates a new tab (in `paneId`, default the focused pane). Alias: addWidget(type, symbol). */
  addTab: (type: WidgetType, opts?: { paneId?: string; symbol?: string }) => void;
  addWidget: (type: WidgetType, symbol?: string) => void;
  /** Always creates a new pane by splitting the focused one. */
  addPane: (type: WidgetType, dir: "right" | "below", symbol?: string) => void;
  removeWidget: (id: string) => void;
  setActiveTab: (paneId: string, widgetId: string) => void;
  /** Moves a tab (from a pane or a window) into `paneId` at `index` (default end). */
  moveTab: (widgetId: string, paneId: string, index?: number) => void;
  focusPane: (id: string) => void;
  setPaneRect: (id: string, rect: Rect) => void;
  snapPane: (id: string, presetKey: string) => void;
  toggleMaximize: (id: string) => void;
  tilePanes: () => void;
  /** Always creates a new widget in its own browser window. */
  addWindow: (type: WidgetType) => void;
  /** Moves the widget to its own browser window and opens it. */
  popOut: (widgetId: string) => void;
  /** Puts a windowed widget back as a tab in the focused pane. */
  dockWindow: (widgetId: string) => void;
  setWidgetSymbol: (id: string, symbol: string) => void;
  toggleLinked: (id: string) => void;
  addToWatchlist: (s: string) => void;
  removeFromWatchlist: (s: string) => void;
  setWatchlist: (symbols: string[]) => void;
  /** Replaces every list at once (used when the server's copy is loaded). */
  setWatchlists: (lists: Watchlist[]) => void;
  setActiveWatchlist: (name: string) => void;
  createWatchlist: (name: string) => void;
  deleteWatchlist: (name: string) => void;
  setRailOpen: (open: boolean) => void;
  setWatchlistOpen: (open: boolean) => void;
  setWatchlistWidth: (w: number) => void;
  resetWorkspace: () => void;
};

const RECENT_MAX = 20;
export const WATCHLIST_WIDTH = { min: 180, max: 420, initial: 300 };

const widget = (type: WidgetType, linked: boolean, symbol?: string): WidgetInstance => ({
  id: `w-${type}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`,
  type,
  symbol,
  linked,
});

const SYMBOL_AWARE: ReadonlySet<WidgetType> = new Set(["quote", "chart", "news", "options", "insider", "fundamentals", "details", "research"]);

function defaultPanes(): Pane[] {
  const pane = (id: string, rect: Rect, z: number, tabs: WidgetInstance[]): Pane => ({
    id, rect, z, tabs, activeTab: tabs[0]?.id ?? null,
  });
  return [
    pane("p-chart", { x: 0, y: 0, w: 0.64, h: 0.55 }, 1, [{ id: "w-chart", type: "chart", linked: true }]),
    pane("p-details", { x: 0, y: 0.55, w: 0.64, h: 0.45 }, 2, [{ id: "w-details", type: "details", linked: true }]),
    pane("p-quote", { x: 0.64, y: 0, w: 0.36, h: 0.46 }, 3, [{ id: "w-quote", type: "quote", linked: true }]),
    pane("p-research", { x: 0.64, y: 0.46, w: 0.36, h: 0.54 }, 4, [
      { id: "w-research", type: "research", linked: true },
      { id: "w-ideas", type: "ideas", linked: false },
    ]),
  ];
}

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

type Layoutish = Pick<TerminalState, "panes" | "focusedPane" | "windows">;

const topZ = (panes: Pane[]) => panes.reduce((m, p) => Math.max(m, p.z), 0);
const newPaneId = () => `p-${Math.random().toString(36).slice(2, 8)}`;

/** Focused pane, else the top-most one, else undefined. */
function focusedOf(st: Layoutish): Pane | undefined {
  return st.panes.find((p) => p.id === st.focusedPane) ?? [...st.panes].sort((a, b) => b.z - a.z)[0];
}

function findTab(st: Layoutish, widgetId: string) {
  for (const p of st.panes) {
    const w = p.tabs.find((t) => t.id === widgetId);
    if (w) return { pane: p, widget: w };
  }
  return null;
}

function hasType(st: Layoutish, type: WidgetType) {
  return st.panes.some((p) => p.tabs.some((t) => t.type === type)) || st.windows.some((w) => w.type === type);
}

function mapWidgets(st: Layoutish, fn: (w: WidgetInstance) => WidgetInstance): Layoutish {
  return {
    ...st,
    panes: st.panes.map((p) => ({ ...p, tabs: p.tabs.map(fn) })),
    windows: st.windows.map(fn),
  };
}

/** Takes the widget out of its pane or window; drops a pane that becomes empty (never the last one). */
function detach(st: Layoutish, widgetId: string): Layoutish {
  const windows = st.windows.filter((w) => w.id !== widgetId);
  let panes = st.panes.map((p) => {
    const i = p.tabs.findIndex((t) => t.id === widgetId);
    if (i < 0) return p;
    const tabs = p.tabs.filter((t) => t.id !== widgetId);
    const activeTab = p.activeTab === widgetId ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : p.activeTab;
    return { ...p, tabs, activeTab };
  });
  if (panes.length > 1) panes = panes.filter((p) => p.tabs.length > 0);
  const focusedPane = panes.some((p) => p.id === st.focusedPane)
    ? st.focusedPane
    : [...panes].sort((a, b) => b.z - a.z)[0]?.id ?? null;
  return { panes, focusedPane, windows };
}

function insertTab(st: Layoutish, paneId: string, w: WidgetInstance, index?: number): Layoutish {
  const z = topZ(st.panes) + 1;
  const panes = st.panes.map((p) => {
    if (p.id !== paneId) return p;
    const tabs = [...p.tabs];
    tabs.splice(index ?? tabs.length, 0, w);
    return { ...p, tabs, activeTab: w.id, z };
  });
  return { ...st, panes, focusedPane: paneId };
}

/** Adds the widget as a tab in the focused pane, creating a full-size pane when none exist. */
function addToFocused(st: Layoutish, w: WidgetInstance): Layoutish {
  const target = focusedOf(st);
  if (target) return insertTab(st, target.id, w);
  const pane: Pane = { id: newPaneId(), rect: FULL, z: 1, tabs: [w], activeTab: w.id };
  return { ...st, panes: [pane], focusedPane: pane.id };
}

/** Un-maximizes every pane so splitting works on real rects. */
function restoreAll(panes: Pane[]): Pane[] {
  return panes.map((p) => (p.restore ? { ...p, rect: p.restore, restore: undefined } : p));
}

function splitFocused(st: Layoutish, w: WidgetInstance, dir: "right" | "below"): Layoutish {
  const panes0 = restoreAll(st.panes);
  const target = focusedOf({ ...st, panes: panes0 });
  if (!target) return addToFocused(st, w);
  const [kept, fresh] = splitRect(target.rect, dir);
  const z = topZ(panes0) + 1;
  const pane: Pane = { id: newPaneId(), rect: fresh, z, tabs: [w], activeTab: w.id };
  return {
    ...st,
    panes: [...panes0.map((p) => (p.id === target.id ? { ...p, rect: kept } : p)), pane],
    focusedPane: pane.id,
  };
}

function raise(st: Layoutish, paneId: string): Layoutish {
  const pane = st.panes.find((p) => p.id === paneId);
  if (!pane) return st;
  if (st.focusedPane === paneId && pane.z === topZ(st.panes)) return st;
  const z = topZ(st.panes) + 1;
  return { ...st, panes: st.panes.map((p) => (p.id === paneId ? { ...p, z } : p)), focusedPane: paneId };
}

export const useTerminal = create<TerminalState>()(
  persist(
    (set, get) => ({
      activeSymbol: "AAPL",
      recent: [],
      panes: defaultPanes(),
      focusedPane: "p-chart",
      windows: [],
      watchlists: [{ name: "default", symbols: DEFAULT_SYMBOLS }],
      activeWatchlist: "default",
      watchlist: DEFAULT_SYMBOLS,
      railOpen: true,
      watchlistOpen: true,
      watchlistWidth: WATCHLIST_WIDTH.initial,
      commandOpen: false,
      setActiveSymbol: (s) => {
        const sym = normalizeSymbol(s);
        if (sym) set({ activeSymbol: sym });
      },
      openSymbol: (s) => {
        const sym = normalizeSymbol(s);
        if (!sym) return;
        set((st) => ({ activeSymbol: sym, recent: [sym, ...st.recent.filter((x) => x !== sym)].slice(0, RECENT_MAX) }));
        for (const type of ["chart", "quote"] as const) {
          if (!hasType(get(), type)) set((st) => splitFocused(st, widget(type, true), "right"));
        }
      },
      setCommandOpen: (open) => set({ commandOpen: open }),
      openOrFocus: (type, mode) => {
        const st = get();
        if (mode === "window") {
          const existing = st.windows.find((w) => w.type === type);
          if (existing) {
            if (!openWidgetWindow(existing.id)) get().dockWindow(existing.id);
            return;
          }
          get().addWindow(type);
          return;
        }
        for (const p of st.panes) {
          const tab = p.tabs.find((t) => t.type === type);
          if (tab) {
            set((s) => raise({ ...s, panes: s.panes.map((x) => (x.id === p.id ? { ...x, activeTab: tab.id } : x)) }, p.id));
            return;
          }
        }
        const w = widget(type, SYMBOL_AWARE.has(type));
        set((s) => (mode === "tab" ? addToFocused(s, w) : splitFocused(s, w, mode)));
      },
      addTab: (type, opts) =>
        set((st) => {
          const w = widget(type, !opts?.symbol, opts?.symbol);
          return opts?.paneId && st.panes.some((p) => p.id === opts.paneId)
            ? insertTab(st, opts.paneId, w)
            : addToFocused(st, w);
        }),
      addWindow: (type) => {
        const w = widget(type, SYMBOL_AWARE.has(type));
        set((s) => ({ windows: [...s.windows, w] }));
        beat(w.id);
        if (!openWidgetWindow(w.id)) get().dockWindow(w.id);
      },
      addWidget: (type, symbol) => get().addTab(type, { symbol }),
      addPane: (type, dir, symbol) => set((st) => splitFocused(st, widget(type, !symbol, symbol), dir)),
      removeWidget: (id) => set((st) => detach(st, id)),
      setActiveTab: (paneId, widgetId) =>
        set((st) =>
          raise({ ...st, panes: st.panes.map((p) => (p.id === paneId ? { ...p, activeTab: widgetId } : p)) }, paneId)
        ),
      moveTab: (widgetId, paneId, index) =>
        set((st) => {
          const w = findTab(st, widgetId)?.widget ?? st.windows.find((x) => x.id === widgetId);
          if (!w || !st.panes.some((p) => p.id === paneId)) return st;
          return insertTab(detach(st, widgetId), paneId, w, index);
        }),
      focusPane: (id) => set((st) => raise(st, id)),
      setPaneRect: (id, rect) =>
        set((st) => ({
          panes: st.panes.map((p) => (p.id === id ? { ...p, rect: sanitizeRect(rect, p.rect), restore: undefined } : p)),
        })),
      snapPane: (id, key) => {
        const preset = SNAP_PRESETS.find((p) => p.key === key);
        if (!preset) return;
        set((st) =>
          raise({ ...st, panes: st.panes.map((p) => (p.id === id ? { ...p, rect: preset.rect, restore: undefined } : p)) }, id)
        );
      },
      toggleMaximize: (id) =>
        set((st) =>
          raise(
            {
              ...st,
              panes: st.panes.map((p) =>
                p.id !== id ? p : p.restore ? { ...p, rect: p.restore, restore: undefined } : { ...p, restore: p.rect, rect: FULL }
              ),
            },
            id
          )
        ),
      tilePanes: () =>
        set((st) => {
          const rects = tileRects(st.panes.length);
          return { panes: st.panes.map((p, i) => ({ ...p, rect: rects[i], restore: undefined })) };
        }),
      popOut: (widgetId) => {
        const st = get();
        const w = findTab(st, widgetId)?.widget;
        if (!w) return;
        set((s) => {
          const rest = detach(s, widgetId);
          return { ...rest, windows: [...rest.windows, w] };
        });
        beat(w.id);
        if (!openWidgetWindow(w.id)) get().dockWindow(w.id);
      },
      dockWindow: (widgetId) => {
        clearBeat(widgetId);
        set((st) => {
          const w = st.windows.find((x) => x.id === widgetId);
          if (!w) return st;
          return addToFocused({ ...st, windows: st.windows.filter((x) => x.id !== widgetId) }, w);
        });
      },
      setWidgetSymbol: (id, symbol) => {
        const sym = normalizeSymbol(symbol);
        if (!sym) return;
        set((st) => mapWidgets(st, (w) => (w.id === id ? { ...w, symbol: sym, linked: false } : w)));
      },
      toggleLinked: (id) => set((st) => mapWidgets(st, (w) => (w.id === id ? { ...w, linked: !w.linked } : w))),
      addToWatchlist: (s) => {
        const sym = normalizeSymbol(s);
        if (!sym || isForeignSymbol(sym)) return;
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
      setRailOpen: (railOpen) => set({ railOpen }),
      setWatchlistOpen: (watchlistOpen) => set({ watchlistOpen }),
      setWatchlistWidth: (w) =>
        set({ watchlistWidth: Math.round(Math.min(WATCHLIST_WIDTH.max, Math.max(WATCHLIST_WIDTH.min, w))) }),
      resetWorkspace: () => set({ panes: defaultPanes(), focusedPane: "p-chart", windows: [] }),
    }),
    {
      name: "openterminal-workspace",
      version: 2,
      // Transient UI state stays out of storage (and out of cross-window sync).
      partialize: (st) => {
        const persisted: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(st)) if (typeof v !== "function" && k !== "commandOpen") persisted[k] = v;
        return persisted as unknown as TerminalState;
      },
      // Version 0 kept a single list in `watchlist`; it becomes the "default" list.
      // Version 1 used a 12-column grid (`widgets` + `layout`); that layout is dropped
      // for the default panes, keeping watchlists and the active symbol.
      migrate: (persisted, version) => {
        let st = (persisted ?? {}) as Record<string, unknown> & Partial<TerminalState>;
        if (version < 1 && Array.isArray(st.watchlist)) {
          st = { ...st, ...withLists([{ name: "default", symbols: st.watchlist }], "default") };
        }
        if (version < 2 && (st.widgets !== undefined || st.layout !== undefined)) {
          st = { ...st };
          delete st.widgets;
          delete st.layout;
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

/** Keeps this window's store in step with writes from other windows (pop-outs, other tabs). */
export function syncStoreAcrossWindows(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === useTerminal.persist.getOptions().name) void useTerminal.persist.rehydrate();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export { SYMBOL_AWARE };
