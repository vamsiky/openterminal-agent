import { db } from "../db.js";
import { calendarFor } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import type { Idea, IdeaKind, OptionStrategy, Scorecard } from "../scan/contracts.js";
import { allOptionScorecards } from "./option-score.js";
import { GROUP_LABELS, factorLabel, getLiveScorecard, topNightly } from "./stock-score.js";

// Ideas: what the Ideas widget lists. Stock ideas are the universe's best
// composites, screened nightly and re-scored every 15 minutes. Option ideas
// are setups scoring 70 or more, refreshed every 5 minutes. A row keeps its
// first_seen while it stays; it is marked dropped (never deleted) when it
// falls out, so the widget can show what just left.

export const STOCK_IDEAS = 25;
export const OPTION_IDEAS = 20;
/** Minimum option setup score to be listed. */
export const OPTION_IDEA_MIN_SCORE = 70;
/** A stock idea needs this share of factors with data. */
export const MIN_COVERAGE = 0.6;
/** Consecutive scans an option idea may miss before it is dropped. */
export const OPTION_MISSES_TO_DROP = 2;
const EARNINGS_WINDOW_DAYS = 30;

db.exec(`
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('stock','option')),
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  contract TEXT,
  score REAL NOT NULL,
  rank INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dropped')),
  misses INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, symbol, strategy)
);
CREATE INDEX IF NOT EXISTS ideas_status ON ideas (kind, status, rank);
`);

type Row = {
  id: number;
  kind: IdeaKind;
  symbol: string;
  strategy: Idea["strategy"];
  contract: string | null;
  score: number;
  rank: number;
  reasons: string;
  first_seen: string;
  last_seen: string;
  status: "active" | "dropped";
};

const toIdea = (r: Row): Idea => ({
  id: r.id, kind: r.kind, symbol: r.symbol, strategy: r.strategy, contract: r.contract, score: r.score, rank: r.rank,
  reasons: JSON.parse(r.reasons), firstSeen: r.first_seen, lastSeen: r.last_seen, status: r.status,
});

export function listIdeas(opts: { kind?: IdeaKind; status?: "active" | "dropped"; limit?: number } = {}): Idea[] {
  const where: string[] = ["status = ?"];
  const args: Array<string | number> = [opts.status ?? "active"];
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  args.push(opts.limit ?? STOCK_IDEAS);
  const order = (opts.status ?? "active") === "active" ? "rank, id" : "last_seen DESC, id DESC";
  return (db.prepare(`SELECT * FROM ideas WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`).all(...args) as Row[]).map(toIdea);
}

/** When the ideas were last touched, or null before the first screen. */
export function ideasAsOf(kind?: IdeaKind): string | null {
  const r = (kind
    ? db.prepare("SELECT MAX(last_seen) AS t FROM ideas WHERE kind = ?").get(kind)
    : db.prepare("SELECT MAX(last_seen) AS t FROM ideas").get()) as { t: string | null };
  return r.t;
}

