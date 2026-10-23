import type { ExtendedHours, Quote } from "./api";

export const SORTS = [
  { id: "default", label: "Default" },
  { id: "chgDesc", label: "% chg H–L" },
  { id: "chgAsc", label: "% chg L–H" },
  { id: "priceDesc", label: "Price H–L" },
  { id: "symAsc", label: "Symbol A–Z" },
] as const;

export type SortId = (typeof SORTS)[number]["id"];

/** Symbols in the order the sort asks for; symbols without a quote go last. `default` keeps the list's own order. */
export function sortSymbols(symbols: string[], quotes: Map<string, Quote>, sort: SortId): string[] {
  if (sort === "default") return symbols;
  if (sort === "symAsc") return [...symbols].sort((a, b) => a.localeCompare(b));
  const key = (s: string) => (sort === "priceDesc" ? quotes.get(s)?.price : quotes.get(s)?.changePercent) ?? null;
  const dir = sort === "chgAsc" ? 1 : -1;
  return [...symbols].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (x - y) * dir;
  });
}

const SESSION_SHORT = { post: "After", overnight: "Night", pre: "Pre" } as const;

/** The extended session that traded last, as the row's second line. */
export function latestSession(ext: ExtendedHours | undefined): { label: string; price: number; changePercent: number | null } | null {
  if (!ext) return null;
  let best: { key: keyof typeof SESSION_SHORT; time: number } | null = null;
  for (const key of ["post", "overnight", "pre"] as const) {
    const s = ext[key];
    if (!s) continue;
    const time = Date.parse(s.time);
    if (!best || time > best.time) best = { key, time };
  }
  if (!best) return null;
  const s = ext[best.key]!;
  return { label: SESSION_SHORT[best.key], price: s.price, changePercent: s.changePercent };
}
