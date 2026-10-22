import { db } from "../../db.js";
import { earningsDb } from "../db.js";

// Synthetic data at the real scale, for the timing tests.

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const SECTORS = ["Technology", "Healthcare", "Financial Services", "Energy", "Industrials", "Consumer Cyclical", "Utilities", "Basic Materials"];
export const symbolName = (i: number) => `S${i.toString(36).toUpperCase().padStart(4, "0")}`;
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** One upcoming report per symbol on `reportDate`, with profile, snapshot, scorecard, bars, own stats and recent events. */
export function seedScreenDay(count: number, reportDate: string, withStats = true): void {
  const r = rng(7);
  const prof = db.prepare("INSERT OR REPLACE INTO bulk_profiles (symbol, company_name, sector, industry, market_cap, data, updated_at) VALUES (?,?,?,?,?,'{}','2026-10-21')");
  const up = earningsDb.prepare("INSERT OR REPLACE INTO upcoming (symbol, report_date, time, time_source, t0, r, eps_estimate, revenue_estimate, fmp_confirmed_flag) VALUES (?,?,?,?,?,?,?,?,1)");
  const snap = earningsDb.prepare("INSERT OR REPLACE INTO snapshots (symbol, ts, expiry_kind, report_date, expiry, spot, call_occ, call_strike, call_bid, call_ask, call_iv, call_volume, call_oi, implied_move_pct) VALUES (?,?,'event',?,?,?,?,?,?,?,?,?,?,?)");
  const card = db.prepare("INSERT OR REPLACE INTO scorecards_live (symbol, as_of, composite, groups, factors, coverage, weights_version) VALUES (?,?,?,?,?,?,?)");
  const bar = db.prepare("INSERT OR REPLACE INTO daily_bars (symbol, day, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)");
  const st = earningsDb.prepare("INSERT OR REPLACE INTO stats (scope_key, horizon, time, json, n) VALUES (?,'intraday',?,?,?)");
  const ev = earningsDb.prepare("INSERT OR REPLACE INTO events (symbol, report_date, time, t0, r, eps_actual, eps_estimate, revenue_actual, revenue_estimate, confirmed, check_fmp, reason) VALUES (?,?,'amc',?,?,1.1,1,101,100,1,1,'ok')");
  const sp = earningsDb.prepare("INSERT OR REPLACE INTO stock_paths (symbol, report_date, t0_close, r_close) VALUES (?,?,100,103)");
  const dist = { n: 8, median: 1, mean: 1, p25: -1, p75: 2, winRate: 0.6 };
  const stats = (sym: string | null) =>
    JSON.stringify({ scope: { symbol: sym, sector: null, capBucket: null }, horizon: "intraday", time: "amc", n: 8, nOptions: 6, stock: dist, call: dist, otmCall: null, callBeta: 6, callAlpha: 1, flatDayCall: -5, preDrift: { t0OpenFrom10: dist, rCloseFromPrev: dist }, impliedVsRealized: { medianImplied: 8, medianRealized: 6, ratio: 1.3 }, ivRamp: {}, reactions: { upShare: 0.5, medianAbs: 6, last4: [3, -2, 5, 1] } });
  db.transaction(() => {
    earningsDb.transaction(() => {
      for (let i = 0; i < count; i++) {
        const s = symbolName(i);
        const px = 10 + r() * 400;
        const cap = Math.exp(18 + r() * 8);
        prof.run(s, `Company ${i}`, SECTORS[i % SECTORS.length], `Industry ${i % 40}`, cap);
        up.run(s, reportDate, i % 3 === 0 ? "bmo" : "amc", "fmp", reportDate, addDays(reportDate, 1), 1, 100);
        const spread = 0.02 + r() * 0.3;
        snap.run(s, "2026-10-21T20:00:00Z", reportDate, addDays(reportDate, 1), px, `${s}261023C00100000`, Math.round(px), px * 0.05, px * 0.05 * (1 + spread), 0.6, 20 + Math.floor(r() * 500), 300, 7);
        card.run(s, "2026-10-21", 50, JSON.stringify({ momentum: r() * 100 }), JSON.stringify({ vs_sma50: [r() * 0.3 - 0.1, 50, 0], vs_sma200: [r() * 0.5 - 0.2, 50, 0], rsi14: [20 + r() * 70, 50, 0] }), 1, "stock-v2");
        for (let d = 0; d < 30; d++) {
          const close = px * (1 + (r() - 0.5) * 0.03);
          bar.run(s, addDays("2026-09-20", d), close, close * 1.02, close * 0.98, close, 1e6);
        }
        if (withStats) {
          st.run(symKey(s), "amc", stats(s), 8);
          st.run(symKey(s), "any", stats(s), 8);
        }
        for (let q = 1; q <= 4; q++) {
          const d = addDays(reportDate, -90 * q);
          ev.run(s, d, d, addDays(d, 1));
          sp.run(s, d);
        }
      }
      for (const key of ["all", ...SECTORS.flatMap((x) => ["micro", "small", "mid", "large", "mega"].map((c) => `pool:${x}:${c}`)), ...["micro", "small", "mid", "large", "mega"].map((c) => `cap:${c}`)]) {
        st.run(key, "amc", stats(null), 500);
        st.run(key, "any", stats(null), 500);
      }
    })();
  })();
}
const symKey = (s: string) => `sym:${s}`;

