import { statSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { agentsEnabled } from "../agents/config.js";
import { dataDir } from "../db.js";
import { nyClock } from "../history/scheduler.js";
import { addDays } from "../estimates/store.js";
import type { CapBucket, EarningsEvent, EarningsStatus, EventStats, OptionLegPath, StockPath } from "../earnings/contracts.js";
import { earningsDb } from "../earnings/db.js";
import { drainReviews, fitsToday, listReviews, queueReviews } from "../earnings/review.js";
import { gather, scoreSetup, SCREEN_SORTS, screen, setupFor, upcomingRows, type ScreenParams } from "../earnings/score.js";
import { lastNightly } from "../earnings/jobs.js";
import { backfillState } from "../earnings/progress.js";
import { ALL_KEY, capKey, getStats, poolKey, symKey } from "../earnings/stats.js";

export const earningsRouter = Router();

// Earnings-event store, setups and screens (earnings/). Mounted at /api/earnings behind requireApiKey.

const bad = (res: import("express").Response, e: z.ZodError) => res.status(400).json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a calendar date");
const symbol = z.string().transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/));
const horizon = z.enum(["intraday", "week", "month"]);
const time = z.enum(["bmo", "amc", "dmh"]);
const capBuckets = z.enum(["micro", "small", "mid", "large", "mega"]);
const bool = z.union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")]);
const symbolList = z.union([z.array(symbol), z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))]).pipe(z.array(symbol).max(2000));

const screenShape = {
  from: day.optional(), to: day.optional(), horizon: horizon.default("intraday"), time: time.optional(), sector: z.string().min(1).optional(), industry: z.string().min(1).optional(),
  minCap: z.coerce.number().nonnegative().optional(), maxCap: z.coerce.number().nonnegative().optional(), minScore: z.coerce.number().min(0).max(100).optional(),
  verdict: z.enum(["candidate", "conditional", "pass"]).optional(), tradable: bool.optional(), symbols: symbolList.optional(),
  sort: z.enum(SCREEN_SORTS).optional(), limit: z.coerce.number().int().positive().optional(),
};
const screenQuery = z.object(screenShape);

// ---- calendar ----

earningsRouter.get("/calendar", (req, res) => {
  const q = z
    .object({ from: day.optional(), to: day.optional(), time: time.optional(), sector: z.string().min(1).optional(), minCap: z.coerce.number().optional(), maxCap: z.coerce.number().optional(), optionable: bool.optional(), symbols: symbolList.optional() })
    .safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  const p = q.data;
  const from = p.from ?? nyClock(new Date()).date;
  const to = p.to ?? addDays(from, 7);
  const rows = upcomingRows({ from, to, time: p.time, symbols: p.symbols });
  const setups = gather(rows, "intraday").map((i) => ({ i, s: scoreSetup(i) }));
  const out = setups
    .filter(({ i }) => !p.sector || i.sector?.toLowerCase() === p.sector.toLowerCase())
    .filter(({ i }) => (p.minCap === undefined || (i.marketCap ?? -1) >= p.minCap) && (p.maxCap === undefined || (i.marketCap ?? Infinity) <= p.maxCap))
    .filter(({ s }) => p.optionable === undefined || (s.contract !== null) === p.optionable)
    .map(({ i, s }) => ({
      symbol: i.symbol, name: i.name, sector: i.sector, industry: i.industry, marketCap: i.marketCap,
      reportDate: i.upcoming.reportDate, time: i.upcoming.time, timeSource: i.upcoming.timeSource, timeBasis: i.upcoming.timeBasis ?? null, fmpConfirmed: i.upcoming.fmpConfirmed, t0: i.upcoming.t0,
      epsEstimate: i.upcoming.epsEstimate, revenueEstimate: i.upcoming.revenueEstimate, fiscalPeriod: i.upcoming.fiscalPeriod,
      lastReport: i.lastReport, lastReactionPct: i.lastReport?.reactionPct ?? null, impliedMovePct: i.impliedMovePct,
      optionable: s.contract !== null, tradable: s.gates.every((g) => g.passed),
    }));
  res.json(out);
});

// ---- screen, setup ----

earningsRouter.get("/screen", (req, res) => {
  const q = screenQuery.safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  res.json(screen(q.data as ScreenParams));
});

