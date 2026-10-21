import { db } from "../db.js";
import { addDays } from "../estimates/store.js";
import { timingsFor } from "../estimates/timing.js";
import { nyClock } from "../history/scheduler.js";
import { liveQuote } from "../live/feed.js";
import { isTradingDay } from "../providers/alpaca-calendar.js";
import * as calendars from "../providers/calendars.js";
import * as fmp from "../providers/fmp.js";
import { withConsensus } from "../routes/econ-calendar.js";
import { listIdeas } from "../quant/ideas.js";
import { heldSymbols } from "../quant/positions.js";
import { resolveUniverse } from "../quant/universe.js";
import { capUsd, MAX_TURNS, model } from "./config.js";
import type { Brief, Thesis } from "./contracts.js";
import { loadPrompt } from "./prompts.js";
import { runAgent } from "./runtime.js";
import { briefJson, briefOutput } from "./schemas.js";
import { insertBrief, latestMacro, latestThesisByIdea, latestThesisFor } from "./store.js";

// The brief's inputs are gathered here, in code, from the app's own modules;
// the model only writes them up.

export const MOVER_MIN_PERCENT = 1;
export const MOVERS = 10;
const MAX_EARNINGS = 40;

type EconEvent = { time: string; title: string; impact: string; forecast: string | null; previous: string | null; actual: string | null };
export type BriefDeps = { econEvents: (day: string) => Promise<EconEvent[]>; symbols: () => string[]; held: () => string[] };

const defaultEcon = async (day: string): Promise<EconEvent[]> => {
  const official = await calendars.econEvents(day, day);
  const events = fmp.isConfigured() ? withConsensus(official, await fmp.economicCalendar(day, day).catch(() => [])) : official;
  return events.filter((e) => e.country === "US" && e.date.slice(0, 10) === day).map((e) => ({ time: e.date, title: e.title, impact: e.impact, forecast: e.forecast, previous: e.previous, actual: e.actual }));
};
const defaultDeps: BriefDeps = { econEvents: defaultEcon, symbols: () => resolveUniverse(), held: () => heldSymbols() };

const previousTradingDay = (day: string): string => {
  let d = addDays(day, -1);
  for (let i = 0; i < 10 && !isTradingDay(d); i++) d = addDays(d, -1);
  return d;
};

const compactThesis = (t: Thesis | null) =>
  t && {
    id: t.id, status: t.status, statusReason: t.statusReason, asOf: t.asOf, verdict: t.verdict, confidence: t.confidence, horizon: t.horizon,
    entry: t.entry, target: t.target, invalidation: t.invalidation, catalysts: t.catalysts, risks: t.risks, summary: t.summary,
  };

export type PendingAnalysis = { symbol: string; strategy: string; state: "queued" | "running" };

