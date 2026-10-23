import { Router } from "express";
import { z } from "zod";
import { listIdeas, ideasAsOf } from "../quant/ideas.js";
import { JOB_NAMES, lastRuns, quantDeps, runJob, type JobName } from "../quant/jobs.js";
import { getOptionScorecard } from "../quant/option-score.js";
import { getLiveScorecard, getStockScorecard } from "../quant/stock-score.js";
import { scanBuildRouter } from "./scan-build.js";
import { scanDefsRouter } from "./scan-defs.js";
import { getUniverseSettings, listSectors, resolveUniverse, setUniverseSettings, universeSchema } from "../quant/universe.js";

export const scanRouter = Router();
scanRouter.use(scanDefsRouter);
scanRouter.use(scanBuildRouter);

// The scan engine's read side (quant/). Mounted behind requireApiKey.

scanRouter.get("/universe", (_req, res) => {
  res.json({ settings: getUniverseSettings(), symbolCount: resolveUniverse().length });
});

// PUT per the spec; POST too, because the web proxy only forwards GET, POST and DELETE.
const saveUniverse: import("express").RequestHandler = (req, res) => {
  const body = universeSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const settings = setUniverseSettings(body.data);
  res.json({ settings, symbolCount: resolveUniverse(settings).length });
};
scanRouter.put("/universe", saveUniverse);
scanRouter.post("/universe", saveUniverse);

scanRouter.get("/universe/symbols", (_req, res) => {
  res.json({ symbols: resolveUniverse() });
});

scanRouter.get("/sectors", (_req, res) => {
  res.json(listSectors());
});

const ideasQuery = z.object({
  kind: z.enum(["stock", "option"]).optional(),
  status: z.enum(["active", "dropped", "near"]).default("active"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

scanRouter.get("/ideas", (req, res) => {
  const q = ideasQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "kind must be stock or option, status active, dropped or near, limit 1-100" });
  if (q.data.status === "near") {
    // Near misses exist for options only: setups below the listing bar that the active definition keeps.
    if (q.data.kind === "stock") return res.status(400).json({ error: "near misses are kept for options only" });
    const ideas = listIdeas({ ...q.data, kind: "option" });
    return res.json({ asOf: ideas[0]?.lastSeen ?? null, ideas });
  }
  res.json({ asOf: ideasAsOf(q.data.kind), ideas: listIdeas(q.data) });
});

scanRouter.get("/scorecard/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) return res.status(400).json({ error: "invalid symbol" });
  res.json({ stock: getStockScorecard(symbol), live: getLiveScorecard(symbol), options: getOptionScorecard(symbol) });
});

scanRouter.get("/status", (_req, res) => {
  res.json({ runs: lastRuns(), options: quantDeps()?.optionsStatus() ?? null });
});

// Force a job now (checks, demos). 409 while another run is in progress.
scanRouter.post("/run/:job", (req, res) => {
  const job = req.params.job as JobName;
  if (!JOB_NAMES.includes(job)) return res.status(404).json({ error: `unknown job; one of ${JOB_NAMES.join(", ")}` });
  if (!runJob(job)) return res.status(409).json({ error: "another run is in progress, or the options layer is not connected" });
  res.json({ ran: job, run: lastRuns()[job] ?? null });
});
