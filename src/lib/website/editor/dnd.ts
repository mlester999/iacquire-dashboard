// Drag-and-drop geometry, kept free of the DOM so it can be tested. The canvas measures real rectangles and asks these functions
// where a dragged item would land; validity comes from `canPlace` / `canInsertElement` in ops, never from the pointer position alone.
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export type Axis = "x" | "y";

export const rectRight = (r: Rect) => r.left + r.width;
export const rectBottom = (r: Rect) => r.top + r.height;
export const center = (r: Rect): Point => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
export const contains = (r: Rect, p: Point) => p.x >= r.left && p.x <= rectRight(r) && p.y >= r.top && p.y <= rectBottom(r);

/** How far a point is from a rectangle (zero inside it). */
export function distance(r: Rect, p: Point): number {
  const dx = Math.max(r.left - p.x, 0, p.x - rectRight(r));
  const dy = Math.max(r.top - p.y, 0, p.y - rectBottom(r));
  return Math.hypot(dx, dy);
}

/** Whether a run of sibling rectangles reads left to right (a row) or top to bottom (a stack). */
export function axisOf(rects: Rect[], hint: Axis = "y"): Axis {
  if (rects.length < 2) return hint;
  const [a, b] = rects;
  // Two items that overlap vertically are side by side.
  return b.top < rectBottom(a) - 2 && a.top < rectBottom(b) - 2 ? "x" : "y";
}

export interface Slot {
  /** The index the dragged item would take among its new siblings. */
  index: number;
  /** The sibling the indicator is drawn against, or -1 for an empty container. */
  ref: number;
  before: boolean;
}

/** Where among `rects` a pointer would insert something. */
export function pickSlot(rects: Rect[], axis: Axis, p: Point): Slot {
  if (rects.length === 0) return { index: 0, ref: -1, before: true };
  let best = 0;
  let bestD = Infinity;
  rects.forEach((r, i) => {
    const d = distance(r, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const c = center(rects[best]);
  const before = axis === "y" ? p.y < c.y : p.x < c.x;
  return { index: before ? best : best + 1, ref: best, before };
}

export interface Line {
  x: number;
  y: number;
  /** Length along the axis the line runs. */
  length: number;
  orientation: "horizontal" | "vertical";
}

/** The indicator line for a slot, relative to the same origin as the rectangles. */
export function slotLine(rects: Rect[], slot: Slot, axis: Axis, container: Rect): Line {
  if (slot.ref < 0) {
    return axis === "y"
      ? { x: container.left + 8, y: container.top + container.height / 2, length: Math.max(24, container.width - 16), orientation: "horizontal" }
      : { x: container.left + container.width / 2, y: container.top + 8, length: Math.max(24, container.height - 16), orientation: "vertical" };
  }
  const r = rects[slot.ref];
  if (axis === "y") return { x: r.left, y: slot.before ? r.top : rectBottom(r), length: r.width, orientation: "horizontal" };
  return { x: slot.before ? r.left : rectRight(r), y: r.top, length: r.height, orientation: "vertical" };
}

/** Moves the index down by one when the dragged item sits earlier in the same list, because it is removed before it is re-inserted. */
export function adjustForRemoval(index: number, fromIndex: number | null, sameParent: boolean): number {
  if (!sameParent || fromIndex === null) return index;
  return fromIndex < index ? index - 1 : index;
}

/** Snaps a pixel width within a row to a 12-column span, within `min`..`max`. */
export function spanFromPixels(px: number, rowWidth: number, min = 1, max = 12): number {
  if (rowWidth <= 0) return min;
  return Math.max(min, Math.min(max, Math.round((px / rowWidth) * 12)));
}