export async function gatherBriefInputs(now: Date, pending: PendingAnalysis[] = [], deps: BriefDeps = defaultDeps) {
  const day = nyClock(now).date;
  const macro = latestMacro(day);
  const held = new Set(deps.held());
  const universe = [...new Set([...deps.symbols(), ...held])];

  let events: EconEvent[] = [];
  let eventsError: string | null = null;
  try {
    events = await deps.econEvents(day);
  } catch (err) {
    eventsError = err instanceof Error ? err.message : String(err);
  }

  // Earnings: today's reports (timing before the open, or unknown) and yesterday's after-close reports.
  const prev = previousTradingDay(day);
  const rows = db
    .prepare("SELECT symbol, report_date, eps_estimate, revenue_estimate, eps_actual, revenue_actual FROM earnings_calendar WHERE report_date IN (?, ?) AND symbol IN (SELECT value FROM json_each(?))")
    .all(day, prev, JSON.stringify(universe)) as Array<{ symbol: string; report_date: string; eps_estimate: number | null; revenue_estimate: number | null; eps_actual: number | null; revenue_actual: number | null }>;
  const timing = timingsFor(rows.map((r) => r.symbol));
  const entry = (r: (typeof rows)[number]) => ({
    symbol: r.symbol, held: held.has(r.symbol), timing: timing.get(r.symbol)?.timing ?? null, reportDate: r.report_date,
    epsEstimate: r.eps_estimate, revenueEstimate: r.revenue_estimate, epsActual: r.eps_actual, revenueActual: r.revenue_actual,
  });
  const byHeld = (a: { symbol: string; held: boolean }, b: { symbol: string; held: boolean }) => Number(b.held) - Number(a.held) || a.symbol.localeCompare(b.symbol);
  const reportingToday = rows.filter((r) => r.report_date === day).map(entry).filter((e) => e.timing !== "amc").sort(byHeld).slice(0, MAX_EARNINGS);
  const reportedAfterClose = rows.filter((r) => r.report_date === prev).map(entry).filter((e) => e.timing === "amc").sort(byHeld).slice(0, MAX_EARNINGS);

  // Movers: the latest extended session's move since the last regular close.
  const movers = universe
    .map((symbol) => {
      const q = liveQuote(symbol, symbol, now);
      if (!q) return null;
      const sessions = (["pre", "overnight", "post"] as const).flatMap((s) => (q.extended[s] ? [{ session: s, ...q.extended[s]! }] : []));
      sessions.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      const s = sessions[0];
      if (!s || s.changePercent === null) return null;
      return { symbol, held: held.has(symbol), session: s.session, price: s.price, changePercent: Math.round(s.changePercent * 100) / 100, previousClose: q.previousClose, asOf: s.time };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null && Math.abs(m.changePercent) >= MOVER_MIN_PERCENT)
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, MOVERS);

  const state = (symbol: string, strategy: string) => pending.find((p) => p.symbol === symbol && p.strategy === strategy)?.state ?? null;
  const ideaBlock = (kind: "stock" | "option") =>
    listIdeas({ kind, limit: 5 }).map((i) => {
      const thesis = latestThesisByIdea(i.id) ?? latestThesisFor(i.symbol, i.strategy, i.contract);
      return { symbol: i.symbol, strategy: i.strategy, contract: i.contract, score: i.score, rank: i.rank, reasons: i.reasons, held: held.has(i.symbol), thesis: compactThesis(thesis), analysis: thesis ? "thesis" : (state(i.symbol, i.strategy) ?? "none") };
    });

  const stockIdeas = ideaBlock("stock");
  const optionIdeas = ideaBlock("option");
  const thesisIds = [...stockIdeas, ...optionIdeas].flatMap((i) => (i.thesis ? [i.thesis.id] : []));
  return {
    day, now: now.toISOString(),
    macro: macro ? { id: macro.id, asOf: macro.asOf, session: macro.session, regime: macro.regime, summary: macro.summary, events: macro.events, risks: macro.risks } : null,
    macroNote: macro ? null : "No macro report today",
    economicEvents: events, economicEventsError: eventsError,
    earnings: { reportingToday, reportedAfterClose, previousTradingDay: prev },
    movers, stockIdeas, optionIdeas,
    pendingAnalyses: pending,
    thesisIds,
  };
}

export async function runBrief(now = new Date(), pending: PendingAnalysis[] = [], deps?: BriefDeps): Promise<{ ok: true; brief: Brief } | { ok: false; error: string }> {
  const inputs = await gatherBriefInputs(now, pending, deps);
  const { thesisIds, ...forModel } = inputs;
  const r = await runAgent({
    agent: "brief", model: model(), system: loadPrompt("brief"),
    prompt: `Write today's pre-market brief from these inputs (JSON):\n${JSON.stringify(forModel)}`,
    schema: briefOutput, jsonSchema: briefJson, tools: [], maxBudgetUsd: capUsd("brief"), maxTurns: MAX_TURNS.brief, now,
  });
  if (!r.ok || !r.output) return { ok: false, error: r.error ?? "no output" };
  return { ok: true, brief: insertBrief({ day: inputs.day, asOf: now.toISOString(), markdown: r.output.markdown, macroId: inputs.macro?.id ?? null, thesisIds, costUsd: r.costUsd }) };
}
