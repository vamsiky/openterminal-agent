import "../env.js";
import { pathToFileURL } from "node:url";
import { tradingDay } from "../history/time.js";
import { isConfigured as alpacaConfigured } from "../providers/alpaca.js";
import { isConfigured as fmpConfigured } from "../providers/fmp.js";
import { earningsDb } from "./db.js";
import { backfillOptions } from "./option-paths.js";
import { rebuildStats } from "./stats.js";
import { refreshAnalystActions, refreshUpcoming } from "./upcoming.js";
import { processSymbol, universe, type StoredEvent, type SymbolResult } from "./events.js";
import { ensureCalendarRange } from "./sessions.js";
import { buildStockPaths } from "./stock-paths.js";

// Usage (from the repo root):
//   npm run backfill-earnings -w server -- [--symbols A,B] [--phase events|stock|options|all] [--since 2017-01-01]
// events: FMP per-symbol earnings history, confirmed and stored in earnings.db.
// stock:  anchors from daily_bars plus 15-minute SIP bars (one multi-symbol request per date).
// options: historical option paths (option-paths.ts). After any completed run the pooled stats are rebuilt.
// Resumable: a symbol finished in a phase is recorded in backfill_progress and skipped next
// time (naming symbols with --symbols always redoes them). Safe to re-run: every write is an upsert.
// Request caps: EARNINGS_BACKFILL_ALPACA_PER_MIN (default 2500) and EARNINGS_BACKFILL_FMP_PER_MIN
// (default 1500), so the live sweep keeps headroom under Alpaca's 5,000/min.

export type Phase = "events" | "stock" | "options" | "all";
export const DEFAULT_SINCE = "2017-01-01";
const WORKERS = 12;
const STOCK_CHUNK = 1500; // symbols per stock pass: big enough that most dates batch many names per request

