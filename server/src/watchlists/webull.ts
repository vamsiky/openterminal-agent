// Webull's watchlist export: one row per symbol, in list order.
//   Watchlist,#,Symbol,Name,Exchange
//   AI,1,CRDO,CREDO TECHNOLOGY GROUP HOLDING,NASDAQ
// Crypto rows (exchange CCC) are saved in Yahoo's form (BTC-USD): the plain
// ticker would be quoted as a stock (BTC is a Bitcoin ETF), and Binance, which
// knows the plain form, refuses US connections. Webull's VIX is the index (^VIX).

export type ImportedList = { name: string; symbols: string[] };

/** Splits one CSV line, honouring double-quoted fields ("Ncino, Inc."). */
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

export function appSymbol(symbol: string, exchange: string): string {
  const s = symbol.toUpperCase();
  const ex = exchange.toUpperCase();
  if (ex === "CCC") return `${s}-USD`;
  if (ex === "CBOE" && s === "VIX") return "^VIX";
  return s;
}

/** Lists in the order they appear in the file; throws when the header isn't Webull's. */
export function parseWebullCsv(text: string): ImportedList[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const header = fields(lines[0] ?? "").map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [list, symbol, exchange] = [col("watchlist"), col("symbol"), col("exchange")];
  if (list < 0 || symbol < 0) throw new Error("expected a Webull export with Watchlist and Symbol columns");
  const lists = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const f = fields(line);
    const name = f[list]?.replace(/\s+/g, " ");
    const sym = f[symbol];
    if (!name || !sym) continue;
    const s = appSymbol(sym, exchange >= 0 ? f[exchange] ?? "" : "");
    const symbols = lists.get(name) ?? [];
    if (!symbols.includes(s)) symbols.push(s);
    lists.set(name, symbols);
  }
  return [...lists].map(([name, symbols]) => ({ name, symbols }));
}
