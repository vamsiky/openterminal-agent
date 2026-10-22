import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EarningsCalendarRow } from "../providers/fmp.js";

let tmp: string;
let fmpTiming: typeof import("./timing.js").fmpTiming;
let db: typeof import("../db.js").db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "earn-timing-fmp-"));
  process.env.DATA_DIR = tmp;
  db = (await import("../db.js")).db;
  ({ fmpTiming } = await import("./timing.js"));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const unix = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
const row = (date: string, time: "bmo" | "amc" | null, reported: boolean): EarningsCalendarRow => ({
  symbol: "X", date: unix(date), epsActual: reported ? 1 : null, epsEstimated: 1, revenueActual: null, revenueEstimated: null, time, confirmed: reported, fiscalPeriod: "Q", fiscalYear: 2026, periodEnding: null,
});
const TODAY = "2026-10-21";
const PAST_DATES = ["2026-07-20", "2026-04-20", "2026-01-20", "2025-10-20"];
const past = (times: Array<"bmo" | "amc" | null>) => times.map((t, i) => row(PAST_DATES[i], t, true));

describe("fmpTiming", () => {
  it("uses the upcoming report's own FMP time when FMP gives one", () => {
    const rows = [...past(["amc", "amc", "amc", "amc"]), row("2026-10-22", "bmo", false)];
    expect(fmpTiming(rows, TODAY)).toMatchObject({ timing: "bmo", source: "fmp" });
  });

  it("ties between past FMP times give no timing", () => {
    expect(fmpTiming([...past(["amc", "bmo"]), row("2026-10-22", null, false)], TODAY)).toBeNull();
  });

  // KNOWN BUG (estimates/timing.ts:64): with the upcoming report's FMP time null, the majority of past FMP times is
  // returned as the timing and labelled source "fmp". The spec allows press-release inference only as the fallback
  // for a null FMP time, and timeSource is one of fmp | press_release | null, so a history guess must not say "fmp".
  it.fails("does not label a time guessed from past reports as FMP's own time (known bug: timing.ts:64)", () => {
    const t = fmpTiming([...past(["amc", "amc", "amc"]), row("2026-10-22", null, false)], TODAY);
    expect(t?.source).not.toBe("fmp");
  });
});
