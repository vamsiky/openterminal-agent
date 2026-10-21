import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionMetrics } from "../scan/contracts.js";
import type { Bar } from "./indicators.js";

let tmpDir: string;
let os: typeof import("./option-score.js");
let db: typeof import("../db.js").db;

const NOW = new Date("2026-10-21T19:00:00Z"); // 15:00 New York
const TODAY = "2026-10-21";

const metrics = (o: Partial<OptionMetrics> = {}): OptionMetrics => ({
  underlying: "AAA", asOf: NOW.toISOString(), price: 100, atmExpiry: "2026-11-20", atmCall: "AAA261120C00100000", atmPut: "AAA261120P00100000",
  atmIv: 0.3, iv30: 0.3, ivRank: 20, ivPercentile: 25, ivHistoryDays: 200, hv20: 0.28, impliedMovePct: 5, termSlope: 0, putCallVolumeRatio: 0.8, unusual: [],
  atmCallQuote: null, atmPutQuote: null, ...o,
});
const inputs = (o: Partial<import("./option-score.js").SetupInputs> = {}): import("./option-score.js").SetupInputs => ({
  momentum: { m5: 50, m15: 60, h1: 55, d1: 30 }, metrics: metrics(), composite: 70, relVolume: 2, sharesHeld: 0, nextEarnings: null, today: TODAY, ...o,
});

const trending = (n: number, drift: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 + drift * i + Math.sin(i) * 0.3;
    return { ts: 1_700_000_000 + i * 900, open: c, high: c + 0.4, low: c - 0.4, close: c, volume: 100 };
  });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-optionscore-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  os = await import("./option-score.js");
});

