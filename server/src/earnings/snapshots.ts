import { mapWithConcurrency } from "../concurrency.js";
import { nyInstant } from "../live/session.js";
import { midPrice } from "../options/black-scholes.js";
import { parseSnapshots, type ParsedContract } from "../options/sweep.js";
import { snapshots as stockSnapshots } from "../providers/alpaca.js";
import { ensureCalendar, isTradingDay } from "../providers/alpaca-calendar.js";
import { optionSnapshots } from "../providers/alpaca-options.js";
import type { Anchor } from "./contracts.js";
import { earningsDb } from "./db.js";
import { addSessions, ENTRIES, TRACK_ORDER } from "./option-paths.js";

// Live earnings snapshots over REST (never the OPRA stream). Names whose T0 is
// within 10 sessions get a summary every 30 minutes from 09:45 to 15:45 ET;
// names 11–45 sessions out get one at 15:50. Each cycle stores, per name, two
// rows: expiry_kind "event" (the first expiry on or after R) and "next" (the
// expiry after it), each with the ATM call and put quote, volume, IV and the
// implied move (ATM straddle mid ÷ spot). The event row also carries the event
// premium (event-expiry ATM IV ÷ next-expiry ATM IV).
//
// After R the quotes roll into option_paths (priceSource "quote") where trades
// left gaps, and snapshot rows more than 30 days past the report are pruned.

export const NEAR_SESSIONS = 10;
export const FAR_SESSIONS = 45;
const STRIKE_BAND = 0.1; // spot ±10%
const EXPIRY_WINDOW_DAYS = 35; // after R: enough to reach the next expiry on monthly-only names
const GRACE_MIN = 4; // a tick this late still runs the slot
const PRUNE_DAYS = 30;
const CONCURRENCY = 8;

const NEAR_MINUTES = Array.from({ length: 13 }, (_, i) => 9 * 60 + 45 + 30 * i); // 09:45 … 15:45
const FAR_MINUTE = 15 * 60 + 50;
const CLOSE_MINUTE = 16 * 60 + 10; // roll-up and prune

const nyParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** New York date and minute-of-day of an instant. */
export function nyClock(ms: number): { day: string; minutes: number } {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export type Slot = { key: string; kind: "near" | "far" | "close"; day: string; minutes: number };

/** The slot due at `nowMs` (within the grace window of its nominal time), or null. Non-trading days have none. */
export function slotAt(nowMs: number): Slot | null {
  const { day, minutes } = nyClock(nowMs);
  if (!isTradingDay(day)) return null;
  const due = (m: number) => minutes >= m && minutes < m + GRACE_MIN;
  const near = NEAR_MINUTES.find(due);
  if (near !== undefined) return { key: `${day}T${near}`, kind: "near", day, minutes: near };
  if (due(FAR_MINUTE)) return { key: `${day}T${FAR_MINUTE}`, kind: "far", day, minutes: FAR_MINUTE };
  if (due(CLOSE_MINUTE)) return { key: `${day}T${CLOSE_MINUTE}`, kind: "close", day, minutes: CLOSE_MINUTE };
  return null;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type Tracked = { symbol: string; reportDate: string; t0: string; r: string };

/** Names to snapshot: the next upcoming report of each, T0 within 10 sessions (near) or 11–45 (far). */
export function trackedNames(kind: "near" | "far", today: string): Tracked[] {
  const nearEnd = addSessions(today, NEAR_SESSIONS);
  const lo = kind === "near" ? today : addDays(nearEnd, 1);
  const hi = kind === "near" ? nearEnd : addSessions(today, FAR_SESSIONS);
  const rows = earningsDb
    .prepare("SELECT symbol, report_date, t0, r FROM upcoming WHERE t0 IS NOT NULL AND r IS NOT NULL AND t0 >= ? AND t0 <= ? ORDER BY symbol, t0")
    .all(lo, hi) as Array<{ symbol: string; report_date: string; t0: string; r: string }>;
  const seen = new Set<string>();
  const out: Tracked[] = [];
  for (const r of rows) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    out.push({ symbol: r.symbol, reportDate: r.report_date, t0: r.t0, r: r.r });
  }
  return out;
}

// ---- summary math ------------------------------------------------------------

export type AtmSummary = {
  expiry: string;
  strike: number;
  call: ParsedContract;
  put: ParsedContract;
  otm: ParsedContract | null; // the call at the next strike above the ATM one
  impliedMovePct: number | null; // straddle mid ÷ spot
  iv: number | null; // mean of the call and put IV
};

const mean = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** ATM pair of one expiry: the strike nearest spot that has both a call and a put. Null when there is none. */
export function atmSummary(contracts: ParsedContract[], expiry: string, spot: number): AtmSummary | null {
  const calls = new Map<number, ParsedContract>();
  const puts = new Map<number, ParsedContract>();
  for (const c of contracts) if (c.expiry === expiry) (c.right === "call" ? calls : puts).set(c.strike, c);
  const both = [...calls.keys()].filter((s) => puts.has(s)).sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b);
  if (both.length === 0) return null;
  const strike = both[0];
  const call = calls.get(strike)!;
  const put = puts.get(strike)!;
  const straddle = call.mid !== null && put.mid !== null ? call.mid + put.mid : null;
  const above = [...calls.keys()].filter((k) => k > strike).sort((a, b) => a - b)[0];
  const otm = above === undefined ? null : calls.get(above)!;
  return { expiry, strike, call, put, otm, impliedMovePct: straddle !== null && spot > 0 ? (straddle / spot) * 100 : null, iv: mean([call.iv, put.iv]) };
}

