import { Router } from "express";
import { z } from "zod";
import {
  getCongress,
  getFloat,
  getInsiders,
  getInstitutional,
  getLatestCongress,
  getLatestInsiders,
  getLatestThirteenF,
} from "../../providers/fmp-ownership.js";
import { envelope, fail, limitParam, parseSymbol } from "./common.js";

export const router = Router();
export const marketRouter = Router();

const quarterQuery = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    quarter: z.coerce.number().int().min(1).max(4).optional(),
  })
  .refine((q) => (q.year === undefined) === (q.quarter === undefined), "year and quarter go together");

const limited = (def: number) => z.object({ limit: limitParam.default(def) });

function badQuery(res: import("express").Response, error: z.ZodError) {
  res.status(400).json({ error: error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") });
}

router.get("/:symbol/institutional", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const q = quarterQuery.safeParse(req.query);
  if (!q.success) return badQuery(res, q.error);
  try {
    const explicit = q.data.year !== undefined && q.data.quarter !== undefined ? { year: q.data.year, quarter: q.data.quarter } : undefined;
    res.json(envelope({ symbol, dataset: "institutional", data: await getInstitutional(symbol, explicit) }));
  } catch (err) {
    fail(res, err, "institutional");
  }
});

router.get("/:symbol/insiders", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const q = limited(50).safeParse(req.query);
  if (!q.success) return badQuery(res, q.error);
  try {
    res.json(envelope({ symbol, dataset: "insiders", data: await getInsiders(symbol, q.data.limit) }));
  } catch (err) {
    fail(res, err, "insiders");
  }
});

router.get("/:symbol/congress", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  const q = limited(50).safeParse(req.query);
  if (!q.success) return badQuery(res, q.error);
  try {
    res.json(envelope({ symbol, dataset: "congress", data: await getCongress(symbol, q.data.limit) }));
  } catch (err) {
    fail(res, err, "congress");
  }
});

router.get("/:symbol/float", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  try {
    res.json(envelope({ symbol, dataset: "float", data: await getFloat(symbol) }));
  } catch (err) {
    fail(res, err, "float");
  }
});

function marketRoute(path: string, dataset: string, defLimit: number, load: (limit: number) => Promise<unknown>) {
  marketRouter.get(path, async (req, res) => {
    const q = limited(defLimit).safeParse(req.query);
    if (!q.success) return badQuery(res, q.error);
    try {
      res.json(envelope({ dataset, data: await load(q.data.limit) }));
    } catch (err) {
      fail(res, err, dataset);
    }
  });
}

marketRoute("/insiders/latest", "insiders-latest", 100, getLatestInsiders);
marketRoute("/congress/latest", "congress-latest", 100, getLatestCongress);
marketRoute("/institutional/latest-filings", "institutional-latest-filings", 50, getLatestThirteenF);
