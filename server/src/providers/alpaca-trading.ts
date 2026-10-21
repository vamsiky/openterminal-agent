import { isConfigured, throttle } from "./alpaca.js";

// Read-only reference data from Alpaca's trading API: the option contract list
// (open interest) and the market calendar. The keys are account keys, so this
// module can reach exactly two GET endpoints and nothing else; orders,
// positions and account endpoints are refused before any request is made.
//
// Whether the account is live or paper isn't known, so the live host is tried
// first and the paper host answers when the live one says 401/403; whichever
// works is remembered. ALPACA_TRADING_BASE pins the host.

const LIVE_BASE = "https://api.alpaca.markets";
const PAPER_BASE = "https://paper-api.alpaca.markets";
const ALLOWED_PATHS = new Set(["/v2/options/contracts", "/v2/calendar"]);

let resolvedBase: string | null = null;

/** Test hook: forget which host worked. */
export function resetTradingBase(): void {
  resolvedBase = null;
}

export function tradingBase(): string | null {
  return resolvedBase;
}

function candidates(): string[] {
  const pinned = process.env.ALPACA_TRADING_BASE?.trim().replace(/\/+$/, "");
  if (pinned) return [pinned];
  return resolvedBase ? [resolvedBase] : [LIVE_BASE, PAPER_BASE];
}

/** GET a read-only trading-API path (allowlisted) with host fallback and 429 retry. */
export async function tradingFetch(path: string, params: Record<string, string | undefined>): Promise<any> {
  if (!isConfigured()) throw new Error("alpaca: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set");
  if (!ALLOWED_PATHS.has(path)) throw new Error(`alpaca: refusing trading-API path ${path}`);
  const bases = candidates();
  let lastError = "";
  for (let b = 0; b < bases.length; b++) {
    const url = new URL(path, bases[b]);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      await throttle();
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID!,
          "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY!,
          Accept: "application/json",
        },
      });
      if (res.status === 429 && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, (isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        lastError = `alpaca ${res.status} from ${url.origin} for ${path}`;
        break; // the other host may own this account
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`alpaca ${res.status} for ${url.pathname}: ${body.slice(0, 200)}`);
      }
      resolvedBase = bases[b];
      return res.json();
    }
  }
  throw new Error(lastError || "alpaca: trading API unavailable");
}
