import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminal } from "./terminal";

// Cross-action flows. Single-action behaviour lives in terminal.test.ts.
const s = () => useTerminal.getState();
const allTypes = () => s().panes.flatMap((p) => p.tabs.map((t) => t.type));

beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => ({ focus: vi.fn() })));
  s().resetWorkspace();
  useTerminal.setState({ recent: [], activeSymbol: "AAPL" });
});

describe("openSymbol flows", () => {
  it("records recent newest first and moves a repeat symbol to the front", () => {
    s().openSymbol("aapl");
    s().openSymbol("msft");
    s().openSymbol("NVDA");
    s().openSymbol("aapl");
    expect(s().recent).toEqual(["AAPL", "NVDA", "MSFT"]);
    expect(s().activeSymbol).toBe("AAPL");
  });

  it("adds only the missing quote when a chart is already open", () => {
    s().removeWidget("w-quote");
    s().openSymbol("TSLA");
    expect(allTypes().filter((t) => t === "chart")).toHaveLength(1);
    expect(allTypes().filter((t) => t === "quote")).toHaveLength(1);
    expect(s().panes.find((p) => p.id === s().focusedPane)!.tabs.map((t) => t.type)).toEqual(["quote"]);
  });
});

describe("openOrFocus flows", () => {
  it("right and below focus an existing tab of that type instead of splitting again", () => {
    const before = s().panes.length;
    s().openOrFocus("quote", "right");
    s().openOrFocus("chart", "below");
    expect(s().panes).toHaveLength(before);
    expect(s().focusedPane).toBe("p-chart");
    expect(s().panes.find((p) => p.id === "p-chart")!.activeTab).toBe("w-chart");
  });

  it("window mode reopens the existing window and does not dock it", () => {
    s().openOrFocus("options", "window");
    const id = s().windows[0].id;
    const opened = vi.mocked(window.open).mock.calls.length;
    s().openOrFocus("options", "window");
    expect(vi.mocked(window.open).mock.calls.length).toBe(opened + 1);
    expect(s().windows.map((w) => w.id)).toEqual([id]);
    expect(allTypes()).not.toContain("options");
  });

  it("window mode docks the existing window when the browser blocks reopening it", () => {
    s().openOrFocus("options", "window");
    vi.stubGlobal("open", vi.fn(() => null));
    s().openOrFocus("options", "window");
    expect(s().windows).toEqual([]);
    expect(allTypes()).toContain("options");
  });
});

describe("pop out and dock", () => {
  it("popOut then dockWindow returns the widget as the active tab of the focused pane", () => {
    s().popOut("w-details");
    expect(allTypes()).not.toContain("details");
    expect(s().windows.map((w) => w.type)).toEqual(["details"]);

    s().focusPane("p-quote");
    s().dockWindow(s().windows[0].id);
    const pane = s().panes.find((p) => p.id === "p-quote")!;
    expect(s().windows).toEqual([]);
    expect(pane.tabs.map((t) => t.type)).toEqual(["quote", "details"]);
    expect(pane.activeTab).toBe(pane.tabs[1].id);
    expect(s().focusedPane).toBe("p-quote");
  });
});

describe("removing tabs", () => {
  it("removing the last tab of a pane removes the pane, and focus moves to a remaining one", () => {
    s().focusPane("p-details");
    s().removeWidget("w-details");
    expect(s().panes.some((p) => p.id === "p-details")).toBe(false);
    expect(s().panes).toHaveLength(3);
    expect(s().panes.map((p) => p.id)).toContain(s().focusedPane);
  });
});

describe("resetWorkspace", () => {
  it("restores the default four-pane layout and clears windows after changes", () => {
    s().addPane("news", "right");
    s().removeWidget("w-quote");
    s().addWindow("calendar");
    s().snapPane("p-chart", "left");
    s().resetWorkspace();

    expect(s().panes.map((p) => p.id)).toEqual(["p-chart", "p-details", "p-quote", "p-research"]);
    expect(s().panes.map((p) => p.tabs.map((t) => t.type))).toEqual([
      ["chart"], ["details"], ["quote"], ["research", "ideas"],
    ]);
    expect(s().panes.every((p) => p.restore === undefined)).toBe(true);
    expect(s().panes[0].rect).toEqual({ x: 0, y: 0, w: 0.64, h: 0.55 });
    expect(s().windows).toEqual([]);
    expect(s().focusedPane).toBe("p-chart");
  });
});
