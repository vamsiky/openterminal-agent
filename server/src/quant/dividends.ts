import { db } from "../db.js";
import { addDays } from "../estimates/store.js";
import { nyClock } from "../history/scheduler.js";
import { appSymbol } from "../providers/fmp-bulk.js";
import { isConfigured } from "../providers/fmp-core.js";
import { dividends } from "../providers/fmp-market.js";

// Upcoming ex-dividend dates from FMP's dividends calendar, fetched once a
// day for the next 60 days. A covered call is exposed to early assignment
// when an ex-date falls before its expiry, so the option scan asks here.

export const DIVIDEND_WINDOW_DAYS = 60;

db.exec(`
CREATE TABLE IF NOT EXISTS dividend_calendar (
  symbol TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  amount REAL,
  fetched_day TEXT NOT NULL,
  PRIMARY KEY (symbol, ex_date)
) WITHOUT ROWID;
`);

const lastFetched = () => (db.prepare("SELECT value FROM scan_settings WHERE key = 'dividends_fetched'").get() as { value: string } | undefined)?.value ?? null;

/** Refreshes the calendar if today's fetch has not happened; returns rows stored, or null when skipped or failed. */
export async function refreshDividends(now = new Date(), fetch: typeof dividends = dividends): Promise<number | null> {
  const today = nyClock(now).date;
  if (lastFetched() === today || (fetch === dividends && !isConfigured())) return null;
  try {
    const rows = await fetch(today, addDays(today, DIVIDEND_WINDOW_DAYS));
    const put = db.prepare(
      "INSERT INTO dividend_calendar (symbol, ex_date, amount, fetched_day) VALUES (?, ?, ?, ?) ON CONFLICT (symbol, ex_date) DO UPDATE SET amount = excluded.amount, fetched_day = excluded.fetched_day"
    );
    let n = 0;
    db.transaction(() => {
      for (const r of rows) {
        const date = typeof r.date === "string" ? r.date.slice(0, 10) : "";
        if (!date) continue;
        put.run(appSymbol(r.symbol), date, typeof r.dividend === "number" ? r.dividend : typeof r.adjDividend === "number" ? r.adjDividend : null, today);
        n++;
      }
      // Dates FMP no longer lists (moved or cancelled) go; past ones are not needed.
      db.prepare("DELETE FROM dividend_calendar WHERE fetched_day < ? OR ex_date < ?").run(today, today);
      db.prepare("INSERT INTO scan_settings (key, value) VALUES ('dividends_fetched', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(today);
    })();
    return n;
  } catch (err) {
    console.error("[scan] dividends calendar failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The next ex-dividend date on or after `today` for each symbol that has one in the window. */
export function nextExDividends(symbols: string[], today: string): Map<string, string> {
  const rows = db
    .prepare("SELECT symbol, MIN(ex_date) AS d FROM dividend_calendar WHERE ex_date >= ? AND symbol IN (SELECT value FROM json_each(?)) GROUP BY symbol")
    .all(today, JSON.stringify(symbols)) as Array<{ symbol: string; d: string }>;
  return new Map(rows.map((r) => [r.symbol, r.d]));
}
