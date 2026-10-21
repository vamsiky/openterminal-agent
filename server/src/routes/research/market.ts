import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import * as market from "../../providers/fmp-market.js";
import { isoDay } from "../../providers/fmp-market.js";
import { envelope, fail, limitParam, parseQuery, parseSymbol } from "./common.js";

// /api/research/market/...: market-wide events and reference data.
export const router = Router();
// /api/research/:symbol/...: per-symbol routes from this area; the commander mounts it.
export const symbolRouter = Router();

const DAY_MS = 86_400_000;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const exchange = z.enum(["NASDAQ", "NYSE"]).default("NASDAQ");
const indexName = z.enum(["sp500", "nasdaq", "dowjones"]);

function offsetDay(days: number): string {
  return isoDay(new Date(Date.now() + days * DAY_MS));
}

function parse<T extends z.ZodTypeAny>(res: Response, schema: T, value: unknown): z.infer<T> | null {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return null;
}

/** Answers 400 when from is after to. */
function ordered(res: Response, from: string, to: string): boolean {
  if (from <= to) return true;
  res.status(400).json({ error: "from must not be after to" });
  return false;
}

router.get("/market/ipos", async (req, res) => {
  const q = parseQuery(res, req.query);
  if (!q) return;
  const from = q.from ?? offsetDay(-30);
  const to = q.to ?? offsetDay(30);
  if (!ordered(res, from, to)) return;
  try {
    res.json(envelope({ dataset: "ipos", data: await market.ipos(from, to) }));
  } catch (err) {
    fail(res, err, "market-ipos");
  }
});

router.get("/market/lockups", async (req, res) => {
  const q = parse(res, z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }), req.query);
  if (!q) return;
  try {
    res.json(envelope({ dataset: "ipo-lockups", data: await market.lockups(q.days) }));
  } catch (err) {
    fail(res, err, "market-lockups");
  }
});

router.get("/market/mergers", async (req, res) => {
  const q = parse(res, z.object({ limit: limitParam.default(50) }), req.query);
  if (!q) return;
  try {
    res.json(envelope({ dataset: "mergers", data: await market.mergers(q.limit) }));
  } catch (err) {
    fail(res, err, "market-mergers");
  }
});

for (const [path, load] of [
  ["splits", market.splits],
  ["dividends", market.dividends],
] as const) {
  router.get(`/market/${path}`, async (req, res) => {
    const q = parseQuery(res, req.query);
    if (!q) return;
    const from = q.from ?? offsetDay(0);
    const to = q.to ?? offsetDay(30);
    if (!ordered(res, from, to)) return;
    try {
      res.json(envelope({ dataset: path, data: await load(from, to) }));
    } catch (err) {
      fail(res, err, `market-${path}`);
    }
  });
}

for (const [path, kind, snapshot] of [
  ["sectors", "sector", market.sectors],
  ["industries", "industry", market.industries],
] as const) {
  router.get(`/market/${path}`, async (req, res) => {
    const q = parse(res, z.object({ date: day.optional(), exchange }), req.query);
    if (!q) return;
    try {
      res.json(envelope({ dataset: `${kind}-performance`, data: (await snapshot(q.exchange, q.date)).rows }));
    } catch (err) {
      fail(res, err, `market-${path}`);
    }
  });

  router.get(`/market/${path}/history`, async (req, res) => {
    const q = parse(res, z.object({ [kind]: z.string().trim().min(1), exchange, from: day.optional(), to: day.optional() }), req.query) as
      | { [k: string]: string | undefined; exchange: market.Exchange }
      | null;
    if (!q) return;
    const name = q[kind] as string;
    try {
      res.json(envelope({ dataset: `${kind}-history`, data: await market.groupHistory(kind, name, q.exchange, q.from, q.to) }));
    } catch (err) {
      fail(res, err, `market-${path}-history`);
    }
  });
}

router.get("/market/index/:name", async (req, res) => {
  const name = parse(res, indexName, req.params.name);
  if (!name) return;
  try {
    res.json(envelope({ dataset: `index-${name}`, data: await market.indexConstituents(name) }));
  } catch (err) {
    fail(res, err, "market-index");
  }
});

router.get("/market/index/:name/changes", async (req, res) => {
  const name = parse(res, indexName, req.params.name);
  const q = name && parseQuery(res, req.query);
  if (!name || !q) return;
  try {
    res.json(envelope({ dataset: `index-${name}-changes`, data: await market.indexChanges(name, q.from, q.to, q.limit) }));
  } catch (err) {
    fail(res, err, "market-index-changes");
  }
});

router.get("/market/etf/:symbol/holdings", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  const q = symbol && parseQuery(res, req.query);
  if (!symbol || !q) return;
  try {
    const holdings = await market.etfHoldings(symbol);
    res.json(envelope({ symbol, dataset: "etf-holdings", data: q.limit ? holdings.slice(0, q.limit) : holdings }));
  } catch (err) {
    fail(res, err, "etf-holdings");
  }
});

router.get("/market/etf/:symbol/exposure", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  try {
    res.json(envelope({ symbol, dataset: "etf-exposure", data: await market.etfExposure(symbol) }));
  } catch (err) {
    fail(res, err, "etf-exposure");
  }
});

symbolRouter.get("/:symbol/etf-exposure", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  const q = symbol && parseQuery(res, req.query);
  if (!symbol || !q) return;
  try {
    const held = await market.etfAssetExposure(symbol);
    res.json(envelope({ symbol, dataset: "etf-asset-exposure", data: held.slice(0, q.limit ?? 100) }));
  } catch (err) {
    fail(res, err, "etf-asset-exposure");
  }
});

symbolRouter.get("/:symbol/profile", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  try {
    res.json(envelope({ symbol, dataset: "profile", data: await market.companyProfile(symbol) }));
  } catch (err) {
    fail(res, err, "company-profile");
  }
});
