import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractLabel, strategyLabel } from "../../lib/ideas";
import { agentsLine, verdictLabel } from "../../lib/agents";
import { parseMarkdown } from "../Markdown";
import { useTerminal } from "../../store/terminal";
import IdeasWidget, { lastRun } from "./IdeasWidget";

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
let calls: Array<{ url: string; init?: RequestInit }>;
let table: Array<[string, (init?: RequestInit) => Response]>;

beforeEach(() => {
  calls = [];
  table = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return table.find(([p]) => url.includes(p))?.[1](init) ?? reply({});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><IdeasWidget /></QueryClientProvider>);
};

const stockIdea = { id: 1, kind: "stock", symbol: "NVDA", strategy: "buy", contract: null, score: 81.2, rank: 1, reasons: ["Strong momentum", "High quality"], firstSeen: "2026-10-20T11:00:00Z", lastSeen: "2026-10-21T11:00:00Z", status: "active" };
const optIdea = { ...stockIdea, id: 2, kind: "option", symbol: "AAPL", strategy: "short_put", contract: "AAPL261120P00150000", reasons: ["IV rich"] };
const card = { stock: { symbol: "NVDA", asOf: "x", sector: "Technology", industry: null, composite: 80, groups: { valuation: 40, momentum: 90 }, factors: [], coverage: 0.9, weightsVersion: "stock-v1" }, live: null, options: null };

describe("helpers", () => {
  it("labels strategies; puts are only sold", () => {
    expect(strategyLabel("long_call")).toBe("Buy call");
    expect(strategyLabel("short_put")).toBe("Sell put");
    expect(strategyLabel("covered_call")).toBe("Sell covered call");
  });
  it("formats OCC contracts", () => {
    expect(contractLabel("AAPL261120P00150000")).toBe("Nov 20 '26 $150 P");
    expect(contractLabel(null)).toBe("—");
  });
  it("finds the latest run by job word", () => {
    const run = (finished_at: string) => ({ started_at: finished_at, finished_at, status: "ok", symbols: 1, duration_ms: 1, error: null });
    const runs = { "stock-intraday": run("2026-10-21 10:00:00"), "stock-nightly": run("2026-10-21 09:00:00"), "option-scan": null };
    expect(lastRun(runs, ["stock-nightly", "stock-intraday"])?.finished_at).toBe("2026-10-21 10:00:00");
    expect(lastRun(runs, ["option-scan"])).toBeNull();
  });
});

describe("IdeasWidget", () => {
  it("shows stock ideas, selects the symbol and expands to group bars", async () => {
    table = [["/api/scan/ideas", () => reply({ asOf: null, ideas: [stockIdea] })], ["/api/scan/scorecard/NVDA", () => reply(card)], ["/api/agents/theses", () => reply({ error: "none" }, 404)]];
    wrap();
    const sym = await screen.findByRole("button", { name: "NVDA" });
    expect(screen.getByText("Strong momentum")).toBeTruthy();
    expect(screen.getByText(/not orders/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /buy|sell/i })).toBeNull();
    fireEvent.click(sym);
    expect(useTerminal.getState().activeSymbol).toBe("NVDA");
    fireEvent.click(screen.getByText("Strong momentum"));
    expect(await screen.findByText("Momentum")).toBeTruthy();
    expect(screen.getByText(/coverage 90%/)).toBeTruthy();
  });

  it("shows option ideas with strategy chip, IV rank and earnings flag", async () => {
    table = [
      ["kind=option", () => reply({ asOf: null, ideas: [optIdea] })],
      ["/api/scan/scorecard/AAPL", () => reply({ stock: null, live: null, options: { underlying: "AAPL", asOf: "x", score: 70, metrics: { ivRank: 72, impliedMovePct: 4.2, atmExpiry: null }, earningsBeforeExpiry: true, nextEarnings: "2026-10-30" } })],
    ];
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(await screen.findByText("Sell put")).toBeTruthy();
    expect(screen.getByText("Nov 20 '26 $150 P")).toBeTruthy();
    expect(await screen.findByText("72")).toBeTruthy();
    expect(screen.getByText("4.2%")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("shows empty and error states", async () => {
    table = [["/api/scan/ideas", () => reply({ asOf: null, ideas: [] })]];
    wrap();
    expect(await screen.findByText(/No stock ideas yet/)).toBeTruthy();
    cleanup();
    table = [["/api/scan/ideas", () => reply({ error: "boom" }, 500)]];
    wrap();
    expect(await screen.findByText(/Error: boom/)).toBeTruthy();
  });

  it("renders the status line", async () => {
    table = [
      ["/api/scan/ideas", () => reply({ asOf: null, ideas: [] })],
      ["/api/scan/status", () => reply({ runs: {}, options: { connected: true, subscribed: 412 } })],
    ];
    wrap();
    expect(await screen.findByText(/412 contracts streamed/)).toBeTruthy();
  });

  it("saves universe settings with POST", async () => {
    const settings = { mode: "watchlists", watchlistIds: null, sectors: [], industries: [], minPrice: 5, minAvgDollarVolume: 20_000_000, requireOptions: true };
    table = [
      ["/api/scan/ideas", () => reply({ asOf: null, ideas: [] })],
      ["/api/scan/universe", (init) => reply({ settings: init?.method === "POST" ? { ...settings, ...JSON.parse(String(init.body)) } : settings, symbolCount: 42 })],
      ["/api/scan/sectors", () => reply({ sectors: ["Technology"], industries: [] })],
      ["/api/watchlists", () => reply([{ id: 3, name: "core", symbols: ["AAPL"] }])],
      ["/api/positions", () => reply({ importedAt: null, positions: [] })],
    ];
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Whole market" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved: 42 symbols/);
    const put = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(put.init!.body)).mode).toBe("market");
  });

  it("uploads positions and lists line errors from a 400", async () => {
    table = [
      ["/api/scan/ideas", () => reply({ asOf: null, ideas: [] })],
      ["/api/scan/universe", () => reply({ settings: { mode: "watchlists", watchlistIds: null, sectors: [], industries: [], minPrice: 5, minAvgDollarVolume: 1, requireOptions: false }, symbolCount: 1 })],
      ["/api/positions/import", () => reply({ errors: [{ line: 3, message: "bad quantity" }] }, 400)],
      ["/api/positions", () => reply({ importedAt: "2026-10-21T10:00:00Z", positions: [{ kind: "stock", symbol: "AAPL" }] })],
    ];
    const { container } = wrap();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByText(/1 position,/);
    const file = new File(["symbol,quantity\nAAPL,x"], "p.csv", { type: "text/csv" });
    fireEvent.change(container.querySelector("input[type=file]")!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("Line 3: bad quantity")).toBeTruthy());
    expect(screen.getByText(/Nothing imported/)).toBeTruthy();
  });
});

