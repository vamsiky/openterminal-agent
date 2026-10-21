import * as fmp from "../providers/fmp.js";
import { tradingDay } from "../history/time.js";
import { refreshTimingsInBackground } from "./timing.js";
import { addDays, hasRun, recordCalendar, recordRun, recordSnapshots, type SnapshotInput } from "./store.js";

// Once per New York calendar day, snapshot the consensus estimates of every
// report in the next 120 days (a company that just reported is next due about
// 90-100 days out), and keep the calendar itself (the past 100 days
// too, for the last report's actuals) in earnings_calendar. FMP's calendar returns at most 4,000 rows and
// keeps the latest dates, so the range is fetched in 7-day windows (about
// 1,400-2,000 rows each) rather than one wide call.

const CHECK_EVERY_MS = 60 * 60_000;
export const HORIZON_DAYS = 120;
export const PAST_DAYS = 100;
const WINDOW_DAYS = 7;

/** [from, to] pairs of at most 7 days covering today through today + HORIZON_DAYS. */
export function windows(today: string): Array<[string, string]> {
  const end = addDays(today, HORIZON_DAYS);
  const out: Array<[string, string]> = [];
  for (let from = today; from <= end; from = addDays(from, WINDOW_DAYS)) {
    const to = addDays(from, WINDOW_DAYS - 1);
    out.push([from, to < end ? to : end]);
  }
  return out;
}

/** [from, to] pairs of at most 7 days covering the 100 days before today. */
export function pastWindows(today: string): Array<[string, string]> {
  const end = addDays(today, -1);
  const out: Array<[string, string]> = [];
  for (let from = addDays(today, -PAST_DAYS); from <= end; from = addDays(from, WINDOW_DAYS)) {
    const to = addDays(from, WINDOW_DAYS - 1);
    out.push([from, to < end ? to : end]);
  }
  return out;
}

/** Captures `today` unless it already ran (or `force`). Returns null when skipped. A day with a failed window is not marked done, so the next check retries. */
export async function captureDay(today: string, force = false): Promise<{ rows: number; stored: number; failed: number } | null> {
  if (!force && hasRun(today)) return null;
  let rows = 0;
  let stored = 0;
  let failed = 0;
  const all = [...pastWindows(today).map((w) => [...w, false] as const), ...windows(today).map((w) => [...w, true] as const)];
  for (const [from, to, future] of all) {
    try {
      const calendar = await fmp.earningsCalendar(from, to);
      recordCalendar(
        calendar.map((r) => ({
          symbol: r.symbol,
          reportDate: new Date(r.date * 1000).toISOString().slice(0, 10),
          epsEstimate: r.epsEstimated,
          revenueEstimate: r.revenueEstimated,
          epsActual: r.epsActual,
          revenueActual: r.revenueActual,
        })),
        today
      );
      if (!future) continue;
      const snaps: SnapshotInput[] = calendar.map((r) => ({
        symbol: r.symbol,
        reportDate: new Date(r.date * 1000).toISOString().slice(0, 10),
        eps: r.epsEstimated,
        revenue: r.revenueEstimated,
      }));
      rows += snaps.length;
      stored += recordSnapshots(snaps, today);
    } catch (err) {
      failed++;
      console.error(`[estimates] ${from}..${to} failed:`, err instanceof Error ? err.message : err);
    }
  }
  if (failed === 0) recordRun(today, rows, stored);
  return { rows, stored, failed };
}

export function startEstimateCapture(): void {
  if (!fmp.isConfigured()) {
    console.log("[estimates] FMP_API_KEY is not set; estimate snapshots disabled.");
    return;
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const today = tradingDay(new Date().toISOString());
      const result = await captureDay(today);
      if (result) {
        console.log(`[estimates] ${today}: ${result.rows} calendar rows, ${result.stored} stored${result.failed ? `, ${result.failed} windows failed` : ""}`);
        void refreshTimingsInBackground(today);
      }
    } catch (err) {
      console.error("[estimates] capture failed:", err);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, CHECK_EVERY_MS).unref();
  void tick();
}
