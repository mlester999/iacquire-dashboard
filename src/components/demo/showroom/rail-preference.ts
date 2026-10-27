"use client";

import * as React from "react";

// Whether the visitor folded the demo's navigation into its icon rail. It is a layout preference and nothing else: one word ("compact" or "full") in this browser's localStorage, no
// personal data and nothing sent anywhere. The server and the first browser render always draw the full rail, and the stored choice is applied right after the page is live (the
// same way the tour's progress and the colour theme are), so the two can never disagree. If the browser will not store it, the choice lasts for the visit.

const KEY = "iaq-demo-nav-v1";

export type RailPreference = "compact" | "full";

const listeners = new Set<() => void>();
/** Only used when storage is unavailable; while it works, storage is the single source of truth. */
let fallback: RailPreference | null = null;

function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return fallback ?? "";
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function writeRailPreference(value: RailPreference) {
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    fallback = value;
  }
  listeners.forEach((l) => l());
}

/** Whether the navigation rail is folded to icons, and how to change it. */
export function useRailCollapsed(): [boolean, (collapsed: boolean) => void] {
  const raw = React.useSyncExternalStore(subscribe, read, () => "");
  const set = React.useCallback((collapsed: boolean) => writeRailPreference(collapsed ? "compact" : "full"), []);
  return [raw === "compact", set];
}
