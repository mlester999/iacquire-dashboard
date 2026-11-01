"use client";

import * as React from "react";
import { fingerprintOf, type LaunchReadiness } from "@/lib/launch-readiness";

// Keeps the launch panel in step with the stored state without re-running the page. The panel passes in the function that reads it (a server action), so this file imports only
// from @/lib and stays free of server code. Nothing here decides what a state is: it asks again, shows what came back, and says so out loud only when something that matters changed.

/** What the read answers with: the launch state and its fingerprint (the server's own, from the same pure function the judge file exports). */
export type LaunchFetcher = () => Promise<{ readiness: LaunchReadiness; fingerprint: string }>;

/** While iAcquire or the system has something open, or a required step is running, the next change is probably seconds away. */
export const FAST_POLL_MS = 5_000;
/** While only the client has to act, nothing changes until they do; this only notices a payment or an approval that happened in another tab. */
export const SLOW_POLL_MS = 30_000;
/** A failing read doubles its wait each time, up to this. */
export const BACKOFF_CAP_MS = 5 * 60_000;

/**
 * How long to wait before asking again, or null for "do not ask": nothing is going to change by itself at 100% (or before the questionnaire is submitted). Only required, applicable
 * items count, because those are the ones the percentage and the state are made of: an informational line that stays open must not keep a panel polling at the fast rate for ever.
 * A failed first read (no state yet) is asked for again slowly.
 */
export function pollIntervalMs(readiness: LaunchReadiness | null): number | null {
  if (!readiness) return SLOW_POLL_MS;
  if (readiness.state === "ready_to_launch" || readiness.state === "not_started") return null;
  const required = readiness.steps.flatMap((s) => s.items).filter((i) => i.required && i.state !== "not_applicable");
  if (required.some((i) => i.state === "in_progress" || (i.owner !== "you" && i.state !== "done"))) return FAST_POLL_MS;
  if (required.some((i) => i.state !== "done")) return SLOW_POLL_MS;
  return null;
}

/** The one sentence a screen reader hears when the launch state changed: where it stands and how many things are the person's own to do. */
export function describeLaunch(readiness: LaunchReadiness): string {
  const you = readiness.blocking.filter((i) => i.owner === "you").length;
  const needs = you ? `, ${you} ${you === 1 ? "thing needs" : "things need"} you` : "";
  return `Launch readiness ${readiness.percent} percent${needs}. ${readiness.label}.`;
}

/** "Updated just now", "Updated 12 s ago", "Updated 3 min ago". Seconds are whole and never negative. */
export function updatedAgoText(syncedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - syncedAt) / 1000));
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds} s ago`;
  return `Updated ${Math.floor(seconds / 60)} min ago`;
}

export type LaunchConnection = "ok" | "error" | "offline";

// The browser's own word on whether it is online, as an external store: nothing is guessed, and the server render says "online" so the two agree until the browser says otherwise.
const subscribeOnline = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};
const onlineNow = () => navigator.onLine !== false;

export function useLiveLaunch({ initial, fetcher, enabled = true }: {
  /** What the page read. Null when that read failed: the panel then shows its retry card and this hook keeps asking. */
  initial: LaunchReadiness | null;
  fetcher: LaunchFetcher;
  /** Off for the design preview and for a read-only agency view, which has nobody's own workspace to ask about: no timers, no listeners. */
  enabled?: boolean;
}) {
  const [readiness, setReadiness] = React.useState<LaunchReadiness | null>(initial);
  const [syncedAt, setSyncedAt] = React.useState(() => Date.now());
  const [failures, setFailures] = React.useState(0);
  const [cycle, setCycle] = React.useState(0);
  const online = React.useSyncExternalStore(subscribeOnline, onlineNow, () => true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const fetcherRef = React.useRef(fetcher);
  const mounted = React.useRef(false);
  const inflight = React.useRef<Promise<boolean> | null>(null);
  // What is on screen (to skip a re-render when a read says the same thing) and the last fingerprint (to announce only a real change).
  const shown = React.useRef<string | null>(initial ? JSON.stringify(initial) : null);
  const fingerprint = React.useRef<string | null>(initial ? fingerprintOf(initial) : null);
  React.useEffect(() => {
    fetcherRef.current = fetcher;
  });
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = React.useCallback((): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    setRefreshing(true);
    const run = (async () => {
      try {
        const next = await fetcherRef.current();
        if (!mounted.current) return true;
        const text = JSON.stringify(next.readiness);
        if (text !== shown.current) {
          shown.current = text;
          setReadiness(next.readiness);
        }
        // Wording and counts can change without the fingerprint moving; only a change in the state, or in who has to move on a required item, is worth interrupting someone for.
        if (next.fingerprint !== fingerprint.current) {
          const before = fingerprint.current;
          fingerprint.current = next.fingerprint;
          if (before !== null) setAnnouncement(describeLaunch(next.readiness));
        }
        setFailures(0);
        setSyncedAt(Date.now());
        return true;
      } catch {
        if (mounted.current) setFailures((n) => n + 1);
        return false;
      } finally {
        inflight.current = null;
        if (mounted.current) {
          setRefreshing(false);
          setCycle((n) => n + 1);
        }
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  // The next read is scheduled after the previous one finished, so a slow answer never piles reads up, and the wait follows the state that was just read.
  const base = enabled ? pollIntervalMs(readiness) : null;
  React.useEffect(() => {
    if (base === null) return;
    const wait = failures === 0 ? base : Math.min(BACKOFF_CAP_MS, base * 2 ** failures);
    const id = window.setTimeout(() => {
      // A tab nobody is looking at does not ask; it is asked again the moment it is shown.
      if (document.visibilityState === "visible") void refresh();
      else setCycle((n) => n + 1);
    }, wait);
    return () => window.clearTimeout(id);
  }, [base, failures, cycle, refresh]);

  React.useEffect(() => {
    if (!enabled) return;
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [enabled, refresh]);

  const connection: LaunchConnection = !enabled ? "ok" : !online ? "offline" : failures > 0 ? "error" : "ok";
  return { readiness, syncedAt, connection, announcement, refreshing, refresh };
}
