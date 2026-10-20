"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, Flame, Inbox, LifeBuoy, MessageSquarePlus, Search, SlidersHorizontal, ThumbsUp, TriangleAlert, UserRound } from "lucide-react";
import { Card, EmptyState, Input, Select } from "@/components/ui/primitives";
import { AvatarTile, StatusPill } from "@/components/ui/status";
import { PRIORITIES, REQUEST_TYPES, REQUEST_TYPE_LABELS, categoryLabel, statusLabelForAgency, ALL_CATEGORIES } from "@/lib/support/lifecycle";
import { SLA_STATE_LABELS } from "@/lib/support/sla";
import { cn, relativeTime, sentenceCase } from "@/lib/utils";
import { SLA_TONE, VIEWS, queueHref, type QueueQuery } from "@/components/admin/support/meta";
import type { AgencyListItem, AgencyViewCounts } from "@/server/support/types";
import type { FilterOptions } from "@/server/support/directory";

const TYPE_ICON = { support: LifeBuoy, issue: TriangleAlert, feedback: ThumbsUp } as const;

/**
 * The left pane of the Requests Management Center: saved views with live counts, search, filters, and the list. Everything here is a
 * link to a server-rendered address, so any view can be bookmarked or shared and the back button behaves.
 */
export function QueuePane({ items, total, page, pageSize, counts, query, options, selectedId, className }: {
  items: AgencyListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: AgencyViewCounts;
  query: QueueQuery;
  options: FilterOptions;
  selectedId: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(query.q);
  // The box follows the address when it changes from outside (back button, a saved view), but never fights what is being typed.
  const [pushed, setPushed] = React.useState(query.q);
  const [seen, setSeen] = React.useState(query.q);
  if (query.q !== seen) {
    setSeen(query.q);
    if (query.q !== pushed) setQ(query.q);
  }
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => {
    if (q.trim() === query.q) return;
    const t = setTimeout(() => {
      setPushed(q.trim());
      router.replace(queueHref(query, { q: q.trim(), page: 1, ticket: "" }));
    }, 350);
    return () => clearTimeout(t);
  }, [q, query, router]);

  // Keyboard: "/" focuses search; "j" and "k" move through the list (when you're not typing).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "j" || e.key === "k") {
        const idx = items.findIndex((i) => i.id === selectedId);
        const next = items[e.key === "j" ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1)];
        if (next && next.id !== selectedId) { e.preventDefault(); router.push(queueHref(query, { ticket: next.id }), { scroll: false }); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selectedId, query, router]);

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const filtersActive = Boolean(query.status || query.requestType || query.category || query.priority || query.assignee || query.orgId);

  return (
    <Card className={cn("flex min-h-0 flex-col overflow-hidden", className)}>
      <div className="space-y-3 border-b border-line p-3.5">
        <nav aria-label="Saved views" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {VIEWS.map((v) => {
            const active = query.view === v.value;
            const n = v.count ? counts[v.count] : undefined;
            return (
              <Link key={v.value} href={queueHref(query, { view: v.value, page: 1, ticket: "" })} aria-current={active ? "page" : undefined} title={v.hint}
                className={cn("inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 text-[12.5px] font-medium transition", active ? "bg-ink text-surface shadow-soft" : "text-muted hover:bg-surface-2 hover:text-ink")}>
                {v.label}
                {n !== undefined && n > 0 && <span className={cn("rounded-md px-1.5 py-px text-[11px] font-semibold tabular-nums", active ? "bg-surface/20" : v.value === "overdue" || v.value === "escalated" ? "bg-danger-soft text-danger-ink" : "bg-surface-3 text-ink-2")}>{n}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted sm:top-3" aria-hidden />
          <Input ref={searchRef} aria-label="Search requests" aria-keyshortcuts="/" placeholder="Search subject, client, reference or message…  ( / )" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <details className="group" open={filtersActive || undefined}>
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg text-[12.5px] font-medium text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <SlidersHorizontal className="size-3.5" aria-hidden /> Filters {filtersActive && <span className="rounded-full bg-primary px-1.5 text-[10.5px] text-white">on</span>}
            <span className="ml-auto text-muted group-open:hidden">Show</span><span className="ml-auto hidden text-muted group-open:inline">Hide</span>
          </summary>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <Select aria-label="Filter by type" value={query.requestType} onChange={(e) => router.push(queueHref(query, { requestType: e.target.value, page: 1, ticket: "" }))}>
              <option value="">Every type</option>{REQUEST_TYPES.map((t) => <option key={t} value={t}>{REQUEST_TYPE_LABELS[t].label}</option>)}
            </Select>
            <Select aria-label="Filter by priority" value={query.priority} onChange={(e) => router.push(queueHref(query, { priority: e.target.value, page: 1, ticket: "" }))}>
              <option value="">Every priority</option>{PRIORITIES.map((p) => <option key={p} value={p}>{sentenceCase(p)}</option>)}
            </Select>
            <Select aria-label="Filter by topic" value={query.category} onChange={(e) => router.push(queueHref(query, { category: e.target.value, page: 1, ticket: "" }))}>
              <option value="">Every topic</option>{ALL_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
            </Select>
            <Select aria-label="Filter by assignee" value={query.assignee} onChange={(e) => router.push(queueHref(query, { assignee: e.target.value, page: 1, ticket: "" }))}>
              <option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>
              {options.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select aria-label="Filter by client" value={query.orgId} className="col-span-2" onChange={(e) => router.push(queueHref(query, { orgId: e.target.value, page: 1, ticket: "" }))}>
              <option value="">Every client</option>{options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select aria-label="Sort requests" value={query.sort} className="col-span-2" onChange={(e) => router.push(queueHref(query, { sort: e.target.value as QueueQuery["sort"], page: 1, ticket: "" }))}>
              <option value="priority">Sort: priority, then latest</option><option value="latest">Sort: latest activity</option><option value="oldest">Sort: oldest first</option><option value="due">Sort: response due soonest</option>
            </Select>
            {filtersActive && <Link href={queueHref(query, { status: "", requestType: "", category: "", priority: "", assignee: "", orgId: "", page: 1, ticket: "" })} className="col-span-2 text-center text-[12.5px] font-medium text-primary-ink hover:underline">Clear filters</Link>}
          </div>
        </details>
      </div>

      <div className="flex items-center justify-between border-b border-line bg-surface-2/50 px-4 py-2 text-xs text-muted">
        <span className="font-medium">Requests</span>
        <span aria-live="polite" className="tabular-nums">{total === 0 ? "None" : `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`}</span>
      </div>

      {items.length === 0 ? (
        <EmptyState compact icon={<Inbox className="size-5" />} title={filtersActive || query.q ? "No matches" : "A clear queue"}
          description={filtersActive || query.q ? "Try a different view, search or filter." : "Nothing needs attention in this view. New requests appear here when clients send them."} />
      ) : (
        <ul ref={listRef} className="min-h-0 flex-1 divide-y divide-line overflow-y-auto" aria-label="Requests">
          {items.map((t) => {
            const active = t.id === selectedId;
            const Icon = TYPE_ICON[t.requestType];
            const slaTone = SLA_TONE[t.sla.state];
            return (
              <li key={t.id}>
                <Link href={queueHref(query, { ticket: t.id })} scroll={false} aria-current={active ? "true" : undefined}
                  className={cn("block border-l-2 p-3.5 transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary", active ? "border-primary bg-primary-soft/50" : "border-transparent hover:bg-surface-2")}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="size-3.5 text-muted" aria-label={REQUEST_TYPE_LABELS[t.requestType].label} />
                      <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2 ring-1 ring-inset ring-line">{t.ref}</span>
                      {t.escalated && <Flame className="size-3.5 text-danger" aria-label="Escalated" />}
                      {t.clientWaiting && <span className="inline-flex items-center gap-1 rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-white"><MessageSquarePlus className="size-2.5" aria-hidden /> Reply</span>}
                    </span>
                    <span className="text-[11px] text-muted" suppressHydrationWarning>{relativeTime(t.lastActivityAt)}</span>
                  </div>
                  <div className="flex items-start gap-3">
                    <AvatarTile name={t.orgName} size="sm" className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-ink" title={t.subject}>{t.subject}</p>
                      <p className="mt-0.5 truncate text-xs text-muted" title={t.orgName}>{t.orgName}</p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <StatusPill status={t.priority} size="sm">{sentenceCase(t.priority)}</StatusPill>
                    <StatusPill status={t.status} size="sm">{statusLabelForAgency(t.status)}</StatusPill>
                    {(t.sla.state === "overdue" || t.sla.state === "approaching") && (
                      <StatusPill tone={slaTone} size="sm" icon={t.sla.state === "overdue" ? <AlertTriangle className="size-3" aria-hidden /> : <CalendarClock className="size-3" aria-hidden />}>{SLA_STATE_LABELS[t.sla.state]}</StatusPill>
                    )}
                    <span className="ml-auto inline-flex min-w-0 max-w-full items-center gap-1 text-[11.5px] font-medium text-ink-2" title={t.assignedToName ? `Assigned to ${t.assignedToName}` : "Unassigned"}>
                      {t.assignedToName ? <><AvatarTile name={t.assignedToName} size="sm" className="!size-5 !rounded-full !text-[8px]" /><span className="truncate">{t.assignedToName.split(" ")[0]}</span></> : <><UserRound className="size-3.5 text-muted" aria-hidden />Unassigned</>}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {lastPage > 1 && (
        <nav className="flex items-center justify-between gap-2 border-t border-line p-2.5" aria-label="Pagination">
          <Link href={queueHref(query, { page: Math.max(1, page - 1), ticket: "" })} aria-disabled={page <= 1} tabIndex={page <= 1 ? -1 : undefined} className={cn("inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 text-[12.5px] font-medium hover:bg-surface-2", page <= 1 && "pointer-events-none opacity-40")}><ChevronLeft className="size-4" aria-hidden /> Previous</Link>
          <span className="text-[12px] tabular-nums text-muted">Page {page} of {lastPage}</span>
          <Link href={queueHref(query, { page: Math.min(lastPage, page + 1), ticket: "" })} aria-disabled={page >= lastPage} tabIndex={page >= lastPage ? -1 : undefined} className={cn("inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 text-[12.5px] font-medium hover:bg-surface-2", page >= lastPage && "pointer-events-none opacity-40")}>Next <ChevronRight className="size-4" aria-hidden /></Link>
        </nav>
      )}
    </Card>
  );
}
