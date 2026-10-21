// Financial Modeling Prep bulk endpoints (Ultimate plan): one CSV per dataset
// for every listing FMP covers, worldwide. research/bulk-store.ts keeps the
// US listings in sqlite.
//
// Checked against the live API on 2026-10-21:
// - Every bulk endpoint answers text/csv. Strings are quoted, numbers and
//   booleans are not, and an empty unquoted field is null; descriptions carry
//   commas, doubled quotes and newlines inside quotes.
// - profile-bulk is paged: part=0..3 (about 30 MB each), then 400 "Invalid or
//   missing query parameter - part".
// - Statement bulk endpoints take year (the fiscal year) and period=FY|Q1..Q4;
//   period=quarter is silently read as Q1.
// - Calling the same bulk endpoint again within about 10 s answers 429 with
//   {"Error Message": "Limit Reach. This is a bulk endpoint..."}, whatever the
//   params, so calls to one endpoint are spaced BULK_GAP_MS apart.
// - Symbols are FMP's: share classes with a dash (BRK-B), some with stray
//   leading spaces (" GVT&D.NS").

import { isForeignSymbol } from "../history/universe.js";
import { BASE, FmpError, requireKey } from "./fmp-core.js";

export type CsvValue = string | number | boolean | null;
export type CsvRow = Record<string, CsvValue>;

const BULK_GAP_MS = 12_000;
const MAX_RETRIES = 3;
const MAX_PARTS = 50;

/**
 * Incremental CSV parser: push text chunks as they arrive, get back the rows
 * completed so far. The first record is the header. Quoted fields stay
 * strings; unquoted ones become numbers, booleans or null (when empty), which
 * gives back the types of FMP's JSON for the same dataset.
 */
export class CsvParser {
  private header: string[] | null = null;
  private record: CsvValue[] = [];
  private field = "";
  private quoted = false; // the current field was quoted
  private inQuotes = false;
  private quoteSeen = false; // a quote inside quotes: either "" or the closing quote
  private sawData = false; // the current record has started

  push(chunk: string): CsvRow[] {
    const out: CsvRow[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.inQuotes) {
        if (this.quoteSeen) {
          this.quoteSeen = false;
          if (c === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false; // the quote closed the field; c is read below
        } else if (c === '"') {
          this.quoteSeen = true;
          continue;
        } else {
          this.field += c;
          continue;
        }
      }
      if (c === '"' && this.field === "" && !this.quoted) {
        this.inQuotes = true;
        this.quoted = true;
        this.sawData = true;
      } else if (c === ",") {
        this.endField();
      } else if (c === "\n") {
        const row = this.endRecord();
        if (row) out.push(row);
      } else if (c !== "\r") {
        this.field += c;
        this.sawData = true;
      }
    }
    return out;
  }

  /** Flush the last record when the input doesn't end with a newline. */
  end(): CsvRow[] {
    if (this.inQuotes && this.quoteSeen) this.inQuotes = this.quoteSeen = false;
    const row = this.endRecord();
    return row ? [row] : [];
  }

  private endField(): void {
    this.record.push(this.quoted ? this.field : typed(this.field));
    this.field = "";
    this.quoted = false;
    this.sawData = true;
  }

  private endRecord(): CsvRow | null {
    if (!this.sawData && this.field === "") return null; // blank line
    this.endField();
    const values = this.record;
    this.record = [];
    this.sawData = false;
    if (!this.header) {
      this.header = values.map((v) => String(v ?? "").trim());
      return null;
    }
    const row: CsvRow = {};
    this.header.forEach((name, i) => {
      if (name) row[name] = values[i] ?? null;
    });
    return row;
  }
}

function typed(raw: string): CsvValue {
  const s = raw.trim();
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

/** Parse a whole CSV document. */
export function parseCsv(text: string): CsvRow[] {
  const p = new CsvParser();
  return [...p.push(text), ...p.end()];
}

/** FMP's symbol in the app's form: trimmed, share classes with a dot (BRK-B -> BRK.B). */
export function appSymbol(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase().replace(/^([A-Z]+)-([A-Z])$/, "$1.$2");
}

/**
 * FMP's short exchange codes for US venues. The live profile-bulk only uses
 * NASDAQ, NYSE, AMEX (NYSE American and NYSE Arca), CBOE (Cboe BZX) and OTC;
 * the rest are kept in case FMP starts sending them.
 */
export const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "NYSE ARCA", "NYSEARCA", "BATS", "CBOE", "OTC"]);

