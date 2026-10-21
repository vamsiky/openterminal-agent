import { db } from "../db.js";
import { isUsListed, listedSymbols } from "./listings.js";
import { parseOcc } from "../providers/alpaca-options.js";
import type { OptionPosition, Position, StockPosition } from "../scan/contracts.js";

// The user's holdings, from a broker CSV export. An import replaces the whole
// snapshot (one transaction) and is rejected as a whole when any row is
// invalid, so a half-parsed file never replaces good data. Format: see
// docs/positions-csv.md.

db.exec(`
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('stock','option')),
  symbol TEXT NOT NULL,        -- the ticker, or the OCC symbol of an option
  underlying TEXT NOT NULL,
  expiry TEXT,
  strike REAL,
  right TEXT CHECK (right IN ('call','put')),
  quantity REAL NOT NULL,      -- negative = short
  cost REAL,                   -- per share (options: premium per share)
  opened_at TEXT
);
CREATE TABLE IF NOT EXISTS positions_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at TEXT NOT NULL,
  rows INTEGER NOT NULL,
  filename TEXT
);
`);

export type ImportError = { line: number; message: string };
export type ParseResult = { positions: Position[]; errors: ImportError[] };

/** Splits one CSV line, honouring double-quoted fields. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

// Header names, lower-cased with punctuation as spaces, mapped to our column.
const ALIASES: Record<string, string> = {
  symbol: "symbol", ticker: "symbol", instrument: "symbol", "option symbol": "symbol", contract: "symbol",
  quantity: "quantity", qty: "quantity", shares: "quantity", contracts: "quantity", position: "quantity",
  cost: "cost", "avg cost": "cost", "average cost": "cost", "avg price": "cost", "average price": "cost", "cost per share": "cost",
  "opened at": "opened_at", opened: "opened_at", "open date": "opened_at", "date opened": "opened_at", "date acquired": "opened_at", acquired: "opened_at",
  type: "type", "asset type": "type", "security type": "type", "asset class": "type",
  expiry: "expiry", expiration: "expiry", "expiration date": "expiry", exp: "expiry",
  strike: "strike", "strike price": "strike",
  right: "right", "put call": "right", "call put": "right", "option type": "right",
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/^\uFEFF/, "").replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();

/** 2026-11-20 or 11/20/2026 (or 11/20/26) -> 2026-11-20; null when it isn't a real date. */
function isoDate(raw: string): string | null {
  const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/) ?? raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const iso = raw.includes("/") ? [m[3].length === 2 ? `20${m[3]}` : m[3], m[1], m[2]] : [m[1], m[2], m[3]];
  const [y, mo, d] = iso.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** "1,234", "-5", "(5)", "$12.50" -> number; null when it isn't one. */
