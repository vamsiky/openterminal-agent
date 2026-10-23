// Option chain math for the full chain and the compact chain in stock details. Pure functions over
// the /api/options/:symbol shape (copied from server/src/providers/alpaca-options.ts).

export type OptionRow = {
  contract?: string;
  strike: number | null;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility?: number | null;
  inTheMoney: boolean;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
};

export type Chain = {
  symbol: string;
  underlyingPrice: number | null;
  expirationDates: string[];
  selectedDate: string | null;
  calls: OptionRow[];
  puts: OptionRow[];
};

export type StrikeRow = { strike: number; call?: OptionRow; put?: OptionRow };
export type Side = "both" | "calls" | "puts";
export const BANDS = [0.1, 0.2, 0.3] as const;

/** Calls and puts joined by strike, ascending. */
export function joinStrikes(calls: OptionRow[], puts: OptionRow[]): StrikeRow[] {
  const by = new Map<number, StrikeRow>();
  for (const c of calls) if (c.strike !== null) by.set(c.strike, { ...by.get(c.strike), strike: c.strike, call: c });
  for (const p of puts) if (p.strike !== null) by.set(p.strike, { ...by.get(p.strike), strike: p.strike, put: p });
  return [...by.values()].sort((a, b) => a.strike - b.strike);
}

/** Today's date in New York as YYYY-MM-DD: the market's calendar, whatever the viewer's timezone. */
export function todayET(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Whole calendar days from `today` to `expiry` (both YYYY-MM-DD). */
export function daysLeft(expiry: string, today: string): number {
  const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((ms(expiry) - ms(today)) / 86_400_000);
}

/** The nearest expiry after today: same-day contracts carry no IV or greeks. Falls back to the first listed. */
export function defaultExpiry(expiries: string[], today: string): string | null {
  const sorted = [...expiries].sort();
  return sorted.find((d) => daysLeft(d, today) >= 1) ?? sorted[0] ?? null;
}

const byDistance = (spot: number) => (a: StrikeRow, b: StrikeRow) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike;

/** The strike closest to spot; the lower one on a tie. */
export function atmStrike(rows: StrikeRow[], spot: number | null): StrikeRow | null {
  if (spot === null || rows.length === 0) return null;
  return [...rows].sort(byDistance(spot))[0];
}

/** Strikes within ±band of spot (a fraction, 0.1 = 10%). */
export function strikeBand(rows: StrikeRow[], spot: number | null, band: number): StrikeRow[] {
  if (spot === null) return rows;
  return rows.filter((r) => Math.abs(r.strike / spot - 1) <= band + 1e-9);
}

/** The `n` strikes closest to spot, ascending. */
export function nearestStrikes(rows: StrikeRow[], spot: number | null, n: number): StrikeRow[] {
  if (spot === null) return rows.slice(0, n);
  return [...rows].sort(byDistance(spot)).slice(0, n).sort((a, b) => a.strike - b.strike);
}

/** Midpoint of a live two-sided quote; null when either side is missing or zero. */
export function mid(r: OptionRow | undefined): number | null {
  return r && r.bid !== null && r.ask !== null && r.ask > 0 ? (r.bid + r.ask) / 2 : null;
}

/** Index of the row the spot marker goes before: the first strike above spot, or rows.length. */
export function spotRowIndex(rows: StrikeRow[], spot: number | null): number {
  if (spot === null) return rows.length;
  const i = rows.findIndex((r) => r.strike > spot);
  return i < 0 ? rows.length : i;
}

export function isItm(side: "call" | "put", strike: number, spot: number | null): boolean {
  if (spot === null) return false;
  return side === "call" ? strike < spot : strike > spot;
}

export type ChainStats = {
  atm: number | null;
  straddle: number | null;
  /** Straddle as a fraction of spot. */
  impliedMove: number | null;
  atmIv: number | null;
  callVolume: number;
  putVolume: number;
  putCallRatio: number | null;
};

/** Stats over the whole expiry (not the displayed band). */
export function chainStats(rows: StrikeRow[], spot: number | null): ChainStats {
  const atm = atmStrike(rows, spot);
  const cm = mid(atm?.call), pm = mid(atm?.put);
  const straddle = cm !== null && pm !== null ? cm + pm : null;
  const ivs = [atm?.call?.impliedVolatility, atm?.put?.impliedVolatility].filter((v): v is number => typeof v === "number" && v > 0);
  const sum = (pick: (r: StrikeRow) => OptionRow | undefined) => rows.reduce((a, r) => a + (pick(r)?.volume ?? 0), 0);
  const callVolume = sum((r) => r.call), putVolume = sum((r) => r.put);
  return {
    atm: atm?.strike ?? null,
    straddle,
    impliedMove: straddle !== null && spot ? straddle / spot : null,
    atmIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
    callVolume,
    putVolume,
    putCallRatio: callVolume > 0 ? putVolume / callVolume : null,
  };
}
