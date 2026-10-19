import { describe, expect, it } from "vitest";
import { overlapArea, placeCard, visiblePart, type Box } from "@/components/aqi/tutorial/placement";

const VIEWPORT = { width: 1440, height: 900 };
const CARD = { width: 360, height: 180 };
const LAUNCHER: Box = { left: 1344, top: 828, width: 80, height: 56 };

function noOverlap(a: Box, b: Box) {
  return overlapArea(a, b) === 0;
}

describe("tutorial card placement", () => {
  it("places the card to the right of a target that leaves room", () => {
    const target: Box = { left: 40, top: 300, width: 220, height: 44 };
    const result = placeCard({ target, card: CARD, viewport: VIEWPORT });
    expect(result.side).toBe("right");
    expect(result.left).toBe(target.left + target.width + 14);
    expect(result.arrow?.edge).toBe("left");
    expect(noOverlap({ left: result.left, top: result.top, width: result.width, height: CARD.height }, target)).toBe(true);
  });

  it("falls back to below for a wide target that fills the row", () => {
    const target: Box = { left: 280, top: 96, width: 1120, height: 220 };
    const result = placeCard({ target, card: CARD, viewport: VIEWPORT });
    expect(result.side).toBe("below");
    expect(result.top).toBe(target.top + target.height + 14);
    expect(result.coversTarget).toBe(false);
  });

  it("uses left, then above, when right and below are full", () => {
    const left = placeCard({ target: { left: 1000, top: 700, width: 420, height: 180 }, card: CARD, viewport: VIEWPORT });
    expect(left.side).toBe("left");
    const above = placeCard({ target: { left: 20, top: 800, width: 1400, height: 90 }, card: CARD, viewport: VIEWPORT });
    expect(above.side).toBe("above");
    expect(above.top + CARD.height).toBeLessThanOrEqual(800 - 14 + 0.001);
  });

  it("never leaves the viewport padding, even for a target at the very edge", () => {
    const targets: Box[] = [
      { left: 0, top: 0, width: 80, height: 40 },
      { left: 1360, top: 860, width: 80, height: 40 },
      { left: 600, top: 0, width: 200, height: 30 },
    ];
    for (const target of targets) {
      const result = placeCard({ target, card: CARD, viewport: VIEWPORT, topInset: 64 });
      expect(result.left).toBeGreaterThanOrEqual(12);
      expect(result.top).toBeGreaterThanOrEqual(12);
      expect(result.left + result.width).toBeLessThanOrEqual(VIEWPORT.width - 12);
      expect(result.top + CARD.height).toBeLessThanOrEqual(VIEWPORT.height - 12);
    }
  });

  it("keeps the card clear of a sticky header", () => {
    const result = placeCard({ target: { left: 600, top: 120, width: 300, height: 200 }, card: { width: 360, height: 600 }, viewport: VIEWPORT, topInset: 72 });
    expect(result.top).toBeGreaterThanOrEqual(80);
  });

  it("docks instead of covering when the target fills the screen", () => {
    const target: Box = { left: 0, top: 0, width: 1440, height: 900 };
    const result = placeCard({ target, card: CARD, viewport: VIEWPORT, avoid: [LAUNCHER] });
    expect(result.side).toBe("dock");
    expect(result.coversTarget).toBe(true);
    expect(result.arrow).toBeNull();
    // Docked cards sit above the launcher, not on it.
    expect(noOverlap({ left: result.left, top: result.top, width: result.width, height: CARD.height }, LAUNCHER)).toBe(true);
  });

  it("docks in a safe corner when there is no target", () => {
    const result = placeCard({ target: null, card: CARD, viewport: VIEWPORT, avoid: [LAUNCHER], topInset: 64 });
    expect(result.side).toBe("dock");
    expect(result.coversTarget).toBe(false);
    expect(result.left + result.width).toBeLessThanOrEqual(1440 - 12);
    expect(result.top).toBeGreaterThan(300);
    expect(noOverlap({ left: result.left, top: result.top, width: result.width, height: CARD.height }, LAUNCHER)).toBe(true);
  });

  it("prefers a side that does not sit on the launcher", () => {
    const target: Box = { left: 1000, top: 800, width: 300, height: 60 };
    const result = placeCard({ target, card: CARD, viewport: VIEWPORT, avoid: [LAUNCHER] });
    expect(noOverlap({ left: result.left, top: result.top, width: result.width, height: CARD.height }, LAUNCHER)).toBe(true);
    expect(noOverlap({ left: result.left, top: result.top, width: result.width, height: CARD.height }, target)).toBe(true);
  });

  it("shrinks to a narrow viewport and still avoids the target when it can", () => {
    const viewport = { width: 390, height: 844 };
    const target: Box = { left: 20, top: 100, width: 350, height: 120 };
    const result = placeCard({ target, card: CARD, viewport });
    expect(result.width).toBeLessThanOrEqual(390 - 24);
    expect(result.side).toBe("below");
    expect(result.left).toBeGreaterThanOrEqual(12);
    expect(result.left + result.width).toBeLessThanOrEqual(378);
  });

  it("treats a target scrolled completely off screen as having no target", () => {
    expect(visiblePart({ left: 100, top: 1200, width: 200, height: 40 }, VIEWPORT)).toBeNull();
    const result = placeCard({ target: { left: 100, top: 1200, width: 200, height: 40 }, card: CARD, viewport: VIEWPORT });
    expect(result.side).toBe("dock");
    expect(result.coversTarget).toBe(false);
  });

  it("centres on the visible part of a partly visible target", () => {
    const target: Box = { left: 300, top: -400, width: 600, height: 700 };
    const part = visiblePart(target, VIEWPORT)!;
    expect(part.top).toBe(0);
    expect(part.height).toBe(300);
    const result = placeCard({ target, card: CARD, viewport: VIEWPORT });
    expect(result.coversTarget).toBe(false);
  });

  it("is deterministic and finite for degenerate sizes", () => {
    const result = placeCard({ target: { left: 5, top: 5, width: 0.5, height: 0.5 }, card: { width: 0, height: 0 }, viewport: { width: 10, height: 10 } });
    expect(Number.isFinite(result.left)).toBe(true);
    expect(Number.isFinite(result.top)).toBe(true);
    expect(Number.isFinite(result.width)).toBe(true);
  });
});
