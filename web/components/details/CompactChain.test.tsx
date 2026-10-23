import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chain, OptionRow } from "../../lib/chain";
import { useTerminal } from "../../store/terminal";
import CompactChain from "./CompactChain";

const EXPIRY = "2099-01-16";

const row = (strike: number, extra: Partial<OptionRow> = {}): OptionRow => ({
  strike, lastPrice: 1, bid: 1, ask: 1.1, volume: 10, openInterest: 100, impliedVolatility: 0.3, inTheMoney: false, ...extra,
});

const chain: Chain = {
  symbol: "AAPL",
  underlyingPrice: 100,
  expirationDates: [EXPIRY],
  selectedDate: EXPIRY,
  calls: [row(95), row(100), row(105)],
  puts: [row(95), row(100), row(105)],
};

beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => ({ focus: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => chain, headers: new Headers() }) as Response));
});

let client: QueryClient | undefined;
afterEach(() => {
  cleanup();
  client?.clear();
  client = undefined;
  vi.unstubAllGlobals();
  useTerminal.setState({ openOrFocus: useTerminal.getInitialState().openOrFocus });
});

const renderChain = () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><CompactChain symbol="AAPL" /></QueryClientProvider>);
};

describe("CompactChain Open full chain", () => {
  it("calls openOrFocus('options', 'window') and opens the options window", async () => {
    const real = useTerminal.getState().openOrFocus;
    const spy = vi.fn(real);
    useTerminal.setState({ openOrFocus: spy });
    renderChain();

    fireEvent.click(await screen.findByRole("button", { name: "Open full chain" }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("options", "window");
    expect(useTerminal.getState().windows.map((w) => w.type)).toEqual(["options"]);
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it("does not add the options widget as a pane tab", async () => {
    renderChain();
    fireEvent.click(await screen.findByRole("button", { name: "Open full chain" }));
    const types = useTerminal.getState().panes.flatMap((p) => p.tabs.map((t) => t.type));
    expect(types).not.toContain("options");
  });
});
