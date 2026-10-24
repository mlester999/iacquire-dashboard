"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronLeft, ChevronRight, Inbox, LifeBuoy, MessageSquarePlus, PencilRuler, Search, ThumbsUp, TriangleAlert, UserCheck } from "lucide-react";
import { Card, EmptyState, Input, Select } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { FilterTabs } from "@/components/settings/panel";
import { REQUEST_TYPE_LABELS, REQUEST_TYPES, categoryLabel, statusLabelForClient, type FeedbackStage, type RequestType } from "@/lib/support/lifecycle";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import type { ClientStatusFilter } from "@/server/support/service";
import type { RequestListItem, RequestPage } from "@/server/support/types";

export interface ListQuery {
  status: ClientStatusFilter;
  requestType: RequestType | "";
  q: string;
  sort: "updated" | "newest" | "oldest" | "status";
  scope: "all" | "mine";
  page: number;
}

const TABS: Array<{ value: ClientStatusFilter; label: string }> = [
  { value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "in_progress", label: "In progress" },
  { value: "waiting", label: "Waiting" }, { value: "resolved", label: "Resolved" }, { value: "closed", label: "Closed" },
];

const TYPE_ICON = { support: LifeBuoy, issue: TriangleAlert, feedback: ThumbsUp, change: PencilRuler } as const;
const tone = (status: string) => (status === "resolved" ? "success" : status === "closed" ? "neutral" : status === "waiting_for_client" ? "warning" : "primary") as "success" | "neutral" | "warning" | "primary";

export function hrefFor(query: ListQuery, patch: Partial<ListQuery>): string {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.status !== "all") params.set("status", next.status);
  if (next.requestType) params.set("type", next.requestType);
  if (next.q) params.set("q", next.q);
  if (next.sort !== "updated") params.set("sort", next.sort);
  if (next.scope === "mine") params.set("scope", "mine");
  if (next.page > 1) params.set("page", String(next.page));
  const s = params.toString();
  return `/support/requests${s ? `?${s}` : ""}`;
}