function number(raw: string): number | null {
  let s = raw.replace(/[$,\s]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

export function occSymbol(underlying: string, expiry: string, right: "call" | "put", strike: number): string {
  const strikeCode = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${underlying}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${right === "call" ? "C" : "P"}${strikeCode}`;
}

const TICKER = /^[A-Z][A-Z0-9]{0,5}(\.[A-Z])?$/;

function rightOf(raw: string): "call" | "put" | null {
  const r = raw.trim().toLowerCase();
  return r === "call" || r === "c" ? "call" : r === "put" || r === "p" ? "put" : null;
}

/** Parses a positions CSV. Every problem is reported with its line number; positions are only meaningful when `errors` is empty. */
export function parsePositionsCsv(csv: string): ParseResult {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
  const errors: ImportError[] = [];
  const headerAt = lines.findIndex((l) => l.trim() !== "");
  if (headerAt < 0) return { positions: [], errors: [{ line: 1, message: "the file is empty" }] };
  const col = new Map<string, number>();
  fields(lines[headerAt]).forEach((h, i) => {
    const name = ALIASES[normalizeHeader(h)];
    if (name && !col.has(name)) col.set(name, i);
  });
  if (!col.has("symbol") || !col.has("quantity")) {
    return { positions: [], errors: [{ line: headerAt + 1, message: "the header row needs symbol and quantity columns" }] };
  }

  const listed = listedSymbols();
  const headerCells = fields(lines[headerAt]).length;
  const merged = new Map<string, Position>();
  for (let i = headerAt + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const line = i + 1;
    const f = fields(lines[i]);
    const get = (name: string) => (col.has(name) ? f[col.get(name)!] ?? "" : "");
    const fail = (message: string) => errors.push({ line, message });

    // A cell too many ("1,000" unquoted) would silently shift or drop data; trailing empty cells are fine.
    if (f.length > headerCells && f.slice(headerCells).some((c) => c !== "")) {
      fail(`the row has ${f.length} cells but the header has ${headerCells}; quote values that contain commas, like "1,000"`);
      continue;
    }
    const rawSymbol = get("symbol").toUpperCase().replace(/^O:/, "").replace(/\s+/g, "");
    if (!rawSymbol) {
      fail("symbol is empty");
      continue;
    }
    const quantity = number(get("quantity"));
    if (quantity === null || quantity === 0 || !Number.isInteger(quantity)) {
      fail(`quantity "${get("quantity")}" is not a non-zero whole number`);
      continue;
    }
    let cost: number | null = null;
    if (get("cost") !== "") {
      cost = number(get("cost"));
      if (cost === null || cost < 0) {
        fail(`cost "${get("cost")}" is not a number`);
        continue;
      }
    }
    let openedAt: string | null = null;
    if (get("opened_at") !== "") {
      openedAt = isoDate(get("opened_at"));
      if (!openedAt) {
        fail(`opened_at "${get("opened_at")}" is not a date (use YYYY-MM-DD)`);
        continue;
      }
    }

    const type = get("type").toLowerCase();
    const occ = parseOcc(rawSymbol);
    const hasLegs = get("expiry") !== "" || get("strike") !== "" || get("right") !== "";
    const isOption = occ !== null || hasLegs || type === "option" || type === "call" || type === "put";

    let position: Position;
    if (isOption) {
      let underlying: string;
      let expiry: string | null;
      let strike: number | null;
      let right: "call" | "put" | null;
      if (occ) {
        const e = isoDate(get("expiry"));
        const k = number(get("strike"));
        const r = rightOf(get("right"));
        if ((get("expiry") !== "" && e !== occ.expiry) || (get("strike") !== "" && k !== occ.strike) || (get("right") !== "" && r !== occ.type)) {
          fail(`the OCC symbol ${rawSymbol} conflicts with the expiry, strike or right columns`);
          continue;
        }
        ({ root: underlying, expiry, strike } = occ);
        right = occ.type;
      } else {
        underlying = rawSymbol;
        expiry = isoDate(get("expiry"));
        strike = number(get("strike"));
        right = rightOf(get("right")) ?? rightOf(type);
        if (!expiry || strike === null || strike <= 0 || !right) {
          fail("an option row needs an OCC symbol, or the underlying with a valid expiry, strike and right (call/put)");
          continue;
        }
      }
      if (!TICKER.test(underlying) || !isUsListed(underlying, listed)) {
        fail(`${underlying} is not a US-listed underlying`);
        continue;
      }
      position = { kind: "option", occ: occSymbol(underlying, expiry, right, strike), underlying, expiry, strike, right, quantity, cost, openedAt };
    } else {
      if (!TICKER.test(rawSymbol) || !isUsListed(rawSymbol, listed)) {
        fail(`${rawSymbol} is not a US-listed ticker`);
        continue;
      }
      position = { kind: "stock", symbol: rawSymbol, quantity, cost, openedAt };
    }

    // Brokers list lots separately; one position per instrument.
    const key = position.kind === "option" ? position.occ : position.symbol;
    const prev = merged.get(key);
    if (!prev) merged.set(key, position);
    else if (prev.quantity * position.quantity < 0) {
      fail(`long and short lots of ${key} in one file; net them before importing`);
    } else {
      const q = prev.quantity + position.quantity;
      const weights = Math.abs(prev.quantity) + Math.abs(position.quantity);
      prev.cost =
        prev.cost !== null && position.cost !== null
          ? (prev.cost * Math.abs(prev.quantity) + position.cost * Math.abs(position.quantity)) / weights
          : prev.cost ?? position.cost;
      prev.openedAt = prev.openedAt && position.openedAt ? (prev.openedAt < position.openedAt ? prev.openedAt : position.openedAt) : prev.openedAt ?? position.openedAt;
      prev.quantity = q;
    }
  }
  return { positions: [...merged.values()].filter((p) => p.quantity !== 0), errors };
}

const replaceAll = db.transaction((positions: Position[], filename: string | null) => {
  db.prepare("DELETE FROM positions").run();
  const insert = db.prepare(
    "INSERT INTO positions (kind, symbol, underlying, expiry, strike, right, quantity, cost, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const p of positions) {
    if (p.kind === "stock") insert.run("stock", p.symbol, p.symbol, null, null, null, p.quantity, p.cost, p.openedAt);
    else insert.run("option", p.occ, p.underlying, p.expiry, p.strike, p.right, p.quantity, p.cost, p.openedAt);
  }
  db.prepare("INSERT INTO positions_imports (imported_at, rows, filename) VALUES (?, ?, ?)").run(new Date().toISOString(), positions.length, filename);
});

/** Replaces the snapshot with the CSV's positions, or returns the line errors and changes nothing. */
export function importPositions(csv: string, filename?: string): { imported: number } | { errors: ImportError[] } {
  const parsed = parsePositionsCsv(csv);
  if (parsed.errors.length > 0) return { errors: parsed.errors };
  replaceAll(parsed.positions, filename ?? null);
  return { imported: parsed.positions.length };
}

type Row = {
  kind: "stock" | "option";
  symbol: string;
  underlying: string;
  expiry: string | null;
  strike: number | null;
  right: "call" | "put" | null;
  quantity: number;
  cost: number | null;
  opened_at: string | null;
};

export function listPositions(): { importedAt: string | null; positions: Position[] } {
  const rows = db.prepare("SELECT * FROM positions ORDER BY kind DESC, underlying, expiry, strike, right").all() as Row[];
  const imp = db.prepare("SELECT imported_at FROM positions_imports ORDER BY id DESC LIMIT 1").get() as { imported_at: string } | undefined;
  const positions = rows.map((r): Position =>
    r.kind === "stock"
      ? { kind: "stock", symbol: r.symbol, quantity: r.quantity, cost: r.cost, openedAt: r.opened_at }
      : { kind: "option", occ: r.symbol, underlying: r.underlying, expiry: r.expiry!, strike: r.strike!, right: r.right!, quantity: r.quantity, cost: r.cost, openedAt: r.opened_at }
  );
  return { importedAt: imp?.imported_at ?? null, positions };
}

export function stockHoldings(): StockPosition[] {
  return listPositions().positions.filter((p): p is StockPosition => p.kind === "stock");
}

export function optionHoldings(): OptionPosition[] {
  return listPositions().positions.filter((p): p is OptionPosition => p.kind === "option");
}

/** Stock symbols plus the underlyings of held options, sorted. */
export function heldSymbols(): string[] {
  const rows = db.prepare("SELECT DISTINCT underlying FROM positions ORDER BY underlying").all() as Array<{ underlying: string }>;
  return rows.map((r) => r.underlying);
}

/** Shares held of `symbol` (0 when none, or short). */
export function sharesHeld(symbol: string): number {
  const row = db.prepare("SELECT quantity FROM positions WHERE kind = 'stock' AND symbol = ?").get(symbol) as { quantity: number } | undefined;
  return Math.max(0, row?.quantity ?? 0);
}
