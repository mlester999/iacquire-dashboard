"use client";

import * as React from "react";
import type { ViewCounts } from "@/server/messaging/inbox-list";

// Keeps the inbox in step with the server by polling /api/inbox/sync (see src/server/messaging/inbox-sync.ts for why it is a poll). Everything the
// hook decides is in the small pure functions below, so it can be tested without a browser; the hook itself only schedules requests.

export const POLL_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;
/** The next poll asks from this long before the last answer's server time, so a change committed late (a slow transaction) is still seen once. */
export const OVERLAP_MS = 10_000;
/** Even when nothing seems to have changed, the list is read again this often: a safety net, not the mechanism. */
export const FULL_REFRESH_MS = 90_000;

export interface SyncChange {
  id: string;
  revision: number;
}

export interface SyncResponse {
  serverTime: string;
  full: boolean;
  changes: SyncChange[];
  counts?: ViewCounts;
}

/** 5 s while it works; after failures 10 s, 20 s, 40 s, then a minute. One success returns it to 5 s. */
export function nextPollDelay(failures: number): number {
  if (failures <= 0) return POLL_MS;
  return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures, 6));
}

/** The `since` to send: the last server time, minus the overlap. Null (ask for everything) before the first answer. */
export function sinceFor(lastServerTime: string | null): string | null {
  if (!lastServerTime) return null;
  const t = Date.parse(lastServerTime);
  return Number.isNaN(t) ? null : new Date(t - OVERLAP_MS).toISOString();
}

export interface SyncPlan {
  refreshList: boolean;
  refreshThread: boolean;
}

/**
 * What to re-read after an answer. A change counts only if its revision is newer than the one this client already holds (a repeated or late
 * answer changes nothing). A conversation the list does not hold may belong in it (a new message), so an unknown id refreshes the list too.
 */
export function planRefresh(res: SyncResponse, known: ReadonlyMap<string, number>, openId: string | null, lastFullAt: number, now: number): SyncPlan {
  if (res.full) return { refreshList: true, refreshThread: openId !== null };
  const newer = res.changes.filter((c) => c.revision > (known.get(c.id) ?? -1));
  return {
    refreshList: newer.length > 0 || now - lastFullAt >= FULL_REFRESH_MS,
    refreshThread: openId !== null && newer.some((c) => c.id === openId),
  };
}

export type SyncStatus = "live" | "reconnecting" | "offline" | "paused";

interface Options {
  /** Off while the page is rendered for a test or the person has no inbox access. */
  enabled: boolean;
  /** The server time the first render was read at. */
  initialServerTime: string | null;
  openId: string | null;
  getKnown: () => ReadonlyMap<string, number>;
  onCounts: (counts: ViewCounts) => void;
  onRefreshList: () => Promise<void>;
  onRefreshThread: () => Promise<void>;
}

export function useInboxSync(o: Options): { status: SyncStatus; lastSyncAt: number | null; poke: () => void } {
  const [status, setStatus] = React.useState<SyncStatus>("live");
  const [lastSyncAt, setLastSyncAt] = React.useState<number | null>(null);
  // The latest options, read by the poller each time it runs (so it never needs restarting when a callback changes).
  const latest = React.useRef(o);
  // Set by the effect below: look again now.
  const pokeRef = React.useRef<() => void>(() => undefined);
  React.useEffect(() => {
    latest.current = o;
  });

  React.useEffect(() => {
    if (!o.enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let serverTime: string | null = latest.current.initialServerTime;
    let lastFullAt = Date.now();
    let inFlight = false;
    let seq = 0;
    let applied = 0;

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void run(), ms);
    };

    async function run() {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setStatus("paused");
        return; // resumes on the visibilitychange below
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setStatus("offline");
        schedule(nextPollDelay(failures + 1));
        return;
      }
      if (inFlight) return;
      inFlight = true;
      const mine = ++seq;
      try {
        const cur = latest.current;
        const since = sinceFor(serverTime);
        const res = await fetch(`/api/inbox/sync?${new URLSearchParams({ ...(since ? { since } : {}), counts: "1" })}`, { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as SyncResponse;
        // Answers can finish out of order (a slow one overtaken by a newer one): only a newer answer than the last applied one counts.
        if (stopped || mine < applied) return;
        applied = mine;
        serverTime = body.serverTime;
        failures = 0;
        setStatus("live");
        setLastSyncAt(Date.now());
        if (body.counts) cur.onCounts(body.counts);
        const plan = planRefresh(body, cur.getKnown(), cur.openId, lastFullAt, Date.now());
        if (plan.refreshList) {
          lastFullAt = Date.now();
          await cur.onRefreshList();
        }
        if (plan.refreshThread) await cur.onRefreshThread();
      } catch {
        failures += 1;
        if (!stopped) setStatus("reconnecting");
      } finally {
        inFlight = false;
        schedule(nextPollDelay(failures));
      }
    }

    const wake = () => {
      if (document.visibilityState === "visible") {
        failures = 0;
        void run();
      }
    };
    pokeRef.current = () => {
      failures = 0;
      void run();
      try {
        const bc = new BroadcastChannel("iaq-inbox");
        bc.postMessage("changed");
        bc.close();
      } catch {
        /* no BroadcastChannel: the other tabs catch up on their next poll */
      }
    };
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("iaq-inbox");
      channel.onmessage = () => void run();
    } catch {
      /* ignore */
    }
    schedule(POLL_MS);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      channel?.close();
      pokeRef.current = () => undefined;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    };
  }, [o.enabled]);

  const poke = React.useCallback(() => pokeRef.current(), []);
  return { status, lastSyncAt, poke };
}
