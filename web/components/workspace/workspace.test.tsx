import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminal } from "../../store/terminal";
import Rail from "./Rail";
import Workspace from "../Workspace";

vi.mock("../widgets/ChartWidget", () => ({ default: () => <div>chart body</div> }));

beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => ({ focus: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => null, headers: new Headers() }) as Response));
  useTerminal.getState().resetWorkspace();
  useTerminal.setState({ railOpen: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

describe("Workspace", () => {
  it("keeps pane elements in the same DOM order when focus changes", () => {
    const { container } = wrap(<Workspace />);
    const order = () => [...container.querySelectorAll("[data-pane]")].map((e) => e.getAttribute("data-pane"));
    const before = order();
    const el = container.querySelector('[data-pane="p-quote"]')!;
    fireEvent.pointerDown(el);
    expect(order()).toEqual(before);
    expect(container.querySelector('[data-pane="p-quote"]')).toBe(el);
    expect(useTerminal.getState().focusedPane).toBe("p-quote");
  });

  it("scrolls the tab strip sideways on wheel", () => {
    const { container } = wrap(<Workspace />);
    const strip = container.querySelector('[data-pane="p-research"] .tab-strip') as HTMLElement;
    Object.defineProperty(strip, "scrollLeft", { value: 0, writable: true, configurable: true });
    const ev = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    strip.dispatchEvent(ev);
    expect(strip.scrollLeft).toBe(40);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("shows a scroll button only on the side where the strip is clipped", () => {
    const { container } = wrap(<Workspace />);
    const strip = container.querySelector('[data-pane="p-research"] .tab-strip') as HTMLElement;
    const set = (k: string, v: number) => Object.defineProperty(strip, k, { value: v, configurable: true });
    set("scrollLeft", 0);
    set("clientWidth", 100);
    set("scrollWidth", 300);
    fireEvent.scroll(strip);
    expect(screen.queryByLabelText("Scroll tabs left")).toBeNull();
    expect(screen.getAllByLabelText("Scroll tabs right").length).toBeGreaterThan(0);
    set("scrollLeft", 200);
    fireEvent.scroll(strip);
    expect(screen.getAllByLabelText("Scroll tabs left").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Scroll tabs right")).toBeNull();
  });

  it("closing a tab removes it, and the tab strip shows each tab as its own control", () => {
    const { container } = wrap(<Workspace />);
    // Only the pane strips: widgets (details) have their own tab rows.
    const paneTabs = () => container.querySelectorAll('.ptab [role="tab"]').length;
    expect(paneTabs()).toBe(5);
    fireEvent.click(screen.getByLabelText("Close Ideas"));
    expect(paneTabs()).toBe(4);
  });
});

describe("Rail", () => {
  it("shows open counts and the four add options", () => {
    wrap(<Rail />);
    const chartRow = screen.getByRole("button", { name: /Chart/ });
    expect(within(chartRow).getByText("1 open")).toBeTruthy();
    fireEvent.click(chartRow);
    fireEvent.click(screen.getByText("New pane below"));
    expect(useTerminal.getState().panes).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: /^Quote/ }));
    fireEvent.click(screen.getByText("Open in its own window"));
    expect(useTerminal.getState().windows.map((w) => w.type)).toEqual(["quote"]);
  });

  it("collapses to an icon column with badges and opens a flyout", () => {
    useTerminal.setState({ railOpen: false });
    wrap(<Rail />);
    const btn = screen.getByRole("button", { name: "Chart · 1 open" });
    expect(btn.textContent).toBe("1");
    fireEvent.click(btn);
    expect(screen.getByRole("menu", { name: "Add Chart" })).toBeTruthy();
    fireEvent.click(screen.getByText("New pane to the right"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useTerminal.getState().panes).toHaveLength(5);
  });
});
