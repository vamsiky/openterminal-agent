import { Router } from "express";
import { z } from "zod";
import { getJob, startBuild } from "../scandef/build.js";
import { addCodeRequest, listCodeRequests } from "../scandef/code-requests.js";
import { getById } from "../scandef/store.js";

// Scan Lab's build-with-Claude jobs and code requests. Mounted under /api/scan.

export const scanBuildRouter = Router();

const kind = z.enum(["stock", "option"]);
const bad = (res: import("express").Response, e: z.ZodError) => res.status(400).json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

const buildBody = z.object({ kind, baseId: z.number().int().positive().nullish(), text: z.string().trim().min(1).max(20_000) });

scanBuildRouter.post("/defs/build", (req, res) => {
  const b = buildBody.safeParse(req.body);
  if (!b.success) return bad(res, b.error);
  const r = startBuild(b.data.kind, b.data.baseId ?? undefined, b.data.text);
  if (r === "disabled") return res.status(503).json({ error: "agents are disabled (AGENTS_ENABLED=0)" });
  if (r === "busy") return res.status(409).json({ error: `a ${b.data.kind} build is already running` });
  if (r === "budget") return res.status(402).json({ error: "daily AI budget reached" });
  if (r === "no_base") return res.status(404).json({ error: `no ${b.data.kind} definition with id ${b.data.baseId}` });
  res.status(202).json(r);
});

scanBuildRouter.get("/defs/build/:jobId", (req, res) => {
  const j = getJob(req.params.jobId);
  if (!j) return res.status(404).json({ error: "no such build" });
  res.json({ status: j.status, draftId: j.draftId, notes: j.notes, needsCode: j.needsCode, error: j.error, refused: j.refused, lines: j.lines });
});

const codeBody = z.object({ kind, draftId: z.number().int().positive().nullish(), request: z.string().trim().min(1).max(2000), reason: z.string().trim().max(2000).default("") });

scanBuildRouter.post("/code-requests", (req, res) => {
  const b = codeBody.safeParse(req.body);
  if (!b.success) return bad(res, b.error);
  if (b.data.draftId != null && getById(b.data.draftId)?.kind !== b.data.kind) return res.status(404).json({ error: `no ${b.data.kind} draft with id ${b.data.draftId}` });
  res.status(201).json(addCodeRequest({ kind: b.data.kind, draftId: b.data.draftId ?? null, request: b.data.request, reason: b.data.reason }));
});

scanBuildRouter.get("/code-requests", (req, res) => {
  const q = z.object({ kind: kind.optional(), status: z.enum(["open", "done", "declined"]).optional() }).safeParse(req.query);
  if (!q.success) return bad(res, q.error);
  res.json({ requests: listCodeRequests(q.data) });
});
