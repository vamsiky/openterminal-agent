import * as fmp from "../providers/fmp.js";
import { EARNINGS_TITLE, classify } from "../estimates/timing.js";
import { db } from "../db.js";
import { isForeignSymbol } from "../history/universe.js";
import { earningsDb } from "./db.js";
import type { ReportTime } from "./contracts.js";
import { addSessions, sessionsFor } from "./sessions.js";
import { loadDaily, reaction, type Daily } from "./stock-paths.js";

// Past report dates from FMP's per-symbol history, confirmed up front:
//   fmp          FMP lists the date with an epsActual (always true here)
//   transcript   FMP's call-transcript dates have the date (amc: or a day either side)
//   pressRelease an earnings-like press release dated the report date (bmo: or the evening before)
//   volume       R's volume is 1.5x the 20-session median before T0, or R's gap 1.5x the average daily move
// Confirmed means fmp plus one other. When volume fails on FMP's date but passes on the
// adjacent trading day (volume ratio at least 1.5 and above FMP's date's) and no transcript is dated
// exactly on FMP's date, the corrected date is stored (reason date_shifted). The press-release
// check costs a request per event, so it only runs when the transcript and volume checks both
// fail (or the report time is unknown and a release is the only way to infer it).

export type StoredEvent = { symbol: string; reportDate: string };
export type SymbolResult = { events: number; skipped: number; confirmed: number; shifted: number; unconfirmed: number; noBars: number; fresh: StoredEvent[] };

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const calendarDays = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
const dayBefore = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The US-listed common stocks the earnings store covers. */
export function universe(): string[] {
  const rows = db
    .prepare(
      `SELECT symbol FROM bulk_profiles
       WHERE exchange IN ('NYSE','NASDAQ','AMEX') AND COALESCE(is_etf,0) = 0 AND COALESCE(is_fund,0) = 0 AND is_actively_trading = 1
       ORDER BY symbol`
    )
    .all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol).filter((s) => !isForeignSymbol(s));
}
const upsert = earningsDb.prepare(
  `INSERT INTO events (symbol, report_date, original_date, time, time_source, t0, r, fiscal_period, fiscal_year, period_ending,
     eps_actual, eps_estimate, revenue_actual, revenue_estimate, confirmed, check_fmp, check_transcript, check_press_release, check_volume,
     reason, fmp_confirmed_flag, updated_at)
   VALUES (@symbol, @report_date, @original_date, @time, @time_source, @t0, @r, @fiscal_period, @fiscal_year, @period_ending,
     @eps_actual, @eps_estimate, @revenue_actual, @revenue_estimate, @confirmed, @check_fmp, @check_transcript, @check_press_release, @check_volume,
     @reason, @fmp_confirmed_flag, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   ON CONFLICT (symbol, report_date) DO UPDATE SET
     original_date = excluded.original_date, time = excluded.time, time_source = excluded.time_source, t0 = excluded.t0, r = excluded.r,
     fiscal_period = excluded.fiscal_period, fiscal_year = excluded.fiscal_year, period_ending = excluded.period_ending,
     eps_actual = excluded.eps_actual, eps_estimate = excluded.eps_estimate, revenue_actual = excluded.revenue_actual, revenue_estimate = excluded.revenue_estimate,
     confirmed = excluded.confirmed, check_fmp = excluded.check_fmp, check_transcript = excluded.check_transcript,
     check_press_release = excluded.check_press_release, check_volume = excluded.check_volume,
     reason = excluded.reason, fmp_confirmed_flag = excluded.fmp_confirmed_flag, updated_at = excluded.updated_at`
);
const exists = earningsDb.prepare("SELECT 1 FROM events WHERE symbol = ? AND report_date = ?");
const dropStale = earningsDb.prepare("DELETE FROM events WHERE symbol = ? AND report_date = ?");

type Evaluated = {
  reportDate: string;
  originalDate: string;
  time: ReportTime | null;
  timeSource: "fmp" | "press_release" | null;
  t0: string | null;
  r: string | null;
  checks: { fmp: boolean; transcript: boolean; pressRelease: boolean; volume: boolean };
  confirmed: boolean;
  reason: "ok" | "unconfirmed" | "date_shifted" | "no_bars";
};

