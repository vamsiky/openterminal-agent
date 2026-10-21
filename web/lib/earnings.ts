import { apiGet } from "./api";
import { symbolsParam } from "./symbol";

export type Timing = "bmo" | "amc" | "dmh";

export type EarningsEntry = {
  symbol: string;
  timing?: Timing | null;
  timingBasis?: { matched: number; total: number } | null;
  nextEarningsDate: number | null; // unix seconds, UTC midnight
  lastEarningsDate: number | null;
  epsForecast: number | null;
  revenueForecast?: number | null;
  lastEps?: number | null;
  lastEpsEstimate?: number | null;
  lastSurprisePercent?: number | null;
  lastRevenue?: number | null;
};

export const CALENDAR_CHUNK = 150;

/** Earnings for any number of symbols: chunked requests run in parallel, results in symbol order. */
export async function fetchCalendar(symbols: string[]): Promise<EarningsEntry[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += CALENDAR_CHUNK) chunks.push(symbols.slice(i, i + CALENDAR_CHUNK));
  const results = await Promise.all(chunks.map((c) => apiGet<EarningsEntry[]>(`/api/calendar?symbols=${symbolsParam(c)}`)));
  return results.flat();
}

export const GROUP_LABELS = ["Today", "Tomorrow", "This week", "Next week", "Later"] as const;
export type GroupLabel = (typeof GROUP_LABELS)[number];

export type UpcomingGroup = { label: GroupLabel; rows: Array<EarningsEntry & { days: number }> };
export type EarningsGroups = {
  upcoming: UpcomingGroup[];
  reported: Array<EarningsEntry & { days: number }>; // last 7 days, newest first
  noDate: EarningsEntry[];
};

const DAY = 86_400;
const TIMING_RANK: Record<Timing, number> = { bmo: 0, dmh: 1, amc: 2 };
const timingRank = (t: Timing | null | undefined) => (t ? TIMING_RANK[t] : 3);

export const timingLabel = (t: Timing | null | undefined) => (t ? t.toUpperCase() : "—");

const WHEN: Record<Timing, string> = { bmo: "before the open", amc: "after close", dmh: "during market hours" };

/** "Usually after close: 4 of 4 recent earnings releases (FMP press releases)"; empty when unknown. */
export function timingTitle(e: Pick<EarningsEntry, "timing" | "timingBasis">): string {
  if (!e.timing) return "Time of day unknown";
  const basis = e.timingBasis ? `: ${e.timingBasis.matched} of ${e.timingBasis.total} recent earnings releases (FMP press releases)` : "";
  return `Usually ${WHEN[e.timing]}${basis}`;
}
const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Calendar-day bucket of an upcoming report, `days` after today (New York), weeks running Monday to Sunday. */
function bucket(days: number, daysToSunday: number): GroupLabel {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days <= daysToSunday) return "This week";
  if (days <= daysToSunday + 7) return "Next week";
  return "Later";
}

/** Splits entries into upcoming reports by relative day, reports of the last 7 days, and symbols with no date. */
export function groupEarnings(entries: EarningsEntry[], now: Date): EarningsGroups {
  const today = Date.parse(nyDay.format(now) + "T00:00:00Z") / 1000;
  const isoDow = new Date(today * 1000).getUTCDay() || 7;
  const daysToSunday = 7 - isoDow;
  const upcoming = new Map<GroupLabel, UpcomingGroup["rows"]>();
  const reported: EarningsGroups["reported"] = [];
  const noDate: EarningsEntry[] = [];
  for (const e of entries) {
    let placed = false;
    if (e.lastEarningsDate !== null && e.lastEps != null) {
      const days = Math.round((e.lastEarningsDate - today) / DAY);
      if (days < 0 && days >= -7) {
        reported.push({ ...e, days });
        placed = true;
      }
    }
    if (e.nextEarningsDate !== null) {
      const days = Math.round((e.nextEarningsDate - today) / DAY);
      if (days >= 0) {
        const label = bucket(days, daysToSunday);
        upcoming.set(label, [...(upcoming.get(label) ?? []), { ...e, days }]);
        placed = true;
      }
    }
    if (!placed && e.nextEarningsDate === null) noDate.push(e);
  }
  reported.sort((a, b) => b.days - a.days || timingRank(a.timing) - timingRank(b.timing) || a.symbol.localeCompare(b.symbol));
  return {
    upcoming: GROUP_LABELS.filter((l) => upcoming.has(l)).map((label) => ({
      label,
      rows: upcoming.get(label)!.sort((a, b) => a.days - b.days || timingRank(a.timing) - timingRank(b.timing) || a.symbol.localeCompare(b.symbol)),
    })),
    reported,
    noDate,
  };
}

/** "Wed Oct 22" for a UTC-midnight unix timestamp. */
export function fmtDay(ts: number): string {
  const part = (o: Intl.DateTimeFormatOptions) => new Date(ts * 1000).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return `${part({ weekday: "short" })} ${part({ month: "short", day: "numeric" })}`;
}

export const inDays = (days: number) => (days === 0 ? "today" : `in ${days}d`);
