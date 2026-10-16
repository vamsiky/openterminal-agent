import { Router } from "express";
import { z } from "zod";
import { dailyBars, historyStatus, minuteBars } from "../history/store.js";
import { tradingDay } from "../history/time.js";

export const barsRouter = Router();

// Read access to the locally stored history (see history/). Unlike
// /api/history, these never call a provider: they return what the sync jobs
// have stored, so agents and studies get the same numbers every time.

const symbolSchema = z.string().regex(/^[A-Za-z0-9.^=-]{1,15}$/).transform((s) => s.toUpperCase());
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

barsRouter.get("/status", (_req, res) => {
  res.json(historyStatus());
});

barsRouter.get("/daily/:symbol", (req, res) => {
  const symbol = symbolSchema.safeParse(req.params.symbol);
  const from = daySchema.safeParse(req.query.from ?? "1900-01-01");
  const to = daySchema.safeParse(req.query.to ?? "2999-12-31");
  if (!symbol.success || !from.success || !to.success) {
    return res.status(400).json({ error: "symbol, and from/to as YYYY-MM-DD" });
  }
  res.json(dailyBars(symbol.data, from.data, to.data));
});

/** Minute bars between two days (New York dates), capped at 20,000 bars per call. */
barsRouter.get("/minute/:symbol", (req, res) => {
  const symbol = symbolSchema.safeParse(req.params.symbol);
  const from = daySchema.safeParse(req.query.from);
  const to = daySchema.safeParse(req.query.to ?? req.query.from);
  if (!symbol.success || !from.success || !to.success) {
    return res.status(400).json({ error: "symbol, and from (and optional to) as YYYY-MM-DD" });
  }
  // Pad the UTC range by a day each side, then keep only the requested New York days.
  const fromTs = Date.parse(`${from.data}T00:00:00Z`) / 1000 - 86_400;
  const toTs = Date.parse(`${to.data}T00:00:00Z`) / 1000 + 2 * 86_400;
  res.json(minuteBars(symbol.data, fromTs, toTs).filter((b) => {
    const day = tradingDay(b.ts);
    return day >= from.data && day <= to.data;
  }));
});
