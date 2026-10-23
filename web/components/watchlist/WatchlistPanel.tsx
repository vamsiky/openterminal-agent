"use client";

// Placeholder: the watchlist squad replaces this file. Rendered inside a container that owns
// width, the splitter and the collapse button (top-right of the 38px header zone; leave ~36px free there).
export default function WatchlistPanel() {
  return (
    <aside aria-label="Watchlist" className="flex h-full flex-col bg-[var(--panel)]">
      <div className="h-[38px] flex items-center px-3 border-b border-[var(--border)] amber">Watchlists</div>
      <div className="p-3 dim">Watchlist panel placeholder.</div>
    </aside>
  );
}
