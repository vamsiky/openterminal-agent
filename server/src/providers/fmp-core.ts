// Shared plumbing for every Financial Modeling Prep module: the stable-API
// base URL, the request limiter, the response cache, error types and parsing
// helpers. fmp.ts and the fmp-<area>.ts research providers build on this.

export const BASE = "https://financialmodelingprep.com/stable";

const CONCURRENCY = 4;

/** Thrown by every function when FMP_API_KEY is unset, so routes can answer with a clear message. */
export class FmpNotConfigured extends Error {
  constructor() {
    super("FMP_API_KEY is not set: add a Financial Modeling Prep key to .env to enable this");
    this.name = "FmpNotConfigured";
  }
}

export class FmpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FmpError";
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.FMP_API_KEY?.trim());
}

export function requireKey(): string {
  const key = process.env.FMP_API_KEY?.trim();
  if (!key) throw new FmpNotConfigured();
  return key;
}

/** Requests per minute from FMP_MAX_REQ_PER_MIN; blank or invalid means the default. */
export function maxRequestsPerMinute(raw = process.env.FMP_MAX_REQ_PER_MIN): number {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) && n >= 1 ? n : 300;
}

// Spacing limiter: FMP's plans allow 300 calls/min (Starter), 750 (Premium)
// and 3,000 (Ultimate); FMP_MAX_REQ_PER_MIN raises it.
let nextSlot = 0;
async function throttle(): Promise<void> {
  const gap = 60_000 / maxRequestsPerMinute();
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gap;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export const cache = new Map<string, { at: number; value: unknown }>();

/** Test hook: reset the limiter and cache between tests. */
export function resetState(): void {
  nextSlot = 0;
  cache.clear();
}

export async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * FMP writes share classes with a dash (BRK-B, BF-B) and answers nothing for
 * the dot form the app uses (BRK.B), checked 2026-10-21.
 */
export function fmpSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/^([A-Z]+)\.([A-Z])$/, "$1-$2");
}

export async function get(path: string, params: Record<string, string | number | undefined>): Promise<any> {
  const key = requireKey();
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const value = k === "symbol" ? fmpSymbol(String(v)) : k === "symbols" ? String(v).split(",").map(fmpSymbol).join(",") : String(v);
    url.searchParams.set(k, value);
  }
  url.searchParams.set("apikey", key);

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, (isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Never echo the URL: it carries the key.
      throw new FmpError(res.status, `fmp ${res.status} for /${path}${res.status === 401 ? " (check FMP_API_KEY)" : ""}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    // FMP reports some errors as 200 with {"Error Message": "..."}.
    if (json && !Array.isArray(json) && typeof json["Error Message"] === "string") {
      throw new FmpError(200, `fmp /${path}: ${json["Error Message"].slice(0, 200)}`);
    }
    return json;
  }
}

export async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function unixDay(date: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000) : null;
}
