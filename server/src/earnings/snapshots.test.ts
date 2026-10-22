import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let sn: typeof import("./snapshots.js");
let edb: typeof import("./db.js");
let nyInstant: typeof import("../live/session.js").nyInstant;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-snapshots-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.ALPACA_API_KEY_ID = "test";
  process.env.ALPACA_API_SECRET_KEY = "test";
  process.env.ALPACA_MAX_REQ_PER_MIN = "1000000";
  sn = await import("./snapshots.js");
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

const at = (day: string, h: number, m: number) => nyInstant(day, h, m);

describe("scheduling windows", () => {
  it("fires the near cycle every 30 minutes from 09:45 to 15:45 ET", () => {
    const day = "2026-10-21"; // Wednesday
    expect(sn.slotAt(at(day, 9, 44))).toBeNull();
    expect(sn.slotAt(at(day, 9, 45))).toMatchObject({ kind: "near", minutes: 585 });
    expect(sn.slotAt(at(day, 9, 48))?.kind).toBe("near"); // late tick still runs it
    expect(sn.slotAt(at(day, 9, 49))).toBeNull();
    expect(sn.slotAt(at(day, 10, 15))?.kind).toBe("near");
    expect(sn.slotAt(at(day, 10, 30))).toBeNull();
    expect(sn.slotAt(at(day, 15, 45))).toMatchObject({ kind: "near", minutes: 945 });
    expect(sn.slotAt(at(day, 16, 15))).toBeNull(); // no 16:15 near slot
  });
  it("runs the far cycle once at 15:50 and the roll-up at 16:10", () => {
    const day = "2026-10-21";
    expect(sn.slotAt(at(day, 15, 50))).toMatchObject({ kind: "far", minutes: 950 });
    expect(sn.slotAt(at(day, 16, 10))?.kind).toBe("close");
    const keys = new Set([at(day, 15, 45), at(day, 15, 47), at(day, 15, 50)].map((t) => sn.slotAt(t)?.key));
    expect(keys.size).toBe(2); // 15:45 and 15:47 share a slot; 15:50 is another
  });
  it("skips weekends, and tracks daylight saving", () => {
    expect(sn.slotAt(at("2026-10-24", 9, 45))).toBeNull(); // Saturday
    expect(sn.slotAt(at("2026-12-02", 9, 45))?.kind).toBe("near"); // EST
  });
  it("picks names by sessions to T0: 0–10 near, 11–45 far, one row per symbol", () => {
    const e = edb.earningsDb;
    const ins = e.prepare("INSERT INTO upcoming (symbol, report_date, t0, r) VALUES (?, ?, ?, ?)");
    ins.run("NOW", "2026-10-21", "2026-10-21", "2026-10-22"); // 0 sessions
    ins.run("TEN", "2026-11-04", "2026-11-04", "2026-11-05"); // 10 sessions after 10-21
    ins.run("ELEV", "2026-11-05", "2026-11-05", "2026-11-06"); // 11
    ins.run("FAR", "2026-12-21", "2026-12-21", "2026-12-22"); // 42
    ins.run("OUT", "2027-02-01", "2027-02-01", "2027-02-02"); // >45
    ins.run("PAST", "2026-10-20", "2026-10-20", "2026-10-21"); // T0 already passed
    ins.run("NOW", "2027-01-20", "2027-01-20", "2027-01-21"); // later report of a near name
    const near = sn.trackedNames("near", "2026-10-21").map((t) => t.symbol);
    expect(near.sort()).toEqual(["NOW", "TEN"]);
    const far = sn.trackedNames("far", "2026-10-21").map((t) => t.symbol);
    expect(far.sort()).toEqual(["ELEV", "FAR"]); // NOW's later report is 63 sessions out
  });
});

const q = (bp: number, ap: number, v = 100) => ({ latestQuote: { bp, ap }, dailyBar: { v } });

