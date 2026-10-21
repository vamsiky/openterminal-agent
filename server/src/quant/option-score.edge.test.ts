import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OptionMetrics } from "../scan/contracts.js";
import type { Momentum, SetupInputs } from "./option-score.js";

let tmpDir: string;
let os: typeof import("./option-score.js");
let db: typeof import("../db.js").db;

const TODAY = "2026-10-21";
const metrics = (o: Partial<OptionMetrics> = {}): OptionMetrics => ({
  underlying: "AAA", asOf: "2026-10-21T14:00:00Z", price: 100, atmExpiry: "2026-11-20",
  atmCall: "AAA261120C00100000", atmPut: "AAA261120P00100000", atmIv: 0.3, iv30: 0.3, ivRank: null, ivPercentile: null,
  ivHistoryDays: 0, hv20: 0.25, impliedMovePct: null, termSlope: null, putCallVolumeRatio: null, unusual: [],
  atmCallQuote: null, atmPutQuote: null, ...o,
});
const mom = (o: Partial<Momentum> = {}): Momentum => ({ m5: 0, m15: 0, h1: 0, d1: 0, ...o });
const inputs = (o: Partial<SetupInputs> = {}): SetupInputs => ({
  momentum: mom(), metrics: metrics(), composite: 50, relVolume: 1, sharesHeld: 0, nextEarnings: null, today: TODAY, ...o,
});
const byStrategy = (s: ReturnType<typeof os.buildSetups>, k: string) => s.find((x) => x.strategy === k);

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-optionscore-edge-test-"));
  process.env.DATA_DIR = tmpDir;
  ({ db } = await import("../db.js"));
  os = await import("./option-score.js");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("long call gates", () => {
  const strong = (o: Partial<Momentum>) => inputs({ momentum: mom({ m15: 40, h1: 40, d1: 25, ...o }), metrics: metrics({ ivRank: 0 }) });

  it("passes at exactly the strength threshold with the daily trend at its minimum of 25", () => {
    expect(byStrategy(os.buildSetups(strong({})), "long_call")).toBeDefined();
  });

  it("needs the 15-minute and hourly charts both positive, not only their average", () => {
    expect(byStrategy(os.buildSetups(inputs({ momentum: mom({ m15: -1, h1: 81, d1: 25 }), metrics: metrics({ ivRank: 0 }) })), "long_call")).toBeUndefined();
    expect(byStrategy(os.buildSetups(inputs({ momentum: mom({ m15: 10, h1: 70, d1: 25 }), metrics: metrics({ ivRank: 0 }) })), "long_call")).toBeDefined();
  });

  it("falls just short with an average a hair under the threshold, and with a daily trend under 25", () => {
    expect(byStrategy(os.buildSetups(strong({ m15: 40, h1: 39.9 })), "long_call")).toBeUndefined();
    expect(byStrategy(os.buildSetups(strong({ d1: 24.9 })), "long_call")).toBeUndefined();
  });

  it("scores 70 for the threshold momentum, cheap IV and high relative volume", () => {
    // 40 base + 0 for strength at the threshold + 5 for a daily trend of 25 + 15 for IV rank 0 + 10 for volume >= 1.5x.
    const setup = byStrategy(os.buildSetups(inputs({ momentum: mom({ m15: 40, h1: 40, d1: 25 }), metrics: metrics({ ivRank: 0 }), relVolume: 2 })), "long_call")!;
    expect(setup.score).toBe(70);
    expect(setup.contract).toBe("AAA261120C00100000");
  });

  it("is capped at 100 at the top of every term", () => {
    const top = byStrategy(os.buildSetups(inputs({ momentum: mom({ m15: 100, h1: 100, d1: 100 }), metrics: metrics({ ivRank: 0 }), relVolume: 3 })), "long_call")!;
    expect(top.score).toBe(100);
  });

  it("counts earnings on the expiry day, but not earnings that already passed", () => {
    // 40 base + 5 for the daily trend + 15 for cheap IV + 10 for volume, minus the 25 earnings penalty.
    const onExpiry = byStrategy(os.buildSetups(inputs({ momentum: mom({ m15: 40, h1: 40, d1: 25 }), metrics: metrics({ ivRank: 0 }), relVolume: 2, nextEarnings: "2026-11-20" })), "long_call")!;
    expect(onExpiry.reasons.join(" ")).toMatch(/caution/);
    expect(onExpiry.score).toBe(45);
    const passed = byStrategy(os.buildSetups(inputs({ momentum: mom({ m15: 40, h1: 40, d1: 25 }), metrics: metrics({ ivRank: 0 }), relVolume: 2, nextEarnings: "2026-10-20" })), "long_call")!;
    expect(passed.reasons.join(" ")).not.toMatch(/caution/);
  });
});

