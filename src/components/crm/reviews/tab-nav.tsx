"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { scrollEdges, tabLinkClass, tabScrollTarget, TAB_BOX_CLASS, TAB_FADE_CLASS, TAB_ROW_CLASS, type ReviewsTab } from "@/lib/reputation/review-tabs";

/**
 * The section tabs of CRM → Reviews. The row scrolls inside its own box (it never makes the page scroll sideways), the tab being looked at is scrolled into view, and a fade
 * at either end says there is more out of sight.
 */
export function ReviewsTabNav({ tab, tabs, hrefFor, openFeedback }: { tab: ReviewsTab; tabs: Array<{ key: ReviewsTab; label: string }>; hrefFor: (t: ReviewsTab) => string; openFeedback: number }) {
  const row = React.useRef<HTMLElement | null>(null);
  const active = React.useRef<HTMLAnchorElement | null>(null);
  const [edges, setEdges] = React.useState({ start: false, end: false });
  const measure = React.useCallback(() => {
    const el = row.current;
    if (el) setEdges(scrollEdges({ scrollLeft: el.scrollLeft, viewWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
  }, []);
  React.useEffect(() => {
    const el = row.current;
    const a = active.current;
    // Set on the row itself, so no other scrolling box (the page) moves.
    if (el && a) el.scrollLeft = tabScrollTarget({ itemLeft: a.offsetLeft, itemWidth: a.offsetWidth, viewWidth: el.clientWidth, scrollWidth: el.scrollWidth });
    if (!el || typeof ResizeObserver === "undefined") return;
    // Observing reports the first size too, so the fades are right from the start.
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [tab, measure]);
  return (
    <div className={TAB_BOX_CLASS}>
      <nav ref={row} aria-label="Reviews sections" className={TAB_ROW_CLASS} onScroll={measure}>
        {tabs.map(({ key, label }) => (
          <Link key={key} ref={tab === key ? active : undefined} href={hrefFor(key)} aria-current={tab === key ? "page" : undefined} className={tabLinkClass(tab === key)}>
            {label}
            {key === "feedback" && openFeedback > 0 && <Badge tone="primary" className="ml-2">{openFeedback}</Badge>}
          </Link>
        ))}
      </nav>
      {edges.start && <span aria-hidden className={cn(TAB_FADE_CLASS, "left-0 bg-gradient-to-r")} />}
      {edges.end && <span aria-hidden className={cn(TAB_FADE_CLASS, "right-0 bg-gradient-to-l")} />}
    </div>
  );
}
