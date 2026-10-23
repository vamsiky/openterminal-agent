import { Router } from "express";
import { z } from "zod";
import { catalog } from "../scandef/catalog.js";
import { diff, formOf } from "../scandef/leaves.js";
import { getActive, getById, getDraft, listVersions, type DefRecord } from "../scandef/store.js";

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
  return { meta: meta(rec)!, definition: rec.definition, text: rec.text, form: formOf(rec.definition), diff: parent ? diff(parent.definition, rec.definition) : [] };
}

scanDefsRouter.get("/defs/:id", (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "id must be a number" });
  const rec = getById(Number(req.params.id));
  if (!rec) return res.status(404).json({ error: "no such definition" });
  res.json(defView(rec));
});
