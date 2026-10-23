import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "../../lib/api";
import { useTerminal } from "../../store/terminal";
import WatchlistPanel from "./WatchlistPanel";

// Mocked quotes: AAPL is up most, NVDA is the most expensive, TSLA has no quote yet.
const QUOTES: Record<string, Partial<Quote>> = {
  AAPL: { price: 190, changePercent: 1.5 },
  MSFT: { price: 410, changePercent: -0.5 },
  NVDA: { price: 900, changePercent: 3.2 },
};

const quote = (symbol: string): Quote => ({
  symbol, name: `${symbol} Inc`, change: null, open: null, high: null, low: null, previousClose: null,
  bid: null, ask: null, volume: null, avgVolume: null, marketCap: null, pe: null, eps: null,
  dividendYield: null, week52High: null, week52Low: null, beta: null, sharesOutstanding: null,
  currency: "USD", exchange: "NMS", marketState: "REGULAR", source: "test",
  price: null, changePercent: null, ...QUOTES[symbol],
});

/** Answers /api/quotes with a row per requested symbol that has a mocked quote. */
function stubQuotes() {
  const fetchMock = vi.fn(async (url: string) => {
    const symbols = new URL(url, "http://x").searchParams.get("symbols")!.split(",");
    const body = symbols.filter((sym) => QUOTES[sym]).map(quote);
    return { ok: true, status: 200, json: async () => body, headers: new Headers() } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let client: QueryClient;
const renderPanel = () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><WatchlistPanel /></QueryClientProvider>);
};

/** Symbols of the rendered rows, top to bottom. */
const rowSymbols = (container: HTMLElement) =>
  [...container.querySelectorAll(".wrow")].map((row) => row.querySelector(".dim")!.textContent!.split(" · ")[0]);

beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => ({ focus: vi.fn() })));
  stubQuotes();
  useTerminal.getState().resetWorkspace();
  useTerminal.setState({
    watchlists: [{ name: "default", symbols: ["MSFT", "AAPL", "NVDA"] }],
    activeWatchlist: "default",
    watchlist: ["MSFT", "AAPL", "NVDA"],
    recent: [],
    activeSymbol: "MSFT",
  });
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});

describe("WatchlistPanel row picks", () => {
  it("clicking a row opens its chart and quote and makes it active", async () => {
    useTerminal.getState().removeWidget("w-chart");
    useTerminal.getState().removeWidget("w-quote");
    renderPanel();

    // Rows show the company name once their quote has loaded.
    fireEvent.click(await screen.findByRole("button", { name: /^NVDA Inc/ }));

    const st = useTerminal.getState();
    expect(st.activeSymbol).toBe("NVDA");
    expect(st.recent).toEqual(["NVDA"]);
    const types = st.panes.flatMap((p) => p.tabs.map((t) => t.type));
    expect(types).toContain("chart");
    expect(types).toContain("quote");
  });

  it("the Enter key picks a row the same way a click does", async () => {
    renderPanel();
    fireEvent.keyDown(await screen.findByRole("button", { name: /^AAPL Inc/ }), { key: "Enter" });
    expect(useTerminal.getState().activeSymbol).toBe("AAPL");
    expect(useTerminal.getState().recent).toEqual(["AAPL"]);
  });
});

describe("WatchlistPanel sorting", () => {
  const sortBy = (label: string) => fireEvent.change(screen.getByLabelText("Sort watchlist"), { target: { value: label } });

  it("default keeps the list's own order", async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelectorAll(".wrow")).toHaveLength(3));
    expect(rowSymbols(container)).toEqual(["MSFT", "AAPL", "NVDA"]);
  });

  it("orders rows by price, change and symbol using the quotes", async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelectorAll(".wrow")).toHaveLength(3));

    sortBy("priceDesc");
    expect(rowSymbols(container)).toEqual(["NVDA", "MSFT", "AAPL"]);

    sortBy("chgDesc");
    expect(rowSymbols(container)).toEqual(["NVDA", "AAPL", "MSFT"]);

    sortBy("chgAsc");
    expect(rowSymbols(container)).toEqual(["MSFT", "AAPL", "NVDA"]);

    sortBy("symAsc");
    expect(rowSymbols(container)).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("a row whose quote has not arrived sorts last", async () => {
    useTerminal.setState({ watchlist: ["TSLA", "NVDA"], watchlists: [{ name: "default", symbols: ["TSLA", "NVDA"] }] });
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelectorAll(".wrow")).toHaveLength(2));
    sortBy("priceDesc");
    expect(rowSymbols(container)).toEqual(["NVDA", "TSLA"]);
  });
});

describe("WatchlistPanel Recent tab", () => {
  it("lists opened symbols newest first and picks from it", async () => {
    const st = useTerminal.getState();
    st.openSymbol("AAPL");
    st.openSymbol("NVDA");
    st.openSymbol("MSFT");
    const { container } = renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    await waitFor(() => expect(rowSymbols(container)).toEqual(["MSFT", "NVDA", "AAPL"]));
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();

    fireEvent.click(await within(container).findByRole("button", { name: /^AAPL Inc/ }));
    expect(useTerminal.getState().activeSymbol).toBe("AAPL");
    expect(useTerminal.getState().recent).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("shows an empty hint before anything is opened", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    expect(screen.getByText("Symbols you open show up here.")).toBeTruthy();
  });
});
