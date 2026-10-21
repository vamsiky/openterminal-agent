import { FmpError, cached, fmpSymbol, get, num, requireKey, str } from "./fmp-core.js";

// Text content from FMP: earnings-call transcripts, press releases, stock news
// and SEC filings. Field names follow FMP; `image` is dropped as noise.

const DATES_TTL = 60 * 60_000;
const NEWS_TTL = 5 * 60_000;
const FILINGS_TTL = 60 * 60_000;

export type TranscriptDate = { fiscalYear: number; quarter: number; date: string };
export type Transcript = { symbol: string; fiscalYear: number; quarter: number; date: string; content: string };
export type NewsArticle = { symbol: string | null; publishedDate: string; publisher: string | null; title: string; site: string | null; text: string | null; url: string | null };
export type Filing = { symbol: string | null; cik: string | null; filingDate: string; acceptedDate: string | null; formType: string; link: string | null; finalLink: string | null };

const rows = (json: unknown): any[] => (Array.isArray(json) ? json : []);

/** A plan without the dataset (402/403) reads as no rows, like fmp.ts does. */
const orEmpty = (err: unknown): never[] => {
  if (err instanceof FmpError && (err.status === 402 || err.status === 403)) return [];
  throw err;
};

/** Uncached; the daily job needs to see a new transcript the hour it appears. */
export async function fetchTranscriptDates(symbol: string): Promise<TranscriptDate[]> {
  requireKey();
  const json = await get("earning-call-transcript-dates", { symbol }).catch(orEmpty);
  return rows(json)
    .map((r) => ({ fiscalYear: num(r?.fiscalYear), quarter: num(r?.quarter), date: str(r?.date) }))
    .filter((r): r is TranscriptDate => r.fiscalYear !== null && r.quarter !== null && r.date !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Available transcripts, newest first. Cached 1 h. */
export function transcriptDates(symbol: string): Promise<TranscriptDate[]> {
  requireKey();
  return cached(`transcript-dates:${fmpSymbol(symbol)}`, DATES_TTL, () => fetchTranscriptDates(symbol));
}

/** One transcript, or null when FMP has none (yet) for that fiscal quarter. Not cached: the store keeps it. */
export async function fetchTranscript(symbol: string, fiscalYear: number, quarter: number): Promise<Transcript | null> {
  requireKey();
  const json = await get("earning-call-transcript", { symbol, year: fiscalYear, quarter }).catch(orEmpty);
  const r = rows(json)[0];
  const content = str(r?.content);
  if (!content) return null;
  return { symbol, fiscalYear, quarter, date: str(r?.date) ?? "", content };
}

const article = (r: any): NewsArticle | null => {
  const publishedDate = str(r?.publishedDate);
  const title = str(r?.title);
  if (!publishedDate || !title) return null;
  return { symbol: str(r?.symbol), publishedDate, publisher: str(r?.publisher), title, site: str(r?.site), text: str(r?.text), url: str(r?.url) };
};
const articles = (json: unknown) => rows(json).map(article).filter((a): a is NewsArticle => a !== null);

type Range = { from?: string; to?: string };

/** Company press releases with full text, newest first. Without a range FMP reaches back about three months. */
export function pressReleases(symbol: string, limit: number, range: Range = {}): Promise<NewsArticle[]> {
  requireKey();
  return cached(`content:pr:${fmpSymbol(symbol)}:${limit}:${range.from ?? ""}:${range.to ?? ""}`, NEWS_TTL, async () =>
    articles(await get("news/press-releases", { symbols: symbol, limit, from: range.from, to: range.to }).catch(orEmpty))
  );
}

/** Stock news for one symbol, newest first. */
export function stockNews(symbol: string, limit: number, range: Range = {}): Promise<NewsArticle[]> {
  requireKey();
  return cached(`content:news:${fmpSymbol(symbol)}:${limit}:${range.from ?? ""}:${range.to ?? ""}`, NEWS_TTL, async () =>
    articles(await get("news/stock", { symbols: symbol, limit, from: range.from, to: range.to }).catch(orEmpty))
  );
}

/** Latest press releases across the market, newest first. */
export function latestPressReleases(limit: number, page = 0): Promise<NewsArticle[]> {
  requireKey();
  return cached(`content:pr-latest:${limit}:${page}`, NEWS_TTL, async () =>
    articles(await get("news/press-releases-latest", { limit, page }).catch(orEmpty))
  );
}

const filing = (r: any): Filing | null => {
  const filingDate = str(r?.filingDate);
  const formType = str(r?.formType);
  if (!filingDate || !formType) return null;
  return { symbol: str(r?.symbol), cik: str(r?.cik), filingDate, acceptedDate: str(r?.acceptedDate), formType, link: str(r?.link), finalLink: str(r?.finalLink) };
};
const filings = (json: unknown) => rows(json).map(filing).filter((f): f is Filing => f !== null);

const byAccepted = (a: Filing, b: Filing) => (b.acceptedDate ?? b.filingDate).localeCompare(a.acceptedDate ?? a.filingDate);

/**
 * SEC filings for one symbol, newest first. FMP requires a date range and has
 * no form filter on the per-symbol search, so `type` filters here: "8-K" also
 * matches "8-K/A", and the comparison ignores case.
 */
export function symbolFilings(symbol: string, o: { from: string; to: string; limit: number; type?: string }): Promise<Filing[]> {
  requireKey();
  return cached(`content:filings:${fmpSymbol(symbol)}:${o.from}:${o.to}:${o.type ?? ""}:${o.limit}`, FILINGS_TTL, async () => {
    const all = filings(await get("sec-filings-search/symbol", { symbol, from: o.from, to: o.to, limit: 1000 }).catch(orEmpty));
    const type = o.type?.toUpperCase();
    return all
      .filter((f) => !type || f.formType.toUpperCase() === type || f.formType.toUpperCase().startsWith(type + "/"))
      .sort(byAccepted)
      .slice(0, o.limit);
  });
}

/** Latest filings of one form type across the market, newest first. */
export function latestFilingsByForm(formType: string, o: { from: string; to: string; limit: number; page?: number }): Promise<Filing[]> {
  requireKey();
  return cached(`content:filings-form:${formType}:${o.from}:${o.to}:${o.limit}:${o.page ?? 0}`, NEWS_TTL, async () =>
    filings(await get("sec-filings-search/form-type", { formType, from: o.from, to: o.to, limit: o.limit, page: o.page ?? 0 }).catch(orEmpty)).sort(byAccepted)
  );
}