describe("summary math", () => {
  const parse = async (snaps: Record<string, any>) => {
    const { parseSnapshots } = await import("../options/sweep.js");
    return parseSnapshots(snaps, 100, at("2026-10-21", 9, 45));
  };
  const snaps = {
    NOW261023C00100000: q(2.0, 2.2),
    NOW261023P00100000: q(1.9, 2.1),
    NOW261023C00105000: q(0.5, 0.6),
    NOW261023C00102000: q(1.0, 1.2),
    NOW261030C00100000: q(3.0, 3.2),
    NOW261030P00100000: q(2.9, 3.1),
  };
  it("implied move is the ATM straddle mid over spot", async () => {
    const contracts = await parse(snaps);
    const a = sn.atmSummary(contracts, "2026-10-23", 100)!;
    expect(a.strike).toBe(100);
    expect(a.impliedMovePct).toBeCloseTo(4.1, 6); // (2.1 + 2.0) / 100
    expect(a.otm).toMatchObject({ strike: 102, occ: "NOW261023C00102000" });
    expect(a.call.delta).toBeGreaterThan(0.3);
    expect(a.put.delta!).toBeLessThan(0);
    expect(a.otm!.delta!).toBeLessThan(a.call.delta!);
    expect(sn.atmSummary(contracts, "2026-10-23", 100.4)!.impliedMovePct).toBeCloseTo(4.1 / 1.004, 6);
    expect(sn.atmSummary(contracts, "2026-10-23", 104)!.strike).toBe(100); // 105 has no put
    expect(sn.atmSummary(contracts, "2026-11-06", 100)).toBeNull();
  });
  it("event premium is the event-expiry ATM IV over the next expiry's", async () => {
    const contracts = await parse(snaps);
    expect(sn.eventAndNext(contracts, "2026-10-22")).toEqual({ event: "2026-10-23", next: "2026-10-30" });
    expect(sn.eventAndNext(contracts, "2026-10-24")).toEqual({ event: "2026-10-30", next: null });
    const ev = sn.atmSummary(contracts, "2026-10-23", 100)!;
    const nx = sn.atmSummary(contracts, "2026-10-30", 100)!;
    expect(ev.iv).toBeGreaterThan(0);
    expect(sn.eventPremium(ev, nx)).toBeCloseTo(ev.iv! / nx.iv!, 10);
    expect(sn.eventPremium(ev, null)).toBeNull();
  });
});

