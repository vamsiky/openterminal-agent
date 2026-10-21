import { Router } from "express";
import { z } from "zod";
import { optionsHandle } from "../options/jobs.js";
import { RANK_WINDOW, ivHistory, latestOptionMetrics, optionBars } from "../options/store.js";
import { parseOcc } from "../providers/alpaca-options.js";

export const optionsDataRouter = Router();

const symbolSchema = z.string().regex(/^[A-Za-z0-9.-]{1,12}$/);
const daysSchema = z.coerce.number().int().min(1).max(5000);
// A time as unix seconds or an ISO date/time.
const timeSchema = z.string().transform((v, ctx) => {
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v);
  if (!Number.isFinite(ms)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected unix seconds or an ISO time" });
    return z.NEVER;
  }
  return Math.floor(ms / 1000);
});

// Status and the contracts the stream is subscribed to, each with its latest quote.
optionsDataRouter.get("/stream", (_req, res) => {
  const h = optionsHandle();
  if (!h) return res.json({ status: null, contracts: [] });
  const contracts = h.stream.subscribedContracts().map((occ) => ({ occ, quote: h.stream.quote(occ) }));
  res.json({ status: h.status(), contracts });
});

optionsDataRouter.get("/metrics/:symbol", (req, res) => {
  const symbol = symbolSchema.safeParse(req.params.symbol);
  if (!symbol.success) return res.status(400).json({ error: "Invalid symbol" });
  const sym = symbol.data.toUpperCase();
  const metrics = latestOptionMetrics([sym]).get(sym);
  if (!metrics) return res.status(404).json({ error: `No option metrics for ${sym}` });
  res.json(metrics);
});

optionsDataRouter.get("/iv/:symbol", (req, res) => {
  const symbol = symbolSchema.safeParse(req.params.symbol);
  const days = req.query.days === undefined ? { success: true as const, data: RANK_WINDOW } : daysSchema.safeParse(req.query.days);
  if (!symbol.success) return res.status(400).json({ error: "Invalid symbol" });
  if (!days.success) return res.status(400).json({ error: "days must be a positive integer" });
  const sym = symbol.data.toUpperCase();
  res.json({ symbol: sym, history: ivHistory(sym, days.data) });
});

optionsDataRouter.get("/bars/:occ", (req, res) => {
  const occ = req.params.occ.toUpperCase();
  if (!parseOcc(occ)) return res.status(400).json({ error: "Invalid OCC symbol" });
  const nowS = Math.floor(Date.now() / 1000);
  const from = req.query.from === undefined ? { success: true as const, data: nowS - 86_400 } : timeSchema.safeParse(req.query.from);
  const to = req.query.to === undefined ? { success: true as const, data: nowS } : timeSchema.safeParse(req.query.to);
  if (!from.success || !to.success) return res.status(400).json({ error: "from and to must be unix seconds or ISO times" });
  res.json({ occ, bars: optionBars(occ, from.data, to.data) });
});
