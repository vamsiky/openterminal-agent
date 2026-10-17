import { Router } from "express";
import { z } from "zod";
import { dailyBars, historyStatus, minuteBars } from "../history/store.js";
import { tradingDay } from "../history/time.js";
import { alpacaSymbol } from "../history/universe.js";

export const barsRouter = Router();

// Read access to the locally stored history (see history/). Unlike
// /api/history, these never call a provider: they return what the sync jobs
// have stored, so agents and studies get the same numbers every time.

// Accepts Yahoo-style class shares (BRK-B) as well as Alpaca's (BRK.B).
const symbolSchema = z
  .string()
  .regex(/^[A-Za-z0-9.^=-]{1,15}$/)
  .transform((s) => (s.startsWith("^") ? s.toUpperCase() : alpacaSymbol(s) ?? s.toUpperCase()));
const DAILY_LIMIT = 20_000;
const MINUTE_LIMIT = 20_000;
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
  const bars = dailyBars(symbol.data, from.data, to.data, DAILY_LIMIT);
  if (bars.length === DAILY_LIMIT) res.setHeader("X-Truncated", "true");
  res.json(bars);
});

/** Minute bars between two days (New York dates), capped at 20,000 bars per call (X-Truncated: true when cut). */
barsRouter.get("/minute/:symbol", (req, res) => {
  const symbol = symbolSchema.safeParse(req.params.symbol);
  const from = daySchema.safeParse(req.query.from);
  const to = daySchema.safeParse(req.query.to ?? req.query.from);
  if (!symbol.success || !from.success || !to.success) {
    return res.status(400).json({ error: "symbol, and from (and optional to) as YYYY-MM-DD" });
  }
  // A New York day runs from 04:00Z (EDT) or 05:00Z (EST) to the next day's
  // 04:00Z/05:00Z, so query that window and trim the edge hour by date.
  const fromTs = Date.parse(`${from.data}T04:00:00Z`) / 1000;
  const toTs = Date.parse(`${to.data}T00:00:00Z`) / 1000 + 86_400 + 5 * 3600;
  const rows = minuteBars(symbol.data, fromTs, toTs, MINUTE_LIMIT);
  if (rows.length === MINUTE_LIMIT) res.setHeader("X-Truncated", "true");
  res.json(rows.filter((b) => {
    const day = tradingDay(b.ts);
    return day >= from.data && day <= to.data;
  }));
});
