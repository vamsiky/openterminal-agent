import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminal } from "../../store/terminal";
import CompactChain from "../details/CompactChain";
import OptionsWidget from "./OptionsWidget";

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
let urls: string[];
let handler: (url: string) => Response;

beforeEach(() => {
  urls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T16:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return handler(url);
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};
const widget = { id: "w", type: "options", symbol: "AAPL", linked: false } as never;
const row = (strike: number, over = {}) => ({ strike, lastPrice: null, bid: 1, ask: 1.2, volume: null, openInterest: null, impliedVolatility: null, inTheMoney: false, ...over });
const chain = (over = {}) => ({
  symbol: "AAPL", underlyingPrice: 200, expirationDates: ["2026-10-23", "2026-10-30", "2026-11-20"], selectedDate: "2026-10-30",
  calls: [row(180, { bid: 20, ask: 20.4 }), row(200, { bid: 2, ask: 2.2, impliedVolatility: 0.3, delta: 0.5, volume: 1200 }), row(205), row(260)],
  puts: [row(200, { bid: 1.8, ask: 2, impliedVolatility: 0.34, delta: -0.5, volume: 600 }), row(180)],
  ...over,
});

describe("OptionsWidget", () => {
  it("loads the nearest expiry after today, not today's", async () => {
    handler = (url) => (url.includes("expiry=") ? reply(chain()) : reply(chain({ selectedDate: "2026-10-23" })));
    wrap(<OptionsWidget widget={widget} />);
    await screen.findByText("ATM straddle");
    expect(urls[0]).toBe("/api/options/AAPL");
    expect(urls[1]).toBe("/api/options/AAPL?expiry=2026-10-30");
    expect(screen.getByRole("button", { name: "Oct 30 · 7d" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("LIVE")).toBeTruthy();
  });

  it("shows stats, the ±10% band, a spot row, and dashes for missing values", async () => {
    handler = () => reply(chain());
    const { container } = wrap(<OptionsWidget widget={widget} />);
    await screen.findByText("ATM straddle");
    const stat = (k: string) => screen.getByText(k).nextElementSibling!.textContent;
    expect(stat("ATM strike")).toBe("200.00");
    expect(stat("ATM straddle")).toBe("$4.00");
    expect(stat("Implied move")).toBe("±$4.00 (±2.0%)");
    expect(stat("ATM IV")).toBe("32%");
    expect(stat("Put/call volume")).toBe("0.50");
    // 180 is 10% away and in; 260 is out of ±10% until ±30%.
    const table = container.querySelector("table")!;
    expect(within(table).queryByText("260.00")).toBeNull();
    expect(within(table).getByText("180.00")).toBeTruthy();
    expect(screen.getByTestId("spot-row").textContent).toContain("200.00");
    fireEvent.click(screen.getByRole("button", { name: "±30%" }));
    expect(within(container.querySelector("table")!).getByText("260.00")).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|undefined|null/);
  });

  it("switches to one side with Mid and theta columns", async () => {
    handler = () => reply(chain());
    const { container } = wrap(<OptionsWidget widget={widget} />);
    await screen.findByText("ATM straddle");
    fireEvent.click(screen.getByRole("button", { name: "Calls" }));
    const heads = [...container.querySelectorAll("thead th")].map((h) => h.textContent);
    expect(heads).toContain("Mid");
    expect(heads).toContain("Θ / day");
  });

  it("refetches every 15 seconds while mounted", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    handler = () => reply(chain());
    wrap(<OptionsWidget widget={widget} />);
    await vi.waitFor(() => expect(screen.getByText("ATM straddle")).toBeTruthy());
    const before = urls.length;
    await vi.advanceTimersByTimeAsync(15_100);
    expect(urls.length).toBeGreaterThan(before);
  });

  it("explains a symbol with no listed options", async () => {
    handler = () => reply(chain({ expirationDates: [], selectedDate: null, calls: [], puts: [] }));
    wrap(<OptionsWidget widget={widget} />);
    await screen.findByText("No listed options for AAPL.");
  });

  it("shows the 503 text without the 'unavailable' box, and other failures as errors", async () => {
    handler = () => reply({ error: "needs Alpaca API keys", feature: "/options/:symbol" }, 503);
    const a = wrap(<OptionsWidget widget={widget} />);
    await screen.findByText("needs Alpaca API keys");
    expect(a.container.querySelector(".down")).toBeNull();
    cleanup();
    handler = () => reply({ error: "boom" }, 500);
    const b = wrap(<OptionsWidget widget={widget} />);
    await screen.findByText("Option chain unavailable for AAPL");
    expect(b.container.textContent).toContain("boom");
  });
});

describe("CompactChain", () => {
  const many = () => {
    const strikes = Array.from({ length: 20 }, (_, i) => 150 + i * 5);
    return chain({ calls: strikes.map((k) => row(k)), puts: strikes.map((k) => row(k)) });
  };

  it("shows the 10 strikes closest to spot and opens the full chain in a window", async () => {
    handler = () => reply(many());
    const openOrFocus = vi.fn();
    useTerminal.setState({ openOrFocus } as never);
    const { container } = wrap(<CompactChain symbol="AAPL" />);
    await screen.findByText("Open full chain");
    expect(container.querySelectorAll("tbody tr:not([data-testid])")).toHaveLength(10);
    expect(screen.getByTestId("spot-row")).toBeTruthy();
    fireEvent.click(screen.getByText("Open full chain"));
    expect(openOrFocus).toHaveBeenCalledWith("options", "window");
  });

  it("says so when there are no options, and on errors", async () => {
    handler = () => reply(chain({ expirationDates: [], selectedDate: null, calls: [], puts: [] }));
    wrap(<CompactChain symbol="AAPL" />);
    await screen.findByText("No listed options for AAPL.");
    cleanup();
    handler = () => reply({ error: "boom" }, 500);
    wrap(<CompactChain symbol="AAPL" />);
    await screen.findByText(/Option chain unavailable for AAPL: boom/);
  });
});
