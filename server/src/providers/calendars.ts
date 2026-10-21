// Official US release schedules, merged into one upcoming-events list.
//
// Dates and times come straight from the agencies: BLS (iCalendar feed), BEA
// (release_dates.json), the Fed (FOMC calendar, kept as a constant below), FRED
// (release dates, only with FRED_API_KEY) and EIA (fixed weekly slot). None of them
// publish forecasts or actuals; those fields stay null in `econEvents` until a
// consensus source fills them.
import type { EconEvent } from "./econcalendar.js";

export type Release = {
  date: string; // YYYY-MM-DD, Eastern Time
  time: string | null; // HH:MM, Eastern Time; null when the agency gives no time
  event: string;
  agency: "BLS" | "BEA" | "Fed" | "FRED" | "EIA";
  country: "US";
  importance?: "High" | "Medium" | "Low";
  // Fixed-slot estimate (EIA): holiday shifts can't be known in advance.
  scheduled?: boolean;
};

const TTL_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;

// FOMC statement dates (second day of each meeting), from
// https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm — checked 2026-10-20.
// The Fed calls later meetings tentative until confirmed. Statement is 2:00 PM ET;
// minutes follow three weeks later at 2:00 PM ET.
const FOMC_STATEMENTS = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
];

const IMPORTANCE: Array<[RegExp, Release["importance"]]> = [
  [/^(FOMC|Employment Situation|Consumer Price Index|Gross Domestic Product|Personal Income and Outlays)/i, "High"],
  [/^(Producer Price Index|Job Openings|Employment Cost Index|U\.S\. International Trade|Productivity and Costs|Real Earnings|Retail Sales|U\.S\. Import and Export)/i, "Medium"],
  [/EIA Weekly Petroleum/i, "Medium"],
];

function importanceOf(event: string): Release["importance"] {
  return IMPORTANCE.find(([re]) => re.test(event))?.[1] ?? "Low";
}

const etFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function etParts(d: Date): { date: string; time: string } {
  const p = Object.fromEntries(etFormat.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Eastern wall-clock date + time to a UTC ISO string (handles EST/EDT). */
export function etToIso(date: string, time: string | null): string {
  const [h, m] = (time ?? "00:00").split(":").map(Number);
  const asUtc = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000;
  // ET is UTC-4 or UTC-5: try both and keep the one that round-trips.
  for (const offset of [4, 5]) {
    const candidate = new Date(asUtc + offset * 3_600_000);
    const back = etParts(candidate);
    if (back.date === date && back.time === (time ?? "00:00")) return candidate.toISOString();
  }
  return new Date(asUtc + 5 * 3_600_000).toISOString();
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** BLS iCalendar feed: one VEVENT per release, DTSTART in US-Eastern wall-clock time. */
export function parseBlsIcs(ics: string): Release[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const out: Release[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const start = block.match(/^DTSTART[^:\r\n]*:(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/m);
    const summary = block.match(/^SUMMARY:(.*?)\r?$/m)?.[1];
    if (!start || !summary) continue;
    const event = summary.replace(/\\(.)/g, "$1").trim();
    out.push({
      date: `${start[1]}-${start[2]}-${start[3]}`,
      time: start[4] ? `${start[4]}:${start[5]}` : null,
      event,
      agency: "BLS",
      country: "US",
      importance: importanceOf(event),
    });
  }
  return out;
}

/** BEA release_dates.json: { "<release name>": { release_dates: [UTC ISO...] }, file_last_updated }. */
export function parseBeaReleases(json: any): Release[] {
  const out: Release[] = [];
  const seen = new Set<string>();
  for (const [name, v] of Object.entries<any>(json ?? {})) {
    for (const iso of Array.isArray(v?.release_dates) ? v.release_dates : []) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      const { date, time } = etParts(d);
      const key = `${name}|${date}|${time}`;
      if (seen.has(key)) continue; // the file repeats some dates
      seen.add(key);
      out.push({ date, time, event: name, agency: "BEA", country: "US", importance: importanceOf(name) });
    }
  }
  return out;
}

export function fomcReleases(): Release[] {
  return FOMC_STATEMENTS.flatMap((date): Release[] => [
    { date, time: "14:00", event: "FOMC Statement and Rate Decision", agency: "Fed", country: "US", importance: "High" },
    { date: addDays(date, 21), time: "14:00", event: "FOMC Minutes", agency: "Fed", country: "US", importance: "Medium" },
  ]);
}

/** Every Wednesday in [from, to] at 10:30 ET. */
export function eiaReleases(from: string, to: string): Release[] {
  const out: Release[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 3) continue;
    out.push({ date, time: "10:30", event: "EIA Weekly Petroleum Status Report", agency: "EIA", country: "US", importance: "Medium", scheduled: true });
  }
  return out;
}

// FRED also republishes BLS/BEA/Fed-meeting releases; those come from the primary schedules above.
const FRED_DUPLICATES = /employment situation|consumer price|producer price|gross domestic|personal income|job openings|international trade|employment cost|productivity and costs|import.*export price|real earnings|state employment|metropolitan area employment|county employment|fomc|federal open market/i;

/** FRED /releases/dates payload: { release_dates: [{ release_name, date }] }. Dates only, no times. */
export function parseFredReleaseDates(json: any): Release[] {
  const out: Release[] = [];
  for (const r of Array.isArray(json?.release_dates) ? json.release_dates : []) {
    const event = String(r?.release_name ?? "").trim();
    if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(r?.date) || FRED_DUPLICATES.test(event)) continue;
    out.push({ date: r.date, time: null, event, agency: "FRED", country: "US", importance: "Low" });
  }
  return out;
}

function blsUserAgent(): string {
  const contact = process.env.SEC_EDGAR_CONTACT?.trim();
  if (!contact) throw new Error("bls: set SEC_EDGAR_CONTACT to your contact email (BLS rejects User-Agents without one)");
  return `OpenTerminal ${contact}`;
}

async function get(url: string, headers: Record<string, string>): Promise<Response> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res;
}

