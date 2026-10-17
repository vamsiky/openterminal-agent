// Same rule as the server's watchlist names (server/src/routes/watchlists.ts):
// letters, digits, spaces, "_" and "-", up to 40 characters, as Webull names
// lists ("Daily Watchlist", "Energy-AI").
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9_-])?$/;

/** Trims and collapses spaces; null when the server wouldn't accept the name. */
export function normalizeListName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return NAME_RE.test(name) && name !== "import" ? name : null;
}

export const listPath = (name: string) => `/api/watchlists/${encodeURIComponent(name)}`;

/** Fired after something other than the store changed the server's lists (an import). */
export const WATCHLISTS_CHANGED = "openterminal:watchlists-changed";
