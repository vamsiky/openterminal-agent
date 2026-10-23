"use client";

import { useCallback, useRef, useState } from "react";
import {
  clampMove, magnetMove, magnetResize, resizeRect, snapZone, toFrac, toPx, type Rect,
} from "../lib/layout";
import { useTerminal } from "../store/terminal";
import PaneView, { type BeginGesture } from "./workspace/PaneView";

export default function Workspace() {
  const panes = useTerminal((s) => s.panes);
  const focusedPane = useTerminal((s) => s.focusedPane);
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<{ id: string; rect: Rect } | null>(null);
  const [preview, setPreview] = useState<Rect | null>(null);

  const begin = useCallback<BeginGesture>((e, paneId, mode) => {
    const host = ref.current;
    const target = e.currentTarget;
    if (e.button !== 0 || !host) return;
    const st = useTerminal.getState();
    const pane = st.panes.find((p) => p.id === paneId);
    if (!pane || pane.restore) return;
    e.preventDefault();
    st.focusPane(paneId);

    const box = host.getBoundingClientRect();
    const ws = { w: box.width, h: box.height };
    const start = toPx(pane.rect, ws);
    const others = st.panes.filter((p) => p.id !== paneId).map((p) => toPx(p.rect, ws));
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = pane.rect;
    let zone: Rect | null = null;
    let moved = false;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      let r: Rect;
      if (mode === "move") {
        r = clampMove(magnetMove(clampMove({ ...start, x: start.x + dx, y: start.y + dy }, ws), others, ws), ws);
        zone = snapZone({ x: ev.clientX - box.left, y: ev.clientY - box.top }, ws);
      } else {
        r = magnetResize(resizeRect(start, mode, dx, dy, ws), mode, others, ws);
      }
      last = toFrac(r, ws);
      setLive({ id: paneId, rect: last });
      setPreview(zone);
    };
    const finish = (commit: boolean) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
      try { target.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      setLive(null);
      setPreview(null);
      if (commit && moved) useTerminal.getState().setPaneRect(paneId, zone ?? last);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onCancel);
  }, []);

  return (
    <div ref={ref} className="ws absolute inset-0 overflow-hidden" data-workspace>
      {panes.map((p) => (
        <PaneView
          key={p.id}
          pane={p}
          rect={live?.id === p.id ? live.rect : p.rect}
          focused={p.id === focusedPane}
          begin={begin}
        />
      ))}
      {preview && (
        <div
          aria-hidden="true"
          className="absolute pointer-events-none rounded-md border-2 border-[var(--amber)] bg-[rgba(255,153,0,0.14)]"
          style={{
            left: `${preview.x * 100}%`, top: `${preview.y * 100}%`,
            width: `${preview.w * 100}%`, height: `${preview.h * 100}%`, zIndex: 100000,
          }}
        />
      )}
    </div>
  );
}
