"use client";

import { useEffect, useRef, useState } from "react";
import { SNAP_PRESETS, HANDLES, type Handle, type Rect } from "../../lib/layout";
import { useTerminal, type Pane } from "../../store/terminal";
import DropdownMenu from "../ui/DropdownMenu";
import SymbolTag from "./SymbolTag";
import WidgetHost from "./WidgetHost";
import { WIDGETS } from "./registry";

export type BeginGesture = (e: React.PointerEvent<HTMLElement>, paneId: string, mode: "move" | Handle) => void;

const icon = (d: string, size = 13, box = 14) => (
  <svg width={size} height={size} viewBox={`0 0 ${box} ${box}`} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d={d} />
  </svg>
);

const MAX_ICON = "M1.5 5V1.5H5M9 1.5h3.5V5M1.5 9v3.5H5M12.5 9v3.5H9";
const RESTORE_ICON = "M5 1.5v3.5H1.5M9 1.5v3.5h3.5M5 12.5V9H1.5M9 12.5V9h3.5";

function miniStyle(r: Rect): React.CSSProperties {
  return { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` };
}

export default function PaneView({
  pane, rect, focused, begin,
}: {
  pane: Pane;
  rect: Rect;
  focused: boolean;
  begin: BeginGesture;
}) {
  const focusPane = useTerminal((s) => s.focusPane);
  const setActiveTab = useTerminal((s) => s.setActiveTab);
  const removeWidget = useTerminal((s) => s.removeWidget);
  const toggleLinked = useTerminal((s) => s.toggleLinked);
  const toggleMaximize = useTerminal((s) => s.toggleMaximize);
  const snapPane = useTerminal((s) => s.snapPane);
  const popOut = useTerminal((s) => s.popOut);

  const active = pane.tabs.find((t) => t.id === pane.activeTab) ?? pane.tabs[0];
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }));
  };
  const nudge = (dir: -1 | 1) => {
    const el = strip.current;
    if (el) el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.6), behavior: "smooth" });
  };

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);

  // Wheel / trackpad scroll the tab strip sideways (React's onWheel is passive, so attach natively).
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0 || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible.
  useEffect(() => {
    const el = strip.current;
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement;
    if (!el || !tab) return;
    if (tab.offsetLeft < el.scrollLeft) el.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth)
      el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth;
    measure();
  }, [active?.id, pane.tabs.length]);
  const activeDef = active ? WIDGETS[active.type] : undefined;
  const maximized = !!pane.restore;
  const title = active ? `${activeDef?.label ?? active.type} pane` : "Empty pane";

  return (
    <section
      aria-label={title}
      data-pane={pane.id}
      onPointerDownCapture={() => focusPane(pane.id)}
      className="absolute flex flex-col bg-[var(--panel)] min-h-0 min-w-0"
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
        zIndex: pane.z,
        border: `1px solid ${focused ? "#7a5418" : "var(--border)"}`,
      }}
    >
      <div className="pane-head">
        <div className="relative flex items-center min-w-0">
        {overflow.left && (
          <button className="tab-nav left-0" aria-label="Scroll tabs left" onClick={() => nudge(-1)}>‹</button>
        )}
        <div ref={strip} className="tab-strip flex items-center gap-1.5 min-w-0 overflow-x-auto py-0.5" role="tablist">
          {pane.tabs.map((t) => {
            const def = WIDGETS[t.type];
            return (
              <div key={t.id} className={`ptab ${t.id === active?.id ? "on" : ""}`}>
                <button role="tab" aria-selected={t.id === active?.id} className="pl" onClick={() => setActiveTab(pane.id, t.id)}>
                  {def?.label ?? t.type}
                </button>
                {def?.symbolAware && <SymbolTag widget={t} />}
                <button className="px" aria-label={`Close ${def?.label ?? t.type}`} onClick={() => removeWidget(t.id)}>
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M2 2l6 6M8 2 2 8" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
        {overflow.right && (
          <button className="tab-nav right-0 !justify-end" aria-label="Scroll tabs right" onClick={() => nudge(1)}>›</button>
        )}
        </div>
        <button
          className="grab"
          aria-label="Move pane (drag)"
          title="Drag to move · drop on a workspace edge or corner to snap · double-click to maximize"
          onPointerDown={(e) => begin(e, pane.id, "move")}
          onDoubleClick={() => toggleMaximize(pane.id)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="3" r="1.1" /><circle cx="9" cy="3" r="1.1" /><circle cx="3" cy="9" r="1.1" />
            <circle cx="9" cy="9" r="1.1" /><circle cx="6" cy="6" r="1.1" />
          </svg>
        </button>
        {active && activeDef?.symbolAware && (
          <button
            className={`ico ${active.linked ? "!text-[var(--amber)]" : ""}`}
            aria-label={active.linked ? "Linked to active symbol (click to unlink)" : "Unlinked (click to link)"}
            title={active.linked ? "Linked to active symbol (click to unlink)" : "Unlinked (click to link)"}
            onClick={() => toggleLinked(active.id)}
          >
            ⛓
          </button>
        )}
        <DropdownMenu
          ariaLabel="Snap pane to a position"
          title="Snap to…"
          triggerClassName="ico"
          align="right"
          panelClassName="snapmenu"
          trigger={icon("M2 2.5h12v11H2zM8 2.5v11M8 8h6", 14, 16)}
        >
          {(close) => (
            <>
              <div className="dim col-span-2 text-[11px] px-0.5 pb-1">Snap this pane to</div>
              {SNAP_PRESETS.map((sp) => (
                <button
                  key={sp.key}
                  role="menuitem"
                  className="menu-item !p-1.5"
                  onClick={() => { snapPane(pane.id, sp.key); close(); }}
                >
                  <span className="snapmini">
                    <span className="absolute rounded-[1px] bg-[var(--amber)]" style={miniStyle(sp.rect)} />
                  </span>
                  <span>{sp.label}</span>
                </button>
              ))}
            </>
          )}
        </DropdownMenu>
        <button
          className="ico"
          aria-label="Open this tab in its own window"
          title="Open in its own window"
          disabled={!active}
          onClick={() => active && popOut(active.id)}
        >
          {icon("M8 2h4v4M12 2 6.5 7.5M10 8.5V12H2V4h3.5")}
        </button>
        <button
          className="ico"
          aria-label={maximized ? "Restore pane" : "Maximize pane"}
          title={maximized ? "Restore pane" : "Maximize pane"}
          onClick={() => toggleMaximize(pane.id)}
        >
          {icon(maximized ? RESTORE_ICON : MAX_ICON)}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto relative">
        {active ? (
          <WidgetHost key={active.id} widget={active} />
        ) : (
          <div className="h-full flex items-center justify-center text-center p-4 dim">
            Empty pane. Pick a panel on the left to add it here.
          </div>
        )}
      </div>
      {!maximized && HANDLES.map((h) => (
        <div key={h} className={`rh rh-${h}`} aria-hidden="true" onPointerDown={(e) => begin(e, pane.id, h)} />
      ))}
    </section>
  );
}
