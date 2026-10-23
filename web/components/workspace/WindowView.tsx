"use client";

import { useEffect, useState } from "react";
import { clearBeat, beat, HEARTBEAT_MS } from "../../lib/windows";
import { useTerminal } from "../../store/terminal";
import SymbolTag from "./SymbolTag";
import WidgetHost from "./WidgetHost";
import { WIDGETS } from "./registry";

/** Body of /window?w=<widgetId>: one popped-out widget. Closing the window docks it back. */
export default function WindowView() {
  const [id, setId] = useState<string | null>(null);
  const widget = useTerminal((s) => s.windows.find((w) => w.id === id));
  const dockWindow = useTerminal((s) => s.dockWindow);
  const toggleLinked = useTerminal((s) => s.toggleLinked);

  useEffect(() => setId(new URLSearchParams(window.location.search).get("w")), []);

  const present = !!widget;
  useEffect(() => {
    if (!id || !present) return;
    beat(id);
    const t = setInterval(() => beat(id), HEARTBEAT_MS);
    const onHide = () => {
      // Skip when the main window already took the widget back (heartbeat prune, reset).
      if (useTerminal.getState().windows.some((w) => w.id === id)) dockWindow(id);
      else clearBeat(id);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", onHide);
    };
  }, [id, present, dockWindow]);

  // The widget was docked or closed from the main window: nothing left to show.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!id || present) return;
    const t = setTimeout(() => setGone(true), 600);
    return () => clearTimeout(t);
  }, [id, present]);
  useEffect(() => {
    if (gone) window.close();
  }, [gone]);

  if (!id) return null;
  if (!widget) {
    return (
      <div className="h-screen flex items-center justify-center text-center p-6 dim">
        This widget is no longer open in its own window. You can close this window.
      </div>
    );
  }

  const def = WIDGETS[widget.type];
  const dock = () => {
    dockWindow(widget.id);
    window.close();
  };

  return (
    <div className="flex flex-col h-screen bg-[var(--panel)]">
      <div className="pane-head">
        <div className="ptab on">
          <span className="pl">{def?.label ?? widget.type}</span>
          {def?.symbolAware && <SymbolTag widget={widget} />}
        </div>
        <div className="flex-1" />
        {def?.symbolAware && (
          <button
            className={`ico ${widget.linked ? "!text-[var(--amber)]" : ""}`}
            title={widget.linked ? "Linked to active symbol (click to unlink)" : "Unlinked (click to link)"}
            aria-label={widget.linked ? "Linked to active symbol (click to unlink)" : "Unlinked (click to link)"}
            onClick={() => toggleLinked(widget.id)}
          >
            ⛓
          </button>
        )}
        <button className="chip !mx-0.5 !text-[#6b8cff] !border-[#2b3a73]" onClick={dock}>
          Dock back
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto relative">
        <WidgetHost widget={widget} />
      </div>
    </div>
  );
}
