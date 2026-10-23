import { db } from "../db.js";
import { nyClock } from "../history/scheduler.js";
import { nyInstant } from "../live/session.js";
import { ensureCalendar, isTradingDay, sessionClose } from "../providers/alpaca-calendar.js";
import type { QuantDeps } from "../scan/contracts.js";
import * as alpaca from "../providers/alpaca.js";
import { hourlyPlan, refreshHourly } from "./hourly.js";
import { refreshDividends } from "./dividends.js";
import { refreshStockIdeas, runStockScreen, updateOptionIdeas } from "./ideas.js";
import { optionScores, runOptionScan } from "./option-score.js";
import { heldSymbols } from "./positions.js";
import { compositeMap, latestScorecardDay, runIntradayStockScan, runNightlyScorecards } from "./stock-score.js";
import { resolveUniverse } from "./universe.js";
import { captureOptionPass, captureStockPass, pruneTestData } from "../scantest/capture.js";

// Scheduling for the scans, inside the API process:
//   stock-nightly    07:00 and 16:30 ET on weekdays: scorecards for every US stock
//   ideas-screen     right after each nightly: the stock ideas list
//   stock-intraday   every 15 min in the regular session: live rescoring of the universe
//   option-scan      every 5 min in the regular session: option scorecards and ideas
// The session scans run from 09:35 ET to the close (early closes included, from
// the Alpaca trading calendar), on trading days only. Jobs never overlap: one loop
// runs due jobs one after another, and a run that outlasts its slot simply
// makes the next slot late. SCAN_ENABLED=0 turns it all off.

export type JobName = "stock-nightly" | "stock-intraday" | "option-scan" | "ideas-screen";
export const JOB_NAMES: JobName[] = ["stock-nightly", "stock-intraday", "option-scan", "ideas-screen"];

/** Daily hourly-bar fetch for the universe; recorded in scan_runs and shown in the status, but not forced through runJob. */
export const HOURLY_JOB = "hourly-bars";
const HOURLY_AFTER = { h: 7, m: 30 };
const HOURLY_RETRY_MS = 3_600_000;
let hourlyFailedAt = 0;

const TICK_MS = 20_000;
/** The stock scan waits this long into its slot for the minute bars to land; the option scan a bit more, for the sweep. */
const STOCK_OFFSET_MS = 20_000;
const OPTION_OFFSET_MS = 90_000;
const NIGHTLY_SLOTS: Array<[number, number]> = [[7, 0], [16, 30]];

db.exec(`
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  symbols INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS scan_runs_job ON scan_runs (job, id);
`);

export type RunRow = { started_at: string; finished_at: string | null; status: string; symbols: number | null; duration_ms: number | null; error: string | null };

/** The latest run of each job. */
export function lastRuns(): Record<string, RunRow> {
  const out: Record<string, RunRow> = {};
  const stmt = db.prepare("SELECT started_at, finished_at, status, symbols, duration_ms, error FROM scan_runs WHERE job = ? ORDER BY id DESC LIMIT 1");
  for (const job of [...JOB_NAMES, HOURLY_JOB]) {
    const r = stmt.get(job) as RunRow | undefined;
    if (r) out[job] = r;
  }
  return out;
}

const lastStart = (job: string): number | null => {
  const r = db.prepare("SELECT started_at FROM scan_runs WHERE job = ? ORDER BY id DESC LIMIT 1").get(job) as { started_at: string } | undefined;
  return r ? Date.parse(r.started_at) : null;
};

/** Holdings first, then the rest of the universe by latest option score, then stock composite, then alphabetically. */
export function universeByPriority(): string[] {
  const universe = resolveUniverse();
  const held = new Set(heldSymbols());
  const options = optionScores();
  const comps = compositeMap(universe);
  const byComposite = (a: string, b: string) => (comps.get(b) ?? -1) - (comps.get(a) ?? -1) || a.localeCompare(b);
  const rest = universe.filter((s) => !held.has(s));
  const withOption = rest.filter((s) => options.has(s)).sort((a, b) => options.get(b)! - options.get(a)! || a.localeCompare(b));
  const without = rest.filter((s) => !options.has(s)).sort(byComposite);
  return [...universe.filter((s) => held.has(s)), ...withOption, ...without];
}

let deps: QuantDeps | null = null;
/** The deps given to startQuantJobs, for the status route. */
export const quantDeps = () => deps;

