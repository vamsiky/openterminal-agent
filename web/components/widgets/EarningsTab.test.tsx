import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_EVENTS, FIXTURE_ROWS, review } from "../../lib/earningsFixtures";
import type { AgentsStatus } from "../../lib/agents";
import EarningsTab from "./EarningsTab";

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as Response;
let calls: Array<{ url: string; init?: RequestInit }>;
let table: Array<[string, (init?: RequestInit) => Response]>;

beforeEach(() => {
  localStorage.clear();
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

const agents = (spent = 1): AgentsStatus => ({ enabled: true, today: { day: "2026-10-21", spentUsd: spent, budgetUsd: 5, runs: 1, skippedForBudget: 0 }, queue: [], running: [] });
const wrap = (a: AgentsStatus | undefined = agents()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><EarningsTab agents={a} /></QueryClientProvider>);
};
const base = () => {
  table = [
    ["/api/earnings/screen", () => reply(FIXTURE_ROWS)],
    ["/api/earnings/reviews", () => reply([])],
    ["/api/earnings/events/", () => reply(FIXTURE_EVENTS)],
  ];
};
const postBody = (n = 0) => JSON.parse(String(calls.filter((c) => c.init?.method === "POST")[n].init?.body));

describe("EarningsTab", () => {
  it("lists every match with the count line and sends the default query", async () => {
    base();
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    expect(screen.getByTestId("count").textContent).toBe("4 reporting · 2 pass gates");
    const url = calls.find((c) => c.url.includes("/screen"))!.url;
    expect(url).toMatch(/horizon=intraday/);
    expect(url).toMatch(/from=\d{4}-\d\d-\d\d&to=/);
    expect(screen.getByText("no options")).toBeTruthy();
    expect(screen.queryByText(/buy|sell order/i)).toBeNull();
  });

  it("refetches with the filter query string and persists the filters", async () => {
    base();
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    fireEvent.change(screen.getByLabelText("Report time"), { target: { value: "amc" } });
    fireEvent.change(screen.getByLabelText("Min score"), { target: { value: "60" } });
    fireEvent.click(screen.getByLabelText("Tradable only"));
    fireEvent.click(screen.getByRole("button", { name: "Week ahead" }));
    await waitFor(() => {
      const u = calls.filter((c) => c.url.includes("/screen")).at(-1)!.url;
      expect(u).toMatch(/horizon=week/);
      expect(u).toMatch(/time=amc/);
      expect(u).toMatch(/minScore=60/);
      expect(u).toMatch(/tradable=1/);
    });
    expect(JSON.parse(localStorage.getItem("openterminal.earnings.filters.v1")!)).toMatchObject({ time: "amc", minScore: "60", tradable: true, horizon: "week" });
  });

  it("restores persisted filters", async () => {
    localStorage.setItem("openterminal.earnings.filters.v1", JSON.stringify({ sector: "Energy", verdict: "candidate" }));
    base();
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    expect((screen.getByLabelText("Sector") as HTMLInputElement).value).toBe("Energy");
    expect(calls.find((c) => c.url.includes("/screen"))!.url).toMatch(/sector=Energy&.*verdict=candidate|verdict=candidate.*sector=Energy/);
  });

  it("sorts when a header is clicked", async () => {
    base();
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    const order = () => screen.getAllByTestId(/^row-/).map((r) => r.getAttribute("data-testid"));
    expect(order()).toEqual(["row-CCC", "row-AAA", "row-BBB", "row-DDD"]);
    fireEvent.click(screen.getByText("Score ▼"));
    expect(order()).toEqual(["row-DDD", "row-BBB", "row-AAA", "row-CCC"]);
    fireEvent.click(screen.getByText("Symbol"));
    expect(order()[0]).toBe("row-AAA");
  });

  it("expands a row to components, gates, history, events, analyst and revisions", async () => {
    base();
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    fireEvent.click(screen.getByTestId("row-AAA"));
    const d = await screen.findByTestId("detail-AAA");
    expect(within(d).getByText("20/25")).toBeTruthy();
    expect(within(d).getByText(/Blended call median \+12%/)).toBeTruthy();
    expect(within(d).getByText(/Spread 5.0% is under 15%/)).toBeTruthy();
    expect(within(d).getByText("Own history (n 14)")).toBeTruthy();
    expect(within(d).getByText("Blended (k 5)")).toBeTruthy();
    expect(within(d).getAllByText(/win 62%/).length).toBe(2);
    expect(await within(d).findByText("2026-07-22")).toBeTruthy();
    expect(within(d).getByText("+6.5%")).toBeTruthy();
    expect(within(d).getByText(/Acme Securities upgrade/)).toBeTruthy();
    expect(within(d).getByText(/EPS 30d \+2\.1%/)).toBeTruthy();
    expect(within(d).queryByRole("button", { name: /buy|sell|order/i })).toBeNull();
  });

  it("shows failed gates and the latest review under the row", async () => {
    table = [["/api/earnings/screen", () => reply(FIXTURE_ROWS)], ["/api/earnings/reviews", () => reply([review("AAA")])], ["/api/earnings/events/", () => reply([])]];
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    fireEvent.click(screen.getByTestId("row-AAA"));
    const rv = await screen.findByTestId("review");
    expect(within(rv).getByText("WAIT")).toBeTruthy();
    expect(within(rv).getByText("66")).toBeTruthy();
    expect(within(rv).getByText("(-6)")).toBeTruthy();
    expect(within(rv).getByText(/Peer cut guidance \(Reuters/)).toBeTruthy();
    expect(within(rv).getByText("Opens above prior close")).toBeTruthy();
    expect(within(rv).getByText("Sell by 15:45 ET")).toBeTruthy();
    expect(within(rv).getByText(/cost \$0.09/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("row-CCC"));
    expect((await screen.findByTestId("detail-CCC")).textContent).toContain("Failed");
  });

  it("reviews one symbol and shows it queued", async () => {
    base();
    table.unshift(["/api/earnings/review", (init) => init?.method !== "POST" ? reply([]) : reply({ queued: 1, skipped: 0, estimatedCostUsd: 0.15 })]);
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    fireEvent.click(screen.getByTestId("row-AAA"));
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("Queued AAA.");
    expect(postBody()).toEqual({ horizon: "intraday", symbols: ["AAA"] });
    expect(screen.getByRole("button", { name: "Queued" })).toBeTruthy();
    expect(within(screen.getByTestId("row-AAA")).getByText("queued")).toBeTruthy();
  });

  it("asks for confirmation with the estimate before reviewing all shown", async () => {
    base();
    table.unshift(["/api/earnings/review", (init) => init?.method !== "POST" ? reply([]) : reply({ queued: 2, skipped: 0, estimatedCostUsd: 0.2 })]);
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    fireEvent.click(screen.getByRole("button", { name: "Review all shown" }));
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent).toMatch(/Review 2 names, estimated up to \$0\.30/);
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Review all shown" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm" }));
    await screen.findByText(/Queued 2, skipped 0 · estimated cost \$0\.20/);
    expect(postBody()).toMatchObject({ horizon: "intraday", filter: { horizon: "intraday" } });
    expect(postBody().filter.from).toMatch(/^\d{4}-/);
  });

  it("handles a 402 from review-all by disabling reviews with the reason", async () => {
    base();
    table.unshift(["/api/earnings/review", (init) => init?.method !== "POST" ? reply([]) : reply({ error: "budget" }, 402)]);
    wrap();
    await screen.findByRole("button", { name: "AAA" });
    fireEvent.click(screen.getByRole("button", { name: "Review all shown" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm" }));
    await screen.findByText("Daily AI budget reached; try again tomorrow.");
    const btn = screen.getByRole("button", { name: "Review all shown" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("Daily AI budget reached.");
    fireEvent.click(screen.getByTestId("row-AAA"));
    expect(((await screen.findByRole("button", { name: "Review" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables reviews up front when the daily budget is spent", async () => {
    base();
    wrap(agents(5));
    await screen.findByRole("button", { name: "AAA" });
    expect((screen.getByRole("button", { name: "Review all shown" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows more rows beyond the first page", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...FIXTURE_ROWS[0], symbol: `S${String(i).padStart(3, "0")}`, score: 250 - i }));
    table = [["/api/earnings/screen", () => reply(many)], ["/api/earnings/reviews", () => reply([])]];
    wrap();
    await screen.findByRole("button", { name: "S000" });
    expect(screen.getAllByTestId(/^row-/).length).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: /Show more \(150 left\)/ }));
    expect(screen.getAllByTestId(/^row-/).length).toBe(200);
  });
});
