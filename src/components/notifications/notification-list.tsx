"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Activity, AlertTriangle, ArrowUpRight, Bell, BookOpen, Bot, CalendarClock, CheckCheck, CheckCircle2, ClipboardCheck, CreditCard, FolderKanban, Gauge, Globe, Info, LifeBuoy, MessageSquareWarning, Plug, Radar, Search, ShieldCheck, Siren, Workflow, Wrench, X, XCircle, UserRound, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Input } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { FilterTabs, IconTile, type PanelTone } from "@/components/settings/panel";
import { markNotificationsReadAction } from "@/app/actions/shell";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";

interface Item {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

const SEVERITY: Record<string, { tone: PanelTone; icon: React.ReactNode; label: string | null }> = {
  info: { tone: "primary", icon: <Info />, label: null },
  success: { tone: "success", icon: <CheckCircle2 />, label: null },
  warning: { tone: "warning", icon: <AlertTriangle />, label: "Needs attention" },
  critical: { tone: "danger", icon: <XCircle />, label: "Critical" },
};

/** The first word of a notification kind says which part of the product it came from. */
const KIND_ICON: Record<string, React.ReactNode> = {
  booking: <CalendarClock />,
  setup: <ClipboardCheck />,
  message: <MessageSquareWarning />,
  agent: <Bot />,
  lead: <Radar />,
  escalation: <Siren />,
  workflow: <Workflow />,
  knowledge: <BookOpen />,
  support: <LifeBuoy />,
  integration: <Plug />,
  approval: <ShieldCheck />,
  project: <FolderKanban />,
  maintenance: <Wrench />,
  billing: <CreditCard />,
  website: <Globe />,
  domain: <Globe />,
  incident: <Activity />,
  retention: <UserRound />,
  account: <UserRound />,
  fair: <Gauge />,
  usage: <Gauge />,
  system: <Settings2 />,
};

type Filter = "all" | "unread" | "attention";

const needsAttention = (n: Item) => n.severity === "warning" || n.severity === "critical";

function dayKey(value: string | number, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  } catch {
    return new Date(value).toISOString().slice(0, 10);
  }
}

/** Today, Yesterday, the last week, then one group per month, so a long inbox reads as a timeline. */
function groupLabel(iso: string, timeZone: string, now: number) {
  const key = dayKey(iso, timeZone);
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(now - 86_400_000, timeZone)) return "Yesterday";
  if (new Date(iso).getTime() > now - 7 * 86_400_000) return "Last 7 days";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", year: "numeric" }).format(new Date(iso));
  } catch {
    return "Earlier";
  }
}

export function NotificationList({ items, timeZone }: { items: Item[]; timeZone: string }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [pending, start] = React.useTransition();
  const [now] = React.useState(() => Date.now());
  const unread = items.filter((i) => !i.read_at).length;
  const attention = items.filter(needsAttention).length;
  const needle = query.trim().toLowerCase();
  const list = items.filter((i) => (filter === "all" || (filter === "unread" && !i.read_at) || (filter === "attention" && needsAttention(i))) && `${i.title} ${i.body ?? ""} ${i.kind.replaceAll("_", " ")}`.toLowerCase().includes(needle));
  const groups: Array<{ label: string; items: Item[] }> = [];
  for (const n of list) {
    const label = groupLabel(n.created_at, timeZone, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line bg-surface-2/40 p-3 sm:p-4">
        <FilterTabs
          label="Filter updates"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: items.length },
            { value: "unread", label: "Unread", count: unread },
            { value: "attention", label: "Needs attention", count: attention },
          ]}
        />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input aria-label="Search notifications" placeholder="Find an update…" className="rounded-full pl-10 pr-9" value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-ink">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            disabled={unread === 0}
            onClick={() =>
              start(async () => {
                await markNotificationsReadAction("all");
                router.refresh();
              })
            }
          >
            <CheckCheck className="size-4" aria-hidden /> Mark all read
          </Button>
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState
          icon={<Bell className="size-5" />}
          title={query ? "No matching updates" : filter === "unread" ? "You’re all caught up" : filter === "attention" ? "Nothing needs attention" : "Your updates will appear here"}
          description={query ? "Try another word or clear the search." : "Setup milestones, support replies and decisions stay together in this activity inbox."}
          action={(query || filter !== "all") && <Button size="sm" variant="soft" onClick={() => { setQuery(""); setFilter("all"); }}>Show all updates</Button>}
          compact
        />
      ) : (
        <div>
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label} className="[&:not(:first-child)>h3]:border-t">
              <h3 className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted sm:px-5">
                {g.label}
                <span className="rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-semibold tabular-nums tracking-normal text-ink-2 ring-1 ring-inset ring-line">{g.items.length}</span>
              </h3>
              <ul className="divide-y divide-line">
                {g.items.map((n) => (
                  <li key={n.id}>
                    <NotificationRow
                      n={n}
                      timeZone={timeZone}
                      now={now}
                      onOpen={async () => {
                        if (!n.read_at) await markNotificationsReadAction([n.id]);
                        if (n.link) router.push(n.link);
                        else router.refresh();
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function NotificationRow({ n, timeZone, now, onOpen }: { n: Item; timeZone: string; now: number; onOpen: () => void }) {
  const sev = SEVERITY[n.severity] ?? SEVERITY.info;
  const isUnread = !n.read_at;
  const kindIcon = KIND_ICON[n.kind.split("_")[0]] ?? <Bell />;
  return (
    <button type="button" onClick={onOpen} className={cn("management-row group relative flex w-full items-start gap-3.5 px-4 py-3.5 text-left sm:px-5", isUnread && "bg-primary-soft/30")}>
      {isUnread && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-primary" />}
      <IconTile icon={sev.icon} tone={sev.tone} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-3">
          <span className={cn("block min-w-0 text-[14px] leading-snug text-ink", isUnread ? "font-semibold" : "font-medium")}>
            {isUnread && <span className="sr-only">Unread: </span>}
            {n.title}
          </span>
          <span className="hidden shrink-0 items-center gap-2 pt-0.5 sm:flex">
            <time dateTime={n.created_at} title={formatDateTime(n.created_at, timeZone)} className="whitespace-nowrap text-[12px] tabular-nums text-muted">
              {relativeTime(n.created_at, now)}
            </time>
            {n.link ? <ArrowUpRight className="size-4 text-faint transition group-hover:text-ink" aria-hidden /> : <span className="size-4" aria-hidden />}
          </span>
        </span>
        {n.body && <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-muted">{n.body}</span>}
        <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <InfoChip icon={kindIcon}>{sentenceCase(n.kind)}</InfoChip>
          {sev.label && <StatusPill size="sm" tone={sev.tone}>{sev.label}</StatusPill>}
          <time dateTime={n.created_at} className="ml-auto text-[12px] tabular-nums text-muted sm:hidden">
            {relativeTime(n.created_at, now)}
          </time>
        </span>
      </span>
    </button>
  );
}
