import "../env.js";
import * as alpaca from "../providers/alpaca.js";
import { historyStatus, listIssues, type IssueKind } from "./store.js";
import { minuteEnabled } from "./scheduler.js";
import { interruptRun, runJob, type JobName } from "./sync.js";

// Usage (from the repo root):
//   npm run history -w server -- universe          refresh the symbol lists
//   npm run history -w server -- daily             daily bars (10 years on first run)
//   npm run history -w server -- minute            minute bars (2 years on first run)
//   npm run history -w server -- all               all of the above, in order
//   npm run history -w server -- status            what is stored so far
//   npm run history -w server -- issues            problems in the latest run, one line per symbol
//        --run N, --symbol AAPL, --kind error|no_bars|skipped narrow the list
// Options: --daily-years N, --minute-years N
// HISTORY_SYNC_MINUTE=0 in .env makes "all" skip the minute bars.
// Runs are resumable: stopping and re-running picks up where each symbol left off.

const JOBS = new Set(["universe", "daily", "minute", "all"]);

function text(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

function option(name: string): number | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a positive number`);
  return n;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  if (command === "status") {
    console.log(JSON.stringify(historyStatus(), null, 2));
    return;
  }
  if (command === "issues") {
    const kind = text("--kind");
    if (kind && !["error", "no_bars", "skipped"].includes(kind)) throw new Error("--kind is error, no_bars or skipped");
    const issues = listIssues({ runId: option("--run"), symbol: text("--symbol")?.toUpperCase(), kind: kind as IssueKind | undefined });
    if (issues.length === 0) console.log("No issues recorded.");
    for (const i of issues) console.log(`${i.at}  run ${i.run_id ?? "-"}  ${i.kind.padEnd(7)}  ${i.job.padEnd(9)}  ${(i.symbol ?? "").padEnd(8)}  ${i.reason}`);
    return;
  }
  if (!JOBS.has(command)) {
    console.error(`unknown command "${command}" (use universe, daily, minute, all, status or issues)`);
    process.exit(2);
  }
  if (command !== "universe" && !alpaca.isConfigured()) {
    console.error("Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in .env at the repo root (see .env.example).");
    process.exit(2);
  }
  // Ctrl-C: record the run as stopped so the next run can start right away.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      interruptRun(`interrupted (${signal})`);
      process.exit(130);
    });
  }
  const result = await runJob(command as JobName, {
    dailyYears: option("--daily-years"),
    minuteYears: option("--minute-years"),
    minute: minuteEnabled(),
    log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  });
  console.log(`${command}: ${result.status}${result.status === "skipped" ? ` (${result.detail})` : ""}`);
  if (result.status === "partial") console.log("Some steps failed (see the error lines above); rerun to retry them.");
  if (result.status !== "ok" && result.status !== "partial") process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
