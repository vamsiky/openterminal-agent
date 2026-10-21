import { Router } from "express";
import { z } from "zod";
import { tradingDay } from "../history/time.js";
import { history, nextReportDate, revisions } from "../estimates/store.js";

export const estimatesRouter = Router();

const symbolSchema = z.string().regex(/^(?=.*[A-Za-z0-9])[A-Za-z0-9.\-^=&]{1,20}$/);
const reportSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Read-only: the daily capture job (estimates/capture.ts) fills the table.
estimatesRouter.get("/:symbol", (req, res) => {
  const symbol = symbolSchema.safeParse(req.params.symbol);
  if (!symbol.success) return res.status(400).json({ error: "Invalid symbol" });
  const report = req.query.report === undefined ? undefined : reportSchema.safeParse(req.query.report);
  if (report && !report.success) return res.status(400).json({ error: "report must be YYYY-MM-DD" });

  const sym = symbol.data.toUpperCase();
  const today = tradingDay(new Date().toISOString());
  const reportDate = report?.data ?? nextReportDate(sym, today);
  const points = reportDate ? history(sym, reportDate) : [];
  if (!reportDate || points.length === 0) {
    return res.json({ symbol: sym, next: null, history: [], revisions: revisions([], today) });
  }
  const latest = points[points.length - 1];
  res.json({
    symbol: sym,
    next: { reportDate, eps: latest.eps, revenue: latest.revenue },
    history: points,
    revisions: revisions(points, today),
  });
});
