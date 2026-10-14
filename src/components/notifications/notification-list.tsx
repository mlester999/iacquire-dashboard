"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bell, CheckCheck, CheckCircle2, Info, Search, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { markNotificationsReadAction } from "@/app/actions/shell";
import { cn, formatDateTime } from "@/lib/utils";

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

const ICON: Record<string, React.ReactNode> = {
  info: <Info className="size-4 text-primary" />,
  success: <CheckCircle2 className="size-4 text-success" />,
  warning: <AlertTriangle className="size-4 text-warning" />,
  critical: <XCircle className="size-4 text-danger" />,
};

export function NotificationList({ items, timeZone }: { items: Item[]; timeZone: string }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<"all" | "unread">("all");
  const [query, setQuery] = React.useState("");
  const [pending, start] = React.useTransition();
  const list = items.filter((i) => (filter === "all" || !i.read_at) && `${i.title} ${i.body ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
        <Segmented id="notif-filter" ariaLabel="Filter" size="sm" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unread", label: `Unread (${items.filter((i) => !i.read_at).length})` }]} />
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
          disabled={!items.some((i) => !i.read_at)}
          onClick={() => start(async () => {
            await markNotificationsReadAction("all");
            router.refresh();
          })}
        >
          <CheckCheck className="size-4" /> Mark all read
        </Button>
      </div>
      <div className="border-b border-line bg-surface-2/40 p-4"><div className="relative max-w-md"><Search className="absolute left-3 top-3 size-4 text-muted" /><Input aria-label="Search notifications" placeholder="Find an update…" className="pl-10" value={query} onChange={(e) => setQuery(e.target.value)} /></div></div>
      {list.length === 0 ? (
        <EmptyState icon={<Bell className="size-5" />} title={query ? "No matching updates" : filter === "unread" ? "You’re all caught up" : "Your updates will appear here"} description={query ? "Try another word or clear the search." : "Setup milestones, support replies and decisions stay together in this activity inbox."} compact />
      ) : (
        <ul className="divide-y divide-line">
          {list.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={async () => {
                  if (!n.read_at) await markNotificationsReadAction([n.id]);
                  if (n.link) router.push(n.link);
                  else router.refresh();
                }}
                className={cn("flex w-full items-start gap-3 px-5 py-3.5 text-left transition hover:bg-surface-2/60", !n.read_at && "bg-primary-soft/30")}
              >
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface">{ICON[n.severity] ?? ICON.info}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium">{n.title}</span>
                  {n.body && <span className="mt-0.5 block text-[13px] text-muted">{n.body}</span>}
                  <span className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-faint"><Badge tone="outline" className="h-5 text-[10px]">{n.kind.replaceAll("_", " ")}</Badge>{formatDateTime(n.created_at, timeZone)}</span>
                </span>
                {!n.read_at && <span className="mt-2 size-2 rounded-full bg-primary" aria-label="Unread" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
