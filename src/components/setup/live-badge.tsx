"use client";

import * as React from "react";
import { Wifi } from "lucide-react";
import { relativeTime } from "@/lib/utils";

/** Honest connection indicator: "Live" only while the event stream is actually open. */
export function LiveBadge({ connection, syncedAt, preview = false }: { connection: "live" | "reconnecting" | "polling"; syncedAt: number; preview?: boolean }) {
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (preview) return;
    const id = window.setInterval(tick, 15000);
    return () => window.clearInterval(id);
  }, [preview]);
  if (preview) return <span className="inline-flex items-center gap-1.5 text-muted">Sample preview</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Checked ${relativeTime(new Date(syncedAt))}`}>
      {connection === "live" ? (
        <>
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          Live updates on
        </>
      ) : (
        <>
          <Wifi className="size-3.5" />
          {connection === "reconnecting" ? "Connecting…" : "Checking for updates every 15 seconds"}
        </>
      )}
    </span>
  );
}
