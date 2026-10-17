import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../db.js";
import type { SymbolRow } from "./store.js";

// Which symbols to keep history for.
//
// - All US-listed stocks and ETFs: Nasdaq Trader's public symbol directory
//   (nasdaqlisted.txt + otherlisted.txt), refreshed daily by Nasdaq and
//   covering Nasdaq, NYSE, NYSE American, NYSE Arca, Cboe and IEX listings.
// - S&P 500 members: the constituents table on Wikipedia, overridable with a
//   plain list in data/universe/sp500.txt (one symbol per line).
// - Nasdaq-100 members: Nasdaq's public index list, overridable with
//   data/universe/nasdaq100.txt.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Market and sector context for swing studies: was a move the stock, its
// sector, or the whole market? Always kept at minute resolution.
export const CONTEXT_ETFS = [
  "SPY", "QQQ", "IWM", "DIA",
  "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC", "SMH",
];

const OTHER_EXCHANGES: Record<string, string> = {
  A: "NYSE American",
  N: "NYSE",
  P: "NYSE Arca",
  Z: "Cboe BZX",
  V: "IEX",
};

/** Parse one of Nasdaq Trader's pipe-delimited symbol directory files. */
export function parseSymbolDirectory(text: string, kind: "nasdaq" | "other"): SymbolRow[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0]?.split("|") ?? [];
  const col = (name: string) => header.indexOf(name);
  const symCol = kind === "nasdaq" ? col("Symbol") : col("ACT Symbol");
  const nameCol = col("Security Name");
  const etfCol = col("ETF");
  const testCol = col("Test Issue");
  const exchCol = col("Exchange");
  if (symCol < 0 || nameCol < 0) throw new Error(`symbol directory: unexpected header "${lines[0]}"`);

  const rows: SymbolRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("File Creation Time")) continue;
    const f = line.split("|");
    const symbol = f[symCol]?.trim();
    // Skip test issues and symbols Alpaca can't price (preferreds use "$").
    if (!symbol || f[testCol] === "Y" || symbol.includes("$")) continue;
    rows.push({
      symbol,
      name: f[nameCol]?.trim() || null,
      exchange: kind === "nasdaq" ? "Nasdaq" : OTHER_EXCHANGES[f[exchCol]] ?? f[exchCol] ?? null,
      isEtf: f[etfCol] === "Y",
    });
  }
  return rows;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

export async function usListings(): Promise<SymbolRow[]> {
  const [nasdaq, other] = await Promise.all([
    fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"),
    fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"),
  ]);
  const bySymbol = new Map<string, SymbolRow>();
  for (const r of [...parseSymbolDirectory(nasdaq, "nasdaq"), ...parseSymbolDirectory(other, "other")]) bySymbol.set(r.symbol, r);
  return [...bySymbol.values()];
}

/**
 * Pull tickers from the first table of the Wikipedia S&P 500 page's wikitext.
 * The second table on that page lists past changes, so parsing stops there.
 */
export function parseSp500Wikitext(wikitext: string): string[] {
  const start = wikitext.indexOf("{|");
  if (start < 0) return [];
  const end = wikitext.indexOf("{|", start + 2);
  const table = wikitext.slice(start, end < 0 ? undefined : end);
  const symbols = new Set<string>();
  for (const m of table.matchAll(/\{\{\s*(?:NyseSymbol|NasdaqSymbol|Nyse|Nasdaq|Cboe|BZX)\s*\|\s*([A-Za-z.]{1,8})\s*\}\}/gi)) {
    symbols.add(m[1].toUpperCase());
  }
  return [...symbols];
}

export function parseNasdaq100(json: any): string[] {
  const rows: any[] = json?.data?.data?.rows ?? json?.data?.rows ?? [];
  return rows.map((r) => String(r?.symbol ?? "").trim().toUpperCase()).filter(Boolean);
}

function overrideFile(name: string): string[] | null {
  const path = join(dataDir, "universe", name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && !s.startsWith("#"));
}

export async function sp500(): Promise<string[]> {
  const override = overrideFile("sp500.txt");
  if (override) return override;
  const text = await fetchText("https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw");
  const symbols = parseSp500Wikitext(text);
  // The index has ~503 share classes; far fewer means the page format changed.
  if (symbols.length < 450) throw new Error(`sp500: parsed only ${symbols.length} symbols; add data/universe/sp500.txt`);
  return symbols;
}

export async function nasdaq100(): Promise<string[]> {
  const override = overrideFile("nasdaq100.txt");
  if (override) return override;
  const res = await fetch("https://api.nasdaq.com/api/quote/list-type/nasdaq100", {
    headers: { "User-Agent": UA, Accept: "application/json", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" },
  });
  if (!res.ok) throw new Error(`nasdaq100 ${res.status}`);
  const symbols = parseNasdaq100(await res.json());
  if (symbols.length < 90) throw new Error(`nasdaq100: parsed only ${symbols.length} symbols; add data/universe/nasdaq100.txt`);
  return symbols;
}

/**
 * Map a Yahoo-style ticker to Alpaca's stock symbol, or null when Alpaca has
 * no US stock bars for it: share classes use a dot (BRK-B → BRK.B), and
 * indices (^GSPC), FX (EURUSD=X), futures (GC=F), foreign listings (0700.HK)
 * and crypto pairs (BTC-USD) are not US stocks.
 */
export function alpacaSymbol(raw: string): string | null {
  const s = raw.toUpperCase().replace(/^([A-Z]+)-([A-Z])$/, "$1.$2");
  return /^[A-Z][A-Z0-9]{0,6}(\.[A-Z])?$/.test(s) ? s : null;
}