// ---- schedule (pure) ----

const isWeekday = (weekday: string) => weekday !== "Sat" && weekday !== "Sun";

/** First session scan, after the open's first minutes have bars. */
const SESSION_START = { h: 9, m: 35 };

/**
 * Jobs due at `now`. `started(job)` is when the job last started (epoch ms);
 * `trading` and `closeAt` come from the trading calendar.
 */
export function dueJobs(
  now: Date,
  started: (job: JobName) => number | null,
  trading: (day: string) => boolean = isTradingDay,
  closeAt: (day: string) => number = sessionClose
): JobName[] {
  const ny = nyClock(now);
  if (!isWeekday(ny.weekday)) return [];
  const t = now.getTime();
  const due: JobName[] = [];

  const slots = NIGHTLY_SLOTS.map(([h, m]) => nyInstant(ny.date, h, m)).filter((s) => s <= t);
  const slot = slots[slots.length - 1];
  if (slot !== undefined && (started("stock-nightly") ?? 0) < slot) due.push("stock-nightly");
  // The screen follows its nightly: due when the nightly of this slot has run but the screen has not.
  if (slot !== undefined && (started("stock-nightly") ?? 0) >= slot && (started("ideas-screen") ?? 0) < slot) due.push("ideas-screen");

  if (!trading(ny.date)) return due;
  const anchor = nyInstant(ny.date, 9, 30);
  const first = nyInstant(ny.date, SESSION_START.h, SESSION_START.m);
  const close = closeAt(ny.date);
  if (t >= first && t <= close) {
    // Slots sit on the clock (:00, :05, ... / :00, :15, ...) counted from the open.
    const slotOf = (min: number) => anchor + Math.floor((t - anchor) / (min * 60_000)) * min * 60_000;
    const stockSlot = slotOf(15);
    const optionSlot = slotOf(5);
    if (stockSlot >= first && stockSlot < close && t >= stockSlot + STOCK_OFFSET_MS && (started("stock-intraday") ?? 0) < stockSlot) due.push("stock-intraday");
    if (optionSlot >= first && optionSlot < close && t >= optionSlot + OPTION_OFFSET_MS && (started("option-scan") ?? 0) < optionSlot) due.push("option-scan");
  }
  return due;
}

// ---- running ----

let ideasListener: ((now: Date) => void) | null = null;
/** Called after an ideas-screen or option-scan run succeeds; index.ts wires the agents here so quant/ never imports agents/. */
export function setIdeasListener(fn: ((now: Date) => void) | null): void {
  ideasListener = fn;
}
function notifyIdeas(now: Date): void {
  try {
    ideasListener?.(now);
  } catch (err) {
    console.error("[scan] ideas listener failed:", err);
  }
}

function record<T extends { symbols?: number; scored?: number }>(job: JobName, fn: () => T): T | null {
  const started = Date.now();
  const id = Number(db.prepare("INSERT INTO scan_runs (job, started_at) VALUES (?, ?)").run(job, new Date(started).toISOString()).lastInsertRowid);
  try {
    const r = fn();
    db.prepare("UPDATE scan_runs SET finished_at = ?, status = 'ok', symbols = ?, duration_ms = ? WHERE id = ?").run(
      new Date().toISOString(), r.symbols ?? r.scored ?? null, Date.now() - started, id
    );
    return r;
  } catch (err) {
    console.error(`[scan] ${job} failed:`, err);
    db.prepare("UPDATE scan_runs SET finished_at = ?, status = 'error', error = ?, duration_ms = ? WHERE id = ?").run(
      new Date().toISOString(), err instanceof Error ? err.message : String(err), Date.now() - started, id
    );
    return null;
  }
}

/**
 * Fetches the universe's hourly bars once a day from 07:30 ET on trading days
 * (and whenever symbols have none cached, e.g. after a universe change or on
 * the first start). A failure waits an hour.
 */
let hourlyRunning = false;

