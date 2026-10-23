import { db } from "../db.js";
import { calendarFor } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import type { Idea, IdeaKind, OptionStrategy, Scorecard } from "../scan/contracts.js";
import { allOptionScorecards } from "./option-score.js";
import type { OptionScorecard } from "../scan/contracts.js";
import { GROUP_LABELS, factorLabel, getLiveScorecard, isMarketWide, topNightly } from "./stock-score.js";
import { getActive } from "../scandef/store.js";
import { screenStocks, type StockCandidate } from "../scandef/stock-engine.js";
import type { OptionListing } from "../scandef/schema.js";

// Ideas: what the Ideas widget lists. Stock ideas are the universe's best
// composites, screened nightly and re-scored every 15 minutes. Option ideas
// are setups scoring above the listing bar, refreshed every 5 minutes. A row
// keeps its first_seen while it stays; it is marked dropped (never deleted)
// when it falls out, so the widget can show what just left. The listing rules
// (bars, sizes, misses, near misses) come from the active stock and option
// definitions; scandef/builtins.ts holds today's numbers.

/** The early-IV reason for a listing; option-v1 gives "IV history < 20 days: ...". */
export const earlyIvReason = (days: number) => `IV history < ${days} days: IV judged against 20-day realised volatility`;
export const EARLY_IV_REASON = earlyIvReason(20);

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
CREATE TABLE IF NOT EXISTS idea_near_misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  contract TEXT,
  score REAL NOT NULL,
  rank INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  as_of TEXT NOT NULL,
  definition TEXT
);
`);
if (!(db.prepare("PRAGMA table_info(ideas)").all() as Array<{ name: string }>).some((c) => c.name === "definition")) db.exec("ALTER TABLE ideas ADD COLUMN definition TEXT");

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
  definition: string | null;
};

const toIdea = (r: Row): Idea => ({
  id: r.id, kind: r.kind, symbol: r.symbol, strategy: r.strategy, contract: r.contract, score: r.score, rank: r.rank,
  reasons: JSON.parse(r.reasons), firstSeen: r.first_seen, lastSeen: r.last_seen, status: r.status, definition: r.definition ?? null,
});

export function listIdeas(opts: { kind?: IdeaKind; status?: "active" | "dropped" | "near"; limit?: number } = {}): Idea[] {
  if (opts.status === "near") return listNearMisses(opts.kind, opts.limit);
  const where: string[] = ["status = ?"];
  const args: Array<string | number> = [opts.status ?? "active"];
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  args.push(opts.limit ?? getActive("stock").definition.listing.top);
  const order = (opts.status ?? "active") === "active" ? "rank, id" : "last_seen DESC, id DESC";
  return (db.prepare(`SELECT * FROM ideas WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`).all(...args) as Row[]).map(toIdea);
}

/** The latest option pass's near misses (setups scoring in the near-miss band that were not listed), best first. */
export function listNearMisses(kind: IdeaKind = "option", limit = 100): Idea[] {
  const rows = db.prepare("SELECT * FROM idea_near_misses WHERE kind = ? ORDER BY rank, id LIMIT ?").all(kind, limit) as Array<{
    id: number; kind: IdeaKind; symbol: string; strategy: Idea["strategy"]; contract: string | null; score: number; rank: number; reasons: string; as_of: string; definition: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id, kind: r.kind, symbol: r.symbol, strategy: r.strategy, contract: r.contract, score: r.score, rank: r.rank,
    reasons: JSON.parse(r.reasons), firstSeen: r.as_of, lastSeen: r.as_of, status: "near" as const, definition: r.definition,
  }));
}

/** When the ideas were last touched, or null before the first screen. */
export function ideasAsOf(kind?: IdeaKind): string | null {
  const r = (kind
    ? db.prepare("SELECT MAX(last_seen) AS t FROM ideas WHERE kind = ?").get(kind)
    : db.prepare("SELECT MAX(last_seen) AS t FROM ideas").get()) as { t: string | null };
  return r.t;
}

/** "momentum 92/100; best: 6-month return, 98/100 against sector peers" for the three strongest groups. */
export function stockReasons(card: Scorecard, today: string): string[] {
  const groups = Object.entries(card.groups)
    .filter((g): g is [string, number] => g[1] !== null)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const reasons = groups.map(([g, score]) => {
    const best = card.factors.filter((f) => f.group === g && f.score !== null).sort((a, b) => b.score! - a.score!)[0];
    const ordinal = best ? `; best: ${factorLabel(best.key)}, ${Math.round(best.score!)}/100 ${isMarketWide(best.key) ? "against the whole market" : "against sector peers"}` : "";
    return `${GROUP_LABELS[g] ?? g} ${Math.round(score)}/100${ordinal}`;
  });
  const next = calendarFor([card.symbol], today)[0]?.nextEarningsDate;
  if (next) {
    const date = new Date(next * 1000).toISOString().slice(0, 10);
    const days = Math.round((next * 1000 - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (days >= 0 && days < getActive("stock").definition.listing.earningsFlagDays) reasons.push(`reports earnings on ${date} (in ${days} day${days === 1 ? "" : "s"})`);
  }
  return reasons;
}

type Candidate = { symbol: string; strategy: "buy" | OptionStrategy; contract: string | null; score: number; reasons: string[] };

const upsert = db.prepare(
  `INSERT INTO ideas (kind, symbol, strategy, contract, score, rank, reasons, first_seen, last_seen, status, misses, definition)
   VALUES (@kind, @symbol, @strategy, @contract, @score, @rank, @reasons, @now, @now, 'active', 0, @definition)
   ON CONFLICT (kind, symbol, strategy) DO UPDATE SET
     contract = excluded.contract, score = excluded.score, rank = excluded.rank, reasons = excluded.reasons, last_seen = excluded.last_seen,
     definition = excluded.definition,
     misses = 0,
     first_seen = CASE WHEN ideas.status = 'dropped' THEN excluded.first_seen ELSE ideas.first_seen END,
     status = 'active'`
);

function place(kind: IdeaKind, ranked: Candidate[], now: string, definition: string): void {
  ranked.forEach((c, i) => upsert.run({ kind, symbol: c.symbol, strategy: c.strategy, contract: c.contract, score: Math.round(c.score * 10) / 10, rank: i + 1, reasons: JSON.stringify(c.reasons), now, definition }));
}

/**
 * One listing per company among cards in composite order: GOOG and GOOGL share
 * a CIK (or company name), and the one with the higher dollar volume stays.
 */
export function onePerCompany<T extends { symbol: string }>(cards: T[]): T[] {
  if (cards.length === 0) return cards;
  const rows = db
    .prepare(
      `SELECT symbol, COALESCE(json_extract(data, '$.cik'), lower(company_name), symbol) AS company, COALESCE(price * average_volume, 0) AS dollars
       FROM bulk_profiles WHERE symbol IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify(cards.map((c) => c.symbol))) as Array<{ symbol: string; company: string; dollars: number }>;
  const info = new Map(rows.map((r) => [r.symbol, r]));
  const best = new Map<string, { symbol: string; dollars: number }>();
  for (const c of cards) {
    const i = info.get(c.symbol);
    const key = i?.company ?? c.symbol;
    const cur = best.get(key);
    if (!cur || (i?.dollars ?? 0) > cur.dollars) best.set(key, { symbol: c.symbol, dollars: i?.dollars ?? 0 });
  }
  const keep = new Set([...best.values()].map((b) => b.symbol));
  return cards.filter((c) => keep.has(c.symbol));
}

