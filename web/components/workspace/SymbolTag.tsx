"use client";

import { useEffect, useRef, useState } from "react";
import { normalizeSymbol } from "../../lib/symbol";
import { useTerminal, type WidgetInstance } from "../../store/terminal";

/** Symbol chip on a symbol-aware tab; click to give the widget its own ticker. */
export default function SymbolTag({ widget }: { widget: WidgetInstance }) {
  const activeSymbol = useTerminal((s) => s.activeSymbol);
  const setWidgetSymbol = useTerminal((s) => s.setWidgetSymbol);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = widget.linked ? activeSymbol : widget.symbol ?? activeSymbol;

  useEffect(() => {
    if (!editing) return;
    setDraft(shown);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Widget ticker"
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = normalizeSymbol(draft);
            if (v) setWidgetSymbol(widget.id, v);
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={() => setEditing(false)}
        className="mr-1.5 w-16 !border-0 !border-b !border-[var(--amber-dim)] bg-transparent text-[var(--text)] px-0 py-0 text-[11px] leading-none"
      />
    );
  }

  return (
    <button className="psym" title="Click to set this widget's ticker" onClick={() => setEditing(true)}>
      {shown}
    </button>
  );
}
