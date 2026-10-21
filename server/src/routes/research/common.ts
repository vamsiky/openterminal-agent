import type { Response } from "express";
import { z } from "zod";
import { FmpError, FmpNotConfigured } from "../../providers/fmp-core.js";
import { isForeignSymbol } from "../../history/universe.js";

/** A US-listed ticker, uppercased: BRK.B and BRK-B both pass. Foreign listings are refused. */
export const symbolParam = z
  .string()
  .trim()
  .regex(/^(?=.*[A-Za-z0-9])[A-Za-z0-9.\-^=&]{1,20}$/, "invalid symbol")
  .transform((s) => s.toUpperCase())
  .refine((s) => !isForeignSymbol(s), "US-listed symbols only (e.g. TSM for TSMC)");

export type Envelope<T> = { symbol?: string; dataset: string; source: "fmp"; asOf: string; data: T };

export function envelope<T>(o: { symbol?: string; dataset: string; data: T; asOf?: Date | string }): Envelope<T> {
  const asOf = o.asOf instanceof Date ? o.asOf.toISOString() : (o.asOf ?? new Date().toISOString());
  return { ...(o.symbol ? { symbol: o.symbol } : {}), dataset: o.dataset, source: "fmp", asOf, data: o.data };
}

/** Answers a provider failure: 503 without a key, 502 when FMP fails, 500 otherwise. */
export function fail(res: Response, err: unknown, feature: string): void {
  if (err instanceof FmpNotConfigured) {
    res.status(503).json({ error: "needs FMP_API_KEY", feature });
    return;
  }
  if (err instanceof FmpError) {
    // FmpError messages never carry the URL, but scrub the key anyway.
    const key = process.env.FMP_API_KEY?.trim();
    const message = key ? err.message.split(key).join("[redacted]") : err.message;
    res.status(502).json({ error: message, feature });
    return;
  }
  res.status(500).json({ error: "internal error", feature });
}

export const periodParam = z.enum(["quarter", "annual", "ttm"]);
export const limitParam = z.coerce.number().int().min(1).max(1000);
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Query params shared by most datasets; each is optional. `period` defaults to nothing so routes pick their own. */
export const researchQuery = z.object({
  period: periodParam.optional(),
  limit: limitParam.optional(),
  from: dateParam.optional(),
  to: dateParam.optional(),
});
export type ResearchQuery = z.infer<typeof researchQuery>;

/** Parses req.query; on failure answers 400 and returns null. */
export function parseQuery(res: Response, query: unknown): ResearchQuery | null {
  const r = researchQuery.safeParse(query);
  if (r.success) return r.data;
  res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  return null;
}

/** Parses the :symbol route param; on failure answers 400 and returns null. */
export function parseSymbol(res: Response, raw: unknown): string | null {
  const r = symbolParam.safeParse(raw);
  if (r.success) return r.data;
  res.status(400).json({ error: r.error.issues[0]?.message ?? "invalid symbol" });
  return null;
}
