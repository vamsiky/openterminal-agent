// Reference data per ticker from SEC EDGAR: CIK, legal name, SIC code, a coarse
// sector derived from the SIC code, and shares outstanding. Entries are cached in
// DATA_DIR/sec-reference.json for a week so a restart doesn't refetch them.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../db.js";
import { edgarFetch } from "./secedgar.js";

export type Reference = {
  symbol: string;
  cik: string; // zero-padded to 10 digits
  name: string;
  sic: string | null;
  sicDescription: string | null;
  sector: Sector;
  sharesOutstanding: number | null; // latest cover-page count; null when the filer reports none (e.g. multi-class)
  sharesAsOf: string | null; // period end of that count, YYYY-MM-DD
  fetchedAt: number; // epoch ms
};

export const SECTORS = [
  "Technology", "Health Care", "Financials", "Energy", "Consumer Discretionary", "Consumer Staples",
  "Industrials", "Materials", "Utilities", "Real Estate", "Communication Services",
] as const;
export type Sector = (typeof SECTORS)[number] | "Other";

const MAX_AGE_MS = 7 * 86_400_000;
const FAILURE_BACKOFF_MS = 3_600_000;
const REQUEST_SPACING_MS = 200; // SEC allows 10 req/s; stay at 5
const TICKER_MAP_TTL_MS = 86_400_000;

// SIC division ranges -> coarse sector. First match wins, so narrow ranges come before
// the wider ones they sit inside. This is an approximation for grouping, NOT GICS
// (which is licensed): e.g. every 7370s software/services filer lands in Technology.
const SIC_SECTORS: Array<[number, number, Sector]> = [
  [2833, 2836, "Health Care"], // drugs, biologics
  [3841, 3851, "Health Care"], // medical instruments and supplies
  [8000, 8099, "Health Care"],
  [8731, 8731, "Health Care"],
  [5047, 5047, "Health Care"],
  [5122, 5122, "Health Care"],
  [5912, 5912, "Consumer Staples"], // drug stores
  [1311, 1389, "Energy"],
  [1200, 1299, "Energy"], // coal
  [2900, 2999, "Energy"], // petroleum refining
  [4610, 4619, "Energy"], // pipelines
  [5171, 5172, "Energy"],
  [4950, 4959, "Industrials"], // sanitary services
  [4900, 4991, "Utilities"],
  [4800, 4899, "Communication Services"],
  [2710, 2799, "Communication Services"], // publishing
  [7810, 7841, "Communication Services"], // film and video
  [3630, 3639, "Consumer Discretionary"], // appliances
  [3570, 3579, "Technology"], // computers
  [3600, 3699, "Technology"], // electronic equipment, semiconductors
  [3810, 3829, "Technology"], // measuring instruments
  [7370, 7379, "Technology"], // software and computer services
  [3711, 3716, "Consumer Discretionary"], // autos
  [5400, 5499, "Consumer Staples"], // food stores
  [5200, 5999, "Consumer Discretionary"], // other retail
  [7000, 7099, "Consumer Discretionary"], // hotels
  [7900, 7999, "Consumer Discretionary"], // amusement and recreation
  [2300, 2399, "Consumer Discretionary"], // apparel
  [3000, 3199, "Consumer Discretionary"], // rubber, plastics, leather
  [3900, 3999, "Consumer Discretionary"], // misc manufacturing (toys, jewelry)
  [100, 999, "Consumer Staples"], // agriculture
  [2000, 2199, "Consumer Staples"], // food, beverages, tobacco
  [5140, 5149, "Consumer Staples"],
  [2800, 2899, "Materials"], // chemicals not covered above
  [1000, 1199, "Materials"], // metal mining
  [1400, 1499, "Materials"], // nonmetallic minerals
  [2400, 2699, "Materials"], // wood, paper
  [3200, 3399, "Materials"], // glass, cement, primary metals
  [3410, 3419, "Materials"],
  [6798, 6798, "Real Estate"], // REITs
  [6500, 6599, "Real Estate"],
  [6000, 6799, "Financials"], // banks, insurance, brokers, trusts
  [1500, 1799, "Industrials"], // construction
  [3400, 3599, "Industrials"], // fabricated metal, machinery
  [3700, 3799, "Industrials"], // aerospace, rail and other transport equipment
  [4000, 4799, "Industrials"], // transportation
  [5000, 5199, "Industrials"], // wholesale
  [7300, 7369, "Industrials"], // business services
  [8700, 8799, "Industrials"], // engineering and management services
];

export function sectorFromSic(sic: string | number | null | undefined): Sector {
  const code = Number(sic);
  if (!Number.isInteger(code) || code <= 0) return "Other";
  return SIC_SECTORS.find(([lo, hi]) => code >= lo && code <= hi)?.[2] ?? "Other";
}

// ---- request pacing ----

let lastRequestAt = 0;
let pacing: Promise<void> = Promise.resolve();