/** Event-expiry ATM IV ÷ next-expiry ATM IV; null when either is missing. */
export function eventPremium(event: AtmSummary | null, next: AtmSummary | null): number | null {
  if (!event?.iv || !next?.iv) return null;
  return event.iv / next.iv;
}

/** Event expiry and the one after it among the expiries on or after R. */
export function eventAndNext(contracts: ParsedContract[], r: string): { event: string | null; next: string | null } {
  const exps = [...new Set(contracts.map((c) => c.expiry))].filter((e) => e >= r).sort();
  return { event: exps[0] ?? null, next: exps[1] ?? null };
}

// ---- one cycle ---------------------------------------------------------------

export type CycleResult = { kind: "near" | "far"; names: number; rows: number; noOptions: number; errors: number; requests: number };

const insertSnapshot = earningsDb.prepare(`INSERT OR REPLACE INTO snapshots
  (symbol, ts, expiry_kind, report_date, expiry, spot, call_occ, call_strike, call_bid, call_ask, call_iv, call_volume, call_oi,
   put_occ, put_strike, put_bid, put_ask, put_iv, put_volume, put_oi,
   otm_occ, otm_strike, otm_bid, otm_ask, otm_iv, otm_volume, otm_oi, call_delta, otm_delta, put_delta, implied_move_pct, event_premium)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function storeRow(t: Tracked, ts: string, kind: "event" | "next", spot: number, a: AtmSummary, premium: number | null): void {
  insertSnapshot.run(
    t.symbol, ts, kind, t.reportDate, a.expiry, spot,
    a.call.occ, a.strike, a.call.bid, a.call.ask, a.call.iv, a.call.volume, a.call.openInterest,
    a.put.occ, a.strike, a.put.bid, a.put.ask, a.put.iv, a.put.volume, a.put.openInterest,
    a.otm?.occ ?? null, a.otm?.strike ?? null, a.otm?.bid ?? null, a.otm?.ask ?? null, a.otm?.iv ?? null, a.otm?.volume ?? null, a.otm?.openInterest ?? null,
    a.call.delta, a.otm?.delta ?? null, a.put.delta,
    a.impliedMovePct, premium
  );
}

// Names whose options came back empty today are not asked again until tomorrow.
const noOptionsToday = { day: "", symbols: new Set<string>() };

/** Test hook. */
export function resetSnapshotState(): void {
  noOptionsToday.day = "";
  noOptionsToday.symbols.clear();
}

/** Snapshot every tracked name once. `slotMs` is the nominal time stamped on the rows. */
export async function runSnapshotCycle(kind: "near" | "far", slotMs: number): Promise<CycleResult> {
  const { day } = nyClock(slotMs);
  await ensureCalendar(Number(day.slice(0, 4)));
  if (noOptionsToday.day !== day) {
    noOptionsToday.day = day;
    noOptionsToday.symbols.clear();
  }
  const names = trackedNames(kind, day).filter((t) => !noOptionsToday.symbols.has(t.symbol));
  const result: CycleResult = { kind, names: names.length, rows: 0, noOptions: 0, errors: 0, requests: 0 };
  if (names.length === 0) return result;
  const ts = new Date(slotMs).toISOString();
  const stats = { requests: 0 };

  const spots = new Map<string, number>();
  for (let i = 0; i < names.length; i += 200) {
    try {
      const snaps = await stockSnapshots(names.slice(i, i + 200).map((n) => n.symbol));
      stats.requests++;
      for (const [sym, s] of Object.entries(snaps)) {
        const p = s?.latestTrade?.p ?? s?.dailyBar?.c;
        if (typeof p === "number" && p > 0) spots.set(sym, p);
      }
    } catch (err) {
      result.errors++;
      console.warn(`[snapshots] stock prices failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await mapWithConcurrency(names, CONCURRENCY, async (t) => {
    const spot = spots.get(t.symbol);
    if (!spot) return;
    try {
      const raw = await optionSnapshots(
        t.symbol,
        { expiryMin: t.r, expiryMax: addDays(t.r, EXPIRY_WINDOW_DAYS), strikeMin: spot * (1 - STRIKE_BAND), strikeMax: spot * (1 + STRIKE_BAND) },
        4,
        stats
      );
      const contracts = parseSnapshots(raw, spot, slotMs);
      const { event, next } = eventAndNext(contracts, t.r);
      const ev = event ? atmSummary(contracts, event, spot) : null;
      if (!ev) {
        noOptionsToday.symbols.add(t.symbol);
        result.noOptions++;
        return;
      }
      const nx = next ? atmSummary(contracts, next, spot) : null;
      storeRow(t, ts, "event", spot, ev, eventPremium(ev, nx));
      result.rows++;
      if (nx) {
        storeRow(t, ts, "next", spot, nx, null);
        result.rows++;
      }
    } catch (err) {
      result.errors++;
      console.warn(`[snapshots] ${t.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  result.requests = stats.requests;
  return result;
}

// ---- roll-up and prune -------------------------------------------------------

/** Which entry or exit anchor a snapshot taken at `tsIso` stands for, given the event's T0; null if none. */
export function snapshotAnchor(tsIso: string, t0: string): Anchor | null {
  const ms = Date.parse(tsIso);
  const { day, minutes } = nyClock(ms);
  if (day === t0) {
    if (minutes >= 9 * 60 + 40 && minutes <= 10 * 60 + 20) return "T0:10:00";
    if (minutes >= 15 * 60 + 40 && minutes <= 15 * 60 + 55) return "T0:15:45";
    return null;
  }
  if (day > t0 || minutes < 15 * 60 + 40) return null; // a daily-close anchor needs a late-session snapshot
  for (const k of [1, 2, 5, 10, 20]) if (addSessions(t0, -k) === day) return `T0-${k}` as Anchor;
  return null;
}

type SnapRow = {
  ts: string; spot: number; call_occ: string; call_strike: number; call_bid: number | null; call_ask: number | null; call_iv: number | null; call_volume: number | null;
  put_occ: string; put_strike: number; put_bid: number | null; put_ask: number | null; put_iv: number | null; put_volume: number | null; expiry: string;
};

const mid = (bid: number | null, ask: number | null): number | null => midPrice(bid, ask);

/**
 * Fold the quote snapshots of events whose R is before `today` into
 * option_paths: gaps in an existing trade-based leg are filled from the
 * quotes of the same contract, and a leg with no trade price at entry is
 * written from the quotes with priceSource "quote". Only atm_call and
 * atm_put of the event expiry (all the snapshots carry). Returns the legs
 * written or changed.
 */
export function rollUpSnapshots(today: string): number {
  const events = earningsDb
    .prepare(
      `SELECT DISTINCT s.symbol, s.report_date, COALESCE(e.t0, u.t0) AS t0, COALESCE(e.r, u.r) AS r
       FROM snapshots s
       LEFT JOIN events e ON e.symbol = s.symbol AND e.report_date = s.report_date
       LEFT JOIN upcoming u ON u.symbol = s.symbol AND u.report_date = s.report_date
       WHERE s.expiry_kind = 'event' AND s.report_date IS NOT NULL`
    )
    .all() as Array<{ symbol: string; report_date: string; t0: string | null; r: string | null }>;
  let changed = 0;
  const getPath = earningsDb.prepare("SELECT contract, prices, price_source FROM option_paths WHERE symbol = ? AND report_date = ? AND entry = ? AND expiry_kind = 'event' AND leg = ?");
  const putPath = earningsDb.prepare(`INSERT OR REPLACE INTO option_paths
    (symbol, report_date, entry, expiry_kind, leg, contract, expiry, strike, spot_at_entry, prices, iv_at_entry, price_source, volume_at_entry_day, updated_at)
    VALUES (?, ?, ?, 'event', ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  const fillPath = earningsDb.prepare("UPDATE option_paths SET prices = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE symbol = ? AND report_date = ? AND entry = ? AND expiry_kind = 'event' AND leg = ?");
  for (const ev of events) {
    if (!ev.t0 || !ev.r || ev.r >= today) continue;
    const rows = earningsDb.prepare("SELECT * FROM snapshots WHERE symbol = ? AND report_date = ? AND expiry_kind = 'event' ORDER BY ts").all(ev.symbol, ev.report_date) as SnapRow[];
    const byAnchor = new Map<Anchor, SnapRow>();
    const quotes = new Map<string, Partial<Record<Anchor, number>>>(); // occ -> anchor -> mid
    for (const row of rows) {
      const anchor = snapshotAnchor(row.ts, ev.t0);
      if (!anchor) continue;
      byAnchor.set(anchor, row);
      for (const [occ, m] of [[row.call_occ, mid(row.call_bid, row.call_ask)], [row.put_occ, mid(row.put_bid, row.put_ask)]] as Array<[string, number | null]>) {
        if (m === null) continue;
        if (!quotes.has(occ)) quotes.set(occ, {});
        quotes.get(occ)![anchor] = m;
      }
    }
    earningsDb.transaction(() => {
      for (const entry of ENTRIES) {
        const row = byAnchor.get(entry);
        if (!row) continue;
        const tracked = TRACK_ORDER.slice(TRACK_ORDER.indexOf(entry));
        for (const leg of ["atm_call", "atm_put"] as const) {
          const occ = leg === "atm_call" ? row.call_occ : row.put_occ;
          const q = quotes.get(occ) ?? {};
          if (q[entry] === undefined) continue;
          const existing = getPath.get(ev.symbol, ev.report_date, entry, leg) as { contract: string; prices: string; price_source: string } | undefined;
          const old: Partial<Record<Anchor, number | null>> = existing ? JSON.parse(existing.prices) : {};
          if (existing && typeof old[entry] === "number") {
            // A trade-based leg: only fill the gaps, and only from the same contract.
            if (existing.contract !== occ) continue;
            let filled = 0;
            for (const a of tracked) {
              if (old[a] == null && q[a] !== undefined) {
                old[a] = q[a]!;
                filled++;
              }
            }
            if (filled === 0) continue;
            fillPath.run(JSON.stringify(old), ev.symbol, ev.report_date, entry, leg);
          } else {
            const prices: Partial<Record<Anchor, number | null>> = {};
            for (const a of tracked) prices[a] = q[a] ?? null;
            const isCall = leg === "atm_call";
            putPath.run(ev.symbol, ev.report_date, entry, leg, occ, row.expiry, isCall ? row.call_strike : row.put_strike, row.spot, JSON.stringify(prices), isCall ? row.call_iv : row.put_iv, "quote", isCall ? row.call_volume : row.put_volume);
          }
          changed++;
        }
      }
    })();
  }
  return changed;
}

/** Delete snapshot rows more than 30 days past their report date. */
export function pruneSnapshots(today: string): number {
  const cutoff = addDays(today, -PRUNE_DAYS - 1);
  return earningsDb.prepare("DELETE FROM snapshots WHERE (report_date IS NOT NULL AND report_date < ?) OR (report_date IS NULL AND ts < ?)").run(cutoff, `${addDays(today, -90)}T00:00:00Z`).changes;
}

// ---- scheduler ---------------------------------------------------------------

/** Arm the snapshot cycles; returns the stop function. */
export function startSnapshotJobs(): () => void {
  let lastKey = "";
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const now = Date.now();
    const slot = slotAt(now);
    if (!slot || slot.key === lastKey) return;
    lastKey = slot.key;
    busy = true;
    const started = Date.now();
    try {
      if (slot.kind === "close") {
        const rolled = rollUpSnapshots(slot.day);
        const pruned = pruneSnapshots(slot.day);
        console.log(`[snapshots] close roll-up legs=${rolled} pruned=${pruned}`);
      } else {
        const res = await runSnapshotCycle(slot.kind, nyInstant(slot.day, Math.floor(slot.minutes / 60), slot.minutes % 60));
        console.log(`[snapshots] ${slot.kind} ${String(Math.floor(slot.minutes / 60)).padStart(2, "0")}:${String(slot.minutes % 60).padStart(2, "0")} names=${res.names} rows=${res.rows} noOptions=${res.noOptions} errors=${res.errors} requests=${res.requests} ${Date.now() - started}ms`);
      }
    } catch (err) {
      console.warn(`[snapshots] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 20_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