/** Evaluates one FMP report: time (FMP, else press-release inference), sessions, checks, a possible one-session date shift. */
export async function evaluate(symbol: string, row: fmp.EarningsCalendarRow, transcripts: string[], daily: Daily): Promise<Evaluated> {
  const date = iso(row.date);
  let time: ReportTime | null = row.time ?? null;
  let timeSource: Evaluated["timeSource"] = time ? "fmp" : null;
  const prCache = new Map<string, fmp.PressRelease[]>();
  const releases = async (from: string, to: string) => {
    const key = `${from}|${to}`;
    if (!prCache.has(key)) prCache.set(key, await fmp.pressReleases(symbol, 100, { from, to }).catch(() => []));
    return prCache.get(key)!;
  };
  const earningsRelease = (rs: fmp.PressRelease[]) => rs.filter((r) => EARNINGS_TITLE.test(r.title));

  let pressDated = false; // a release on the report date was seen while inferring the time
  if (time === null) {
    const todays = earningsRelease(await releases(date, date))
      .filter((r) => r.publishedAt.startsWith(date) && classify(r.publishedAt) !== null)
      .map((r) => r.publishedAt)
      .sort();
    if (todays.length > 0) {
      time = classify(todays[0]);
      timeSource = "press_release";
      pressDated = true;
    }
  }

  const transcriptAt = (d: string, t: ReportTime | null) => transcripts.some((x) => x === d || (t === "amc" && Math.abs(calendarDays(x, d)) === 1));
  const base = { fmp: true, transcript: false, pressRelease: false, volume: false };
  const finish = (partial: Omit<Evaluated, "confirmed" | "reason"> & { reason?: Evaluated["reason"]; haveBars: boolean }): Evaluated => {
    const { haveBars, ...rest } = partial;
    const c = rest.checks;
    const confirmed = haveBars && c.fmp && (c.transcript || c.pressRelease || c.volume);
    const reason = rest.reason ?? (!haveBars && rest.t0 ? "no_bars" : confirmed ? "ok" : "unconfirmed");
    return { ...rest, confirmed, reason };
  };

  if (time === null) {
    // Time unknown: no T0/R, so only fmp + transcript/press can speak, and stats can't use it.
    const transcript = transcriptAt(date, null);
    return finish({ reportDate: date, originalDate: date, time, timeSource, t0: null, r: null, checks: { ...base, transcript, pressRelease: pressDated }, haveBars: false });
  }

  const reactionOn = (d: string) => {
    const s = sessionsFor(d, time);
    return s.t0 && s.r ? reaction(daily, s.t0, s.r) : null;
  };
  let reportDate = date;
  let shifted = false;
  let rx = reactionOn(date);
  // An earnings release dated the report date (bmo: or the evening before).
  const releaseAt = async (d: string): Promise<boolean> => {
    const found = earningsRelease(await releases(time === "bmo" ? dayBefore(d) : d, d));
    return found.some((x) => x.publishedAt.startsWith(d) || (time === "bmo" && x.publishedAt.startsWith(dayBefore(d)) && (classify(x.publishedAt) ?? "amc") === "amc"));
  };
  let shiftPress = false;
  // Volume alone is weak (small banks and large caps both react under 1.5x on the right day: the first
  // audit moved 118 dates a press release backed). A date moves only when nothing else supports FMP's
  // date (no transcript exactly on it, no earnings release for it), volume is clear on the adjacent
  // session, and something independent supports that session: a transcript dated exactly on it (bmo only), or an
  // earnings release for it.
  if (rx && !rx.pass && !transcripts.includes(date)) {
    const scored = [addSessions(date, -1), addSessions(date, 1)]
      .map((d) => ({ d, rx: reactionOn(d) }))
      .filter((c): c is { d: string; rx: NonNullable<typeof rx> } => c.rx !== null && (c.rx.volumeRatio ?? 0) >= 1.5 && (c.rx.volumeRatio ?? 0) > (rx?.volumeRatio ?? 0))
      .sort((a, b) => (b.rx.volumeRatio ?? 0) - (a.rx.volumeRatio ?? 0));
    if (scored.length > 0 && !(await releaseAt(date))) {
      for (const c of scored) {
        // An amc call is held that evening or the next morning, so a transcript a day either side of FMP's
        // date supports both dates equally: only a release can back an amc move. A bmo call is same-day.
        const byTranscript = time !== "amc" && transcripts.includes(c.d);
        const press = byTranscript ? false : await releaseAt(c.d);
        if (byTranscript || press) {
          reportDate = c.d;
          rx = c.rx;
          shifted = true;
          shiftPress = press;
          break;
        }
      }
    }
  }
  const { t0, r } = sessionsFor(reportDate, time);
  const checks = { ...base, transcript: transcriptAt(reportDate, time), volume: rx?.pass === true, pressRelease: (pressDated && reportDate === date) || shiftPress };
  if (rx !== null && !checks.transcript && !checks.volume && !checks.pressRelease) {
    // Last resort: an earnings release dated the report date.
    checks.pressRelease = await releaseAt(reportDate);
  }
  return finish({
    reportDate,
    originalDate: date,
    time,
    timeSource,
    t0,
    r,
    checks,
    haveBars: rx !== null,
    reason: shifted ? "date_shifted" : undefined,
  });
}

