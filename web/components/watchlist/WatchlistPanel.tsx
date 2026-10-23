"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmt, fmtPct, pctClass, type Quote } from "../../lib/api";
import { isForeignSymbol, normalizeSymbol, US_ONLY_MESSAGE } from "../../lib/symbol";
import { fetchQuotes } from "../../lib/watchlist";
import { latestSession, SORTS, sortSymbols, type SortId } from "../../lib/watchlistSort";
import { useTerminal } from "../../store/terminal";
import Flash from "../Flash";
import PillTabs from "../ui/PillTabs";

type Tab = "watch" | "recent";

// Rendered inside a container that owns width, the splitter and the collapse button (top-right of the
// 38px header, so the header keeps ~36px free on the right).
export default function WatchlistPanel() {
  const [tab, setTab] = useState<Tab>("watch");
  const [sort, setSort] = useState<SortId>("default");
  const [input, setInput] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const lists = useTerminal((s) => s.watchlists);
  const activeList = useTerminal((s) => s.activeWatchlist);
  const watchlist = useTerminal((s) => s.watchlist);
  const recent = useTerminal((s) => s.recent);
  const activeSymbol = useTerminal((s) => s.activeSymbol);
  const setActiveWatchlist = useTerminal((s) => s.setActiveWatchlist);
  const addToWatchlist = useTerminal((s) => s.addToWatchlist);
  const removeFromWatchlist = useTerminal((s) => s.removeFromWatchlist);
  const openSymbol = useTerminal((s) => s.openSymbol);
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);

  // Nothing opened yet: start on the first symbol of the active list.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (recent.length === 0 && watchlist.length > 0 && !watchlist.includes(activeSymbol)) setActiveSymbol(watchlist[0]);
    // Only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = tab === "watch" ? watchlist : recent;
  // Same key as the grid widget, so both share one request.
  const { data: quotes = [] } = useQuery({
    queryKey: [tab === "watch" ? "watchlist" : "watchlist-recent", shown.join(",")],
    queryFn: () => fetchQuotes(shown),
    enabled: shown.length > 0,
    refetchInterval: 1_000,
  });
  const bySymbol = useMemo(() => new Map(quotes.map((q) => [q.symbol, q])), [quotes]);
  const rows = tab === "watch" ? sortSymbols(shown, bySymbol, sort) : shown;

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const sym = normalizeSymbol(input);
    if (!sym) return setProblem("Not a valid ticker symbol");
    if (isForeignSymbol(sym)) return setProblem(US_ONLY_MESSAGE);
    addToWatchlist(sym);
    setInput("");
    setProblem(null);
  };

  return (
    <aside aria-label="Watchlist" className="flex h-full min-h-0 flex-col bg-[var(--panel)]">
      <div className="flex h-[38px] shrink-0 items-center border-b border-[#222] bg-[#0f0f10] pl-1 pr-9">
        <PillTabs
          ariaLabel="Watchlist view"
          tabs={[{ id: "watch", label: "Watchlists" }, { id: "recent", label: "Recent" }]}
          value={tab}
          onChange={(t) => setTab(t as Tab)}
        />
      </div>
      {tab === "watch" && (
        <div className="flex shrink-0 gap-1.5 px-2.5 pt-2 pb-1.5">
          <label className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="dim text-[10px]">LIST</span>
            <select aria-label="Watchlist" value={activeList} onChange={(e) => setActiveWatchlist(e.target.value)} className="w-full !py-[5px]">
              {lists.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.symbols.length})</option>)}
            </select>
          </label>
          <label className="flex w-[104px] shrink-0 flex-col gap-[3px]">
            <span className="dim text-[10px]">SORT</span>
            <select aria-label="Sort watchlist" value={sort} onChange={(e) => setSort(e.target.value as SortId)} className="w-full !py-[5px] !px-1.5">
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="dim flex shrink-0 justify-between border-b border-[#262626] px-2.5 py-1 text-[10px]">
        <span>NAME</span>
        <span>PRICE · CHG / EXT</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <div className="dim p-3 text-xs">
            {tab === "watch" ? `No symbols in ${activeList} yet. Add one below.` : "Symbols you open show up here."}
          </div>
        )}
        {rows.map((sym) => (
          <Row
            key={sym}
            sym={sym}
            quote={bySymbol.get(sym)}
            selected={sym === activeSymbol}
            onPick={() => openSymbol(sym)}
            onRemove={tab === "watch" ? () => removeFromWatchlist(sym) : undefined}
          />
        ))}
      </div>
      <form onSubmit={add} className="shrink-0 border-t border-[#262626] px-2.5 py-1.5">
        <label className="flex items-center gap-1.5">
          <span className="amber text-sm" aria-hidden="true">+</span>
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setProblem(null);
            }}
            placeholder="Add symbol"
            aria-label="Add symbol to watchlist"
            aria-invalid={problem !== null}
            className={`flex-1 min-w-0 !px-1.5 !py-1 ${problem ? "!border-[var(--down)]" : "!border-[#262626]"}`}
          />
        </label>
        {problem && <div className="down mt-1 text-[10px]">{problem}</div>}
      </form>
    </aside>
  );
}

function Row({ sym, quote, selected, onPick, onRemove }: {
  sym: string;
  quote: Quote | undefined;
  selected: boolean;
  onPick: () => void;
  onRemove?: () => void;
}) {
  const ext = latestSession(quote?.extended);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      className={`wrow group ${selected ? "sel" : ""}`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[#e6e6e6]">{quote?.name ?? sym}</span>
        <span className="dim text-[10px]">{sym}{quote?.exchange ? ` · ${quote.exchange}` : ""}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 pl-2">
        <span className={pctClass(quote?.changePercent)}>
          <Flash value={quote?.price}>{fmt(quote?.price)}</Flash>{" "}
          <span className="text-[10px]">{quote?.changePercent == null ? "" : fmtPct(quote.changePercent)}</span>
        </span>
        <span className="text-[10px]">
          {ext ? (
            <>
              <span className="dim">{ext.label}</span> <span className={pctClass(ext.changePercent)}>{fmtPct(ext.changePercent)}</span>
            </>
          ) : (
            <span className="dim">—</span>
          )}
        </span>
      </span>
      {onRemove && (
        <button
          aria-label={`Remove ${sym}`}
          title={`Remove ${sym}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="dim ml-1 hidden shrink-0 px-1 hover:text-[var(--down)] group-hover:block group-focus-within:block"
        >
          ✕
        </button>
      )}
    </div>
  );
}
