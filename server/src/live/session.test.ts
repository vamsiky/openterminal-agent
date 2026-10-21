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

  it("converts New York wall time across daylight saving", () => {
    expect(new Date(regularCloseAt("2026-10-16")).toISOString()).toBe("2026-10-16T20:00:00.000Z"); // EDT
    expect(new Date(regularCloseAt("2026-12-01")).toISOString()).toBe("2026-12-01T21:00:00.000Z"); // EST
    expect(new Date(nyInstant("2026-10-16", 4)).toISOString()).toBe("2026-10-16T08:00:00.000Z");
  });
});
