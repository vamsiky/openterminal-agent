import { decode, encode } from "@msgpack/msgpack";
import { tradingDay } from "../history/time.js";
import { regularCloseAt } from "../live/session.js";
import { isTradingDay, sessionClose, sessionOpen } from "../providers/alpaca-calendar.js";
import { optionsFeed, parseOcc } from "../providers/alpaca-options.js";
import { isConfigured } from "../providers/alpaca.js";
import { greeks, impliedVol, midPrice, riskFreeRate, yearsToExpiry } from "./black-scholes.js";
import { upsertOptionBars, type OptionBar } from "./store.js";

// Alpaca's real-time option stream (OPRA, or the indicative feed). Same shape
// as the stock stream in live/feed.ts: authenticate once "connected" arrives,
// subscribe after "authenticated", diff subscriptions as the selection moves,
// reconnect with backoff. Unlike the stock stream, frames are MsgPack only,
// in both directions.
//
// Keeps the latest quote and trade per contract in memory, computes IV and
// delta from each quote (at most once a second per contract), and writes
// minute bars to option_minute_bars.
//
// Subscriptions are tracked as requested (sent) and confirmed (Alpaca's
// "subscription" reply). A 405 means the account's symbol limit was hit: the
// confirmed set stays and becomes the cap for later selections.
//
// Runs from 09:25 to five minutes past the close on trading days; OPTIONS_STREAM=0 opts out.

const STREAM_URL = "wss://stream.data.alpaca.markets/v1beta1";
const CHECK_EVERY_MS = 30_000;
const FLUSH_EVERY_MS = 5_000;
const IV_MIN_GAP_MS = 1_000;
const SUBSCRIBE_CHUNK = 200;
// Five minutes before the open to five after the close (early closes included).
const WINDOW_BEFORE_MS = 5 * 60_000;
const WINDOW_AFTER_MS = 5 * 60_000;

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

export type ContractQuote = {
  occ: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  /** Receive time of the latest quote, ms. */
  quoteAt: number;
  last: number | null;
  lastAt: number | null;
  /** Contracts traded since this process subscribed, not the exchange's day volume. */
  tradedSize: number;
  iv: number | null;
  delta: number | null;
  ivAt: number;
};

/** The slice of the WebSocket API the stream uses; tests pass a fake. */
export type SocketLike = {
  binaryType: string;
  send(data: Uint8Array | string): void;
  close(): void;
  addEventListener(type: string, fn: (ev: any) => void): void;
};

export type StreamDeps = {
  /** Latest underlying price for IV, or null when unknown. */
  spot: (underlying: string) => number | null;
  openSocket?: (url: string) => SocketLike;
  now?: () => number;
  /** Test hook; defaults to the real minute-bar writer. */
  writeBars?: (bars: OptionBar[]) => void;
};

/** Whether the stream should be connected at `nowMs`: trading days, 09:25 to five minutes past the close. */
export function inStreamWindow(nowMs: number): boolean {
  const day = tradingDay(nowMs / 1000);
  return isTradingDay(day) && nowMs >= sessionOpen(day) - WINDOW_BEFORE_MS && nowMs < sessionClose(day) + WINDOW_AFTER_MS;
}

/** Node's WebSocket (undici) accepts request headers; Alpaca wants the msgpack content type on option streams. */
function nodeSocket(url: string): SocketLike {
  const Ctor = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => SocketLike;
  return new Ctor(url, { headers: { "Content-Type": "application/msgpack" } });
}