describe("cycle, roll-up and prune", () => {
  it("stores event and next rows per name and skips names without options", async () => {
    sn.resetSnapshotState();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const u = new URL(input);
      seen.push(u.pathname);
      if (u.pathname === "/v2/calendar") return new Response("x", { status: 500 });
      if (u.pathname === "/v2/stocks/snapshots") {
        return new Response(JSON.stringify({ NOW: { latestTrade: { p: 100 } }, TEN: { latestTrade: { p: 50 } } }), { status: 200 });
      }
      if (u.pathname === "/v1beta1/options/snapshots/NOW") {
        return new Response(
          JSON.stringify({
            snapshots: {
              NOW261023C00100000: q(2.0, 2.2), NOW261023P00100000: q(1.9, 2.1), NOW261023C00102500: q(1.0, 1.2),
              NOW261030C00100000: q(3.0, 3.2), NOW261030P00100000: q(2.9, 3.1),
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ snapshots: {} }), { status: 200 });
    });
    const slot = at("2026-10-21", 9, 45);
    const res = await sn.runSnapshotCycle("near", slot);
    expect(res).toMatchObject({ names: 2, rows: 2, noOptions: 1, errors: 0 });
    const rows = edb.earningsDb.prepare("SELECT * FROM snapshots WHERE symbol = 'NOW' ORDER BY expiry_kind").all() as any[];
    expect(rows.map((r) => [r.expiry_kind, r.expiry])).toEqual([["event", "2026-10-23"], ["next", "2026-10-30"]]);
    expect(rows[0]).toMatchObject({ spot: 100, call_occ: "NOW261023C00100000", call_bid: 2.0, put_ask: 2.1, call_volume: 100, report_date: "2026-10-21" });
    expect(rows[0]).toMatchObject({ otm_occ: "NOW261023C00102500", otm_strike: 102.5, otm_bid: 1.0, otm_ask: 1.2, otm_volume: 100 });
    expect(rows[0].call_delta).toBeGreaterThan(rows[0].otm_delta);
    expect(rows[0].put_delta).toBeLessThan(0);
    expect(rows[1].otm_occ).toBeNull();
    expect(rows[0].implied_move_pct).toBeCloseTo(4.1, 6);
    expect(rows[0].event_premium).toBeGreaterThan(0);
    expect(rows[1].event_premium).toBeNull();
    expect(rows[0].ts).toBe(new Date(slot).toISOString());
    // The empty name is not asked again that day.
    seen.length = 0;
    await sn.runSnapshotCycle("near", at("2026-10-21", 10, 15));
    expect(seen.filter((p) => p.endsWith("/TEN"))).toHaveLength(0);
  });

  it("maps snapshot times to anchors", () => {
    const t0 = "2026-09-23";
    const iso = (d: string, h: number, m: number) => new Date(at(d, h, m)).toISOString();
    expect(sn.snapshotAnchor(iso("2026-09-23", 9, 45), t0)).toBe("T0:10:00");
    expect(sn.snapshotAnchor(iso("2026-09-23", 15, 45), t0)).toBe("T0:15:45");
    expect(sn.snapshotAnchor(iso("2026-09-23", 12, 15), t0)).toBeNull();
    expect(sn.snapshotAnchor(iso("2026-09-22", 15, 45), t0)).toBe("T0-1");
    expect(sn.snapshotAnchor(iso("2026-09-16", 15, 50), t0)).toBe("T0-5");
    expect(sn.snapshotAnchor(iso("2026-09-17", 15, 50), t0)).toBeNull(); // T0-4 is not an anchor
    expect(sn.snapshotAnchor(iso("2026-09-22", 10, 15), t0)).toBeNull(); // mid-session on a close anchor day
  });

  it("rolls quotes into option_paths after R, filling trade gaps and adding quote-only legs, then prunes", () => {
    const e = edb.earningsDb;
    e.prepare("INSERT INTO events (symbol, report_date, t0, r, confirmed) VALUES ('RUP','2026-09-23','2026-09-23','2026-09-24',1)").run();
    const snap = e.prepare(`INSERT INTO snapshots (symbol, ts, expiry_kind, report_date, expiry, spot, call_occ, call_strike, call_bid, call_ask, call_iv, call_volume,
      put_occ, put_strike, put_bid, put_ask, put_iv, put_volume) VALUES ('RUP', ?, 'event', '2026-09-23', '2026-09-25', 100, 'RUP260925C00100000', 100, ?, ?, 0.6, 20,
      'RUP260925P00100000', 100, ?, ?, 0.62, 15)`);
    const ts = (d: string, h: number, m: number) => new Date(at(d, h, m)).toISOString();
    snap.run(ts("2026-09-22", 15, 45), 1.9, 2.1, 1.4, 1.6); // T0-1
    snap.run(ts("2026-09-23", 9, 45), 2.0, 2.2, 1.3, 1.5); // T0:10:00
    snap.run(ts("2026-09-23", 15, 45), 3.0, 3.4, 0.9, 1.1); // T0:15:45
    // A trade-based call leg entered T0-1 that lacks the 15:45 price; no put leg exists.
    e.prepare(`INSERT INTO option_paths (symbol, report_date, entry, expiry_kind, leg, contract, expiry, strike, spot_at_entry, prices, iv_at_entry, price_source, volume_at_entry_day)
      VALUES ('RUP','2026-09-23','T0-1','event','atm_call','RUP260925C00100000','2026-09-25',100,100,?,0.5,'trade',9)`).run(JSON.stringify({ "T0-1": 2.05, "T0:10:00": 2.1, "T0:15:45": null }));
    expect(sn.rollUpSnapshots("2026-09-24")).toBe(0); // R is not before today yet
    const changed = sn.rollUpSnapshots("2026-09-25");
    expect(changed).toBeGreaterThan(0);
    const call = e.prepare("SELECT * FROM option_paths WHERE symbol='RUP' AND entry='T0-1' AND leg='atm_call'").get() as any;
    expect(JSON.parse(call.prices)).toEqual({ "T0-1": 2.05, "T0:10:00": 2.1, "T0:15:45": 3.2 }); // trade prices kept, gap filled
    expect(call.price_source).toBe("trade");
    expect(call.iv_at_entry).toBe(0.5);
    const put = e.prepare("SELECT * FROM option_paths WHERE symbol='RUP' AND entry='T0-1' AND leg='atm_put'").get() as any;
    expect(put.price_source).toBe("quote");
    expect(JSON.parse(put.prices)).toMatchObject({ "T0-1": 1.5, "T0:10:00": 1.4, "T0:15:45": 1.0, "T0:close": null, "R:close": null });
    expect(put.iv_at_entry).toBe(0.62);
    const early = e.prepare("SELECT * FROM option_paths WHERE symbol='RUP' AND entry='T0:10:00' AND leg='atm_call'").get() as any;
    expect(early.price_source).toBe("quote");
    expect(JSON.parse(early.prices)["T0:15:45"]).toBe(3.2);
    expect(sn.rollUpSnapshots("2026-09-25")).toBe(0); // idempotent

    // Prune: rows more than 30 days past the report go, newer ones stay.
    const count = () => (e.prepare("SELECT COUNT(*) n FROM snapshots WHERE symbol='RUP'").get() as any).n;
    expect(sn.pruneSnapshots("2026-10-23")).toBe(0); // 30 days after the report date
    expect(count()).toBe(3);
    expect(sn.pruneSnapshots("2026-10-25")).toBe(3);
    expect(count()).toBe(0);
    expect(e.prepare("SELECT COUNT(*) n FROM snapshots WHERE symbol='NOW'").get()).toMatchObject({ n: 4 }); // two cycles, recent rows kept
  });
});
