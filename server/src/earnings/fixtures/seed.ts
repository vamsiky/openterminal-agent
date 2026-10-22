import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { earningsDb } from "../db.js";
import { db } from "../../db.js";

// Test seeding from the commander's ad-hoc analysis for 2026-10-22 (bt.json = past report-day prices, now.json = live
// features and chains). The tests call the real stats and score code on these rows.

export type AdhocName = {
  events: Array<{ date: string; prevClose: number; open: number; close: number; nextClose: number | null; s10: number | null; s1545: number | null; call: null | { occ: string; expiry: string; strike: number; o10: number; o1545: number } }>;
  px: number; vs20: number; vs50: number; vs200: number; rsi: number; atrPct: number; momentum: number;
  contract: { expiry: string; strike: number; bid: number; ask: number; vol: number; delta: number; iv: number; occ: string };
  chains: Array<{ expiry: string; strike: number; occ: string; bid: number; ask: number; iv: number; dayVol: number; otm: null | { occ: string; strike: number; bid: number; ask: number; iv: number; delta: number; vol: number } }>;
  beats: number;
  analyst: Array<{ date: string; firm: string; action: string; pt: number; prior: number }>;
  expected: { A: number; B: number; C: number; D: number; E: number; total: number; gate: boolean };
};

export const adhoc: Record<string, AdhocName> = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "adhoc-2026-10-22.json"), "utf8"));
export const NOW = new Date("2026-10-21T21:00:00Z");

const nextDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);

export function seedAdhoc(): void {
  const ev = earningsDb.prepare("INSERT OR REPLACE INTO events (symbol, report_date, time, time_source, t0, r, eps_actual, eps_estimate, revenue_actual, revenue_estimate, confirmed, check_fmp, reason) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,'ok')");
  const sp = earningsDb.prepare("INSERT OR REPLACE INTO stock_paths (symbol, report_date, t0_open, t0_1000, t0_1545, t0_close, r_close, prev_close) VALUES (?,?,?,?,?,?,?,?)");
  const op = earningsDb.prepare("INSERT OR REPLACE INTO option_paths (symbol, report_date, entry, expiry_kind, leg, contract, expiry, strike, spot_at_entry, prices, price_source) VALUES (?,?,'T0:10:00','event','atm_call',?,?,?,?,?,'trade')");
  const up = earningsDb.prepare("INSERT OR REPLACE INTO upcoming (symbol, report_date, time, time_source, t0, r, fiscal_period, eps_estimate, revenue_estimate, fmp_confirmed_flag) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const snap = earningsDb.prepare("INSERT OR REPLACE INTO snapshots (symbol, ts, expiry_kind, report_date, expiry, spot, call_occ, call_strike, call_bid, call_ask, call_iv, call_volume, call_oi, otm_occ, otm_strike, otm_bid, otm_ask, otm_iv, otm_volume, otm_oi, otm_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const an = earningsDb.prepare("INSERT OR REPLACE INTO analyst_actions (symbol, date, firm, action, price_target, prior_price_target) VALUES (?,?,?,?,?,?)");
  const card = db.prepare("INSERT OR REPLACE INTO scorecards_live (symbol, as_of, composite, groups, factors, coverage, weights_version) VALUES (?,?,?,?,?,?,?)");
  const bar = db.prepare("INSERT OR REPLACE INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)");
  earningsDb.transaction(() => {
    for (const [s, n] of Object.entries(adhoc)) {
      n.events.forEach((e, i) => {
        // The newest event carries last quarter's beat flags.
        const last = i === n.events.length - 1;
        const beatEps = last ? (n.beats >= 1 ? 1.1 : 1.0) : 1;
        const beatRev = last ? (n.beats >= 2 ? 101 : 99) : 100;
        ev.run(s, e.date, "amc", "fmp", e.date, nextDay(e.date), beatEps, 1.0, beatRev, 100);
        sp.run(s, e.date, e.open, e.s10, e.s1545, e.close, e.nextClose, e.prevClose);
        if (e.call) op.run(s, e.date, e.call.occ, e.call.expiry, e.call.strike, e.s10 ?? e.open, JSON.stringify({ "T0:10:00": e.call.o10, "T0:15:45": e.call.o1545 }));
      });
      up.run(s, "2026-10-22", "amc", "fmp", "2026-10-22", "2026-10-23", "Q3", 1, 100, 1);
      // The snapshot holds the first strike at or above spot and the next one up, as the live chain does.
      const ch = n.chains[0];
      const o = ch.otm;
      snap.run(s, "2026-10-21T20:00:00Z", "event", "2026-10-22", ch.expiry, n.px, ch.occ, ch.strike, ch.bid, ch.ask, ch.iv, ch.dayVol, 100, o?.occ ?? null, o?.strike ?? null, o?.bid ?? null, o?.ask ?? null, o?.iv ?? null, o?.vol ?? null, o ? 100 : null, o?.delta ?? null);
      for (const a of n.analyst) an.run(s, a.date, a.firm, a.action, a.pt, a.prior);
      card.run(s, "2026-10-21", 60, JSON.stringify({ momentum: n.momentum }), JSON.stringify({ vs_sma50: [n.vs50 / 100, 50, 0], vs_sma200: [n.vs200 / 100, 50, 0], rsi14: [n.rsi, 50, 0] }), 1, "stock-v2");
      // 40 days of bars: flat at B with the last close at px reproduces vs20; the daily range reproduces ATR.
      const sma20 = n.px / (1 + n.vs20 / 100);
      const base = (20 * sma20 - n.px) / 19;
      for (let d = 0; d < 40; d++) {
        const day = new Date(Date.parse("2026-09-11T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10);
        const close = d === 39 ? n.px : base;
        bar.run(s, day, close, close * (1 + n.atrPct / 200), close * (1 - n.atrPct / 200), close, 1e6);
      }
    }
  })();
}
