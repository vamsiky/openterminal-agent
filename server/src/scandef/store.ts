import { db } from "../db.js";
import { OPTION_V1_DEF, STOCK_V2_DEF } from "./builtins.js";
import { render } from "./render.js";
import { parseDefinition, type DefKind, type Definition, type OptionDefinition, type StockDefinition } from "./schema.js";

// Versioned definitions in SQLite. One active per kind, at most one open draft per kind (a new draft
// replaces it), and the previous active kept for rollback. The active definition is cached in memory
// and reloaded whenever a status changes.

export type DefStatus = "active" | "draft" | "previous" | "retired" | "discarded";
export type DefAuthor = "built-in" | "form" | "claude";

export type DefMeta = {
  id: number;
  kind: DefKind;
  version: string;
  status: DefStatus;
  parentId: number | null;
  author: DefAuthor;
  sourceText: string | null;
  notes: unknown;
  createdAt: string;
  promotedAt: string | null;
};
export type DefRecord<D extends Definition = Definition> = DefMeta & { definition: D; text: string };

db.exec(`
CREATE TABLE IF NOT EXISTS scan_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('option','stock')),
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','draft','previous','retired','discarded')),
  definition TEXT NOT NULL,
  text TEXT NOT NULL,
  parent_id INTEGER REFERENCES scan_definitions(id),
  author TEXT NOT NULL CHECK (author IN ('built-in','form','claude')),
  source_text TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  UNIQUE (kind, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS scan_definitions_one_active ON scan_definitions (kind) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS scan_definitions_one_draft ON scan_definitions (kind) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS scan_definitions_one_previous ON scan_definitions (kind) WHERE status = 'previous';
`);

type Row = {
  id: number;
  kind: DefKind;
  version: string;
  status: DefStatus;
  definition: string;
  text: string;
  parent_id: number | null;
  author: DefAuthor;
  source_text: string | null;
  notes: string | null;
  created_at: string;
  promoted_at: string | null;
};

const meta = (r: Row): DefMeta => ({
  id: r.id, kind: r.kind, version: r.version, status: r.status, parentId: r.parent_id, author: r.author,
  sourceText: r.source_text, notes: r.notes ? JSON.parse(r.notes) : null, createdAt: r.created_at, promotedAt: r.promoted_at,
});
const record = (r: Row): DefRecord => ({ ...meta(r), definition: JSON.parse(r.definition) as Definition, text: r.text });

export class DefinitionError extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

// ---- change notifications ----

export type DefEvent = { kind: DefKind; event: "activated" | "drafted" | "discarded"; id: number };
const listeners: Array<(e: DefEvent) => void> = [];
/** Called after a definition is activated (promote or rollback), a draft is created or a draft is discarded. */
export function onDefinitionChange(fn: (e: DefEvent) => void): void {
  listeners.push(fn);
}
const cache = new Map<DefKind, DefRecord>();
function changed(e: DefEvent): void {
  cache.delete(e.kind);
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.error("[scandef] listener failed:", err);
    }
  }
}

// ---- reads ----

export function getById(id: number): DefRecord | null {
  const r = db.prepare("SELECT * FROM scan_definitions WHERE id = ?").get(id) as Row | undefined;
  return r ? record(r) : null;
}

export function getByVersion(kind: DefKind, version: string): DefRecord | null {
  const r = db.prepare("SELECT * FROM scan_definitions WHERE kind = ? AND version = ?").get(kind, version) as Row | undefined;
  return r ? record(r) : null;
}

export function getActive(kind: "option"): DefRecord<OptionDefinition>;
export function getActive(kind: "stock"): DefRecord<StockDefinition>;
export function getActive(kind: DefKind): DefRecord;
/** The active definition of a kind, from memory after the first read. */
export function getActive(kind: DefKind): DefRecord {
  const hit = cache.get(kind);
  if (hit) return hit;
  const r = db.prepare("SELECT * FROM scan_definitions WHERE kind = ? AND status = 'active'").get(kind) as Row | undefined;
  if (!r) throw new Error(`no active ${kind} definition`);
  const rec = record(r);
  cache.set(kind, rec);
  return rec;
}

export const activeOption = (): OptionDefinition => getActive("option").definition;
export const activeStock = (): StockDefinition => getActive("stock").definition;

export function getDraft(kind: DefKind): DefRecord | null {
  const r = db.prepare("SELECT * FROM scan_definitions WHERE kind = ? AND status = 'draft'").get(kind) as Row | undefined;
  return r ? record(r) : null;
}

/** Metadata of every version of a kind, newest first. */
export function listVersions(kind: DefKind): DefMeta[] {
  return (db.prepare("SELECT * FROM scan_definitions WHERE kind = ? ORDER BY id DESC").all(kind) as Row[]).map(meta);
}

