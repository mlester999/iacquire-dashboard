"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { NotificationListItem } from "@/lib/notification-presentation";
import { cn } from "@/lib/utils";
import { NotificationCategoryChip, NotificationSeverityMark, NotificationTimestamp, NotificationTypeIcon } from "@/components/notifications/notification-visuals";

/**
 * One notification, shared by the bell's centre and the full activity inbox.
 *
 * `compact` is the popover row; `full` adds the category surface, severity mark and a larger icon for
 * the page. Both use the same saved kind, severity, link and timestamp so the two views can never
 * describe the same event differently.
 */
export function NotificationRow({
  item,
  timeZone,
  now,
  unread,
  onOpen,
  variant = "compact",
  busy = false,
  className,
}: {
  item: NotificationListItem;
  timeZone: string;
  now: number;
  unread: boolean;
  onOpen: () => void;
  variant?: "compact" | "full";
  busy?: boolean;
  className?: string;
}) {
  const full = variant === "full";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-busy={busy || undefined}
      className={cn(
        "group relative flex w-full items-start gap-3 text-left transition-colors duration-150",
        "hover:bg-surface-2/70 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
        full ? "px-4 py-4 sm:px-5" : "px-3.5 py-3",
        unread ? "bg-primary-soft/35 hover:bg-primary-soft/50" : "bg-transparent",
        className,
      )}
    >
      {unread && <span aria-hidden className="absolute inset-y-2.5 left-0 w-[2.5px] rounded-r-full bg-primary" />}
      <NotificationTypeIcon kind={item.kind} severity={item.severity} size={full ? "md" : "sm"} className={full ? undefined : "mt-0.5"} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-2">
          <span className={cn("min-w-0 flex-1 leading-snug text-ink", full ? "text-[14px] font-semibold" : "text-[13px] font-semibold")}>
            {unread && <span className="sr-only">Unread: </span>}
            {item.title}
          </span>
          <NotificationSeverityMark severity={item.severity} />
          {unread && <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary ring-2 ring-primary/15" />}
        </span>
        {item.body && (
          <span className={cn("mt-0.5 line-clamp-2 block leading-relaxed text-muted", full ? "text-[13px]" : "text-[12px]")}>
            {item.body}
          </span>
        )}
        <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5", full ? "mt-2.5" : "mt-2")}>
          <NotificationCategoryChip kind={item.kind} />
          <NotificationTimestamp value={item.created_at} timeZone={timeZone} now={now} />
          {item.link && (
            <span className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-medium text-faint transition-colors group-hover:text-primary">
              Open <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
