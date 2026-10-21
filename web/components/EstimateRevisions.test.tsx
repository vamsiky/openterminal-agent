import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EstimateRevisions, { type EstimateRevisionsData } from "./EstimateRevisions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const none = { eps: null, revenue: null };
const data = (over: Partial<EstimateRevisionsData> = {}): EstimateRevisionsData => ({
  symbol: "NVDA",
  next: { reportDate: "2026-11-18", eps: 2.49, revenue: 108.8e9 },
  history: [{ day: "2026-09-01", eps: 2.4, revenue: 108e9 }, { day: "2026-10-10", eps: 2.49, revenue: 108.8e9 }],
  revisions: { "7d": { eps: 0.4, revenue: 0 }, "30d": { eps: -1.2, revenue: 0 }, "60d": { eps: 3.7, revenue: 0 }, "90d": none },
  ...over,
});

function renderWith(response: { status: number; body: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: response.status < 400, status: response.status, json: async () => response.body })));
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <EstimateRevisions symbol="NVDA" />
    </QueryClientProvider>
  );
}

describe("EstimateRevisions", () => {
  it("shows the estimate and the revisions that have history, coloured by direction", async () => {
    const { container } = renderWith({ status: 200, body: data() });
    await screen.findByText("2.49");
    expect(container.textContent).toBe("EPS est 2.49 · 7d +0.40% · 30d -1.20% · 60d +3.70%");
    expect(screen.getByText("+0.40%").className).toBe("up");
    expect(screen.getByText("-1.20%").className).toBe("down");
    expect(container.querySelector("span[title]")?.getAttribute("title")).toContain("2026-09-01: EPS 2.40");
  });

  it("says when tracking is recent", async () => {
    const { container } = renderWith({
      status: 200,
      body: data({ revisions: { "7d": none, "30d": none, "60d": none, "90d": none } }),
    });
    await screen.findByText("2.49");
    expect(container.textContent).toBe("EPS est 2.49 · tracking since 2026-09-01");
  });

  it("renders nothing without a tracked report or on errors", async () => {
    const empty = renderWith({ status: 200, body: data({ next: null, history: [] }) });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(empty.container.textContent).toBe("");
    cleanup();
    const failed = renderWith({ status: 503, body: { error: "no key" } });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(failed.container.textContent).toBe("");
  });
});