export async function runHourlyIfNeeded(now = new Date()): Promise<boolean> {
  if (hourlyRunning) return false;
  const ny = nyClock(now);
  if (!isTradingDay(ny.date) || now.getTime() < nyInstant(ny.date, HOURLY_AFTER.h, HOURLY_AFTER.m) || now.getTime() - hourlyFailedAt < HOURLY_RETRY_MS) return false;
  if (!alpaca.isConfigured()) return false;
  hourlyRunning = true;
  const started = Date.now();
  let id: number | null = null;
  let symbols = 0;
  let status: "ok" | "error" = "ok";
  let error: string | null = null;
  try {
    const plan = hourlyPlan(resolveUniverse(), now);
    if (!plan) return false;
    symbols = plan.symbols.length;
    id = Number(db.prepare("INSERT INTO scan_runs (job, started_at) VALUES (?, ?)").run(HOURLY_JOB, new Date(started).toISOString()).lastInsertRowid);
    const r = await refreshHourly(plan.symbols, now, undefined, plan.mode === "daily");
    console.log(`[scan] hourly bars (${plan.mode}): ${r.symbols} symbols, ${r.requests} requests, ${r.bars} bars in ${(r.durationMs / 1000).toFixed(1)} s`);
  } catch (err) {
    hourlyFailedAt = now.getTime();
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    console.error("[scan] hourly bars failed:", err);
  } finally {
    // Whatever happened, a run that started is closed out.
    if (id !== null) {
      db.prepare("UPDATE scan_runs SET finished_at = ?, status = ?, symbols = ?, error = ?, duration_ms = ? WHERE id = ?").run(new Date().toISOString(), status, symbols, error, Date.now() - started, id);
    }
    hourlyRunning = false;
  }
  return id !== null;
}

let running = false;
let stopped = false;

/** Runs one job now (also the route behind forced scans). Returns false when another run is in progress or the job can't run. */
export function runJob(job: JobName, now = new Date()): boolean {
  if (running || stopped) return false;
  if (job === "option-scan" && !deps) return false;
  running = true;
  try {
    switch (job) {
      case "stock-nightly":
        record(job, () => {
          const r = runNightlyScorecards(now);
          return { symbols: r.scored };
        });
        pruneTestData(now);
        break;
      case "ideas-screen":
        if (
          record(job, () => {
            const universe = resolveUniverse();
            runStockScreen(universe, now);
            return { symbols: universe.length };
          })
        ) notifyIdeas(now);
        break;
      case "stock-intraday":
        record(job, () => {
          const universe = resolveUniverse();
          const r = runIntradayStockScan(universe, now);
          refreshStockIdeas(now);
          captureStockPass(r, now);
          return { symbols: r.scored };
        });
        break;
      case "option-scan":
        if (
          record(job, () => {
            const universe = universeByPriority();
            const r = runOptionScan(universe, deps!.optionMetrics, now);
            updateOptionIdeas(now);
            captureOptionPass(r);
            return { symbols: r.scored };
          })
        ) notifyIdeas(now);
        break;
    }
  } finally {
    running = false;
  }
  return true;
}

export function startQuantJobs(d: QuantDeps): { stop: () => void } | null {
  if (process.env.SCAN_ENABLED === "0") {
    console.log("[scan] SCAN_ENABLED=0; scans disabled.");
    return null;
  }
  deps = d;
  stopped = false;
  // A killed process leaves its run marked running.
  db.prepare("UPDATE scan_runs SET status = 'error', error = 'abandoned: process stopped', finished_at = ? WHERE status = 'running'").run(new Date().toISOString());

  const ensureYears = async (now: Date) => {
    const year = Number(nyClock(now).date.slice(0, 4));
    await ensureCalendar(year);
    // Early December: the next year's holidays are published, and January's first scans need them.
    if (now.getUTCMonth() === 11) await ensureCalendar(year + 1);
  };

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = new Date();
      await ensureYears(now);
      await refreshDividends(now);
      // Not awaited: the backfill takes minutes and must not hold up the scans.
      void runHourlyIfNeeded(now);
      // A fresh install has no scorecards: build them once without waiting for 07:00.
      const jobs: JobName[] = latestScorecardDay() === null && lastStart("stock-nightly") === null ? ["stock-nightly", "ideas-screen"] : dueJobs(now, (j) => lastStart(j));
      for (const job of jobs) {
        runJob(job, now);
        await new Promise((r) => setImmediate(r));
      }
    } catch (err) {
      console.error("[scan] tick failed:", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  setTimeout(() => void tick(), 15_000).unref();
  console.log("[scan] jobs enabled: nightly scorecards 07:00 and 16:30 ET, stock scan every 15 min and option scan every 5 min in the session");
  return {
    stop: () => {
      clearInterval(timer);
      deps = null;
      stopped = true;
    },
  };
}

