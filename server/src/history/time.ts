const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The New York trading date (YYYY-MM-DD) of an instant. Alpaca stamps daily bars at New York midnight in UTC. */
export function tradingDay(instant: string | number): string {
  return nyDate.format(typeof instant === "number" ? new Date(instant * 1000) : new Date(instant));
}
