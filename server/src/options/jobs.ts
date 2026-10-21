import { liveEntry } from "../live/feed.js";
import { nyInstant } from "../live/session.js";
import { tradingDay } from "../history/time.js";
import * as alpaca from "../providers/alpaca.js";
import type { OptionMetrics, OptionsDeps } from "../scan/contracts.js";
import { createOpraStream, type OpraStream } from "./opra-stream.js";
import { latestOptionMetrics, pruneOptionBars } from "./store.js";
import { runSweep, type SweepDeps, type SweepResult } from "./sweep.js";
import type { Pair } from "./selection.js";

// Schedules the options data layer: the 5-minute sweep (09:30–16:00 New York,
// weekdays) and the OPRA stream (09:25–16:05, see opra-stream.ts). After each
// sweep the stream is pointed at the new contract selection. Option bars are
// pruned once a day. OPTIONS_SWEEP=0 turns the sweep off, OPTIONS_STREAM=0 the stream.

const SWEEP_EVERY_MS = 5 * 60_000;
const CHECK_EVERY_MS = 15_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;

export type SweepSummary = {
  startedAt: string;
  finishedAt: string;
  underlyings: number;
  requests: number;
  durationMs: number;
  errors: number;
  lastError: string | null;
};

/** Weekdays 09:30–16:00 New York. Holidays run a harmless sweep over stale quotes. */
export function inSweepWindow(nowMs: number): boolean {
  const day = tradingDay(nowMs / 1000);
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && nowMs >= nyInstant(day, 9, 30) && nowMs < nyInstant(day, 16, 0);
}

export type OptionsHandle = {
  status: () => ReturnType<typeof statusOf>;
  latestOptionMetrics: (symbols: string[]) => Map<string, OptionMetrics>;
  stream: OpraStream;
  /** Run a sweep now (also used by tests); skipped when one is already running. */
  sweepNow: () => Promise<SweepResult | null>;
  stop: () => void;
};

let current: OptionsHandle | null = null;
/** The running handle, for the route; null before startOptionsJobs. */
export const optionsHandle = (): OptionsHandle | null => current;

function statusOf(stream: OpraStream, enabled: boolean, lastSweep: SweepSummary | null, sweeping: boolean) {
  const s = stream.status();
  return {
    ...s,
    // The sweep's error shows when the stream has none, so one field tells the widget something is wrong.
    lastError: s.lastError ?? lastSweep?.lastError ?? null,
    sweepEnabled: enabled,
    sweeping,
    lastSweep,
  };
}

export function startOptionsJobs(deps: OptionsDeps, overrides: Partial<SweepDeps> = {}): OptionsHandle {
  if (current) return current;
  const lastPrices = new Map<string, number>();
  let previous = new Map<string, Pair>();
  let lastSweep: SweepSummary | null = null;
  let sweeping = false;
  let lastStart = 0;
  let lastPrune = 0;
  let warnedHeld = false;
  const sweepEnabled = process.env.OPTIONS_SWEEP !== "0" && alpaca.isConfigured();

  const stream = createOpraStream({
    // The live tape's price when it has one, else the sweep's.
    spot: (u) => liveEntry(u)?.price ?? lastPrices.get(u) ?? null,
  });

  async function sweepNow(): Promise<SweepResult | null> {
    if (sweeping) return null; // a slow sweep skips the next tick
    sweeping = true;
    lastStart = Date.now();
    try {
      const result = await runSweep({
        underlyings: deps.underlyings,
        holdings: deps.optionHoldings,
        previous: () => previous,
        live: (occ) => {
          const q = stream.quote(occ);
          return q ? { bid: q.bid, ask: q.ask, delta: q.delta, at: q.quoteAt } : null;
        },
        ...overrides,
      });
      for (const [u, p] of result.prices) lastPrices.set(u, p);
      previous = result.selection.pairs;
      stream.setTargets(result.selection.contracts);
      if (result.selection.heldDropped > 0 && !warnedHeld) {
        warnedHeld = true;
        console.warn(`[options] held options exceed OPTIONS_STREAM_MAX; ${result.selection.heldDropped} are not streamed`);
      }
      lastSweep = {
        startedAt: result.startedAt,
        finishedAt: new Date().toISOString(),
        underlyings: result.underlyings,
        requests: result.requests,
        durationMs: result.durationMs,
        errors: result.errors.length,
        lastError: result.errors[0] ? `${result.errors[0].symbol}: ${result.errors[0].message}` : null,
      };
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[options] sweep failed:", message);
      lastSweep = { startedAt: new Date(lastStart).toISOString(), finishedAt: new Date().toISOString(), underlyings: 0, requests: 0, durationMs: Date.now() - lastStart, errors: 1, lastError: message };
      return null;
    } finally {
      sweeping = false;
    }
  }

  const tick = () => {
    const now = Date.now();
    if (now - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = now;
      try {
        const removed = pruneOptionBars(now);
        if (removed > 0) console.log(`[options] pruned ${removed} option minute bars`);
      } catch (err) {
        console.error("[options] prune failed:", err);
      }
    }
    // Sweeps start a little early so the 5-minute cadence doesn't drift by a tick.
    if (sweepEnabled && inSweepWindow(now) && now - lastStart >= SWEEP_EVERY_MS - CHECK_EVERY_MS) void sweepNow();
  };

  const timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();
  stream.start();
  tick();
  if (sweepEnabled) console.log("[options] sweep enabled (every 5 minutes, 09:30–16:00 New York, weekdays)");

  current = {
    status: () => statusOf(stream, sweepEnabled, lastSweep, sweeping),
    latestOptionMetrics,
    stream,
    sweepNow,
    stop: () => {
      clearInterval(timer);
      stream.stop();
      current = null;
    },
  };
  return current;
}
