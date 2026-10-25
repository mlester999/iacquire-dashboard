"use client";

import * as React from "react";
import Link from "next/link";
import { ListTodo, MessageSquareHeart, MessageSquareText } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { RelativeTime } from "@/components/crm/relative-time";
import { FOLLOW_UP_LABELS, FOLLOW_UP_TONES } from "@/components/crm/reviews/model";
import { RatingStars } from "@/components/crm/reviews/review-lists";
import type { CrmScope } from "@/server/crm/page";
import type { ContactFeedbackItem, ContactReputationView } from "@/server/reputation/feedback";

// What this customer privately told the business, on their contact profile. It shows private feedback only: nothing here is a public review, and nothing links what
// someone said privately to what they may have posted on a review site.

const SHOWN = 3;

function Score({ f }: { f: ContactFeedbackItem }) {
  if (f.scale === "nps10") return <span className="text-[13px] font-medium text-ink">{f.npsScore === null ? "No score" : `${f.npsScore} of 10`}</span>;
  return <RatingStars rating={f.rating} />;
}

export function ContactFeedbackCard({ scope, view }: { scope: CrmScope; view: ContactReputationView }) {
  const shown = view.feedback.slice(0, SHOWN);
  const open = view.open;
  return (
    <section aria-labelledby="contact-feedback" className="rounded-2xl border border-line bg-surface p-4">
      <h2 id="contact-feedback" className="flex items-center gap-1.5 text-[14px] font-semibold"><MessageSquareHeart className="size-4 text-muted" aria-hidden />Private feedback</h2>
      {open && (
        <div role="status" className="mt-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5 text-[13px] leading-relaxed text-warning-ink">
          <p className="font-medium">{open.followUpStatus === "acknowledged" ? "Low feedback was acknowledged and is being followed up" : "Low feedback is waiting for a follow-up"}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {open.taskId && <Link href={`${scope.base}/tasks?task=${open.taskId}`} className="inline-flex min-h-8 items-center gap-1 font-medium underline underline-offset-2"><ListTodo className="size-3.5" aria-hidden />Follow-up task</Link>}
            {open.conversationId && !scope.agency && <Link href={`/inbox?c=${open.conversationId}`} className="inline-flex min-h-8 items-center gap-1 font-medium underline underline-offset-2"><MessageSquareText className="size-3.5" aria-hidden />Open in the inbox</Link>}
          </div>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="mt-2 text-[14px] text-muted">No private feedback from this person yet.</p>
      ) : (
        <ul className="mt-2 space-y-2.5" aria-label="Latest private feedback">
          {shown.map((f) => (
            <li key={f.id} className="rounded-xl bg-surface-2/70 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Score f={f} />
                {f.lowScore && <Badge tone="warning">Low</Badge>}
                <Badge tone={FOLLOW_UP_TONES[f.followUpStatus]}>{FOLLOW_UP_LABELS[f.followUpStatus]}</Badge>
              </div>
              {f.comment && <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{f.comment}</p>}
              <p className="mt-1 text-[12px] text-muted">
                <RelativeTime iso={f.receivedAt} timezone={scope.timezone} />
                {f.resolvedAt ? <> · resolved <RelativeTime iso={f.resolvedAt} timezone={scope.timezone} />{f.resolutionNote ? `: ${f.resolutionNote}` : ""}</> : null}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2.5 text-[12px] leading-relaxed text-muted">
        Private to your team; never published or counted as a review.{" "}
        {view.total > shown.length ? <Link href={`${scope.base}/reviews?tab=feedback&filter=all`} className="font-medium text-primary hover:underline">See all {view.total} in Reviews</Link> : null}
      </p>
    </section>
  );
}
