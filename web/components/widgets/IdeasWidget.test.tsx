import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractLabel, strategyLabel } from "../../lib/ideas";
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
    expect(lastRun({ stock_15m: { finished_at: "2026-10-21 10:00:00" }, stock_nightly: { finished_at: "2026-10-21 09:00:00" }, options: null }, "stock")?.finished_at).toBe("2026-10-21 10:00:00");
    expect(lastRun({}, "option")).toBeNull();
  });
});

describe("IdeasWidget", () => {
  it("shows stock ideas, selects the symbol and expands to group bars", async () => {
    table = [["/api/scan/ideas", () => reply({ asOf: null, ideas: [stockIdea] })], ["/api/scan/scorecard/NVDA", () => reply(card)]];
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

  it("saves universe settings with PUT", async () => {
    const settings = { mode: "watchlists", watchlistIds: null, sectors: [], industries: [], minPrice: 5, minAvgDollarVolume: 20_000_000, requireOptions: true };
    table = [
      ["/api/scan/ideas", () => reply({ asOf: null, ideas: [] })],
      ["/api/scan/universe", (init) => reply({ settings: init?.method === "PUT" ? { ...settings, ...JSON.parse(String(init.body)) } : settings, symbolCount: 42 })],
      ["/api/scan/sectors", () => reply({ sectors: ["Technology"], industries: [] })],
      ["/api/watchlists", () => reply([{ id: 3, name: "core", symbols: ["AAPL"] }])],
      ["/api/positions", () => reply({ importedAt: null, positions: [] })],
    ];
    wrap();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Whole market" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved: 42 symbols/);
    const put = calls.find((c) => c.init?.method === "PUT")!;
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
