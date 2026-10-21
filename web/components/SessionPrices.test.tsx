import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtendedHours, Quote, SessionPrice } from "../lib/api";
import { ExtendedPrices, RegularPrice, SessionCell } from "./SessionPrices";

afterEach(cleanup);

const sp = (price: number, changePercent: number, live = false): SessionPrice => ({
  price,
  change: price - 100,
  changePercent,
  time: "2026-10-20T20:30:00Z",
  live,
});
const quote = (extended?: Partial<ExtendedHours>, over: Partial<Quote> = {}) =>
  ({ symbol: "X", price: 100, change: 1, changePercent: 1, extended: extended && { post: null, overnight: null, pre: null, ...extended }, ...over }) as Quote;

describe("ExtendedPrices", () => {
  it("renders sessions in post, overnight, pre order regardless of key order", () => {
    const { container } = render(
      <ExtendedPrices quote={quote({ pre: sp(103, 3), post: sp(101, 1), overnight: sp(102, 2) })} />
    );
    const labels = [...container.querySelectorAll("span.dim")].map((e) => e.textContent);
    expect(labels).toEqual(["After hours", "Overnight", "Pre-market"]);
  });

  it("omits null sessions and renders nothing when all are null or missing", () => {
    const { container, rerender } = render(<ExtendedPrices quote={quote({ overnight: sp(102, 2) })} />);
    expect(screen.queryByText("After hours")).toBeNull();
    expect(screen.getByText("Overnight")).toBeTruthy();
    rerender(<ExtendedPrices quote={quote({})} />);
    expect(container.innerHTML).toBe("");
    rerender(<ExtendedPrices quote={quote(undefined)} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the live dot only for live sessions", () => {
    const { container, rerender } = render(<ExtendedPrices quote={quote({ post: sp(101, 1, true) })} />);
    expect(container.textContent).toContain("●");
    rerender(<ExtendedPrices quote={quote({ post: sp(101, 1, false) })} />);
    expect(container.textContent).not.toContain("●");
  });
});

describe("SessionCell", () => {
  const cell = (q: Quote | undefined, session: "post" | "overnight" | "pre" = "post") =>
    render(
      <table>
        <tbody>
          <tr>
            <SessionCell quote={q} session={session} label="After hours" />
          </tr>
        </tbody>
      </table>
    ).container.querySelector("td")!;

  it("renders a dash when the quote or session is missing", () => {
    expect(cell(undefined).textContent).toBe("—");
    cleanup();
    const td = cell(quote({ pre: sp(103, 3) }), "post");
    expect(td.textContent).toBe("—");
    expect(td.className).toBe("dim");
  });

  it("shows price and signed percent with up/down class", () => {
    const up = cell(quote({ post: sp(101, 1.5) }));
    expect(up.textContent).toContain("101.00");
    expect(up.querySelector("span.up")?.textContent).toBe("+1.50%");
    cleanup();
    const down = cell(quote({ post: sp(99, -1.5) }));
    expect(down.querySelector("span.down")?.textContent).toBe("-1.50%");
  });
});

describe("RegularPrice", () => {
  it("renders price and change", () => {
    const { container } = render(<RegularPrice quote={quote(undefined, { price: 1234.5, change: 4.53, changePercent: 2.09 })} />);
    expect(container.textContent).toContain("1,234.50");
    expect(container.textContent).toContain("+4.53 (+2.09%)");
    expect(container.querySelector(".up")).toBeTruthy();
  });

  it("uses the down class for a loss and dashes for nulls", () => {
    const { container } = render(<RegularPrice quote={quote(undefined, { price: null, change: -2, changePercent: -1 })} />);
    expect(container.querySelector(".down")?.textContent).toBe("-2.00 (-1.00%)");
    expect(container.textContent).toContain("—");
  });
});
