"use client";

import * as React from "react";
import { Bot, CheckCircle2, Info, Send, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Textarea } from "@/components/ui/primitives";
import { RelativeTime } from "@/components/crm/relative-time";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { RatingStars } from "@/components/crm/reviews/review-lists";
import {
  cancelReplyAction, decideReplyAction, draftReplyWithAiAction, editReplyAction, postReplyAction, resolveReplyAction, startReplyAction, submitReplyAction,
} from "@/app/actions/reputation";
import { REPLY_LONG_CHARS, REPLY_MAX_CHARS, cleanReplyBody, replyProblems, replyWarnings } from "@/lib/reputation/reply-rules";
import { REPLY_STATUS_EXPLAIN, REPLY_STATUS_LABELS, eventLabel, replyAbilities, type ReplyStatus } from "@/lib/reputation/reply-state";
import type { PublicReviewView, ReplyFacts, ReplyView } from "@/server/reputation/public-reviews";

// The reply to one public review: the words, the rules they are held to as they are typed, the steps a reply goes through, and exactly who may do each. The server decides all of
// it again; this only shows what it will accept. A reply is never posted by itself: a person with the right presses Post, after a person with the right approved those exact words.

export const REPLY_TONES: Record<ReplyStatus, "neutral" | "primary" | "success" | "warning" | "danger"> = {
  draft: "neutral", pending_approval: "primary", changes_requested: "warning", approved: "success", posting: "primary", posted: "success", failed: "danger", needs_reconciliation: "warning", rejected: "danger", cancelled: "neutral",
};

const KNOWLEDGE_TITLES: Record<string, string> = { business_description: "business description", customer_service: "customer service", policies: "policies", brand_voice: "brand voice" };

export function ReplyStatusBadge({ status }: { status: ReplyStatus }) {
  return <Badge tone={REPLY_TONES[status]}>{REPLY_STATUS_LABELS[status]}</Badge>;
}