/** "momentum 92: 6-month return in the 98th percentile of its sector" for the three strongest groups. */
export function stockReasons(card: Scorecard, today: string): string[] {
  const groups = Object.entries(card.groups)
    .filter((g): g is [string, number] => g[1] !== null)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const reasons = groups.map(([g, score]) => {
    const best = card.factors.filter((f) => f.group === g && f.score !== null).sort((a, b) => b.score! - a.score!)[0];
    const ordinal = best ? `; best: ${factorLabel(best.key)} (${Math.round(best.score!)}th percentile in its sector)` : "";
    return `${GROUP_LABELS[g] ?? g} ${Math.round(score)}/100${ordinal}`;
  });
  const next = calendarFor([card.symbol], today)[0]?.nextEarningsDate;
  if (next) {
    const date = new Date(next * 1000).toISOString().slice(0, 10);
    const days = Math.round((next * 1000 - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (days >= 0 && days < EARNINGS_WINDOW_DAYS) reasons.push(`reports earnings on ${date} (in ${days} day${days === 1 ? "" : "s"})`);
  }
  return reasons;
}

type Candidate = { symbol: string; strategy: "buy" | OptionStrategy; contract: string | null; score: number; reasons: string[] };

const upsert = db.prepare(
  `INSERT INTO ideas (kind, symbol, strategy, contract, score, rank, reasons, first_seen, last_seen, status, misses)
   VALUES (@kind, @symbol, @strategy, @contract, @score, @rank, @reasons, @now, @now, 'active', 0)
   ON CONFLICT (kind, symbol, strategy) DO UPDATE SET
     contract = excluded.contract, score = excluded.score, rank = excluded.rank, reasons = excluded.reasons, last_seen = excluded.last_seen,
     misses = 0,
     first_seen = CASE WHEN ideas.status = 'dropped' THEN excluded.first_seen ELSE ideas.first_seen END,
     status = 'active'`
);

function place(kind: IdeaKind, ranked: Candidate[], now: string): void {
  ranked.forEach((c, i) => upsert.run({ kind, symbol: c.symbol, strategy: c.strategy, contract: c.contract, score: Math.round(c.score * 10) / 10, rank: i + 1, reasons: JSON.stringify(c.reasons), now }));
}

/**
 * The stock screen: the top 25 composites among `universe` with enough data
 * become (or stay) active; active stock ideas outside them are dropped.
 */
export function runStockScreen(universe: string[], now = new Date()): { listed: number; dropped: number } {
  const today = nyClock(now).date;
  const iso = now.toISOString();
  const top = topNightly(universe, MIN_COVERAGE, STOCK_IDEAS);
  let dropped = 0;
  db.transaction(() => {
    place("stock", top.map((c) => ({ symbol: c.symbol, strategy: "buy", contract: null, score: c.composite!, reasons: stockReasons(c, today) })), iso);
    const keep = JSON.stringify(top.map((c) => c.symbol));
    dropped = db
      .prepare("UPDATE ideas SET status = 'dropped' WHERE kind = 'stock' AND status = 'active' AND symbol NOT IN (SELECT value FROM json_each(?))")
      .run(keep).changes;
  })();
  return { listed: top.length, dropped };
}

/** The 15-minute update: active stock ideas take the live score and reasons; ranks follow the new order. */
export function refreshStockIdeas(now = new Date()): number {
  const today = nyClock(now).date;
  const iso = now.toISOString();
  const active = listIdeas({ kind: "stock", limit: 100 });
  const updated: Candidate[] = [];
  for (const idea of active) {
    const live = getLiveScorecard(idea.symbol);
    if (!live || live.composite === null) {
      updated.push({ symbol: idea.symbol, strategy: "buy", contract: null, score: idea.score, reasons: idea.reasons });
    } else updated.push({ symbol: idea.symbol, strategy: "buy", contract: null, score: live.composite, reasons: stockReasons(live, today) });
  }
  updated.sort((a, b) => b.score - a.score);
  db.transaction(() => place("stock", updated, iso))();
  return updated.length;
}

/**
 * The 5-minute option pass: the best setups scoring 70+ (top 20, one per
 * symbol and strategy) are active; one that is missing from two scans in a
 * row is dropped.
 */
export function updateOptionIdeas(now = new Date()): { listed: number; dropped: number } {
  const iso = now.toISOString();
  const candidates: Candidate[] = [];
  for (const card of allOptionScorecards()) {
    for (const s of card.setups) {
      if (s.score >= OPTION_IDEA_MIN_SCORE) candidates.push({ symbol: card.underlying, strategy: s.strategy, contract: s.contract, score: s.score, reasons: s.reasons });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const top = candidates.slice(0, OPTION_IDEAS);
  let dropped = 0;
  db.transaction(() => {
    place("option", top, iso);
    const present = new Set(top.map((c) => `${c.symbol}|${c.strategy}`));
    const missing = (db.prepare("SELECT id, symbol, strategy, misses FROM ideas WHERE kind = 'option' AND status = 'active'").all() as Array<{ id: number; symbol: string; strategy: string; misses: number }>)
      .filter((r) => !present.has(`${r.symbol}|${r.strategy}`));
    let rank = top.length;
    for (const r of missing) {
      if (r.misses + 1 >= OPTION_MISSES_TO_DROP) {
        db.prepare("UPDATE ideas SET status = 'dropped', misses = misses + 1 WHERE id = ?").run(r.id);
        dropped++;
      } else db.prepare("UPDATE ideas SET misses = misses + 1, rank = ? WHERE id = ?").run(++rank, r.id);
    }
  })();
  return { listed: top.length, dropped };
}