describe("short put gates", () => {
  const rich = (o: Partial<SetupInputs> = {}) => inputs({ composite: 60, momentum: mom({ d1: 0 }), metrics: metrics({ ivRank: 60 }), ...o });

  it("needs a composite of 60, and passes at exactly 60", () => {
    expect(byStrategy(os.buildSetups(rich({ composite: 60 })), "short_put")).toBeDefined();
    expect(byStrategy(os.buildSetups(rich({ composite: 59.9 })), "short_put")).toBeUndefined();
  });

  it("needs rich IV: an IV rank of 60 passes, 59.9 does not", () => {
    expect(byStrategy(os.buildSetups(rich({ metrics: metrics({ ivRank: 60 }) })), "short_put")).toBeDefined();
    expect(byStrategy(os.buildSetups(rich({ metrics: metrics({ ivRank: 59.9 }) })), "short_put")).toBeUndefined();
  });

  it("uses IV over realised vol when there is no rank: strictly above 1.0x passes", () => {
    expect(byStrategy(os.buildSetups(rich({ metrics: metrics({ ivRank: null, iv30: 0.26, hv20: 0.25 }) })), "short_put")).toBeDefined();
    expect(byStrategy(os.buildSetups(rich({ metrics: metrics({ ivRank: null, iv30: 0.25, hv20: 0.25 }) })), "short_put")).toBeUndefined();
  });

  it("is blocked at a daily trend of -50 and allowed at -49.9", () => {
    expect(byStrategy(os.buildSetups(rich({ momentum: mom({ d1: -50 }) })), "short_put")).toBeUndefined();
    expect(byStrategy(os.buildSetups(rich({ momentum: mom({ d1: -49.9 }) })), "short_put")).toBeDefined();
  });

  it("states the cash needed for 100 shares at the price", () => {
    const setup = byStrategy(os.buildSetups(rich({ metrics: metrics({ ivRank: 80, price: 250.4 }) })), "short_put")!;
    expect(setup.reasons.join(" ")).toMatch(/about \$25,040/);
  });
});

describe("covered call gates", () => {
  const flat = (o: Partial<SetupInputs> = {}) => inputs({ sharesHeld: 100, momentum: mom({ m15: 20, h1: 20, d1: 0 }), metrics: metrics({ ivRank: 80 }), ...o });

  it("needs 100 shares, not 99", () => {
    expect(byStrategy(os.buildSetups(flat({ sharesHeld: 99 })), "covered_call")).toBeUndefined();
    expect(byStrategy(os.buildSetups(flat({ sharesHeld: 100 })), "covered_call")).toBeDefined();
  });

  it("allows flat momentum at exactly 20 on both charts, and not 20.1 on either", () => {
    expect(byStrategy(os.buildSetups(flat({ momentum: mom({ m15: 20, h1: 20 }) })), "covered_call")).toBeDefined();
    expect(byStrategy(os.buildSetups(flat({ momentum: mom({ m15: 20.1, h1: 20 }) })), "covered_call")).toBeUndefined();
    expect(byStrategy(os.buildSetups(flat({ momentum: mom({ m15: 20, h1: 20.1 }) })), "covered_call")).toBeUndefined();
  });

  it("names the contracts you can cover and scores 100 at the top of every term", () => {
    const setup = byStrategy(os.buildSetups(flat({ sharesHeld: 250, momentum: mom({ m15: -60, h1: -60, d1: 0 }), metrics: metrics({ ivRank: 100 }) })), "covered_call")!;
    expect(setup.score).toBe(100);
    expect(setup.reasons[0]).toBe("you hold 250 shares (2 contracts covered)");
  });
});

describe("earnings when the expiry is unknown", () => {
  it("reports earningsBeforeExpiry as null, not false, when there is no expiry to compare with", () => {
    const sym = "NOEXPIRY";
    db.prepare("INSERT OR REPLACE INTO earnings_calendar (symbol, report_date, last_seen_day) VALUES (?, '2026-11-05', ?)").run(sym, TODAY);
    os.runOptionScan([sym], () => new Map([[sym, metrics({ underlying: sym, atmExpiry: null, atmCall: null, atmPut: null })]]), new Date("2026-10-21T14:00:00Z"));
    expect(os.getOptionScorecard(sym)!.earningsBeforeExpiry).toBeNull();
  });
});
