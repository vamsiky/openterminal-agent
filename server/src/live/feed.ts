import * as alpaca from "../providers/alpaca.js";
import type { ExtendedHours, Quote, SessionPrice } from "../providers/yahoo.js";
import { upsertMinuteBars, type MinuteBar } from "../history/store.js";
import { dailyUniverse, minuteUniverse } from "../history/sync.js";
import { tradingDay } from "../history/time.js";
import { regularCloseAt, nyInstant, sessionAt, type Session } from "./session.js";

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
//
// Quotes keep the regular session (09:30–16:00 New York) apart from the
// extended ones: the price and change are the regular session's, and the
// after-hours, overnight and pre-market prices since the last regular close
// come alongside, each with its change from that close. Overnight prices
// (20:00–04:00) come from a second stream on Alpaca's Blue Ocean ATS feed
// ("boats"); opt out with LIVE_OVERNIGHT=0.

const FOCUS_TTL_MS = 10 * 60_000;
// How long a quote request waits for a first-click snapshot. Behind the shared
// request limiter or Alpaca's 429 backoff it can take far longer; past this the
// web sources answer and the snapshot lands for the next poll.
export const SNAPSHOT_WAIT_MS = 1_500;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const SNAPSHOT_BATCH = 500;
const RESUBSCRIBE_EVERY_MS = 30_000;
const MINUTE_FLUSH_MS = 5_000;
// Sale conditions (CTA/UTP) of trades that don't set the last sale, high or
// low: B, W average price; C cash; H price variation; I odd lot; M market
// center official close; N next day; P prior reference price; Q market center
// official open; R seller; V contingent; Z sold out of sequence; 4
// derivatively priced; 7 qualified contingent; 9 corrected consolidated close.
const NON_PRICE_CONDITIONS = new Set(["B", "C", "H", "I", "M", "N", "P", "Q", "R", "V", "W", "Z", "4", "7", "9"]);
// Extended-hours trades (T form T, U extended hours sold out of sequence)
// don't set the regular session's last sale, but they are the pre-market and
// after-hours prices.
const EXTENDED_CONDITIONS = new Set(["T", "U"]);
// The closing auction prints a few milliseconds after 16:00:00 with condition
// 6. It is the regular session's last sale (the official close), so it counts
// as regular by its condition rather than by a grace window after 16:00, which
// would also take in the first after-hours trades.
const CLOSING_PRINT = "6";

/** Whether instant `a` is before `b`; Alpaca's times have up to nanoseconds, so compare them as instants, not strings. */
const before = (a: string, b: string) => Date.parse(a) < Date.parse(b);

export type SessionTrade = { price: number; time: string };

export type LiveEntry = {
  symbol: string;
  /** Latest consolidated-tape price from any session (intraday charts follow it). */
  price: number | null;
  tradeTime: string | null;
  /** Latest regular-session price of barDay. */
  regPrice: number | null;
  regTime: string | null;
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
  /** barDay's closing auction price, the official close, when the trade feed had it. */
  closePrint: number | null;
  /** New York date of the regular session that open/high/low/volume belong to. */
  barDay: string | null;
  /** Close of the session before barDay, and its date. */
  prevClose: number | null;
  prevDay: string | null;
  /** Latest trade in each extended session. */
  pre: SessionTrade | null;
  post: SessionTrade | null;
  overnight: SessionTrade | null;
  updatedAt: number;
};

const entries = new Map<string, LiveEntry>();
const focus = new Map<string, number>(); // symbol → last requested (ms)
const unknownToAlpaca = new Map<string, number>(); // symbol → when a snapshot came back empty (ms)
const snapshotsInFlight = new Map<string, Promise<void>>(); // symbol → its first-click snapshot request
let minuteSet = new Set<string>(); // symbols whose minute bars are stored
const minuteBuffer: MinuteBar[] = [];

/** One Alpaca stream connection: the consolidated tape, or the overnight feed. */
type Stream = {
  name: string;
  /** Stream path after the host, e.g. "v2/sip". */
  path: () => string;
  apply: (m: alpaca.StreamMessage) => void;
  ws: WebSocket | null;
  connected: boolean; // authenticated and subscribed
  tradeSet: Set<string>; // symbols currently subscribed to trades + quotes
  reconnectDelay: number;
  lastMessageAt: number;
  lastError: string | null;
  /** Set when Alpaca refuses the feed for this account, so it stops retrying. */
  refused: boolean;
};