export function RequestsList({ data, counts, query, seesAll, timeZone }: {
  data: RequestPage<RequestListItem>;
  counts: Record<ClientStatusFilter, number>;
  query: ListQuery;
  seesAll: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(query.q);
  // The box follows the address when it changes from outside (back button, clear filters), but never fights what is being typed.
  const [pushed, setPushed] = React.useState(query.q);
  const [seen, setSeen] = React.useState(query.q);
  if (query.q !== seen) {
    setSeen(query.q);
    if (query.q !== pushed) setQ(query.q);
  }
  // Searching updates the address as you type (after a short pause), so the page can be shared and refreshed.
  React.useEffect(() => {
    if (q.trim() === query.q) return;
    const t = setTimeout(() => {
      setPushed(q.trim());
      router.replace(hrefFor(query, { q: q.trim(), page: 1 }));
    }, 350);
    return () => clearTimeout(t);
  }, [q, query, router]);

  const start = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const end = Math.min(data.total, data.page * data.pageSize);
  const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = query.status !== "all" || query.requestType !== "" || query.q !== "";
  const neverUsed = counts.all === 0 && !filtered && query.scope === "all";

  return (
    <div className="space-y-5">
      <FilterTabs label="Filter requests by status" value={query.status} onChange={(v) => router.push(hrefFor(query, { status: v, page: 1 }))}
        options={TABS.map((t) => ({ ...t, count: counts[t.value] }))} />

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted sm:top-3" aria-hidden />
          <Input aria-label="Search your requests" placeholder="Search by title, reference or message…" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Filter by request type" value={query.requestType} onChange={(e) => router.push(hrefFor(query, { requestType: e.target.value as RequestType | "", page: 1 }))} className="sm:w-48">
          <option value="">All types</option>
          {REQUEST_TYPES.map((t) => <option key={t} value={t}>{REQUEST_TYPE_LABELS[t].plural}</option>)}
        </Select>
        <Select aria-label="Sort requests" value={query.sort} onChange={(e) => router.push(hrefFor(query, { sort: e.target.value as ListQuery["sort"], page: 1 }))} className="sm:w-44">
          <option value="updated">Latest activity</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="status">Needs me first</option>
        </Select>
        {seesAll && (
          <Select aria-label="Whose requests" value={query.scope} onChange={(e) => router.push(hrefFor(query, { scope: e.target.value as "all" | "mine", page: 1 }))} className="sm:w-44">
            <option value="all">Whole workspace</option>
            <option value="mine">Only mine</option>
          </Select>
        )}
      </div>

      <p className="text-[12.5px] text-muted" role="status" aria-live="polite">
        {data.total === 0 ? (filtered ? "No requests match." : "") : `Showing ${start}–${end} of ${data.total} request${data.total === 1 ? "" : "s"}${seesAll && query.scope === "all" ? " in your workspace" : ""}`}
      </p>

      {data.items.length === 0 ? (
        <Card>
          {neverUsed ? (
            <EmptyState icon={<Inbox className="size-5" />} title="You haven't sent any requests yet" description="When you ask for help, report a problem or share an idea, it shows up here with its progress and every reply."
              action={<><ButtonLink href="/support" variant="brand"><LifeBuoy className="size-4" aria-hidden /> Get support</ButtonLink><ButtonLink href="/support/report-issue" variant="secondary"><TriangleAlert className="size-4" aria-hidden /> Report an issue</ButtonLink><ButtonLink href="/support/feedback" variant="secondary"><ThumbsUp className="size-4" aria-hidden /> Provide feedback</ButtonLink></>} />
          ) : (
            <EmptyState compact icon={<Search className="size-5" />} title="Nothing matches" description="Try a different status, type or search."
              action={<ButtonLink href="/support/requests" variant="secondary" size="sm">Clear filters</ButtonLink>} />
          )}
        </Card>
      ) : (
        <ul className="space-y-3" aria-label="Your requests">
          {data.items.map((r) => {
            const Icon = TYPE_ICON[r.requestType];
            const label = statusLabelForClient(r.status, r.requestType, r.feedbackStage as FeedbackStage | null);
            return (
              <li key={r.id}>
                <Link href={`/support/${r.id}`} className={cn("group block rounded-2xl border bg-surface p-4 shadow-soft transition hover:border-line-strong hover:shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:p-5", r.hasUnreadReply ? "border-primary/40" : "border-line")}>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2 ring-1 ring-inset ring-line" aria-hidden><Icon className="size-4" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2 ring-1 ring-inset ring-line">{r.ref}</span>
                        <StatusPill tone={tone(r.status)} size="sm">{label}</StatusPill>
                        <InfoChip>{REQUEST_TYPE_LABELS[r.requestType].label}</InfoChip>
                        {r.hasUnreadReply && <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-white"><MessageSquarePlus className="size-3" aria-hidden /> New reply</span>}
                      </div>
                      <h2 className="mt-2 line-clamp-2 break-words text-[15px] font-semibold leading-snug tracking-tight text-ink group-hover:text-primary-ink" title={r.subject}>{r.subject}</h2>
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
                        <span>{categoryLabel(r.category)}</span>
                        <span className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" aria-hidden /> Sent {formatDate(r.createdAt, timeZone)}</span>
                        <span suppressHydrationWarning>Updated {relativeTime(r.lastActivityAt)}</span>
                        {r.isAssigned && <span className="inline-flex items-center gap-1"><UserCheck className="size-3.5" aria-hidden /> With the iAcquire team</span>}
                        {seesAll && r.createdByName && <span>By {r.createdByName}</span>}
                      </div>
                    </div>
                    <ChevronRight className="mt-1 size-4 shrink-0 text-faint transition group-hover:translate-x-0.5" aria-hidden />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {lastPage > 1 && (
        <nav className="flex items-center justify-between gap-3" aria-label="Pagination">
          <ButtonLink href={hrefFor(query, { page: Math.max(1, data.page - 1) })} variant="secondary" size="sm" aria-disabled={data.page <= 1} tabIndex={data.page <= 1 ? -1 : undefined} className={cn(data.page <= 1 && "pointer-events-none opacity-50")} prefetch={false}>
            <ChevronLeft className="size-4" aria-hidden /> Previous
          </ButtonLink>
          <span className="text-[12.5px] tabular-nums text-muted">Page {data.page} of {lastPage}</span>
          <ButtonLink href={hrefFor(query, { page: Math.min(lastPage, data.page + 1) })} variant="secondary" size="sm" aria-disabled={data.page >= lastPage} tabIndex={data.page >= lastPage ? -1 : undefined} className={cn(data.page >= lastPage && "pointer-events-none opacity-50")} prefetch={false}>
            Next <ChevronRight className="size-4" aria-hidden />
          </ButtonLink>
        </nav>
      )}
    </div>
  );
}
