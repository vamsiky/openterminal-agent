// Pure geometry for the free-form workspace. Pane rects are fractions of the
// workspace ({x, y, w, h} in 0..1); the gesture helpers work in workspace pixels.

export type Rect = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MIN_W = 240;
export const MIN_H = 140;
export const MAGNET = 10;
export const EDGE_ZONE = 24;
export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export const HANDLES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export const SNAP_PRESETS: Array<{ key: string; label: string; rect: Rect }> = [
  { key: "left", label: "Left half", rect: { x: 0, y: 0, w: 0.5, h: 1 } },
  { key: "right", label: "Right half", rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
  { key: "top", label: "Top half", rect: { x: 0, y: 0, w: 1, h: 0.5 } },
  { key: "bottom", label: "Bottom half", rect: { x: 0, y: 0.5, w: 1, h: 0.5 } },
  { key: "tl", label: "Top left", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
  { key: "tr", label: "Top right", rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
  { key: "bl", label: "Bottom left", rect: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
  { key: "br", label: "Bottom right", rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
  { key: "left23", label: "Left two-thirds", rect: { x: 0, y: 0, w: 2 / 3, h: 1 } },
  { key: "right13", label: "Right third", rect: { x: 2 / 3, y: 0, w: 1 / 3, h: 1 } },
  { key: "full", label: "Full workspace", rect: FULL },
];

export const toPx = (r: Rect, ws: Size): Rect => ({ x: r.x * ws.w, y: r.y * ws.h, w: r.w * ws.w, h: r.h * ws.h });

export const toFrac = (r: Rect, ws: Size): Rect => ({
  x: ws.w ? r.x / ws.w : 0,
  y: ws.h ? r.y / ws.h : 0,
  w: ws.w ? r.w / ws.w : 1,
  h: ws.h ? r.h / ws.h : 1,
});

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Keeps a pixel rect inside the workspace without resizing it. */
export function clampMove(r: Rect, ws: Size): Rect {
  return { ...r, x: clamp(r.x, 0, ws.w - r.w), y: clamp(r.y, 0, ws.h - r.h) };
}

/** Rect after dragging `handle` by (dx, dy) from `start`; honors the minimum size and the workspace. */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, ws: Size, min: Size = { w: MIN_W, h: MIN_H }): Rect {
  const minW = Math.min(min.w, ws.w);
  const minH = Math.min(min.h, ws.h);
  let l = start.x;
  let t = start.y;
  let r = start.x + start.w;
  let b = start.y + start.h;
  if (handle.includes("w")) l = clamp(start.x + dx, 0, r - minW);
  if (handle.includes("e")) r = clamp(r + dx, l + minW, ws.w);
  if (handle.includes("n")) t = clamp(start.y + dy, 0, b - minH);
  if (handle.includes("s")) b = clamp(b + dy, t + minH, ws.h);
  return { x: l, y: t, w: r - l, h: b - t };
}

/** Signed distance to the nearest line within the magnet range, or null. */
function nearest(value: number, lines: number[], range: number): number | null {
  let best: number | null = null;
  for (const line of lines) {
    const d = line - value;
    if (Math.abs(d) <= range && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}

function lines(others: Rect[], ws: Size) {
  return {
    xs: [0, ws.w, ...others.flatMap((o) => [o.x, o.x + o.w])],
    ys: [0, ws.h, ...others.flatMap((o) => [o.y, o.y + o.h])],
  };
}

const closer = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.abs(a) <= Math.abs(b) ? a : b;

/** Moves a whole rect so its edges meet other panes' edges or the workspace border. */
export function magnetMove(r: Rect, others: Rect[], ws: Size, range = MAGNET): Rect {
  const { xs, ys } = lines(others, ws);
  const dx = closer(nearest(r.x, xs, range), nearest(r.x + r.w, xs, range)) ?? 0;
  const dy = closer(nearest(r.y, ys, range), nearest(r.y + r.h, ys, range)) ?? 0;
  return { ...r, x: r.x + dx, y: r.y + dy };
}

/** Snaps only the edges `handle` is moving; the others stay put. */
export function magnetResize(
  r: Rect, handle: Handle, others: Rect[], ws: Size, min: Size = { w: MIN_W, h: MIN_H }, range = MAGNET
): Rect {
  const { xs, ys } = lines(others, ws);
  let l = r.x;
  let t = r.y;
  let rt = r.x + r.w;
  let b = r.y + r.h;
  if (handle.includes("w")) l += nearest(l, xs, range) ?? 0;
  if (handle.includes("e")) rt += nearest(rt, xs, range) ?? 0;
  if (handle.includes("n")) t += nearest(t, ys, range) ?? 0;
  if (handle.includes("s")) b += nearest(b, ys, range) ?? 0;
  const minW = Math.min(min.w, ws.w);
  const minH = Math.min(min.h, ws.h);
  if (rt - l < minW) { if (handle.includes("w")) l = rt - minW; else rt = l + minW; }
  if (b - t < minH) { if (handle.includes("n")) t = b - minH; else b = t + minH; }
  return { x: l, y: t, w: rt - l, h: b - t };
}

/** Snap target (fractions) when the pointer is at a workspace edge or corner, else null. */
export function snapZone(p: Point, ws: Size, edge = EDGE_ZONE): Rect | null {
  const left = p.x <= edge;
  const right = p.x >= ws.w - edge;
  const top = p.y <= edge;
  const bottom = p.y >= ws.h - edge;
  const x = left ? 0 : 0.5;
  const y = top ? 0 : 0.5;
  if ((left || right) && (top || bottom)) return { x, y, w: 0.5, h: 0.5 };
  if (left || right) return { x, y: 0, w: 0.5, h: 1 };
  if (top || bottom) return { x: 0, y, w: 1, h: 0.5 };
  return null;
}

/** Even grid for n panes; a short last row stretches to fill the width. */
export function tileRects(n: number): Rect[] {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - cols * (rows - 1) : cols;
    out.push({ x: c / inRow, y: row / rows, w: 1 / inRow, h: 1 / rows });
  }
  return out;
}

/** Splits a rect in two; the first half keeps the original position. */
export function splitRect(r: Rect, dir: "right" | "below"): [Rect, Rect] {
  return dir === "right"
    ? [{ ...r, w: r.w / 2 }, { ...r, x: r.x + r.w / 2, w: r.w / 2 }]
    : [{ ...r, h: r.h / 2 }, { ...r, y: r.y + r.h / 2, h: r.h / 2 }];
}

/** Rects of fractions kept inside the unit square with a positive size. */
export function sanitizeRect(r: Partial<Rect> | undefined, fallback: Rect = FULL): Rect {
  if (!r || ![r.x, r.y, r.w, r.h].every((v) => typeof v === "number" && Number.isFinite(v))) return fallback;
  const w = clamp(r.w!, 0.05, 1);
  const h = clamp(r.h!, 0.05, 1);
  return { x: clamp(r.x!, 0, 1 - w), y: clamp(r.y!, 0, 1 - h), w, h };
}
