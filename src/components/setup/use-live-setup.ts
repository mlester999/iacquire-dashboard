"use client";

import * as React from "react";
import { createBrowserRealtimeClient, fetchRealtimeGrant, startSetupRealtime, type RealtimeState } from "@/components/setup/setup-realtime";

type Connection = "live" | "reconnecting" | "polling";

interface Versioned {
  scope?: string;
  revision: number;
  tasks: Array<{ id: string; status: string; updatedAt: string }>;
}

/**
 * Keeps a setup screen in step with the database.
 *
 * - With Supabase configured, a private, permission-checked Realtime topic (`setup:<organization>`)
 *   signals each committed revision. Only a revision number travels over it; the data itself is
 *   always refetched from the authorized server snapshot.
 * - An event stream also tells the browser when the revision changes, so edits appear within
 *   moments even where Realtime is unavailable (local demo, hosted outage, blocked WebSockets).
 * - If both drop (or are refused) the hook falls back to polling, and it also refetches when
 *   the tab becomes visible again or the network returns. A dead connection therefore can never
 *   leave the screen stale for long.
 * - The server revision is the only source of truth; nothing here decides what a status is.
 */
export function useLiveSetup<T extends Versioned>({
  initial,
  snapshotUrl,
  streamUrl,
  onChange,
  enabled = true,
}: {
  initial: T;
  snapshotUrl: string;
  streamUrl: string;
  onChange?: (previous: T, next: T) => void;
  /** Off for static design previews: no stream, no polling. */
  enabled?: boolean;
}) {
  const [data, setData] = React.useState<T>(initial);
  const [streamState, setConnection] = React.useState<Connection>(enabled ? "reconnecting" : "polling");
  const [realtime, setRealtime] = React.useState<RealtimeState>("connecting");
  const connection: Connection = realtime === "subscribed" ? "live" : streamState;
  const [error, setError] = React.useState<string | null>(null);
  const [accessLost, setAccessLost] = React.useState(false);
  const [syncedAt, setSyncedAt] = React.useState(() => Date.now());
  const [changed, setChanged] = React.useState<Set<string>>(() => new Set());
  const dataRef = React.useRef(data);
  const inflight = React.useRef<Promise<void> | null>(null);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });

  const refresh = React.useCallback(
    async (force = false) => {
      if (inflight.current) {
        await inflight.current;
        if (!force) return;
      }
      const run = (async () => {
        try {
          const rev = dataRef.current.revision;
          const scope = dataRef.current.scope ?? "";
          const res = await fetch(force ? snapshotUrl : `${snapshotUrl}?since=${rev}&scope=${encodeURIComponent(scope)}`, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            if (res.status === 401 || res.status === 403) setAccessLost(true);
            setError(res.status === 401 ? "Your session has ended. Please sign in again." : (body?.error ?? "We couldn't refresh this page."));
            return;
          }
          const json = (await res.json()) as T | { unchanged: true; revision: number };
          setError(null);
          setAccessLost(false);
          setSyncedAt(Date.now());
          if ("unchanged" in json) return;
          const prev = dataRef.current;
          if (json.scope === prev.scope && json.revision < prev.revision) return;
          const before = new Map(prev.tasks.map((t) => [t.id, `${t.status}|${t.updatedAt}`]));
          const diff = new Set(json.tasks.filter((t) => before.get(t.id) !== `${t.status}|${t.updatedAt}`).map((t) => t.id));
          dataRef.current = json;
          setData(json);
          if (diff.size) {
            setChanged(diff);
            window.setTimeout(() => setChanged(new Set()), 3200);
          }
          onChangeRef.current?.(prev, json);
        } catch {
          setError("You appear to be offline. We'll keep trying.");
        } finally {
          inflight.current = null;
        }
      })();
      inflight.current = run;
      return run;
    },
    [snapshotUrl],
  );

  // Event stream with backoff reconnects when the browser gives up on it.
  React.useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: number | undefined;
    let attempt = 0;
    let stopped = false;
    const open = () => {
      if (stopped) return;
      es = new EventSource(streamUrl);
      es.addEventListener("open", () => {
        attempt = 0;
        setConnection("live");
      });
      const onRevision = (e: MessageEvent) => {
        try {
          const { revision } = JSON.parse(e.data) as { revision: number };
          if (revision > dataRef.current.revision) void refresh();
        } catch {
          /* ignore malformed frames */
        }
      };
      es.addEventListener("ready", onRevision as EventListener);
      es.addEventListener("revision", onRevision as EventListener);
      es.addEventListener("access_changed", () => {
        es?.close();
        stopped = true;
        setConnection("polling");
        setAccessLost(true);
        setError("Your access to this setup has changed. Refresh or sign in again.");
        void refresh(true);
      });
      es.addEventListener("error", () => {
        setConnection(es?.readyState === EventSource.CLOSED ? "polling" : "reconnecting");
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          attempt += 1;
          retry = window.setTimeout(open, Math.min(30000, 2000 * 2 ** attempt));
        }
      });
    };
    open();
    return () => {
      stopped = true;
      es?.close();
      window.clearTimeout(retry);
    };
  }, [streamUrl, refresh, enabled]);

  // Scoped Supabase Realtime: a second, independent signal source. Skipped when Supabase is not
  // configured for the browser or the screen has no organization scope.
  const scope = initial.scope;
  React.useEffect(() => {
    if (!enabled || !scope || !process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    return startSetupRealtime({
      orgId: scope,
      fetchGrant: fetchRealtimeGrant,
      createClient: createBrowserRealtimeClient,
      onRevision: (revision) => {
        if (revision > dataRef.current.revision) void refresh();
      },
      onState: setRealtime,
    });
  }, [enabled, scope, refresh]);

  // Safety net: poll faster while the stream is down, slowly while it is up.
  React.useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => void refresh(), connection === "live" ? 60000 : 15000);
    return () => window.clearInterval(id);
  }, [connection, refresh, enabled]);

  React.useEffect(() => {
    if (!enabled) return;
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    };
  }, [refresh, enabled]);

  return { data, connection, error, accessLost, syncedAt, changed, refresh: () => refresh(true) };
}
