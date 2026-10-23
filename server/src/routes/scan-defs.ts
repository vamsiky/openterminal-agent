import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { catalog } from "../scandef/catalog.js";
import { diff, formOf } from "../scandef/leaves.js";
import { applyForm } from "../scandef/leaves.js";
import { createDraft, DefinitionError, getActive, getById, getDraft, listVersions, setStatus, type DefRecord } from "../scandef/store.js";
import { compareResults } from "../scantest/result.js";
import { replayOption, replayStock, type OptionSnapshot, type StockSnapshot } from "../scantest/replay.js";
import { latestReplay, listInputs, loadInput, replayCount, saveReplay, shadowPass, shadowView, startShadow, stopShadow } from "../scantest/store.js";

// Scan Lab's read side: the data catalog and the versioned definitions. Mounted under /api/scan.

export const scanDefsRouter = Router();

scanDefsRouter.get("/catalog", (req, res) => {
  const q = z.object({ scope: z.enum(["stock", "option"]).optional() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "scope must be stock or option" });
  res.json({ fields: catalog(q.data.scope) });
});

const meta = (r: DefRecord | null) => (r ? { id: r.id, kind: r.kind, version: r.version, status: r.status, parentId: r.parentId, author: r.author, sourceText: r.sourceText, notes: r.notes, createdAt: r.createdAt, promotedAt: r.promotedAt } : null);

scanDefsRouter.get("/defs", (req, res) => {
  const q = z.object({ kind: z.enum(["stock", "option"]) }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "kind must be stock or option" });
  res.json({ active: meta(getActive(q.data.kind)), draft: meta(getDraft(q.data.kind)), versions: listVersions(q.data.kind) });
});

/** A definition as the Scan Lab shows it: metadata, JSON, text, settings form and the diff against its parent. */
export function defView(rec: DefRecord) {
  const parent = rec.parentId !== null ? getById(rec.parentId) : null;
  return { meta: meta(rec)!, definition: rec.definition, text: rec.text, form: formOf(rec.definition), diff: parent ? diff(parent.definition, rec.definition) : [], tests: { replay: latestReplay(rec.id), shadow: shadowView(rec.id, rec.kind) } };
}

scanDefsRouter.get("/defs/:id", (req, res) => {
  const rec = recordOf(req, res);
  if (rec) res.json(defView(rec));
});

function recordOf(req: Request, res: Response): DefRecord | null {
  if (!/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: "id must be a number" });
    return null;
  }
  const rec = getById(Number(req.params.id));
  if (!rec) res.status(404).json({ error: "no such definition" });
  return rec;
}

/** The record when it is an open draft; otherwise answers 409. */
function draftOf(req: Request, res: Response): DefRecord | null {
  const rec = recordOf(req, res);
  if (rec && rec.status !== "draft") {
    res.status(409).json({ error: `only a draft can do this; ${rec.version} is ${rec.status}` });
    return null;
  }
  return rec;
}

// ---- form edits ----

const draftBody = z.object({
  kind: z.enum(["stock", "option"]),
  baseId: z.number().int().positive().optional(),
  edits: z.array(z.object({ path: z.string().min(1), value: z.union([z.number(), z.boolean(), z.string(), z.null()]) })).min(1).max(500),
});

scanDefsRouter.post("/defs/draft", (req, res) => {
  const body = draftBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const { kind, baseId, edits } = body.data;
  const base = baseId !== undefined ? getById(baseId) : getActive(kind);
  if (!base || base.kind !== kind) return res.status(404).json({ error: `no ${kind} definition with id ${baseId}` });
  const applied = applyForm(base.definition, edits);
  if (!applied.ok) return res.status(400).json({ error: applied.errors.join("; "), errors: applied.errors });
  try {
    res.status(201).json(defView(createDraft({ kind, baseId: base.id, definition: applied.def, author: "form" })));
  } catch (err) {
    if (err instanceof DefinitionError) return res.status(400).json({ error: err.message, errors: err.errors });
    throw err;
  }
});

// ---- tests ----

scanDefsRouter.get("/inputs", (req, res) => {
  const q = z.object({ kind: z.enum(["stock", "option"]) }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "kind must be stock or option" });
  res.json({ passes: listInputs(q.data.kind) });
});

const replayBody = z.object({ source: z.string().min(1).default("latest") });

scanDefsRouter.post("/defs/:id/replay", (req, res) => {
  const rec = recordOf(req, res);
  if (!rec) return;
  const body = replayBody.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'source must be "latest" or a pass time' });
  const stored = loadInput<OptionSnapshot | StockSnapshot>(rec.kind, body.data.source);
  if (!stored) return res.status(404).json({ error: body.data.source === "latest" ? `no stored ${rec.kind} inputs yet; a scheduled pass has to run first` : `no stored ${rec.kind} pass at ${body.data.source}` });
  const r = rec.kind === "option" ? replayOption(stored.payload as OptionSnapshot, rec.definition as never) : replayStock(stored.payload as StockSnapshot, rec.definition as never);
  res.status(201).json(saveReplay(rec.id, rec.kind, stored.passAt, r.live, r.draft));
});

scanDefsRouter.get("/defs/:id/replay", (req, res) => {
  const rec = recordOf(req, res);
  if (!rec) return;
  res.json({ replay: latestReplay(rec.id) });
});

const shadowBody = z.object({ on: z.boolean() });

scanDefsRouter.post("/defs/:id/shadow", (req, res) => {
  const rec = draftOf(req, res);
  if (!rec) return;
  const body = shadowBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "on must be true or false" });
  if (body.data.on) startShadow(rec.kind, rec.id);
  else stopShadow(rec.kind);
  res.json(shadowView(rec.id, rec.kind));
});

scanDefsRouter.get("/defs/:id/shadow", (req, res) => {
  const rec = recordOf(req, res);
  if (!rec) return;
  const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "limit must be 1 to 500" });
  res.json(shadowView(rec.id, rec.kind, q.data.limit));
});

scanDefsRouter.get("/defs/:id/compare", (req, res) => {
  const rec = recordOf(req, res);
  if (!rec) return;
  const q = z.object({ source: z.enum(["replay", "shadow"]), at: z.string().optional() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "source must be replay or shadow" });
  const pass = q.data.source === "replay" ? latestReplay(rec.id) : shadowPass(rec.id, q.data.at);
  if (!pass) return res.status(404).json({ error: `no ${q.data.source} result for ${rec.version} yet` });
  res.json({ source: q.data.source, at: "passAt" in pass ? pass.passAt : pass.at, ...compareResults(pass.live, pass.draft) });
});

// ---- promote, roll back, discard ----

scanDefsRouter.post("/defs/:id/promote", (req, res) => {
  const rec = draftOf(req, res);
  if (!rec) return;
  if (replayCount(rec.id) === 0) return res.status(409).json({ error: `replay ${rec.version} before promoting it` });
  res.json(defView(setStatus(rec.id, "active")));
});

scanDefsRouter.post("/defs/:id/rollback", (req, res) => {
  const rec = recordOf(req, res);
  if (!rec) return;
  if (rec.status !== "previous") return res.status(409).json({ error: `only the previous version can be rolled back to; ${rec.version} is ${rec.status}` });
  res.json(defView(setStatus(rec.id, "active")));
});

scanDefsRouter.post("/defs/:id/discard", (req, res) => {
  const rec = draftOf(req, res);
  if (!rec) return;
  res.json(defView(setStatus(rec.id, "discarded")));
});
