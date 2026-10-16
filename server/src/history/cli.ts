import "../env.js";
import * as alpaca from "../providers/alpaca.js";
import { historyStatus } from "./store.js";
import { runJob, type JobName } from "./sync.js";

// Usage (from the repo root):
//   npm run history -w server -- universe          refresh the symbol lists
//   npm run history -w server -- daily             daily bars (10 years on first run)
//   npm run history -w server -- minute            minute bars (2 years on first run)
//   npm run history -w server -- all               all of the above, in order
//   npm run history -w server -- status            what is stored so far
// Options: --daily-years N, --minute-years N
// Runs are resumable: stopping and re-running picks up where each symbol left off.

const JOBS = new Set(["universe", "daily", "minute", "all"]);

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
  if (!JOBS.has(command)) {
    console.error(`unknown command "${command}" (use universe, daily, minute, all or status)`);
    process.exit(2);
  }
  if (command !== "universe" && !alpaca.isConfigured()) {
    console.error("Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in .env at the repo root (see .env.example).");
    process.exit(2);
  }
  const result = await runJob(command as JobName, {
    dailyYears: option("--daily-years"),
    minuteYears: option("--minute-years"),
    log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  });
  console.log(`${command}: ${result.status}`);
  if (result.status !== "ok") process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
