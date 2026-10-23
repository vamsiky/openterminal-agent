import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTerminal } from "../store/terminal";
import WatchlistWidget from "./widgets/WatchlistWidget";
import CalendarWidget from "./widgets/CalendarWidget";
import CryptoWidget from "./widgets/CryptoWidget";
import NewsWidget from "./widgets/NewsWidget";
import QuoteWidget from "./widgets/QuoteWidget";
import ScreenerWidget from "./widgets/ScreenerWidget";
import { ApiError } from "../lib/api";
import ErrorNote from "./ErrorNote";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers(headers) }) as Response;

/** Routes by URL substring; the first matching entry wins. */
function stubApi(routes: Array<[string, () => Response]>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => routes.find(([p]) => url.includes(p))?.[1]() ?? reply(null)));
}

const wrap = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

const widget = { id: "w", type: "quote", linked: true } as never;

describe("ErrorNote", () => {
  it("shows the key note for a missing FMP key, not an error box", () => {
    const { container } = render(<ErrorNote error={new ApiError("needs FMP_API_KEY", 503)} />);
    expect(container.textContent).toBe("Needs an FMP API key (set FMP_API_KEY): see README");
    expect(container.querySelector(".down")).toBeNull();
  });
  it("shows other 503 text as a plain note and other failures as errors", () => {
    const a = render(<ErrorNote error={new ApiError("needs Alpaca API keys", 503)} />);
    expect(a.container.textContent).toBe("needs Alpaca API keys");
    expect(a.container.querySelector(".down")).toBeNull();
    cleanup();
    const b = render(<ErrorNote error={new ApiError("boom", 500)} />);
    expect(b.container.querySelector(".down")?.textContent).toBe("Error: boom");
  });
});

describe("QuoteWidget", () => {
  it("renders a sparse non-Alpaca quote with dashes and a source name", async () => {
    const q = Object.fromEntries(
      ["name", "open", "high", "low", "previousClose", "bid", "ask", "volume", "avgVolume", "marketCap", "pe", "eps", "dividendYield", "week52High", "week52Low", "beta", "sharesOutstanding", "currency", "exchange", "marketState"].map((k) => [k, null])
    );
    stubApi([["/api/quotes", () => reply([{ ...q, symbol: "PRYMY", price: 400, change: null, changePercent: null, source: "stooq" }])]]);
    const { container } = wrap(<QuoteWidget widget={widget} />);
    await screen.findByText("Stooq");
    expect(container.textContent).not.toMatch(/NaN|undefined/i);
    expect(container.textContent).not.toMatch(/yahoo/i);
  });
});

