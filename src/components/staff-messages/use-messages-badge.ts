"use client";

import * as React from "react";
import { accessLostFor, pollDelayMs, snapshotQueryString, SNAPSHOT_URL } from "@/lib/staff-messages/live";
import { UNREAD_EVENT, type MessagesNavState } from "@/lib/staff-messages/nav";
import type { AccessError, SnapshotResponse } from "@/lib/staff-messages/snapshot";

/**
 * The unread total for the badge in the agency navigation. It starts from what the server worked out when the page was built, asks the snapshot endpoint for just the number
 * every 15 to 20 seconds while the tab is visible (and when it comes back into view), and follows the Messages page at once when that page is open (the page says what it
 * knows instead of the badge asking again). A refusal hides the entry: the person's access changed. Nothing is asked for a person who has no Messages to show.
 */
export function useMessagesBadge(initial: MessagesNavState | undefined, opts: { paused?: boolean } = {}): MessagesNavState {
  const [nav, setNav] = React.useState<MessagesNavState>(initial ?? { state: "denied", unread: 0 });
  const revision = React.useRef<number | null>(null);
  const active = nav.state === "on";

  React.useEffect(() => {
    if (!active) return;
    const onUnread = (event: Event) => {
      const unread = (event as CustomEvent<{ unread?: unknown }>).detail?.unread;
      if (typeof unread === "number" && Number.isFinite(unread)) setNav((current) => (current.state === "on" && current.unread !== unread ? { ...current, unread } : current));
    };
    window.addEventListener(UNREAD_EVENT, onUnread);
    return () => window.removeEventListener(UNREAD_EVENT, onUnread);
  }, [active]);

  React.useEffect(() => {
    if (!active || opts.paused) return;
    let timer: number | undefined;
    let cancelled = false;
    const ask = async () => {
      try {
        const res = await fetch(`${SNAPSHOT_URL}?${snapshotQueryString({ since: revision.current, conversationId: null, threadRootId: null, beforeSeq: null, aroundSeq: null, badgeOnly: true })}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as AccessError | null;
          const lost = accessLostFor(res.status, body?.reason);
          if (lost && !cancelled) setNav({ state: lost === "not_enabled" ? "off" : "denied", unread: 0 });
          return;
        }
        const body = (await res.json()) as SnapshotResponse;
        revision.current = body.revision;
        if (!cancelled && "unread" in body && typeof body.unread === "number") {
          const unread = body.unread;
          setNav((current) => (current.state === "on" && current.unread !== unread ? { ...current, unread } : current));
        }
      } catch {
        // Offline or a hiccup: the badge keeps what it had and asks again at the next turn.
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      const delay = pollDelayMs({ connection: "polling", visible: document.visibilityState === "visible", jitter: Math.random() });
      if (delay === null || cancelled) return;
      timer = window.setTimeout(async () => {
        if (document.visibilityState !== "visible") return;
        await ask();
        schedule();
      }, delay);
    };
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      void ask();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [active, opts.paused]);

  return nav;
}
