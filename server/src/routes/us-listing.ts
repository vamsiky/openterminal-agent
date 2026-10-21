import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../db.js";
import * as alpacaAssets from "../providers/alpaca-assets.js";
import * as openfigi from "../providers/openfigi.js";
import type { Quote } from "../providers/types.js";

// The US listing of a foreign symbol (SHOP.TO, 2330.TW, 7203.T...), so a
// ticker FMP Starter won't price can be priced live from Alpaca. A wrong
// company is worse than none (T.TO is Telus, not AT&T), so anything short of
// a confident match maps to nothing and the route falls back to Stooq.
//
// - Interlisted: OpenFIGI maps the local ticker to its share class, and the
//   same share class's US composite ticker is a US exchange listing (SHOP, RY).
// - ADR: a different security. US stock listings whose name is the OpenFIGI
//   company name, which OpenFIGI then confirms is a depositary receipt of that
//   company; exactly one, or nothing. Nasdaq Trader's names alone can't tell:
//   TSM, TM and NVO are listed there as plain stock.
//
// Answers are kept in DATA_DIR/us-listings.json, "no listing" included, and
// checked again after 30 days. OpenFIGI failures and rate limits aren't kept:
// those symbols are asked again after FAILURE_BACKOFF_MS.

export type Listing = { symbol: string; exchange: string; kind: "interlisted" | "adr" };

/** A quote priced from a symbol's US listing carries that listing. */
export type ListedQuote = Quote & { listing?: Listing };

const RECHECK_MS = 30 * 86_400_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
// More US names than this matching one company is too vague to check each.
const MAX_ADR_CANDIDATES = 3;
// OpenFIGI cuts names at 28 characters ("TAIWAN SEMICONDUCTOR MANUFAC").
const FIGI_NAME_MAX = 28;

// Yahoo-style suffix → OpenFIGI exchCode.
const EXCH_CODES: Record<string, string> = {
  TO: "CT", V: "CV", L: "LN", AS: "NA", DE: "GR", F: "GF", PA: "FP", BR: "BB", LS: "PL", MC: "SM", MI: "IM",
  SW: "SW", ST: "SS", CO: "DC", HE: "FH", OL: "NO", IR: "ID", VI: "AV", WA: "PW", AT: "GA", IS: "TI",
  HK: "HK", T: "JT", TW: "TT", KS: "KS", KQ: "KQ", SS: "CG", SZ: "CS", SI: "SP", AX: "AT", NZ: "NZ",
  NS: "IS", BO: "IB", JK: "IJ", KL: "MK", BK: "TB", SA: "BS", MX: "MM", JO: "SJ", TA: "IT",
};
// Nordic share classes run together in Bloomberg tickers (NOVO-B → NOVOB); elsewhere they take a slash (BBD-B → BBD/B).
const JOINED_CLASS = new Set(["DC", "SS", "FH", "NO"]);

function bloombergTicker(local: string, exchCode: string): string {
  if (exchCode === "HK") return local.replace(/^0+(?=\d)/, "");
  if (JOINED_CLASS.has(exchCode)) return local.replace(/-/g, "");
  // London tickers under three letters end in a slash (BP → BP/).
  if (exchCode === "LN" && /^[A-Z0-9]{1,2}$/.test(local)) return `${local}/`;
  return local.replace(/-/g, "/");
}

/** The local ticker and OpenFIGI exchange code of a Yahoo-style foreign symbol (SHOP.TO → SHOP on CT), or null. */
export function figiQuery(symbol: string): { ticker: string; exchCode: string } | null {
  const m = /^([A-Z0-9][A-Z0-9-]*)\.([A-Z]{1,2})$/.exec(symbol.toUpperCase());
  const exchCode = m ? EXCH_CODES[m[2]] : undefined;
  return m && exchCode ? { ticker: bloombergTicker(m[1], exchCode), exchCode } : null;
}

export const isForeign = (symbol: string): boolean => figiQuery(symbol) !== null;

// ---- company names ----

