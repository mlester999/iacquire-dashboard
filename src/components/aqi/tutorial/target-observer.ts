"use client";

import { aqiTargetSelector } from "@/lib/aqi/targets";

export interface TargetHit {
  element: HTMLElement;
  rect: DOMRect;
  insideDialog: boolean;
}

export function normalizePath(pathname: string | null | undefined): string {
  return (pathname ?? "/").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
}

export function routeMatches(stepRoute: string | null, pathname: string): boolean {
  if (!stepRoute) return true;
  const clean = normalizePath(pathname);
  return clean === stepRoute || clean.startsWith(`${stepRoute}/`);
}

export function findVisibleTarget(id: string): TargetHit | null {
  if (typeof document === "undefined") return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(aqiTargetSelector(id)));
  for (const element of nodes) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    return { element, rect, insideDialog: Boolean(element.closest('[role="dialog"]')) };
  }
  return null;
}

export function scrollTargetIntoView(element: HTMLElement, reducedMotion: boolean): void {
  const rect = element.getBoundingClientRect();
  const headerGuard = 72;
  // On a phone the instruction sheet occupies the bottom of the screen. A tall target is aligned
  // toward the top so the sheet does not cover the control it is explaining.
  if (window.innerWidth < 640 && rect.height > window.innerHeight * 0.3) {
    const top = window.scrollY + rect.top - headerGuard;
    try {
      window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : "smooth" });
    } catch {
      window.scrollTo(0, Math.max(0, top));
    }
    return;
  }
  const visible = rect.top >= headerGuard && rect.bottom <= window.innerHeight - 16;
  if (visible) return;
  try {
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  } catch {
    element.scrollIntoView();
  }
}

export interface TargetSubscriptionOptions {
  id: string;
  timeoutMs?: number;
  onHit: (hit: TargetHit) => void;
  onMissing: () => void;
}

/**
 * Observes a target until it exists, then keeps its rectangle current without polling. A
 * MutationObserver covers portals and dialogs that mount later; scroll/resize keep the spotlight
 * aligned; the timeout prevents an endless "looking for" state when a control was renamed.
 */
export function subscribeToTarget({ id, timeoutMs = 8000, onHit, onMissing }: TargetSubscriptionOptions): () => void {
  let disposed = false;
  let frame = 0;
  let resizeObserver: ResizeObserver | null = null;
  let observedElement: HTMLElement | null = null;
  let timer: number | null = null;

  const report = () => {
    if (disposed) return;
    const hit = findVisibleTarget(id);
    if (!hit) return;
    if (observedElement !== hit.element) {
      observedElement = hit.element;
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(schedule);
      try {
        resizeObserver.observe(hit.element);
      } catch {
        /* detached */
      }
    }
    onHit(hit);
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (disposed || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      report();
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);

  report();
  if (!observedElement) {
    timer = window.setTimeout(() => {
      if (!disposed && !findVisibleTarget(id)) onMissing();
    }, timeoutMs);
  }

  return () => {
    disposed = true;
    observer.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    if (frame) window.cancelAnimationFrame(frame);
    if (timer) window.clearTimeout(timer);
  };
}

export interface Placement {
  left: number;
  top: number;
  width: number;
  placement: "left" | "right" | "above" | "below";
}

/** Chooses a tooltip position that never covers the highlighted element. */
export function placeTooltip(rect: DOMRect, cardWidth: number, cardHeight: number, viewportWidth: number, viewportHeight: number): Placement {
  const gap = 14;
  const margin = 12;
  const width = Math.min(cardWidth, viewportWidth - margin * 2);
  const height = Math.min(cardHeight, viewportHeight - margin * 2);
  const clampLeft = (value: number) => Math.max(margin, Math.min(value, viewportWidth - width - margin));
  const clampTop = (value: number) => Math.max(margin, Math.min(value, viewportHeight - height - margin));

  const spaceRight = viewportWidth - rect.right;
  const spaceLeft = rect.left;
  const spaceBelow = viewportHeight - rect.bottom;

  if (spaceRight >= width + gap) {
    return { left: rect.right + gap, top: clampTop(rect.top + rect.height / 2 - height / 2), width, placement: "right" };
  }
  if (spaceLeft >= width + gap) {
    return { left: rect.left - width - gap, top: clampTop(rect.top + rect.height / 2 - height / 2), width, placement: "left" };
  }
  if (spaceBelow >= height + gap) {
    return { left: clampLeft(rect.left + rect.width / 2 - width / 2), top: rect.bottom + gap, width, placement: "below" };
  }
  return { left: clampLeft(rect.left + rect.width / 2 - width / 2), top: clampTop(rect.top - height - gap), width, placement: "above" };
}
