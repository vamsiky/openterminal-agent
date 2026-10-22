import { db } from "../db.js";
import * as fmp from "../providers/fmp.js";
import { allWatchlistSymbols } from "../routes/watchlists.js";
import { addDays } from "./store.js";

// Before the open / after the close. FMP's own report time comes first (the
// upcoming report's, else the majority of the last few reports'). Only a name
// whose FMP time is null (about 6% of US names) falls back to the time of day
// of its last few earnings press releases (FMP press releases, New York wall
// time), which is also the only source of "dmh".

export type Timing = "bmo" | "amc" | "dmh";
export type TimingRow = { timing: Timing | null; matched: number; total: number; source: "fmp" | "press_release" | null; basis?: "upcoming" | "history" };

export const RECENT_REPORTS = 4;
export const STALE_DAYS = 30;
const UPCOMING_DAYS = 14;
export const EARNINGS_TITLE = /result|earnings|quarter/i;

/** "YYYY-MM-DD HH:MM:SS" → bmo before 09:30, amc from 16:00, dmh between; null for date-only ("00:00:00") times. */
export function classify(publishedAt: string): Timing | null {
  const m = /(\d{2}):(\d{2}):(\d{2})$/.exec(publishedAt);
  if (!m) return null;
  const secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
  if (secs === 0) return null;
  if (secs < 9.5 * 3600) return "bmo";
  return secs >= 16 * 3600 ? "amc" : "dmh";
}

/**
 * The majority timing over the given report dates: each date votes with its
 * earliest timed earnings release. `matched` is the winner's votes and `total`
 * the dates looked at; no votes or a tie leaves `timing` null.
 */
export function timingFor(releases: fmp.PressRelease[], reportDates: string[]): Omit<TimingRow, "source"> {
  const votes: Record<Timing, number> = { bmo: 0, amc: 0, dmh: 0 };
  for (const date of reportDates) {
    const times = releases
      .filter((r) => r.publishedAt.startsWith(date) && EARNINGS_TITLE.test(r.title) && classify(r.publishedAt) !== null)
      .map((r) => r.publishedAt)
      .sort();
    if (times.length > 0) votes[classify(times[0])!]++;
  }
  const ranked = (Object.entries(votes) as Array<[Timing, number]>).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  return { timing: top[1] > 0 && top[1] > second[1] ? top[0] : null, matched: top[1], total: reportDates.length };
}

/**
 * FMP's report time from its per-symbol rows: the upcoming report's own time when it has one
 * (counted with the past reports for the basis), else the majority of the recent reported
 * rows' times. Null when FMP has no time, or ties.
 */
export function fmpTiming(rows: fmp.EarningsCalendarRow[], today: string): TimingRow | null {
  const day = (r: fmp.EarningsCalendarRow) => new Date(r.date * 1000).toISOString().slice(0, 10);
  const past = rows.filter((r) => r.epsActual !== null && day(r) < today).sort((a, b) => b.date - a.date).slice(0, RECENT_REPORTS);
  const upcoming = rows.filter((r) => r.epsActual === null && day(r) >= today).sort((a, b) => a.date - b.date)[0];
  const votes = new Map<Timing, number>();
  for (const r of past) if (r.time) votes.set(r.time, (votes.get(r.time) ?? 0) + 1);
  const timed = [...votes.values()].reduce((a, b) => a + b, 0);
  if (upcoming?.time) return { timing: upcoming.time, matched: (votes.get(upcoming.time) ?? 0) + 1, total: timed + 1, source: "fmp", basis: "upcoming" };
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) return null;
  return { timing: ranked[0][0], matched: ranked[0][1], total: past.length, source: "fmp", basis: "history" };
}

export function recordTiming(symbol: string, row: TimingRow, day: string): void {
  db.prepare(
    `INSERT INTO earnings_timing (symbol, timing, matched, total, updated_day, source) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (symbol) DO UPDATE SET timing = excluded.timing, matched = excluded.matched, total = excluded.total, updated_day = excluded.updated_day, source = excluded.source`
  ).run(symbol, row.timing, row.matched, row.total, day, row.timing ? row.source : null);
}

