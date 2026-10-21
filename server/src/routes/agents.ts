import { Router } from "express";
import { z } from "zod";
import { agentsEnabled } from "../agents/config.js";
import { requestAnalysis, startRun, status } from "../agents/service.js";
import { getThesis, latestBrief, latestMacro, latestThesisByIdea, latestThesisFor, listBriefs, listMacro, listRuns, listTheses } from "../agents/store.js";

export const agentsRouter = Router();

// Read side and triggers of the AI agents (agents/). Mounted behind requireApiKey.
// POST routes answer 202 and work in the background.

const limitQ = (max: number, dflt: number) => z.coerce.number().int().min(1).max(max).default(dflt);
const strategy = z.enum(["buy", "long_call", "short_put", "covered_call"]);
const symbol = z.string().transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/));
const bad = (res: import("express").Response, e: z.ZodError) => res.status(400).json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

agentsRouter.get("/status", (_req, res) => {
  res.json(status());
});

agentsRouter.get("/macro/latest", (_req, res) => {
  const m = latestMacro();
  if (!m) return res.status(404).json({ error: "no macro report yet" });
  res.json(m);
});

agentsRouter.get("/macro", (req, res) => {
  const q = z.object({ limit: limitQ(100, 10) }).safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  res.json(listMacro(q.data.limit));
});

agentsRouter.get("/theses", (req, res) => {
  const q = z.object({ symbol: symbol.optional(), strategy: strategy.optional(), limit: limitQ(200, 20) }).safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  res.json(listTheses(q.data));
});

// Before /theses/:id so "latest" is not read as an id.
agentsRouter.get("/theses/latest", (req, res) => {
  const q = z
    .object({ ideaId: z.coerce.number().int().positive().optional(), symbol: symbol.optional(), strategy: strategy.optional(), contract: z.string().min(1).max(40).optional() })
    .safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  const { ideaId, symbol: sym, strategy: strat, contract } = q.data;
  if (ideaId === undefined && !(sym && strat)) return res.status(400).json({ error: "pass ideaId, or symbol and strategy (and contract for options)" });
  const t = ideaId !== undefined ? latestThesisByIdea(ideaId) : latestThesisFor(sym!, strat!, contract ?? null);
  if (!t) return res.status(404).json({ error: "no thesis" });
  res.json(t);
});

agentsRouter.get("/theses/:id", (req, res) => {
  const t = /^\d+$/.test(req.params.id) ? getThesis(Number(req.params.id)) : null;
  if (!t) return res.status(404).json({ error: "no such thesis" });
  res.json(t);
});

const analyzeBody = z.object({ symbol, strategy, contract: z.string().min(1).max(40).nullish(), ideaId: z.number().int().positive().nullish() });

agentsRouter.post("/analyze", (req, res) => {
  if (!agentsEnabled()) return res.status(503).json({ error: "agents are disabled (AGENTS_ENABLED=0)" });
  const b = analyzeBody.safeParse(req.body);
  if (!b.success) return bad(res, b.error);
  const r = requestAnalysis(b.data);
  if (r === "disabled") return res.status(503).json({ error: "agents are disabled (AGENTS_ENABLED=0)" });
  if (r === "busy") return res.status(409).json({ error: "already queued or running" });
  if (r === "budget") return res.status(402).json({ error: "daily AI budget reached" });
  res.status(202).json({ queued: true, position: r.position });
});

agentsRouter.post("/run/:agent", (req, res) => {
  const agent = req.params.agent;
  if (agent !== "macro" && agent !== "brief") return res.status(404).json({ error: "agent must be macro or brief" });
  if (!agentsEnabled()) return res.status(503).json({ error: "agents are disabled (AGENTS_ENABLED=0)" });
  const r = startRun(agent, { session: "adhoc" });
  if (r === "busy") return res.status(409).json({ error: `${agent} is already running` });
  if (r === "budget") return res.status(402).json({ error: "daily AI budget reached" });
  if (r === "disabled") return res.status(503).json({ error: "agents are disabled (AGENTS_ENABLED=0)" });
  res.status(202).json({ started: true, agent });
});

agentsRouter.get("/brief/latest", (_req, res) => {
  const b = latestBrief();
  if (!b) return res.status(404).json({ error: "no brief yet" });
  res.json(b);
});

agentsRouter.get("/briefs", (req, res) => {
  const q = z.object({ limit: limitQ(100, 10) }).safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  res.json(listBriefs(q.data.limit));
});

agentsRouter.get("/runs", (req, res) => {
  const q = z.object({ limit: limitQ(500, 50) }).safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  res.json(listRuns(q.data.limit));
});
