"use client";

import { aqiTargetSelector } from "@/lib/aqi/targets";

export interface TargetHit {
  element: HTMLElement;
  rect: DOMRect;
  insideDialog: boolean;
  /** The element's own corner radius, so the spotlight can match it. */
  radius: number;
}

export function normalizePath(pathname: string | null | undefined): string {
  return (pathname ?? "/").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
}

export function routeMatches(stepRoute: string | null, pathname: string): boolean {
  if (!stepRoute) return true;
  const clean = normalizePath(pathname);
  return clean === stepRoute || clean.startsWith(`${stepRoute}/`);
}

function measureElement(element: HTMLElement): TargetHit | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const style = window.getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
  const radius = Number.parseFloat(style.borderTopLeftRadius);
  return { element, rect, insideDialog: Boolean(element.closest('[role="dialog"]')), radius: Number.isFinite(radius) ? radius : 0 };
}

export function findVisibleTarget(id: string): TargetHit | null {
  if (typeof document === "undefined") return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(aqiTargetSelector(id)));
  for (const element of nodes) {
    const hit = measureElement(element);
    if (hit) return hit;
  }
  return null;
}

/**
 * Height of a sticky or fixed bar pinned to the top of the viewport, so a card or a scroll
 * alignment never ends up underneath it. Returns 0 when nothing is pinned there.
 */
export function measureTopInset(): number {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return 0;
  let node: Element | null = document.elementFromPoint(Math.round(window.innerWidth / 2), 4);
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    if (style.position === "fixed" || style.position === "sticky") {
      const rect = node.getBoundingClientRect();
      if (rect.top <= 4 && rect.width >= window.innerWidth * 0.5 && rect.height < 200) return Math.ceil(rect.bottom);
    }
    node = node.parentElement;
  }
  return 0;
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

export interface ScrollInsets {
  topInset?: number;
  /** Space at the bottom that the guide covers, for example a phone-width bottom sheet. */
  bottomInset?: number;
}

/**
 * Brings a target into the free part of the viewport (below a sticky header, above a bottom sheet).
 * Returns true when it scrolled, so the caller can wait for the page to settle before revealing the
 * spotlight instead of showing it sliding.
 */
export function scrollTargetIntoView(element: HTMLElement, reducedMotion: boolean, insets: ScrollInsets = {}): boolean {
  const rect = element.getBoundingClientRect();
  const top = Math.max(insets.topInset ?? 0, 0) + 16;
  const bottom = window.innerHeight - Math.max(insets.bottomInset ?? 0, 0) - 16;
  if (bottom - top < 80) return false;
  if (rect.top >= top && rect.bottom <= bottom) return false;
  const free = bottom - top;
  // A target taller than the free band is aligned to its top edge; otherwise it is centred in the band.
  const delta = rect.height > free ? rect.top - top : rect.top + rect.height / 2 - (top + bottom) / 2;
  if (Math.abs(delta) < 2) return false;
  const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
  const container = scrollParent(element);
  try {
    if (container) container.scrollBy({ top: delta, behavior });
    else window.scrollBy({ top: delta, behavior });
  } catch {
    if (container) container.scrollTop += delta;
    else window.scrollBy(0, delta);
  }
  return true;
}

export interface TargetSubscriptionOptions {
  id: string;
  /** Give up and report the control as missing after this long. 0 disables the timeout. */
  timeoutMs?: number;
  /** `first` is true once per element, after its rectangle has held still for two frames. */
  onHit: (hit: TargetHit, info: { first: boolean }) => void;
  /** The element that was highlighted left the page (a dialog closed, a route changed). */
  onLost?: () => void;
  onMissing?: () => void;
}

const RECT_EPSILON = 0.5;

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) < RECT_EPSILON && Math.abs(a.top - b.top) < RECT_EPSILON
    && Math.abs(a.width - b.width) < RECT_EPSILON && Math.abs(a.height - b.height) < RECT_EPSILON;
}

/**
 * Finds an approved target and keeps its rectangle current without polling. A MutationObserver covers
 * portals and dialogs that mount later; scroll, resize and CSS transition events re-measure; a
 * ResizeObserver covers the element changing size. The first report waits for the rectangle to hold
 * still, so an element that is animating in (a dialog, a collapsing sidebar) is never highlighted at
 * a transient position. After a change the observer samples for a few frames and then goes idle.
 */
export function subscribeToTarget({ id, timeoutMs = 8000, onHit, onLost, onMissing }: TargetSubscriptionOptions): () => void {
  let disposed = false;
  let frame = 0;
  let element: HTMLElement | null = null;
  let ready = false;
  let last: DOMRect | null = null;
  let lastInside = false;
  let stableFrames = 0;
  let waitedFrames = 0;
  let idleFrames = 0;
  let timer: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const armTimeout = () => {
    clearTimer();
    if (!timeoutMs || !onMissing) return;
    timer = window.setTimeout(() => {
      if (!disposed && !ready && !findVisibleTarget(id)) onMissing();
    }, timeoutMs);
  };

  const tick = () => {
    frame = 0;
    if (disposed) return;
    const hit = element && element.isConnected ? measureElement(element) : findVisibleTarget(id);
    if (!hit) {
      if (element) {
        const wasReady = ready;
        element = null;
        ready = false;
        last = null;
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (wasReady) {
          onLost?.();
          armTimeout();
        }
      }
      return;
    }
    if (hit.element !== element) {
      element = hit.element;
      ready = false;
      last = null;
      stableFrames = 0;
      waitedFrames = 0;
      clearTimer();
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(schedule);
      try {
        resizeObserver.observe(hit.element);
      } catch {
        /* detached */
      }
    }
    if (!ready) {
      stableFrames = last && sameRect(last, hit.rect) ? stableFrames + 1 : 0;
      last = hit.rect;
      waitedFrames += 1;
      if (stableFrames >= 2 || waitedFrames >= 40) {
        ready = true;
        lastInside = hit.insideDialog;
        idleFrames = 0;
        onHit(hit, { first: true });
      }
      frame = window.requestAnimationFrame(tick);
      return;
    }
    if (!last || !sameRect(last, hit.rect) || hit.insideDialog !== lastInside) {
      last = hit.rect;
      lastInside = hit.insideDialog;
      idleFrames = 0;
      onHit(hit, { first: false });
      frame = window.requestAnimationFrame(tick);
      return;
    }
    // Nothing moved this frame. Keep sampling briefly so a transition that is still running is
    // followed to its end, then stop until the next event.
    idleFrames += 1;
    if (idleFrames < 6) frame = window.requestAnimationFrame(tick);
  };

  function schedule() {
    if (disposed) return;
    idleFrames = 0;
    if (!frame) frame = window.requestAnimationFrame(tick);
  }

  // The walkthrough's own overlay changes on every update; reacting to it would only re-measure.
  const observer = new MutationObserver((records) => {
    if (records.every((record) => record.target instanceof Element && record.target.closest("[data-aqi-stage]"))) return;
    schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-state"] });
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  // A sidebar collapsing or a panel sliding moves the target without any DOM mutation after it starts.
  document.addEventListener("transitionrun", schedule, true);
  document.addEventListener("transitionend", schedule, true);

  schedule();
  armTimeout();

  return () => {
    disposed = true;
    observer.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    document.removeEventListener("transitionrun", schedule, true);
    document.removeEventListener("transitionend", schedule, true);
    if (frame) window.cancelAnimationFrame(frame);
    clearTimer();
  };
}
