import { tradingDay } from "../history/time.js";
import { nyInstant } from "../live/session.js";
import * as fmp from "../providers/fmp.js";
import { ensureCalendar, isTradingDay } from "../providers/alpaca-calendar.js";
import { addDays } from "../estimates/store.js";
import { earningsDb } from "./db.js";
import { runEvents, runStock } from "./backfill.js";
import { universe, type StoredEvent } from "./events.js";
import { refreshAnalystActions, refreshUpcoming } from "./upcoming.js";

// Nightly at 18:30 New York time on trading days: reports since the last run (events, then
// stock paths), the upcoming calendar, analyst actions, then the hooks (the option side and the
// stats rebuild are wired in by OPS-1). One run at a time; one summary line per run.

const CHECK_EVERY_MS = 5 * 60_000;
const RUN_AT = { hour: 18, minute: 30 };
const LOOKBACK_DAYS = 7;
const RETRY_NO_BARS_DAYS = 10;

export type Hooks = {
  afterNewEvents?: (events: Array<{ symbol: string; reportDate: string }>) => Promise<void>;
  afterNightly?: () => Promise<void>;
};

export type NightlySummary = { day: string; symbols: number; newEvents: number; stockPaths: number; upcoming: number; analystRows: number; failed: number };

/** When the last nightly run finished (ISO UTC) and how many events it added; null before the first. */
export function lastNightly(): { lastRun: string; newEvents: number } | null {
  const r = earningsDb.prepare("SELECT updated_at, detail FROM backfill_progress WHERE task = 'nightly' AND symbol = 'last'").get() as { updated_at: string; detail: string | null } | undefined;
  if (!r) return null;
  return { lastRun: r.updated_at, newEvents: (JSON.parse(r.detail ?? "{}") as { newEvents?: number }).newEvents ?? 0 };
}

/** The symbols with a report in the last week (FMP calendar, US-listed) plus recent events still missing bars. */
async function reportedSince(today: string, listed: Set<string>): Promise<string[]> {
  const rows = await fmp.earningsCalendar(addDays(today, -LOOKBACK_DAYS), today, { includeReportTimes: true });
  const out = new Set(rows.filter((r) => r.epsActual !== null && listed.has(r.symbol)).map((r) => r.symbol));
  const retry = earningsDb.prepare("SELECT DISTINCT symbol FROM events WHERE reason = 'no_bars' AND report_date >= ?").all(addDays(today, -RETRY_NO_BARS_DAYS)) as Array<{ symbol: string }>;
  for (const r of retry) out.add(r.symbol);
  return [...out];
}

/** One nightly pass. Step failures are counted and logged, not thrown, so later steps still run. */
export async function runNightly(today: string, hooks: Hooks = {}): Promise<NightlySummary> {
  const s: NightlySummary = { day: today, symbols: 0, newEvents: 0, stockPaths: 0, upcoming: 0, analystRows: 0, failed: 0 };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      s.failed++;
      console.error(`[earnings] nightly ${name} failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  };
  await step("calendar", () => ensureCalendar(Number(today.slice(0, 4))));
  const listed = new Set(universe());
  const symbols = (await step("reported", () => reportedSince(today, listed))) ?? [];
  s.symbols = symbols.length;
  let fresh: StoredEvent[] = [];
  if (symbols.length > 0) {
    const ev = await step("events", () => runEvents(symbols, { since: addDays(today, -30), today, force: true }));
    if (ev) {
      fresh = ev.fresh;
      s.newEvents = fresh.length;
      s.failed += ev.totals.errors;
    }
    const st = await step("stock", () => runStock(symbols, { today, force: true }));
    if (st) {
      s.stockPaths = st.stockPaths;
      s.failed += st.errors;
    }
  }
  const up = await step("upcoming", () => refreshUpcoming(today, listed));
  if (up) {
    s.upcoming = up.rows;
    s.failed += up.failed;
  }
  const an = await step("analyst", () => refreshAnalystActions(today));
  if (an) {
    s.analystRows = an.rows;
    s.failed += an.failed;
  }
  if (fresh.length > 0 && hooks.afterNewEvents) await step("afterNewEvents", () => hooks.afterNewEvents!(fresh));
  if (hooks.afterNightly) await step("afterNightly", () => hooks.afterNightly!());
  earningsDb
    .prepare(
      `INSERT INTO backfill_progress (task, symbol, status, detail) VALUES ('nightly', 'last', 'done', ?)
       ON CONFLICT (task, symbol) DO UPDATE SET status = 'done', detail = excluded.detail, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .run(JSON.stringify({ newEvents: s.newEvents }));
  console.log(`[earnings] nightly ${today}: ${s.symbols} reporters, ${s.newEvents} new events, ${s.stockPaths} stock paths, ${s.upcoming} upcoming, ${s.analystRows} analyst rows${s.failed ? `, ${s.failed} failed` : ""}`);
  return s;
}

/** Whether the nightly run is due at `now`: a trading day, past 18:30 New York time, and not yet run that day. */
export function isDue(now: Date, lastRun: string | null): boolean {
  const today = tradingDay(now.toISOString());
  if (!isTradingDay(today) || now.getTime() < nyInstant(today, RUN_AT.hour, RUN_AT.minute)) return false;
  return lastRun === null || tradingDay(lastRun) < today;
}

/** Arms the nightly job; returns a function that stops it. Does nothing without an FMP key. */
export function startEarningsJobs(hooks: Hooks = {}): () => void {
  if (!fmp.isConfigured()) {
    console.log("[earnings] FMP_API_KEY is not set; nightly earnings job disabled.");
    return () => {};
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = new Date();
      await ensureCalendar(Number(tradingDay(now.toISOString()).slice(0, 4)));
      if (isDue(now, lastNightly()?.lastRun ?? null)) await runNightly(tradingDay(now.toISOString()), hooks);
    } catch (err) {
      console.error("[earnings] nightly job failed:", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
