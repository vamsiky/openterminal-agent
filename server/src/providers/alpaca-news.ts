import { dataFetch } from "./alpaca.js";

export type AlpacaNewsImage = { size: string; url: string };

export type AlpacaNewsItem = {
  id: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  author: string;
  symbols: string[];
  createdAt: string;
  updatedAt: string;
  images?: AlpacaNewsImage[];
};

/** The /api/news row, which NewsWidget reads. */
export type NewsItem = {
  title: string;
  link: string;
  publisher: string;
  publishedAt: string | null;
  symbol: string | null;
};

function parseItem(r: any): AlpacaNewsItem | null {
  if (!r?.headline || !r?.url) return null;
  const item: AlpacaNewsItem = {
    id: Number(r.id),
    headline: String(r.headline),
    summary: String(r.summary ?? ""),
    url: String(r.url),
    source: String(r.source ?? ""),
    author: String(r.author ?? ""),
    symbols: Array.isArray(r.symbols) ? r.symbols.map(String) : [],
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? r.created_at ?? ""),
  };
  if (Array.isArray(r.images) && r.images.length > 0) item.images = r.images.map((i: any) => ({ size: String(i.size), url: String(i.url) }));
  return item;
}

async function fetchNews(symbols: string | undefined, limit: number): Promise<AlpacaNewsItem[]> {
  const data = await dataFetch("/v1beta1/news", {
    symbols,
    limit: String(Math.min(Math.max(Math.trunc(limit), 1), 50)),
    sort: "desc",
    include_content: "false",
  });
  return ((data?.news ?? []) as any[]).map(parseItem).filter((i): i is AlpacaNewsItem => i !== null);
}

/** Newest-first Benzinga headlines that mention `symbol`. Alpaca allows 50 per page. */
export function symbolNews(symbol: string, limit = 20): Promise<AlpacaNewsItem[]> {
  return fetchNews(symbol.toUpperCase(), limit);
}

/** Newest-first headlines across all symbols. */
export function marketNews(limit = 20): Promise<AlpacaNewsItem[]> {
  return fetchNews(undefined, limit);
}

// Alpaca reports the wire as a lowercase id ("benzinga").
function publisherName(source: string): string {
  return source ? source.charAt(0).toUpperCase() + source.slice(1) : "Alpaca News";
}

/** Adapt to the /api/news row. */
export function toNewsItem(item: AlpacaNewsItem, symbol: string | null = null): NewsItem {
  return {
    title: item.headline,
    link: item.url,
    publisher: publisherName(item.source),
    publishedAt: item.createdAt && !Number.isNaN(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : null,
    symbol,
  };
}
