import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminal, type WidgetType } from "../../store/terminal";
import Rail from "./Rail";
import { GROUPS, WIDGETS } from "./registry";

// Rail rows come from the registry. Checks here cover that wiring; the add menu itself is in workspace.test.tsx.

const nav = () => screen.getByRole("navigation", { name: "Panels" });

beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => ({ focus: vi.fn() })));
  useTerminal.getState().resetWorkspace();
  useTerminal.setState({ railOpen: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The expanded row for a registry type: a button whose label span is the registry label. */
const expandedRow = (type: WidgetType) =>
  within(nav()).getByText(WIDGETS[type].label, { selector: ".pitem span" }).closest("button")!;

describe("Rail groups from the registry", () => {
  it("renders every group heading in registry order, with each type's row under it", () => {
    render(<Rail />);
    const headings = [...nav().querySelectorAll(".px-3\\.5.pt-3")].map((h) => h.textContent);
    expect(headings).toEqual(GROUPS.map((g) => g.name));

    for (const g of GROUPS) {
      for (const type of g.types) {
        expect(expandedRow(type).textContent).toContain(WIDGETS[type].label);
      }
    }
  });

  it("lists every registry widget exactly once", () => {
    const listed = GROUPS.flatMap((g) => g.types);
    expect([...listed].sort()).toEqual(Object.keys(WIDGETS).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("the collapsed rail has one icon per registry type, labelled with its registry name", () => {
    useTerminal.setState({ railOpen: false });
    render(<Rail />);
    for (const g of GROUPS) {
      for (const type of g.types) {
        // The name gains " · n open" while the type has tabs or windows.
        expect(screen.getByRole("button", { name: new RegExp(`^${WIDGETS[type].label}( · \\d+ open)?$`) })).toBeTruthy();
      }
    }
    expect(screen.getAllByRole("separator")).toHaveLength(GROUPS.length);
  });
});

describe("Rail open counts", () => {
  it("a type's count goes up as tabs and windows of that type are added", () => {
    render(<Rail />);
    expect(expandedRow("news").querySelector(".pcount")).toBeNull();

    act(() => { useTerminal.getState().addTab("news"); });
    expect(expandedRow("news").querySelector(".pcount")!.textContent).toBe("1 open");

    act(() => { useTerminal.getState().addWindow("news"); });
    expect(expandedRow("news").querySelector(".pcount")!.textContent).toBe("2 open");
  });

  it("counts a widget in the default layout and drops it when closed", () => {
    render(<Rail />);
    expect(expandedRow("ideas").querySelector(".pcount")!.textContent).toBe("1 open");
    act(() => { useTerminal.getState().removeWidget("w-ideas"); });
    expect(expandedRow("ideas").querySelector(".pcount")).toBeNull();
  });

  it("collapsed badges equal the open counts, and a zero count has no badge", () => {
    act(() => { useTerminal.getState().addWindow("quote"); });
    act(() => { useTerminal.getState().addTab("news"); });
    act(() => { useTerminal.getState().addTab("news"); });
    useTerminal.setState({ railOpen: false });
    render(<Rail />);

    const expected: Partial<Record<WidgetType, number>> = { chart: 1, quote: 2, news: 2, research: 1, ideas: 1, details: 1 };
    for (const g of GROUPS) {
      for (const type of g.types) {
        const n = expected[type] ?? 0;
        const label = WIDGETS[type].label;
        const btn = screen.getByRole("button", { name: n ? `${label} · ${n} open` : label });
        const badge = btn.querySelector(".pbadge");
        if (n) expect(badge!.textContent).toBe(String(n));
        else expect(badge).toBeNull();
      }
    }
  });

  it("collapsed badges follow the store when tabs are added", () => {
    useTerminal.setState({ railOpen: false });
    render(<Rail />);
    expect(screen.getByRole("button", { name: "Calendar" }).querySelector(".pbadge")).toBeNull();
    act(() => { useTerminal.getState().addTab("calendar"); });
    expect(screen.getByRole("button", { name: "Calendar · 1 open" }).querySelector(".pbadge")!.textContent).toBe("1");
  });
});
