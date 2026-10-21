import { Router, type Response } from "express";
import { z } from "zod";
import * as content from "../../providers/fmp-content.js";
import { getOrFetch, search, storedDates } from "../../research/transcripts-store.js";
import { envelope, fail, limitParam, parseQuery, parseSymbol } from "./common.js";

// Per-symbol routes of the content area, mounted under /api/research.
export const router = Router();
// Market-wide routes, mounted under /api/research/market.
export const marketRouter = Router();

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => day(new Date(Date.now() - n * 86_400_000));
const FILINGS_LOOKBACK_DAYS = 730;
const LATEST_8K_DAYS = 7;

/** Answers 400 with the zod message and returns null on failure. */
function parse<T>(res: Response, schema: z.ZodType<T>, value: unknown): T | null {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return null;
}

router.get("/:symbol/transcripts", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  try {
    const dates = await content.transcriptDates(symbol);
    res.json(envelope({ symbol, dataset: "transcripts", data: dates }));
  } catch (err) {
    // FMP's list is the source; fall back to what is already stored when it fails.
    const stored = storedDates(symbol);
    if (stored.length > 0) res.json(envelope({ symbol, dataset: "transcripts", data: stored }));
    else fail(res, err, "/research/transcripts");
  }
});

const searchQuery = z.object({ q: z.string().trim().min(1).max(200), limit: limitParam.max(50).optional() });

// Registered before the :year/:quarter route; the paths differ in depth, so they never collide.
router.get("/:symbol/transcripts/search", (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const q = parse(res, searchQuery, req.query);
  if (!q) return;
  try {
    res.json(envelope({ symbol, dataset: "transcripts-search", data: search(symbol, q.q, q.limit ?? 10) }));
  } catch (err) {
    fail(res, err, "/research/transcripts/search");
  }
});

const transcriptParams = z.object({ year: z.coerce.number().int().min(1990).max(2100), quarter: z.coerce.number().int().min(1).max(4) });

router.get("/:symbol/transcripts/:year/:quarter", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const p = parse(res, transcriptParams, req.params);
  if (!p) return;
  try {
    const t = await getOrFetch(symbol, p.year, p.quarter);
    if (!t) {
      res.status(404).json({ error: `no transcript for ${symbol} FY${p.year} Q${p.quarter}`, feature: "/research/transcripts" });
      return;
    }
    res.json(envelope({ symbol, dataset: "transcript", asOf: t.fetchedAt, data: { fiscalYear: t.fiscalYear, quarter: t.quarter, date: t.date, content: t.content } }));
  } catch (err) {
    fail(res, err, "/research/transcripts");
  }
});

router.get("/:symbol/press-releases", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const q = parseQuery(res, req.query);
  if (!q) return;
  try {
    const data = await content.pressReleases(symbol, q.limit ?? 20, { from: q.from, to: q.to });
    res.json(envelope({ symbol, dataset: "press-releases", data }));
  } catch (err) {
    fail(res, err, "/research/press-releases");
  }
});

router.get("/:symbol/news", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const q = parseQuery(res, req.query);
  if (!q) return;
  try {
    const data = await content.stockNews(symbol, q.limit ?? 30, { from: q.from, to: q.to });
    res.json(envelope({ symbol, dataset: "news", data }));
  } catch (err) {
    fail(res, err, "/research/news");
  }
});

const filingsQuery = z.object({ type: z.string().trim().min(1).max(20).optional() });

router.get("/:symbol/filings", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const q = parseQuery(res, req.query);
  const f = q && parse(res, filingsQuery, req.query);
  if (!q || !f) return;
  try {
    const data = await content.symbolFilings(symbol, { from: q.from ?? daysAgo(FILINGS_LOOKBACK_DAYS), to: q.to ?? day(new Date()), limit: q.limit ?? 20, type: f.type });
    res.json(envelope({ symbol, dataset: "filings", data }));
  } catch (err) {
    fail(res, err, "/research/filings");
  }
});

marketRouter.get("/press-releases/latest", async (req, res) => {
  const q = parseQuery(res, req.query);
  if (!q) return;
  try {
    res.json(envelope({ dataset: "press-releases-latest", data: await content.latestPressReleases(q.limit ?? 50) }));
  } catch (err) {
    fail(res, err, "/research/market/press-releases/latest");
  }
});

marketRouter.get("/filings/8k/latest", async (req, res) => {
  const q = parseQuery(res, req.query);
  if (!q) return;
  try {
    const data = await content.latestFilingsByForm("8-K", { from: q.from ?? daysAgo(LATEST_8K_DAYS), to: q.to ?? day(new Date()), limit: q.limit ?? 50 });
    res.json(envelope({ dataset: "filings-8k-latest", data }));
  } catch (err) {
    fail(res, err, "/research/market/filings/8k/latest");
  }
});
