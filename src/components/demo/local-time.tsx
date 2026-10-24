"use client";

import * as React from "react";

// A moment shown in the visitor's own time zone. The server does not know it, so the page is rendered in UTC (and says so), and the browser replaces it with local time as soon as the
// page is live. The server render and the first browser render are the same text, so nothing mismatches.

const noSubscribe = () => () => {};

const inUtc = (iso: string) => `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))} UTC`;

/**
 * The visitor's own date and time, with their zone. `dateStyle`/`timeStyle` cannot be combined with `timeZoneName` (Chrome throws "Invalid option"), so the fields are named.
 * Exported for the regression test: this run only happens in the browser, after hydration.
 */
export function formatDemoLocalMoment(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

const inLocal = formatDemoLocalMoment;

export function LocalTime({ iso }: { iso: string }) {
  const live = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  return <time dateTime={iso}>{live ? inLocal(iso) : inUtc(iso)}</time>;
}
