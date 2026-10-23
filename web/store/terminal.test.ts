import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminal } from "./terminal";

const reset = () =>
  useTerminal.setState({
    watchlists: [{ name: "default", symbols: ["AAPL", "MSFT"] }],
    activeWatchlist: "default",
    watchlist: ["AAPL", "MSFT"],
  });

describe("watchlist actions", () => {
  beforeEach(reset);
  const s = () => useTerminal.getState();

  it("addToWatchlist normalizes, dedupes and ignores invalid symbols", () => {
    s().addToWatchlist(" nvda ");
    s().addToWatchlist("NVDA");
    s().addToWatchlist("bad symbol");
    expect(s().watchlist).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(s().watchlists[0].symbols).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("removeFromWatchlist edits only the active list", () => {
    s().createWatchlist("Other");
    s().addToWatchlist("TSLA");
    s().removeFromWatchlist("TSLA");
    expect(s().watchlist).toEqual([]);
    expect(s().watchlists.find((l) => l.name === "default")!.symbols).toEqual(["AAPL", "MSFT"]);
  });

  it("createWatchlist switches to the new list; an existing name just switches", () => {
    s().createWatchlist("Tech");
    expect(s().activeWatchlist).toBe("Tech");
    expect(s().watchlist).toEqual([]);
    s().createWatchlist("default");
    expect(s().activeWatchlist).toBe("default");
    expect(s().watchlists).toHaveLength(2);
  });

  it("setActiveWatchlist keeps `watchlist` in step; unknown name falls back to the first", () => {
    s().createWatchlist("Tech");
    s().setActiveWatchlist("default");
    expect(s().watchlist).toEqual(["AAPL", "MSFT"]);
    s().setActiveWatchlist("nope");
    expect(s().activeWatchlist).toBe("default");
  });

  it("deleteWatchlist falls back to another list, or an empty default when none remain", () => {
    s().createWatchlist("Tech");
    s().deleteWatchlist("Tech");
    expect(s().activeWatchlist).toBe("default");
    s().deleteWatchlist("default");
    expect(s().watchlists).toEqual([{ name: "default", symbols: [] }]);
    expect(s().watchlist).toEqual([]);
  });

  it("setWatchlists replaces all lists and keeps the active one when it still exists", () => {
    s().setWatchlists([
      { name: "A", symbols: ["X"] },
      { name: "default", symbols: ["Y"] },
    ]);
    expect(s().activeWatchlist).toBe("default");
    expect(s().watchlist).toEqual(["Y"]);
    s().setWatchlists([{ name: "A", symbols: ["X"] }]);
    expect(s().activeWatchlist).toBe("A");
  });
});

describe("persist migrate", () => {
  const migrate = (persisted: unknown, version: number) =>
    useTerminal.persist.getOptions().migrate!(persisted, version) as any;

  it("version 0 single list becomes the default list", () => {
    const out = migrate({ watchlist: ["AAPL", "IBM"], activeSymbol: "IBM" }, 0);
    expect(out.watchlists).toEqual([{ name: "default", symbols: ["AAPL", "IBM"] }]);
    expect(out.activeWatchlist).toBe("default");
    expect(out.watchlist).toEqual(["AAPL", "IBM"]);
    expect(out.activeSymbol).toBe("IBM");
  });

  it("version 1 grid layout is dropped; watchlists and active symbol are kept", () => {
    const st = {
      activeSymbol: "IBM",
      watchlists: [{ name: "A", symbols: ["X"] }],
      watchlist: ["X"],
      widgets: [{ id: "w-chart", type: "chart", linked: true }],
      layout: [{ i: "w-chart", x: 0, y: 0, w: 7, h: 12 }],
    };
    const out = migrate(st, 1);
    expect(out).toEqual({ activeSymbol: "IBM", watchlists: st.watchlists, watchlist: ["X"], nearMissOpen: true });
    expect(out.widgets).toBeUndefined();
  });

  it("version 2 state gains the near-miss group, open; version 3 state passes through; null is tolerated", () => {
    const st = { watchlists: [{ name: "A", symbols: [] }], watchlist: [] };
    expect(migrate(st, 2)).toEqual({ ...st, nearMissOpen: true });
    const v3 = { ...st, nearMissOpen: false };
    expect(migrate(v3, 3)).toEqual(v3);
    expect(migrate(v3, 2)).toEqual(v3);
    expect(migrate(null, 0)).toEqual({ nearMissOpen: true });
  });
});

describe("panes", () => {
  const s = () => useTerminal.getState();
  const tabTypes = () => s().panes.flatMap((p) => p.tabs.map((t) => t.type));
  beforeEach(() => {
    vi.stubGlobal("open", vi.fn(() => ({ focus: vi.fn() })));
    s().resetWorkspace();
    useTerminal.setState({ recent: [], activeSymbol: "AAPL" });
  });

  it("default layout: chart, details, quote, and research + ideas as two tabs", () => {
    expect(s().panes.map((p) => p.tabs.map((t) => t.type))).toEqual([
      ["chart"], ["details"], ["quote"], ["research", "ideas"],
    ]);
    expect(s().panes[0].rect).toEqual({ x: 0, y: 0, w: 0.64, h: 0.55 });
    expect(s().panes[3].rect).toEqual({ x: 0.64, y: 0.46, w: 0.36, h: 0.54 });
  });

  it("addTab adds an active tab to the focused pane", () => {
    s().focusPane("p-quote");
    s().addTab("news");
    const pane = s().panes.find((p) => p.id === "p-quote")!;
    expect(pane.tabs.map((t) => t.type)).toEqual(["quote", "news"]);
    expect(pane.activeTab).toBe(pane.tabs[1].id);
  });

  it("addPane splits the focused pane and focuses the new one", () => {
    s().addPane("news", "right");
    const [kept, fresh] = [s().panes[0], s().panes[4]];
    expect(kept.rect.w).toBeCloseTo(0.32);
    expect(fresh.rect).toEqual({ x: 0.32, y: 0, w: 0.32, h: 0.55 });
    expect(s().focusedPane).toBe(fresh.id);
  });

  it("removeWidget drops an emptied pane but never the last one", () => {
    s().removeWidget("w-chart");
    expect(s().panes).toHaveLength(3);
    for (const p of [...s().panes]) p.tabs.forEach((t) => s().removeWidget(t.id));
    expect(s().panes).toHaveLength(1);
    expect(s().panes[0].tabs).toEqual([]);
    s().addTab("chart");
    expect(s().panes[0].tabs).toHaveLength(1);
  });

  it("focusPane raises z-order without reordering panes", () => {
    const order = s().panes.map((p) => p.id);
    s().focusPane("p-chart");
    expect(s().panes.map((p) => p.id)).toEqual(order);
    const chart = s().panes.find((p) => p.id === "p-chart")!;
    expect(Math.max(...s().panes.map((p) => p.z))).toBe(chart.z);
    expect(s().focusedPane).toBe("p-chart");
  });

  it("moveTab moves between panes and removes the emptied source", () => {
    s().moveTab("w-quote", "p-chart");
    expect(s().panes.find((p) => p.id === "p-chart")!.tabs.map((t) => t.id)).toEqual(["w-chart", "w-quote"]);
    expect(s().panes.some((p) => p.id === "p-quote")).toBe(false);
  });

  it("snapPane, toggleMaximize and tilePanes set rects", () => {
    s().snapPane("p-quote", "left");
    expect(s().panes.find((p) => p.id === "p-quote")!.rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    const before = s().panes.find((p) => p.id === "p-details")!.rect;
    s().toggleMaximize("p-details");
    expect(s().panes.find((p) => p.id === "p-details")!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    s().toggleMaximize("p-details");
    expect(s().panes.find((p) => p.id === "p-details")!.rect).toEqual(before);
    s().tilePanes();
    expect(s().panes.map((p) => p.rect)).toEqual([
      { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ]);
  });

  it("openSymbol sets the symbol, tracks recent (deduped, max 20) and restores missing chart/quote", () => {
    s().removeWidget("w-chart");
    s().removeWidget("w-quote");
    expect(tabTypes()).not.toContain("chart");
    s().openSymbol(" msft ");
    expect(s().activeSymbol).toBe("MSFT");
    expect(tabTypes()).toContain("chart");
    expect(tabTypes()).toContain("quote");
    for (let i = 0; i < 25; i++) s().openSymbol(`A${i}`);
    s().openSymbol("A5");
    expect(s().recent).toHaveLength(20);
    expect(s().recent[0]).toBe("A5");
    expect(s().recent.filter((x) => x === "A5")).toHaveLength(1);
    s().openSymbol("bad symbol");
    expect(s().activeSymbol).toBe("A5");
  });

  it("openSymbol does not add tabs when a chart and quote already exist", () => {
    const n = tabTypes().length;
    s().openSymbol("NVDA");
    expect(tabTypes()).toHaveLength(n);
  });

  it("openOrFocus focuses an existing tab, else adds by mode", () => {
    s().openOrFocus("ideas", "tab");
    const research = s().panes.find((p) => p.id === "p-research")!;
    expect(research.activeTab).toBe("w-ideas");
    expect(s().focusedPane).toBe("p-research");
    expect(tabTypes().filter((t) => t === "ideas")).toHaveLength(1);

    s().openOrFocus("news", "below");
    expect(s().panes).toHaveLength(5);
    expect(s().panes[4].tabs[0].type).toBe("news");
    s().openOrFocus("calendar", "tab");
    expect(s().panes.find((p) => p.id === s().focusedPane)!.tabs.at(-1)!.type).toBe("calendar");
  });

  it("window mode opens a window, reuses it, and dockWindow returns the widget as a tab", () => {
    s().openOrFocus("options", "window");
    expect(s().windows).toHaveLength(1);
    expect(window.open).toHaveBeenCalledTimes(1);
    const id = s().windows[0].id;
    s().openOrFocus("options", "window");
    expect(s().windows).toHaveLength(1);
    s().focusPane("p-quote");
    s().dockWindow(id);
    expect(s().windows).toEqual([]);
    expect(s().panes.find((p) => p.id === "p-quote")!.tabs.at(-1)!.type).toBe("options");
  });

  it("popOut moves a tab to a window; a blocked popup docks it straight back", () => {
    s().popOut("w-chart");
    expect(s().windows.map((w) => w.type)).toEqual(["chart"]);
    expect(s().panes.some((p) => p.id === "p-chart")).toBe(false);
    s().dockWindow(s().windows[0].id);
    vi.stubGlobal("open", vi.fn(() => null));
    s().popOut("w-quote");
    expect(s().windows).toEqual([]);
    expect(tabTypes()).toContain("quote");
  });

  it("setWidgetSymbol and toggleLinked reach widgets in windows too", () => {
    s().addWindow("news");
    const id = s().windows[0].id;
    s().setWidgetSymbol(id, "ibm");
    expect(s().windows[0]).toMatchObject({ symbol: "IBM", linked: false });
    s().toggleLinked(id);
    expect(s().windows[0].linked).toBe(true);
  });

  it("setWatchlistWidth clamps", () => {
    s().setWatchlistWidth(5);
    expect(s().watchlistWidth).toBe(180);
    s().setWatchlistWidth(9999);
    expect(s().watchlistWidth).toBe(420);
  });
});