afterAll(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("trendScore", () => {
  it("is positive in an uptrend, negative in a downtrend, null without enough bars", () => {
    expect(os.trendScore(trending(60, 0.3))!).toBeGreaterThan(40);
    expect(os.trendScore(trending(60, -0.3))!).toBeLessThan(-40);
    expect(os.trendScore(trending(10, 0.3))).toBeNull();
  });

  it("price below the session VWAP pulls the score down", () => {
    const bars = trending(60, 0.3);
    const price = bars[bars.length - 1].close;
    expect(os.trendScore(bars, price * 1.05)!).toBeLessThan(os.trendScore(bars, price * 0.95)!);
  });
});

describe("buildSetups", () => {
  it("long call: strong momentum, daily not negative, cheap IV", () => {
    const [s] = os.buildSetups(inputs());
    expect(s.strategy).toBe("long_call");
    expect(s.contract).toBe("AAA261120C00100000");
    expect(s.score).toBeGreaterThan(70);
    expect(s.reasons.join(" ")).toMatch(/IV rank 20/);
  });

  it("long call needs the daily trend and the strength; earnings before expiry cost points", () => {
    expect(os.buildSetups(inputs({ momentum: { m5: 50, m15: 60, h1: 55, d1: -5 } }))).toEqual([]);
    expect(os.buildSetups(inputs({ momentum: { m5: 5, m15: 30, h1: 20, d1: 30 } }))).toEqual([]);
    const plain = os.buildSetups(inputs())[0];
    const warned = os.buildSetups(inputs({ nextEarnings: "2026-11-05" }))[0];
    expect(warned.score).toBe(Math.round((plain.score - os.EARNINGS_PENALTY.long_call) * 10) / 10);
    expect(warned.reasons.join(" ")).toMatch(/earnings on 2026-11-05 fall before/);
    expect(os.buildSetups(inputs({ nextEarnings: "2026-12-05" }))[0].score).toBe(plain.score);
  });

  it("long call falls back to IV against realised vol when there is no rank", () => {
    const cheap = os.buildSetups(inputs({ metrics: metrics({ ivRank: null, ivPercentile: null, iv30: 0.3, hv20: 0.28 }) }))[0];
    expect(cheap.reasons.join(" ")).toMatch(/no IV rank yet/);
    const dear = os.buildSetups(inputs({ metrics: metrics({ ivRank: null, iv30: 0.5, hv20: 0.28 }) })).find((x) => x.strategy === "long_call")!;
    expect(dear.score).toBeLessThan(cheap.score);
  });

  it("short put: a stock worth owning, rich IV, daily not falling hard", () => {
    const i = inputs({ momentum: { m5: 0, m15: 5, h1: 0, d1: -10 }, metrics: metrics({ ivRank: 75 }), composite: 72 });
    const setups = os.buildSetups(i);
    expect(setups.map((s) => s.strategy)).toEqual(["short_put"]);
    expect(setups[0].contract).toBe("AAA261120P00100000");
    expect(setups[0].reasons.join(" ")).toMatch(/worth owning/);
    expect(os.buildSetups({ ...i, composite: 55 })).toEqual([]);
    expect(os.buildSetups({ ...i, momentum: { ...i.momentum, d1: -60 } })).toEqual([]);
    expect(os.buildSetups({ ...i, metrics: metrics({ ivRank: 40 }) })).toEqual([]);
  });

  it("covered call: only with 100+ shares, rich IV and flat or falling momentum", () => {
    const i = inputs({ momentum: { m5: -10, m15: -5, h1: 10, d1: 0 }, metrics: metrics({ ivRank: 80 }), composite: 40, sharesHeld: 250 });
    const setups = os.buildSetups(i);
    expect(setups.map((s) => s.strategy)).toEqual(["covered_call"]);
    expect(setups[0].reasons[0]).toMatch(/250 shares \(2 contracts covered\)/);
    expect(os.buildSetups({ ...i, sharesHeld: 99 })).toEqual([]);
    expect(os.buildSetups({ ...i, momentum: { m5: 40, m15: 45, h1: 40, d1: 10 } }).map((s) => s.strategy)).not.toContain("covered_call");
  });

  it("ex-dividend before expiry: a big penalty on a covered call, a small one on a short put", () => {
    const call = inputs({ momentum: { m5: -10, m15: -5, h1: 10, d1: 0 }, metrics: metrics({ ivRank: 80 }), composite: 40, sharesHeld: 100 });
    const plain = os.buildSetups(call)[0];
    const warned = os.buildSetups({ ...call, nextExDividend: "2026-11-05" })[0];
    expect(warned.score).toBe(Math.round((plain.score - os.EX_DIVIDEND_PENALTY.covered_call) * 10) / 10);
    expect(warned.reasons).toContain("ex-dividend 2026-11-05 before expiry: early assignment risk");
    expect(os.buildSetups({ ...call, nextExDividend: "2026-12-05" })[0].score).toBe(plain.score);
    expect(os.buildSetups({ ...call, nextExDividend: "2026-10-01" })[0].score).toBe(plain.score);

    const put = inputs({ momentum: { m5: 0, m15: 5, h1: 0, d1: -10 }, metrics: metrics({ ivRank: 75 }), composite: 72 });
    const p0 = os.buildSetups(put)[0];
    const p1 = os.buildSetups({ ...put, nextExDividend: "2026-11-05" })[0];
    expect(p0.score - p1.score).toBeCloseTo(os.EX_DIVIDEND_PENALTY.short_put, 1);
    expect(p1.reasons.join(" ")).toMatch(/ex-dividend 2026-11-05/);
  });

  it("long call: a daily trend of 14 (CRCL-like) is gated out, 25 passes", () => {
    const m = { m5: 80, m15: 82, h1: 68, d1: 14 };
    expect(os.buildSetups(inputs({ momentum: m })).map((s) => s.strategy)).not.toContain("long_call");
    const ok = os.buildSetups(inputs({ momentum: { ...m, d1: 25 } })).find((s) => s.strategy === "long_call")!;
    expect(ok.reasons[0]).toBe("momentum is strong: 15-minute 82, hourly 68, daily uptrend 25 (at least 25)");
  });

  it("long call: stretch penalty of 10 per condition, capped at 30, with one reason that names them", () => {
    const base = inputs({ momentum: { m5: 80, m15: 91, h1: 75, d1: 42 }, metrics: metrics({ hv20: 0.62 }) });
    const calm = os.buildSetups(base).find((s) => s.strategy === "long_call")!;
    // ZS-like: 2.1 ATR above VWAP, 15-minute RSI 84, up 7.6% against a normal 0.62 / sqrt(252) = 3.9% day.
    const zs = os.buildSetups({ ...base, stretch: { vwapAtr: 2.1, rsi15: 84, dayMovePct: 7.6, dailyAtrPct: 3 } }).find((s) => s.strategy === "long_call")!;
    expect(zs.score).toBe(Math.round((calm.score - 30) * 10) / 10);
    expect(zs.reasons).toContain("stretched: 2.1 ATR above VWAP, 15-min RSI 84, up 7.6% vs a normal 3.9% day: consider waiting for a pullback");
    // One condition costs 10 and names only itself.
    const one = os.buildSetups({ ...base, stretch: { vwapAtr: 2.6, rsi15: 60, dayMovePct: 2, dailyAtrPct: 3 } }).find((s) => s.strategy === "long_call")!;
    expect(one.score).toBe(Math.round((calm.score - 10) * 10) / 10);
    expect(one.reasons.find((r) => r.startsWith("stretched"))).toBe("stretched: 2.6 ATR above VWAP: consider waiting for a pullback");
  });

  it("long call: a calm uptrend gets no penalty or reason; without hv20 the daily ATR sets the normal move", () => {
    const base = inputs({ momentum: { m5: 80, m15: 70, h1: 60, d1: 40 } });
    const plain = os.buildSetups(base).find((s) => s.strategy === "long_call")!;
    const calm = os.buildSetups({ ...base, stretch: { vwapAtr: 0.8, rsi15: 62, dayMovePct: 1.2, dailyAtrPct: 2 } }).find((s) => s.strategy === "long_call")!;
    expect(calm.score).toBe(plain.score);
    expect(calm.reasons.some((r) => r.startsWith("stretched"))).toBe(false);
    const noHv = { ...base, metrics: metrics({ hv20: null }) };
    const moved = os.buildSetups({ ...noHv, stretch: { vwapAtr: 0, rsi15: 50, dayMovePct: 3.1, dailyAtrPct: 2 } }).find((s) => s.strategy === "long_call")!;
    expect(moved.reasons.find((r) => r.startsWith("stretched"))).toBe("stretched: up 3.1% vs a normal 2.0% day: consider waiting for a pullback");
    expect(os.buildSetups({ ...noHv, stretch: { vwapAtr: 0, rsi15: 50, dayMovePct: 3.0, dailyAtrPct: 2 } }).find((s) => s.strategy === "long_call")!.reasons.some((r) => r.startsWith("stretched"))).toBe(false); // exactly 1.5x is not beyond it
  });

  it("offers nothing without option metrics", () => {
    expect(os.buildSetups(inputs({ metrics: null }))).toEqual([]);
  });
});

describe("runOptionScan", () => {
  it("scores symbols from stored bars and the injected metrics, and keeps history", async () => {
    const store = await import("../history/store.js");
    const days = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"];
    const { nyInstant } = await import("../live/session.js");
    const minute = days.flatMap((day, d) => {
      const open = nyInstant(day, 9, 30) / 1000;
      const count = day === TODAY ? 330 : 390; // 15:00 now
      return Array.from({ length: count }, (_, m) => {
        const c = 100 + (d * 390 + m) * 0.004 + Math.sin(m / 3) * 0.05;
        return { symbol: "AAA", ts: open + m * 60, open: c, high: c + 0.05, low: c - 0.05, close: c, volume: 1000, vwap: null, trades: null };
      });
    });
    store.upsertMinuteBars(minute);
    store.upsertDailyBars(
      Array.from({ length: 40 }, (_, i) => {
        const c = 90 + i * 0.3 + Math.sin(i) * 0.2;
        return { symbol: "AAA", day: new Date(Date.parse("2026-09-11T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1e6, vwap: null, trades: null };
      })
    );
    const m = new Map([["AAA", metrics()]]);
    const r = os.runOptionScan(["AAA", "BBB"], () => m, NOW);
    expect(r.scored).toBe(2);
    const a = os.getOptionScorecard("AAA")!;
    expect(a.momentum.m15).not.toBeNull();
    expect(a.momentum.d1).not.toBeNull();
    expect(a.metrics?.atmCall).toBe("AAA261120C00100000");
    expect(a.momentum.h1!).toBeGreaterThan(0);
    const b = os.getOptionScorecard("BBB")!;
    expect(b.score).toBeNull();
    expect(b.setups).toEqual([]);
    expect(b.earningsBeforeExpiry).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM option_scorecards_history").get()).toEqual({ n: 2 });
    expect(os.optionScores().has("BBB")).toBe(false);

    // A later scan drops symbols that left the universe and trims history older than 30 days.
    db.prepare("UPDATE option_scorecards_history SET ts = '2026-08-01T00:00:00.000Z'").run();
    os.runOptionScan(["AAA"], () => m, NOW);
    expect(os.getOptionScorecard("BBB")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM option_scorecards_history").get()).toEqual({ n: 1 });
  });
});