const stream = (name: string, path: () => string, apply: (m: alpaca.StreamMessage) => void): Stream => ({
  name, path, apply, ws: null, connected: false, tradeSet: new Set(), reconnectDelay: 1_000, lastMessageAt: 0, lastError: null, refused: false,
});

const sip = stream("live", () => `v2/${alpaca.feed()}`, applyMessage);
const boats = stream("overnight", () => "v1beta1/boats", applyOvernightMessage);
let overnightEnabled = false;

let allTrades = false;
let started = false;
let lastError: string | null = null;

function entry(symbol: string): LiveEntry {
  let e = entries.get(symbol);
  if (!e) {
    e = {
      symbol, price: null, tradeTime: null, regPrice: null, regTime: null,
      bid: null, ask: null, bidSize: null, askSize: null,
      open: null, high: null, low: null, volume: null, dayClose: null, closePrint: null, barDay: null, prevClose: null, prevDay: null,
      pre: null, post: null, overnight: null, updatedAt: 0,
    };
    entries.set(symbol, e);
  }
  return e;
}

// ---- applying data ----

/**
 * A newer regular session starts: the last one's close becomes the previous
 * close. Returns false for a day older than the session already known.
 */
function startSession(e: LiveEntry, day: string): boolean {
  if (e.barDay && day < e.barDay) return false;
  if (e.barDay && day > e.barDay) {
    e.prevClose = e.closePrint ?? e.dayClose ?? e.regPrice ?? e.prevClose;
    e.prevDay = e.barDay;
    e.open = e.high = e.low = null;
    e.volume = null;
    e.dayClose = null;
    e.closePrint = null;
    e.regPrice = null;
    e.regTime = null;
  }
  e.barDay = day;
  return true;
}

/**
 * Day bars cover the regular session only (extended-hours trades don't set
 * them). Returns false for a bar older than the session already known.
 */
function applyDayBar(e: LiveEntry, bar: { t: string; o: number; h: number; l: number; c: number; v: number }): boolean {
  if (!startSession(e, tradingDay(bar.t))) return false;
  e.open = bar.o;
  e.high = bar.h;
  e.low = bar.l;
  e.volume = bar.v;
  e.dayClose = bar.c;
  return true;
}

/** Record a trade (or a minute bar's close) at `time` against the session it falls in. */
function applyPrice(e: LiveEntry, price: number, time: string, session: Session | null): void {
  if (session === "regular") {
    if (!startSession(e, tradingDay(time))) return;
    if (e.regTime && before(time, e.regTime)) return;
    e.regPrice = price;
    e.regTime = time;
    if (e.open === null) e.open = price;
    if (e.high === null || price > e.high) e.high = price;
    if (e.low === null || price < e.low) e.low = price;
  } else if (session) {
    const last = e[session];
    if (last && before(time, last.time)) return;
    e[session] = { price, time };
  }
}

/** A snapshot from the consolidated tape (SIP or IEX). */
export function applySnapshot(symbol: string, snap: alpaca.Snapshot | null): void {
  if (!snap) return;
  const e = entry(symbol);
  const prev = snap.prevDailyBar;
  const daily = snap.dailyBar;
  // A snapshot can lag the stream around the open: a day bar older than the
  // session already known says nothing about it, nor its previous close.
  if (daily && applyDayBar(e, daily)) {
    if (prev && tradingDay(prev.t) < tradingDay(daily.t)) {
      e.prevClose = prev.c;
      e.prevDay = tradingDay(prev.t);
    }
    if (!e.regTime) {
      e.regPrice = daily.c;
      e.regTime = new Date(Math.min(regularCloseAt(tradingDay(daily.t)), Date.now())).toISOString();
    }
  }
  const trade = snap.latestTrade;
  if (trade) {
    if (!e.tradeTime || before(e.tradeTime, trade.t)) {
      e.price = trade.p;
      e.tradeTime = trade.t;
    }
    const session = sessionAt(trade.t);
    // A regular-session trade only counts for the day bar's own session.
    if (session !== "regular" || (daily && tradingDay(trade.t) === e.barDay)) applyPrice(e, trade.p, trade.t, session);
  }
  const quote = snap.latestQuote;
  if (quote) {
    e.bid = quote.bp || null;
    e.ask = quote.ap || null;
    e.bidSize = quote.bs ?? null;
    e.askSize = quote.as ?? null;
  }
  e.updatedAt = Date.now();
}

