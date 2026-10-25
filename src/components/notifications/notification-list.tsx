"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bell, RefreshCw, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Input, Select } from "@/components/ui/primitives";
import { FilterTabs } from "@/components/settings/panel";
import { NotificationRow } from "@/components/notifications/notification-row";
import { fetchNotificationsAction, markNotificationsReadAction } from "@/app/actions/shell";
import {
  notificationCategory,
  notificationGroupLabel,
  presentNotificationCategories,
  type NotificationListItem,
} from "@/lib/notification-presentation";

type Filter = "all" | "unread" | "attention";

const needsAttention = (item: NotificationListItem) => item.severity === "warning" || item.severity === "critical";

function uniqueById(items: NotificationListItem[]): NotificationListItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * The full notification inbox. It shares the row, category and timestamp vocabulary with the bell,
 * and pages older updates with a keyset cursor supplied by the server action.
 */
export function NotificationList({
  items,
  timeZone,
  initialNow,
  hasMore,
  nextBefore,
  nextBeforeId,
  description,
}: {
  items: NotificationListItem[];
  timeZone: string;
  initialNow: number;
  hasMore: boolean;
  nextBefore: string | null;
  nextBeforeId: string | null;
  description?: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [readIds, setReadIds] = React.useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [markingAll, setMarkingAll] = React.useState(false);
  const [extra, setExtra] = React.useState<NotificationListItem[]>([]);
  const [cursor, setCursor] = React.useState({ hasMore, before: nextBefore, beforeId: nextBeforeId });
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [olderError, setOlderError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(initialNow);

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const all = React.useMemo(() => uniqueById([...items, ...extra]), [items, extra]);
  const isRead = React.useCallback((item: NotificationListItem) => Boolean(item.read_at) || readIds.has(item.id), [readIds]);
  const unread = all.filter((item) => !isRead(item)).length;
  const attention = all.filter(needsAttention).length;
  const categories = React.useMemo(() => presentNotificationCategories(all.map((item) => item.kind)), [all]);
  const needle = query.trim().toLowerCase();

  const list = all.filter((item) => {
    if (filter === "unread" && isRead(item)) return false;
    if (filter === "attention" && !needsAttention(item)) return false;
    if (category !== "all" && notificationCategory(item.kind).key !== category) return false;
    if (!needle) return true;
    const haystack = `${item.title} ${item.body ?? ""} ${item.kind.replaceAll("_", " ")} ${notificationCategory(item.kind).label}`.toLowerCase();
    return haystack.includes(needle);
  });

  const groups: Array<{ label: string; items: NotificationListItem[] }> = [];
  for (const item of list) {
    const label = notificationGroupLabel(item.created_at, timeZone, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  const markAll = async () => {
    if (!unread || markingAll) return;
    const previousReadIds = readIds;
    setMarkingAll(true);
    // Mark the rows already on screen; rows that arrive later keep the read_at value the server gives
    // them, so a notification received after "mark all" is correctly unread.
    setReadIds(new Set(all.map((item) => item.id)));
    try {
      const res = await markNotificationsReadAction("all");
      if (!res.ok) throw new Error(res.error);
      toast.success("All notifications marked as read.");
      router.refresh();
    } catch {
      setReadIds(previousReadIds);
      toast.error("Couldn't mark notifications as read. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  };

  const openItem = async (item: NotificationListItem) => {
    if (!isRead(item) && !busyId) {
      setBusyId(item.id);
      setReadIds((current) => new Set(current).add(item.id));
      try {
        const res = await markNotificationsReadAction([item.id]);
        if (!res.ok) throw new Error(res.error);
      } catch {
        setReadIds((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
        setBusyId(null);
        toast.error("Couldn't open that notification. Please try again.");
        return;
      }
      setBusyId(null);
    }
    if (item.link) router.push(item.link);
    else router.refresh();
  };

  const loadOlder = async () => {
    if (!cursor.hasMore || !cursor.before || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const res = await fetchNotificationsAction({ limit: 30, before: cursor.before, beforeId: cursor.beforeId });
      if (!res.ok) throw new Error(res.error);
      setExtra((current) => uniqueById([...current, ...res.items]));
      setCursor({ hasMore: res.hasMore, before: res.nextBefore, beforeId: res.nextBeforeId });
    } catch {
      setOlderError("Couldn't load older notifications.");
    } finally {
      setLoadingOlder(false);
    }
  };

  const clearFilters = () => {
    setFilter("all");
    setQuery("");
    setCategory("all");
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line bg-surface-2/40 p-3 sm:p-4">
        <FilterTabs
          label="Filter notifications"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: all.length },
            { value: "unread", label: "Unread", count: unread },
            { value: "attention", label: "Needs attention", count: attention },
          ]}
        />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              aria-label="Search notifications"
              placeholder="Find an update…"
              className="rounded-full pl-10 pr-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {categories.length > 1 && (
            <div className="w-full sm:w-44">
              <Select
                aria-label="Filter by notification type"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="h-10 rounded-xl text-[13px]"
              >
                <option value="all">All types</option>
                {categories.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <Button
            size="sm"
            variant="secondary"
            loading={markingAll}
            disabled={unread === 0}
            onClick={() => void markAll()}
            aria-label="Mark all notifications as read"
          >
            Mark all read
          </Button>
        </div>
      </div>

      {description && (
        <p className="border-b border-line bg-surface px-4 py-2.5 text-[12px] leading-relaxed text-muted sm:px-5">{description}</p>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={<Bell className="size-5" />}
          title={query || category !== "all" || filter !== "all" ? "No matching updates" : "Your notifications will appear here"}
          description={
            query || category !== "all" || filter !== "all"
              ? "Try a different filter, or clear your search to see everything."
              : "Configuration reviews, support replies, onboarding milestones and operational alerts stay together in this inbox."
          }
          action={
            (query || category !== "all" || filter !== "all") && (
              <Button size="sm" variant="soft" onClick={clearFilters}>
                Show all notifications
              </Button>
            )
          }
          compact
        />
      ) : (
        <div>
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label} className="[&:not(:first-child)>h3]:border-t">
              <h3 className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-muted sm:px-5">
                {group.label}
                <span className="rounded-md bg-surface px-1.5 py-0.5 text-[12px] font-semibold tabular-nums tracking-normal text-ink-2 ring-1 ring-inset ring-line">
                  {group.items.length}
                </span>
              </h3>
              <ul className="divide-y divide-line">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <NotificationRow
                      item={item}
                      timeZone={timeZone}
                      now={now}
                      unread={!isRead(item)}
                      busy={busyId === item.id}
                      variant="full"
                      onOpen={() => void openItem(item)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <div className="flex flex-col items-center gap-2 border-t border-line bg-surface-2/30 px-4 py-4">
            {olderError && (
              <p className="flex items-center gap-1.5 text-[12px] text-danger-ink" role="alert">
                <AlertTriangle className="size-3.5" aria-hidden /> {olderError}
              </p>
            )}
            {cursor.hasMore ? (
              <Button size="sm" variant="secondary" loading={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? "Loading…" : "Load older notifications"}
              </Button>
            ) : (
              <p className="flex items-center gap-1.5 text-[12px] text-faint">
                <RefreshCw className="size-3" aria-hidden /> You&apos;re at the beginning of your notification history.
              </p>
            )}
            <p className="sr-only" aria-live="polite">
              {list.length} notifications shown, {unread} unread
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
