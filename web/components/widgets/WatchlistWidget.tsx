"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { apiPost, EXTENDED_SESSIONS, fmt, fmtBig, fmtPct, pctClass } from "../../lib/api";
import { normalizeSymbol } from "../../lib/symbol";
import { fetchQuotes, normalizeListName, WATCHLISTS_CHANGED } from "../../lib/watchlist";
import { useTerminal } from "../../store/terminal";
import Flash from "../Flash";
import { SessionCell } from "../SessionPrices";

export default function WatchlistWidget() {
  const watchlist = useTerminal((s) => s.watchlist);
  const lists = useTerminal((s) => s.watchlists);
  const active = useTerminal((s) => s.activeWatchlist);
  const setActiveWatchlist = useTerminal((s) => s.setActiveWatchlist);
  const createWatchlist = useTerminal((s) => s.createWatchlist);
  const deleteWatchlist = useTerminal((s) => s.deleteWatchlist);
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const addToWatchlist = useTerminal((s) => s.addToWatchlist);
  const removeFromWatchlist = useTerminal((s) => s.removeFromWatchlist);
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);

  const { data = [] } = useQuery({
    queryKey: ["watchlist", watchlist.join(",")],
    queryFn: () => fetchQuotes(watchlist),
    enabled: watchlist.length > 0,
    refetchInterval: 1_000,
  });

  const newList = () => {
    const raw = window.prompt("Name for the new watchlist");
    if (raw === null) return;
    const name = normalizeListName(raw);
    if (!name) {
      setNotice("Names can use letters, digits, spaces, - and _ (up to 40).");
      return;
    }
    createWatchlist(name);
    setNotice(null);
  };

  const removeList = () => {
    if (window.confirm(`Delete the watchlist "${active}"?`)) deleteWatchlist(active);
  };

  // Webull: Watchlists → ⋯ → Export saves a CSV with every list.
  const importCsv = async (file: File) => {
    setNotice("Importing…");
    try {
      const result = await apiPost<{ saved: Array<{ name: string }>; skipped: string[] }>("/api/watchlists/import", {
        csv: await file.text(),
      });
      window.dispatchEvent(new Event(WATCHLISTS_CHANGED));
      setNotice(
        `Imported ${result.saved.length} watchlists` +
          (result.skipped.length ? `; skipped ${result.skipped.join(", ")}` : "") +
          "."
      );
    } catch (err) {
      setNotice(`Import failed: ${(err as Error).message}`);
    }
  };

  return (
    <div>
      <div className="flex gap-1 p-1">
        <select
          value={active}
          onChange={(e) => setActiveWatchlist(e.target.value)}
          className="flex-1 min-w-0"
          title="Watchlist"
        >
          {lists.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name} ({l.symbols.length})
            </option>
          ))}
        </select>
        <button className="term-btn" onClick={newList} title="New watchlist">New</button>
        <button className="term-btn" onClick={removeList} title="Delete this watchlist">Del</button>
        <button className="term-btn" onClick={() => fileInput.current?.click()} title="Import a Webull watchlist export (.csv)">
          Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importCsv(file);
          }}
        />
      </div>
      {notice && <div className="dim px-1 text-xs">{notice}</div>}
      <form
        className="flex gap-1 p-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          const sym = normalizeSymbol(input);
          if (!sym) {
            setInvalid(true);
            return;
          }
          addToWatchlist(sym);
          setInput("");
        }}
      >
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setInvalid(false);
          }}
          placeholder="Add ticker…"
          title={invalid ? "Not a valid ticker symbol" : undefined}
          aria-invalid={invalid}
          className={`flex-1 ${invalid ? "!border-[var(--down)]" : ""}`}
        />
        <button className="term-btn" type="submit">+</button>
      </form>
      <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Sym</th><th>Last</th><th>Chg</th><th>Chg%</th>
            {EXTENDED_SESSIONS.map((s) => <th key={s.key} title={`${s.label}: price and change from the last regular close`}>{s.short}</th>)}
            <th>Vol</th><th></th>
          </tr>
        </thead>
        <tbody>
          {watchlist.map((sym) => {
            const q = data.find((d) => d.symbol === sym);
            return (
              <tr key={sym} onClick={() => setActiveSymbol(sym)}>
                <td className="font-bold">{sym}</td>
                <td><Flash value={q?.price}>{fmt(q?.price)}</Flash></td>
                <td className={pctClass(q?.change)}>
                  <Flash value={q?.change}>{q?.change != null && q.change > 0 ? "+" : ""}{fmt(q?.change)}</Flash>
                </td>
                <td className={pctClass(q?.changePercent)}>
                  <Flash value={q?.changePercent}>{fmtPct(q?.changePercent)}</Flash>
                </td>
                {EXTENDED_SESSIONS.map((s) => <SessionCell key={s.key} quote={q} session={s.key} label={s.label} />)}
                <td>{fmtBig(q?.volume)}</td>
                <td>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromWatchlist(sym);
                    }}
                    className="dim hover:text-[var(--down)]"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
