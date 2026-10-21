import "../env.js";
import { db } from "../db.js";
import { isConfigured } from "../providers/alpaca.js";
import { backfillMany, newBackfillStatus } from "./backfill.js";
import { ivHistoryCount } from "./store.js";

// Usage (from the repo root):
//   npm run backfill-iv -w server                      every watchlist symbol with under 200 IV rows
//   npm run backfill-iv -w server -- --symbols SPY,AAPL   just these (always, even with 200 rows)
// Fills iv_history from Alpaca's historical option bars (about a request per
// 200 contracts); live rows are never overwritten. Safe to re-run.

async function main(): Promise<void> {
  if (!isConfigured()) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set");
  const i = process.argv.indexOf("--symbols");
  const symbols =
    i >= 0
      ? process.argv[i + 1].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
      : (db.prepare("SELECT DISTINCT symbol FROM watchlist_items ORDER BY symbol").all() as Array<{ symbol: string }>)
          .map((r) => r.symbol)
          .filter((s) => ivHistoryCount(s) < 200);
  console.log(`backfilling ${symbols.length} symbols`);
  const status = newBackfillStatus();
  await backfillMany(symbols, {}, status);
  console.log(JSON.stringify(status, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
