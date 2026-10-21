import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { fmpSymbol } from "../../providers/fmp-core.js";
import * as fund from "../../providers/fmp-fundamentals.js";
import { history, nextReportDate, revisions } from "../../estimates/store.js";
import { tradingDay } from "../../history/time.js";
import { envelope, fail, parseQuery, parseSymbol } from "./common.js";

export const router = Router();

const typeParam = z.enum(["income", "balance", "cashflow"]);

/** Parses the symbol and the shared query, answers 400 on either failing. */
function parse(req: Request, res: Response) {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return null;
  const q = parseQuery(res, req.query);
  return q ? { symbol, q, range: { from: q.from, to: q.to } } : null;
}

const bad = (res: Response, error: string) => void res.status(400).json({ error });

router.get("/:symbol/statements", async (req, res) => {
  const p = parse(req, res);
  if (!p) return;
  const type = typeParam.safeParse(req.query.type ?? "income");
  if (!type.success) return bad(res, "type: expected income, balance or cashflow");
  try {
    const r = await fund.statements(p.symbol, type.data, p.q.period ?? "quarter", p.q.limit ?? 8, p.range);
    res.json(envelope({ symbol: p.symbol, dataset: "statements", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.statements");
  }
});

router.get("/:symbol/metrics", async (req, res) => {
  const p = parse(req, res);
  if (!p) return;
  try {
    const r = await fund.metrics(p.symbol, p.q.period ?? "quarter", p.q.limit ?? 8, p.range);
    res.json(envelope({ symbol: p.symbol, dataset: "metrics", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.metrics");
  }
});

router.get("/:symbol/growth", async (req, res) => {
  const p = parse(req, res);
  if (!p) return;
  if (p.q.period === "ttm") return bad(res, "period: growth supports quarter or annual");
  try {
    const r = await fund.growth(p.symbol, p.q.period ?? "quarter", p.q.limit ?? 8, p.range);
    res.json(envelope({ symbol: p.symbol, dataset: "growth", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.growth");
  }
});

router.get("/:symbol/scores", async (req, res) => {
  const p = parse(req, res);
  if (!p) return;
  try {
    const r = await fund.scores(p.symbol, p.q.limit ?? 4);
    res.json(envelope({ symbol: p.symbol, dataset: "scores", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.scores");
  }
});

router.get("/:symbol/segments", async (req, res) => {
  const p = parse(req, res);
  if (!p) return;
  if (p.q.period === "ttm") return bad(res, "period: segments support quarter or annual");
  try {
    const r = await fund.segments(p.symbol, p.q.period ?? "annual", p.q.limit ?? 8, p.range);
    res.json(envelope({ symbol: p.symbol, dataset: "segments", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.segments");
  }
});

router.get("/:symbol/estimates", async (req, res) => {
  const p = parse(req, res);
  if (!p) return;
  if (p.q.period === "ttm") return bad(res, "period: estimates support quarter or annual");
  try {
    const today = tradingDay(new Date().toISOString());
    const r = await fund.analystEstimates(p.symbol, p.q.period ?? "annual", p.q.limit ?? 8, p.range, today);
    // The app's own daily snapshots of the next report's EPS/revenue consensus; keyed by FMP's spelling.
    const sym = fmpSymbol(p.symbol);
    const reportDate = nextReportDate(sym, today);
    const points = reportDate ? history(sym, reportDate) : [];
    const latest = points[points.length - 1];
    const nextReport = {
      reportDate: reportDate && latest ? reportDate : null,
      eps: latest?.eps ?? null,
      revenue: latest?.revenue ?? null,
      history: points,
      revisions: revisions(points, today),
    };
    res.json(envelope({ symbol: p.symbol, dataset: "estimates", data: { estimates: r.data, nextReport }, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.estimates");
  }
});

router.get("/:symbol/analysts", async (req, res) => {
  const p = parse(req, res);
  if (!p) return;
  try {
    const r = await fund.analysts(p.symbol, p.q.limit ?? 20, p.range);
    res.json(envelope({ symbol: p.symbol, dataset: "analysts", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.analysts");
  }
});

router.get("/:symbol/valuation", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  try {
    const r = await fund.valuation(symbol);
    res.json(envelope({ symbol, dataset: "valuation", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.valuation");
  }
});

router.get("/:symbol/peers", async (req, res) => {
  const symbol = parseSymbol(res, req.params.symbol);
  if (!symbol) return;
  try {
    const r = await fund.peers(symbol);
    res.json(envelope({ symbol, dataset: "peers", data: r.data, asOf: r.asOf }));
  } catch (err) {
    fail(res, err, "research.peers");
  }
});
