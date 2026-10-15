import { describe, expect, it } from "vitest";
import { captureAnchor, keyScroll, readerMoved, restoreAnchor, wheelDeltaPx, type SectionBox } from "@/lib/website/preview-scroll";

// A page as measured at desktop width and again at phone width: the same sections, different heights.
const desktop: SectionBox[] = [
  { id: "hero", top: 0, height: 900 }, { id: "about", top: 900, height: 700 }, { id: "services", top: 1600, height: 1000 }, { id: "footer", top: 2600, height: 400 },
];
const phone: SectionBox[] = [
  { id: "hero", top: 0, height: 700 }, { id: "about", top: 700, height: 1500 }, { id: "services", top: 2200, height: 2100 }, { id: "footer", top: 4300, height: 700 },
];

describe("wheel forwarding", () => {
  it("converts every wheel delta mode to pixels", () => {
    expect(wheelDeltaPx(120, 0, 800)).toBe(120);
    expect(wheelDeltaPx(3, 1, 800)).toBe(48);
    expect(wheelDeltaPx(1, 2, 800)).toBe(800);
  });
});

describe("keys that scroll a page", () => {
  it("claims the navigation keys wherever focus is", () => {
    expect(keyScroll("PageDown", false, 1000, true)).toEqual({ kind: "by", dy: 900 });
    expect(keyScroll("PageUp", false, 1000, true)).toEqual({ kind: "by", dy: -900 });
    expect(keyScroll("Home", false, 1000, true)).toEqual({ kind: "to", edge: "top" });
    expect(keyScroll("End", false, 1000, true)).toEqual({ kind: "to", edge: "end" });
  });
  it("leaves Space and the arrows to a focused button, and scrolls otherwise", () => {
    expect(keyScroll(" ", false, 1000, true)).toBeNull();
    expect(keyScroll("ArrowDown", false, 1000, true)).toBeNull();
    expect(keyScroll(" ", false, 1000, false)).toEqual({ kind: "by", dy: 900 });
    expect(keyScroll(" ", true, 1000, false)).toEqual({ kind: "by", dy: -900 });
    expect(keyScroll("ArrowDown", false, 1000, false)).toEqual({ kind: "by", dy: 48 });
    expect(keyScroll("ArrowUp", false, 1000, false)).toEqual({ kind: "by", dy: -48 });
  });
  it("ignores unrelated keys and never scrolls by less than a sensible step on a tiny viewport", () => {
    expect(keyScroll("a", false, 1000, false)).toBeNull();
    expect(keyScroll("Enter", false, 1000, false)).toBeNull();
    expect(keyScroll("PageDown", false, 40, false)).toEqual({ kind: "by", dy: 80 });
  });
});

describe("keeping your place when the width changes", () => {
  it("stays at the top, and stays at the end", () => {
    expect(captureAnchor(0, 3000, 800, desktop)).toEqual({ kind: "top" });
    expect(restoreAnchor({ kind: "top" }, 5000, 800, phone)).toBe(0);
    const end = captureAnchor(2200, 3000, 800, desktop);
    expect(end).toEqual({ kind: "end" });
    expect(restoreAnchor(end, 5000, 800, phone)).toBe(4200);
  });
  it("keeps the same part of the same section in view", () => {
    // Halfway through the services section on desktop (top 1600, height 1000).
    const anchor = captureAnchor(2100, 3000, 800, desktop);
    expect(anchor).toMatchObject({ kind: "section", id: "services", fraction: 0.5 });
    // On the phone that section starts at 2200 and is 2100 tall, so halfway through it is 3250.
    expect(restoreAnchor(anchor, 5000, 800, phone)).toBe(3250);
  });
  it("falls back to the proportional position when the section is gone", () => {
    const anchor = captureAnchor(1000, 3000, 800, desktop);
    const next = restoreAnchor(anchor, 5000, 800, [{ id: "different", top: 0, height: 5000 }]);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(4200);
    expect(next).toBe(Math.round(4200 * (1000 / 2200)));
  });
  it("never returns a position outside the document", () => {
    expect(restoreAnchor({ kind: "section", id: "services", fraction: 1, ratio: 1 }, 1000, 800, phone)).toBe(200);
    expect(restoreAnchor({ kind: "section", id: "x", fraction: 0, ratio: 0.5 }, 500, 800, [])).toBe(0);
  });
  it("handles a page that fits entirely in the viewport", () => {
    expect(captureAnchor(0, 600, 800, desktop)).toEqual({ kind: "top" });
    expect(restoreAnchor({ kind: "end" }, 600, 800, phone)).toBe(0);
  });
});

describe("telling the reader's scrolling from the preview's own", () => {
  it("is not the reader before the preview has placed the page, or when the page is where the preview put it", () => {
    expect(readerMoved(1400, null, 2000)).toBe(false);
    expect(readerMoved(1108, 1108, 2204)).toBe(false);
    expect(readerMoved(1115, 1108, 2204)).toBe(false); // the browser keeping the same content in view
  });
  it("is not the reader when the page got shorter and the browser clamped the position", () => {
    expect(readerMoved(1500, 2056, 1500)).toBe(false);
  });
  it("is the reader when the page is somewhere the preview did not put it", () => {
    // A scrollbar drag (or any script) moves the page to the middle after the preview placed it at the end: the preview must not drag them back.
    expect(readerMoved(1417, 2056, 2930)).toBe(true);
    expect(readerMoved(300, 1108, 2204)).toBe(true);
  });
});