/** A snapshot from Blue Ocean's overnight feed: only its latest trade is used. */
export function applyOvernightSnapshot(symbol: string, snap: alpaca.Snapshot | null): void {
  const trade = snap?.latestTrade;
  if (!trade) return;
  const e = entry(symbol);
  applyPrice(e, trade.p, trade.t, "overnight");
  e.updatedAt = Date.now();
}

export function applyMessage(m: alpaca.StreamMessage): void {
  const symbol = m.S;
  if (!symbol) return;
  switch (m.T) {
    case "t": {
      const conditions = (m.c as string[] | undefined) ?? [];
      if (conditions.some((c) => NON_PRICE_CONDITIONS.has(c))) return;
      const t = m.t as string;
      const closing = conditions.includes(CLOSING_PRINT);
      const session = closing && sessionAt(t) === "post" ? "regular" : sessionAt(t);
      if (session === "regular" && conditions.some((c) => EXTENDED_CONDITIONS.has(c))) return;
      const e = entry(symbol);
      const p = m.p as number;
      // A late report (the closing print can come after the first after-hours
      // trades) still counts for its own session, but doesn't move the latest price.
      if (!e.tradeTime || !before(t, e.tradeTime)) {
        e.price = p;
        e.tradeTime = t;
      }
      // The tape has nothing overnight but the odd late report.
      if (session !== "overnight") applyPrice(e, p, t, session);
      if (closing && session === "regular" && e.barDay === tradingDay(t)) e.closePrint = p;
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
      if (!applyDayBar(e, m as unknown as alpaca.Bar)) return;
      if (!isRealtime(symbol)) {
        // Without the trade feed, the day bar's close is the latest regular price.
        e.regPrice = m.c as number;
        e.regTime = new Date(Math.min(regularCloseAt(e.barDay!), Date.now())).toISOString();
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
      // Tickers without the trade feed follow the extended sessions by the minute.
      const session = sessionAt(m.t as string);
      if (session === "pre" || session === "post") {
        if (isRealtime(symbol)) return;
        const e = entry(symbol);
        const end = new Date(Date.parse(m.t as string) + 60_000).toISOString();
        applyPrice(e, m.c as number, end, session);
        if (!e.tradeTime || before(e.tradeTime, end)) {
          e.price = m.c as number;
          e.tradeTime = end;
        }
        e.updatedAt = Date.now();
      }
      return;
    }
  }
}

/** A message from the overnight (Blue Ocean) stream. */
export function applyOvernightMessage(m: alpaca.StreamMessage): void {
  const symbol = m.S;
  if (!symbol) return;
  // Most overnight trades are odd lots, so they count here.
  if (m.T === "t") {
    const e = entry(symbol);
    applyPrice(e, m.p as number, m.t as string, "overnight");
    e.updatedAt = Date.now();
  } else if ((m.T === "b" || m.T === "u") && !overnightRealtime(symbol)) {
    const e = entry(symbol);
    applyPrice(e, m.c as number, new Date(Date.parse(m.t as string) + 60_000).toISOString(), "overnight");
    e.updatedAt = Date.now();
  }
}

// ---- reading ----

function marketState(now: Date): string {
  const s = sessionAt(now);
  return s === "pre" ? "PRE" : s === "regular" ? "REGULAR" : s === "post" ? "POST" : s === "overnight" ? "OVERNIGHT" : "CLOSED";
}

/** Whether `symbol` is getting every trade right now. */
export function isRealtime(symbol: string): boolean {
  return sip.connected && (allTrades || sip.tradeSet.has(symbol));
}

/** Whether `symbol` is getting every overnight trade right now. */
export function overnightRealtime(symbol: string): boolean {
  return boats.connected && boats.tradeSet.has(symbol);
}

export type LiveQuote = Quote & { live: boolean; extended: ExtendedHours };

/**
 * A quote from memory, or null when nothing is known yet. Price and change are
 * the regular session's (the close once it's over); `extended` has what traded
 * since the last close. `asOf` is the regular price's time.
 */
export function liveQuote(symbol: string, requestedAs = symbol, now = new Date()): LiveQuote | null {
  const e = entries.get(symbol);
  if (!e || !e.barDay) return null;
  const session = sessionAt(now);
  const finished = now.getTime() >= regularCloseAt(e.barDay);
  const price = finished ? e.closePrint ?? e.dayClose ?? e.regPrice : e.regPrice ?? e.dayClose;
  if (price === null) return null;
  const change = e.prevClose !== null ? price - e.prevClose : null;

  // Extended sessions count from the last regular close: the previous session's
  // while today's is on, this one's once it has closed.
  const anchor = finished ? price : e.prevClose;
  const anchorAt = finished
    ? regularCloseAt(e.barDay)
    : e.prevDay
      ? regularCloseAt(e.prevDay)
      : nyInstant(e.barDay, 4) - 8 * 3_600_000;
  const extended = (name: Exclude<Session, "regular">): SessionPrice | null => {
    const t = e[name];
    if (!t || Date.parse(t.time) <= anchorAt) return null;
    const diff = anchor !== null ? t.price - anchor : null;
    return {
      price: t.price,
      change: diff,
      changePercent: diff !== null && anchor ? (diff / anchor) * 100 : null,
      time: t.time,
      live: session === name && (name === "overnight" ? overnightRealtime(symbol) : isRealtime(symbol)),
    };
  };

  return {
    symbol: requestedAs,
    name: null,
    price,
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
    marketState: marketState(now),
    time: e.regTime ? Math.floor(Date.parse(e.regTime) / 1000) : null,
    source: "alpaca",
    asOf: e.regTime ?? undefined,
    // Live means the regular price itself is moving with every trade.
    live: session === "regular" && !finished && isRealtime(symbol),
    extended: { post: extended("post"), overnight: extended("overnight"), pre: extended("pre") },
  };
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
 * Waits at most `waitMs` for those snapshots; overlapping calls share them.
 */
export async function focusOn(symbols: string[], waitMs = SNAPSHOT_WAIT_MS): Promise<void> {
  if (!started) return;
  const now = Date.now();
  let added = false;
  for (const s of symbols) {
    if (!focus.has(s) && !sip.tradeSet.has(s)) added = true;
    focus.set(s, now);
  }
  if (added) scheduleResubscribe();
  // Ask once per FOCUS_TTL_MS about tickers Alpaca had nothing for, not on
  // every poll, and not again while a request for them is out.
  const unknown = symbols.filter(
    (s) => !snapshotsInFlight.has(s) && entries.get(s)?.price == null && now - (unknownToAlpaca.get(s) ?? 0) > FOCUS_TTL_MS
  );
  if (unknown.length > 0) {
    const request: Promise<void> = firstSnapshots(unknown, now).finally(() => {
      for (const s of unknown) if (snapshotsInFlight.get(s) === request) snapshotsInFlight.delete(s);
    });
    for (const s of unknown) snapshotsInFlight.set(s, request);
  }
  const pending = [...new Set(symbols.flatMap((s) => snapshotsInFlight.get(s) ?? []))];
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(pending), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
  clearTimeout(timer);
}

/** Snapshots for tickers nothing is known about yet, from the tape and the overnight feed. */
async function firstSnapshots(unknown: string[], now: number): Promise<void> {
  try {
    const [snaps, night] = await Promise.all([
      alpaca.snapshots(unknown),
      overnightEnabled ? alpaca.snapshots(unknown, "boats").catch(() => ({})) : Promise.resolve({}),
    ]);
    for (const [s, snap] of Object.entries(snaps)) applySnapshot(s, snap);
    for (const [s, snap] of Object.entries(night)) applyOvernightSnapshot(s, snap);
    for (const s of unknown) if (entries.get(s)?.price == null) unknownToAlpaca.set(s, now);
  } catch (err) {
    // Don't retry on every poll while Alpaca is failing; the web sources answer meanwhile.
    for (const s of unknown) unknownToAlpaca.set(s, now);
    lastError = `snapshot: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function status() {
  return {
    enabled: started,
    connected: sip.connected,
    allTrades,
    realtimeSymbols: allTrades ? "all" : sip.tradeSet.size,
    focused: focus.size,
    knownSymbols: entries.size,
    lastMessageAt: sip.lastMessageAt ? new Date(sip.lastMessageAt).toISOString() : null,
    lastError: sip.lastError ?? lastError,
    overnight: {
      enabled: overnightEnabled,
      connected: boats.connected,
      realtimeSymbols: boats.tradeSet.size,
      lastMessageAt: boats.lastMessageAt ? new Date(boats.lastMessageAt).toISOString() : null,
      lastError: boats.lastError,
    },
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
  const want = new Set([...minuteSet, ...focus.keys()]);
  for (const st of [sip, boats]) {
    if (!st.ws || !st.connected || (st === sip && allTrades)) continue;
    const add = [...want].filter((s) => !st.tradeSet.has(s));
    const drop = [...st.tradeSet].filter((s) => !want.has(s));
    if (add.length > 0) st.ws.send(JSON.stringify({ action: "subscribe", trades: add, quotes: st === sip ? add : [] }));
    if (drop.length > 0) st.ws.send(JSON.stringify({ action: "unsubscribe", trades: drop, quotes: st === sip ? drop : [] }));
    st.tradeSet = new Set(want);
  }
}

function connect(st: Stream): void {
  st.connected = false;
  let socket: WebSocket;
  try {
    socket = alpaca.openStream(st.path());
  } catch (err) {
    st.lastError = err instanceof Error ? err.message : String(err);
    return;
  }
  st.ws = socket;
  socket.addEventListener("message", (ev) => {
    st.lastMessageAt = Date.now();
    for (const m of alpaca.parseStream(ev.data)) {
      if (m.T === "success" && m.msg === "authenticated") {
        st.reconnectDelay = 1_000;
        st.connected = true;
        st.lastError = null;
        st.tradeSet = new Set();
        if (st === sip) {
          const base = { bars: ["*"], updatedBars: ["*"], dailyBars: ["*"] };
          socket.send(JSON.stringify(allTrades ? { action: "subscribe", ...base, trades: ["*"] } : { action: "subscribe", ...base }));
        } else {
          socket.send(JSON.stringify({ action: "subscribe", bars: ["*"], updatedBars: ["*"] }));
        }
        resubscribe();
        console.log(`[${st.name}] connected to Alpaca stream ${st.path()}${st === sip && allTrades ? " (all trades)" : ""}`);
      } else if (m.T === "error") {
        // e.g. 406 connection limit exceeded: another app is using this account's stream.
        st.lastError = `stream error ${m.code}: ${m.msg}`;
        console.error(`[${st.name}] ${st.lastError}`);
        // 402 not authorized / 409 insufficient subscription: retrying won't help.
        if (m.code === 402 || m.code === 409) st.refused = true;
      } else {
        st.apply(m);
      }
    }
  });
  socket.addEventListener("close", () => {
    st.connected = false;
    if (st.ws !== socket) return;
    st.ws = null;
    if (st.refused) {
      console.warn(`[${st.name}] Alpaca refused ${st.path()} for this account; not reconnecting`);
      return;
    }
    console.warn(`[${st.name}] stream closed; reconnecting in ${st.reconnectDelay / 1000}s`);
    setTimeout(() => connect(st), st.reconnectDelay).unref();
    st.reconnectDelay = Math.min(st.reconnectDelay * 2, 60_000);
  });
  socket.addEventListener("error", () => {
    st.lastError = "stream connection error";
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
  // Overnight snapshots for the watched tickers, at start and while the
  // overnight session is on; the stream's minute bars cover everything else.
  if (!overnightEnabled || (overnightSeeded && sessionAt(new Date()) !== "overnight")) return;
  const watched = [...new Set([...minuteSet, ...focus.keys()])];
  for (let i = 0; i < watched.length; i += SNAPSHOT_BATCH) {
    try {
      const snaps = await alpaca.snapshots(watched.slice(i, i + SNAPSHOT_BATCH), "boats");
      for (const [s, snap] of Object.entries(snaps)) applyOvernightSnapshot(s, snap);
    } catch (err) {
      boats.lastError = `snapshot: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  overnightSeeded = true;
}
let overnightSeeded = false;

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
  overnightEnabled = process.env.LIVE_OVERNIGHT !== "0";
  minuteSet = new Set(minuteUniverse());
  connect(sip);
  if (overnightEnabled) connect(boats);
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
  snapshotsInFlight.clear();
  minuteSet = new Set();
  minuteBuffer.length = 0;
  for (const st of [sip, boats]) {
    st.tradeSet = new Set();
    st.connected = false;
  }
}
