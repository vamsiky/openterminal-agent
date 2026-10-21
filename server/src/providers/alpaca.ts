// Alpaca market data (paid SIP + OPRA plan). Market-data endpoints ONLY.
//
// Alpaca keys are account keys: the same pair can also place orders through
// Alpaca's trading API. This module is the only place that reads them, and it
// can only ever reach the market-data host below — every request goes through
// dataFetch(), which refuses any other origin. Agents propose; nothing in this
// app places orders.

const DATA_BASE = "https://data.alpaca.markets";
// Real-time stream for the same market data (trades, quotes, bars).
const STREAM_BASE = "wss://stream.data.alpaca.markets";

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

export type Timeframe = "1Min" | "5Min" | "15Min" | "1Hour" | "1Day";

export function isConfigured(): boolean {
  return Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

export function feed(): string {
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
export async function throttle(): Promise<void> {
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

/** Every market-data request goes through here: origin guard, throttle, 429 retry. */
export async function dataFetch(path: string, params: Record<string, string | undefined>): Promise<any> {
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

export type Snapshot = {
  latestTrade?: { t: string; p: number; s: number } | null;
  latestQuote?: { t: string; bp: number; ap: number; bs: number; as: number } | null;
  minuteBar?: Bar | null;
  dailyBar?: Bar | null;
  prevDailyBar?: Bar | null;
};

/**
 * Latest trade, quote and today's/yesterday's bars for up to a few hundred
 * symbols in one call. `source` "boats" is Blue Ocean ATS, the overnight session.
 */
export async function snapshots(symbols: string[], source = feed()): Promise<Record<string, Snapshot | null>> {
  if (symbols.length === 0) return {};
  const data = await dataFetch("/v2/stocks/snapshots", { symbols: symbols.join(","), feed: source });
  return data ?? {};
}

/**
 * Open a real-time stream ("v2/sip" by default; "v1beta1/boats" for the
 * overnight session) and authenticate once Alpaca says it's connected. The
 * caller subscribes after the "authenticated" message. Uses the global
 * WebSocket (Node 22+).
 */
export function openStream(path = `v2/${feed()}`): WebSocket {
  if (!isConfigured()) throw new Error("alpaca: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set");
  const ws = new WebSocket(`${STREAM_BASE}/${path}`);
  ws.addEventListener("message", (ev) => {
    const msgs = parseStream(ev.data);
    if (msgs.some((m) => m.T === "success" && m.msg === "connected")) {
      ws.send(JSON.stringify({ action: "auth", key: process.env.ALPACA_API_KEY_ID, secret: process.env.ALPACA_API_SECRET_KEY }));
    }
  });
  return ws;
}

export type StreamMessage = { T: string; S?: string; msg?: string; code?: number; [k: string]: unknown };

/** Stream frames are JSON arrays of messages. */
export function parseStream(data: unknown): StreamMessage[] {
  try {
    const parsed = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}
