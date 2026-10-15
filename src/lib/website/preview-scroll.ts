// Scroll behaviour for the full-page website preview, kept free of the DOM so it can be unit tested. The preview shell measures the framed
// document, hands the numbers here, and applies the answer.

/** The browser's WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
export function wheelDeltaPx(delta: number, mode: number, pageSize: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * pageSize;
  return delta;
}

export type KeyScroll = { kind: "by"; dy: number } | { kind: "to"; edge: "top" | "end" };

/**
 * What the keys that scroll a page should do, so they work when focus is on the preview's own controls and not only inside the framed site.
 * `onControl` is true when a button or link has focus: Space and Enter belong to that control then, so only the navigation keys are claimed.
 */
export function keyScroll(key: string, shift: boolean, pageSize: number, onControl: boolean): KeyScroll | null {
  const page = Math.max(80, Math.round(pageSize * 0.9));
  switch (key) {
    case "PageDown": return { kind: "by", dy: page };
    case "PageUp": return { kind: "by", dy: -page };
    case "Home": return { kind: "to", edge: "top" };
    case "End": return { kind: "to", edge: "end" };
    case "ArrowDown": return onControl ? null : { kind: "by", dy: 48 };
    case "ArrowUp": return onControl ? null : { kind: "by", dy: -48 };
    case " ": return onControl ? null : { kind: "by", dy: shift ? -page : page };
    default: return null;
  }
}

export interface SectionBox { id: string; top: number; height: number }

/** Where the top edge of the viewport sat, in terms that survive a change of width (heights change, the content does not). */
export type ScrollAnchor =
  | { kind: "top" }
  | { kind: "end" }
  | { kind: "section"; id: string; fraction: number; ratio: number };

const EDGE = 2;

/** Describe the current scroll position. `sections` are the page's sections in document order, measured from the top of the document. */
export function captureAnchor(scrollTop: number, scrollHeight: number, viewportHeight: number, sections: SectionBox[]): ScrollAnchor {
  const max = Math.max(0, scrollHeight - viewportHeight);
  if (scrollTop <= EDGE) return { kind: "top" };
  if (max > 0 && scrollTop >= max - EDGE) return { kind: "end" };
  const ratio = max > 0 ? scrollTop / max : 0;
  let hit: SectionBox | null = null;
  for (const section of sections) {
    if (section.height <= 0) continue;
    if (section.top <= scrollTop + EDGE && (hit === null || section.top >= hit.top)) hit = section;
  }
  if (!hit || scrollTop > hit.top + hit.height) return { kind: "section", id: "", fraction: 0, ratio };
  return { kind: "section", id: hit.id, fraction: Math.min(1, Math.max(0, (scrollTop - hit.top) / hit.height)), ratio };
}

/** The scroll position that puts the same part of the page at the top of the viewport after the layout has changed. */
export function restoreAnchor(anchor: ScrollAnchor, scrollHeight: number, viewportHeight: number, sections: SectionBox[]): number {
  const max = Math.max(0, scrollHeight - viewportHeight);
  if (anchor.kind === "top") return 0;
  if (anchor.kind === "end") return max;
  const section = anchor.id ? sections.find((s) => s.id === anchor.id && s.height > 0) : undefined;
  const target = section ? section.top + section.height * anchor.fraction : max * anchor.ratio;
  return Math.min(max, Math.max(0, Math.round(target)));
}

/**
 * Whether something other than the preview moved the page since the preview last placed it. While the preview is re-applying a reader's place after a
 * width change it must give way the moment the reader (a scrollbar drag, a script, a keyboard that the page never saw) scrolls somewhere else, or it
 * would drag them back. A page that got shorter is clamped by the browser, which is not the reader, and a small shift is the browser keeping the same
 * content in view as things above it change size.
 */
export function readerMoved(currentTop: number, placedTop: number | null, maxTop: number, tolerance = 24): boolean {
  if (placedTop === null) return false;
  return Math.abs(currentTop - Math.min(placedTop, Math.max(0, maxTop))) > tolerance;
}