/** Serialise SEC calls and keep them at least REQUEST_SPACING_MS apart. */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = pacing.then(async () => {
    const wait = lastRequestAt + REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  pacing = run.then(() => undefined, () => undefined);
  return run;
}

// ---- ticker -> CIK ----

let tickers: { at: number; map: Map<string, { cik: string; name: string }> } | null = null;

// SEC writes share classes with a dash (BRK-B); we use a dot (BRK.B).
const secTicker = (symbol: string) => symbol.toUpperCase().replace(/\./g, "-");

async function tickerMap(): Promise<Map<string, { cik: string; name: string }>> {
  if (tickers && Date.now() - tickers.at < TICKER_MAP_TTL_MS) return tickers.map;
  const data = await paced(() => edgarFetch("https://www.sec.gov/files/company_tickers.json"));
  const map = new Map<string, { cik: string; name: string }>();
  for (const row of Object.values(data) as Array<{ ticker: string; cik_str: number; title: string }>) {
    map.set(row.ticker.toUpperCase(), { cik: String(row.cik_str).padStart(10, "0"), name: row.title });
  }
  tickers = { at: Date.now(), map };
  return map;
}

// ---- per-symbol fetch ----

/** Latest cover-page share count from a dei:EntityCommonStockSharesOutstanding concept. */
export function latestShares(concept: any): { shares: number; asOf: string } | null {
  const facts: Array<{ end?: string; val?: number; filed?: string }> = concept?.units?.shares ?? [];
  let best: { end: string; val: number; filed: string } | null = null;
  for (const f of facts) {
    if (!f.end || !isFinite(Number(f.val)) || Number(f.val) <= 0) continue;
    const filed = f.filed ?? "";
    if (!best || f.end > best.end || (f.end === best.end && filed > best.filed)) best = { end: f.end, val: Number(f.val), filed };
  }
  return best ? { shares: best.val, asOf: best.end } : null;
}

async function fetchReference(symbol: string): Promise<Reference | null> {
  const known = (await tickerMap()).get(secTicker(symbol));
  if (!known) return null;

  const submissions = await paced(() => edgarFetch(`https://data.sec.gov/submissions/CIK${known.cik}.json`));
  // Filers with no dei share count (e.g. Alphabet reports per class) answer 404: that's "unknown", not an error.
  const concept = await paced(() =>
    edgarFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${known.cik}/dei/EntityCommonStockSharesOutstanding.json`)
  ).catch((err: Error) => {
    if (/ 404 /.test(err.message)) return null;
    throw err;
  });
  const shares = latestShares(concept);
  const sic = submissions?.sic ? String(submissions.sic) : null;

  return {
    symbol: symbol.toUpperCase(),
    cik: known.cik,
    name: submissions?.name ?? known.name,
    sic,
    sicDescription: submissions?.sicDescription || null,
    sector: sectorFromSic(sic),
    sharesOutstanding: shares?.shares ?? null,
    sharesAsOf: shares?.asOf ?? null,
    fetchedAt: Date.now(),
  };
}

// ---- cache ----

const cachePath = () => join(dataDir, "sec-reference.json");
let entries: Map<string, Reference> | null = null;
const failedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

function load(): Map<string, Reference> {
  if (entries) return entries;
  entries = new Map();
  try {
    if (existsSync(cachePath())) {
      for (const e of JSON.parse(readFileSync(cachePath(), "utf8")) as Reference[]) entries.set(e.symbol, e);
    }
  } catch {
    // A corrupt cache file just means refetching.
  }
  return entries;
}

function save(): void {
  const tmp = `${cachePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify([...load().values()]));
  renameSync(tmp, cachePath());
}

function refreshOne(symbol: string): Promise<void> {
  let p = inFlight.get(symbol);
  if (!p) {
    p = fetchReference(symbol)
      .then((ref) => {
        if (ref) load().set(symbol, ref);
        else failedAt.set(symbol, Date.now()); // no CIK (ETF, foreign): don't ask again for a while
      })
      .catch(() => {
        failedAt.set(symbol, Date.now()); // keep any stale entry; retry after the backoff
      })
      .finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, p);
  }
  return p;
}

const normalise = (symbols: string[]) => [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];

/** Fetch every given symbol now, ignoring entry age. Symbols SEC doesn't know are skipped. */
export async function refreshReference(symbols: string[]): Promise<Map<string, Reference>> {
  const wanted = normalise(symbols);
  for (const s of wanted) failedAt.delete(s);
  await Promise.all(wanted.map(refreshOne));
  save();
  return pick(wanted);
}

/**
 * Reference data for the given symbols. Entries older than a week (or missing) are
 * fetched first; symbols that failed recently are not retried until the backoff ends.
 * A stale entry is returned if its refresh fails.
 */
export async function reference(symbols: string[]): Promise<Map<string, Reference>> {
  const wanted = normalise(symbols);
  const cache = load();
  const due = wanted.filter((s) => {
    const e = cache.get(s);
    if (e && Date.now() - e.fetchedAt < MAX_AGE_MS) return false;
    return Date.now() - (failedAt.get(s) ?? 0) >= FAILURE_BACKOFF_MS;
  });
  if (due.length > 0) {
    await Promise.all(due.map(refreshOne));
    save();
  }
  return pick(wanted);
}

function pick(symbols: string[]): Map<string, Reference> {
  const out = new Map<string, Reference>();
  for (const s of symbols) {
    const e = load().get(s);
    if (e) out.set(s, e);
  }
  return out;
}

/** Forget in-memory state so the next call re-reads the cache file (tests). */
export function resetReferenceState(): void {
  entries = null;
  tickers = null;
  failedAt.clear();
  inFlight.clear();
  lastRequestAt = 0;
}
