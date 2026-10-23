"use client";

import * as React from "react";
import Link from "next/link";
import { ListTodo, Mail, MessageCircle, MessageSquareHeart, MessageSquareText, Send, Star, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Select, Textarea } from "@/components/ui/primitives";
import { RelativeTime } from "@/components/crm/relative-time";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { cancelReviewRequestAction, setFeedbackFollowUpAction } from "@/app/actions/crm-reviews";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { npsBand, type FeedbackScale } from "@/lib/reputation/scores";
import { cn } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { FeedbackView, ReviewRequestView } from "@/server/crm/reviews";
import { FOLLOW_UP_LABELS, FOLLOW_UP_TONES, RATING_WORDS, REQUEST_STATUS_LABELS, REQUEST_STATUS_TONES, type FollowUpKey, type RequestStatusKey } from "@/components/crm/reviews/model";

const CHANNEL_ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const VIA: Record<ReviewRequestView["requestedVia"], string> = { manual: "Sent by", workflow: "Sent by a workflow", api: "Sent through the API", program: "Sent by a customer program", batch: "Sent in a batch" };

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

const BAND_LABEL = { promoter: "Promoter", passive: "Passive", detractor: "Detractor" } as const;

/** A private answer on either scale: stars for one to five, "9 of 10 · Promoter" for zero to ten. The group is for the team's reading; the customer is never told it. */
export function FeedbackScore({ rating, npsScore, scale, className }: { rating: number | null; npsScore: number | null; scale: FeedbackScale; className?: string }) {
  if (scale !== "nps10") return <RatingStars rating={rating} className={className} />;
  if (npsScore === null) return <span className={cn("text-[12.5px] text-muted", className)}>No score</span>;
  return <span className={cn("text-[12.5px] font-medium text-ink", className)}>{npsScore} of 10<span className="font-normal text-muted"> · {BAND_LABEL[npsBand(npsScore)]}</span></span>;
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
                  {r.kind === "survey" && <Badge tone="outline">Survey</Badge>}
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
                    <FeedbackScore rating={r.feedback.rating} npsScore={r.feedback.npsScore} scale={r.feedback.scale} />
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

/**
 * Private feedback, kept for the team. Escalated feedback links to its follow-up task and its inbox conversation; owners and managers, and the person the follow-up task is
 * assigned to, can mark progress (resolving asks for an optional note of what was done).
 */
export function FeedbackList({ scope, rows, canFollowUp, contactsLinked, emptyText }: { scope: CrmScope; rows: FeedbackView[]; canFollowUp: boolean; contactsLinked: boolean; emptyText?: string }) {
  const { run, busy } = useCrmAction();
  const [resolving, setResolving] = React.useState<FeedbackView | null>(null);
  const [note, setNote] = React.useState("");
  if (!rows.length) {
    return <EmptyState compact icon={<MessageSquareHeart className="size-5" />} title="No feedback here" description={emptyText ?? "When customers send you private feedback from their review page, it appears here."} />;
  }
  return (
    <>
    <ul className="space-y-3" aria-label="Private feedback">
      {rows.map((f) => {
        const follow = f.followUpStatus as FollowUpKey;
        const canAct = (canFollowUp || f.assignedToYou) && !scope.readOnly;
        return (
          <li key={f.id} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <FeedbackScore rating={f.rating} npsScore={f.npsScore} scale={f.scale} />
                  {f.lowScore && <Badge tone="warning">Low</Badge>}
                </span>
                <p className="mt-1 text-[12.5px] text-muted">
                  {f.contact ? (contactsLinked ? <Link href={`${scope.base}/contacts/${f.contact.id}`} className="font-medium text-ink hover:underline">{f.contact.name}</Link> : <span className="font-medium text-ink">{f.contact.name}</span>) : f.source === "survey" ? "No name attached" : "A customer"}
                  {" · "}{SOURCE_LABELS[f.source]} · <RelativeTime iso={f.receivedAt} timezone={scope.timezone} />
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {f.escalatedTaskId && (
                  <Link href={`${scope.base}/tasks?task=${f.escalatedTaskId}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-primary hover:bg-primary-soft">
                    <ListTodo className="size-3.5" aria-hidden />Follow-up task
                  </Link>
                )}
                {f.conversationId && !scope.agency && (
                  <Link href={`/inbox?c=${f.conversationId}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-primary hover:bg-primary-soft">
                    <MessageSquareText className="size-3.5" aria-hidden />Open in the inbox
                  </Link>
                )}
                {canAct ? (
                  <Select
                    aria-label="Follow-up status"
                    className="h-9 min-w-[150px]"
                    value={follow === "escalated" ? "escalated" : follow}
                    disabled={busy(`fu-${f.id}`)}
                    onChange={(e) => {
                      const to = e.target.value as "new" | "acknowledged" | "resolved";
                      if (to === "resolved") {
                        setNote("");
                        setResolving(f);
                      } else void run(`fu-${f.id}`, () => setFeedbackFollowUpAction(scope.orgId, f.id, to), "Feedback updated.");
                    }}
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
            {(f.acknowledgedAt || f.resolvedAt) && (
              <p className="mt-2 text-[12.5px] text-muted">
                {f.acknowledgedAt && <>Acknowledged{f.acknowledgedByName ? ` by ${f.acknowledgedByName}` : ""} <RelativeTime iso={f.acknowledgedAt} timezone={scope.timezone} />. </>}
                {f.resolvedAt && <>Resolved{f.resolvedByName ? ` by ${f.resolvedByName}` : ""} <RelativeTime iso={f.resolvedAt} timezone={scope.timezone} />.{f.resolutionNote ? ` ${f.resolutionNote}` : ""}</>}
              </p>
            )}
          </li>
        );
      })}
    </ul>
    <ConfirmDialog
      open={Boolean(resolving)}
      onOpenChange={(o) => !o && setResolving(null)}
      title="Mark this feedback resolved?"
      description="Say what was done, if you like. It stays with the feedback so the team can see how it ended. The customer is not told anything."
      confirmLabel="Mark resolved"
      loading={busy("resolve-feedback")}
      onConfirm={async () => {
        if (!resolving) return;
        if (await run("resolve-feedback", () => setFeedbackFollowUpAction(scope.orgId, resolving.id, "resolved", note.trim() || null), "Feedback resolved.")) setResolving(null);
      }}
    >
      <label htmlFor="resolve-note" className="text-[13px] font-medium text-ink">What was done <span className="font-normal text-muted">Optional</span></label>
      <Textarea id="resolve-note" rows={3} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1.5 text-[16px] sm:text-[14px]" />
    </ConfirmDialog>
    </>
  );
}
