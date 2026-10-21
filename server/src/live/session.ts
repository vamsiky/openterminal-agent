// US equity trading sessions on the New York clock.
//   pre-market   04:00–09:30
//   regular      09:30–16:00
//   after hours  16:00–20:00
//   overnight    20:00–04:00 (Blue Ocean ATS, Sunday to Thursday nights)
// Early-close days (13:00) aren't known here, so their 13:00–16:00 trades count as regular.

export type Session = "pre" | "regular" | "post" | "overnight";

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});

function parts(ms: number) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, minutes: +p.hour * 60 + +p.minute, weekday: p.weekday };
}

const toMs = (instant: string | number | Date) =>
  instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);

/** The session an instant falls in, or null on weekends outside the Sunday-night overnight session. */
export function sessionAt(instant: string | number | Date): Session | null {
  const { minutes, weekday } = parts(toMs(instant));
  const weekend = weekday === "Sat" || weekday === "Sun";
  if (minutes >= 20 * 60) return weekday === "Fri" || weekday === "Sat" ? null : "overnight";
  if (minutes < 4 * 60) return weekday === "Sat" || weekday === "Sun" ? null : "overnight";
  if (weekend) return null;
  if (minutes < 9 * 60 + 30) return "pre";
  if (minutes < 16 * 60) return "regular";
  return "post";
}

/** Epoch ms of hh:mm New York time on a New York date (YYYY-MM-DD). */
export function nyInstant(day: string, hh: number, mm = 0): number {
  const guess = Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  const p = parts(guess);
  const offset = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60) - guess;
  return guess - offset;
}

/** When the regular session of a New York date closes. */
export function regularCloseAt(day: string): number {
  return nyInstant(day, 16);
}