// Where the company name ends in a Nasdaq Trader security name or an OpenFIGI name.
// Not at " - ", which is also inside names ("Banco Santander - Chile ADS").
const DESCRIPTION =
  /\(|\b(?:common|ordinary|american deposit[ao]ry|depositary|sponsored|unsponsored|ads|adr|new york registry|each representing|subordinate|class [a-z]|warrants?|units?|rights?|preferred)\b/;
// Legal forms and depositary jargon, which the two sources spell differently or leave out.
const NOISE = new Set([
  "the", "inc", "incorporated", "corp", "corporation", "co", "cos", "company", "ltd", "limited", "plc", "llc", "lp",
  "ag", "sa", "sab", "de", "cv", "nv", "se", "spa", "as", "asa", "ab", "oyj", "kk", "bhd", "tbk", "pt", "bv", "kgaa",
  "holding", "holdings", "sp", "spon", "spons", "unsp", "unspon", "adrs", "ny", "reg", "shs", "cl", "class",
]);

function words(name: string): string[] {
  let s = name.toLowerCase();
  const cut = DESCRIPTION.exec(s);
  if (cut) s = s.slice(0, cut.index);
  return s.replace(/[.&'/]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

const significant = (ws: string[]) => ws.filter((w) => w.length > 1 && !NOISE.has(w));
const noisePrefix = (w: string) => w.length < 2 || [...NOISE].some((n) => n.startsWith(w));

/**
 * Whether a US security name names the company OpenFIGI calls `figiName`:
 * the same significant words in the same order. A name OpenFIGI cut short
 * matches on the words it has, its last one as a prefix.
 */
export function namesMatch(figiName: string, listingName: string): boolean {
  const listing = significant(words(listingName));
  const raw = words(figiName);
  if (figiName.trim().length < FIGI_NAME_MAX) {
    const figi = significant(raw);
    return figi.length > 0 && figi.length === listing.length && figi.every((w, i) => w === listing[i]);
  }
  const figi = significant(raw.slice(0, -1));
  const last = raw[raw.length - 1] ?? "";
  if (figi.length === 0 || !figi.every((w, i) => w === listing[i])) return false;
  const next = listing[figi.length];
  return next !== undefined ? next.startsWith(last) : noisePrefix(last);
}

/** Whether two OpenFIGI names agree on the words both have (either may be cut short). */
function sameCompany(a: string, b: string): boolean {
  const [x, y] = [significant(words(a)), significant(words(b))];
  const n = Math.min(x.length, y.length);
  if (n === 0) return false;
  return x.slice(0, n).every((w, i) => w === y[i] || (i === n - 1 && (w.startsWith(y[i]) || y[i].startsWith(w))));
}

// ---- lookup ----

/** Undefined in the result means the lookup failed and is retried later. */
async function resolve(symbols: string[]): Promise<Map<string, Listing | null>> {
  const out = new Map<string, Listing | null>();
  const listed = new Map((await alpacaAssets.allAssets()).filter((a) => a.type !== "crypto").map((a) => [a.symbol, a]));
  const listing = (symbol: string, kind: Listing["kind"]): Listing => ({ symbol, exchange: listed.get(symbol)!.exchange, kind });

  // A symbol that is itself a US listing isn't foreign.
  const queries: Array<{ s: string; q: { ticker: string; exchCode: string } }> = [];
  for (const s of symbols) {
    if (listed.has(s)) out.set(s, null);
    else queries.push({ s, q: figiQuery(s)! });
  }
  if (queries.length === 0) return out;

  // 1. The local listing's share class and company name.
  const local = await openfigi.map(queries.map(({ q }) => ({ idType: "TICKER", idValue: q.ticker, exchCode: q.exchCode })));
  const known: Array<{ s: string; shareClass: string; name: string }> = [];
  queries.forEach(({ s }, i) => {
    const recs = local[i]?.filter((r) => r.marketSector === "Equity" && r.shareClassFIGI && r.name);
    if (!recs) return;
    if (new Set(recs.map((r) => r.shareClassFIGI)).size === 1) known.push({ s, shareClass: recs[0].shareClassFIGI!, name: recs[0].name! });
    else out.set(s, null);
  });
  if (known.length === 0) return out;

  // 2. Interlisted: the same share class trades on a US exchange.
  const us = await openfigi.map(known.map((k) => ({ idType: "ID_BB_GLOBAL_SHARE_CLASS_LEVEL", idValue: k.shareClass, exchCode: "US" })));
  const unlisted: typeof known = [];
  known.forEach((k, i) => {
    const recs = us[i];
    if (!recs) return;
    const tickers = new Set(recs.flatMap((r) => (r.exchCode === "US" && r.ticker ? [r.ticker.replace("/", ".")] : [])).filter((t) => listed.has(t)));
    if (tickers.size === 1) out.set(k.s, listing([...tickers][0], "interlisted"));
    else if (tickers.size > 1) out.set(k.s, null);
    else unlisted.push(k);
  });

  // 3. ADR: US stocks under the company's name, confirmed as its depositary receipt.
  const stocks = [...listed.values()].filter((a) => a.type === "stock");
  const candidates: Array<(typeof known)[number] & { matches: string[] }> = [];
  for (const k of unlisted) {
    const matches = stocks.filter((a) => namesMatch(k.name, a.name)).map((a) => a.symbol);
    if (matches.length === 0 || matches.length > MAX_ADR_CANDIDATES) out.set(k.s, null);
    else candidates.push({ ...k, matches });
  }
  const jobs = candidates.flatMap((c) => c.matches.map((t) => ({ idType: "TICKER", idValue: t.replace(".", "/"), exchCode: "US" })));
  const checked = jobs.length > 0 ? await openfigi.map(jobs) : [];
  let j = 0;
  for (const c of candidates) {
    const results = c.matches.map(() => checked[j++]);
    if (results.some((r) => !r)) continue;
    const receipts = c.matches.filter((_, i) =>
      results[i]!.some((r) => r.securityType2 === "Depositary Receipt" && r.name && sameCompany(r.name, c.name))
    );
    out.set(c.s, receipts.length === 1 ? listing(receipts[0], "adr") : null);
  }
  return out;
}

type Entry = { symbol: string; listing: Listing | null; checkedAt: number };

const cachePath = () => join(dataDir, "us-listings.json");
let entries: Map<string, Entry> | null = null;
const failedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

function load(): Map<string, Entry> {
  if (entries) return entries;
  entries = new Map();
  try {
    if (existsSync(cachePath())) {
      for (const e of JSON.parse(readFileSync(cachePath(), "utf8")) as Entry[]) entries.set(e.symbol, e);
    }
  } catch {
    // A corrupt cache file just means asking OpenFIGI again.
  }
  return entries;
}

function save(): void {
  const tmp = `${cachePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify([...load().values()]));
  renameSync(tmp, cachePath());
}

/**
 * The US listing of each foreign symbol that has one. Symbols not checked in
 * 30 days are looked up first, in one batch; a failed lookup keeps the last
 * answer and is retried after the backoff.
 */
export async function lookup(symbols: string[]): Promise<Map<string, Listing>> {
  const cache = load();
  const now = Date.now();
  const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(isForeign);
  const due = wanted.filter(
    (s) => !inFlight.has(s) && now - (cache.get(s)?.checkedAt ?? 0) >= RECHECK_MS && now - (failedAt.get(s) ?? 0) >= FAILURE_BACKOFF_MS
  );
  if (due.length > 0) {
    const request = resolve(due)
      .catch((err) => {
        console.warn("[us-listing] lookup failed:", err instanceof Error ? err.message : err);
        return new Map<string, Listing | null>();
      })
      .then((found) => {
        const at = Date.now();
        for (const s of due) {
          const listing = found.get(s);
          if (listing === undefined) failedAt.set(s, at);
          else {
            cache.set(s, { symbol: s, listing, checkedAt: at });
            failedAt.delete(s);
          }
        }
        if (found.size > 0) save();
      })
      .finally(() => {
        for (const s of due) inFlight.delete(s);
      });
    for (const s of due) inFlight.set(s, request);
  }
  await Promise.all(new Set(wanted.flatMap((s) => inFlight.get(s) ?? [])));
  const out = new Map<string, Listing>();
  for (const s of wanted) {
    const listing = cache.get(s)?.listing;
    if (listing) out.set(s, listing);
  }
  return out;
}

/** A US listing's quote, relabelled as the foreign symbol it stands in for. */
export function listedQuote(symbol: string, q: Quote, listing: Listing): ListedQuote {
  return { ...q, symbol, currency: "USD", exchange: listing.exchange || null, listing };
}

/** Test hook: forget the cache in memory and the failure backoffs. */
export function resetUsListingState(): void {
  entries = null;
  failedAt.clear();
  inFlight.clear();
}
