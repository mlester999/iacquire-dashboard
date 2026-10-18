"use client";

import * as React from "react";
import Link from "next/link";
import { ListTodo, Mail, MessageCircle, MessageSquareHeart, MessageSquareText, Send, Star, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Select } from "@/components/ui/primitives";
import { RelativeTime } from "@/components/crm/relative-time";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { cancelReviewRequestAction, setFeedbackFollowUpAction } from "@/app/actions/crm-reviews";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { cn } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { FeedbackView, ReviewRequestView } from "@/server/crm/reviews";
import { FOLLOW_UP_LABELS, FOLLOW_UP_TONES, RATING_WORDS, REQUEST_STATUS_LABELS, REQUEST_STATUS_TONES, type FollowUpKey, type RequestStatusKey } from "@/components/crm/reviews/model";

const CHANNEL_ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const VIA: Record<ReviewRequestView["requestedVia"], string> = { manual: "Sent by", workflow: "Sent by a workflow", api: "Sent through the API" };

/** A private rating as five small stars and the words, so it reads the same with or without colour. */
export function RatingStars({ rating, className }: { rating: number | null; className?: string }) {
  if (rating === null) return <span className={cn("text-[12.5px] text-muted", className)}>No rating</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="inline-flex" aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => <Star key={i} className={cn("size-3.5", i <= rating ? "fill-current text-warning" : "text-line-strong")} />)}
      </span>
      <span className="text-[12.5px] font-medium text-ink">{rating} of 5<span className="font-normal text-muted"> · {RATING_WORDS[rating]}</span></span>
    </span>
  );
}