const done = (task: string) => new Set((earningsDb.prepare("SELECT symbol FROM backfill_progress WHERE task = ? AND status = 'done'").all(task) as Array<{ symbol: string }>).map((r) => r.symbol));
const mark = earningsDb.prepare(
  `INSERT INTO backfill_progress (task, symbol, status, detail) VALUES (?, ?, ?, ?)
   ON CONFLICT (task, symbol) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
);

export type PhaseTotals = { symbols: number; skipped: number; errors: number; events: number; confirmed: number; shifted: number; unconfirmed: number; noBars: number; stockPaths: number };
const zero = (): PhaseTotals => ({ symbols: 0, skipped: 0, errors: 0, events: 0, confirmed: 0, shifted: 0, unconfirmed: 0, noBars: 0, stockPaths: 0 });

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

/** Events phase: confirm and store every reported event since `since` for the symbols. Returns the totals and the events that were new. */
export async function runEvents(symbols: string[], opts: { since: string; today: string; force?: boolean }): Promise<{ totals: PhaseTotals; fresh: StoredEvent[] }> {
  const finished = opts.force ? new Set<string>() : done("events");
  const todo = symbols.filter((s) => !finished.has(s));
  const totals = zero();
  totals.skipped = symbols.length - todo.length;
  const fresh: StoredEvent[] = [];
  let next = 0;
  let finishedCount = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(WORKERS, todo.length) }, async () => {
      while (next < todo.length) {
        const symbol = todo[next++];
        try {
          const r: SymbolResult = await processSymbol(symbol, opts);
          totals.events += r.events;
          totals.confirmed += r.confirmed;
          totals.shifted += r.shifted;
          totals.unconfirmed += r.unconfirmed;
          totals.noBars += r.noBars;
          fresh.push(...r.fresh);
          mark.run("events", symbol, "done", JSON.stringify({ events: r.events, confirmed: r.confirmed }));
        } catch (err) {
          totals.errors++;
          mark.run("events", symbol, "error", String(err instanceof Error ? err.message : err).slice(0, 300));
        }
        totals.symbols++;
        finishedCount++;
        if (finishedCount % 100 === 0 || finishedCount === todo.length) {
          const rate = finishedCount / ((Date.now() - started) / 60_000);
          log(`[events] ${finishedCount}/${todo.length} symbols (${totals.skipped} already done) events=${totals.events} confirmed=${totals.confirmed} shifted=${totals.shifted} unconfirmed=${totals.unconfirmed} errors=${totals.errors} ${rate.toFixed(0)}/min`);
        }
      }
    })
  );
  return { totals, fresh };
}

/** Events of the symbols that still need a stock path (none stored, or no R:close yet). */
function pendingStock(symbols: string[]): Array<{ symbol: string; reportDate: string; t0: string; r: string }> {
  const q = earningsDb.prepare(
    `SELECT e.symbol AS symbol, e.report_date AS reportDate, e.t0 AS t0, e.r AS r FROM events e
     LEFT JOIN stock_paths p ON p.symbol = e.symbol AND p.report_date = e.report_date
     WHERE e.symbol = ? AND e.t0 IS NOT NULL AND e.r IS NOT NULL AND (p.symbol IS NULL OR p.r_close IS NULL)`
  );
  return symbols.flatMap((s) => q.all(s) as Array<{ symbol: string; reportDate: string; t0: string; r: string }>);
}

/** Stock phase: stock paths for the symbols' stored events, in passes of up to 1,500 symbols. */
export async function runStock(symbols: string[], opts: { today: string; force?: boolean }): Promise<PhaseTotals> {
  const finished = opts.force ? new Set<string>() : done("stock");
  const todo = symbols.filter((s) => !finished.has(s));
  const totals = zero();
  totals.skipped = symbols.length - todo.length;
  for (let i = 0; i < todo.length; i += STOCK_CHUNK) {
    const chunk = todo.slice(i, i + STOCK_CHUNK);
    const pending = pendingStock(chunk);
    try {
      const r = await buildStockPaths(pending, opts.today);
      totals.stockPaths += r.stored;
      for (const s of chunk) mark.run("stock", s, "done", null);
      totals.symbols += chunk.length;
    } catch (err) {
      totals.errors++;
      for (const s of chunk) mark.run("stock", s, "error", String(err instanceof Error ? err.message : err).slice(0, 300));
      log(`[stock] pass failed: ${err instanceof Error ? err.message : err}`);
    }
    log(`[stock] ${Math.min(i + STOCK_CHUNK, todo.length)}/${todo.length} symbols, ${totals.stockPaths} paths stored (${pending.length} events in this pass)`);
  }
  return totals;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Applies the backfill request caps to the shared providers (they read these variables on every request). */
export function applyCaps(): void {
  process.env.ALPACA_MAX_REQ_PER_MIN = process.env.EARNINGS_BACKFILL_ALPACA_PER_MIN?.trim() || "2500";
  process.env.FMP_MAX_REQ_PER_MIN = process.env.EARNINGS_BACKFILL_FMP_PER_MIN?.trim() || "1500";
}

async function main(): Promise<void> {
  if (!fmpConfigured()) throw new Error("FMP_API_KEY is not set");
  if (!alpacaConfigured()) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set");
  applyCaps();
  const phase = (arg("phase") ?? "all") as Phase;
  if (!["events", "stock", "options", "all"].includes(phase)) throw new Error("--phase must be events, stock, options or all");
  const since = arg("since") ?? DEFAULT_SINCE;
  const explicit = arg("symbols");
  const symbols = explicit ? explicit.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : universe();
  const today = tradingDay(new Date().toISOString());
  const force = Boolean(explicit);
  log(`earnings backfill: phase=${phase} since=${since} symbols=${symbols.length}${explicit ? " (explicit, redone)" : ""} alpaca=${process.env.ALPACA_MAX_REQ_PER_MIN}/min fmp=${process.env.FMP_MAX_REQ_PER_MIN}/min`);
  await ensureCalendarRange(Number(since.slice(0, 4)) - 1, Number(today.slice(0, 4)) + 1);

  if (phase === "events" || phase === "all") {
    const { totals } = await runEvents(symbols, { since, today, force });
    log(`[events] done: ${JSON.stringify(totals)}`);
  }
  if (phase === "stock" || phase === "all") {
    const totals = await runStock(symbols, { today, force });
    log(`[stock] done: ${JSON.stringify(totals)}`);
  }
  if (phase === "options" || phase === "all") {
    const r = await backfillOptions(symbols, { since });
    log(`[options] done: ${JSON.stringify(r)}`);
  }
  if (phase === "all") {
    // A fresh store has no upcoming rows until the first nightly run; fill them now.
    const up = await refreshUpcoming(today);
    const an = await refreshAnalystActions(today);
    log(`[upcoming] ${JSON.stringify(up)} analyst=${JSON.stringify(an)}`);
  }
  const stats = rebuildStats();
  log(`[stats] rebuilt: ${JSON.stringify(stats)}`);
}

// Run only when started as the CLI, not when jobs.ts or a test imports the phases.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
