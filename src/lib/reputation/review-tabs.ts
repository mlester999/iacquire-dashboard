import { cn } from "@/lib/utils";

// The section tabs of CRM → Reviews, as plain data and plain functions (the screen is a client component, so nothing a server page calls lives in it). Seven tabs do not fit a
// phone or the narrow column beside the CRM menu, so the row scrolls inside its own box instead of pushing the page sideways; the tab being looked at is scrolled into view.

export const REVIEWS_TABS = [
  ["overview", "Overview"], ["requests", "Requests"], ["feedback", "Private feedback"], ["satisfaction", "Satisfaction"], ["public", "Public reviews"], ["batches", "Batches"], ["settings", "Settings"],
] as const;

export type ReviewsTab = (typeof REVIEWS_TABS)[number][0];

/** The tabs this workspace shows: Satisfaction needs surveys, Batches needs batches (or some already made), Public reviews needs public reviews (or some already read). */
export function visibleReviewsTabs(show: { satisfaction: boolean; batches: boolean; public: boolean }): Array<{ key: ReviewsTab; label: string }> {
  return REVIEWS_TABS.filter(([k]) => (k !== "satisfaction" || show.satisfaction) && (k !== "batches" || show.batches) && (k !== "public" || show.public)).map(([key, label]) => ({ key, label }));
}

// The row sits in a box of its own width (`min-w-0`) and scrolls sideways inside it; a tab never shrinks or wraps (`shrink-0`, `whitespace-nowrap`) and is at least 44px tall.
// The rule under the row is on the box, not on the row, because a scrolling row clips whatever hangs below it.
export const TAB_BOX_CLASS = "relative min-w-0 max-w-full border-b border-line";
export const TAB_ROW_CLASS = "scrollbar-thin relative flex min-w-0 snap-x snap-proximity scroll-px-3 gap-1 overflow-x-auto overscroll-x-contain";
export const TAB_FADE_CLASS = "pointer-events-none absolute inset-y-0 z-10 w-8 from-bg to-transparent";

export const tabLinkClass = (active: boolean) =>
  cn(
    "inline-flex min-h-11 shrink-0 snap-start items-center whitespace-nowrap border-b-2 px-3 text-[14px] font-medium transition-colors",
    active ? "border-primary text-ink" : "border-transparent text-muted hover:text-ink",
  );

/** Where to scroll the row so the tab being looked at is in the middle of it (or as near as the row's ends allow). */
export function tabScrollTarget(m: { itemLeft: number; itemWidth: number; viewWidth: number; scrollWidth: number }): number {
  const max = Math.max(0, m.scrollWidth - m.viewWidth);
  return Math.min(max, Math.max(0, Math.round(m.itemLeft + m.itemWidth / 2 - m.viewWidth / 2)));
}

/** Whether more of the row lies out of sight at each end, for the fade hint. */
export function scrollEdges(m: { scrollLeft: number; viewWidth: number; scrollWidth: number }): { start: boolean; end: boolean } {
  return { start: m.scrollLeft > 1, end: m.scrollLeft + m.viewWidth < m.scrollWidth - 1 };
}
