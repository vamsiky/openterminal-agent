import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionContract } from "../providers/alpaca-trading.js";

let tmpDir: string;
let op: typeof import("./option-paths.js");
let trading: typeof import("../providers/alpaca-trading.js");
let bs: typeof import("../options/black-scholes.js");
let edb: typeof import("./db.js");
let nyInstant: typeof import("../live/session.js").nyInstant;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-option-paths-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.ALPACA_API_KEY_ID = "test";
  process.env.ALPACA_API_SECRET_KEY = "test";
  process.env.ALPACA_MAX_REQ_PER_MIN = "1000000";
  op = await import("./option-paths.js");
  trading = await import("../providers/alpaca-trading.js");
  bs = await import("../options/black-scholes.js");
  edb = await import("./db.js");
  ({ nyInstant } = await import("../live/session.js"));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  edb.earningsDb.close();
  const { db } = await import("../db.js");
  const { minuteDb } = await import("../history/store.js");
  db.close();
  minuteDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const bar = (iso: string, c: number, v = 10) => ({ t: iso, o: c, h: c, l: c, c, v });

describe("sessions and anchors", () => {
  it("counts trading days, skipping weekends", () => {
    expect(op.addSessions("2026-07-24", -1)).toBe("2026-07-23");
    expect(op.addSessions("2026-07-20", -1)).toBe("2026-07-17"); // Monday back over the weekend
    expect(op.addSessions("2026-07-23", 5)).toBe("2026-07-30");
  });
  it("maps anchors to days and read kinds", () => {
    expect(op.anchorDay("T0-5", "2026-07-23", "2026-07-24")).toEqual({ day: "2026-07-16", kind: "close" });
    expect(op.anchorDay("T0:10:00", "2026-07-23", "2026-07-24")).toEqual({ day: "2026-07-23", kind: "1000" });
    expect(op.anchorDay("R:open", "2026-07-23", "2026-07-24")).toEqual({ day: "2026-07-24", kind: "open" });
  });
});

describe("expiry kinds", () => {
  const exps = ["2026-07-23", "2026-07-24", "2026-07-31", "2026-08-14", "2026-08-21"];
  it("event is the first expiry on or after R, swing the first at least 21 days after R", () => {
    expect(op.pickExpiries(exps, "2026-07-24")).toEqual({ event: "2026-07-24", swing: "2026-08-14" });
    expect(op.pickExpiries(exps, "2026-07-25")).toEqual({ event: "2026-07-31", swing: "2026-08-21" });
    expect(op.pickExpiries(["2026-07-31"], "2026-07-25").swing).toBeNull();
  });
});

describe("leg selection", () => {
  const strikes = [95, 97.5, 100, 102.5, 105];
  const all = () => true;
  it("ATM is the nearest strike, OTM the next above the ATM call", () => {
    expect(op.selectStrike(strikes, 101.1, "atm_call", all)).toBe(100);
    expect(op.selectStrike(strikes, 101.4, "atm_put", all)).toBe(102.5);
    expect(op.selectStrike(strikes, 101.1, "otm_call", all, 100)).toBe(102.5);
    expect(op.selectStrike(strikes, 101.1, "otm_call", all)).toBeNull();
  });
  it("breaks a tie toward the lower strike and skips strikes that did not trade", () => {
    expect(op.selectStrike(strikes, 101.25, "atm_call", all)).toBe(100);
    expect(op.selectStrike(strikes, 100.2, "atm_call", (s) => s !== 100)).toBe(102.5);
    expect(op.selectStrike(strikes, 100.2, "atm_call", (s) => s === 95)).toBeNull(); // 95 is only 5th nearest
  });
});

describe("intraday prices with sparse bars", () => {
  const day = "2026-07-23";
  const at = (h: number, m: number) => new Date(nyInstant(day, h, m)).toISOString();
  it("uses the bar ending at the target", () => {
    const bars = [bar(at(9, 45), 2.05), bar(at(9, 30), 1.9)];
    expect(op.intradayPrice(bars, nyInstant(day, 10, 0))).toBe(2.05);
  });
  it("falls back to the last bar ending within 45 minutes, else null", () => {
    const bars = [bar(at(9, 30), 1.9)]; // ends 09:45
    expect(op.intradayPrice(bars, nyInstant(day, 10, 0))).toBe(1.9);
    expect(op.intradayPrice(bars, nyInstant(day, 10, 30))).toBe(1.9); // 45 min before
    expect(op.intradayPrice(bars, nyInstant(day, 10, 31))).toBeNull(); // 46 min
    expect(op.intradayPrice([bar(at(15, 45), 3)], nyInstant(day, 15, 45))).toBeNull(); // ends after the target
    expect(op.intradayPrice(undefined, nyInstant(day, 10, 0))).toBeNull();
  });
});

