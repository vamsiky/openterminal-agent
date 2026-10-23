import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailsWidget from "./DetailsWidget";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
const widget = { id: "d", type: "details", symbol: "AAPL", linked: false } as never;
const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><DetailsWidget widget={widget} /></QueryClientProvider>);
};

/** Research routes answer in an envelope; everything else as sent. */
function stub(data: unknown, extra: Array<[string, unknown]> = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const hit = extra.find(([p]) => url.includes(p));
    if (hit) return reply(hit[1]);
    return reply(url.includes("/api/research/") ? { dataset: "x", source: "fmp", asOf: "", data } : data);
  }));
}
const open = (tab: string, sub?: string) => {
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  if (sub) fireEvent.click(screen.getByRole("button", { name: sub }));
};

// [tab, sub-tab, empty payload, text shown for it]
const EMPTY: Array<[string, string | undefined, unknown, RegExp]> = [
  ["News", undefined, [], /No recent news for AAPL/],
  ["Options", undefined, { symbol: "AAPL", underlyingPrice: 1, expirationDates: [], selectedDate: null, calls: [], puts: [] }, /No listed options for AAPL/],
  ["Financials", "Forecast", { estimates: [] }, /No analyst estimates for AAPL/],
  ["Financials", "Income statement", [], /No income statements for AAPL/],
  ["Financials", "Balance sheet", [], /No balance sheets for AAPL/],
  ["Financials", "Cash flow", [], /No cash-flow statements for AAPL/],
  ["Financials", "Earnings history", [], /No earnings history for AAPL/],
  ["Analysis", "Analysts", {}, /No analyst coverage for AAPL/],
  ["Analysis", "Short selling", null, /No short-sale data for AAPL/],
  ["Analysis", "Institutions", {}, /No 13F holdings data for AAPL/],
  ["Analysis", "ETF weighting", [], /No ETF holds a reported weight in AAPL/],
  ["Filings & releases", "SEC filings", [], /No SEC filings found for AAPL/],
  ["Filings & releases", "Press releases", [], /No press releases for AAPL/],
  ["Filings & releases", "Insider filings", [], /No recent insider filings \(Form 4\) for AAPL/],
  ["Corporate actions", "Insider activity", [], /No insider trades reported for AAPL/],
  ["Corporate actions", "Dividends", { profile: { lastDividend: 0 } }, /AAPL doesn’t pay a dividend/],
  ["Brief", undefined, { profile: null }, /No company profile for AAPL/],
  ["Brief", "Key executives", { profile: { companyName: "Apple" }, executives: [] }, /No key executives listed for AAPL/],
];

describe("DetailsWidget", () => {
  it("shows the nine tabs", () => {
    stub([]);
    wrap();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "News", "Comments", "Options", "Bonds", "Financials", "Analysis", "Filings & releases", "Corporate actions", "Brief",
    ]);
  });

  it.each(EMPTY)("%s / %s: explicit no-data message", async (tab, sub, payload, text) => {
    stub(payload);
    wrap();
    open(tab, sub);
    await screen.findByText(text);
  });

  it.each(EMPTY.filter(([tab]) => tab !== "Options"))("%s / %s: loading state, then an error", async (tab, sub) => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "boom" }, 500)));
    wrap();
    open(tab, sub);
    expect(screen.getByText(/^Loading /)).toBeTruthy();
    await screen.findByText("Error: boom");
  });

  it("explains the options error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "boom" }, 500)));
    wrap();
    open("Options");
    await screen.findByText(/Option chain unavailable for AAPL: boom/);
  });

  it("shows the FMP key note instead of an error for a keyless 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "needs FMP_API_KEY" }, 503)));
    wrap();
    await screen.findByText(/Needs an FMP API key/);
  });

  it("says why comments, bonds and order flow are empty", () => {
    stub([]);
    wrap();
    open("Comments");
    expect(screen.getByText(/Community comments aren’t available/)).toBeTruthy();
    open("Bonds");
    expect(screen.getByText(/No bond data for AAPL/)).toBeTruthy();
    open("Analysis", "Order flow");
    expect(screen.getByText(/Order flow .* isn’t computed by the app/)).toBeTruthy();
  });

  it("lists news with safe links only", async () => {
    stub([
      { publishedDate: "2026-10-21 09:30:00", title: "Good headline", site: "example.com", url: "https://example.com/a" },
      { publishedDate: "2026-10-20 09:30:00", title: "Bad link", site: "x.com", url: "javascript:alert(1)" },
    ]);
    const { container } = wrap();
    const link = await screen.findByText("Good headline");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(link.closest("a")?.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("Bad link").closest("a")).toBeNull();
    expect(screen.getByText("Oct 21, 2026")).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|undefined|null/);
  });

  it("renders analyst consensus, targets and upside", async () => {
    stub(
      {
        gradesConsensus: { strongBuy: 10, buy: 20, hold: 5, sell: 0, strongSell: 0, consensus: "Buy" },
        priceTargetConsensus: { targetHigh: 400, targetLow: 245, targetConsensus: 330, targetMedian: 335 },
        priceTargets: [{ publishedDate: "2026-10-20T10:43:18.000Z", analystCompany: "Loop", newsTitle: "t", newsURL: null, priceTarget: 330, priceWhenPosted: 342.94 }],
      },
      [["/api/quotes", [{ symbol: "AAPL", price: 300 }]]],
    );
    const { container } = wrap();
    open("Analysis");
    await screen.findByText("Buy (35 analysts)");
    await screen.findByText("+10.00%");
    expect(screen.getByText("Loop")).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|undefined/);
  });

  it("shows the short-sale stats", async () => {
    stub({ date: "20261022", shortVolume: 8693763.5, totalVolume: 15030702.2, shortVolumePercent: 57.84 });
    wrap();
    open("Analysis", "Short selling");
    await screen.findByText("57.8%");
    expect(screen.getByText("Oct 22, 2026")).toBeTruthy();
  });
});
