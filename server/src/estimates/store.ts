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