/**
 * Re-reads one symbol's reported earnings since `since` and stores every event with its checks.
 * Idempotent: rerunning updates rows in place. `fresh` lists the (symbol, reportDate) not stored before.
 */
export async function processSymbol(symbol: string, opts: { since: string; today: string }): Promise<SymbolResult> {
  const out: SymbolResult = { events: 0, skipped: 0, confirmed: 0, shifted: 0, unconfirmed: 0, noBars: 0, fresh: [] };
  // Reports dated today or later are not settled events yet (the nightly run picks them up the next day).
  const all = (await fmp.earningsReports(symbol, 80, { includeReportTimes: true })).filter((r) => r.epsActual !== null && iso(r.date) >= opts.since && iso(r.date) < opts.today);
  if (all.length === 0) return out;
  const daily = loadDaily(symbol);
  // No daily bars at all (preferreds, notes, delisted names) or a report before the first bar: nothing to measure, so not an event.
  const first = [...daily.byDay.keys()].sort()[0];
  const rows = all.filter((r) => first !== undefined && iso(r.date) > first);
  out.skipped = all.length - rows.length;
  if (rows.length === 0) return out;
  const transcripts = await fmp.transcriptDates(symbol);
  for (const row of rows) {
    const ev = await evaluate(symbol, row, transcripts, daily);
    const wasThere = exists.get(symbol, ev.reportDate) !== undefined || exists.get(symbol, ev.originalDate) !== undefined;
    earningsDb.transaction(() => {
      if (ev.reportDate !== ev.originalDate) dropStale.run(symbol, ev.originalDate);
      upsert.run({
        symbol,
        report_date: ev.reportDate,
        original_date: ev.originalDate,
        time: ev.time,
        time_source: ev.timeSource,
        t0: ev.t0,
        r: ev.r,
        fiscal_period: row.fiscalPeriod ?? null,
        fiscal_year: row.fiscalYear ?? null,
        period_ending: row.periodEnding ?? null,
        eps_actual: row.epsActual,
        eps_estimate: row.epsEstimated,
        revenue_actual: row.revenueActual,
        revenue_estimate: row.revenueEstimated,
        confirmed: ev.confirmed ? 1 : 0,
        check_fmp: ev.checks.fmp ? 1 : 0,
        check_transcript: ev.checks.transcript ? 1 : 0,
        check_press_release: ev.checks.pressRelease ? 1 : 0,
        check_volume: ev.checks.volume ? 1 : 0,
        reason: ev.reason,
        fmp_confirmed_flag: row.confirmed === null || row.confirmed === undefined ? null : row.confirmed ? 1 : 0,
      });
    })();
    out.events++;
    if (ev.confirmed) out.confirmed++;
    if (ev.reason === "date_shifted") out.shifted++;
    if (ev.reason === "unconfirmed") out.unconfirmed++;
    if (ev.reason === "no_bars") out.noBars++;
    if (!wasThere) out.fresh.push({ symbol, reportDate: ev.reportDate });
  }
  return out;
}
