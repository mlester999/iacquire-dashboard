"use client";

import * as React from "react";

const noSubscribe = () => () => {};

/**
 * Whether a media query matches. False on the server and in the first browser render, so the markup always agrees with the server's, and then live (it follows a rotated phone or a
 * resized window). A browser (or a test document) with no matchMedia reads as "no match".
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return noSubscribe();
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** A screen too short for the long question prompt and the full-height message box (a phone on its side): the chat tightens up, and its prompt shortens. */
export const SHORT_QUERY = "(max-height: 500px)";

/** The phone layout: the same breakpoint Tailwind's `sm` starts at. Below it AQi is a sheet over the whole page; from it up, a panel in the corner. */
export const SHEET_QUERY = "(max-width: 639px)";

/**
 * The part of the screen a phone's keyboard leaves free, as `bottom` (how far the keyboard reaches up from the bottom edge) and `height` (the visible height), in pixels; null while there is
 * no keyboard or the browser has no visualViewport. A sheet fixed to the bottom is otherwise covered by the keyboard on most phones, with the question box under it.
 */
export function useKeyboardBox(enabled: boolean): { bottom: number; height: number } | null {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const vv = typeof window !== "undefined" ? window.visualViewport : null;
      if (!enabled || !vv) return noSubscribe();
      vv.addEventListener("resize", onChange);
      vv.addEventListener("scroll", onChange);
      return () => {
        vv.removeEventListener("resize", onChange);
        vv.removeEventListener("scroll", onChange);
      };
    },
    [enabled],
  );
  const raw = React.useSyncExternalStore(
    subscribe,
    () => {
      const vv = window.visualViewport;
      if (!enabled || !vv) return "";
      const bottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      // Only a real keyboard counts: a few pixels of difference is the browser's own toolbar moving.
      return bottom > 80 ? `${bottom},${Math.round(vv.height)}` : "";
    },
    () => "",
  );
  if (!raw) return null;
  const [bottom, height] = raw.split(",").map(Number);
  return { bottom, height };
}