// ---- writes ----

const num = (v: string) => Number(/-v(\d+)$/.exec(v)?.[1] ?? 0);

/** The next version name for a kind: option-v2, stock-v3, ... */
export function nextVersion(kind: DefKind): string {
  const rows = db.prepare("SELECT version FROM scan_definitions WHERE kind = ?").all(kind) as Array<{ version: string }>;
  return `${kind}-v${Math.max(0, ...rows.map((r) => num(r.version))) + 1}`;
}

export type DraftInput = {
  kind: DefKind;
  /** The definition the draft derives from; defaults to the active one. */
  baseId?: number;
  /** The new definition. Its version and parent are replaced by the store. */
  definition: unknown;
  author: Exclude<DefAuthor, "built-in">;
  sourceText?: string | null;
  notes?: unknown;
};

/** Validates, names (next version) and stores a draft, discarding the open one. Throws DefinitionError when invalid. */
export function createDraft(input: DraftInput): DefRecord {
  const base = input.baseId !== undefined ? getById(input.baseId) : getActive(input.kind);
  if (!base || base.kind !== input.kind) throw new DefinitionError([`no ${input.kind} definition with id ${input.baseId}`]);
  const version = nextVersion(input.kind);
  const candidate = { ...(input.definition as object), kind: input.kind, version, parent: base.version };
  const parsed = parseDefinition(candidate);
  if (!parsed.ok) throw new DefinitionError(parsed.errors);
  const id = db.transaction(() => {
    const open = db.prepare("SELECT id FROM scan_definitions WHERE kind = ? AND status = 'draft'").get(input.kind) as { id: number } | undefined;
    if (open) db.prepare("UPDATE scan_definitions SET status = 'discarded' WHERE id = ?").run(open.id);
    const r = db
      .prepare(
        `INSERT INTO scan_definitions (kind, version, status, definition, text, parent_id, author, source_text, notes, created_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.kind, version, JSON.stringify(parsed.def), render(parsed.def), base.id, input.author, input.sourceText ?? null, input.notes === undefined ? null : JSON.stringify(input.notes), new Date().toISOString());
    return Number(r.lastInsertRowid);
  })();
  changed({ kind: input.kind, event: "drafted", id });
  return getById(id)!;
}

/**
 * Moves a version to a new status. Allowed: draft to active (promote: the old active becomes previous, the old
 * previous retired), previous to active (roll back: the two swap, so the active one becomes previous), draft to discarded, previous to
 * retired. Anything else throws.
 */
export function setStatus(id: number, status: DefStatus): DefRecord {
  const cur = getById(id);
  if (!cur) throw new Error(`no definition with id ${id}`);
  const now = new Date().toISOString();
  const set = db.prepare("UPDATE scan_definitions SET status = ? WHERE id = ?");
  if (status === "active" && (cur.status === "draft" || cur.status === "previous")) {
    db.transaction(() => {
      const active = db.prepare("SELECT id FROM scan_definitions WHERE kind = ? AND status = 'active'").get(cur.kind) as { id: number } | undefined;
      if (cur.status === "draft") {
        db.prepare("UPDATE scan_definitions SET status = 'retired' WHERE kind = ? AND status = 'previous'").run(cur.kind);
        if (active) set.run("previous", active.id);
        db.prepare("UPDATE scan_definitions SET status = 'active', promoted_at = ? WHERE id = ?").run(now, id);
      } else {
        // Roll back is a swap: the active one becomes previous, so it can be switched back to.
        if (active) set.run("retired", active.id); // parked while both indexes are rewritten
        db.prepare("UPDATE scan_definitions SET status = 'active', promoted_at = ? WHERE id = ?").run(now, id);
        if (active) set.run("previous", active.id);
      }
    })();
    changed({ kind: cur.kind, event: "activated", id });
  } else if (status === "discarded" && cur.status === "draft") {
    set.run("discarded", id);
    changed({ kind: cur.kind, event: "discarded", id });
  } else if (status === "retired" && cur.status === "previous") {
    set.run("retired", id);
    changed({ kind: cur.kind, event: "discarded", id });
  } else throw new Error(`cannot move a ${cur.status} definition to ${status}`);
  return getById(id)!;
}

function seed(def: Definition): void {
  const has = db.prepare("SELECT 1 FROM scan_definitions WHERE kind = ?").get(def.kind);
  if (has) return;
  db.prepare(
    `INSERT INTO scan_definitions (kind, version, status, definition, text, parent_id, author, created_at, promoted_at)
     VALUES (?, ?, 'active', ?, ?, NULL, 'built-in', ?, ?)`
  ).run(def.kind, def.version, JSON.stringify(def), render(def), new Date().toISOString(), new Date().toISOString());
}
seed(OPTION_V1_DEF);
seed(STOCK_V2_DEF);
