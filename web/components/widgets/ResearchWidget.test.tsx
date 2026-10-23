import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWidget from "./ResearchWidget";

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
const widget = { id: "r", type: "research", symbol: "AAPL", linked: false } as never;
let calls: Array<{ url: string; init?: RequestInit }>;
let table: Array<[string, (init?: RequestInit) => Response]>;

beforeEach(() => {
  calls = [];
  table = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return table.find(([p]) => url.includes(p))?.[1](init) ?? (url.includes("/api/earnings/setup") ? reply({ error: "none" }, 404) : reply([]));
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ResearchWidget widget={widget} /></QueryClientProvider>);
};
const agentsOn = (spent = 1) => ["/api/agents/status", () => reply({ enabled: true, today: { day: "d", spentUsd: spent, budgetUsd: 5, runs: 0, skippedForBudget: 0 }, queue: [], running: [] })] as [string, () => Response];

const setup = (horizon: string, score: number, verdict: string, gates: unknown[] = []) => ({
  symbol: "AAPL", horizon, score, verdict, gates,
  upcoming: { reportDate: "2026-10-29", time: "amc", epsEstimate: 1.99, revenueEstimate: 113e9, fiscalPeriod: "Q4 FY2026" },
  components: [{ key: "history", points: 10, max: 20, value: {}, reason: "Called up 3 of 4 reports" }],
});

describe("ResearchWidget empty states", () => {
  it("says there is no setup, no analysis and no history, and offers to request one", async () => {
    table = [["/api/earnings/setup", () => reply({ error: "no upcoming report for AAPL" }, 404)], agentsOn()];
    wrap();
    await screen.findByText(/no upcoming report for AAPL, so there is no setup score yet/);
    await screen.findByText("No AI analysis or options report for AAPL yet.");
    await screen.findByText("No earnings history for AAPL.");
    expect(screen.getByRole("button", { name: "Request analysis" })).toBeTruthy();
  });

  it("shows an error per card when the API fails", async () => {
    table = [["/api/", () => reply({ error: "boom" }, 500)]];
    wrap();
    await waitFor(() => expect(screen.getAllByText("Error: boom").length).toBe(3));
  });
});

describe("Earnings setup and track record", () => {
  it("lists the score per horizon, failed gates and the history", async () => {
    table = [
      ["horizon=intraday", () => reply(setup("intraday", 62, "conditional", [{ key: "spread", passed: false, reason: "Spread 18% is over 10%" }]))],
      ["horizon=week", () => reply(setup("week", 71, "candidate"))],
      ["horizon=month", () => reply({ error: "none" }, 404)],
      ["/api/earnings-history", () => reply([
        { fiscalQtrEnd: "", upcoming: true, surprisePercent: null, dayAfterChangePercent: null },
        { fiscalQtrEnd: "2026-06-27", surprisePercent: 6.88, dayAfterChangePercent: -7.35 },
      ])],
      agentsOn(),
    ];
    const { container } = wrap();
    await screen.findByText("62 · conditional");
    expect(screen.getByText("71 · candidate")).toBeTruthy();
    expect(screen.getByText("Oct 29, 2026 · AMC")).toBeTruthy();
    expect(screen.getByText("Fails gates: spread.")).toBeTruthy();
    expect(screen.getByText("Spread 18% is over 10%")).toBeTruthy();
    await screen.findByText("EPS +6.9% vs est · next day -7.4%");
    expect(screen.getByText("Jun 27 qtr")).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|undefined|null/);
  });
});

describe("AI analysis", () => {
  it("shows an earnings review and a thesis instead of the request button", async () => {
    table = [
      ["/api/earnings/reviews", () => reply([{ id: 1, symbol: "AAPL", horizon: "intraday", reportDate: "2026-10-29", asOf: "2026-10-28T12:00:00Z", status: "ok", statusReason: null, baseScore: 60, adjustedScore: 66, adjustment: 6, verdict: "act", entryConditions: ["Buy the dip"], exitPlan: "Out by close", risks: ["Guide risk"], summary: "Looks fine.", newsFactors: [] }])],
      ["/api/agents/theses", () => reply([{ id: 2, symbol: "AAPL", strategy: "short_put", status: "ok", statusReason: null, asOf: "2026-10-27T12:00:00Z", verdict: "wait", confidence: 55, horizon: "2w", summary: "Wait for IV.", bull: { summary: "Cheap" }, bear: { summary: "Rich" } }])],
      agentsOn(),
    ];
    wrap();
    await screen.findByText("Looks fine.");
    expect(screen.getByText("Entry: Buy the dip")).toBeTruthy();
    expect(screen.getByText("Wait for IV.")).toBeTruthy();
    expect(screen.getByText("55%")).toBeTruthy();
    expect(screen.getByText("Bull: Cheap")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request analysis" })).toBeNull();
  });

  const post = () => calls.find((c) => c.init?.method === "POST");
  const request = async () => fireEvent.click(await screen.findByRole("button", { name: "Request analysis" }));

  it("queues an analysis", async () => {
    table = [["/api/agents/analyze", () => reply({ queued: true, position: 1 }, 202)], agentsOn()];
    wrap();
    await request();
    await screen.findByText(/Analysis queued/);
    expect(post()!.url).toBe("/api/agents/analyze");
    expect(JSON.parse(String(post()!.init!.body))).toEqual({ symbol: "AAPL", strategy: "buy" });
    expect(screen.queryByRole("button", { name: "Request analysis" })).toBeNull();
  });

  it.each([
    [409, "Already queued or running."],
    [402, "Daily AI budget reached; try again tomorrow."],
    [503, "AI agents are disabled."],
    [500, "Request failed: boom"],
  ])("explains a %i answer", async (status, text) => {
    table = [["/api/agents/analyze", () => reply({ error: "boom" }, status)], agentsOn()];
    wrap();
    await request();
    await screen.findByText(text);
  });

  it("disables the button when agents are off or the budget is spent", async () => {
    table = [["/api/agents/status", () => reply({ enabled: false, today: { spentUsd: 0, budgetUsd: 5 }, queue: [], running: [] })]];
    wrap();
    await screen.findByText("AI agents are disabled.");
    expect((screen.getByRole("button", { name: "Request analysis" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    table = [agentsOn(5)];
    wrap();
    await screen.findByText("Daily AI budget reached.");
    expect((screen.getByRole("button", { name: "Request analysis" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
