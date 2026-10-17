import { describe, expect, it } from "vitest";
import { minuteEnabled, nyClock, syncDue } from "./scheduler.js";

describe("nightly sync timing", () => {
  it("reads New York time across daylight saving", () => {
    expect(nyClock(new Date("2026-01-15T23:30:00Z"))).toMatchObject({ date: "2026-01-15", hour: 18, weekday: "Thu" });
    expect(nyClock(new Date("2026-07-15T22:30:00Z"))).toMatchObject({ date: "2026-07-15", hour: 18, weekday: "Wed" });
  });

  it("is due on a weekday evening when today's run hasn't happened", () => {
    const evening = new Date("2026-10-16T22:30:00Z"); // Fri 18:30 ET
    expect(syncDue(evening, undefined)).toBe(true);
    expect(syncDue(evening, "2026-10-15 22:30:00")).toBe(true); // yesterday's run
    expect(syncDue(evening, "2026-10-16 22:15:00")).toBe(false); // already ran tonight
    expect(syncDue(evening, "2026-10-16 15:00:00")).toBe(true); // ran this morning, before the close
  });

  it("is not due before 18:00 New York time or on weekends", () => {
    expect(syncDue(new Date("2026-10-16T20:00:00Z"), undefined)).toBe(false); // Fri 16:00 ET
    expect(syncDue(new Date("2026-10-17T23:00:00Z"), undefined)).toBe(false); // Sat
  });

  it("syncs minute bars unless HISTORY_SYNC_MINUTE=0", () => {
    expect(minuteEnabled({})).toBe(true);
    expect(minuteEnabled({ HISTORY_SYNC_MINUTE: "1" })).toBe(true);
    expect(minuteEnabled({ HISTORY_SYNC_MINUTE: "0" })).toBe(false);
  });
});