/** Candidates for the screen's filters: the cards with the price and days to earnings the catalog offers. */
function candidatesFor(cards: Scorecard[], today: string): StockCandidate[] {
  if (cards.length === 0) return [];
  const symbols = JSON.stringify(cards.map((c) => c.symbol));
  const prices = new Map((db.prepare("SELECT symbol, price FROM bulk_profiles WHERE symbol IN (SELECT value FROM json_each(?))").all(symbols) as Array<{ symbol: string; price: number | null }>).map((r) => [r.symbol, r.price]));
  const next = new Map(calendarFor(cards.map((c) => c.symbol), today).map((e) => [e.symbol, e.nextEarningsDate]));
  const base = Date.parse(`${today}T00:00:00Z`);
  return cards.map((card) => {
    const n = next.get(card.symbol);
    return { card, price: prices.get(card.symbol) ?? null, nextEarningsDays: n ? Math.round((n * 1000 - base) / 86_400_000) : null };
  });
}

/**
 * The stock screen: the top composites among `universe` with enough data (and passing the active definition's
 * filters) become (or stay) active; active stock ideas outside them are dropped.
 */
export function runStockScreen(universe: string[], now = new Date()): { listed: number; dropped: number } {
  const today = nyClock(now).date;
  const iso = now.toISOString();
  const def = getActive("stock");
  const { top, minCoverage } = def.definition.listing;
  // Extra candidates, so removing a second share class still leaves `top`. Filters need every card.
  const cards = topNightly(universe, minCoverage, def.definition.filters.length > 0 ? Number.MAX_SAFE_INTEGER : top * 3);
  const dedupe = (cs: StockCandidate[]) => {
    const keep = new Set(onePerCompany(cs.map((c) => c.card)).map((c) => c.symbol));
    return cs.filter((c) => keep.has(c.card.symbol));
  };
  const picked = screenStocks(def.definition, candidatesFor(cards, today), dedupe).picked.map((c) => c.card);
  let dropped = 0;
  db.transaction(() => {
    place("stock", picked.map((c) => ({ symbol: c.symbol, strategy: "buy", contract: null, score: c.composite!, reasons: stockReasons(c, today) })), iso, def.version);
    const keep = JSON.stringify(picked.map((c) => c.symbol));
    dropped = db
      .prepare("UPDATE ideas SET status = 'dropped' WHERE kind = 'stock' AND status = 'active' AND symbol NOT IN (SELECT value FROM json_each(?))")
      .run(keep).changes;
  })();
  return { listed: picked.length, dropped };
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
  db.transaction(() => place("stock", updated, iso, getActive("stock").version))();
  return updated.length;
}

