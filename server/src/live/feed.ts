import * as alpaca from "../providers/alpaca.js";
import type { Quote } from "../providers/yahoo.js";
import { upsertMinuteBars, type MinuteBar } from "../history/store.js";
import { dailyUniverse, minuteUniverse } from "../history/sync.js";
import { tradingDay } from "../history/time.js";
import { nyClock } from "../history/scheduler.js";

// Real-time prices for US stocks and ETFs from Alpaca's stream, kept in
// memory so a click on a ticker is answered without a web request.
//
// - Every trade and quote, for the tickers that matter right now: the
//   watchlist, S&P 500, Nasdaq-100 and sector ETFs (minuteUniverse), plus any
//   ticker someone has open (focus), which is subscribed on the first request
//   and dropped after FOCUS_TTL_MS without one.
// - Minute and daily bars for every US ticker ("*"), so the rest of the
//   market is at most a minute old, for scans.
// - Snapshots over REST to seed every ticker at start, refresh them every
//   few minutes, and answer a first click before the stream catches up.
//
// Opt out with LIVE_STREAM=0. LIVE_ALL_TRADES=1 subscribes to every trade in
// the market instead of the tiers above: a much heavier feed at the open.

const FOCUS_TTL_MS = 10 * 60_000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const SNAPSHOT_BATCH = 500;
const RESUBSCRIBE_EVERY_MS = 30_000;
const MINUTE_FLUSH_MS = 5_000;
// Odd-lot trades don't set the last sale price on the consolidated tape.
const NON_PRICE_CONDITIONS = new Set(["I"]);

export type LiveEntry = {
  symbol: string;
  price: number | null;
  tradeTime: string | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** Close of barDay's day bar (as last reported), the next session's previous close. */
  dayClose: number | null;
  /** New York date of the day bar that open/high/low/volume belong to. */
  barDay: string | null;
  /** Close of the session before barDay. */
  prevClose: number | null;
  updatedAt: number;
};

const entries = new Map<string, LiveEntry>();
const focus = new Map<string, number>(); // symbol → last requested (ms)
const unknownToAlpaca = new Map<string, number>(); // symbol → when a snapshot came back empty (ms)
let tradeSet = new Set<string>(); // symbols currently subscribed to trades + quotes
let minuteSet = new Set<string>(); // symbols whose minute bars are stored
const minuteBuffer: MinuteBar[] = [];

let ws: WebSocket | null = null;
let connected = false; // authenticated and subscribed
let allTrades = false;
let started = false;
let lastMessageAt = 0;
let lastError: string | null = null;
let reconnectDelay = 1_000;

function entry(symbol: string): LiveEntry {
  let e = entries.get(symbol);
  if (!e) {
    e = {
      symbol, price: null, tradeTime: null, bid: null, ask: null, bidSize: null, askSize: null,
      open: null, high: null, low: null, volume: null, dayClose: null, barDay: null, prevClose: null, updatedAt: 0,
    };
    entries.set(symbol, e);
  }
  return e;
}

// ---- applying data ----

/** A newer day bar starts a new session: yesterday's close becomes the previous close. */
function applyDayBar(e: LiveEntry, bar: { t: string; o: number; h: number; l: number; c: number; v: number }): void {
  const day = tradingDay(bar.t);
  if (e.barDay && day < e.barDay) return;
  if (e.barDay && day > e.barDay) e.prevClose = e.dayClose ?? e.price ?? e.prevClose;
  e.barDay = day;
  e.open = bar.o;
  e.high = bar.h;
  e.low = bar.l;
  e.volume = bar.v;
  e.dayClose = bar.c;
}

export function applySnapshot(symbol: string, snap: alpaca.Snapshot | null): void {
  if (!snap) return;
  const e = entry(symbol);
  const trade = snap.latestTrade;
  if (trade && (!e.tradeTime || trade.t > e.tradeTime)) {
    e.price = trade.p;
    e.tradeTime = trade.t;
  }
  const quote = snap.latestQuote;
  if (quote) {
    e.bid = quote.bp || null;
    e.ask = quote.ap || null;
    e.bidSize = quote.bs ?? null;
    e.askSize = quote.as ?? null;
  }
  const daily = snap.dailyBar;
  const prev = snap.prevDailyBar;
  if (daily) {
    const today = tradingDay(Date.now() / 1000);
    if (tradingDay(daily.t) === today || !trade || tradingDay(trade.t) === tradingDay(daily.t)) {
      // Today's session (or the last one, outside trading days) is the day bar.
      e.barDay = tradingDay(daily.t);
      e.open = daily.o;
      e.high = daily.h;
      e.low = daily.l;
      e.volume = daily.v;
      e.dayClose = daily.c;
      e.prevClose = prev?.c ?? e.prevClose;
    } else {
      // Pre-market: the latest day bar is yesterday's, so its close is the previous close.
      e.barDay = tradingDay(trade.t);
      e.open = e.high = e.low = null;
      e.volume = null;
      e.dayClose = null;
      e.prevClose = daily.c;
    }
  }
  e.updatedAt = Date.now();
}