const thesis = {
  id: 9, ideaId: 2, symbol: "AAPL", kind: "option", strategy: "short_put", contract: "AAPL261120P00150000", asOf: "2026-10-21T10:00:00Z",
  status: "ok", statusReason: null, verdict: "act", confidence: 72, horizon: "1-5 days",
  entry: { low: 1.2, high: 1.5, note: "limit" }, target: { price: null, note: "close at 50% of premium" },
  invalidation: { price: 148, condition: "close below 148" }, exitPlan: "Roll down and out if tested",
  catalysts: [{ date: "2026-10-30", event: "Earnings" }], risks: ["Gap down"], summary: "Would own it at 150.",
  bull: { side: "bull", summary: "Bull sum", points: [{ point: "Cheap", evidence: [{ claim: "PE 20", source: "fundamentals:metrics", asOf: "2026-10-20" }] }], costUsd: 0.1 },
  bear: { side: "bear", summary: "Bear sum", points: [], costUsd: 0.1 }, evidence: [], costUsd: 0.8,
};
const optionIdeaRoutes: Array<[string, () => Response]> = [["kind=option", () => reply({ asOf: null, ideas: [optIdea] })]];

describe("agents helpers", () => {
  it("words verdicts and the footer", () => {
    expect(verdictLabel("act", "Sell put")).toBe("Act: Sell put");
    expect(verdictLabel("wait", "Sell put")).toBe("Wait");
    expect(verdictLabel("pass", "Buy")).toBe("Pass");
    const today = { day: "d", spentUsd: 1.84, budgetUsd: 5, runs: 1, skippedForBudget: 0 };
    expect(agentsLine({ enabled: true, today, queue: [1, 2, 3] as never, running: [1] as never })).toBe("AI today $1.84 / $5.00 · 3 queued · 1 running");
    expect(agentsLine({ enabled: true, auth: "claude_login", today, queue: [], running: [] })).toBe("AI today $1.84 / $5.00 (Claude login)");
  });
  it("parses markdown blocks and never emits html", () => {
    expect(parseMarkdown("# H\n\nsome **bold**\ntext\n- a\n- b\n1. x")).toEqual([
      { type: "h", level: 1, text: "H" }, { type: "p", text: "some **bold** text" }, { type: "ul", items: ["a", "b"] }, { type: "ol", items: ["x"] },
    ]);
  });
});