export type OptionCandidate = { symbol: string; strategy: OptionStrategy; contract: string | null; score: number; reasons: string[] };
export type OptionListingResult = {
  /** The best candidates scoring above the bar, best first, capped at maxIdeas. */
  top: OptionCandidate[];
  /** Setups at or above `nearMissFrom` that did not make the list, best first. Empty when nearMissFrom is null. */
  nearMisses: OptionCandidate[];
};

/**
 * Which setups the option pass lists, under a definition's listing rules (pure: no database). A setup is a
 * candidate at its bar (the early bar while IV history is short); names are ordered by score, then symbol.
 */
export function listOptionCandidates(cards: Array<Pick<OptionScorecard, "underlying" | "metrics" | "setups">>, listing: OptionListing): OptionListingResult {
  const candidates: OptionCandidate[] = [];
  const misses: OptionCandidate[] = [];
  for (const card of cards) {
    const early = (card.metrics?.ivHistoryDays ?? 0) < listing.early.ivHistoryDaysBelow;
    const bar = early ? listing.early.minScore : listing.minScore;
    for (const s of card.setups) {
      const c = { symbol: card.underlying, strategy: s.strategy, contract: s.contract, score: s.score, reasons: early ? [...s.reasons, earlyIvReason(listing.early.ivHistoryDaysBelow)] : s.reasons };
      if (s.score >= bar) candidates.push(c);
      else if (listing.nearMissFrom !== null && s.score >= listing.nearMissFrom) misses.push(c);
    }
  }
  const order = (a: OptionCandidate, b: OptionCandidate) => b.score - a.score || a.symbol.localeCompare(b.symbol);
  candidates.sort(order);
  const top = candidates.slice(0, listing.maxIdeas);
  if (listing.nearMissFrom !== null) misses.push(...candidates.slice(listing.maxIdeas));
  misses.sort(order);
  return { top, nearMisses: listing.nearMissFrom === null ? [] : misses };
}

/**
 * The 5-minute option pass: the best setups above the active definition's listing bar (top maxIdeas, one per
 * symbol and strategy) are active; one that is missing from `missesToDrop` scans in a row is dropped. Setups in
 * the near-miss band are kept as the latest pass's near misses (they never become ideas).
 */
export function updateOptionIdeas(now = new Date()): { listed: number; dropped: number } {
  const iso = now.toISOString();
  const def = getActive("option");
  const listing = def.definition.listing;
  const { top, nearMisses } = listOptionCandidates(allOptionScorecards(), listing);
  let dropped = 0;
  db.transaction(() => {
    place("option", top, iso, def.version);
    const present = new Set(top.map((c) => `${c.symbol}|${c.strategy}`));
    const missing = (db.prepare("SELECT id, symbol, strategy, misses FROM ideas WHERE kind = 'option' AND status = 'active'").all() as Array<{ id: number; symbol: string; strategy: string; misses: number }>)
      .filter((r) => !present.has(`${r.symbol}|${r.strategy}`));
    let rank = top.length;
    for (const r of missing) {
      if (r.misses + 1 >= listing.missesToDrop) {
        db.prepare("UPDATE ideas SET status = 'dropped', misses = misses + 1 WHERE id = ?").run(r.id);
        dropped++;
      } else db.prepare("UPDATE ideas SET misses = misses + 1, rank = ? WHERE id = ?").run(++rank, r.id);
    }
    // Names still listed as ideas (kept through a miss) are not near misses.
    const listed = new Set(
      (db.prepare("SELECT symbol, strategy FROM ideas WHERE kind = 'option' AND status = 'active'").all() as Array<{ symbol: string; strategy: string }>).map((r) => `${r.symbol}|${r.strategy}`)
    );
    db.prepare("DELETE FROM idea_near_misses WHERE kind = 'option'").run();
    const put = db.prepare("INSERT INTO idea_near_misses (kind, symbol, strategy, contract, score, rank, reasons, as_of, definition) VALUES ('option', ?, ?, ?, ?, ?, ?, ?, ?)");
    nearMisses.filter((c) => !listed.has(`${c.symbol}|${c.strategy}`)).forEach((c, i) => put.run(c.symbol, c.strategy, c.contract, c.score, i + 1, JSON.stringify(c.reasons), iso, def.version));
  })();
  return { listed: top.length, dropped };
}
