import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";

export const watchlistsRouter = Router();

// The watchlist used to live only in the browser's localStorage, where the
// server (and every agent running on it) couldn't see it. It's stored here
// now; the browser keeps its copy as a cache and syncs it on change.

const nameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const symbolsSchema = z.object({
  symbols: z
    // Same characters as the web's normalizeSymbol (web/lib/symbol.ts).
    .array(z.string().regex(/^(?=.*[A-Za-z0-9])[A-Za-z0-9.\-^=&]{1,20}$/).transform((s) => s.toUpperCase()))
    .max(500),
});

export function getWatchlist(name: string): string[] | null {
  const list = db.prepare("SELECT id FROM watchlists WHERE name = ?").get(name) as { id: number } | undefined;
  if (!list) return null;
  const rows = db
    .prepare("SELECT symbol FROM watchlist_items WHERE watchlist_id = ? ORDER BY position")
    .all(list.id) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

/** Every symbol on any watchlist, deduplicated. */
export function allWatchlistSymbols(): string[] {
  const rows = db.prepare("SELECT DISTINCT symbol FROM watchlist_items ORDER BY symbol").all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

const replaceList = db.transaction((name: string, symbols: string[]) => {
  db.prepare(
    "INSERT INTO watchlists (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now')"
  ).run(name);
  const { id } = db.prepare("SELECT id FROM watchlists WHERE name = ?").get(name) as { id: number };
  db.prepare("DELETE FROM watchlist_items WHERE watchlist_id = ?").run(id);
  const insert = db.prepare("INSERT OR IGNORE INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)");
  symbols.forEach((s, i) => insert.run(id, s, i));
});

export function setWatchlist(name: string, symbols: string[]): void {
  replaceList(name, symbols);
}

/** null = the list has never been saved, so the browser should seed it. */
watchlistsRouter.get("/:name", (req, res) => {
  const name = nameSchema.safeParse(req.params.name);
  if (!name.success) return res.status(400).json({ error: "invalid watchlist name" });
  res.json({ name: name.data, symbols: getWatchlist(name.data) });
});

// POST rather than PUT: the web proxy only forwards GET, POST and DELETE.
watchlistsRouter.post("/:name", (req, res) => {
  const name = nameSchema.safeParse(req.params.name);
  if (!name.success) return res.status(400).json({ error: "invalid watchlist name" });
  const body = symbolsSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });
  setWatchlist(name.data, body.data.symbols);
  res.json({ name: name.data, symbols: getWatchlist(name.data) });
});