export function ReplyEditor({ orgId, review, facts, enabled, timezone }: { orgId: string | null; review: PublicReviewView; facts: ReplyFacts; enabled: boolean; timezone: string }) {
  const { run, busy } = useCrmAction();
  const reply: ReplyView | null = review.reply;
  const open = reply && !["posted", "rejected", "cancelled"].includes(reply.status) ? reply : null;
  const [body, setBody] = React.useState(open?.body ?? "");
  const [note, setNote] = React.useState("");
  const [asking, setAsking] = React.useState<null | "post" | "cancel" | "reject" | "changes" | "not_posted" | "posted">(null);
  const bodyId = React.useId();
  const noteId = React.useId();
  const ab = replyAbilities({
    reply: reply ? { status: reply.status, version: reply.version, approvedVersion: reply.approvedVersion, authorId: reply.authorId, origin: reply.origin } : null,
    userId: facts.userId, canDraft: facts.canDraft, canPublish: facts.canPublish, canAi: facts.canAi, reviewLive: review.live, postable: review.postable.ok,
    postableReason: review.postable.ok ? null : review.postable.reason, enabled,
  });
  const dirty = open ? cleanReplyBody(body) !== open.body : cleanReplyBody(body) !== "";
  const problems = React.useMemo(() => replyProblems(body), [body]);
  const warnings = React.useMemo(() => replyWarnings(body), [body]);
  const editing = open ? ab.edit : ab.start;
  const siteName = review.providerLabel;
  const long = cleanReplyBody(body).length > REPLY_LONG_CHARS;

  const start = () => run("start", () => startReplyAction(orgId, review.id, body), "Draft saved. Nothing has been posted.");
  const save = () => open && run("save", () => editReplyAction(orgId, open.id, body, open.version), "Changes saved. Any earlier approval was withdrawn.");
  const submit = () => open && run("submit", () => submitReplyAction(orgId, open.id, open.version), "Sent for approval. Nothing has been posted.");
  const withAi = () => run("ai", () => draftReplyWithAiAction(orgId, review.id), (r) => `Draft ready${r.warnings.length ? ", with things to check" : ""}. Read it and change anything before you send it for approval.`);
  const decide = async (decision: "approve" | "request_changes" | "reject") => {
    if (!open) return;
    const ok = await run(decision, () => decideReplyAction(orgId, open.id, decision, open.version, note || null), decision === "approve" ? "Approved. It has not been posted yet." : decision === "reject" ? "Rejected." : "Changes requested.");
    if (ok) {
      setAsking(null);
      setNote("");
    }
  };
  const post = async () => {
    if (!open) return;
    const r = await run("post", () => postReplyAction(orgId, open.id), (x) => (x.status === "posted" ? `Posted to ${siteName}.` : x.status === "needs_reconciliation" ? `${siteName} did not say whether it took the reply. It is being checked and won't be sent again until that is known.` : `${siteName} did not take the reply.`));
    if (r) setAsking(null);
  };
  const cancel = async () => {
    if (!open) return;
    if (await run("cancel", () => cancelReplyAction(orgId, open.id), "Reply cancelled.")) setAsking(null);
  };
  const resolve = async (outcome: "posted" | "not_posted") => {
    if (!open) return;
    if (await run(outcome, () => resolveReplyAction(orgId, open.id, outcome), outcome === "posted" ? "Recorded as posted, on your word." : "Recorded as not posted.")) setAsking(null);
  };

  return (
    <div className="space-y-5 p-5">
      <section aria-label="The review" className="space-y-2 rounded-2xl border border-line bg-surface-2/50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {review.rating !== null ? <RatingStars rating={review.rating} /> : <span className="text-[13px] font-medium text-ink">{review.ratingText}</span>}
          <Badge tone="outline">{review.providerLabel}</Badge>
          {review.simulated && <Badge tone="violet">Simulated</Badge>}
          {review.removedAt && <Badge tone="warning">Removed from the site</Badge>}
        </div>
        <p className="text-[12.5px] text-muted">{review.reviewerName ?? "Anonymous reviewer"} · <RelativeTime iso={review.at} timezone={timezone} /></p>
        {review.comment ? <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{review.comment}</p> : <p className="text-[13px] text-muted">The reviewer wrote no text.</p>}
        {review.providerReply && (
          <div className="rounded-xl border border-line bg-surface p-3">
            <p className="text-[12px] font-medium text-muted">Already answered on {siteName}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{review.providerReply.text}</p>
            <p className="mt-1 text-[12px] text-muted">A reply posted from here may replace this one.</p>
          </div>
        )}
      </section>

      {!enabled && <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">{ab.note}</p>}
      {enabled && ab.note && !open && <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />{ab.note}</p>}

      {reply && (
        <section aria-label="Where the reply stands" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">Your reply</h3>
            <ReplyStatusBadge status={reply.status} />
            {reply.origin === "ai" && <Badge tone="violet"><Bot className="size-3" aria-hidden />AI-drafted</Badge>}
            <span className="text-[12px] text-muted">Version {reply.version}</span>
          </div>
          <p className="text-[13px] leading-relaxed text-ink-2" role="status">{REPLY_STATUS_EXPLAIN[reply.status]}</p>
          {reply.origin === "ai" && reply.ai && (
            <p className="text-[12.5px] leading-relaxed text-muted">
              Written by the AI assist for {reply.authorName ?? "a team member"}, who asked for it. A person still has to read it and approve it.{reply.ai.knowledgeSections.length ? ` It was given only your approved ${reply.ai.knowledgeSections.map((s) => KNOWLEDGE_TITLES[s] ?? s).join(", ")}.` : " It was given no business information, so it can only say thank you."}
            </p>
          )}
          {reply.status === "approved" && reply.approvedByName && <p className="flex items-start gap-1.5 text-[12.5px] text-success-ink"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /><span>Approved by {reply.approvedByName} {reply.approvedAt && <RelativeTime iso={reply.approvedAt} timezone={timezone} />}. These exact words, and nothing else, can be posted.</span></p>}
          {reply.status === "posted" && <p className="flex items-center gap-1.5 text-[12.5px] text-success-ink"><CheckCircle2 className="size-4" aria-hidden />{reply.postedVia === "person" ? "A person said they posted it themselves." : reply.verifiedAt ? `Posted, and ${siteName} shows it.` : `Posted. ${siteName} has not been asked to confirm it yet.`}</p>}
          {reply.decisionNote && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">{reply.decisionNote}</p>}
          {reply.failureMessage && ["failed", "needs_reconciliation"].includes(reply.status) && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{reply.failureMessage}</p>}
          {!open && <p className="whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-[13.5px] leading-relaxed text-ink">{reply.body}</p>}
        </section>
      )}

      {editing && (
        <div className="space-y-3">
          <Field label={open ? "Change the reply" : "Write a reply"} htmlFor={bodyId} hint={`Short, calm and kind. Public replies can't carry links, phone numbers or offers, and never say the reviewer was a customer. ${cleanReplyBody(body).length} of ${REPLY_MAX_CHARS} characters.`}>
            <Textarea id={bodyId} rows={7} value={body} maxLength={5000} aria-invalid={problems.length > 0 && body.trim() !== "" ? true : undefined} aria-describedby={`${bodyId}-rules`} className="text-[16px] sm:text-[14px]" onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div id={`${bodyId}-rules`} aria-live="polite" className="space-y-1.5">
            {body.trim() !== "" && problems.length > 0 && (
              <ul role="alert" className="list-disc space-y-1 rounded-xl bg-danger-soft py-2.5 pl-8 pr-3 text-[13px] text-danger-ink">
                {problems.map((p, i) => <li key={`${p.code}-${i}`}>{p.message}{p.term ? <> (<span className="font-mono text-[12px]">{p.term}</span>)</> : null}</li>)}
              </ul>
            )}
            {warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-warning-ink">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            {long && warnings.length === 0 && <p className="text-[12.5px] text-warning-ink">This is a long reply.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!open ? (
              <>
                <Button loading={busy("start")} disabled={!ab.start || problems.length > 0} onClick={start}>Save as a draft</Button>
                {ab.startWithAi && <Button variant="secondary" loading={busy("ai")} onClick={withAi}><Sparkles className="size-4" aria-hidden />Draft with AI</Button>}
              </>
            ) : (
              <>
                <Button variant="secondary" loading={busy("save")} disabled={!dirty || problems.length > 0} onClick={save}>Save changes</Button>
                {ab.submit && <Button loading={busy("submit")} disabled={dirty} title={dirty ? "Save your changes first." : undefined} onClick={submit}><Send className="size-4" aria-hidden />Send for approval</Button>}
              </>
            )}
          </div>
          {!open && ab.startWithAi && <p className="text-[12px] leading-relaxed text-muted">The AI assist writes one draft from your approved business information. It never sends it for approval, approves it or posts it; you read it first.</p>}
          {!open && facts.canDraft && !facts.canAi && facts.aiEnabled === false && <p className="text-[12px] text-muted">AI drafts are switched off. An owner or manager can switch them on in Settings.</p>}
          {dirty && open && <p className="text-[12px] text-muted">Saving changes withdraws any approval: the owner or a manager approves exactly the words they read.</p>}
        </div>
      )}

      {open && !editing && <p className="whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-[13.5px] leading-relaxed text-ink">{open.body}</p>}
      {open && ab.note && <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />{ab.note}</p>}

      {open && (ab.approve || ab.requestChanges || ab.reject || ab.post || ab.markPosted || ab.markNotPosted || ab.cancel) && (
        <div className="space-y-2 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {ab.approve && <Button variant="brand" loading={busy("approve")} disabled={dirty} title={dirty ? "Save or undo your changes first." : undefined} onClick={() => decide("approve")}><CheckCircle2 className="size-4" aria-hidden />Approve these words</Button>}
            {ab.requestChanges && <Button variant="secondary" disabled={dirty} onClick={() => setAsking("changes")}>Ask for changes</Button>}
            {ab.reject && <Button variant="ghost" disabled={dirty} onClick={() => setAsking("reject")}><XCircle className="size-4" aria-hidden />Reject</Button>}
            {ab.post && <Button variant="brand" disabled={dirty} onClick={() => setAsking("post")}><Send className="size-4" aria-hidden />Post to {siteName}</Button>}
            {ab.markPosted && <Button variant="secondary" onClick={() => setAsking("posted")}>I posted it myself</Button>}
            {ab.markNotPosted && <Button variant="secondary" onClick={() => setAsking("not_posted")}>It is not on {siteName}</Button>}
            {ab.cancel && <Button variant="ghost" onClick={() => setAsking("cancel")}>Cancel this reply</Button>}
          </div>
          {open.status === "approved" && !ab.post && ab.markPosted && <p className="text-[12.5px] leading-relaxed text-muted">Posting from here is not available, so post the approved words on {siteName} yourself, then say so. That is recorded as your word; iAcquire doesn&apos;t check it.</p>}
        </div>
      )}

      {reply && reply.events.length > 0 && (
        <section aria-label="History of this reply" className="space-y-1.5 border-t border-line pt-4">
          <h3 className="text-[13px] font-semibold text-ink">History</h3>
          <ol className="space-y-1 text-[12.5px] text-muted">
            {reply.events.map((e) => (
              <li key={e.id}>{eventLabel(e.kind)}{e.actorName ? ` · ${e.actorName}` : e.actorKind === "ai" ? " · AI assist" : e.actorKind === "system" ? " · automatic" : ""} · <RelativeTime iso={e.at} timezone={timezone} /></li>
            ))}
          </ol>
        </section>
      )}

      <ConfirmDialog open={asking === "post"} onOpenChange={(o) => !o && setAsking(null)} title={`Post this reply to ${siteName}?`} confirmLabel="Post reply" loading={busy("post")} onConfirm={post}
        description={`This posts the exact words below under ${review.connectionName}'s name, where anyone can read them. It can't be taken back from here.`}>
        <p className="whitespace-pre-wrap break-words rounded-xl border border-line bg-surface-2/50 p-3 text-[13.5px] leading-relaxed text-ink">{open?.body}</p>
      </ConfirmDialog>
      <ConfirmDialog open={asking === "cancel"} onOpenChange={(o) => !o && setAsking(null)} title="Cancel this reply?" confirmLabel="Cancel reply" danger loading={busy("cancel")} onConfirm={cancel} description="The words are not posted and the draft is closed. You can start another reply to this review." />
      <ConfirmDialog open={asking === "reject"} onOpenChange={(o) => !o && setAsking(null)} title="Reject this reply?" confirmLabel="Reject" danger loading={busy("reject")} onConfirm={() => decide("reject")} description="It will not be posted. The person who wrote it is told." />
      <ConfirmDialog open={asking === "posted"} onOpenChange={(o) => !o && setAsking(null)} title={`Did you post this on ${siteName}?`} confirmLabel="Yes, I posted it" loading={busy("posted")} onConfirm={() => resolve("posted")} description="This records it as posted on your word. iAcquire doesn't check the review site." />
      <ConfirmDialog open={asking === "not_posted"} onOpenChange={(o) => !o && setAsking(null)} title={`Is it missing from ${siteName}?`} confirmLabel="Yes, it is not there" loading={busy("not_posted")} onConfirm={() => resolve("not_posted")} description="This records the reply as not posted. You can then try again." />
      <ConfirmDialog open={asking === "changes"} onOpenChange={(o) => !o && setAsking(null)} title="Ask for changes" confirmLabel="Send request" loading={busy("request_changes")} confirmDisabled={!note.trim()} onConfirm={() => decide("request_changes")}>
        <Field label="What should change?" htmlFor={noteId}>
          <Textarea id={noteId} rows={3} value={note} maxLength={600} className="text-[16px] sm:text-[14px]" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