earningsRouter.get("/setup/:symbol", async (req, res) => {
  const sym = symbol.safeParse(req.params.symbol);
  const h = horizon.default("intraday").safeParse(req.query.horizon);
  if (!sym.success || !h.success) return res.status(400).json({ error: "invalid symbol or horizon (intraday, week, month)" });
  const setup = await setupFor(sym.data, h.data);
  if (!setup) return res.status(404).json({ error: `no upcoming report for ${sym.data}` });
  res.json(setup);
});

// ---- events ----

const EVENT_SQL = `SELECT e.*, p.t0_m20, p.t0_m10, p.t0_m5, p.t0_m2, p.t0_m1, p.t0_open, p.t0_1000, p.t0_1545, p.t0_close, p.r_open, p.r_close, p.r_p5, p.r_p20,
  p.prev_close, p.r_volume_ratio, p.atr14_pct FROM events e LEFT JOIN stock_paths p ON p.symbol = e.symbol AND p.report_date = e.report_date
  WHERE e.symbol = @symbol AND e.report_date >= @from AND (@confirmed IS NULL OR e.confirmed = @confirmed) ORDER BY e.report_date DESC`;

const stockPath = (r: any): StockPath => ({
  "T0-20": r.t0_m20, "T0-10": r.t0_m10, "T0-5": r.t0_m5, "T0-2": r.t0_m2, "T0-1": r.t0_m1, "T0:open": r.t0_open, "T0:10:00": r.t0_1000, "T0:15:45": r.t0_1545,
  "T0:close": r.t0_close, "R:open": r.r_open, "R:close": r.r_close, "R+5": r.r_p5, "R+20": r.r_p20,
  prevClose: r.prev_close ?? null, rVolumeRatio: r.r_volume_ratio ?? null, atr14Pct: r.atr14_pct ?? null,
});

earningsRouter.get("/events/:symbol", (req, res) => {
  const sym = symbol.safeParse(req.params.symbol);
  const q = z.object({ from: day.default("1900-01-01"), confirmed: bool.optional() }).safeParse(req.query);
  if (!sym.success || !q.success) return res.status(400).json({ error: "invalid symbol, from or confirmed" });
  const rows = earningsDb.prepare(EVENT_SQL).all({ symbol: sym.data, from: q.data.from, confirmed: q.data.confirmed === undefined ? null : q.data.confirmed ? 1 : 0 }) as any[];
  const legs = new Map<string, OptionLegPath[]>();
  for (const o of earningsDb.prepare("SELECT * FROM option_paths WHERE symbol = ? ORDER BY report_date, entry, expiry_kind, leg").all(sym.data) as any[]) {
    const list = legs.get(o.report_date) ?? [];
    list.push({ entry: o.entry, expiryKind: o.expiry_kind, leg: o.leg, contract: o.contract, expiry: o.expiry, strike: o.strike, spotAtEntry: o.spot_at_entry, prices: JSON.parse(o.prices), ivAtEntry: o.iv_at_entry, priceSource: o.price_source, volumeAtEntryDay: o.volume_at_entry_day });
    legs.set(o.report_date, list);
  }
  const out = rows.map((r): EarningsEvent & { stock: StockPath; options: OptionLegPath[] } => ({
    symbol: r.symbol, reportDate: r.report_date, time: r.time, timeSource: r.time_source, t0: r.t0, r: r.r, fiscalPeriod: r.fiscal_period, fiscalYear: r.fiscal_year, periodEnding: r.period_ending,
    epsActual: r.eps_actual, epsEstimate: r.eps_estimate, revenueActual: r.revenue_actual, revenueEstimate: r.revenue_estimate, confirmed: r.confirmed === 1,
    checks: { fmp: r.check_fmp === 1, transcript: r.check_transcript === 1, pressRelease: r.check_press_release === 1, volume: r.check_volume === 1 },
    reason: r.reason, fmpConfirmedFlag: r.fmp_confirmed_flag === null ? null : r.fmp_confirmed_flag === 1,
    stock: stockPath(r), options: legs.get(r.report_date) ?? [],
  }));
  res.json(out);
});

// ---- stats ----

earningsRouter.get("/stats", (req, res) => {
  const q = z
    .object({ horizon: horizon.default("intraday"), symbol: symbol.optional(), sector: z.string().min(1).optional(), capBucket: capBuckets.optional(), time: z.enum(["bmo", "amc", "dmh", "any"]).default("any") })
    .safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  const { horizon: h, symbol: sym, sector, capBucket, time: t } = q.data;
  if (sector && !capBucket) return res.status(400).json({ error: "sector needs capBucket (pools are sector x capBucket)" });
  const key = sym ? symKey(sym) : sector && capBucket ? poolKey(sector, capBucket as CapBucket) : capBucket ? capKey(capBucket as CapBucket) : ALL_KEY;
  const stats: EventStats | null = getStats(key, h, t);
  if (!stats) return res.status(404).json({ error: `no stats for ${key} (${h}, ${t})` });
  res.json(stats);
});

