import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eiaReleases,
  econEvents,
  etToIso,
  clearCalendarCache,
  fomcReleases,
  parseBeaReleases,
  parseBlsIcs,
  parseFredReleaseDates,
  upcomingReleases,
} from "./calendars.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SEQUENCE:1",
  "UID:a",
  "DTSTART;TZID=US-Eastern:20261110T083000",
  "DURATION:PT0M",
  "SUMMARY:Consumer Price Index",
  "CATEGORIES:IMPORTANT, BLS",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=US-Eastern:20261106T083000",
  "SUMMARY:Employment Situation",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=US-Eastern:20261112T100000",
  "SUMMARY:Metropolitan Area Employment\\, Unemployment and",
  "  Wages",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const BEA = {
  "Gross Domestic Product": { release_dates: ["2026-10-29T12:30:00+00:00", "2026-11-25T13:30:00+00:00"] },
  "U.S. International Trade in Goods and Services": { release_dates: ["2026-11-05T13:30:00+00:00", "2026-11-05T13:30:00+00:00"] },
  file_last_updated: "2026-10-01T00:00:00",
};

describe("BLS ICS parsing", () => {
  it("reads Eastern wall-clock dates, unescapes and unfolds summaries", () => {
    expect(parseBlsIcs(ICS)).toEqual([
      { date: "2026-11-10", time: "08:30", event: "Consumer Price Index", agency: "BLS", country: "US", importance: "High" },
      { date: "2026-11-06", time: "08:30", event: "Employment Situation", agency: "BLS", country: "US", importance: "High" },
      { date: "2026-11-12", time: "10:00", event: "Metropolitan Area Employment, Unemployment and Wages", agency: "BLS", country: "US", importance: "Low" },
    ]);
  });
});

describe("BEA parsing", () => {
  it("converts UTC release times to Eastern, once per slot, and skips the file marker", () => {
    expect(parseBeaReleases(BEA)).toEqual([
      { date: "2026-10-29", time: "08:30", event: "Gross Domestic Product", agency: "BEA", country: "US", importance: "High" },
      { date: "2026-11-25", time: "08:30", event: "Gross Domestic Product", agency: "BEA", country: "US", importance: "High" },
      { date: "2026-11-05", time: "08:30", event: "U.S. International Trade in Goods and Services", agency: "BEA", country: "US", importance: "Medium" },
    ]);
  });
});

describe("FRED release dates", () => {
  it("keeps releases the primary schedules don't cover and drops malformed rows", () => {
    expect(
      parseFredReleaseDates({
        release_dates: [
          { release_id: 1, release_name: "Advance Retail Sales", date: "2026-11-17" },
          { release_id: 2, release_name: "Consumer Price Index", date: "2026-11-10" },
          { release_id: 3, release_name: "Bad", date: "soon" },
        ],
      })
    ).toEqual([{ date: "2026-11-17", time: null, event: "Advance Retail Sales", agency: "FRED", country: "US", importance: "Low" }]);
  });
});

describe("fixed schedules", () => {
  it("puts FOMC minutes three weeks after each statement", () => {
    const rows = fomcReleases();
    expect(rows).toContainEqual(expect.objectContaining({ date: "2026-10-28", time: "14:00", event: "FOMC Statement and Rate Decision" }));
    expect(rows).toContainEqual(expect.objectContaining({ date: "2026-11-18", time: "14:00", event: "FOMC Minutes" }));
  });

  it("lists EIA petroleum reports on Wednesdays only", () => {
    expect(eiaReleases("2026-10-19", "2026-11-02").map((r) => r.date)).toEqual(["2026-10-21", "2026-10-28"]);
  });

  it("converts Eastern times across the DST change", () => {
    expect(etToIso("2026-10-28", "14:00")).toBe("2026-10-28T18:00:00.000Z");
    expect(etToIso("2026-11-18", "14:00")).toBe("2026-11-18T19:00:00.000Z");
  });
});

describe("upcomingReleases", () => {
  beforeEach(() => {
    clearCalendarCache();
    vi.stubEnv("SEC_EDGAR_CONTACT", "ops@example.com");
    vi.stubEnv("FRED_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("merges sources inside the window in time order and sends a contact User-Agent to BLS", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("bls.gov")
        ? { ok: true, status: 200, text: async () => ICS }
        : { ok: true, status: 200, json: async () => BEA }
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const rows = await upcomingReleases("2026-11-05", "2026-11-11");
    expect(rows.map((r) => `${r.date} ${r.time} ${r.event}`)).toEqual([
      "2026-11-05 08:30 U.S. International Trade in Goods and Services",
      "2026-11-06 08:30 Employment Situation",
      "2026-11-10 08:30 Consumer Price Index",
      "2026-11-11 10:30 EIA Weekly Petroleum Status Report",
    ]);
    expect(fetchMock.mock.calls.find(([u]) => String(u).includes("bls.gov"))?.[1].headers["User-Agent"]).toBe("OpenTerminal ops@example.com");
  });

  it("keeps going when one source fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => "" })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await upcomingReleases("2026-10-21", "2026-10-29");
    expect(rows.some((r) => r.agency === "Fed")).toBe(true);
    expect(rows.some((r) => r.agency === "EIA")).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("maps to the /econ-calendar shape with null consensus fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => "" })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await econEvents("2026-10-28", "2026-10-28");
    expect(events).toContainEqual({
      title: "FOMC Statement and Rate Decision",
      country: "USD",
      date: "2026-10-28T18:00:00.000Z",
      impact: "High",
      forecast: null,
      previous: null,
      actual: null,
    });
  });
});