describe("listContracts", () => {
  beforeEach(() => {
    trading.resetTradingBase();
    trading.resetContractMemo();
  });
  it("parses string strikes, pages, drops adjusted roots and is memoised", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const first = !u.searchParams.get("page_token");
      return new Response(
        JSON.stringify({
          option_contracts: first
            ? [{ symbol: "TST260724C00100000", root_symbol: "TST", expiration_date: "2026-07-24", strike_price: "100", type: "call", status: "inactive", open_interest: null }]
            : [
                { symbol: "TST260724P00102500", root_symbol: "TST", expiration_date: "2026-07-24", strike_price: "102.5", type: "put", status: "inactive" },
                { symbol: "TST1260724C00100000", root_symbol: "TST1", expiration_date: "2026-07-24", strike_price: "100", type: "call", status: "inactive" },
              ],
          next_page_token: first ? "p2" : null,
        }),
        { status: 200 }
      );
    });
    const stats = { requests: 0 };
    const args = { underlying: "tst", expiryGte: "2026-07-24", expiryLte: "2026-09-01", strikeGte: 88, strikeLte: 112, status: "inactive" as const };
    const got = await trading.listContracts(args, stats);
    expect(got.map((c) => [c.occ, c.strike, c.type])).toEqual([["TST260724C00100000", 100, "call"], ["TST260724P00102500", 102.5, "put"]]);
    expect(stats.requests).toBe(2);
    expect(urls[0]).toContain("status=inactive");
    expect(urls[0]).toContain("strike_price_gte=88");
    await trading.listContracts(args, stats);
    expect(stats.requests).toBe(2); // memo
  });
  it("stays GET-only and refuses other statuses and paths", async () => {
    await expect(trading.tradingFetch("/v2/options/contracts", { status: "filled" })).rejects.toThrow(/refusing/);
    await expect(trading.tradingFetch("/v2/orders", {})).rejects.toThrow(/refusing/);
  });
});

describe("paths from bars (pure)", () => {
  const contract = (expiry: string, type: "call" | "put", strike: number): OptionContract => ({
    occ: `TST${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8)}${type === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`,
    underlying: "TST", expiry, type, strike, status: "inactive", openInterest: null,
  });
  const contracts = ["2026-07-24", "2026-08-21"].flatMap((e) => [95, 97.5, 100, 102.5, 105].flatMap((k) => [contract(e, "call", k), contract(e, "put", k)]));
  const ev = {
    symbol: "TST", reportDate: "2026-07-23", t0: "2026-07-23", r: "2026-07-24",
    spots: { "T0-5": 100.4, "T0-1": 103.2, "T0:10:00": 103.1 } as Record<string, number>,
  };

  it("fixes the contract at entry and prices it at every later anchor only", () => {
    const daily = new Map<string, number>();
    // The T0-5 ATM call (100) trades on all days; the T0-1 ATM call (102.5) is a different contract.
    for (const e of contracts) for (const d of ["2026-07-16", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"]) daily.set(`${e.occ}|${d}`, e.strike);
    const lookup = {
      daily: (occ: string, day: string) => (daily.has(`${occ}|${day}`) ? { t: day, o: 1, h: 1, l: 1, c: daily.get(`${occ}|${day}`)! / 10, v: 7 } : undefined),
      intraday: () => undefined,
    };
    const paths = op.buildLegPaths(ev, contracts, lookup);
    const t5 = paths.find((p) => p.entry === "T0-5" && p.expiryKind === "event" && p.leg === "atm_call")!;
    expect(t5.strike).toBe(100);
    expect(t5.spotAtEntry).toBe(100.4);
    expect(Object.keys(t5.prices)).toEqual(["T0-5", "T0-2", "T0-1", "T0:open", "T0:10:00", "T0:15:45", "T0:close", "R:open", "R:close"]);
    expect(t5.prices["T0-5"]).toBe(10);
    expect(t5.prices["T0:close"]).toBe(10); // same contract, 100 strike
    expect(t5.prices["T0:15:45"]).toBeNull(); // no intraday bars
    expect("T0-10" in t5.prices).toBe(false);
    expect(t5.volumeAtEntryDay).toBe(7);
    expect(t5.priceSource).toBe("trade");
    const t1 = paths.find((p) => p.entry === "T0-1" && p.expiryKind === "event" && p.leg === "atm_call")!;
    expect(t1.strike).toBe(102.5);
    expect(t1.contract).not.toBe(t5.contract);
    expect(paths.find((p) => p.entry === "T0-1" && p.expiryKind === "event" && p.leg === "otm_call")!.strike).toBe(105);
    expect(paths.find((p) => p.entry === "T0-1" && p.expiryKind === "event" && p.leg === "atm_put")!.contract).toMatch(/P00102500$/);
    const swing = paths.find((p) => p.entry === "T0-5" && p.expiryKind === "swing" && p.leg === "atm_call")!;
    expect(swing.expiry).toBe("2026-08-21");
  });

  it("drops legs with no price at entry and steps to the next nearest strike that traded", () => {
    const call100 = contracts.find((c) => c.expiry === "2026-07-24" && c.type === "call" && c.strike === 100)!;
    const call97 = contracts.find((c) => c.expiry === "2026-07-24" && c.type === "call" && c.strike === 97.5)!;
    const lookup = {
      daily: (occ: string, day: string) => (occ === call97.occ && day === "2026-07-16" ? { t: day, o: 2, h: 2, l: 2, c: 4, v: 3 } : undefined),
      intraday: () => undefined,
    };
    void call100;
    const paths = op.buildLegPaths({ ...ev, spots: { "T0-5": 100.4 } }, contracts, lookup);
    const legs = paths.filter((p) => p.expiryKind === "event");
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ leg: "atm_call", strike: 97.5 });
  });

  it("computes IV from the entry price with the repo's solver", () => {
    const call = contracts.find((c) => c.expiry === "2026-07-24" && c.type === "call" && c.strike === 100)!;
    const day = "2026-07-23";
    const rate = 0.04;
    const t = Math.max(bs.yearsToExpiry("2026-07-24", nyInstant(day, 10), (d) => nyInstant(d, 16)), 0);
    const px = bs.price({ right: "call", spot: 100.2, strike: 100, t, rate, vol: 0.9 });
    const at = (h: number, m: number) => new Date(nyInstant(day, h, m)).toISOString();
    const lookup = {
      daily: () => undefined,
      intraday: (occ: string, d: string) => (occ === call.occ && d === day ? [bar(at(9, 45), px)] : undefined),
    };
    const paths = op.buildLegPaths({ ...ev, spots: { "T0:10:00": 100.2 } }, contracts, lookup, rate);
    const p = paths.find((x) => x.expiryKind === "event" && x.leg === "atm_call")!;
    expect(p.entry).toBe("T0:10:00");
    expect(p.prices["T0:10:00"]).toBeCloseTo(px, 6);
    expect(p.ivAtEntry!).toBeCloseTo(0.9, 3);
  });
});