describe("CalendarWidget", () => {
  it("shows the FMP key note on the earnings tab", async () => {
    useTerminal.setState({ watchlist: ["AAPL"] });
    stubApi([
      ["/api/econ-calendar", () => reply([])],
      ["/api/calendar", () => reply({ error: "needs FMP_API_KEY", feature: "/calendar" }, 503)],
    ]);
    wrap(<CalendarWidget />);
    fireEvent.click(screen.getByText("EARNINGS"));
    await screen.findByText(/Needs an FMP API key/);
  });
  it("shows the Time column with a tooltip, ordered within a day, and keeps the history expansion", async () => {
    useTerminal.setState({ watchlist: ["AMCCO", "BMOCO", "UNKCO"] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T16:00:00Z"));
    const at = Date.parse("2026-10-22T00:00:00Z") / 1000;
    const row = (symbol: string, timing: string | null, timingBasis: unknown) => ({ symbol, nextEarningsDate: at, lastEarningsDate: null, epsForecast: 1, timing, timingBasis });
    stubApi([
      ["/api/econ-calendar", () => reply([])],
      ["/api/earnings-history", () => reply([])],
      ["/api/calendar", () => reply([row("UNKCO", null, null), row("AMCCO", "amc", { matched: 4, total: 4 }), row("BMOCO", "bmo", { matched: 3, total: 4 })])],
    ]);
    const { container } = wrap(<CalendarWidget />);
    fireEvent.click(screen.getByText("EARNINGS"));
    try {
      await screen.findByText("AMC");
    } finally {
      vi.useRealTimers();
    }
    expect([...container.querySelectorAll("tbody tr")].slice(1).map((tr) => tr.children[3].textContent)).toEqual(["BMOCO", "AMCCO", "UNKCO"]);
    expect(screen.getByText("AMC").getAttribute("title")).toBe("Usually after close: 4 of 4 recent earnings releases (FMP press releases)");
    expect(container.querySelector("td[title='Time of day unknown']")?.textContent).toBe("—");
    fireEvent.click(screen.getByText("AMCCO"));
    await screen.findByText("No earnings history for AMCCO.");
  });
  it("renders official events with missing numbers and odd impact as dashes", async () => {
    stubApi([
      [
        "/api/econ-calendar",
        () => reply([{ title: "CPI", country: "USD", date: "2026-10-21T12:30:00Z", impact: "High", forecast: null, previous: null, actual: null }, { title: "Odd", country: "USD", date: "nope", impact: "Unknown", forecast: null, previous: null, actual: null }]),
      ],
    ]);
    const { container } = wrap(<CalendarWidget />);
    await screen.findByText("CPI");
    fireEvent.click(screen.getByText("ALL"));
    await screen.findByText("Odd");
    expect(container.textContent).not.toMatch(/Invalid Date|NaN|undefined/);
  });
});

describe("NewsWidget", () => {
  it("shows the 503 text", async () => {
    stubApi([["/api/news", () => reply({ error: "needs Alpaca API keys", feature: "/news" }, 503)]]);
    wrap(<NewsWidget widget={widget} />);
    await screen.findByText("needs Alpaca API keys");
  });
  it("keeps the symbol feed as the default and shows press releases on the PRESS tab", async () => {
    useTerminal.setState({ activeSymbol: "AAPL" });
    stubApi([
      ["/api/research/AAPL/press-releases", () => reply({ data: [{ title: "Apple HomeView", url: "https://example.com/pr", publisher: "Business Wire", publishedDate: "2026-10-13 08:56:00", text: "x" }, { title: "No link", url: null, publisher: null, publishedDate: "2026-10-12 07:00:00" }] })],
      ["/api/news", () => reply([{ title: "Benzinga story", link: "https://example.com/b", publisher: "Benzinga", publishedAt: null }])],
    ]);
    const { container } = wrap(<NewsWidget widget={widget} />);
    await screen.findByText("Benzinga story");
    fireEvent.click(screen.getByText("PRESS"));
    const link = (await screen.findByText("Apple HomeView")).closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/pr");
    expect(container.textContent).toContain("Business Wire · 2026-10-13 08:56");
    expect(screen.getByText("No link").closest("a")).toBeNull();
    expect(container.textContent).not.toMatch(/Invalid Date|NaN|undefined/);
  });
});

describe("ScreenerWidget", () => {
  it("explains the empty EU market with the API's X-Market-Note", async () => {
    stubApi([
      ["/api/sectors", () => reply([])],
      ["/api/screener", () => reply([], 200, { "x-market-note": "No source for European markets" })],
    ]);
    wrap(<ScreenerWidget />);
    fireEvent.click(screen.getByText("EU"));
    await screen.findByText("No source for European markets");
  });
  it("renders rows with null name, sector and numbers", async () => {
    stubApi([
      ["/api/sectors", () => reply([])],
      ["/api/screener", () => reply([{ symbol: "XYZ", name: null, price: null, changePercent: null, volume: null, marketCap: null, sector: null }])],
    ]);
    const { container } = wrap(<ScreenerWidget />);
    await screen.findByText("XYZ");
    expect(container.textContent).not.toMatch(/NaN|null|undefined/);
  });
});

describe("CryptoWidget", () => {
  it("opens the -USD pair so the chart and quote hit the crypto route", async () => {
    useTerminal.setState({ activeSymbol: "AAPL" });
    stubApi([
      ["/api/crypto/global", () => reply({ totalMarketCap: 1e12, btcDominance: 50, ethDominance: 10 })],
      ["/api/crypto", () => reply([{ id: "solana", symbol: "SOL", name: "Solana", price: null, changePercent24h: null, marketCap: null, volume24h: null, rank: null, sparkline: [] }])],
    ]);
    wrap(<CryptoWidget />);
    fireEvent.click(await screen.findByText("SOL"));
    expect(useTerminal.getState().activeSymbol).toBe("SOL-USD");
  });
});

describe("WatchlistWidget", () => {
  it("refuses a foreign symbol with the US-only message and adds a US one", async () => {
    stubApi([["/api/", () => reply([])]]);
    useTerminal.setState({ watchlists: [{ name: "default", symbols: [] }], activeWatchlist: "default", watchlist: [] });
    wrap(<WatchlistWidget />);
    const input = screen.getByPlaceholderText("Add ticker…");
    fireEvent.change(input, { target: { value: "shop.to" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("US-listed symbols only (e.g. TSM for TSMC)");
    expect(useTerminal.getState().watchlist).toEqual([]);

    fireEvent.change(input, { target: { value: "tsm" } });
    fireEvent.submit(input.closest("form")!);
    expect(useTerminal.getState().watchlist).toEqual(["TSM"]);
  });
});
