import * as React from "react";
import Link from "next/link";
import { Settings2, UsersRound } from "lucide-react";
import { Badge, Card, Input, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { listHref, STATUS_FILTERS, STATUS_LABEL, STATUS_TONE, visitorsSee, windowWords, type ListQuery, type SwitchState } from "@/lib/demo/admin-view";
import { formatDateTime } from "@/lib/utils";
import type { ProspectListRow, ProspectsSummary } from "@/server/demo/admin";

// The agency's list of demo prospects: where the funnel stands today, what the three switches say, a filter, and one card per prospect. A prospect's conversation is NOT on this
// page or on their details page: reading it is a separate, recorded step.

const TONE = { success: "border-success/25 bg-success-soft text-success-ink", warning: "border-warning/30 bg-warning-soft text-warning-ink", danger: "border-danger/20 bg-danger-soft text-danger-ink" } as const;

function Stat({ label, value, detail }: { label: string; value: React.ReactNode; detail?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <dt className="text-[12px] font-medium text-muted">{label}</dt>
      <dd className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-ink">{value}</dd>
      {detail && <dd className="text-[12px] text-muted">{detail}</dd>}
    </div>
  );
}

export function ProspectsList({
  summary,
  rows,
  hasMore,
  query,
  owners,
  switches,
  canManage,
  timeZone,
  now,
}: {
  summary: ProspectsSummary;
  rows: ProspectListRow[];
  hasMore: boolean;
  query: ListQuery;
  owners: Array<{ id: string; name: string }>;
  switches: SwitchState;
  canManage: boolean;
  timeZone: string;
  now: string;
}) {
  const state = visitorsSee(switches);
  const clock = new Date(now);
  const open = summary.byStatus.active ?? 0;
  const last = rows[rows.length - 1];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
            <UsersRound className="size-5 text-primary" aria-hidden />
            Demo prospects
          </h1>
          <p className="max-w-3xl text-[13.5px] leading-relaxed text-muted">
            People who asked for a demo with their work email. A prospect is not a user and has no workspace; you can turn a confirmed one into a client on their page. Reading what a prospect
            wrote to the AI chat is a separate step that is recorded.
          </p>
        </div>
        <Link href="/admin/prospects/settings" className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-soft hover:bg-surface-2 sm:h-10">
          <Settings2 className="size-4" aria-hidden />
          {canManage ? "Demo settings" : "View settings"}
        </Link>
      </header>

      <p role="status" className={`rounded-xl border px-4 py-3 text-[13.5px] leading-relaxed ${TONE[state.tone]}`}>
        {state.text}
      </p>

      <Card className="p-4">
        <h2 className="text-[14px] font-semibold text-ink">Where the funnel stands</h2>
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="All prospects" value={summary.total} />
          <Stat label="Demo open now" value={open} />
          <Stat label="Asked for a consultation" value={summary.byStatus.consultation_requested ?? 0} />
          <Stat label="Pressed Buy now" value={summary.byStatus.purchase_started ?? 0} />
          <Stat label="Demos started today" value={summary.today.starts} detail={`of ${summary.caps.dailyStartCap} a day (UTC)`} />
          <Stat label="AI messages today" value={summary.today.messages} detail={`of ${summary.caps.dailyMessageCap} a day${summary.today.blocked ? `, ${summary.today.blocked} refused` : ""}`} />
        </dl>
      </Card>

      <Card className="p-4">
        <form method="get" action="/admin/prospects" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_12rem_12rem_auto] lg:items-end">
          <div className="space-y-1.5">
            <label htmlFor="prospect-search" className="text-[13px] font-medium text-ink-2">
              Search name, email or business
            </label>
            <Input id="prospect-search" name="q" defaultValue={query.search} maxLength={100} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="prospect-status" className="text-[13px] font-medium text-ink-2">
              Status
            </label>
            <Select id="prospect-status" name="status" defaultValue={query.status}>
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All statuses" : STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="prospect-owner" className="text-[13px] font-medium text-ink-2">
              Followed by
            </label>
            <Select id="prospect-owner" name="owner" defaultValue={query.owner}>
              <option value="">Anyone</option>
              <option value="none">Nobody yet</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            <Link href="/admin/prospects" className="inline-flex h-11 items-center rounded-xl px-3 text-sm text-muted hover:text-ink sm:h-10">
              Clear
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-[14px] text-muted">{query.status === "all" && !query.search && !query.owner ? "Nobody has asked for a demo yet." : "No prospect matches that filter."}</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Prospects">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/prospects/${r.id}`} className="block px-4 py-4 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="min-w-0 break-words text-[14.5px] font-semibold text-ink">{r.erased ? "Details erased" : (r.name ?? "No name")}</p>
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    {r.accessRequestId && <Badge tone="outline">Also on the get-started form</Badge>}
                  </div>
                  {!r.erased && (
                    <p className="mt-0.5 break-words text-[13px] text-muted">
                      {r.business ?? "No business"}
                      {r.industryLabel ? `, ${r.industryLabel}` : ""} · <span className="break-all">{r.email}</span>
                    </p>
                  )}
                  <p className="mt-1.5 text-[12.5px] text-muted">
                    {windowWords(r, clock)} · {r.messagesUsed} of {r.messageAllowance} messages used · Asked {formatDateTime(r.createdAt, timeZone)}
                    {r.ownerName ? ` · Followed by ${r.ownerName}` : ""}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {(hasMore || query.after) && (
          <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px]">
            {query.after ? (
              <Link href={listHref({ ...query, after: null })} className="inline-flex min-h-11 items-center text-primary hover:underline">
                Back to the newest
              </Link>
            ) : (
              <span />
            )}
            {hasMore && last && (
              <Link href={listHref({ ...query, after: { createdAt: last.createdAt, id: last.id } })} className="inline-flex min-h-11 items-center text-primary hover:underline">
                Older prospects
              </Link>
            )}
          </nav>
        )}
      </Card>
    </div>
  );
}
