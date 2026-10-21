import { db } from "../db.js";
import { fetchTranscript, type Transcript } from "../providers/fmp-content.js";

// Earnings-call transcripts, kept forever once fetched. Rows are keyed by the
// app's symbol (BRK.B) and FMP's fiscal year and quarter. Search uses FTS5
// when this SQLite build has it, else LIKE.

db.exec(`
CREATE TABLE IF NOT EXISTS content_transcripts (
  symbol TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  quarter INTEGER NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, fiscal_year, quarter)
);
CREATE TABLE IF NOT EXISTS content_job_runs (
  day TEXT PRIMARY KEY,
  recent INTEGER NOT NULL,
  backfilled INTEGER NOT NULL,
  fetched INTEGER NOT NULL,
  calls INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_backfill (
  symbol TEXT PRIMARY KEY,
  done_day TEXT NOT NULL
);
`);

let fts = true;
try {
  // `content` is indexed; the rest only rides along. rowid mirrors content_transcripts.
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS content_transcripts_fts USING fts5(content)");
} catch {
  fts = false;
}

export type StoredTranscript = Transcript & { fetchedAt: string };

type Row = { symbol: string; fiscal_year: number; quarter: number; date: string; content: string; fetched_at: string };
const toStored = (r: Row): StoredTranscript => ({
  symbol: r.symbol,
  fiscalYear: r.fiscal_year,
  quarter: r.quarter,
  date: r.date,
  content: r.content,
  fetchedAt: r.fetched_at,
});

export function getStored(symbol: string, fiscalYear: number, quarter: number): StoredTranscript | null {
  const r = db.prepare("SELECT * FROM content_transcripts WHERE symbol = ? AND fiscal_year = ? AND quarter = ?").get(symbol, fiscalYear, quarter) as Row | undefined;
  return r ? toStored(r) : null;
}

/** Newest stored transcript call date for a symbol, or null. */
export function newestStoredDate(symbol: string): string | null {
  const r = db.prepare("SELECT MAX(date) AS d FROM content_transcripts WHERE symbol = ?").get(symbol) as { d: string | null };
  return r.d;
}

export function storedDates(symbol: string): Array<{ fiscalYear: number; quarter: number; date: string }> {
  return db
    .prepare("SELECT fiscal_year AS fiscalYear, quarter, date FROM content_transcripts WHERE symbol = ? ORDER BY date DESC")
    .all(symbol) as Array<{ fiscalYear: number; quarter: number; date: string }>;
}

const store = db.transaction((t: Transcript): StoredTranscript => {
  const old = db.prepare("SELECT rowid FROM content_transcripts WHERE symbol = ? AND fiscal_year = ? AND quarter = ?").get(t.symbol, t.fiscalYear, t.quarter) as { rowid: number } | undefined;
  if (old && fts) db.prepare("DELETE FROM content_transcripts_fts WHERE rowid = ?").run(old.rowid);
  const fetchedAt = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO content_transcripts (symbol, fiscal_year, quarter, date, content, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").run(t.symbol, t.fiscalYear, t.quarter, t.date, t.content, fetchedAt);
  if (fts) {
    const { rowid } = db.prepare("SELECT rowid FROM content_transcripts WHERE symbol = ? AND fiscal_year = ? AND quarter = ?").get(t.symbol, t.fiscalYear, t.quarter) as { rowid: number };
    db.prepare("INSERT INTO content_transcripts_fts (rowid, content) VALUES (?, ?)").run(rowid, t.content);
  }
  return { ...t, fetchedAt };
});

/** The stored transcript, fetched from FMP and stored on first request; null when FMP has none. */
export async function getOrFetch(symbol: string, fiscalYear: number, quarter: number): Promise<StoredTranscript | null> {
  const have = getStored(symbol, fiscalYear, quarter);
  if (have) return have;
  const t = await fetchTranscript(symbol, fiscalYear, quarter);
  return t ? store(t) : null;
}

/** Fetches and stores a transcript the caller already knows is missing; null when FMP has none. */
export async function fetchAndStore(symbol: string, fiscalYear: number, quarter: number, date: string): Promise<StoredTranscript | null> {
  const t = await fetchTranscript(symbol, fiscalYear, quarter);
  return t ? store({ ...t, date: t.date || date }) : null;
}

export type SearchHit = { fiscalYear: number; quarter: number; date: string; snippet: string };

const tokens = (q: string) => q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const SNIPPET_CHARS = 280;

function snippet(content: string, words: string[]): string {
  const lower = content.toLowerCase();
  const at = Math.max(0, lower.indexOf(words[0]));
  const start = Math.max(0, at - SNIPPET_CHARS / 2);
  const end = Math.min(content.length, start + SNIPPET_CHARS);
  return (start > 0 ? "…" : "") + content.slice(start, end).trim() + (end < content.length ? "…" : "");
}

/** Stored transcripts of `symbol` containing every word of `q`, newest first, each with a snippet around the first word. */
export function search(symbol: string, q: string, limit: number): SearchHit[] {
  const words = tokens(q);
  if (words.length === 0) return [];
  const cols = "t.fiscal_year, t.quarter, t.date, t.content";
  const rows = (
    fts
      ? db
          .prepare(
            `SELECT ${cols} FROM content_transcripts t JOIN content_transcripts_fts f ON f.rowid = t.rowid
             WHERE t.symbol = ? AND f.content MATCH ? ORDER BY t.date DESC LIMIT ?`
          )
          .all(symbol, words.map((w) => `"${w}"`).join(" "), limit)
      : db
          .prepare(`SELECT ${cols} FROM content_transcripts t WHERE t.symbol = ? ${words.map(() => "AND lower(t.content) LIKE ?").join(" ")} ORDER BY t.date DESC LIMIT ?`)
          .all(symbol, ...words.map((w) => `%${w}%`), limit)
  ) as Array<{ fiscal_year: number; quarter: number; date: string; content: string }>;
  return rows.map((r) => ({ fiscalYear: r.fiscal_year, quarter: r.quarter, date: r.date, snippet: snippet(r.content, words) }));
}
