"use client";

import { useRef, useState } from "react";
import { useTerminal, WATCHLIST_WIDTH } from "../store/terminal";
import WatchlistPanel from "./watchlist/WatchlistPanel";

/** Resizable, collapsible shell around the watchlist aside. */
export default function WatchlistContainer() {
  const open = useTerminal((s) => s.watchlistOpen);
  const width = useTerminal((s) => s.watchlistWidth);
  const setOpen = useTerminal((s) => s.setWatchlistOpen);
  const setWidth = useTerminal((s) => s.setWatchlistWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });

  if (!open) {
    return (
      <button
        aria-label="Open watchlist"
        onClick={() => setOpen(true)}
        className="flex-none w-7 bg-[var(--panel)] border-r border-[var(--border)] text-[var(--amber)] text-[11px] tracking-[0.1em] py-3"
        style={{ writingMode: "vertical-rl" }}
      >
        WATCHLIST ›
      </button>
    );
  }

  return (
    <>
      <div className="relative flex-none min-h-0 border-r border-[var(--border)]" style={{ width }}>
        <WatchlistPanel />
        <button
          className="ico absolute top-[5px] right-1 z-10"
          aria-label="Collapse watchlist"
          title="Collapse watchlist"
          onClick={() => setOpen(false)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M7.5 2.5 4 6l3.5 3.5" />
          </svg>
        </button>
      </div>
      <button
        className={`vsplit ${dragging ? "on" : ""}`}
        aria-label="Resize watchlist"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, w: width };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (dragging) setWidth(start.current.w + e.clientX - start.current.x);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => setWidth(WATCHLIST_WIDTH.initial)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setWidth(width - 16);
          if (e.key === "ArrowRight") setWidth(width + 16);
        }}
      />
    </>
  );
}
