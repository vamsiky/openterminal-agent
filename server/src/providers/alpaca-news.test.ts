import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetThrottle } from "./alpaca.js";
import { marketNews, symbolNews, toNewsItem } from "./alpaca-news.js";

const raw = {
  id: 62485936,
  headline: "SpaceX Can't Find Spare Nvidia Chips",
  summary: "Compute shortage may persist.",
  url: "https://www.benzinga.com/markets/equities/26/10/62485936/x",
  source: "benzinga",
  author: "Ananya Gairola",
  symbols: ["AMZN", "NVDA"],
  created_at: "2026-10-21T04:14:09Z",
  updated_at: "2026-10-21T04:15:00Z",
  images: [{ size: "thumb", url: "https://cdn.benzinga.com/a.jpg" }],
  content: "",
};

function mockFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body, headers: new Headers() });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("alpaca news", () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY_ID = "key-id";
    process.env.ALPACA_API_SECRET_KEY = "secret";
    process.env.ALPACA_MAX_REQ_PER_MIN = "60000";
    resetThrottle();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
    delete process.env.ALPACA_MAX_REQ_PER_MIN;
  });

  it("asks for one symbol's news, newest first, capped at 50", async () => {
    const fetchMock = mockFetch({ news: [raw], next_page_token: null });
    const items = await symbolNews("nvda", 500);
    const u = new URL(fetchMock.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe("https://data.alpaca.markets/v1beta1/news");
    expect(u.searchParams.get("symbols")).toBe("NVDA");
    expect(u.searchParams.get("limit")).toBe("50");
    expect(u.searchParams.get("sort")).toBe("desc");
    expect(items).toEqual([
      {
        id: 62485936,
        headline: "SpaceX Can't Find Spare Nvidia Chips",
        summary: "Compute shortage may persist.",
        url: raw.url,
        source: "benzinga",
        author: "Ananya Gairola",
        symbols: ["AMZN", "NVDA"],
        createdAt: "2026-10-21T04:14:09Z",
        updatedAt: "2026-10-21T04:15:00Z",
        images: [{ size: "thumb", url: "https://cdn.benzinga.com/a.jpg" }],
      },
    ]);
  });

  it("market news sends no symbols filter and drops items without a headline or url", async () => {
    const fetchMock = mockFetch({ news: [{ ...raw, images: [] }, { ...raw, headline: "" }, { ...raw, url: "" }] });
    const items = await marketNews(5);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has("symbols")).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("images");
  });

  it("adapts to the NewsItem shape the widget reads", async () => {
    mockFetch({ news: [raw] });
    const [item] = await symbolNews("NVDA");
    expect(toNewsItem(item, "NVDA")).toEqual({
      title: "SpaceX Can't Find Spare Nvidia Chips",
      link: raw.url,
      publisher: "Benzinga",
      publishedAt: "2026-10-21T04:14:09.000Z",
      symbol: "NVDA",
    });
    expect(toNewsItem({ ...item, source: "", createdAt: "" })).toMatchObject({ publisher: "Alpaca News", publishedAt: null, symbol: null });
  });
});
