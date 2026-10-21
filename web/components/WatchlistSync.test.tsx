import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminal } from "../store/terminal";
import WatchlistSync from "./WatchlistSync";

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("WatchlistSync", () => {
  let server: { name: string; symbols: string[] }[];
  let fetchMock: ReturnType<typeof vi.fn>;
  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

  beforeEach(() => {
    vi.useFakeTimers();
    server = [{ name: "AI", symbols: ["AAA"] }];
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return json(server);
      return json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    useTerminal.setState({ watchlists: [{ name: "AI", symbols: ["AAA"] }], activeWatchlist: "AI", watchlist: ["AAA"] });
  });

  afterEach(() => {
    cleanup();
    setVisibility("visible");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not re-post a list whose keepalive flush succeeded (#3)", async () => {
    render(<WatchlistSync />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Edit, then hide the tab before the 500 ms save timer fires.
    act(() => useTerminal.getState().addToWatchlist("NEW"));
    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0][1].keepalive).toBe(true);

    // Someone else replaces the list while the tab is hidden.
    server = [{ name: "AI", symbols: ["ZZZ"] }];
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(useTerminal.getState().watchlist).toEqual(["ZZZ"]);
    expect(posts()).toHaveLength(1);
  });

  it("keeps unsaved edits when the keepalive flush fails", async () => {
    render(<WatchlistSync />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (!init?.method) return json(server);
      return json({ error: "boom" }, 500);
    });
    act(() => useTerminal.getState().addToWatchlist("NEW"));
    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(0);
    });
    server = [{ name: "AI", symbols: ["ZZZ"] }];
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useTerminal.getState().watchlist).toEqual(["AAA", "NEW"]);
  });
});
