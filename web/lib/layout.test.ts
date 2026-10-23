import { describe, expect, it } from "vitest";
import {
  clampMove, magnetMove, magnetResize, resizeRect, sanitizeRect, snapZone, splitRect, tileRects, toFrac, toPx,
} from "./layout";

const ws = { w: 1000, h: 600 };

describe("px/fraction conversion", () => {
  it("round-trips", () => {
    const f = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
    expect(toFrac(toPx(f, ws), ws)).toEqual(f);
  });
});

describe("clampMove", () => {
  it("keeps the rect inside the workspace", () => {
    expect(clampMove({ x: -40, y: 590, w: 300, h: 200 }, ws)).toEqual({ x: 0, y: 400, w: 300, h: 200 });
    expect(clampMove({ x: 900, y: 10, w: 300, h: 200 }, ws).x).toBe(700);
  });
});

describe("resizeRect", () => {
  const start = { x: 100, y: 100, w: 400, h: 300 };
  it("moves the east and south edges", () => {
    expect(resizeRect(start, "se", 50, 20, ws)).toEqual({ x: 100, y: 100, w: 450, h: 320 });
  });
  it("moves the west edge and keeps the right edge fixed", () => {
    expect(resizeRect(start, "w", -60, 0, ws)).toEqual({ x: 40, y: 100, w: 460, h: 300 });
  });
  it("never goes below 240 x 140", () => {
    const r = resizeRect(start, "nw", 999, 999, ws);
    expect(r.w).toBe(240);
    expect(r.h).toBe(140);
    expect(r.x + r.w).toBe(500);
    expect(r.y + r.h).toBe(400);
  });
  it("stops at the workspace border", () => {
    const r = resizeRect(start, "ne", 9999, -9999, ws);
    expect(r.x + r.w).toBe(1000);
    expect(r.y).toBe(0);
  });
});

describe("magnet", () => {
  const others = [{ x: 500, y: 0, w: 500, h: 300 }];
  it("snaps a moved pane's edge to another pane within 10 px", () => {
    const r = magnetMove({ x: 195, y: 100, w: 300, h: 200 }, others, ws);
    expect(r.x).toBe(200); // right edge 495 -> 500
    expect(r.y).toBe(100);
  });
  it("snaps to the workspace border", () => {
    expect(magnetMove({ x: 6, y: 3, w: 300, h: 200 }, [], ws)).toMatchObject({ x: 0, y: 0 });
  });
  it("leaves rects beyond 10 px alone", () => {
    expect(magnetMove({ x: 20, y: 100, w: 300, h: 200 }, [], ws)).toMatchObject({ x: 20, y: 100 });
  });
  it("resize snaps only the moving edge", () => {
    const r = magnetResize({ x: 100, y: 100, w: 395, h: 200 }, "e", others, ws);
    expect(r).toEqual({ x: 100, y: 100, w: 400, h: 200 });
  });
  it("resize keeps the minimum size after snapping", () => {
    const r = magnetResize({ x: 100, y: 100, w: 245, h: 200 }, "e", [{ x: 336, y: 0, w: 10, h: 10 }], ws);
    expect(r.w).toBeGreaterThanOrEqual(240);
  });
});

describe("snapZone", () => {
  it("corners give quarters, edges give halves, the middle gives nothing", () => {
    expect(snapZone({ x: 2, y: 2 }, ws)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(snapZone({ x: 998, y: 598 }, ws)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(snapZone({ x: 2, y: 300 }, ws)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(snapZone({ x: 999, y: 300 }, ws)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(snapZone({ x: 500, y: 1 }, ws)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(snapZone({ x: 500, y: 599 }, ws)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(snapZone({ x: 500, y: 300 }, ws)).toBeNull();
  });
});

describe("tileRects", () => {
  it("covers the workspace without overlap", () => {
    for (const n of [1, 2, 3, 4, 5, 7]) {
      const rs = tileRects(n);
      expect(rs).toHaveLength(n);
      const area = rs.reduce((a, r) => a + r.w * r.h, 0);
      expect(area).toBeCloseTo(1, 6);
    }
  });
  it("stretches a short last row", () => {
    const rs = tileRects(3);
    expect(rs[2]).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
  it("returns nothing for zero panes", () => {
    expect(tileRects(0)).toEqual([]);
  });
});

describe("splitRect / sanitizeRect", () => {
  it("splits right and below", () => {
    const [a, b] = splitRect({ x: 0, y: 0, w: 0.5, h: 1 }, "right");
    expect(a).toEqual({ x: 0, y: 0, w: 0.25, h: 1 });
    expect(b).toEqual({ x: 0.25, y: 0, w: 0.25, h: 1 });
    const [c, d] = splitRect({ x: 0, y: 0, w: 1, h: 1 }, "below");
    expect(c.h).toBe(0.5);
    expect(d.y).toBe(0.5);
  });
  it("sanitizes bad rects", () => {
    expect(sanitizeRect(undefined)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(sanitizeRect({ x: 0.9, y: 0, w: 0.5, h: 1 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(sanitizeRect({ x: NaN, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
