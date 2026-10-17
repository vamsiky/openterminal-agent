// Alpaca market data (paid SIP + OPRA plan). Market-data endpoints ONLY.
//
// Alpaca keys are account keys: the same pair can also place orders through
// Alpaca's trading API. This module is the only place that reads them, and it
// can only ever reach the market-data host below — every request goes through
// dataFetch(), which refuses any other origin. Agents propose; nothing in this
// app places orders.

const DATA_BASE = "https://data.alpaca.markets";

export type Bar = {
  t: string; // RFC 3339 bar start time
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number; // trade count
  vw?: number; // volume-weighted average price
};

export type Timeframe = "1Min" | "5Min" | "1Hour" | "1Day";

export function isConfigured(): boolean {
  return Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

function feed(): string {
  return process.env.ALPACA_FEED?.trim() || "sip";
}

/** Requests per minute from ALPACA_MAX_REQ_PER_MIN; blank or invalid means the default. */
export function maxRequestsPerMinute(raw = process.env.ALPACA_MAX_REQ_PER_MIN): number {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) && n >= 1 ? n : 180;
}

// A simple spacing limiter: requests are released no faster than
// ALPACA_MAX_REQ_PER_MIN (default 180, under the 200/min of Alpaca's basic
// plan; paid plans allow far more and can raise it).
let nextSlot = 0;
async function throttle(): Promise<void> {
  const gap = 60_000 / maxRequestsPerMinute();
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gap;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Test hook: reset the limiter between tests. */
export function resetThrottle(): void {
  nextSlot = 0;
}

async function dataFetch(path: string, params: Record<string, string | undefined>): Promise<any> {
  if (!isConfigured()) throw new Error("alpaca: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set");
  const url = new URL(path, DATA_BASE);
  if (url.origin !== DATA_BASE) throw new Error(`alpaca: refusing non-market-data URL ${url.origin}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID!,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY!,
        Accept: "application/json",
      },
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, (isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`alpaca ${res.status} for ${url.pathname}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
}

export type BarsPage = { bars: Record<string, Bar[]>; nextPageToken: string | null };

/**
 * One page of historical stock bars for up to ~100 symbols. Prices are
 * split-adjusted by default so a split never shows up as a fake swing.
 */
export async function stockBarsPage(opts: {
  symbols: string[];
  timeframe: Timeframe;
  start: string;
  end?: string;
  pageToken?: string;
  adjustment?: "raw" | "split" | "dividend" | "all";
  limit?: number;
}): Promise<BarsPage> {
  const data = await dataFetch("/v2/stocks/bars", {
    symbols: opts.symbols.join(","),
    timeframe: opts.timeframe,
    start: opts.start,
    end: opts.end,
    adjustment: opts.adjustment ?? "split",
    feed: feed(),
    limit: String(opts.limit ?? 10_000),
    sort: "asc",
    page_token: opts.pageToken,
  });
  return { bars: data?.bars ?? {}, nextPageToken: data?.next_page_token ?? null };
}

/** Every page of stock bars, yielded page by page so callers can store as they go. */
export async function* stockBars(opts: Omit<Parameters<typeof stockBarsPage>[0], "pageToken">): AsyncGenerator<Record<string, Bar[]>> {
  let pageToken: string | undefined;
  do {
    const page = await stockBarsPage({ ...opts, pageToken });
    yield page.bars;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
}
