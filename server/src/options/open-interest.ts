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
const RETRY_AFTER_FAIL_MS = 30 * 60_000;
let failedAt = 0;

export type ContractRow = { symbol?: string; open_interest?: string | number | null };

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
  const todo = underlyings.filter((u) => !done.has(u));
  if (todo.length > 0 && nowMs - failedAt >= RETRY_AFTER_FAIL_MS) {
    try {
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const counts = new Map<string, number>(batch.map((u) => [u, 0]));
        let pageToken: string | undefined;
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
          for (const r of rows) if (r.underlying_symbol && counts.has(r.underlying_symbol)) counts.set(r.underlying_symbol, counts.get(r.underlying_symbol)! + 1);
          pageToken = data?.next_page_token ?? undefined;
          if (!pageToken) break;
        }
        const mark = db.prepare("INSERT OR REPLACE INTO option_open_interest_fetched (underlying, day, contracts) VALUES (?, ?, ?)");
        db.transaction(() => {
          for (const [u, n] of counts) mark.run(u, day, n);
        })();
      }
      db.prepare("DELETE FROM option_open_interest WHERE day < date(?, '-7 days')").run(day);
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