describe("backfillOptions with mocked Alpaca", () => {
  const SESSIONS = (() => {
    const out: string[] = [];
    for (let d = Date.parse("2026-06-10T00:00:00Z"); d <= Date.parse("2026-07-30T00:00:00Z"); d += 86_400_000) {
      const dow = new Date(d).getUTCDay();
      if (dow !== 0 && dow !== 6) out.push(new Date(d).toISOString().slice(0, 10));
    }
    return out;
  })();
  const occOf = (expiry: string, type: "C" | "P", strike: number) => `TST${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8)}${type}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  const expiries = ["2026-07-24", "2026-07-31", "2026-08-21"];
  const strikes = [90, 92.5, 95, 97.5, 100, 102.5, 105, 107.5, 110];
  const calls: string[] = [];

  function mockAlpaca(opts: { noBarsFor?: string[] } = {}) {
    calls.length = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      const u = new URL(input);
      calls.push(`${u.pathname}?${u.searchParams.get("timeframe") ?? u.searchParams.get("status") ?? ""}`);
      if (u.pathname === "/v2/calendar") return new Response("nope", { status: 500 });
      if (u.pathname === "/v2/options/contracts") {
        const inactive = u.searchParams.get("status") === "inactive";
        const rows = inactive
          ? expiries.flatMap((e) => strikes.flatMap((k) => (["C", "P"] as const).map((t) => ({ symbol: occOf(e, t, k), root_symbol: "TST", expiration_date: e, strike_price: String(k), type: t === "C" ? "call" : "put", status: "inactive" }))))
          : [];
        return new Response(JSON.stringify({ option_contracts: rows, next_page_token: null }), { status: 200 });
      }
      if (u.pathname === "/v1beta1/options/bars") {
        const syms = (u.searchParams.get("symbols") ?? "").split(",").filter((s) => !(opts.noBarsFor ?? []).includes(s));
        const tf = u.searchParams.get("timeframe");
        const bars: Record<string, unknown[]> = {};
        for (const s of syms) {
          const isCall = /C\d{8}$/.test(s);
          const strike = Number(s.slice(-8)) / 1000;
          const base = Math.max(0.3, isCall ? 100 - strike + 3 : strike - 100 + 3);
          if (tf === "1Day") {
            bars[s] = SESSIONS.map((d, i) => ({ t: `${d}T04:00:00Z`, o: base + 0.01 * i, h: base, l: base, c: base + 0.02 * i, v: 50 }));
          } else {
            const day = new Date(u.searchParams.get("start")!).toISOString().slice(0, 10);
            // sparse: only the 09:45 and 15:30 bars (start times; EDT = UTC-4)
            bars[s] = [{ t: `${day}T13:45:00Z`, o: base, h: base, l: base, c: base + 0.5, v: 4 }, { t: `${day}T19:30:00Z`, o: base, h: base, l: base, c: base + 1, v: 2 }];
          }
        }
        return new Response(JSON.stringify({ bars, next_page_token: null }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
  }

  beforeAll(() => {
    const e = edb.earningsDb;
    e.prepare("INSERT INTO events (symbol, report_date, time, t0, r, confirmed, reason) VALUES ('TST','2026-07-23','amc','2026-07-23','2026-07-24',1,'ok')").run();
    e.prepare("INSERT INTO events (symbol, report_date, time, t0, r, confirmed, reason) VALUES ('TST','2026-04-23','amc','2026-04-23','2026-04-24',0,'unconfirmed')").run();
    e.prepare("INSERT INTO events (symbol, report_date, time, t0, r, confirmed, reason) VALUES ('TST','2023-10-23','amc','2023-10-23','2023-10-24',1,'ok')").run();
    e.prepare("INSERT INTO stock_paths (symbol, report_date, t0_m20, t0_m10, t0_m5, t0_m2, t0_m1, t0_open, t0_1000, t0_1545, t0_close, r_open, r_close) VALUES ('TST','2026-07-23',99.8,100.1,100.4,100.9,101.2,101.0,101.1,101.5,101.4,95,94)").run();
  });

  it("stores ladder, intraday and leg paths for confirmed events since the cutoff", async () => {
    mockAlpaca();
    const res = await op.backfillOptions(["TST"], { since: "2026-01-01" });
    expect(res.errors).toBe(0);
    expect(res.events).toBe(1); // unconfirmed and pre-cutoff events are skipped
    expect(res.legs).toBeGreaterThan(20);
    expect(res.requests).toBeGreaterThan(3);
    const e = edb.earningsDb;
    expect((e.prepare("SELECT COUNT(*) n FROM option_ladder_bars").get() as any).n).toBeGreaterThan(100);
    expect((e.prepare("SELECT COUNT(*) n FROM option_intraday_bars").get() as any).n).toBeGreaterThan(10);
    const row = e.prepare("SELECT * FROM option_paths WHERE symbol='TST' AND entry='T0-5' AND expiry_kind='event' AND leg='atm_call'").get() as any;
    expect(row.contract).toBe(occOf("2026-07-24", "C", 100));
    expect(row.strike).toBe(100);
    expect(row.expiry).toBe("2026-07-24");
    expect(row.price_source).toBe("trade");
    const prices = JSON.parse(row.prices);
    expect(prices["T0-5"]).toBeGreaterThan(0);
    expect(prices["T0:10:00"]).toBeCloseTo(3.5, 6); // 09:45 bar close
    expect(prices["T0:15:45"]).toBeCloseTo(4, 6); // 15:30 bar close
    expect(prices["R:close"]).toBeGreaterThan(0);
    expect(row.iv_at_entry).toBeGreaterThan(0);
    const swing = e.prepare("SELECT expiry FROM option_paths WHERE entry='T0-5' AND expiry_kind='swing' AND leg='atm_call'").get() as any;
    expect(swing.expiry).toBe("2026-08-21");
    const prog = e.prepare("SELECT status FROM backfill_progress WHERE task='options' AND symbol='TST'").get() as any;
    expect(prog.status).toBe("done");
  });

  it("resumes: a finished symbol costs no requests and changes nothing", async () => {
    mockAlpaca();
    const before = (edb.earningsDb.prepare("SELECT COUNT(*) n FROM option_paths").get() as any).n;
    const res = await op.backfillOptions(["TST"], { since: "2026-01-01" });
    expect(res).toEqual({ events: 0, legs: 0, requests: 0, errors: 0 });
    expect(calls).toHaveLength(0);
    expect((edb.earningsDb.prepare("SELECT COUNT(*) n FROM option_paths").get() as any).n).toBe(before);
  });

  it("is idempotent when the nightly hook rebuilds an event", async () => {
    mockAlpaca();
    const count = () => (edb.earningsDb.prepare("SELECT COUNT(*) n FROM option_paths").get() as any).n;
    const before = count();
    await op.buildOptionPathsFor([{ symbol: "TST", reportDate: "2026-07-23" }]);
    expect(count()).toBe(before);
  });
});