export function applyMessage(m: alpaca.StreamMessage): void {
  const symbol = m.S;
  if (!symbol) return;
  switch (m.T) {
    case "t": {
      const conditions = (m.c as string[] | undefined) ?? [];
      if (conditions.some((c) => NON_PRICE_CONDITIONS.has(c))) return;
      const e = entry(symbol);
      const t = m.t as string;
      if (e.tradeTime && t < e.tradeTime) return;
      const p = m.p as number;
      if (e.barDay && tradingDay(t) > e.barDay) {
        applyDayBar(e, { t, o: p, h: p, l: p, c: p, v: 0 });
        e.dayClose = null;
      }
      e.price = p;
      e.tradeTime = t;
      if (e.high !== null && p > e.high) e.high = p;
      if (e.low !== null && p < e.low) e.low = p;
      e.updatedAt = Date.now();
      return;
    }
    case "q": {
      const e = entry(symbol);
      e.bid = (m.bp as number) || null;
      e.ask = (m.ap as number) || null;
      e.bidSize = (m.bs as number) ?? null;
      e.askSize = (m.as as number) ?? null;
      e.updatedAt = Date.now();
      return;
    }
    case "d": {
      const e = entry(symbol);
      applyDayBar(e, m as unknown as alpaca.Bar);
      if (!tradeSet.has(symbol) && !allTrades) {
        // Without the trade feed, the day bar's close is the latest price.
        e.price = m.c as number;
        e.tradeTime = new Date().toISOString();
      }
      e.updatedAt = Date.now();
      return;
    }
    case "b":
    case "u": {
      if (minuteSet.has(symbol)) {
        minuteBuffer.push({
          symbol, ts: Math.floor(Date.parse(m.t as string) / 1000),
          open: m.o as number, high: m.h as number, low: m.l as number, close: m.c as number,
          volume: m.v as number, vwap: (m.vw as number) ?? null, trades: (m.n as number) ?? null,
        });
      }
      return;
    }
  }
}

// ---- reading ----

function marketState(now: Date): string {
  const ny = nyClock(now);
  if (ny.weekday === "Sat" || ny.weekday === "Sun") return "CLOSED";
  const minutes = ny.hour * 60 + Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", minute: "2-digit" }).format(now));
  if (minutes < 4 * 60) return "CLOSED";
  if (minutes < 9 * 60 + 30) return "PRE";
  if (minutes < 16 * 60) return "REGULAR";
  if (minutes < 20 * 60) return "POST";
  return "CLOSED";
}

/** Whether `symbol` is getting every trade right now. */
export function isRealtime(symbol: string): boolean {
  return connected && (allTrades || tradeSet.has(symbol));
}

export type LiveQuote = Quote & { live: boolean };

/** A quote from memory, or null when nothing is known yet. `asOf` is the last trade's time. */
export function liveQuote(symbol: string, requestedAs = symbol): LiveQuote | null {
  const e = entries.get(symbol);
  if (!e || e.price === null) return null;
  const change = e.prevClose !== null ? e.price - e.prevClose : null;
  return {
    symbol: requestedAs,
    name: null,
    price: e.price,
    change,
    changePercent: change !== null && e.prevClose ? (change / e.prevClose) * 100 : null,
    open: e.open,
    high: e.high,
    low: e.low,
    previousClose: e.prevClose,
    bid: e.bid,
    ask: e.ask,
    volume: e.volume,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: null,
    marketState: marketState(new Date()),
    time: e.tradeTime ? Math.floor(Date.parse(e.tradeTime) / 1000) : null,
    source: "alpaca",
    asOf: e.tradeTime ?? undefined,
    live: isRealtime(symbol),
  } as LiveQuote;
}

export function liveEntry(symbol: string): LiveEntry | undefined {
  return entries.get(symbol);
}

export function enabled(): boolean {
  return started;
}

/**
 * Mark tickers as open on someone's screen: they get every trade from the
 * next subscription update (within a second), and a snapshot now if nothing
 * is known about them yet, so the first answer doesn't wait for a trade.
 */
