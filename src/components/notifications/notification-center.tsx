"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Bell, CheckCheck, ChevronRight, RefreshCw, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { EmptyState } from "@/components/ui/primitives";
import { NotificationRow } from "@/components/notifications/notification-row";
import { fetchNotificationsAction, markNotificationsReadAction } from "@/app/actions/shell";
import type { NotificationListItem } from "@/lib/notification-presentation";
import { cn, currentTime } from "@/lib/utils";

const BELL_PAGE_SIZE = 12;

/**
 * The notification bell and its centre, shared by the client portal, the agency team workspace and
 * the Super Admin portal. The server resolves the person; this component only ever asks for "my
 * notifications". Role scope is therefore enforced by the same RLS-backed action in every shell.
 */
export function NotificationCenter({
  initialUnread,
  initialNow,
  timeZone,
  viewAllHref,
  settingsHref,
  className,
}: {
  initialUnread: number;
  initialNow: number;
  timeZone: string;
  viewAllHref: string;
  /** Present only where the viewer has a notification-preferences screen. */
  settingsHref?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationListItem[] | null>(null);
  const [unread, setUnread] = React.useState(initialUnread);
  const [filter, setFilter] = React.useState<"all" | "unread">("all");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [markingAll, setMarkingAll] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(initialNow);

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const res = await fetchNotificationsAction({ limit: BELL_PAGE_SIZE });
      if (!res.ok) {
        if (!silent) setError(res.error);
        return;
      }
      setItems(res.items);
      setUnread(res.unread);
      setError(null);
    } catch {
      if (!silent) setError("Couldn't load notifications. Check your connection and try again.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Keep the badge honest even while the dropdown is closed, without flashing a skeleton.
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  React.useEffect(() => {
    if (!open) return;
    const clock = setInterval(() => setNow(currentTime()), 30_000);
    const refresh = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 60_000);
    return () => {
      clearInterval(clock);
      clearInterval(refresh);
    };
  }, [open, load]);

  const markAll = async () => {
    if (!unread || markingAll) return;
    const previousItems = items;
    const previousUnread = unread;
    setMarkingAll(true);
    setItems((current) => current?.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })) ?? current);
    setUnread(0);
    try {
      const res = await markNotificationsReadAction("all");
      if (!res.ok) throw new Error(res.error);
      toast.success("All notifications marked as read.");
      router.refresh();
    } catch {
      setItems(previousItems);
      setUnread(previousUnread);
      toast.error("Couldn't mark notifications as read. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  };

  const openItem = async (item: NotificationListItem) => {
    if (!item.read_at && !busyId) {
      const previousItems = items;
      const previousUnread = unread;
      setBusyId(item.id);
      setItems((current) => current?.map((entry) => (entry.id === item.id ? { ...entry, read_at: new Date().toISOString() } : entry)) ?? current);
      setUnread((value) => Math.max(0, value - 1));
      try {
        const res = await markNotificationsReadAction([item.id]);
        if (!res.ok) throw new Error(res.error);
      } catch {
        setItems(previousItems);
        setUnread(previousUnread);
        setBusyId(null);
        toast.error("Couldn't open that notification. Please try again.");
        return;
      }
      setBusyId(null);
    }
    setOpen(false);
    if (item.link) router.push(item.link);
    else router.refresh();
  };

  const visible = items === null ? [] : filter === "unread" ? items.filter((item) => !item.read_at) : items;
  const unreadInFeed = items?.filter((item) => !item.read_at).length ?? 0;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setFilter("all");
            setNow(currentTime());
            void load();
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-aqi-target="notifications.bell"
            className={cn(
              "relative flex size-10 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              open && "bg-surface-2 text-ink",
              className,
            )}
            aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
            aria-haspopup="dialog"
          >
            <Bell className="size-[19px]" aria-hidden />
            <AnimatePresence>
              {unread > 0 && (
                <motion.span
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 520, damping: 28 }}
                  className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#b42328] px-1 text-[10px] font-bold tabular-nums text-white ring-2 ring-bg"
                >
                  {unread > 9 ? "9+" : unread}
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={10}
          aria-label="Notifications"
          className="w-[min(420px,calc(100vw-24px))] overflow-hidden p-0"
        >
          <header className="border-b border-line px-4 pb-3.5 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/15">
                  <Bell className="size-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold tracking-tight text-ink">Notifications</p>
                  <p className="mt-0.5 text-[11.5px] text-muted">
                    {unread > 0 ? `${unread} unread update${unread === 1 ? "" : "s"}` : "You're all caught up"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void markAll()}
                disabled={!unread || markingAll}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-primary transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:text-faint"
                aria-label="Mark all notifications as read"
              >
                <CheckCheck className={cn("size-3.5", markingAll && "animate-pulse")} aria-hidden />
                <span className="hidden min-[380px]:inline">Mark all read</span>
              </button>
            </div>
          </header>

          <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2/35 px-3 py-2">
            <div role="group" aria-label="Filter notifications" className="flex items-center gap-1">
              {(
                [
                  { value: "all" as const, label: "All", count: items?.length ?? null },
                  { value: "unread" as const, label: "Unread", count: unreadInFeed || null },
                ]
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium transition-colors",
                    filter === option.value ? "bg-ink text-surface shadow-soft" : "text-ink-2 hover:bg-surface-3/70",
                  )}
                >
                  {option.label}
                  {option.count !== null && (
                    <span className={cn("text-[10.5px] tabular-nums", filter === option.value ? "text-surface/75" : "text-faint")}>{option.count}</span>
                  )}
                </button>
              ))}
            </div>
            {settingsHref && (
              <Link
                href={settingsHref}
                onClick={() => setOpen(false)}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-ink"
                aria-label="Notification settings"
              >
                <Settings2 className="size-3.5" aria-hidden />
              </Link>
            )}
          </div>

          <div className="scrollbar-thin max-h-[min(440px,calc(100dvh-250px))] overflow-y-auto overscroll-contain">
            <p className="sr-only" aria-live="polite">
              {open ? `${unread} unread notifications` : ""}
            </p>
            {items === null && loading ? (
              <div className="space-y-2 p-3" aria-label="Loading notifications" role="status">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex items-start gap-3 rounded-xl border border-line/60 p-3">
                    <div className="skeleton size-8 shrink-0 rounded-lg" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="skeleton h-3 w-2/3 rounded" />
                      <div className="skeleton h-2.5 w-full rounded" />
                      <div className="skeleton h-2.5 w-1/3 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : error && !items ? (
              <div className="px-4 py-8 text-center" role="alert">
                <span className="mx-auto grid size-10 place-items-center rounded-xl bg-danger-soft text-danger-ink">
                  <AlertTriangle className="size-4" aria-hidden />
                </span>
                <p className="mt-3 text-[13px] font-semibold text-ink">Couldn&apos;t load notifications</p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">{error}</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
                >
                  <RefreshCw className="size-3.5" aria-hidden /> Try again
                </button>
              </div>
            ) : visible.length === 0 ? (
              <EmptyState
                compact
                icon={<Bell className="size-5" />}
                title={filter === "unread" ? "No unread updates" : "You're all caught up"}
                description={
                  filter === "unread"
                    ? "Everything in your latest updates has been read."
                    : "New updates from your AI team, support and reviews will appear here."
                }
              />
            ) : (
              <div>
                {error && (
                  <div className="flex items-center gap-2 border-b border-line bg-warning-soft/60 px-3 py-2 text-[11.5px] text-warning-ink" role="status">
                    <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">Showing saved notifications. A refresh failed.</span>
                    <button type="button" onClick={() => void load()} className="font-semibold hover:underline">Retry</button>
                  </div>
                )}
                {visible.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    timeZone={timeZone}
                    now={now}
                    unread={!item.read_at}
                    busy={busyId === item.id}
                    onOpen={() => void openItem(item)}
                    className="border-b border-line/70 last:border-b-0"
                  />
                ))}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-2 border-t border-line bg-surface-2/40 px-3 py-2">
            <Link
              href={viewAllHref}
              onClick={() => setOpen(false)}
              className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-primary hover:underline"
            >
              View all notifications <ChevronRight className="size-3.5" aria-hidden />
            </Link>
            <span className="text-[10.5px] text-faint">Updates refresh automatically</span>
          </footer>
        </PopoverContent>
      </Popover>
    </>
  );
}
