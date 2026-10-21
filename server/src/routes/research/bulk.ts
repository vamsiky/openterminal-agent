import { Router } from "express";
import { z } from "zod";
import { FmpNotConfigured, isConfigured } from "../../providers/fmp-core.js";
import * as store from "../../research/bulk-store.js";
import type { ScreenField } from "../../research/bulk-store.js";
import { envelope, fail } from "./common.js";

// Whole-market screen over the bulk tables (research/bulk-store.ts), and the
// state of each bulk dataset. Mounted before the per-symbol routers.

export const router = Router();

const fieldName = z.enum(store.SCREEN_FIELD_NAMES as [ScreenField, ...ScreenField[]]);
const sortField = z.enum(store.SORTABLE_FIELDS as [ScreenField, ...ScreenField[]]);
const number = z.coerce.number().finite();
const list = (item: z.ZodTypeAny) =>
  z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item).max(60));
const text = z.string().trim().min(1).max(100);

export const screenQuery = z
  .object({
    sector: text.optional(),
    industry: text.optional(),
    exchange: list(z.string().toUpperCase().pipe(z.enum(["NASDAQ", "NYSE", "AMEX", "CBOE", "OTC"]))).optional(),
    marketCapMin: number.optional(),
    marketCapMax: number.optional(),
    peMin: number.optional(),
    peMax: number.optional(),
    epsGrowthMin: number.optional(),
    revenueGrowthMin: number.optional(),
    dividendYieldMin: number.optional(),
    betaMax: number.optional(),
    ratingMin: z.coerce.number().int().min(1).max(5).optional(),
    upsideMin: number.optional(),
    sort: sortField.default("marketCap"),
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    fields: list(fieldName).optional(),
  })
  .strict();

router.get("/screen", (req, res) => {
  const q = screenQuery.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") });
    return;
  }
  try {
    const { asOf, rows } = store.screen(q.data);
    if (!asOf) {
      if (!isConfigured()) throw new FmpNotConfigured();
      res.status(503).json({ error: "bulk data is still loading: see /api/research/market/datasets", feature: "screen" });
      return;
    }
    res.json(envelope({ dataset: "screen", data: rows, asOf }));
  } catch (err) {
    fail(res, err, "screen");
  }
});

router.get("/market/datasets", (_req, res) => {
  try {
    res.json(envelope({ dataset: "datasets", data: store.datasets() }));
  } catch (err) {
    fail(res, err, "datasets");
  }
});
