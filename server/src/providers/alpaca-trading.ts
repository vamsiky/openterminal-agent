import { isConfigured, throttle } from "./alpaca.js";

// Read-only reference data from Alpaca's trading API: the option contract list
// (open interest, and expired contracts with status=inactive) and the market
// calendar. The keys are account keys, so this module can reach exactly two
// GET endpoints and nothing else; orders, positions and account endpoints are
// refused before any request is made. The contract list is further limited to
// status active or inactive (the only values it has).
//
// Whether the account is live or paper isn't known, so the live host is tried
// first and the paper host answers when the live one says 401/403; whichever
// works is remembered. ALPACA_TRADING_BASE pins the host.

const LIVE_BASE = "https://api.alpaca.markets";
const PAPER_BASE = "https://paper-api.alpaca.markets";
const ALLOWED_PATHS = new Set(["/v2/options/contracts", "/v2/calendar"]);

const CONTRACT_STATUSES = new Set(["active", "inactive"]);

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
  if (path === "/v2/options/contracts" && params.status !== undefined && !CONTRACT_STATUSES.has(params.status)) {
    throw new Error(`alpaca: refusing contract status ${params.status}`);
  }
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

export type ContractStatus = "active" | "inactive";

export type OptionContract = {
  occ: string;
  underlying: string;
  expiry: string; // YYYY-MM-DD
  type: "call" | "put";
  strike: number; // strike_price arrives as a string
  status: string;
  openInterest: number | null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const listMemo = new Map<string, OptionContract[]>();

/** Test hook: drop the listContracts memo. */
export function resetContractMemo(): void {
  listMemo.clear();
}

/**
 * Option contracts of one underlying across an expiry range (and optional
 * strike band), all pages. Expired contracts are status "inactive". Adjusted
 * roots (WDC1 and the like) are left out. Identical calls are answered from
 * memory; `stats.requests` counts the page requests actually made.
 */
export async function listContracts(
  opts: { underlying: string; type?: "call" | "put"; expiryGte: string; expiryLte: string; strikeGte?: number; strikeLte?: number; status: ContractStatus },
  stats?: { requests: number },
  maxPages = 20
): Promise<OptionContract[]> {
  const underlying = opts.underlying.toUpperCase();
  const key = JSON.stringify({ ...opts, underlying });
  const memo = listMemo.get(key);
  if (memo) return memo;
  const out: OptionContract[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (stats) stats.requests++;
    const data = await tradingFetch("/v2/options/contracts", {
      underlying_symbols: underlying,
      status: opts.status,
      type: opts.type,
      expiration_date_gte: opts.expiryGte,
      expiration_date_lte: opts.expiryLte,
      strike_price_gte: opts.strikeGte === undefined ? undefined : String(opts.strikeGte),
      strike_price_lte: opts.strikeLte === undefined ? undefined : String(opts.strikeLte),
      limit: "10000",
      page_token: pageToken,
    });
    for (const c of data?.option_contracts ?? []) {
      const strike = num(c?.strike_price);
      if (!c?.symbol || !c?.expiration_date || strike === null) continue;
      if (c.root_symbol && String(c.root_symbol).toUpperCase() !== underlying) continue;
      if (!/^[A-Z.]{1,6}\d{6}[CP]\d{8}$/.test(c.symbol)) continue; // adjusted/non-standard roots carry digits
      out.push({
        occ: c.symbol,
        underlying,
        expiry: String(c.expiration_date),
        type: c.type === "put" ? "put" : "call",
        strike,
        status: String(c.status ?? opts.status),
        openInterest: num(c.open_interest),
      });
    }
    pageToken = data?.next_page_token ?? undefined;
    if (!pageToken) break;
  }
  listMemo.set(key, out);
  if (listMemo.size > 500) listMemo.delete(listMemo.keys().next().value!);
  return out;
}
