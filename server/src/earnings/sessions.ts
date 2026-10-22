import { ensureCalendar, isTradingDay } from "../providers/alpaca-calendar.js";
import type { ReportTime } from "./contracts.js";

// Trading-session arithmetic on the repo's trading_calendar (holidays and early
// closes), and the T0 / R sessions of a report. Until a year's calendar is
// loaded, weekdays count as trading days (see alpaca-calendar.ts).

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The session `n` trading days after `day` (before it when negative); `day` need not be a session itself. */
export function addSessions(day: string, n: number): string {
  let d = day;
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    d = shift(d, step);
    if (isTradingDay(d)) left--;
  }
  return d;
}

/** `day` itself when it is a session, else the next one. */
export function onOrAfter(day: string): string {
  let d = day;
  while (!isTradingDay(d)) d = shift(d, 1);
  return d;
}

/**
 * T0 is the last full session before the announcement and R the first session
 * after it. amc: T0 = report date, R = next session. bmo: T0 = previous session,
 * R = report date. dmh: both are the report date. A report date that is not a
 * session (weekend or holiday date in the feed) moves to the next session first.
 */
export function sessionsFor(reportDate: string, time: ReportTime | null): { t0: string | null; r: string | null } {
  if (time === null) return { t0: null, r: null };
  const d = onOrAfter(reportDate);
  if (time === "amc") return { t0: d, r: addSessions(d, 1) };
  if (time === "bmo") return { t0: addSessions(d, -1), r: d };
  return { t0: d, r: d };
}

/** Loads the trading calendar for every year in [from, to] (needs the Alpaca keys; failures leave the weekday fallback). */
export async function ensureCalendarRange(fromYear: number, toYear: number): Promise<void> {
  for (let y = fromYear; y <= toYear; y++) await ensureCalendar(y);
}

export { isTradingDay };
