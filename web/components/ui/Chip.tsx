// Small rounded chip button (filters, "Tile panes", removable indicator chips).
// Props: all <button> props, plus on?: boolean (amber active state) and onRemove?: () => void
// (adds a trailing x button and makes the chip a non-button span-like group).
"use client";

import type { ButtonHTMLAttributes } from "react";

export default function Chip({
  on, onRemove, className = "", children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean; onRemove?: () => void }) {
  if (onRemove) {
    return (
      <span className={`chip inline-flex items-center gap-1.5 !py-0.5 !pr-1 ${on ? "on" : ""} ${className}`}>
        {children}
        <button
          aria-label="Remove"
          onClick={onRemove}
          className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[#8a8a8a] hover:bg-[#2a2a2d] hover:text-[#ff8a6b]"
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M2 2l6 6M8 2 2 8" />
          </svg>
        </button>
      </span>
    );
  }
  return (
    <button {...rest} aria-pressed={on === undefined ? undefined : on} className={`chip ${on ? "on" : ""} ${className}`}>
      {children}
    </button>
  );
}
