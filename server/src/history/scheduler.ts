import * as alpaca from "../providers/alpaca.js";
import { lastFinishedRun } from "./store.js";
import { runJob } from "./sync.js";

// Nightly history sync inside the API process, for an always-on install.
// Opt in with HISTORY_SYNC=1 (and Alpaca keys). Every 15 minutes it checks
// whether today's New York session has closed (after 18:00 ET, Mon–Fri) and
// whether today's sync already ran; if not, it runs universe + daily + minute.
// HISTORY_SYNC_MINUTE=0 leaves out the minute bars (daily only).
// The first run on an empty database is the full backfill, which can take
// hours; `npm run history -w server -- all` does the same from a terminal.

const CHECK_EVERY_MS = 15 * 60_000;
const SYNC_AFTER_HOUR_ET = 18;

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

export function nyClock(now: Date): { date: string; hour: number; weekday: string } {
  const p = Object.fromEntries(nyParts.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
}

/** True when a sync is due: a weekday evening in New York with no successful run since that day's close. */
export function syncDue(now: Date, lastRunStartedUtc: string | undefined): boolean {
  const ny = nyClock(now);
  if (ny.weekday === "Sat" || ny.weekday === "Sun" || ny.hour < SYNC_AFTER_HOUR_ET) return false;
  if (!lastRunStartedUtc) return true;
  // SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC.
  const last = nyClock(new Date(lastRunStartedUtc.replace(" ", "T") + "Z"));
  return last.date !== ny.date || last.hour < SYNC_AFTER_HOUR_ET;
}

export function minuteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HISTORY_SYNC_MINUTE !== "0";
}

export function startHistoryScheduler(): void {
  if (process.env.HISTORY_SYNC !== "1") return;
  if (!alpaca.isConfigured()) {
    console.warn("[history] HISTORY_SYNC=1 but ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set; nightly sync disabled.");
    return;
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!syncDue(new Date(), lastFinishedRun("all")?.started_at)) return;
      const result = await runJob("all", { minute: minuteEnabled(), log: (m) => console.log(`[history] ${m}`) });
      console.log(`[history] nightly sync ${result.status}`);
    } catch (err) {
      // e.g. SQLITE_BUSY while the CLI holds the lock; try again next tick.
      console.error("[history] nightly sync failed:", err);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, CHECK_EVERY_MS).unref();
  void tick();
  console.log(`[history] nightly sync enabled (after 18:00 New York time, weekdays${minuteEnabled() ? "" : ", daily bars only"})`);
}
