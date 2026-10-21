import { describe, expect, it } from "vitest";
import { nyInstant, regularCloseAt, sessionAt } from "./session.js";

describe("trading sessions", () => {
  it("names the session for a New York time", () => {
    expect(sessionAt("2026-10-16T08:00:00Z")).toBe("pre"); // Fri 04:00
    expect(sessionAt("2026-10-16T13:29:59Z")).toBe("pre"); // 09:29:59
    expect(sessionAt("2026-10-16T13:30:00Z")).toBe("regular");
    expect(sessionAt("2026-10-16T20:00:00Z")).toBe("post"); // 16:00
    expect(sessionAt("2026-10-15T00:30:00Z")).toBe("overnight"); // Wed 20:30
    expect(sessionAt("2026-10-15T07:59:00Z")).toBe("overnight"); // Thu 03:59
  });

  it("has no overnight session on Friday and Saturday nights", () => {
    expect(sessionAt("2026-10-17T01:00:00Z")).toBeNull(); // Fri 21:00
    expect(sessionAt("2026-10-17T15:00:00Z")).toBeNull(); // Sat 11:00
    expect(sessionAt("2026-10-18T07:00:00Z")).toBeNull(); // Sun 03:00
    expect(sessionAt("2026-10-19T00:30:00Z")).toBe("overnight"); // Sun 20:30
  });

  it("switches sessions exactly on the minute", () => {
    const table: Array<[string, string | null]> = [
      ["2026-10-19T07:59:59Z", "overnight"], // Mon 03:59:59
      ["2026-10-19T08:00:00Z", "pre"], // Mon 04:00
      ["2026-10-19T13:29:59.999Z", "pre"],
      ["2026-10-19T19:59:59Z", "regular"], // 15:59:59
      ["2026-10-19T20:00:00Z", "post"], // 16:00
      ["2026-10-19T23:59:59Z", "post"], // 19:59:59
      ["2026-10-20T00:00:00Z", "overnight"], // Mon 20:00
      ["2026-10-16T23:59:00Z", "post"], // Fri 19:59
      ["2026-10-17T00:00:00Z", null], // Fri 20:00
      ["2026-10-17T07:59:00Z", null], // Sat 03:59
      ["2026-10-18T23:59:00Z", null], // Sun 19:59
      ["2026-10-19T00:00:00Z", "overnight"], // Sun 20:00
    ];
    for (const [at, session] of table) expect([at, sessionAt(at)]).toEqual([at, session]);
  });

  it("keeps the sessions on New York time on daylight-saving days", () => {
    expect(new Date(nyInstant("2026-03-08", 4)).toISOString()).toBe("2026-03-08T08:00:00.000Z"); // EDT from 02:00
    expect(new Date(nyInstant("2026-11-01", 4)).toISOString()).toBe("2026-11-01T09:00:00.000Z"); // EST from 02:00
    expect(new Date(regularCloseAt("2026-03-06")).toISOString()).toBe("2026-03-06T21:00:00.000Z"); // Fri before, EST
    expect(new Date(regularCloseAt("2026-03-09")).toISOString()).toBe("2026-03-09T20:00:00.000Z"); // Mon after, EDT
    expect(new Date(regularCloseAt("2026-11-02")).toISOString()).toBe("2026-11-02T21:00:00.000Z");
    expect(sessionAt("2026-03-09T03:30:00Z")).toBe("overnight"); // Sun 23:30 EDT
    expect(sessionAt("2026-11-01T05:30:00Z")).toBeNull(); // Sun 01:30 EDT, Saturday night
    expect(sessionAt("2026-11-02T05:30:00Z")).toBe("overnight"); // Mon 00:30 EST
    expect(sessionAt("2026-11-02T09:00:00Z")).toBe("pre"); // Mon 04:00 EST
  });

  it("converts New York wall time across daylight saving", () => {
    expect(new Date(regularCloseAt("2026-10-16")).toISOString()).toBe("2026-10-16T20:00:00.000Z"); // EDT
    expect(new Date(regularCloseAt("2026-12-01")).toISOString()).toBe("2026-12-01T21:00:00.000Z"); // EST
    expect(new Date(nyInstant("2026-10-16", 4)).toISOString()).toBe("2026-10-16T08:00:00.000Z");
  });
});
