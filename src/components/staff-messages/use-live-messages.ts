"use client";

import * as React from "react";
import {
  accessLostFor, backoffMs, frameReason, frameRevision, pollDelayMs, snapshotQueryString, SNAPSHOT_URL, STREAM_URL,
  type AccessLostReason, type Connection, type SnapshotQuery,
} from "@/lib/staff-messages/live";
import { isUnchanged, type AccessError, type SnapshotPayload, type SnapshotResponse } from "@/lib/staff-messages/snapshot";
import { applyOlder, applySnapshot, initialState, type PageState } from "@/lib/staff-messages/state";

// Keeps an open Messages page in step with the database. A server-sent stream says "the number changed" within seconds; a poll every 15 to 20 seconds while the tab is visible
// (and once when it comes back into view, regains focus, or the network returns) is the baseline that works where a stream cannot. Either one only decides WHEN to ask; the
// answer is always the snapshot endpoint's, which applies the person's own access. Nothing here decides what a message is. Hosted Supabase Realtime is not used.

export interface LiveOptions {
  initial: SnapshotPayload;
  conversationId: string | null;
  /** Keep the newest page ending a little after this message (reading around a search hit), instead of at the newest messages. */
  aroundSeq: number | null;
  threadRootId: string | null;
  /** Off for design previews and tests: no stream, no polling. */
  enabled?: boolean;
}

export function useLiveMessages({ initial, conversationId, aroundSeq, threadRootId, enabled = true }: LiveOptions) {
  const [state, setState] = React.useState<PageState>(() => initialState(initial));
  const stateRef = React.useRef(state);
  const [streamState, setStreamState] = React.useState<Connection>(enabled ? "reconnecting" : "polling");
  const [error, setError] = React.useState<string | null>(null);
  const [offline, setOffline] = React.useState(false);
  const [accessLost, setAccessLost] = React.useState<AccessLostReason | null>(null);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const inflight = React.useRef<Promise<void> | null>(null);
  const threadRef = React.useRef(threadRootId);

  /** Changes the page's state from anything that is not rendering (an answer, a click). The ref always holds what the page shows. */
  const commit = React.useCallback((change: (previous: PageState) => PageState) => {
    const next = change(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const fetchSnapshot = React.useCallback(async (q: SnapshotQuery): Promise<{ ok: true; body: SnapshotResponse } | { ok: false }> => {
    try {
      const res = await fetch(`${SNAPSHOT_URL}?${snapshotQueryString(q)}`, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as AccessError | null;
        const lost = accessLostFor(res.status, body?.reason);
        if (lost) setAccessLost(lost);
        else setError(body?.error ?? "We couldn't refresh this page.");
        return { ok: false };
      }
      setError(null);
      setOffline(false);
      return { ok: true, body: (await res.json()) as SnapshotResponse };
    } catch {
      setOffline(true);
      return { ok: false };
    }
  }, []);

  /**
   * Asks for what changed. `force` ignores the revision the page holds (used when the page needs something it was not asking for before, such as a thread that was just
   * opened); `replace` makes the answer's newest page replace the list instead of joining it (used when the window moves back to the newest messages).
   */
  const refresh = React.useCallback(
    async (opts: { force?: boolean; replace?: boolean } = {}) => {
      if (!enabled) return;
      if (inflight.current) {
        await inflight.current;
        if (!opts.force) return;
      }
      const run = (async () => {
        try {
          const result = await fetchSnapshot({ since: opts.force ? null : stateRef.current.revision, conversationId, threadRootId: threadRef.current, beforeSeq: null, aroundSeq, badgeOnly: false });
          if (!result.ok || isUnchanged(result.body)) return;
          const body = result.body;
          commit((previous) => applySnapshot(previous, body, opts.replace ? "replace" : "live"));
        } finally {
          inflight.current = null;
        }
      })();
      inflight.current = run;
      return run;
    },
    [enabled, fetchSnapshot, conversationId, aroundSeq, commit],
  );

  const loadOlder = React.useCallback(async () => {
    const first = stateRef.current.messages[0];
    if (!first || !conversationId || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await fetchSnapshot({ since: null, conversationId, threadRootId: null, beforeSeq: first.seq, aroundSeq: null, badgeOnly: false });
      if (result.ok && !isUnchanged(result.body) && result.body.older) {
        const older = result.body.older;
        commit((previous) => applyOlder(previous, older));
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, fetchSnapshot, commit, loadingOlder]);

  // A thread opened or closed: the next answer must carry it, whatever revision the page holds.
  React.useEffect(() => {
    threadRef.current = threadRootId;
    if (threadRootId) void refresh({ force: true });
  }, [threadRootId, refresh]);

  // The stream: says when the number changed. If the browser gives it up, back off and reopen; polling covers the gap.
  React.useEffect(() => {
    if (!enabled || accessLost || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let retry: number | undefined;
    let attempt = 0;
    let stopped = false;
    const open = () => {
      if (stopped) return;
      source = new EventSource(STREAM_URL);
      source.addEventListener("open", () => {
        attempt = 0;
        setStreamState("live");
      });
      const onRevision = (event: MessageEvent) => {
        const revision = frameRevision(event.data);
        if (revision !== null && revision > stateRef.current.revision) void refresh();
      };
      source.addEventListener("ready", onRevision as EventListener);
      source.addEventListener("revision", onRevision as EventListener);
      source.addEventListener("access_changed", ((event: MessageEvent) => {
        stopped = true;
        source?.close();
        setStreamState("polling");
        setAccessLost(frameReason(event.data));
      }) as EventListener);
      source.addEventListener("error", () => {
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          setStreamState("polling");
          attempt += 1;
          retry = window.setTimeout(open, backoffMs(attempt));
        } else setStreamState("reconnecting");
      });
    };
    open();
    return () => {
      stopped = true;
      source?.close();
      window.clearTimeout(retry);
    };
  }, [enabled, accessLost, refresh]);

  // The poll: every 15 to 20 seconds while the tab is visible (slower with a stream open), and at once when the person comes back to it.
  React.useEffect(() => {
    if (!enabled || accessLost) return;
    let timer: number | undefined;
    let cancelled = false;
    const schedule = () => {
      window.clearTimeout(timer);
      const delay = pollDelayMs({ connection: streamState, visible: document.visibilityState === "visible", jitter: Math.random() });
      if (delay === null || cancelled) return;
      timer = window.setTimeout(async () => {
        // A tab that went into the background while waiting asks nothing; it asks as soon as it is shown again (wake, below).
        if (document.visibilityState !== "visible") return;
        await refresh();
        schedule();
      }, delay);
    };
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [enabled, accessLost, streamState, refresh]);

  const connection: Connection = streamState;
  return { state, commit, connection, error, offline, accessLost, refresh, loadOlder, loadingOlder };
}
