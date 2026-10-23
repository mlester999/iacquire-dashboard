"use client";

import * as React from "react";
import Link from "next/link";
import { Globe2, Lock, MessageSquareReply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlays";
import { Pagination, useCrmAction } from "@/components/crm/ui";
import { RelativeTime } from "@/components/crm/relative-time";
import { RatingStars } from "@/components/crm/reviews/review-lists";
import { ReplyEditor, ReplyStatusBadge } from "@/components/reputation/reply-editor";
import { readReviewsNowAction } from "@/app/actions/reputation";
import { REVIEW_FILTER_LABELS, REVIEW_FILTERS, type ReviewFilter } from "@/lib/reputation/external";
import { cn } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { ConnectionSummary, PublicReviewView, PublicReviewsData } from "@/server/reputation/public-reviews";

// CRM → Reviews → Public reviews. The reviews a connected review site returned, as they were read: iAcquire never writes, edits, hides or counts a review for anyone, and nothing
// here says why a review exists. Numbers are computed from the reviews read, shown with how many that is and when they were read, beside what the site says about itself.

const num = (n: number) => n.toLocaleString("en-US");

function Summary({ s, scope, canRead }: { s: ConnectionSummary; scope: CrmScope; canRead: boolean }) {
  const { run, busy } = useCrmAction();
  const m = s.summary;
  const word = s.provider === "facebook" ? "recommendation" : "review";
  return (
    <Card className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold text-ink">
            <span className="truncate">{s.label}: {s.name}</span>
            {s.simulated && <Badge tone="violet">Simulated</Badge>}
            {s.status === "disconnected" && <Badge tone="neutral">Disconnected</Badge>}
            {(s.status === "needs_reauth" || s.status === "revoked" || s.status === "error") && <Badge tone="warning">Needs attention</Badge>}
          </h3>
          <p className="mt-1 text-[12.5px] text-muted">Read <span className="text-ink-2">{s.ago}</span>. These numbers come from the {word}s read, not from {s.label}&apos;s own average.</p>
        </div>
        {canRead && s.status === "connected" && (
          <Button variant="secondary" size="sm" loading={busy("read")} onClick={() => run("read", () => readReviewsNowAction(scope.orgId, s.connectionId), (r) => (r.status === "synced" ? "Read again." : r.status === "partial" ? "Read part of the list; the rest follows." : r.reason ?? "Nothing was read."))}>Read now</Button>
        )}
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-[12px] font-medium text-muted">{s.provider === "facebook" ? "Recommendations read" : "Reviews read"}</dt>
          <dd className="mt-1 text-[22px] font-semibold leading-none tabular-nums text-ink">{num(m.live)}</dd>
        </div>
        <div>
          <dt className="text-[12px] font-medium text-muted">{m.rated ? `Average of ${num(m.rated)} star ratings` : "Average"}</dt>
          <dd className="mt-1 text-[22px] font-semibold leading-none tabular-nums text-ink">{m.average !== null ? m.average.toFixed(1) : "None yet"}</dd>
        </div>
        <div>
          <dt className="text-[12px] font-medium text-muted">{s.label} says</dt>
          <dd className="mt-1 text-[22px] font-semibold leading-none tabular-nums text-ink">{s.reportedCount !== null ? num(s.reportedCount) : "No total"}{s.reportedRating !== null && <span className="ml-2 text-[13px] font-normal text-muted">average {s.reportedRating.toFixed(1)}</span>}</dd>
        </div>
      </dl>
      <p className="text-[13px] leading-relaxed text-ink-2">{s.line}</p>
      {s.provider === "facebook" && (m.recommended > 0 || m.notRecommended > 0) && <p className="text-[12.5px] text-muted">{num(m.recommended)} recommend and {num(m.notRecommended)} don&apos;t.</p>}
      {m.removed > 0 && <p className="text-[12.5px] text-muted">{num(m.removed)} read earlier {m.removed === 1 ? "is" : "are"} no longer on the site and {m.removed === 1 ? "is" : "are"} not counted above.</p>}
      {m.rated > 0 && m.rated < 10 && <p className="text-[12.5px] text-warning-ink">Only {num(m.rated)} star {m.rated === 1 ? "rating" : "ratings"} read: an average of so few moves a lot with each new one.</p>}
    </Card>
  );
}

function Weekly({ weekly }: { weekly: PublicReviewsData["weekly"] }) {
  const max = Math.max(1, ...weekly.map((w) => w.count));
  const total = weekly.reduce((t, w) => t + w.count, 0);
  return (
    <Card className="space-y-2 p-4 sm:p-5">
      <h3 className="text-[14.5px] font-semibold text-ink">New public reviews each week</h3>
      <p className="text-[12.5px] leading-relaxed text-muted">{num(total)} in the last 12 weeks, from every review site connected. This counts every review that appeared, whatever the reason. It does not show that a request for a review produced one.</p>
      <ol className="space-y-1" aria-label="New public reviews by week">
        {weekly.map((w) => (
          <li key={w.weekStart} className="flex items-center gap-3 text-[12px]">
            <span className="w-20 shrink-0 text-muted tabular-nums">{w.weekStart}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round((w.count / max) * 100)}%` }} /></span>
            <span className="w-6 shrink-0 text-right tabular-nums text-ink-2">{w.count}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function ReviewRow({ r, onOpen, scope, contactsLinked }: { r: PublicReviewView; onOpen: () => void; scope: CrmScope; contactsLinked: boolean }) {
  const reply = r.reply;
  const answered = Boolean(r.providerReply) || reply?.status === "posted";
  return (
    <li className={cn("rounded-2xl border bg-surface p-4", r.low && !answered && !r.removedAt ? "border-warning/40" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        {r.rating !== null ? <RatingStars rating={r.rating} /> : <span className="text-[13px] font-medium text-ink">{r.ratingText}</span>}
        <Badge tone="outline">{r.providerLabel}</Badge>
        {r.simulated && <Badge tone="violet">Simulated</Badge>}
        {r.removedAt && <Badge tone="warning">Removed from the site</Badge>}
        {answered && <Badge tone="success">Answered</Badge>}
        {reply && reply.status !== "posted" && <ReplyStatusBadge status={reply.status} />}
      </div>
      <p className="mt-1 text-[12.5px] text-muted">{r.reviewerName ?? "Anonymous reviewer"} · <RelativeTime iso={r.at} timezone={scope.timezone} /></p>
      {r.comment ? <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{r.comment}</p> : <p className="mt-2 text-[13px] text-muted">The reviewer wrote no text.</p>}
      {r.contactId && r.contactName && (
        <p className="mt-2 text-[12.5px] text-muted">
          Linked by your team to {contactsLinked ? <Link href={`${scope.base}/contacts/${r.contactId}`} className="font-medium text-primary hover:underline">{r.contactName}</Link> : r.contactName}. iAcquire never matches a reviewer to a customer by itself.
        </p>
      )}
      <div className="mt-3">
        <Button variant="secondary" size="sm" onClick={onOpen}><MessageSquareReply className="size-4" aria-hidden />{reply && !["posted", "rejected", "cancelled"].includes(reply.status) ? "Open the reply" : answered ? "See the reply" : "Reply"}</Button>
      </div>
    </li>
  );
}

export function PublicReviewsPanel({ scope, data, enabled, contactsLinked, hrefFor, focusId }: {
  scope: CrmScope;
  data: PublicReviewsData;
  /** A Super Admin switched public reviews on for the workspace. Without it what was read stays visible, and nothing new is read or written. */
  enabled: boolean;
  contactsLinked: boolean;
  hrefFor: (q: { filter?: ReviewFilter; page?: number }) => string;
  focusId: string | null;
}) {
  const rows = data.focus ? [data.focus, ...data.page.rows] : data.page.rows;
  const [openId, setOpenId] = React.useState<string | null>(focusId);
  const open = rows.find((r) => r.id === openId) ?? null;
  const canRead = enabled && !scope.readOnly && !scope.agency;
  return (
    <div className="space-y-5">
      {!enabled && (
        <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          Public reviews aren&apos;t switched on for this workspace now, so nothing new is read and nothing can be written. What was read earlier is shown below.
        </p>
      )}
      <p className="text-[13px] leading-relaxed text-muted">
        Reviews customers wrote on a review site, as the site returned them. iAcquire doesn&apos;t write, hide or change a review, and a reviewer is never matched to a customer by name. A reply is written by a person or drafted by the AI assist for a person,
        and goes out only after the owner or a manager approves those exact words.
      </p>
      {data.summaries.length > 0 ? (
        <div className="grid gap-4 xl:grid-cols-2">{data.summaries.map((s) => <Summary key={s.connectionId} s={s} scope={scope} canRead={canRead && !scope.agency} />)}</div>
      ) : (
        <EmptyState compact icon={<Globe2 className="size-5" />} title="No review site is connected" description={<>Connect Google or a Facebook Page in <Link href={`${scope.base}/reviews?tab=settings`} className="font-medium underline">Settings</Link>. Until then nothing is read, and no review or rating appears here.</>} />
      )}
      {data.summaries.length > 0 && <Weekly weekly={data.weekly} />}

      <nav aria-label="Filter public reviews" className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {REVIEW_FILTERS.map((f) => (
          <Link
            key={f}
            href={hrefFor({ filter: f })}
            aria-current={f === data.filter ? "page" : undefined}
            className={cn("inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-[13px] font-medium transition-colors sm:min-h-9", f === data.filter ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}
          >
            {REVIEW_FILTER_LABELS[f]}<span className="tabular-nums text-muted">{data.counts[f]}</span>
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState compact icon={<MessageSquareReply className="size-5" />} title={data.summaries.length ? "No reviews match" : "Nothing has been read yet"} description={data.summaries.length ? "Try another filter. A review shows up here only after a connected site returned it." : "Reviews appear here once a review site is connected and has been read."} />
      ) : (
        <ul className="space-y-3" aria-label="Public reviews">
          {rows.map((r) => <ReviewRow key={r.id} r={r} scope={scope} contactsLinked={contactsLinked} onOpen={() => setOpenId(r.id)} />)}
        </ul>
      )}
      <Pagination page={data.page.page} pageSize={data.page.pageSize} total={data.page.total} hrefFor={(n) => hrefFor({ filter: data.filter, page: n })} />

      <Sheet open={Boolean(open)} onOpenChange={(o) => !o && setOpenId(null)} title="Reply to a review" description={open ? `${open.providerLabel}: ${open.connectionName}` : undefined}>
        {open && <ReplyEditor key={`${open.id}:${open.reply?.id ?? ""}:${open.reply?.version ?? 0}:${open.reply?.status ?? ""}`} orgId={scope.orgId} review={open} facts={data.facts} enabled={enabled} timezone={scope.timezone} />}
      </Sheet>
    </div>
  );
}
