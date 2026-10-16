"use client";

import * as React from "react";
import { Wifi } from "lucide-react";
import { StatusPill } from "@/components/ui/status";
import { relativeTime } from "@/lib/utils";

/** Honest connection indicator: "Live" only while the event stream is actually open. */
export function LiveBadge({ connection, syncedAt, preview = false }: { connection: "live" | "reconnecting" | "polling"; syncedAt: number; preview?: boolean }) {
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (preview) return;
    const id = window.setInterval(tick, 15000);
    return () => window.clearInterval(id);
  }, [preview]);
  if (preview) return <StatusPill tone="neutral" size="sm">Sample preview</StatusPill>;
  return (
    <span title={`Checked ${relativeTime(new Date(syncedAt))}`}>
      {connection === "live" ? (
        <StatusPill
          tone="success"
          size="sm"
          icon={
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60 motion-reduce:hidden" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
          }
        >
          Live updates on
        </StatusPill>
      ) : (
        <StatusPill tone="warning" size="sm" icon={<Wifi className="size-3" />}>
          {connection === "reconnecting" ? "Connecting…" : "Checking for updates every 15 seconds"}
        </StatusPill>
      )}
    </span>
  );
}
