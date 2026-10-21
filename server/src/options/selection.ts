import type { OptionPosition } from "../scan/contracts.js";

// Which contracts to stream: every held option, then one call and one put at
// the strike nearest the price on the nearest usable expiry, per underlying.
// Pure; the sweep supplies prices and the available expiries/strikes.

export type ExpiryStrikes = { expiry: string; strikes: number[] };

export type SelectionInput = {
  /** Priority order: holdings' underlyings first, then the universe order. */
  underlyings: string[];
  prices: Map<string, number>;
  /** Available expiries with their strikes, per underlying. */
  chains: Map<string, ExpiryStrikes[]>;
  holdings: OptionPosition[];
  cap: number;
  /** Smallest days-to-expiry the streamed pair may have. */
  minDte: number;
  /** New York date, YYYY-MM-DD. */
  today: string;
  /** Last selection's pairs, for the re-centring hysteresis. */
  previous?: Map<string, Pair>;
};

export type Pair = { expiry: string; strike: number; call: string; put: string };

export type Selection = {
  contracts: string[];
  pairs: Map<string, Pair>;
  /** Underlyings left out because the cap was reached. */
  skipped: string[];
  /** Held options dropped because holdings alone exceeded the cap. */
  heldDropped: number;
};

/** Re-centre only once another strike is nearer by more than this share of the strike gap. */
export const HYSTERESIS = 0.25;

/** NVDA, 2026-11-02, call, 215 -> NVDA261102C00215000. */
export function buildOcc(root: string, expiry: string, right: "call" | "put", strike: number): string {
  const [y, m, d] = expiry.split("-");
  return `${root}${y.slice(2)}${m}${d}${right === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Strike closest to `price`, keeping `prev` unless the best is nearer by more than HYSTERESIS of the local strike gap. */
export function pickStrike(strikes: number[], price: number, prev?: number): number | null {
  if (strikes.length === 0) return null;
  const sorted = [...strikes].sort((a, b) => a - b);
  let best = sorted[0];
  for (const s of sorted) if (Math.abs(s - price) < Math.abs(best - price)) best = s;
  if (prev !== undefined && sorted.includes(prev) && prev !== best) {
    const i = sorted.indexOf(best);
    const gap = Math.min(...[sorted[i + 1] - best, best - sorted[i - 1]].filter((g) => Number.isFinite(g) && g > 0));
    if (Number.isFinite(gap) && Math.abs(prev - price) - Math.abs(best - price) <= HYSTERESIS * gap) return prev;
  }
  return best;
}

export function selectContracts(input: SelectionInput): Selection {
  const { cap, minDte, today } = input;
  const contracts: string[] = [];
  const seen = new Set<string>();
  const add = (occ: string) => {
    if (seen.has(occ)) return;
    seen.add(occ);
    contracts.push(occ);
  };

  // Held options come first; only if they alone exceed the cap are the last ones dropped.
  let heldDropped = 0;
  for (const h of input.holdings) {
    if (!seen.has(h.occ) && contracts.length >= cap) heldDropped++;
    else add(h.occ);
  }

  const pairs = new Map<string, Pair>();
  const skipped: string[] = [];
  for (const u of input.underlyings) {
    const price = input.prices.get(u);
    const chain = input.chains.get(u);
    if (price === undefined || !chain) continue;
    const usable = chain.filter((c) => c.strikes.length > 0 && daysBetween(today, c.expiry) >= minDte).sort((a, b) => a.expiry.localeCompare(b.expiry));
    const front = usable[0];
    if (!front) continue;
    const prev = input.previous?.get(u);
    const strike = pickStrike(front.strikes, price, prev?.expiry === front.expiry ? prev.strike : undefined);
    if (strike === null) continue;
    const call = buildOcc(u, front.expiry, "call", strike);
    const put = buildOcc(u, front.expiry, "put", strike);
    const extra = [call, put].filter((o) => !seen.has(o)).length;
    if (contracts.length + extra > cap) {
      skipped.push(u);
      continue;
    }
    add(call);
    add(put);
    pairs.set(u, { expiry: front.expiry, strike, call, put });
  }
  return { contracts, pairs, skipped, heldDropped };
}
