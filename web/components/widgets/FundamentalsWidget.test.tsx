import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import FundamentalsWidget, { fmtValue, insiderSummary, yoy } from "./FundamentalsWidget";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<typeof import("../../lib/api")>()), apiGet }));
vi.mock("../EstimateRevisions", () => ({ default: () => <span>revisions-line</span> }));

const widget = { id: "w", type: "fundamentals", symbol: "NVDA", linked: false } as never;
const env = (data: unknown) => ({ dataset: "x", source: "fmp", asOf: "2026-10-21T00:00:00Z", data });

/** Answers each request from the first route whose path fragment matches. */
function routes(table: Array<[string, unknown | (() => never)]>) {
  apiGet.mockImplementation(async (url: string) => {
    const hit = table.find(([p]) => url.includes(p));
    if (!hit) return env(null);
    if (typeof hit[1] === "function") return (hit[1] as () => never)();
    return hit[0].startsWith("/api/quotes") ? hit[1] : env(hit[1]);
  });
}

const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><FundamentalsWidget widget={widget} /></QueryClientProvider>);
};

beforeEach(() => {
  apiGet.mockReset();
});
afterEach(cleanup);

const income = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2025-0${9 - i > 0 ? 9 - i : 1}-30`,
    fiscalYear: String(2026 - Math.floor(i / 4)),
    period: `Q${4 - (i % 4)}`,
    reportedCurrency: "USD",
    revenue: 1_000_000_000 * (12 - i),
    netIncome: i === 0 ? -5_000_000 : 2_000_000_000,
    epsDiluted: 1.234,
  }));

describe("formatting", () => {
  it("formats percent as a fraction, multiples with x, and dashes for missing", () => {
    expect(fmtValue(0.256, "pct")).toBe("25.6%");
    expect(fmtValue(-0.1, "pct")).toBe("-10.0%");
    expect(fmtValue(22.374, "x")).toBe("22.37x");
    expect(fmtValue(-3.5e9, "big")).toBe("-3.50B");
    expect(fmtValue(null, "pct")).toBe("—");
    expect(fmtValue(undefined, "x")).toBe("—");
    expect(fmtValue(NaN, "big")).toBe("—");
  });
  it("computes YoY against the absolute prior and skips unusable bases", () => {
    expect(yoy(120, 100)).toBeCloseTo(0.2);
    expect(yoy(-50, -100)).toBeCloseTo(0.5);
    expect(yoy(10, 0)).toBeNull();
    expect(yoy(10, undefined)).toBeNull();
  });
  it("nets only open-market buys and sales inside 90 days", () => {
    const now = Date.parse("2026-10-21");
    const t = (transactionDate: string, transactionType: string, securitiesTransacted: number, price: number) =>
      ({ transactionDate, transactionType, securitiesTransacted, price, reportingName: "x", typeOfOwner: "" });
    const s = insiderSummary(
      [t("2026-10-01", "S-Sale", 100, 10), t("2026-09-01", "P-Purchase", 50, 10), t("2026-09-09", "A-Award", 999, 0), t("2026-01-01", "S-Sale", 1000, 10)],
      now
    );
    expect(s.sold).toBe(1000);
    expect(s.bought).toBe(500);
    expect(s.net).toBe(-500);
  });
});

describe("FundamentalsWidget", () => {
  it("shows statements, red negatives, YoY on hover, and refetches on toggle", async () => {
    routes([["/statements", income(12)]]);
    const { container } = wrap();
    await screen.findByText("Revenue");
    expect(apiGet).toHaveBeenCalledWith("/api/research/NVDA/statements?type=income&period=quarter&limit=12");
    expect(container.querySelectorAll("thead th")).toHaveLength(9); // label + 8 periods
    const net = screen.getByText("Net income").closest("tr")!;
    expect(net.querySelector("td.down")?.textContent).toBe("-5.00M");
    const rev = screen.getByText("Revenue").closest("tr")!.querySelectorAll("td")[1];
    expect(rev.getAttribute("title")).toMatch(/^YoY \+/);

    fireEvent.click(screen.getByText("FY"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/research/NVDA/statements?type=income&period=annual&limit=9"));
    fireEvent.click(screen.getByText("Balance"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/research/NVDA/statements?type=balance&period=annual&limit=9"));
  });

  it("formats metrics as percent or multiple and reads TTM keys with or without suffix", async () => {
    routes([
      ["period=ttm", [{ period: "TTM", keyMetrics: { returnOnEquityTTM: 1.1011, evToEBITDATTM: 22.37, netDebtToEBITDATTM: -0.5 }, ratios: { grossProfitMarginTTM: 0.71, priceToEarningsRatioTTM: 30 } }]],
      ["period=quarter", [{ date: "2026-07-26", fiscalYear: "2027", period: "Q2", keyMetrics: { returnOnEquity: 0.5 }, ratios: { grossProfitMargin: 0.72 } }]],
    ]);
    wrap();
    fireEvent.click(screen.getByText("Metrics"));
    await screen.findByText("ROE");
    const row = (label: string) => screen.getByText(label).closest("tr")!;
    expect(row("ROE").textContent).toBe("ROE110.1%50.0%");
    expect(row("Gross margin").textContent).toBe("Gross margin71.0%72.0%");
    expect(row("EV/EBITDA").textContent).toBe("EV/EBITDA22.37x—");
    expect(row("Net debt/EBITDA").querySelector("td.down")?.textContent).toBe("-0.50x");
  });

  it("shows estimates and the revisions line", async () => {
    const e = { date: "2026-10-26", epsLow: 2.3, epsAvg: 2.47, epsHigh: 2.67, revenueLow: 1.07e11, revenueAvg: 1.088e11, revenueHigh: 1.12e11, numAnalystsEps: 28, numAnalystsRevenue: 27 };
    routes([["/estimates", { estimates: [e], nextReport: null }]]);
    wrap();
    fireEvent.click(screen.getByText("Estimates"));
    await screen.findByText("revisions-line");
    expect((await screen.findAllByText("2.47")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("108.80B").length).toBeGreaterThan(0);
    expect(screen.getAllByText("28/27").length).toBeGreaterThan(0);
  });

  it("computes price-target upside against the quote", async () => {
    routes([
      ["/analysts", {
        priceTargetSummary: null,
        priceTargetConsensus: { targetLow: 90, targetMedian: 110, targetConsensus: 120, targetHigh: 150 },
        grades: [{ date: "2026-10-01", gradingCompany: "Acme", previousGrade: "Hold", newGrade: "Buy", action: "upgrade" }],
        gradesConsensus: { strongBuy: 10, buy: 20, hold: 5, sell: 1, strongSell: 0, consensus: "Buy" },
      }],
      ["/api/quotes", [{ price: 100 }]],
    ]);
    wrap();
    fireEvent.click(screen.getByText("Analysts"));
    await screen.findByText("Acme");
    await screen.findByText("+20.00%");
    expect(screen.getByText("-10.00%").className).toBe("down");
    expect(screen.getByText("upgrade").className).toBe("up");
  });

  it("shows ownership: 13F summary, net insider value and Congress trades", async () => {
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    routes([
      ["/institutional", {
        year: 2026, quarter: 2,
        summary: { investorsHolding: 6000, investorsHoldingChange: -12, ownershipPercent: 67.5, ownershipPercentChange: 0.4, numberOf13Fshares: 16.5e9, numberOf13FsharesChange: 1e8, newPositions: 100, closedPositions: 50, increasedPositions: 2000, reducedPositions: 1900 },
        holders: [{ investorName: "VANGUARD GROUP INC", sharesNumber: 2.2e9, changeInSharesNumberPercentage: -1.5, ownership: 9, marketValue: 4.8e11 }],
      }],
      ["/insiders", { trades: [{ transactionDate: day(5), transactionType: "S-Sale", reportingName: "Teter", typeOfOwner: "officer", securitiesTransacted: 1000, price: 200 }] }],
      ["/congress", [{ transactionDate: day(10), disclosureDate: day(2), chamber: "house", firstName: "Ro", lastName: "Khanna", type: "Purchase", amount: "$1,001 - $15,000" }]],
    ]);
    wrap();
    fireEvent.click(screen.getByText("Ownership"));
    await screen.findByText("VANGUARD GROUP INC");
    expect(screen.getByText("-1.50%").className).toBe("down");
    expect(screen.getByText("-$200.0K").className).toContain("down");
    expect(screen.getByText("Teter")).toBeTruthy();
    expect(screen.getByText("Purchase").className).toBe("up");
    expect(screen.getByText("$1,001 - $15,000")).toBeTruthy();
  });

  it("shows empty states", async () => {
    routes([["/statements", []], ["/analysts", { priceTargetSummary: null, priceTargetConsensus: null, grades: [], gradesConsensus: null }]]);
    wrap();
    await screen.findByText("No statements for NVDA.");
    fireEvent.click(screen.getByText("Analysts"));
    await screen.findByText("No analyst coverage for NVDA.");
    fireEvent.click(screen.getByText("Ownership"));
    await screen.findByText("No ownership data for NVDA.");
  });

  it("shows the key note on 503 and a red error otherwise", async () => {
    routes([["/statements", () => { throw new ApiError("needs FMP_API_KEY", 503); }], ["/analysts", () => { throw new ApiError("fmp 500 boom", 502); }]]);
    const { container } = wrap();
    await screen.findByText("Needs an FMP API key (set FMP_API_KEY): see README");
    expect(container.querySelector(".down")).toBeNull();
    fireEvent.click(screen.getByText("Analysts"));
    await screen.findByText("Error: fmp 500 boom");
  });

  it("switches tabs", async () => {
    routes([]);
    wrap();
    const tabs = ["Statements", "Metrics", "Estimates", "Analysts", "Ownership"];
    for (const t of tabs) {
      fireEvent.click(screen.getByText(t));
      expect(screen.getByText(t).className).toContain("active");
      for (const other of tabs.filter((x) => x !== t)) expect(screen.getByText(other).className).not.toContain("active");
    }
  });
});
