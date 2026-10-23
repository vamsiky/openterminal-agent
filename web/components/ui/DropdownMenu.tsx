// Small dropdown: a trigger button and an absolutely positioned panel that closes on outside
// click, Escape, or when `close` is called.
// Props: trigger (ReactNode shown inside the button), ariaLabel, title?, triggerClassName? (default "chip"),
// align?: "left" | "right" (default "left"), panelClassName?, children: ReactNode | ((close) => ReactNode).
// Use className "menu-item" on buttons inside the panel for the standard row look.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export default function DropdownMenu({
  trigger, ariaLabel, title, triggerClassName = "chip", align = "left", panelClassName = "", children,
}: {
  trigger: ReactNode;
  ariaLabel: string;
  title?: string;
  triggerClassName?: string;
  align?: "left" | "right";
  panelClassName?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        aria-label={ariaLabel}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        className={triggerClassName}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div role="menu" className={`menu-panel top-full mt-1 ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
