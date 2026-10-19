/**
 * Pure placement maths for the walkthrough card. It has no DOM access so every decision can be
 * tested: the stage measures the target, the card, the viewport and any obstacles, and this module
 * chooses where the card goes.
 *
 * Preference order is right, below, left, above. The card never overlaps the highlighted target
 * when any side can hold it; when no side can (a target that fills the screen), it docks in a
 * viewport corner that covers the least of the target and avoids the AQi launcher.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PlacementSide = "right" | "below" | "left" | "above";

export interface PlacementInput {
  /** The highlighted element's rectangle in viewport coordinates, or null when there is none. */
  target: Box | null;
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Minimum distance from every viewport edge. */
  padding?: number;
  /** Distance between the target and the card. */
  gap?: number;
  /** Height of a sticky/fixed header at the top of the viewport that the card must not cover. */
  topInset?: number;
  /** Rectangles the card should stay clear of, for example the AQi launcher. */
  avoid?: Box[];
}

export interface CardPlacement {
  left: number;
  top: number;
  width: number;
  /** The side of the target the card sits on, or "dock" when it is parked in a viewport corner. */
  side: PlacementSide | "dock";
  /** Where the pointer on the card edge should sit, measured along that edge. */
  arrow: { edge: "left" | "right" | "top" | "bottom"; offset: number } | null;
  /** True only when no position avoided the target. */
  coversTarget: boolean;
}

const right = (box: Box) => box.left + box.width;
const bottom = (box: Box) => box.top + box.height;

export function overlapArea(a: Box, b: Box): number {
  const width = Math.min(right(a), right(b)) - Math.max(a.left, b.left);
  const height = Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** The part of a rectangle that is actually on screen. */
export function visiblePart(box: Box, viewport: { width: number; height: number }): Box | null {
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const rightEdge = Math.min(viewport.width, right(box));
  const bottomEdge = Math.min(viewport.height, bottom(box));
  if (rightEdge - left < 1 || bottomEdge - top < 1) return null;
  return { left, top, width: rightEdge - left, height: bottomEdge - top };
}

export function placeCard(input: PlacementInput): CardPlacement {
  const padding = input.padding ?? 12;
  const gap = input.gap ?? 14;
  const { viewport } = input;
  const width = Math.min(input.card.width, viewport.width - padding * 2);
  const minTop = Math.max(padding, (input.topInset ?? 0) + 8);
  const maxHeight = viewport.height - minTop - padding;
  const height = Math.min(input.card.height, maxHeight);
  const avoid = input.avoid ?? [];
  const minLeft = padding;
  const maxLeft = viewport.width - width - padding;
  const maxTop = viewport.height - height - padding;
  const visible = input.target ? visiblePart(input.target, viewport) : null;

  const rect = (left: number, top: number): Box => ({ left, top, width, height });
  const obstaclePenalty = (box: Box) => avoid.reduce((sum, obstacle) => sum + overlapArea(box, obstacle), 0);

  if (visible) {
    const centreX = visible.left + visible.width / 2;
    const centreY = visible.top + visible.height / 2;
    const candidates: Array<{ side: PlacementSide; box: Box; fits: boolean }> = [
      { side: "right", box: rect(right(visible) + gap, clamp(centreY - height / 2, minTop, maxTop)), fits: right(visible) + gap + width <= viewport.width - padding },
      { side: "below", box: rect(clamp(centreX - width / 2, minLeft, maxLeft), bottom(visible) + gap), fits: bottom(visible) + gap + height <= viewport.height - padding },
      { side: "left", box: rect(visible.left - gap - width, clamp(centreY - height / 2, minTop, maxTop)), fits: visible.left - gap - width >= padding },
      { side: "above", box: rect(clamp(centreX - width / 2, minLeft, maxLeft), visible.top - gap - height), fits: visible.top - gap - height >= minTop },
    ];
    const usable = candidates.filter((candidate) => candidate.fits && overlapArea(candidate.box, visible) === 0);
    // Prefer the first side that is clear of the launcher too; otherwise the first side that fits.
    const chosen = usable.find((candidate) => obstaclePenalty(candidate.box) === 0) ?? usable[0];
    if (chosen) {
      const horizontal = chosen.side === "right" || chosen.side === "left";
      const edge = chosen.side === "right" ? "left" : chosen.side === "left" ? "right" : chosen.side === "below" ? "top" : "bottom";
      const arrowOffset = horizontal
        ? clamp(centreY - chosen.box.top, 18, chosen.box.height - 18)
        : clamp(centreX - chosen.box.left, 18, chosen.box.width - 18);
      return { left: chosen.box.left, top: chosen.box.top, width, side: chosen.side, arrow: { edge, offset: arrowOffset }, coversTarget: false };
    }
  }

  // No side can hold the card beside the target (or there is no target): park it in a corner.
  const corners: Box[] = [
    rect(maxLeft, maxTop),
    rect(minLeft, maxTop),
    rect(maxLeft, minTop),
    rect(minLeft, minTop),
  ];
  const lifted = corners.map((box) => {
    // Lift a bottom corner above any obstacle sitting in it, such as the launcher.
    const blockers = avoid.filter((obstacle) => overlapArea(box, obstacle) > 0);
    if (!blockers.length || box.top <= minTop) return box;
    const top = Math.min(...blockers.map((blocker) => blocker.top)) - gap - height;
    return top >= minTop ? { ...box, top } : box;
  });
  let best = lifted[0];
  let bestScore = Number.POSITIVE_INFINITY;
  lifted.forEach((box, index) => {
    const score = (visible ? overlapArea(box, visible) : 0) * 1000 + obstaclePenalty(box) * 10 + index;
    if (score < bestScore) {
      bestScore = score;
      best = box;
    }
  });
  return {
    left: best.left,
    top: best.top,
    width,
    side: "dock",
    arrow: null,
    coversTarget: Boolean(visible && overlapArea(best, visible) > 0),
  };
}
