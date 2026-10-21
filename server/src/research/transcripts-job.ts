import { db } from "../db.js";
import { tradingDay } from "../history/time.js";
import { addDays } from "../estimates/store.js";
import { fetchTranscriptDates } from "../providers/fmp-content.js";
import { isConfigured, mapLimit } from "../providers/fmp-core.js";
import { allWatchlistSymbols } from "../routes/watchlists.js";
import { fetchAndStore, getStored } from "./transcripts-store.js";

// Once per New York day: fetch the transcript of every watchlist symbol that
// reported in the last 10 days (retrying daily until FMP has it), and backfill
// the last 4 transcripts of each watchlist symbol once. A run stops at about
// CALL_BUDGET FMP calls; symbols left over are backfilled by the next run.

const CHECK_EVERY_MS = 60 * 60_000;
const RECENT_DAYS = 10;
const BACKFILL_COUNT = 4;
export const CALL_BUDGET = 1500;

export type JobResult = { recent: number; backfilled: number; fetched: number; calls: number };

const hasRun = (day: string) => db.prepare("SELECT 1 FROM content_job_runs WHERE day = ?").get(day) !== undefined;

/** Watchlist symbols whose report date falls in the last 10 days, with that date. */
function recentReporters(today: string, watch: Set<string>): Array<{ symbol: string; reportDate: string }> {
  const rows = db
    .prepare("SELECT symbol, MAX(report_date) AS reportDate FROM earnings_calendar WHERE report_date >= ? AND report_date <= ? GROUP BY symbol")
    .all(addDays(today, -RECENT_DAYS), today) as Array<{ symbol: string; reportDate: string }>;
  return rows.filter((r) => watch.has(r.symbol));
}

export async function runTranscriptJob(today: string, budget = CALL_BUDGET): Promise<JobResult> {
  const watch = new Set(allWatchlistSymbols());
  let calls = 0;
  let fetched = 0;
  const spend = () => {
    calls++;
  };

  // Newest transcript of recent reporters: FMP lists it a few hours to days after the call.
  const reporters = recentReporters(today, watch);
  await mapLimit(reporters, async ({ symbol, reportDate }) => {
    if (calls >= budget) return;
    try {
      const dates = await (spend(), fetchTranscriptDates(symbol));
      const wanted = addDays(reportDate, -1);
      for (const d of dates.filter((x) => x.date >= wanted)) {
        if (getStored(symbol, d.fiscalYear, d.quarter) || calls >= budget) continue;
        spend();
        if (await fetchAndStore(symbol, d.fiscalYear, d.quarter, d.date)) fetched++;
      }
    } catch (err) {
      console.error(`[transcripts] ${symbol} failed:`, err instanceof Error ? err.message : err);
    }
  });

  // One-time backfill of the last few transcripts per symbol.
  const done = new Set((db.prepare("SELECT symbol FROM content_backfill").all() as Array<{ symbol: string }>).map((r) => r.symbol));
  const todo = [...watch].filter((s) => !done.has(s));
  let backfilled = 0;
  const mark = db.prepare("INSERT OR REPLACE INTO content_backfill (symbol, done_day) VALUES (?, ?)");
  // A symbol needs up to 1 + BACKFILL_COUNT calls. Reserve them before starting, since workers run
  // concurrently, and skip a symbol rather than leave it half done.
  let reserved = calls;
  await mapLimit(todo, async (symbol) => {
    if (reserved + 1 + BACKFILL_COUNT > budget) return;
    reserved += 1 + BACKFILL_COUNT;
    try {
      const dates = (await (spend(), fetchTranscriptDates(symbol))).slice(0, BACKFILL_COUNT);
      for (const d of dates) {
        if (getStored(symbol, d.fiscalYear, d.quarter)) continue;
        spend();
        if (await fetchAndStore(symbol, d.fiscalYear, d.quarter, d.date)) fetched++;
      }
      mark.run(symbol, today);
      backfilled++;
    } catch (err) {
      console.error(`[transcripts] backfill ${symbol} failed:`, err instanceof Error ? err.message : err);
    }
  });

  db.prepare("INSERT OR REPLACE INTO content_job_runs (day, recent, backfilled, fetched, calls) VALUES (?, ?, ?, ?, ?)").run(today, reporters.length, backfilled, fetched, calls);
  return { recent: reporters.length, backfilled, fetched, calls };
}

/** Starts the background jobs of the content area; call once from index.ts. */
export function startContentJobs(): void {
  if (!isConfigured()) {
    console.log("[transcripts] FMP_API_KEY is not set; transcript job disabled.");
    return;
  }
  let busy = false;
  const tick = async () => {
    const today = tradingDay(new Date().toISOString());
    if (busy || hasRun(today)) return;
    busy = true;
    try {
      const r = await runTranscriptJob(today);
      console.log(`[transcripts] ${today}: ${r.recent} recent reporters, ${r.backfilled} symbols backfilled, ${r.fetched} transcripts stored, ${r.calls} FMP calls`);
    } catch (err) {
      console.error("[transcripts] job failed:", err);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, CHECK_EVERY_MS).unref();
  void tick();
}
