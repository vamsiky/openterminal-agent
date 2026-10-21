import * as fmp from "../providers/fmp.js";
import { tradingDay } from "../history/time.js";
import { addDays, hasRun, recordRun, recordSnapshots, type SnapshotInput } from "./store.js";

// Once per New York calendar day, snapshot the consensus estimates of every
// report in the next 91 days. FMP's calendar returns at most 4,000 rows and
// keeps the latest dates, so the range is fetched in 7-day windows (about
// 1,400-2,000 rows each) rather than one wide call.

const CHECK_EVERY_MS = 60 * 60_000;
export const HORIZON_DAYS = 91;
const WINDOW_DAYS = 7;

/** [from, to] pairs of at most 7 days covering today through today + 91. */
export function windows(today: string): Array<[string, string]> {
  const end = addDays(today, HORIZON_DAYS);
  const out: Array<[string, string]> = [];
  for (let from = today; from <= end; from = addDays(from, WINDOW_DAYS)) {
    const to = addDays(from, WINDOW_DAYS - 1);
    out.push([from, to < end ? to : end]);
  }
  return out;
}

/** Captures `today` unless it already ran. Returns null when skipped. A day with a failed window is not marked done, so the next check retries. */
export async function captureDay(today: string): Promise<{ rows: number; stored: number; failed: number } | null> {
  if (hasRun(today)) return null;
  let rows = 0;
  let stored = 0;
  let failed = 0;
  for (const [from, to] of windows(today)) {
    try {
      const calendar = await fmp.earningsCalendar(from, to);
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
      if (result) console.log(`[estimates] ${today}: ${result.rows} calendar rows, ${result.stored} stored${result.failed ? `, ${result.failed} windows failed` : ""}`);
    } catch (err) {
      console.error("[estimates] capture failed:", err);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, CHECK_EVERY_MS).unref();
  void tick();
}