/** Stored timing per symbol; symbols never refreshed are absent. */
export function timingsFor(symbols: string[]): Map<string, TimingRow> {
  const get = db.prepare("SELECT timing, matched, total, source FROM earnings_timing WHERE symbol = ?");
  const out = new Map<string, TimingRow>();
  for (const s of symbols) {
    const r = get.get(s) as TimingRow | undefined;
    if (r) out.set(s, r);
  }
  return out;
}

function pastReportDates(symbol: string, today: string): string[] {
  const rows = db
    .prepare("SELECT report_date AS d FROM earnings_calendar WHERE symbol = ? AND report_date < ? AND eps_actual IS NOT NULL ORDER BY report_date DESC LIMIT ?")
    .all(symbol, today, RECENT_REPORTS) as Array<{ d: string }>;
  return rows.map((r) => r.d);
}

/** The last reported dates: the captured calendar's, topped up from FMP's rows when it has fewer than four. */
function recentReportDates(symbol: string, today: string, rows: fmp.EarningsCalendarRow[]): string[] {
  const dates = new Set(pastReportDates(symbol, today));
  if (dates.size < RECENT_REPORTS) for (const r of rows) if (r.epsActual !== null) dates.add(new Date(r.date * 1000).toISOString().slice(0, 10));
  return [...dates].filter((d) => d < today).sort().reverse().slice(0, RECENT_REPORTS);
}

/** Symbols to time: every watchlist symbol plus everything reporting in the next 14 days. */
function targets(today: string): string[] {
  const upcoming = db
    .prepare("SELECT DISTINCT symbol FROM earnings_calendar WHERE report_date >= ? AND report_date <= ?")
    .all(today, addDays(today, UPCOMING_DAYS)) as Array<{ symbol: string }>;
  return [...new Set([...allWatchlistSymbols(), ...upcoming.map((r) => r.symbol)])];
}

/** Refreshes the timing of every target without an entry from the last 30 days (all of them with `force`; just `only` when given). */
export async function refreshTimings(today: string, force = false, only?: string[]): Promise<{ symbols: number; timed: number; unknown: number; failed: number }> {
  const cutoff = addDays(today, -STALE_DAYS);
  const fresh = db.prepare("SELECT 1 FROM earnings_timing WHERE symbol = ? AND updated_day > ?");
  const todo = (only ?? targets(today)).filter((s) => force || fresh.get(s, cutoff) === undefined);
  let timed = 0;
  let unknown = 0;
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        const symbol = todo[next++];
        try {
          // FMP's own time first; its feed also tops up the report dates the inference needs.
          const fmpRows = await fmp.earningsReports(symbol, 8, { includeReportTimes: true }).catch(() => []);
          const fromFmp = fmpTiming(fmpRows, today);
          if (fromFmp) {
            recordTiming(symbol, fromFmp, today);
            timed++;
            continue;
          }
          const dates = recentReportDates(symbol, today, fmpRows);
          // The unranged feed reaches back about three months, so each report date asks for its own day.
          const releases = (await Promise.all(dates.map((d) => fmp.pressReleases(symbol, 100, { from: d, to: d })))).flat();
          const inferred = timingFor(releases, dates);
          const row: TimingRow = { ...inferred, source: inferred.timing ? "press_release" : null };
          recordTiming(symbol, row, today);
          if (row.timing) timed++;
          else unknown++;
        } catch (err) {
          failed++;
          console.error(`[timing] ${symbol} failed:`, err instanceof Error ? err.message : err);
        }
      }
    })
  );
  return { symbols: todo.length, timed, unknown, failed };
}

/** Runs a refresh and logs one summary line; never throws. */
export async function refreshTimingsInBackground(today: string): Promise<void> {
  try {
    const r = await refreshTimings(today);
    console.log(`[timing] ${today}: ${r.symbols} symbols, ${r.timed} timed, ${r.unknown} unknown${r.failed ? `, ${r.failed} failed` : ""}`);
  } catch (err) {
    console.error("[timing] refresh failed:", err);
  }
}
