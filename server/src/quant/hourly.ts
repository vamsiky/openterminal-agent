import { db } from "../db.js";
import { nyClock } from "../history/scheduler.js";
import { tradingDay } from "../history/time.js";
import { nyInstant } from "../live/session.js";
import * as alpaca from "../providers/alpaca.js";
import type { Bar } from "./indicators.js";
import "./universe.js"; // creates scan_settings

// Hourly bars for the universe, cached so the hourly trend (h1) works from
// day one even where minute history is only a few sessions deep. Fetched from
// Alpaca once a day before the open, regular-session hours only (the 09:00
// bar covers 09:30–10:00 in practice). Today's hours come from the minute bars.

export const HOURLY_DAYS = 30; // trading days wanted
const FETCH_CALENDAR_DAYS = 45;
const KEEP_DAYS = 45;
const BATCH_SYMBOLS = 100;
const ENOUGH_BARS = 150; // a symbol with fewer cached bars gets a full fetch
const SESSION_SECONDS = 390 * 60;

db.exec(`
CREATE TABLE IF NOT EXISTS hourly_bars (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  vwap REAL,
  PRIMARY KEY (symbol, ts)
) WITHOUT ROWID;
-- The day each symbol was last asked for, whether or not Alpaca had bars: a symbol with none is not asked again until tomorrow.
CREATE TABLE IF NOT EXISTS hourly_attempts (
  symbol TEXT PRIMARY KEY,
  day TEXT NOT NULL
) WITHOUT ROWID;
`);

type BarFetch = (symbols: string[], start: string) => AsyncIterable<Record<string, alpaca.Bar[]>>;

const defaultFetch: BarFetch = (symbols, start) => alpaca.stockBars({ symbols, timeframe: "1Hour", start });

export type HourlyResult = { symbols: number; requests: number; bars: number; durationMs: number };

