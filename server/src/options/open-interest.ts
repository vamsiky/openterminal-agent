import { db } from "../db.js";
import { tradingFetch } from "../providers/alpaca-trading.js";

// Open interest per option contract, from Alpaca's contract reference data
// (the market-data host has none). OI is published once a day, so each
// underlying is fetched once per trading day, on the first sweep, 50
// underlyings to a request, and cached in option_open_interest.

db.exec(`
CREATE TABLE IF NOT EXISTS option_open_interest (
  occ TEXT NOT NULL,
  day TEXT NOT NULL,
  open_interest INTEGER NOT NULL,
  PRIMARY KEY (occ, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS option_rejected_symbols (
  symbol TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (symbol, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS option_open_interest_fetched (
  underlying TEXT NOT NULL,
  day TEXT NOT NULL,
  contracts INTEGER NOT NULL,
  PRIMARY KEY (underlying, day)
) WITHOUT ROWID;
`);

const BATCH = 50;
const PAGE_LIMIT = 10_000;
const MAX_PAGES = 20;
const MAX_SPLIT_DEPTH = 6; // 50 -> 1 in at most log2(50) halvings
const RETRY_AFTER_FAIL_MS = 30 * 60_000;
let failedAt = 0;

export type ContractRow = { symbol?: string; open_interest?: string | number | null };

/** Underlyings Alpaca rejected as invalid on `day` (e.g. crypto tickers); skipped by the OI fetch and the sweep. */
export function rejectedFor(day: string): Set<string> {
  return new Set((db.prepare("SELECT symbol FROM option_rejected_symbols WHERE day = ?").all(day) as Array<{ symbol: string }>).map((r) => r.symbol));
}

function reject(day: string, symbols: string[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO option_rejected_symbols (symbol, day) VALUES (?, ?)");
  db.transaction(() => {
    for (const s of symbols) insert.run(s, day);
  })();
}

/** Symbols a 422 names, from "invalid underlying symbols: DOGE, XYZ"; empty when it names none. */
export function invalidSymbols(message: string): string[] {
  const m = message.match(/invalid underlying symbols?:?\s*([A-Za-z0-9.,\s-]+)/i);
  return m ? m[1].split(/[\s,]+/).filter((s) => /^[A-Za-z0-9.-]+$/.test(s)).map((s) => s.toUpperCase()) : [];
}

/** Store OI rows for a day; contracts without open interest are skipped. */
export function saveOpenInterest(day: string, rows: ContractRow[]): number {
  const insert = db.prepare("INSERT OR REPLACE INTO option_open_interest (occ, day, open_interest) VALUES (?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const oi = r.open_interest === null || r.open_interest === undefined ? NaN : Number(r.open_interest);
      if (r.symbol && Number.isFinite(oi)) {
        insert.run(r.symbol, day, Math.round(oi));
        n++;
      }
    }
  })();
  return n;
}

/** Today's open interest by OCC symbol. */
export function openInterestFor(day: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.prepare("SELECT occ, open_interest AS oi FROM option_open_interest WHERE day = ?").all(day) as Array<{ occ: string; oi: number }>) {
    out.set(r.occ, r.oi);
  }
  return out;
}

const fetchedToday = (day: string): Set<string> =>
  new Set((db.prepare("SELECT underlying FROM option_open_interest_fetched WHERE day = ?").all(day) as Array<{ underlying: string }>).map((r) => r.underlying));

/**
 * Fetch open interest for the underlyings not yet fetched on `day`, for
 * contracts expiring from `day` through `expiryMax`. Drops rows older than a
 * week. `stats.requests` counts the HTTP requests. Throws on failure (the
 * caller records it); a failure is not retried for 30 minutes.
 */
export async function ensureOpenInterest(
  underlyings: string[],
  day: string,
  expiryMax: string,
  stats: { requests: number },
  nowMs = Date.now(),
  fetcher: typeof tradingFetch = tradingFetch
): Promise<Map<string, number>> {
  const done = fetchedToday(day);
  const bad = rejectedFor(day);
  const todo = underlyings.filter((u) => !done.has(u) && !bad.has(u));

  /**
   * One batch, with its pages. A 422 naming invalid symbols drops them (and
   * remembers them for the day) and retries the rest once; a 422 naming none
   * splits the batch in half, down to single symbols.
   */
  async function fetchBatch(batch: string[], depth: number, counts: Map<string, number>, retried = false): Promise<void> {
    if (batch.length === 0) return;
    const local = new Map<string, number>(batch.map((u) => [u, 0]));
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        stats.requests++;
        const data = await fetcher("/v2/options/contracts", {
          underlying_symbols: batch.join(","),
          expiration_date_gte: day,
          expiration_date_lte: expiryMax,
          limit: String(PAGE_LIMIT),
          page_token: pageToken,
        });
        const rows: Array<ContractRow & { underlying_symbol?: string }> = data?.option_contracts ?? [];
        saveOpenInterest(day, rows);
        for (const r of rows) if (r.underlying_symbol && local.has(r.underlying_symbol)) local.set(r.underlying_symbol, local.get(r.underlying_symbol)! + 1);
        pageToken = data?.next_page_token ?? undefined;
        if (!pageToken) break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes(" 422 ")) throw err;
      const named = invalidSymbols(message).filter((s) => batch.includes(s));
      if (named.length > 0 && !retried) {
        reject(day, named);
        for (const s of named) counts.set(s, 0);
        return fetchBatch(batch.filter((s) => !named.includes(s)), depth, counts, true);
      }
      if (batch.length === 1) {
        reject(day, batch);
        counts.set(batch[0], 0);
        return;
      }
      if (depth >= MAX_SPLIT_DEPTH) throw err;
      const half = Math.ceil(batch.length / 2);
      await fetchBatch(batch.slice(0, half), depth + 1, counts);
      await fetchBatch(batch.slice(half), depth + 1, counts);
      return;
    }
    for (const [u, n] of local) counts.set(u, n);
  }
  if (todo.length > 0 && nowMs - failedAt >= RETRY_AFTER_FAIL_MS) {
    try {
      for (let i = 0; i < todo.length; i += BATCH) {
        const counts = new Map<string, number>();
        await fetchBatch(todo.slice(i, i + BATCH), 0, counts);
        const mark = db.prepare("INSERT OR REPLACE INTO option_open_interest_fetched (underlying, day, contracts) VALUES (?, ?, ?)");
        db.transaction(() => {
          for (const [u, n] of counts) mark.run(u, day, n);
        })();
      }
      db.prepare("DELETE FROM option_open_interest WHERE day < date(?, '-7 days')").run(day);
      db.prepare("DELETE FROM option_rejected_symbols WHERE day < ?").run(day);
      db.prepare("DELETE FROM option_open_interest_fetched WHERE day < date(?, '-7 days')").run(day);
    } catch (err) {
      failedAt = nowMs;
      throw err;
    }
  }
  return openInterestFor(day);
}

/** Test hook. */
export function resetOpenInterestBackoff(): void {
  failedAt = 0;
}