describe("thesis view", () => {
  const open = async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    fireEvent.click(await screen.findByText("IV rich"));
  };

  it("shows the verdict, levels, catalysts and collapsible cases", async () => {
    table = [...optionIdeaRoutes, ["/api/agents/theses/latest", () => reply(thesis)]];
    await open();
    expect(await screen.findByText("Act: Sell put")).toBeTruthy();
    expect(screen.getByText("Confidence 72%")).toBeTruthy();
    expect(screen.getByText("Roll down and out if tested")).toBeTruthy();
    expect(screen.getByText("Earnings")).toBeTruthy();
    expect(screen.getByText("Would own it at 150.")).toBeTruthy();
    expect(screen.getByText(/PE 20 \(fundamentals:metrics, 2026-10-20\)/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes("ideaId=2"))).toBe(true);
  });

  it("shows a rejected thesis with its reason", async () => {
    table = [...optionIdeaRoutes, ["/api/agents/theses/latest", () => reply({ ...thesis, status: "rejected", statusReason: "act without a dated catalyst" })]];
    await open();
    expect(await screen.findByText(/Rejected: act without a dated catalyst/)).toBeTruthy();
  });

  it("falls back to symbol/strategy/contract, then offers Analyse and polls after 202", async () => {
    let analysed = false;
    table = [
      ...optionIdeaRoutes,
      ["/api/agents/analyze", () => { analysed = true; return reply({ queued: true, position: 1 }, 202); }],
      ["/api/agents/status", () => reply({ enabled: true, today: { day: "d", spentUsd: 1, budgetUsd: 5, runs: 0, skippedForBudget: 0 }, queue: [], running: [] })],
      ["/api/agents/theses/latest", () => reply({ error: "none" }, 404)],
    ];
    await open();
    expect(await screen.findByText("Not analysed yet")).toBeTruthy();
    expect(calls.some((c) => c.url.includes("symbol=AAPL") && c.url.includes("strategy=short_put") && c.url.includes("contract=AAPL261120P00150000"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
    expect(await screen.findByText(/Queued: /)).toBeTruthy();
    expect(analysed).toBe(true);
    expect(JSON.parse(String(calls.find((c) => c.url.includes("/analyze"))!.init!.body))).toMatchObject({ symbol: "AAPL", strategy: "short_put", ideaId: 2 });
  });

  it("disables Analyse when the budget is spent and reports 402", async () => {
    table = [
      ...optionIdeaRoutes,
      ["/api/agents/status", () => reply({ enabled: true, today: { day: "d", spentUsd: 5, budgetUsd: 5, runs: 0, skippedForBudget: 0 }, queue: [], running: [] })],
      ["/api/agents/theses/latest", () => reply({ error: "none" }, 404)],
    ];
    await open();
    await screen.findByText("Not analysed yet");
    await waitFor(() => expect((screen.getByRole("button", { name: "Analyse" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText("Daily AI budget reached.")).toBeTruthy();
  });

  it("reports a 402 from the server", async () => {
    table = [
      ...optionIdeaRoutes,
      ["/api/agents/analyze", () => reply({ error: "daily AI budget reached" }, 402)],
      ["/api/agents/theses/latest", () => reply({ error: "none" }, 404)],
    ];
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Analyse" }));
    expect(await screen.findByText(/budget reached; try again tomorrow/)).toBeTruthy();
  });
});

describe("brief tab and footer", () => {
  it("renders the brief markdown and regenerates", async () => {
    table = [
      ["/api/agents/brief/latest", () => reply({ id: 1, day: "2026-10-21", asOf: "2026-10-21T11:00:00Z", markdown: "## Regime\n- risk **on**\n<script>x</script>", macroId: 1, thesisIds: [], costUsd: 0.1 })],
      ["/api/agents/run/brief", () => reply({ queued: true }, 202)],
      ["/api/agents/status", () => reply({ enabled: true, auth: "claude_login", today: { day: "d", spentUsd: 1.84, budgetUsd: 5, runs: 1, skippedForBudget: 0 }, queue: [1, 2, 3], running: [] })],
    ];
    const { container } = wrap();
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    expect(await screen.findByText("Regime")).toBeTruthy();
    expect(screen.getByText("on").tagName).toBe("STRONG");
    expect(screen.getByText(/<script>x<\/script>/)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(await screen.findByText(/AI today \$1.84 \/ \$5.00 · 3 queued \(Claude login\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(await screen.findByText(/Queued: the brief/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/run/brief") && c.init?.method === "POST")).toBe(true);
  });

  it("shows the empty brief state", async () => {
    table = [["/api/agents/brief/latest", () => reply({ error: "none" }, 404)]];
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    expect(await screen.findByText("No brief yet: it is written at 07:00 ET on trading days.")).toBeTruthy();
  });
});