// ---- status ----

earningsRouter.get("/status", (_req, res) => {
  const one = <T,>(sql: string, ...args: unknown[]) => earningsDb.prepare(sql).get(...args) as T;
  const prog = earningsDb.prepare("SELECT task, COUNT(*) AS n, MIN(updated_at) AS first, MAX(updated_at) AS last, SUM(status = 'error') AS errors, SUM(status = 'done') AS done FROM backfill_progress WHERE task IN ('events','stock','options','analyst') GROUP BY task").all() as Array<{ task: string; n: number; first: string; last: string; errors: number; done: number }>;
  const byTask = new Map(prog.map((p) => [p.task, p]));
  // Phase from the backfill CLI's completion markers (progress.ts); count logic only for databases without markers.
  const { phase, phases } = backfillState(earningsDb);
  const current = byTask.get(phase === "idle" || phase === "done" ? "options" : (phase as string));
  const total = one<{ n: number }>("SELECT COUNT(DISTINCT symbol) AS n FROM events").n;
  const ev = one<{ stored: number; confirmed: number; last: string | null }>("SELECT COUNT(*) AS stored, COALESCE(SUM(confirmed), 0) AS confirmed, MAX(updated_at) AS last FROM events");
  const today = nyClock(new Date()).date;
  const snap = one<{ last: string | null; names: number; rows: number }>("SELECT MAX(ts) AS last, COUNT(DISTINCT symbol) AS names, COUNT(*) AS rows FROM snapshots WHERE ts >= ?", `${today}T00:00:00Z`);
  const tracked = one<{ n: number }>("SELECT COUNT(DISTINCT symbol) AS n FROM snapshots").n;
  let size = 0;
  for (const f of ["earnings.db", "earnings.db-wal"]) {
    try {
      size += statSync(join(dataDir, f)).size;
    } catch { /* absent */ }
  }
  const status: EarningsStatus = {
    backfill: {
      phase, phases, symbolsDone: current?.done ?? 0, symbolsTotal: Math.max(total, current?.n ?? 0), eventsStored: ev.stored, eventsConfirmed: ev.confirmed,
      optionEvents: one<{ n: number }>("SELECT COUNT(DISTINCT symbol || report_date) AS n FROM option_paths").n,
      startedAt: current?.first ?? null, updatedAt: current?.last ?? null, errors: [...byTask.values()].reduce((a, p) => a + (p.errors ?? 0), 0),
    },
    nightly: lastNightly() ?? { lastRun: null, newEvents: 0 },
    snapshots: { lastRun: snap.last, namesTracked: tracked, rowsToday: snap.rows },
    db: { sizeBytes: size },
  };
  res.json(status);
});

// ---- reviews ----

const reviewBody = z.object({
  horizon,
  symbols: z.array(symbol).max(2000).optional(),
  filter: z.object({ ...screenShape, horizon: horizon.optional() }).partial().optional(),
  dryRun: z.boolean().optional(),
});

earningsRouter.post("/review", (req, res) => {
  if (!agentsEnabled()) return res.status(503).json({ error: "agents are disabled (AGENTS_ENABLED=0)" });
  const b = reviewBody.safeParse(req.body);
  if (!b.success) return bad(res, b.error);
  const params: ScreenParams = { ...(b.data.filter as ScreenParams), horizon: b.data.horizon };
  if (b.data.symbols) params.symbols = b.data.symbols;
  // Default filter: gates passed.
  if (params.tradable === undefined) params.tradable = true;
  const setups = screen(params);
  if (setups.length > 0 && fitsToday() < 1) return res.status(402).json({ error: "daily AI budget reached" });
  const r = queueReviews(b.data.horizon, setups, { dryRun: b.data.dryRun });
  if (!b.data.dryRun && r.queued > 0) setImmediate(() => void drainReviews());
  res.status(b.data.dryRun ? 200 : 202).json(r);
});

earningsRouter.get("/reviews", (req, res) => {
  const q = z.object({ reportDate: day.optional(), from: day.optional(), to: day.optional(), horizon: horizon.optional(), symbol: symbol.optional(), limit: z.coerce.number().int().positive().max(5000).optional() }).safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  res.json(listReviews(q.data));
});