/**
 * A profile-bulk row for a US listing: a US exchange and a symbol without a
 * foreign suffix. The company's country isn't required: ADRs (TSM) and
 * foreign-domiciled companies listed only here (ACN and MDT are "IE", LIN
 * "GB") are US listings too.
 */
export function isUsListing(row: CsvRow): boolean {
  const symbol = appSymbol(row.symbol);
  return Boolean(symbol) && US_EXCHANGES.has(String(row.exchange ?? "").toUpperCase()) && !isForeignSymbol(symbol);
}

/**
 * The 1-5 score FMP's /ratings-snapshot reports as overallScore for each
 * rating letter. rating-bulk has the letter but not the score; this mapping
 * matched /ratings-snapshot for every letter on 2026-10-21 (note B- is 2 and
 * C- is 1).
 */
export const RATING_SCORE: Record<string, number> = {
  "S+": 5, S: 5, "S-": 5,
  "A+": 4, A: 4, "A-": 4,
  "B+": 3, B: 3, "B-": 2,
  "C+": 2, C: 2, "C-": 1,
  "D+": 1, D: 1, "D-": 1,
};

export function ratingScore(rating: unknown): number | null {
  return typeof rating === "string" ? RATING_SCORE[rating.trim()] ?? null : null;
}

// One bulk download at a time (they're tens of MB each), and each endpoint
// called at most once per gap.
let gapMs = BULK_GAP_MS;
let queue: Promise<unknown> = Promise.resolve();
const lastCall = new Map<string, number>();

/** Test hook: forget past calls and set the per-endpoint gap. */
export function resetState(gap = BULK_GAP_MS): void {
  gapMs = gap;
  queue = Promise.resolve();
  lastCall.clear();
}

const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export type DownloadStats = { rows: number; bytes: number; calls: number };

/**
 * Stream one bulk CSV, calling onRow for each row as it is parsed, so a
 * 70 MB file never sits in memory whole. Retries "Limit Reach" 429s.
 */
export function download(path: string, params: Record<string, string | number>, onRow: (row: CsvRow) => void): Promise<DownloadStats> {
  const run = queue.then(() => fetchCsv(path, params, onRow));
  queue = run.catch(() => {});
  return run;
}

async function fetchCsv(path: string, params: Record<string, string | number>, onRow: (row: CsvRow) => void): Promise<DownloadStats> {
  const key = requireKey();
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("apikey", key);

  for (let attempt = 0; ; attempt++) {
    await wait((lastCall.get(path) ?? 0) + gapMs - Date.now());
    lastCall.set(path, Date.now());
    const res = await fetch(url.toString(), { headers: { Accept: "text/csv" } });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get("retry-after"));
      await wait(isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : gapMs * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Never echo the URL: it carries the key.
      throw new FmpError(res.status, `fmp ${res.status} for /${path}${res.status === 401 ? " (check FMP_API_KEY)" : ""}: ${body.slice(0, 200)}`);
    }
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      // Errors (and an empty dataset) come back as JSON even with a 200.
      const json = await res.json();
      if (json && !Array.isArray(json) && typeof json["Error Message"] === "string") {
        throw new FmpError(200, `fmp /${path}: ${json["Error Message"].slice(0, 200)}`);
      }
      return { rows: 0, bytes: 0, calls: attempt + 1 };
    }
    return { ...(await stream(res, onRow)), calls: attempt + 1 };
  }
}

async function stream(res: Response, onRow: (row: CsvRow) => void): Promise<{ rows: number; bytes: number }> {
  const parser = new CsvParser();
  const decoder = new TextDecoder();
  let rows = 0;
  let bytes = 0;
  const emit = (batch: CsvRow[]) => {
    for (const row of batch) onRow(row);
    rows += batch.length;
  };
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      emit(parser.push(decoder.decode(value, { stream: true })));
    }
  }
  emit(parser.push(decoder.decode()));
  emit(parser.end());
  return { rows, bytes };
}

/**
 * Every part of a paged bulk endpoint (profile-bulk), from part=0 until FMP
 * answers 400 for the part number or an empty part.
 */
export async function downloadParts(path: string, onRow: (row: CsvRow) => void): Promise<DownloadStats & { parts: number }> {
  const total = { rows: 0, bytes: 0, calls: 0, parts: 0 };
  for (let part = 0; part < MAX_PARTS; part++) {
    let got: DownloadStats;
    try {
      got = await download(path, { part }, onRow);
    } catch (err) {
      if (part > 0 && err instanceof FmpError && err.status === 400) break;
      throw err;
    }
    total.calls += got.calls;
    if (got.rows === 0) break;
    total.rows += got.rows;
    total.bytes += got.bytes;
    total.parts++;
  }
  return total;
}
