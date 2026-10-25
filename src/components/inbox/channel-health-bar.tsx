"use client";

import * as React from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck, CircleDashed, CircleOff, Radio, WifiOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { CHANNEL_STATE_LABELS, type ChannelState } from "@/lib/inbox";
import { cn, relativeTime } from "@/lib/utils";
import type { ChannelHealth } from "@/server/messaging/channel-health";
import type { SyncStatus } from "@/components/inbox/use-inbox-sync";

const STATE_STYLE: Record<ChannelState, { icon: React.ComponentType<{ className?: string }>; dot: string; text: string }> = {
  connected: { icon: CircleCheck, dot: "text-success-ink", text: "text-success-ink" },
  needs_attention: { icon: CircleAlert, dot: "text-warning-ink", text: "text-warning-ink" },
  paused: { icon: CircleDashed, dot: "text-muted", text: "text-muted" },
  not_connected: { icon: CircleOff, dot: "text-muted", text: "text-muted" },
  not_available: { icon: CircleOff, dot: "text-faint", text: "text-faint" },
};

/** The one-line answer for the header: how many channels can carry messages right now, and whether any needs a look. */
export function summarizeChannels(channels: ChannelHealth[]): { label: string; tone: "ok" | "warn" | "none" } {
  const real = channels.filter((c) => c.key === "sms" || c.key === "whatsapp" || c.key === "email");
  const connected = real.filter((c) => c.state === "connected").length;
  const attention = real.filter((c) => c.state === "needs_attention").length;
  if (attention) return { label: `${attention} channel${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention`, tone: "warn" };
  if (!connected) return { label: "No channel connected", tone: "none" };
  return { label: `${connected} of ${real.length} channels connected`, tone: "ok" };
}

export function ChannelHealthBar({ channels, status, lastSyncAt }: { channels: ChannelHealth[]; status: SyncStatus; lastSyncAt: number | null }) {
  const summary = summarizeChannels(channels);
  const sync =
    status === "live" ? { text: "Live", cls: "text-success-ink", icon: Radio }
    : status === "paused" ? { text: "Paused while this tab is hidden", cls: "text-muted", icon: Radio }
    : status === "offline" ? { text: "Offline", cls: "text-warning-ink", icon: WifiOff }
    : { text: "Reconnecting…", cls: "text-warning-ink", icon: WifiOff };
  const SyncIcon = sync.icon;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <button className={cn("inline-flex min-h-9 items-center gap-2 rounded-xl border px-3 text-[12.5px] font-medium transition", summary.tone === "warn" ? "border-warning/40 bg-warning-soft text-warning-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")} aria-haspopup="dialog">
            {summary.tone === "warn" ? <CircleAlert className="size-4" aria-hidden /> : summary.tone === "ok" ? <CircleCheck className="size-4 text-success-ink" aria-hidden /> : <CircleOff className="size-4 text-muted" aria-hidden />}
            {summary.label}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(420px,calc(100vw-32px))] p-0">
          <h2 className="border-b border-line px-4 py-3 text-[13px] font-semibold">Channels</h2>
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {channels.map((c) => {
              const s = STATE_STYLE[c.state];
              const Icon = s.icon;
              return (
                <li key={c.key} className="px-4 py-3 text-[12.5px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium"><Icon className={cn("size-4", s.dot)} aria-hidden />{c.label}{c.provider && <span className="font-normal text-faint">via {c.provider}</span>}</span>
                    <span className={cn("font-medium", s.text)}>{CHANNEL_STATE_LABELS[c.state]}</span>
                  </div>
                  <p className="mt-1 text-muted">{c.detail}</p>
                  {(c.state === "connected" || c.state === "needs_attention" || c.state === "paused") && (
                    <p className="mt-1 text-[12px] text-faint" suppressHydrationWarning>
                      {c.inbound7d} received in 7 days{c.lastInboundAt ? `, last ${relativeTime(c.lastInboundAt)}` : ""}
                      {c.sent24h ? ` · ${c.sent24h} sent today, ${c.failed24h} failed` : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="border-t border-line px-4 py-3 text-[12px] text-muted">
            Connected means a verified sender is switched on and this environment may send. It does not prove a customer can reach you.{" "}
            <Link href="/settings/messaging" className="font-medium text-primary">Channel settings</Link>
          </p>
        </PopoverContent>
      </Popover>
      <p role="status" className={cn("inline-flex items-center gap-1.5 text-[12px]", sync.cls)} suppressHydrationWarning>
        <SyncIcon className="size-3.5" aria-hidden />{sync.text}
        {status === "live" && lastSyncAt ? <span className="text-faint">· updated {relativeTime(new Date(lastSyncAt))}</span> : null}
      </p>
    </div>
  );
}
