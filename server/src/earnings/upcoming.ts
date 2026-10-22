import * as fmp from "../providers/fmp.js";
import { windows } from "../estimates/capture.js";
import { timingsFor } from "../estimates/timing.js";
import { addDays } from "../estimates/store.js";
import { allWatchlistSymbols } from "../routes/watchlists.js";
import { earningsDb } from "./db.js";
import { universe } from "./events.js";
import { sessionsFor } from "./sessions.js";

// The next 120 days of the FMP calendar with report times, refreshed nightly, and
// analyst actions for the names reporting soon.

const ANALYST_DAYS = 60;
const ANALYST_KEEP_DAYS = 90;
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

const insertUpcoming = earningsDb.prepare(
  `INSERT INTO upcoming (symbol, report_date, time, time_source, t0, r, fiscal_period, fiscal_year, period_ending, eps_estimate, revenue_estimate, fmp_confirmed_flag, updated_at)
   VALUES (@symbol, @report_date, @time, @time_source, @t0, @r, @fiscal_period, @fiscal_year, @period_ending, @eps_estimate, @revenue_estimate, @fmp_confirmed_flag, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   ON CONFLICT (symbol, report_date) DO UPDATE SET time = excluded.time, time_source = excluded.time_source, t0 = excluded.t0, r = excluded.r,
     fiscal_period = excluded.fiscal_period, fiscal_year = excluded.fiscal_year, period_ending = excluded.period_ending,
     eps_estimate = excluded.eps_estimate, revenue_estimate = excluded.revenue_estimate, fmp_confirmed_flag = excluded.fmp_confirmed_flag, updated_at = excluded.updated_at`
);

/** Replaces `upcoming` with the next 120 days (US-listed names only). A failed window keeps the old rows and upserts what arrived. */
export async function refreshUpcoming(today: string, listed: Set<string> = new Set(universe())): Promise<{ rows: number; failed: number }> {
  const seen: fmp.EarningsCalendarRow[] = [];
  let failed = 0;
  for (const [from, to] of windows(today)) {
    try {
      seen.push(...(await fmp.earningsCalendar(from, to, { includeReportTimes: true })));
    } catch (err) {
      failed++;
      console.error(`[earnings] upcoming ${from}..${to} failed:`, err instanceof Error ? err.message : err);
    }
  }
  const rows = seen.filter((r) => listed.has(r.symbol) && r.epsActual === null);
  // A null FMP time falls back to the press-release inference, when the app has one for the name.
  const inferred = timingsFor([...new Set(rows.filter((r) => !r.time).map((r) => r.symbol))]);
  earningsDb.transaction(() => {
    if (failed === 0) earningsDb.prepare("DELETE FROM upcoming").run();
    for (const r of rows) {
      const fallback = r.time ? null : inferred.get(r.symbol);
      const time = r.time ?? fallback?.timing ?? null;
      const { t0, r: react } = sessionsFor(iso(r.date), time);
      insertUpcoming.run({
        symbol: r.symbol,
        report_date: iso(r.date),
        time,
        time_source: r.time ? "fmp" : time ? "press_release" : null,
        t0,
        r: react,
        fiscal_period: r.fiscalPeriod ?? null,
        fiscal_year: r.fiscalYear ?? null,
        period_ending: r.periodEnding ?? null,
        eps_estimate: r.epsEstimated,
        revenue_estimate: r.revenueEstimated,
        fmp_confirmed_flag: r.confirmed === null || r.confirmed === undefined ? null : r.confirmed ? 1 : 0,
      });
    }
  })();
  return { rows: rows.length, failed };
}

const insertAction = earningsDb.prepare(
  `INSERT INTO analyst_actions (symbol, date, firm, action, prior_grade, new_grade, price_target, prior_price_target)
   VALUES (@symbol, @date, @firm, @action, @prior_grade, @new_grade, @price_target, @prior_price_target)
   ON CONFLICT (symbol, date, firm, action) DO UPDATE SET prior_grade = excluded.prior_grade, new_grade = excluded.new_grade,
     price_target = excluded.price_target, prior_price_target = excluded.prior_price_target`
);

/** pt_raise / pt_cut / pt_set (no prior target) / pt_maintain, so a target move never collides with a grade action of the same firm. */
export function targetAction(price: number | null, prior: number | null): string {
  if (price === null || prior === null) return "pt_set";
  return price > prior ? "pt_raise" : price < prior ? "pt_cut" : "pt_maintain";
}

/** Fetches and stores one symbol's grades and price-target headlines from the last 90 days. */
export async function refreshAnalyst(symbol: string, today: string): Promise<number> {
  const cutoff = addDays(today, -ANALYST_KEEP_DAYS);
  const [gradeRows, targetRows] = await Promise.all([fmp.grades(symbol), fmp.priceTargetNews(symbol)]);
  let n = 0;
  earningsDb.transaction(() => {
    for (const g of gradeRows) {
      if (g.date < cutoff) continue;
      insertAction.run({ symbol, date: g.date, firm: g.firm ?? "", action: g.action, prior_grade: g.previousGrade, new_grade: g.newGrade, price_target: null, prior_price_target: null });
      n++;
    }
    for (const t of targetRows) {
      if (t.date < cutoff) continue;
      insertAction.run({ symbol, date: t.date, firm: t.firm ?? "", action: targetAction(t.priceTarget, t.priorPriceTarget), prior_grade: null, new_grade: null, price_target: t.priceTarget, prior_price_target: t.priorPriceTarget });
      n++;
    }
  })();
  return n;
}

/**
 * Analyst actions for the names reporting in the next 60 days plus every watchlist symbol. A symbol is
 * refetched once a day when it reports within 10 days, else weekly (freshness lives in backfill_progress, task "analyst").
 */
export async function refreshAnalystActions(today: string): Promise<{ symbols: number; rows: number; failed: number }> {
  const soon = earningsDb.prepare("SELECT symbol, MIN(report_date) AS d FROM upcoming WHERE report_date >= ? AND report_date <= ? GROUP BY symbol").all(today, addDays(today, ANALYST_DAYS)) as Array<{ symbol: string; d: string }>;
  const next = new Map(soon.map((r) => [r.symbol, r.d]));
  for (const s of allWatchlistSymbols()) if (!next.has(s)) next.set(s, addDays(today, ANALYST_DAYS));
  const fresh = earningsDb.prepare("SELECT updated_at FROM backfill_progress WHERE task = 'analyst' AND symbol = ?");
  const mark = earningsDb.prepare(
    "INSERT INTO backfill_progress (task, symbol, status, updated_at) VALUES ('analyst', ?, 'done', ?) ON CONFLICT (task, symbol) DO UPDATE SET status = 'done', updated_at = excluded.updated_at"
  );
  const todo = [...next].filter(([symbol, d]) => {
    const last = (fresh.get(symbol) as { updated_at: string } | undefined)?.updated_at.slice(0, 10);
    if (!last) return true;
    return last < addDays(today, d <= addDays(today, 10) ? 0 : -6);
  });
  let rows = 0;
  let failed = 0;
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (i < todo.length) {
        const [symbol] = todo[i++];
        try {
          const n = await refreshAnalyst(symbol, today);
          rows += n;
          mark.run(symbol, `${today}T23:00:00.000Z`);
        } catch (err) {
          failed++;
          console.error(`[earnings] analyst ${symbol} failed:`, err instanceof Error ? err.message : err);
        }
      }
    })
  );
  return { symbols: todo.length, rows, failed };
}