export async function focusOn(symbols: string[]): Promise<void> {
  if (!started) return;
  const now = Date.now();
  let added = false;
  for (const s of symbols) {
    if (!focus.has(s) && !tradeSet.has(s)) added = true;
    focus.set(s, now);
  }
  if (added) scheduleResubscribe();
  // Ask once per FOCUS_TTL_MS about tickers Alpaca had nothing for, not on every poll.
  const unknown = symbols.filter((s) => entries.get(s)?.price == null && now - (unknownToAlpaca.get(s) ?? 0) > FOCUS_TTL_MS);
  if (unknown.length > 0) {
    try {
      const snaps = await alpaca.snapshots(unknown);
      for (const [s, snap] of Object.entries(snaps)) applySnapshot(s, snap);
      for (const s of unknown) if (entries.get(s)?.price == null) unknownToAlpaca.set(s, now);
    } catch (err) {
      // Don't retry on every poll while Alpaca is failing; the web sources answer meanwhile.
      for (const s of unknown) unknownToAlpaca.set(s, now);
      lastError = `snapshot: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export function status() {
  return {
    enabled: started,
    connected,
    allTrades,
    realtimeSymbols: allTrades ? "all" : tradeSet.size,
    focused: focus.size,
    knownSymbols: entries.size,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
    lastError,
  };
}

// ---- subscriptions ----

let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleResubscribe(): void {
  if (resubscribeTimer) return;
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    resubscribe();
  }, 200);
}

/** Bring trade/quote subscriptions in line with the always-on tiers plus focused tickers. */
function resubscribe(): void {
  const now = Date.now();
  for (const [s, at] of focus) if (now - at > FOCUS_TTL_MS) focus.delete(s);
  minuteSet = new Set(minuteUniverse());
  if (!ws || !connected || allTrades) return;
  const want = new Set([...minuteSet, ...focus.keys()]);
  const add = [...want].filter((s) => !tradeSet.has(s));
  const drop = [...tradeSet].filter((s) => !want.has(s));
  if (add.length > 0) ws.send(JSON.stringify({ action: "subscribe", trades: add, quotes: add }));
  if (drop.length > 0) ws.send(JSON.stringify({ action: "unsubscribe", trades: drop, quotes: drop }));
  tradeSet = want;
}

function connect(): void {
  connected = false;
  let socket: WebSocket;
  try {
    socket = alpaca.openStream();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return;
  }
  ws = socket;
  socket.addEventListener("message", (ev) => {
    lastMessageAt = Date.now();
    for (const m of alpaca.parseStream(ev.data)) {
      if (m.T === "success" && m.msg === "authenticated") {
        reconnectDelay = 1_000;
        connected = true;
        tradeSet = new Set();
        const base = { bars: ["*"], updatedBars: ["*"], dailyBars: ["*"] };
        socket.send(JSON.stringify(allTrades ? { action: "subscribe", ...base, trades: ["*"] } : { action: "subscribe", ...base }));
        resubscribe();
        console.log(`[live] connected to Alpaca stream${allTrades ? " (all trades)" : ""}`);
      } else if (m.T === "error") {
        // e.g. 406 connection limit exceeded: another app is using this account's stream.
        lastError = `stream error ${m.code}: ${m.msg}`;
        console.error(`[live] ${lastError}`);
      } else {
        applyMessage(m);
      }
    }
  });
  socket.addEventListener("close", () => {
    connected = false;
    if (ws !== socket) return;
    ws = null;
    console.warn(`[live] stream closed; reconnecting in ${reconnectDelay / 1000}s`);
    setTimeout(connect, reconnectDelay).unref();
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  });
  socket.addEventListener("error", () => {
    lastError = "stream connection error";
  });
}

async function refreshSnapshots(): Promise<void> {
  const symbols = dailyUniverse();
  for (let i = 0; i < symbols.length; i += SNAPSHOT_BATCH) {
    try {
      const snaps = await alpaca.snapshots(symbols.slice(i, i + SNAPSHOT_BATCH));
      for (const [s, snap] of Object.entries(snaps)) applySnapshot(s, snap);
    } catch (err) {
      lastError = `snapshot: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

function flushMinuteBars(): void {
  if (minuteBuffer.length === 0) return;
  try {
    upsertMinuteBars(minuteBuffer.splice(0));
  } catch (err) {
    console.error("[live] storing minute bars failed:", err);
  }
}

export function startLiveFeed(): void {
  if (started || process.env.LIVE_STREAM === "0" || !alpaca.isConfigured()) return;
  if (typeof WebSocket === "undefined") {
    console.warn("[live] this Node version has no WebSocket (needs 22+); live prices disabled");
    return;
  }
  started = true;
  allTrades = process.env.LIVE_ALL_TRADES === "1";
  minuteSet = new Set(minuteUniverse());
  connect();
  const snap = () => void refreshSnapshots();
  snap();
  setInterval(snap, SNAPSHOT_EVERY_MS).unref();
  setInterval(resubscribe, RESUBSCRIBE_EVERY_MS).unref();
  setInterval(flushMinuteBars, MINUTE_FLUSH_MS).unref();
}

/** Test hook. */
export function resetLiveFeed(): void {
  entries.clear();
  focus.clear();
  unknownToAlpaca.clear();
  tradeSet = new Set();
  minuteSet = new Set();
  minuteBuffer.length = 0;
  connected = false;
}
