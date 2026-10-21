export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

export type Quote = {
  symbol: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  source: string;
  asOf?: string;
  /** Alpaca quotes only: true while the regular price moves with every trade. */
  live?: boolean;
  /** Extended-hours prices since the last regular close, where the source has them. */
  extended?: ExtendedHours;
  sector?: string;
  label?: string;
};

export type SessionPrice = {
  price: number;
  /** From the last regular close. */
  change: number | null;
  changePercent: number | null;
  time: string;
  live: boolean;
};

export type ExtendedHours = { post: SessionPrice | null; overnight: SessionPrice | null; pre: SessionPrice | null };

/** Extended sessions in the order they trade after a regular close. */
export const EXTENDED_SESSIONS = [
  { key: "post", label: "After hours", short: "After hrs" },
  { key: "overnight", label: "Overnight", short: "Overnight" },
  { key: "pre", label: "Pre-market", short: "Pre-mkt" },
] as const;

/** "+4.53 (+2.09%)" */
export function fmtChange(change: number | null | undefined, pct: number | null | undefined): string {
  const sign = (n: number | null | undefined) => (n !== null && n !== undefined && n > 0 ? "+" : "");
  return `${sign(change)}${fmt(change)} (${sign(pct)}${fmt(pct)}%)`;
}

export function fmtPct(pct: number | null | undefined): string {
  return `${pct !== null && pct !== undefined && pct > 0 ? "+" : ""}${fmt(pct)}%`;
}

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function pctClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return "dim";
  return n >= 0 ? "up" : "down";
}