export function createOpraStream(deps: StreamDeps) {
  const now = deps.now ?? Date.now;
  const writeBars = deps.writeBars ?? upsertOptionBars;
  const quotes = new Map<string, ContractQuote>();
  const bars = new Map<string, OptionBar>(); // the current minute's bar per contract
  const dirty = new Set<string>();
  let targets = new Set<string>();
  let requested = new Set<string>();
  let subscribed = new Set<string>();
  /** Contracts Alpaca confirmed when it answered 405 on this connection; caps later selections. */
  let limited: number | null = null;
  let ws: SocketLike | null = null;
  let connected = false;
  let refused = false;
  let started = false;
  let reconnectDelay = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastError: string | null = null;
  let lastMessageAt = 0;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // Message rate: the last full minute, or the running estimate before one completes.
  let rateStart = now();
  let rateCount = 0;
  let lastRate = 0;
  const msgsPerMin = () => {
    const elapsed = now() - rateStart;
    if (elapsed >= 60_000) {
      lastRate = Math.round((rateCount * 60_000) / elapsed);
      rateStart = now();
      rateCount = 0;
    }
    return lastRate || (elapsed >= 10_000 ? Math.round((rateCount * 60_000) / elapsed) : 0);
  };

  const send = (payload: unknown) => ws?.send(encode(payload));

  function sendDiff(): void {
    if (!ws || !connected) return;
    // Targets are in priority order, so a limit keeps the first contracts.
    const wanted = limited === null ? [...targets] : [...targets].slice(0, limited);
    const wantedSet = new Set(wanted);
    const add = wanted.filter((o) => !requested.has(o));
    const drop = [...requested].filter((o) => !wantedSet.has(o));
    // Unsubscribe first so a selection change never holds old plus new.
    for (let i = 0; i < drop.length; i += SUBSCRIBE_CHUNK) {
      const chunk = drop.slice(i, i + SUBSCRIBE_CHUNK);
      send({ action: "unsubscribe", quotes: chunk, trades: chunk });
    }
    for (let i = 0; i < add.length; i += SUBSCRIBE_CHUNK) {
      const chunk = add.slice(i, i + SUBSCRIBE_CHUNK);
      send({ action: "subscribe", quotes: chunk, trades: chunk });
    }
    requested = wantedSet;
  }

  /** Bring the subscriptions to exactly `contracts`. */
  function setTargets(contracts: string[]): void {
    targets = new Set(contracts);
    sendDiff();
  }

  function minuteBar(occ: string, at: number): OptionBar {
    const ts = Math.floor(at / 60_000) * 60;
    let b = bars.get(occ);
    if (!b || b.ts !== ts) {
      b = { occ, ts, bid: null, ask: null, mid: null, last: null, volume: 0, iv: null, delta: null };
      bars.set(occ, b);
    }
    dirty.add(occ);
    return b;
  }

  function entry(occ: string, at: number): ContractQuote {
    let q = quotes.get(occ);
    if (!q) {
      q = { occ, bid: null, ask: null, bidSize: null, askSize: null, quoteAt: at, last: null, lastAt: null, tradedSize: 0, iv: null, delta: null, ivAt: 0 };
      quotes.set(occ, q);
    }
    return q;
  }

  function computeIv(q: ContractQuote, at: number): void {
    if (at - q.ivAt < IV_MIN_GAP_MS) return;
    const occ = parseOcc(q.occ);
    const mid = midPrice(q.bid, q.ask);
    const spot = occ ? deps.spot(occ.root) : null;
    if (!occ || mid === null || spot === null) return;
    q.ivAt = at;
    const base = { right: occ.type, spot, strike: occ.strike, t: yearsToExpiry(occ.expiry, at, regularCloseAt), rate: riskFreeRate() };
    const iv = impliedVol(base, mid);
    q.iv = iv;
    q.delta = iv === null ? null : greeks({ ...base, vol: iv }).delta;
  }

  /** Apply one decoded message; returns false for control messages the caller handles. */
  function apply(m: Record<string, any>): void {
    const occ = m.S as string | undefined;
    if (!occ) return;
    const at = now();
    if (m.T === "q") {
      const q = entry(occ, at);
      q.bid = typeof m.bp === "number" && m.bp > 0 ? m.bp : null;
      q.ask = typeof m.ap === "number" && m.ap > 0 ? m.ap : null;
      q.bidSize = typeof m.bs === "number" ? m.bs : null;
      q.askSize = typeof m.as === "number" ? m.as : null;
      q.quoteAt = at;
      computeIv(q, at);
      const b = minuteBar(occ, at);
      b.bid = q.bid;
      b.ask = q.ask;
      b.mid = midPrice(q.bid, q.ask);
      b.iv = q.iv;
      b.delta = q.delta;
    } else if (m.T === "t" && typeof m.p === "number") {
      const q = entry(occ, at);
      q.last = m.p;
      q.lastAt = at;
      const size = typeof m.s === "number" ? m.s : 0;
      q.tradedSize += size;
      const b = minuteBar(occ, at);
      b.last = m.p;
      b.volume = (b.volume ?? 0) + size;
    }
  }

  /** Handle one frame (an array of messages) from the socket. */
  function handleFrame(data: ArrayBuffer | Uint8Array | string): void {
    lastMessageAt = now();
    let msgs: unknown;
    try {
      msgs = decode(typeof data === "string" ? Buffer.from(data) : data instanceof Uint8Array ? data : new Uint8Array(data));
    } catch {
      lastError = "undecodable frame";
      return;
    }
    for (const m of (Array.isArray(msgs) ? msgs : [msgs]) as Array<Record<string, any>>) {
      rateCount++;
      if (m.T === "success" && m.msg === "connected") {
        send({ action: "auth", key: process.env.ALPACA_API_KEY_ID, secret: process.env.ALPACA_API_SECRET_KEY });
      } else if (m.T === "success" && m.msg === "authenticated") {
        reconnectDelay = 1_000;
        connected = true;
        lastError = null;
        subscribed = new Set();
        requested = new Set();
        limited = null;
        sendDiff();
        log(`[options] connected to Alpaca option stream (${optionsFeed()}), ${targets.size} contracts`);
      } else if (m.T === "subscription") {
        subscribed = new Set<string>(Array.isArray(m.quotes) ? m.quotes : []);
      } else if (m.T === "error" && m.code === 405) {
        // The rejected message left earlier subscriptions unchanged; keep what was confirmed.
        const known = limited !== subscribed.size;
        limited = subscribed.size;
        requested = new Set(subscribed);
        lastError = `Alpaca symbol limit: streaming ${limited} of ${targets.size}`;
        if (known) log(`[options] Alpaca symbol limit: streaming ${limited} of ${targets.size} contracts`);
      } else if (m.T === "error") {
        lastError = `stream error ${m.code}: ${m.msg}`;
        console.error(`${new Date().toISOString().slice(11, 19)} [options] ${lastError}`);
        // 402 auth failed / 409 insufficient subscription / 412 wrong format: retrying won't help.
        if (m.code === 402 || m.code === 409 || m.code === 412) refused = true;
      } else {
        apply(m);
      }
    }
  }

  function connect(): void {
    if (ws || refused || !isConfigured()) return;
    let socket: SocketLike;
    try {
      socket = (deps.openSocket ?? nodeSocket)(`${STREAM_URL}/${optionsFeed()}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    socket.binaryType = "arraybuffer";
    ws = socket;
    socket.addEventListener("message", (ev) => handleFrame(ev.data));
    socket.addEventListener("close", () => {
      connected = false;
      subscribed = new Set();
      requested = new Set();
      if (ws !== socket) return;
      ws = null;
      if (refused) {
        console.warn(`${new Date().toISOString().slice(11, 19)} [options] Alpaca refused the option stream for this account; not reconnecting`);
        return;
      }
      if (!started || !inStreamWindow(now())) return;
      console.warn(`${new Date().toISOString().slice(11, 19)} [options] stream closed; reconnecting in ${reconnectDelay / 1000}s`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (inStreamWindow(now())) connect();
      }, reconnectDelay);
      reconnectTimer.unref?.();
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    });
    socket.addEventListener("error", () => {
      if (ws !== socket) return;
      lastError = "stream connection error";
    });
  }

  function disconnect(): void {
    const socket = ws;
    ws = null;
    connected = false;
    subscribed = new Set();
    requested = new Set();
    lastError = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
  }

  /** Connect inside the window, disconnect outside it. */
  function tick(): void {
    if (!started) return;
    if (inStreamWindow(now())) {
      if (!ws && !reconnectTimer) connect();
    } else if (ws) {
      disconnect();
    }
  }

  function flush(): void {
    if (dirty.size === 0) return;
    const rows = [...dirty].map((o) => bars.get(o)!).filter(Boolean);
    dirty.clear();
    try {
      writeBars(rows);
    } catch (err) {
      console.error("[options] storing option minute bars failed:", err);
    }
    // Contracts whose minute has passed need no further updates.
    const minute = Math.floor(now() / 60_000) * 60;
    for (const [occ, b] of bars) if (b.ts < minute) bars.delete(occ);
  }

  function start(): void {
    if (started || process.env.OPTIONS_STREAM === "0" || !isConfigured()) return;
    if (!deps.openSocket && typeof WebSocket === "undefined") {
      console.warn("[options] this Node version has no WebSocket (needs 22+); option stream disabled");
      return;
    }
    started = true;
    timers.push(setInterval(tick, CHECK_EVERY_MS), setInterval(flush, FLUSH_EVERY_MS));
    for (const t of timers) t.unref?.();
    tick();
  }

  function stop(): void {
    started = false;
    for (const t of timers.splice(0)) clearInterval(t);
    flush();
    disconnect();
  }

  return {
    start,
    stop,
    tick,
    flush,
    setTargets,
    handleFrame,
    quote: (occ: string): ContractQuote | null => quotes.get(occ) ?? null,
    subscribedContracts: () => [...subscribed],
    status: () => ({
      enabled: started,
      connected,
      subscribed: subscribed.size,
      targets: targets.size,
      limited,
      inWindow: inStreamWindow(now()),
      msgsPerMin: msgsPerMin(),
      lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
      lastError,
      feed: optionsFeed(),
      refused,
    }),
  };
}

export type OpraStream = ReturnType<typeof createOpraStream>;