type Cached<T> = { at: number; value: T };
const fileCache = new Map<string, Cached<Release[]>>();

/** Drop cached source files (tests). */
export function clearCalendarCache(): void {
  fileCache.clear();
}

async function cachedSource(key: string, load: () => Promise<Release[]>): Promise<Release[]> {
  const hit = fileCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  fileCache.set(key, { at: Date.now(), value });
  return value;
}

const blsReleases = () =>
  cachedSource("bls", async () => parseBlsIcs(await (await get("https://www.bls.gov/schedule/news_release/bls.ics", { "User-Agent": blsUserAgent() })).text()));

const beaReleases = () =>
  cachedSource("bea", async () => parseBeaReleases(await (await get("https://apps.bea.gov/API/signup/release_dates.json", { "User-Agent": "openterminal/0.1" })).json()));

const fredReleases = (from: string, to: string) =>
  cachedSource(`fred:${from}:${to}`, async () => {
    const key = process.env.FRED_API_KEY?.trim();
    if (!key) return [];
    const params = new URLSearchParams({
      api_key: key,
      file_type: "json",
      realtime_start: from,
      realtime_end: to,
      include_release_dates_with_no_data: "true",
      order_by: "release_date",
      limit: "1000",
    });
    return parseFredReleaseDates(await (await get(`https://api.stlouisfed.org/fred/releases/dates?${params}`, { "User-Agent": "openterminal/0.1" })).json());
  });

/** Official releases dated within [from, to] (YYYY-MM-DD, inclusive), merged and sorted. */
export async function upcomingReleases(from: string, to: string): Promise<Release[]> {
  const sources = { BLS: blsReleases(), BEA: beaReleases(), FRED: fredReleases(from, to) };
  const settled = await Promise.allSettled(Object.values(sources));
  const rows: Release[] = [...fomcReleases(), ...eiaReleases(from, to)];
  Object.keys(sources).forEach((name, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") rows.push(...r.value);
    else console.warn(`calendars: ${name} unavailable: ${(r.reason as Error).message}`);
  });
  return rows
    .filter((r) => r.date >= from && r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.event.localeCompare(b.event));
}

const IMPACT: Record<NonNullable<Release["importance"]>, EconEvent["impact"]> = { High: "High", Medium: "Medium", Low: "Low" };

/** Same rows in the /econ-calendar shape; forecast/previous/actual stay null. */
export async function econEvents(from: string, to: string): Promise<EconEvent[]> {
  return (await upcomingReleases(from, to)).map((r) => ({
    title: r.scheduled ? `${r.event} (scheduled)` : r.event,
    country: "USD",
    date: etToIso(r.date, r.time),
    impact: IMPACT[r.importance ?? "Low"],
    forecast: null,
    previous: null,
    actual: null,
  }));
}