/** `count` confirmed events spread over `symbols` names; about `optionShare` of them with option legs on all three entries. */
export function seedEvents(count: number, symbols: number, optionShare: number): void {
  const r = rng(11);
  const prof = db.prepare("INSERT OR REPLACE INTO bulk_profiles (symbol, company_name, sector, industry, market_cap, data, updated_at) VALUES (?,?,?,?,?,'{}','2026-10-21')");
  const ev = earningsDb.prepare("INSERT OR REPLACE INTO events (symbol, report_date, time, t0, r, confirmed, check_fmp, reason) VALUES (?,?,?,?,?,1,1,'ok')");
  const sp = earningsDb.prepare("INSERT OR REPLACE INTO stock_paths (symbol, report_date, t0_m20, t0_m10, t0_m5, t0_m2, t0_m1, t0_open, t0_1000, t0_1545, t0_close, r_open, r_close, prev_close) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const op = earningsDb.prepare("INSERT OR REPLACE INTO option_paths (symbol, report_date, entry, expiry_kind, leg, contract, expiry, strike, spot_at_entry, prices, price_source) VALUES (?,?,?,'event',?,?,?,?,?,?,'trade')");
  const per = Math.ceil(count / symbols);
  const times = ["bmo", "amc", "dmh"];
  db.transaction(() => {
    for (let i = 0; i < symbols; i++) prof.run(symbolName(i), `Company ${i}`, SECTORS[i % SECTORS.length], "I", Math.exp(18 + r() * 8));
  })();
  earningsDb.transaction(() => {
    let n = 0;
    for (let i = 0; i < symbols && n < count; i++) {
      const s = symbolName(i);
      for (let q = 0; q < per && n < count; q++, n++) {
        // Weekday report dates going back from 2026-09-30, one quarter apart.
        const t0 = addDays("2026-09-30", -91 * q - (i % 5));
        const d = new Date(t0 + "T00:00:00Z").getUTCDay();
        const t0w = d === 0 ? addDays(t0, -2) : d === 6 ? addDays(t0, -1) : t0;
        const rd = addDays(t0w, 1);
        const base = 20 + r() * 200;
        const move = (r() - 0.5) * 0.06;
        ev.run(s, t0w, times[(i + q) % 3], t0w, rd);
        sp.run(s, t0w, base * 0.9, base * 0.92, base * 0.95, base * 0.98, base * 0.99, base, base * (1 + move / 3), base * (1 + move), base * (1 + move * 0.9), base * 1.01, base * (1 + (r() - 0.5) * 0.2), base * 0.99);
        if (r() < optionShare) {
          const exp = addDays(rd, 3);
          for (const [entry, spot] of [["T0:10:00", base * (1 + move / 3)], ["T0-5", base * 0.95], ["T0-20", base * 0.9]] as const) {
            const o1 = spot * 0.04;
            for (const leg of ["atm_call", "otm_call"]) {
              op.run(s, t0w, entry, leg, `${s}C`, exp, Math.round(spot), spot, JSON.stringify({ [entry]: o1, "T0:15:45": o1 * (1 + move * 6), "T0:close": o1 * (1 + move * 6), "R:open": o1 * 0.6, "R:close": o1 * 0.5, "T0:open": o1, "T0-1": o1 * 0.95, "T0-2": o1 * 0.9 }));
            }
          }
        }
      }
    }
  })();
}
