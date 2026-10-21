import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let cal: typeof import("./alpaca-calendar.js");
let trading: typeof import("./alpaca-trading.js");
let alpaca: typeof import("./alpaca.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openterminal-calendar-test-"));
  process.env.DATA_DIR = tmpDir;
  cal = await import("./alpaca-calendar.js");
  trading = await import("./alpaca-trading.js");
  alpaca = await import("./alpaca.js");
});

afterAll(async () => {
  const { db } = await import("../db.js");
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  process.env.ALPACA_API_KEY_ID = "kid";
  process.env.ALPACA_API_SECRET_KEY = "sec";
  process.env.ALPACA_MAX_REQ_PER_MIN = "60000";
  alpaca.resetThrottle();
  trading.resetTradingBase();
  cal.resetCalendar();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.ALPACA_MAX_REQ_PER_MIN;
  delete process.env.ALPACA_TRADING_BASE;
});

const reply = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });

describe("calendar", () => {
  it("falls back to weekdays and a 16:00 close when nothing is loaded", () => {
    expect(cal.isTradingDay("2026-11-26")).toBe(true); // Thanksgiving, unknown yet
    expect(cal.isTradingDay("2026-11-28")).toBe(false); // Saturday
    expect(cal.sessionClose("2026-11-27")).toBe(Date.parse("2026-11-27T21:00:00Z"));
  });

  it("uses holidays and early closes once a year is loaded", () => {
    cal.loadCalendarRows(2026, [
      { date: "2026-11-25", open: "09:30", close: "16:00" },
      { date: "2026-11-27", open: "09:30", close: "13:00" },
    ]);
    expect(cal.isTradingDay("2026-11-25")).toBe(true);
    expect(cal.isTradingDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(cal.sessionClose("2026-11-27")).toBe(Date.parse("2026-11-27T18:00:00Z")); // 13:00 EST
    expect(cal.isTradingDay("2027-01-04")).toBe(true); // 2027 not loaded: weekday
    expect(cal.holidays(2026)).toContain("2026-11-26");
  });

  it("fetches a year, caches it, and falls back when the call fails", async () => {
    const fetchMock = vi.fn(async () => reply(200, [{ date: "2026-07-03", open: "09:30", close: "13:00" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await cal.ensureCalendar(2026)).toBe(true);
    expect(await cal.ensureCalendar(2026)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.origin + url.pathname).toBe("https://api.alpaca.markets/v2/calendar");
    expect(url.searchParams.get("start")).toBe("2026-01-01");
    expect(cal.isTradingDay("2026-07-06")).toBe(false); // not in the one-row fake calendar

    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    cal.resetCalendar();
    expect(await cal.ensureCalendar(2027)).toBe(false);
    expect(cal.isTradingDay("2027-03-01")).toBe(true);
  });
});

describe("trading host", () => {
  it("falls back to paper on 401/403 and remembers it", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.startsWith("https://api.") ? reply(403) : reply(200, { ok: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await trading.tradingFetch("/v2/calendar", {})).toEqual({ ok: 1 });
    expect(trading.tradingBase()).toBe("https://paper-api.alpaca.markets");
    await trading.tradingFetch("/v2/calendar", {});
    expect(fetchMock).toHaveBeenCalledTimes(3); // live, paper, then paper only
  });

  it("honours ALPACA_TRADING_BASE and fails when it is refused", async () => {
    process.env.ALPACA_TRADING_BASE = "https://example.test/";
    const fetchMock = vi.fn(async () => reply(401));
    vi.stubGlobal("fetch", fetchMock);
    await expect(trading.tradingFetch("/v2/calendar", {})).rejects.toThrow(/401/);
    expect(new URL((fetchMock.mock.calls[0] as unknown as [string])[0]).origin).toBe("https://example.test");
  });

  it("refuses any path but contracts and calendar", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(trading.tradingFetch("/v2/orders", {})).rejects.toThrow(/refusing/);
    await expect(trading.tradingFetch("/v2/account", {})).rejects.toThrow(/refusing/);
  });
});
