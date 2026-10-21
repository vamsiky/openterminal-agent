// European Black-Scholes-Merton with a continuous dividend yield. American
// options are priced as European: close enough for the near-the-money,
// short-dated contracts the scans look at, and it keeps IV a pure function of
// the quote.

export type Right = "call" | "put";

/** Annual risk-free rate from RISK_FREE_RATE (default 0.04). */
export function riskFreeRate(raw = process.env.RISK_FREE_RATE): number {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) ? n : 0.04;
}

// Complementary error function, Chebyshev fit (Numerical Recipes), |error| < 1.2e-7.
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

export const normCdf = (x: number): number => 0.5 * erfc(-x / Math.SQRT2);
const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export type BsInput = {
  right: Right;
  spot: number;
  strike: number;
  /** Years to expiry. */
  t: number;
  rate: number;
  /** Continuous dividend yield; 0 when unknown. */
  div?: number;
  vol: number;
};

function d1d2({ spot, strike, t, rate, div = 0, vol }: BsInput): [number, number] {
  const d1 = (Math.log(spot / strike) + (rate - div + 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
  return [d1, d1 - vol * Math.sqrt(t)];
}

/** Intrinsic value discounted to today; the floor a European price can't go below. */
export function lowerBound(i: Omit<BsInput, "vol">): number {
  const fwd = i.spot * Math.exp(-(i.div ?? 0) * i.t);
  const disc = i.strike * Math.exp(-i.rate * i.t);
  return Math.max(0, i.right === "call" ? fwd - disc : disc - fwd);
}

export function price(i: BsInput): number {
  const q = i.div ?? 0;
  if (i.t <= 0 || i.vol <= 0) return lowerBound(i);
  const [d1, d2] = d1d2(i);
  const fwd = i.spot * Math.exp(-q * i.t);
  const disc = i.strike * Math.exp(-i.rate * i.t);
  return i.right === "call" ? fwd * normCdf(d1) - disc * normCdf(d2) : disc * normCdf(-d2) - fwd * normCdf(-d1);
}

export type Greeks = {
  delta: number;
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per volatility point (1% = 0.01). */
  vega: number;
};

export function greeks(i: BsInput): Greeks {
  const q = i.div ?? 0;
  const [d1, d2] = d1d2(i);
  const sq = Math.sqrt(i.t);
  const eq = Math.exp(-q * i.t);
  const er = Math.exp(-i.rate * i.t);
  const pdf = normPdf(d1);
  const call = i.right === "call";
  const delta = call ? eq * normCdf(d1) : -eq * normCdf(-d1);
  const gamma = (eq * pdf) / (i.spot * i.vol * sq);
  const vega = (i.spot * eq * pdf * sq) / 100;
  const decay = -(i.spot * eq * pdf * i.vol) / (2 * sq);
  const yearly = call
    ? decay - i.rate * i.strike * er * normCdf(d2) + q * i.spot * eq * normCdf(d1)
    : decay + i.rate * i.strike * er * normCdf(-d2) - q * i.spot * eq * normCdf(-d1);
  return { delta, gamma, theta: yearly / 365, vega };
}

const VOL_MIN = 1e-4;
const VOL_MAX = 8;

/**
 * Implied volatility of a market price: Newton on vega, falling back to
 * bisection when a step leaves the bracket or vega is flat. Null when the
 * price is below intrinsic, above the no-arbitrage ceiling, or t <= 0.
 */
export function impliedVol(i: Omit<BsInput, "vol">, target: number, tol = 1e-7): number | null {
  if (!(target > 0) || !(i.t > 0) || !(i.spot > 0) || !(i.strike > 0)) return null;
  const q = i.div ?? 0;
  const ceiling = i.right === "call" ? i.spot * Math.exp(-q * i.t) : i.strike * Math.exp(-i.rate * i.t);
  if (target < lowerBound(i) - 1e-9 || target >= ceiling) return null;

  let lo = VOL_MIN;
  let hi = VOL_MAX;
  if (price({ ...i, vol: lo }) > target + tol) return null; // below what the lowest vol can produce
  if (price({ ...i, vol: hi }) < target - tol) return null;
  let vol = 0.3;
  for (let n = 0; n < 50; n++) {
    const diff = price({ ...i, vol }) - target;
    if (Math.abs(diff) < tol) return vol;
    if (diff > 0) hi = vol;
    else lo = vol;
    const [d1] = d1d2({ ...i, vol });
    const vegaRaw = i.spot * Math.exp(-q * i.t) * normPdf(d1) * Math.sqrt(i.t);
    const next = vegaRaw > 1e-10 ? vol - diff / vegaRaw : NaN;
    vol = next > lo && next < hi ? next : (lo + hi) / 2;
  }
  // Bisection to the end if Newton never settled.
  for (let n = 0; n < 100; n++) {
    vol = (lo + hi) / 2;
    const diff = price({ ...i, vol }) - target;
    if (Math.abs(diff) < tol || hi - lo < 1e-10) return vol;
    if (diff > 0) hi = vol;
    else lo = vol;
  }
  return vol;
}

const YEAR_MS = 365 * 86_400_000;

/** Years from `now` to the 16:00 ET close of an expiry date (YYYY-MM-DD); the minimum is a minute so 0DTE stays defined. */
export function yearsToExpiry(expiry: string, now: number, closeAt: (day: string) => number): number {
  return Math.max(closeAt(expiry) - now, 60_000) / YEAR_MS;
}

/** IV from a bid/ask pair: the mid, or null with no bid or a crossed/empty quote. */
export function midPrice(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || !(bid > 0) || !(ask > 0) || ask < bid) return null;
  return (bid + ask) / 2;
}
