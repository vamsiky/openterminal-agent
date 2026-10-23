import { fmt, fmtBig, fmtIv } from "../../lib/api";
import type { OptionRow } from "../../lib/chain";

/** A price cell: zero or missing quotes are dashes. */
export const px = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "—" : fmt(v));
export const vol = (v: number | null | undefined) => (v ? fmtBig(v) : "—");
export const delta = (r: OptionRow | undefined) => (r?.delta === null || r?.delta === undefined ? "—" : fmt(r.delta));
export const iv = (r: OptionRow | undefined) => (r?.impliedVolatility ? fmtIv(r.impliedVolatility) : "—");

export function greeksTitle(r: OptionRow | undefined): string | undefined {
  if (!r || r.delta == null) return undefined;
  return `Δ ${fmt(r.delta, 3)} · Γ ${fmt(r.gamma, 4)} · Θ ${fmt(r.theta, 3)} · V ${fmt(r.vega, 3)} · ρ ${fmt(r.rho, 3)}`;
}

export function expiryLabel(d: string): string {
  const [, m, day] = d.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${day}`;
}
