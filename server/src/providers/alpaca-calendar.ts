import { db } from "../db.js";
import { nyInstant } from "../live/session.js";
import { tradingFetch } from "./alpaca-trading.js";

// Real trading days and early closes from Alpaca's market calendar. Fetched a
// year at a time, kept in memory and in the trading_calendar table. Until a
// year is known (or if the call fails) weekdays count as trading days with the
// usual 09:30–16:00 session, so callers never wait on the network.

db.exec(`
CREATE TABLE IF NOT EXISTS trading_calendar (
  day TEXT PRIMARY KEY,
  open TEXT NOT NULL,
  close TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS trading_calendar_years (
  year INTEGER PRIMARY KEY,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

type Session = { open: string; close: string };
const days = new Map<string, Session>();
const years = new Set<number>();
const RETRY_AFTER_FAIL_MS = 3_600_000;
const failedAt = new Map<number, number>();

for (const r of db.prepare("SELECT year FROM trading_calendar_years").all() as Array<{ year: number }>) years.add(r.year);
for (const r of db.prepare("SELECT day, open, close FROM trading_calendar").all() as Array<{ day: string; open: string; close: string }>) {
  days.set(r.day, { open: r.open, close: r.close });
}

const weekday = (day: string) => {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};

/** Whether the US market is open on a New York date (YYYY-MM-DD). */
export function isTradingDay(day: string): boolean {
  return years.has(Number(day.slice(0, 4))) ? days.has(day) : weekday(day);
}

const clock = (hhmm: string): [number, number] => {
  const [h, m] = hhmm.split(":").map(Number);
  return [h, m];
};

/** Epoch ms of the day's close: 16:00 New York, or the early close. */
export function sessionClose(day: string): number {
  const [h, m] = clock(days.get(day)?.close ?? "16:00");
  return nyInstant(day, h, m);
}

/** Epoch ms of the day's open (09:30 New York). */
export function sessionOpen(day: string): number {
  const [h, m] = clock(days.get(day)?.open ?? "09:30");
  return nyInstant(day, h, m);
}

/** Store a year's calendar rows (as Alpaca returns them) in memory and the table. */
export function loadCalendarRows(year: number, rows: Array<{ date: string; open: string; close: string }>): void {
  const insert = db.prepare("INSERT INTO trading_calendar (day, open, close) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET open = excluded.open, close = excluded.close");
  db.transaction(() => {
    db.prepare("DELETE FROM trading_calendar WHERE day >= ? AND day <= ?").run(`${year}-01-01`, `${year}-12-31`);
    for (const r of rows) insert.run(r.date, r.open, r.close);
    db.prepare("INSERT OR REPLACE INTO trading_calendar_years (year) VALUES (?)").run(year);
  })();
  for (const d of [...days.keys()]) if (d.startsWith(`${year}-`)) days.delete(d);
  for (const r of rows) days.set(r.date, { open: r.open, close: r.close });
  years.add(year);
}

/** Make sure `year` is loaded; false when the call failed (weekday fallback stays in force, retried after an hour). */
export async function ensureCalendar(year: number, nowMs = Date.now()): Promise<boolean> {
  if (years.has(year)) return true;
  if (nowMs - (failedAt.get(year) ?? 0) < RETRY_AFTER_FAIL_MS) return false;
  try {
    const rows = await tradingFetch("/v2/calendar", { start: `${year}-01-01`, end: `${year}-12-31` });
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty calendar");
    loadCalendarRows(year, rows.filter((r) => r?.date && r?.open && r?.close));
    return true;
  } catch (err) {
    failedAt.set(year, nowMs);
    console.warn(`[calendar] ${year} unavailable (${err instanceof Error ? err.message : String(err)}); using weekdays`);
    return false;
  }
}

/** Weekdays of `year` the calendar says are closed (holidays), for checking the data. */
export function holidays(year: number): string[] {
  const out: string[] = [];
  for (let d = Date.UTC(year, 0, 1); new Date(d).getUTCFullYear() === year; d += 86_400_000) {
    const day = new Date(d).toISOString().slice(0, 10);
    if (weekday(day) && !days.has(day)) out.push(day);
  }
  return out;
}

/** Test hook: forget everything in memory (the table is left alone). */
export function resetCalendar(): void {
  days.clear();
  years.clear();
  failedAt.clear();
}
