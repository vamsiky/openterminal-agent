import { db } from "../db.js";
import type { DefKind } from "./schema.js";

// Asks from Scan Lab that need a code change (data outside the catalog, logic the language cannot
// express). Stored for the maintainer to review; nothing acts on them automatically.

db.exec(`
CREATE TABLE IF NOT EXISTS scan_code_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('option','stock')),
  draft_id INTEGER,
  request TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','declined')),
  created_at TEXT NOT NULL
);
`);

export type CodeRequestStatus = "open" | "done" | "declined";
export type CodeRequest = { id: number; kind: DefKind; draftId: number | null; request: string; reason: string; status: CodeRequestStatus; createdAt: string };
type Row = { id: number; kind: DefKind; draft_id: number | null; request: string; reason: string; status: CodeRequestStatus; created_at: string };
const toRequest = (r: Row): CodeRequest => ({ id: r.id, kind: r.kind, draftId: r.draft_id, request: r.request, reason: r.reason, status: r.status, createdAt: r.created_at });

export function addCodeRequest(r: { kind: DefKind; draftId: number | null; request: string; reason: string }): CodeRequest {
  const id = db
    .prepare("INSERT INTO scan_code_requests (kind, draft_id, request, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(r.kind, r.draftId, r.request, r.reason, new Date().toISOString()).lastInsertRowid;
  return toRequest(db.prepare("SELECT * FROM scan_code_requests WHERE id = ?").get(id) as Row);
}

export function listCodeRequests(filter: { kind?: DefKind; status?: CodeRequestStatus } = {}): CodeRequest[] {
  const rows = db
    .prepare("SELECT * FROM scan_code_requests WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR status = ?) ORDER BY id DESC")
    .all(filter.kind ?? null, filter.kind ?? null, filter.status ?? null, filter.status ?? null) as Row[];
  return rows.map(toRequest);
}