const getSetting = (key: string) => (db.prepare("SELECT value FROM scan_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
const setSetting = (key: string, value: string) =>
  db.prepare("INSERT INTO scan_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);

export type HourlyPlan = { mode: "daily" | "missing"; symbols: string[] };

/**
 * What to fetch now, or null. Symbols already asked for today are left out,
 * so a symbol Alpaca has no hourly bars for is tried once a day, not on every
 * tick; and a run cut short by a restart resumes with the symbols not yet done.
 * - daily: the first run of each day covers the symbols not yet asked for today.
 * - missing: afterwards, only symbols with nothing cached and not asked today (new to the universe).
 */
export function hourlyPlan(symbols: string[], now: Date): HourlyPlan | null {
  if (symbols.length === 0) return null;
  const today = nyClock(now).date;
  const json = JSON.stringify(symbols);
  const asked = new Set((db.prepare("SELECT symbol FROM hourly_attempts WHERE day = ? AND symbol IN (SELECT value FROM json_each(?))").all(today, json) as Array<{ symbol: string }>).map((r) => r.symbol));
  const todo = symbols.filter((s) => !asked.has(s));
  if (getSetting("hourly_fetched") !== today) return todo.length > 0 ? { mode: "daily", symbols: todo } : null;
  const have = new Set((db.prepare("SELECT DISTINCT symbol FROM hourly_bars WHERE symbol IN (SELECT value FROM json_each(?))").all(json) as Array<{ symbol: string }>).map((r) => r.symbol));
  const missing = todo.filter((s) => !have.has(s));
  return missing.length > 0 ? { mode: "missing", symbols: missing } : null;
}

export const hourlyNeeded = (symbols: string[], now: Date) => hourlyPlan(symbols, now) !== null;

/** Keeps regular-session hour bars: those starting 09:00 up to the last full hour before 16:00 New York. */
function regularOnly(bars: alpaca.Bar[]): Array<{ ts: number; b: alpaca.Bar }> {
  const opens = new Map<number, number>();
  const out: Array<{ ts: number; b: alpaca.Bar }> = [];
  for (const b of bars) {
    const ts = Math.floor(Date.parse(b.t) / 1000);
    // One New York trading day per key: bars run 04:00–20:00 NY, never across the 2-hours-after-midnight-UTC edge.
    const key = Math.floor((ts - 2 * 3600) / 86_400);
    let open = opens.get(key);
    if (open === undefined) {
      open = nyInstant(tradingDay(ts), 9, 30) / 1000;
      opens.set(key, open);
    }
    if (ts >= open - 1800 && ts < open + SESSION_SECONDS) out.push({ ts, b });
  }
  return out;
}

/**
 * Fetches hourly bars for `symbols`: all of the last 45 days for symbols with
 * thin cache, only the days since the last cached bar for the rest. Stores
 * them and prunes anything older than 45 days. Each batch is marked as asked
 * for today when it completes; `daily` also marks the day's fetch as done.
 */
export async function refreshHourly(symbols: string[], now = new Date(), fetchBars: BarFetch = defaultFetch, daily = true): Promise<HourlyResult> {
  const started = Date.now();
  const counts = new Map(
    (db.prepare("SELECT symbol, COUNT(*) AS n, MAX(ts) AS last FROM hourly_bars WHERE symbol IN (SELECT value FROM json_each(?)) GROUP BY symbol").all(JSON.stringify(symbols)) as Array<{ symbol: string; n: number; last: number }>).map((r) => [r.symbol, r])
  );
  const fullStart = new Date(now.getTime() - FETCH_CALENDAR_DAYS * 86_400_000).toISOString();
  const full = symbols.filter((s) => (counts.get(s)?.n ?? 0) < ENOUGH_BARS);
  const incremental = symbols.filter((s) => !full.includes(s));
  // Incremental symbols restart two days before the oldest "latest" bar, which also repairs a partial final day.
  const lastMin = incremental.length > 0 ? Math.min(...incremental.map((s) => counts.get(s)!.last)) : 0;
  const incStart = new Date((lastMin - 2 * 86_400) * 1000).toISOString();

  const put = db.prepare("INSERT OR REPLACE INTO hourly_bars (symbol, ts, open, high, low, close, volume, vwap) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const ask = db.prepare("INSERT INTO hourly_attempts (symbol, day) VALUES (?, ?) ON CONFLICT (symbol) DO UPDATE SET day = excluded.day");
  const today = nyClock(now).date;
  let requests = 0;
  let stored = 0;
  for (const [group, start] of [[full, fullStart], [incremental, incStart]] as const) {
    for (let i = 0; i < group.length; i += BATCH_SYMBOLS) {
      const batch = group.slice(i, i + BATCH_SYMBOLS);
      for await (const page of fetchBars(batch, start)) {
        requests++;
        db.transaction(() => {
          for (const [symbol, bars] of Object.entries(page)) {
            for (const { ts, b } of regularOnly(bars)) {
              put.run(symbol, ts, b.o, b.h, b.l, b.c, b.v, b.vw ?? null);
              stored++;
            }
          }
        })();
      }
      db.transaction(() => batch.forEach((sym) => ask.run(sym, today)))();
    }
  }
  db.prepare("DELETE FROM hourly_bars WHERE ts < ?").run(Math.floor(now.getTime() / 1000) - KEEP_DAYS * 86_400);
  if (daily) setSetting("hourly_fetched", today);
  return { symbols: symbols.length, requests, bars: stored, durationMs: Date.now() - started };
}

const hourlyStmt = db.prepare("SELECT ts, open, high, low, close, volume FROM hourly_bars WHERE symbol = ? AND ts >= ? ORDER BY ts");

/**
 * The hourly series for the trend score: cached hours of earlier days plus
 * today's hours built from the minute bars (so the current hour is live).
 * `minute` are today's and earlier minute bars, oldest first.
 */
export function hourlySeries(symbol: string, minute: Bar[], today: string, nowSec: number): Bar[] {
  const openToday = nyInstant(today, 9, 30) / 1000;
  const cached = hourlyStmt.all(symbol, nowSec - FETCH_CALENDAR_DAYS * 86_400) as Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
  const buckets = new Map<number, Bar>();
  for (const m of minute) {
    const ts = m.ts ?? 0;
    if (ts < openToday || ts >= openToday + SESSION_SECONDS) continue;
    const h = Math.floor(ts / 3600) * 3600; // New York offsets are whole hours, so UTC hours are New York hours
    const cur = buckets.get(h);
    if (cur) {
      cur.high = Math.max(cur.high, m.high);
      cur.low = Math.min(cur.low, m.low);
      cur.close = m.close;
      cur.volume += m.volume;
    } else buckets.set(h, { ts: h, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume });
  }
  // Today's hours: from minutes when there are some, else whatever the cache has for today.
  const earlier = cached.filter((c) => c.ts < openToday - 1800).map((c): Bar => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  const todays = buckets.size > 0 ? [...buckets.values()].sort((a, b) => a.ts! - b.ts!) : cached.filter((c) => c.ts >= openToday - 1800).map((c): Bar => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  return [...earlier, ...todays];
}
