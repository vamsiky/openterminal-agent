// Helpers for widgets popped out into their own browser window. The window
// route writes a heartbeat so the main window can dock widgets whose window
// vanished (browser quit, crash) without a pagehide event.

const BEAT_PREFIX = "ot-window-";
export const HEARTBEAT_MS = 2000;
export const STALE_MS = 7000;

export function windowUrl(widgetId: string): string {
  return `/window?w=${encodeURIComponent(widgetId)}`;
}

/** Opens (or focuses) the widget's window. Returns false when the browser blocked it. */
export function openWidgetWindow(widgetId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const win = window.open(windowUrl(widgetId), `ot-${widgetId}`, "popup=yes,width=980,height=680");
    if (!win) return false;
    win.focus?.();
    beat(widgetId);
    return true;
  } catch {
    return false;
  }
}

export function beat(widgetId: string, now = Date.now()): void {
  try {
    localStorage.setItem(BEAT_PREFIX + widgetId, String(now));
  } catch {
    /* storage unavailable */
  }
}

export function clearBeat(widgetId: string): void {
  try {
    localStorage.removeItem(BEAT_PREFIX + widgetId);
  } catch {
    /* storage unavailable */
  }
}

/** Ids whose heartbeat is missing or older than `maxAge`. */
export function staleWindowIds(ids: string[], now = Date.now(), maxAge = STALE_MS): string[] {
  return ids.filter((id) => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(BEAT_PREFIX + id);
    } catch {
      /* treat as stale */
    }
    const t = raw ? Number(raw) : NaN;
    return !Number.isFinite(t) || now - t > maxAge;
  });
}
