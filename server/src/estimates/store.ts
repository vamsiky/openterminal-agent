import { db } from "../db.js";

// Consensus estimates for upcoming reports, captured once a day from FMP's
// earnings calendar. A row is stored only when the estimate differs from the
// latest stored one for that (symbol, report date), so "what was it on day X?"
// is the newest row on or before X.

export type Estimate = { eps: number | null; revenue: number | null };
export type SnapshotInput = { symbol: string; reportDate: string; eps: number | null; revenue: number | null };
export type HistoryPoint = { day: string; eps: number | null; revenue: number | null };

export const WINDOWS = [7, 30, 60, 90] as const;
export type Revisions = Record<`${(typeof WINDOWS)[number]}d`, Estimate>;

const same = (a: number | null, b: number | null) => a === b;

/** Stores each row whose estimate changed since its latest snapshot (or is new); returns how many were stored. */
export function recordSnapshots(rows: SnapshotInput[], day: string): number {
  const latest = db.prepare(
    "SELECT eps_estimate AS eps, revenue_estimate AS revenue FROM estimate_snapshots WHERE symbol = ? AND report_date = ? ORDER BY captured_day DESC LIMIT 1"
  );
  const insert = db.prepare(
    "INSERT OR REPLACE INTO estimate_snapshots (symbol, report_date, captured_day, eps_estimate, revenue_estimate) VALUES (?, ?, ?, ?, ?)"
  );
  let stored = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (r.eps === null && r.revenue === null) continue;
      const prev = latest.get(r.symbol, r.reportDate) as Estimate | undefined;
      if (prev && same(prev.eps, r.eps) && same(prev.revenue, r.revenue)) continue;
      insert.run(r.symbol, r.reportDate, day, r.eps, r.revenue);
      stored++;
    }
  })();
  return stored;
}

export type CalendarInput = {
  symbol: string;
  reportDate: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
};

/** Upserts every calendar row, past or future, stamping it as seen on `day`. */
export function recordCalendar(rows: CalendarInput[], day: string): void {
  const upsert = db.prepare(
    `INSERT INTO earnings_calendar (symbol, report_date, eps_estimate, revenue_estimate, eps_actual, revenue_actual, last_seen_day)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (symbol, report_date) DO UPDATE SET
       eps_estimate = excluded.eps_estimate, revenue_estimate = excluded.revenue_estimate,
       eps_actual = excluded.eps_actual, revenue_actual = excluded.revenue_actual, last_seen_day = excluded.last_seen_day`
  );
  db.transaction(() => {
    for (const r of rows) upsert.run(r.symbol, r.reportDate, r.epsEstimate, r.revenueEstimate, r.epsActual, r.revenueActual, day);
  })();
}

/** The newest day whose capture finished every window, or null before the first. */
export function latestRunDay(): string | null {
  return (db.prepare("SELECT MAX(day) AS d FROM estimate_runs").get() as { d: string | null }).d;
}

export function hasCalendarRows(): boolean {
  return db.prepare("SELECT 1 FROM earnings_calendar LIMIT 1").get() !== undefined;
}

export type CalendarEntry = {
  symbol: string;
  nextEarningsDate: number | null; // unix seconds
  lastEarningsDate: number | null;
  epsForecast: number | null;
  revenueForecast: number | null;
  lastEps: number | null;
  lastEpsEstimate: number | null;
  lastSurprisePercent: number | null;
  lastRevenue: number | null;
};

const unix = (day: string) => Date.parse(day + "T00:00:00Z") / 1000;

/**
 * Next and last report per symbol from the captured calendar. The next report
 * is the earliest date on or after `today` seen in the latest successful
 * capture (FMP moves dates, so older sightings are stale); the last is the
 * newest earlier date with an actual. `found` is false when a symbol has neither.
 */
export function calendarFor(symbols: string[], today: string): Array<CalendarEntry & { found: boolean }> {
  const seen = latestRunDay() ?? today;
  const next = db.prepare(
    `SELECT report_date AS d, eps_estimate AS eps, revenue_estimate AS revenue FROM earnings_calendar
     WHERE symbol = ? AND report_date >= ? AND last_seen_day >= ? ORDER BY report_date LIMIT 1`
  );
  const last = db.prepare(
    `SELECT report_date AS d, eps_actual AS actual, eps_estimate AS eps, revenue_actual AS revenue FROM earnings_calendar
     WHERE symbol = ? AND report_date < ? AND eps_actual IS NOT NULL ORDER BY report_date DESC LIMIT 1`
  );
  return symbols.map((symbol) => {
    const n = next.get(symbol, today, seen) as { d: string; eps: number | null; revenue: number | null } | undefined;
    const l = last.get(symbol, today) as { d: string; actual: number; eps: number | null; revenue: number | null } | undefined;
    return {
      symbol,
      found: n !== undefined || l !== undefined,
      nextEarningsDate: n ? unix(n.d) : null,
      lastEarningsDate: l ? unix(l.d) : null,
      epsForecast: n?.eps ?? null,
      revenueForecast: n?.revenue ?? null,
      lastEps: l?.actual ?? null,
      lastEpsEstimate: l?.eps ?? null,
      lastSurprisePercent: l ? pctChange(l.eps, l.actual) : null,
      lastRevenue: l?.revenue ?? null,
    };
  });
}

export function hasRun(day: string): boolean {
  return db.prepare("SELECT 1 FROM estimate_runs WHERE day = ?").get(day) !== undefined;
}

export function recordRun(day: string, rows: number, stored: number): void {
  db.prepare("INSERT OR REPLACE INTO estimate_runs (day, rows, stored) VALUES (?, ?, ?)").run(day, rows, stored);
}

/** The earliest report date on or after `today` that has snapshots. */
export function nextReportDate(symbol: string, today: string): string | null {
  const row = db
    .prepare("SELECT MIN(report_date) AS d FROM estimate_snapshots WHERE symbol = ? AND report_date >= ?")
    .get(symbol, today) as { d: string | null };
  return row.d;
}

/** Stored changes for one report, oldest first. */
export function history(symbol: string, reportDate: string): HistoryPoint[] {
  return db
    .prepare(
      "SELECT captured_day AS day, eps_estimate AS eps, revenue_estimate AS revenue FROM estimate_snapshots WHERE symbol = ? AND report_date = ? ORDER BY captured_day"
    )
    .all(symbol, reportDate) as HistoryPoint[];
}

const dayMs = 86_400_000;
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * dayMs).toISOString().slice(0, 10);
}

/** Percent change from `old` to `now`; null when either is missing or the old value is zero. */
export function pctChange(old: number | null | undefined, now: number | null | undefined): number | null {
  if (old === null || old === undefined || now === null || now === undefined || old === 0) return null;
  return ((now - old) / Math.abs(old)) * 100;
}

/**
 * Percent change of the latest estimate against the one in force N days before
 * `today`: the newest snapshot on or before that day. Null where tracking
 * began later than that.
 */
export function revisions(points: HistoryPoint[], today: string): Revisions {
  const out = {} as Revisions;
  const latest = points[points.length - 1];
  for (const n of WINDOWS) {
    const cutoff = addDays(today, -n);
    const base = [...points].reverse().find((p) => p.day <= cutoff);
    out[`${n}d`] = base && latest ? { eps: pctChange(base.eps, latest.eps), revenue: pctChange(base.revenue, latest.revenue) } : { eps: null, revenue: null };
  }
  return out;
}