/** Review requests: who was asked, on which channel, how far it got, and their private feedback if they gave any. */
export function RequestsList({ scope, rows, canCancel, contactsLinked, emptyText }: { scope: CrmScope; rows: ReviewRequestView[]; canCancel: boolean; contactsLinked: boolean; emptyText?: string }) {
  const { run, busy } = useCrmAction();
  const [cancelling, setCancelling] = React.useState<ReviewRequestView | null>(null);
  if (!rows.length) {
    return <EmptyState compact icon={<Send className="size-5" />} title="No review requests here" description={emptyText ?? "Requests you send appear here with how far each one got."} />;
  }
  return (
    <>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface" aria-label="Review requests">
        {rows.map((r) => {
          const Icon = CHANNEL_ICON[r.channel];
          const status = r.status as RequestStatusKey;
          return (
            <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
              <span className="hidden size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2 sm:flex"><Icon className="size-4" aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {r.contact ? (
                    contactsLinked ? <Link href={`${scope.base}/contacts/${r.contact.id}`} className="truncate text-[13.5px] font-medium text-ink hover:underline">{r.contact.name}</Link> : <span className="truncate text-[13.5px] font-medium text-ink">{r.contact.name}</span>
                  ) : <span className="text-[13.5px] text-muted">Removed contact</span>}
                  <Badge tone={REQUEST_STATUS_TONES[status]}>{REQUEST_STATUS_LABELS[status]}</Badge>
                  {r.expired && r.status !== "cancelled" && <Badge tone="outline">Link expired</Badge>}
                </div>
                <p className="mt-0.5 text-[12.5px] text-muted">
                  {CHANNEL_LABELS[r.channel]}{r.templateName ? ` · ${r.templateName}` : ""} · {r.requestedVia === "manual" ? `${VIA.manual} ${r.requestedByName ?? "a teammate"}` : VIA[r.requestedVia]} <RelativeTime iso={r.createdAt} timezone={scope.timezone} />
                </p>
                <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                  <div className="flex gap-1"><dt>Sent</dt><dd className="text-ink-2">{r.sentAt ? <RelativeTime iso={r.sentAt} timezone={scope.timezone} /> : "Not yet"}</dd></div>
                  <div className="flex gap-1"><dt>Opened</dt><dd className="text-ink-2">{r.openedAt ? <RelativeTime iso={r.openedAt} timezone={scope.timezone} /> : "No"}</dd></div>
                  <div className="flex gap-1"><dt>Review site</dt><dd className="text-ink-2">{r.clickedAt ? <RelativeTime iso={r.clickedAt} timezone={scope.timezone} /> : "Not opened"}</dd></div>
                </dl>
                {r.messageDetail && <p className="mt-1.5 text-[12.5px] text-danger-ink">{r.messageDetail}</p>}
                {r.feedback && (
                  <div className="mt-2 rounded-xl bg-surface-2/70 px-3 py-2">
                    <RatingStars rating={r.feedback.rating} />
                    {r.feedback.comment && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{r.feedback.comment}</p>}
                  </div>
                )}
              </div>
              {canCancel && (r.status === "queued" || r.status === "pending") && (
                <Button variant="ghost" size="sm" className="self-start" onClick={() => setCancelling(r)}><XCircle className="size-4" aria-hidden />Cancel</Button>
              )}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel this review request?"
        description="The message hasn't gone out yet. Cancelling withdraws it and the link stops taking feedback. If it's already on its way, it can't be called back."
        confirmLabel="Cancel request"
        danger
        loading={busy("cancel-review")}
        onConfirm={async () => {
          if (!cancelling) return;
          if (await run("cancel-review", () => cancelReviewRequestAction(scope.orgId, cancelling.id), "Review request cancelled.")) setCancelling(null);
        }}
      />
    </>
  );
}

const SOURCE_LABELS: Record<FeedbackView["source"], string> = { review_request: "From a review request", manual: "Recorded by the team", survey: "From a survey", import: "Imported" };

/** Private feedback, kept for the team. Escalated feedback links to its follow-up task; anyone who manages reviews can mark progress. */
export function FeedbackList({ scope, rows, canFollowUp, contactsLinked, emptyText }: { scope: CrmScope; rows: FeedbackView[]; canFollowUp: boolean; contactsLinked: boolean; emptyText?: string }) {
  const { run, busy } = useCrmAction();
  if (!rows.length) {
    return <EmptyState compact icon={<MessageSquareHeart className="size-5" />} title="No feedback here" description={emptyText ?? "When customers send you private feedback from their review page, it appears here."} />;
  }
  return (
    <ul className="space-y-3" aria-label="Private feedback">
      {rows.map((f) => {
        const follow = f.followUpStatus as FollowUpKey;
        return (
          <li key={f.id} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <RatingStars rating={f.rating} />
                <p className="mt-1 text-[12.5px] text-muted">
                  {f.contact ? (contactsLinked ? <Link href={`${scope.base}/contacts/${f.contact.id}`} className="font-medium text-ink hover:underline">{f.contact.name}</Link> : <span className="font-medium text-ink">{f.contact.name}</span>) : "A customer"}
                  {" · "}{SOURCE_LABELS[f.source]} · <RelativeTime iso={f.receivedAt} timezone={scope.timezone} />
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {f.escalatedTaskId && (
                  <Link href={`${scope.base}/tasks?task=${f.escalatedTaskId}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-primary hover:bg-primary-soft">
                    <ListTodo className="size-3.5" aria-hidden />Follow-up task
                  </Link>
                )}
                {canFollowUp ? (
                  <Select
                    aria-label="Follow-up status"
                    className="h-9 min-w-[150px]"
                    value={follow === "escalated" ? "escalated" : follow}
                    disabled={busy(`fu-${f.id}`)}
                    onChange={(e) => run(`fu-${f.id}`, () => setFeedbackFollowUpAction(scope.orgId, f.id, e.target.value as "new" | "acknowledged" | "resolved"), "Feedback updated.")}
                  >
                    {follow === "escalated" && <option value="escalated" disabled>Escalated</option>}
                    <option value="new">New</option>
                    <option value="acknowledged">Acknowledged</option>
                    <option value="resolved">Resolved</option>
                  </Select>
                ) : (
                  <Badge tone={FOLLOW_UP_TONES[follow]}>{FOLLOW_UP_LABELS[follow]}</Badge>
                )}
              </div>
            </div>
            {f.comment ? <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{f.comment}</p> : <p className="mt-2 text-[13px] text-muted">No comment.</p>}
          </li>
        );
      })}
    </ul>
  );
}
