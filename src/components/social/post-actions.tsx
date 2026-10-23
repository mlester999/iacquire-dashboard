"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { STATUS_EXPLAIN } from "@/lib/social/state";
import { cancelPostAction, decideAction, duplicatePostAction, rescheduleAction, resolveUnknownAction, retryPostAction, scheduleAction, submitForApprovalAction } from "@/app/actions/social";
import type { JobSummary, PostView } from "@/server/social/posts";
import { formatWhen, toLocalInput } from "@/lib/social/calendar";
import { StatusBadge } from "@/components/social/status";

// What a person can do with a post right now. The server decides every one of these again; this only offers what the status and the person's role allow, and
// says why when something is not offered. A post that may already be live is never offered a blind retry.

export interface PostActionsProps {
  post: PostView;
  job: JobSummary | null;
  tz: string;
  /** What this person may do. */
  can: { create: boolean; approve: boolean; publish: boolean; edit: boolean };
  /** Whether this post needs a reviewer before it can be scheduled (an AI draft always does). */
  needsApproval: boolean;
  /** A reasonable first time to offer, as a datetime-local value in the workspace's zone. */
  defaultWhen: string;
  accountReady: boolean;
}

export function PostActions({ post, job, tz, can, needsApproval, defaultWhen, accountReady }: PostActionsProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [when, setWhen] = React.useState(post.scheduledAt ? toLocalInput(post.scheduledAt, tz) : defaultWhen);
  const [note, setNote] = React.useState("");
  const [permalink, setPermalink] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "cancel" | "reject">(null);
  const s = post.status;
  const blocking = post.problems.filter((p) => p.level === "blocking");
  const unknownOutcome = s === "needs_reconciliation" || (s === "failed" && post.failureCode === "unknown_outcome");

  const duplicate = async () => {
    const r = await run("dup", () => duplicatePostAction(post.id), "A copy was saved as a draft.");
    if (r) router.push(`/social/posts/${(r as { id: string }).id}`);
  };

  const scheduleControls = (verb: "Schedule" | "Reschedule") => (
    <div className="space-y-3">
      <Field label={verb === "Schedule" ? "Publish at" : "Move to"} htmlFor="sp-when" hint={`In your workspace's time zone (${tz.replace(/_/g, " ")}).`}>
        <Input id="sp-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="text-[16px] sm:text-[14px]" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="brand" loading={busy("schedule")} disabled={!when || !accountReady || blocking.length > 0} onClick={() => run("schedule", () => (verb === "Schedule" ? scheduleAction(post.id, { atLocal: when }) : rescheduleAction(post.id, { atLocal: when })), verb === "Schedule" ? "Scheduled." : "Moved.")}>{verb}</Button>
        {verb === "Schedule" && <Button variant="secondary" loading={busy("asap")} disabled={!accountReady || blocking.length > 0} onClick={() => run("asap", () => scheduleAction(post.id, { asap: true }), "Queued to publish now.")}>Publish as soon as possible</Button>}
      </div>
      {!accountReady && <p className="text-[12.5px] text-warning-ink">This account needs to be reconnected before anything can be published to it.</p>}
      {blocking.length > 0 && <p className="text-[12.5px] text-danger-ink">Fix the problems listed beside the text first.</p>}
    </div>
  );

  return (
    <section aria-label="Status and actions" className="space-y-4 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s} />
        {post.origin === "ai" && <span className="rounded bg-violet-soft px-1.5 py-0.5 text-[11px] font-semibold text-violet-ink">AI-written draft</span>}
        <span className="text-[12.5px] text-muted">Version {post.version}</span>
      </div>
      <p className="text-[13.5px] text-ink-2">{STATUS_EXPLAIN[s]}</p>
      {post.scheduledAt && ["scheduled", "publishing"].includes(s) && <p className="text-[13.5px] text-ink"><span className="font-medium">Planned for</span> {formatWhen(post.scheduledAt, tz)}</p>}
      {post.approvedByName && post.approvedVersion === post.version && <p className="text-[12.5px] text-muted">Approved by {post.approvedByName}{post.approvedAt ? `, ${formatWhen(post.approvedAt, tz)}` : ""}.</p>}
      {post.decisionNote && (s === "changes_requested" || s === "rejected") && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink"><span className="font-semibold">Reviewer&apos;s note: </span>{post.decisionNote}</p>}
      {post.failureMessage && (s === "failed" || s === "needs_reconciliation") && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{post.failureMessage}</p>}
      {job && s === "publishing" && <p className="text-[12.5px] text-muted">Attempt {job.attempt} of {job.maxAttempts}{job.nextAttemptAt ? `; next try ${formatWhen(job.nextAttemptAt, tz)}` : ""}{job.lastError ? `. Last problem: ${job.lastError}` : ""}</p>}
      {s === "published" && post.permalink && <a href={post.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-[13.5px] font-medium text-primary-ink underline sm:min-h-8">View the post <ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">(opens in a new tab)</span></a>}

      {(s === "draft" || s === "changes_requested") && can.create && (
        <div className="space-y-3 border-t border-line pt-4">
          {blocking.length > 0 && <p className="text-[12.5px] text-danger-ink">Fix the problems listed beside the text before sending it on.</p>}
          {!needsApproval && can.publish ? (
            <>
              <p className="text-[12.5px] text-muted">You can schedule your own post. It is recorded as approved by you.</p>
              {scheduleControls("Schedule")}
            </>
          ) : (
            <Button variant="brand" loading={busy("submit")} disabled={blocking.length > 0 || !accountReady} onClick={() => run("submit", () => submitForApprovalAction(post.id), "Sent for approval.")}>Send for approval</Button>
          )}
        </div>
      )}

      {s === "pending_approval" && (
        <div className="space-y-3 border-t border-line pt-4">
          {can.approve ? (
            <>
              <Field label="Note to the writer" htmlFor="sp-note" optional hint="Required when you ask for changes.">
                <Textarea id="sp-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="text-[16px] sm:text-[14px]" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="brand" loading={busy("approve")} disabled={blocking.length > 0} onClick={() => run("approve", () => decideAction(post.id, { decision: "approve", version: post.version, note: note || null }), "Approved.")}>Approve</Button>
                <Button variant="secondary" loading={busy("changes")} disabled={!note.trim()} onClick={() => run("changes", () => decideAction(post.id, { decision: "request_changes", version: post.version, note }), "Changes requested.")}>Request changes</Button>
                <Button variant="outline" onClick={() => setConfirm("reject")}>Reject</Button>
              </div>
              {blocking.length > 0 && <p className="text-[12.5px] text-danger-ink">This post has problems that would stop it being published. Ask for changes instead.</p>}
            </>
          ) : (
            <p className="text-[13px] text-muted">Only the business owner or a manager can approve it.</p>
          )}
        </div>
      )}

      {s === "approved" && (can.publish ? <div className="border-t border-line pt-4">{scheduleControls("Schedule")}</div> : <p className="border-t border-line pt-4 text-[13px] text-muted">Approved. Someone who can publish needs to schedule it.</p>)}

      {s === "scheduled" && can.publish && <div className="border-t border-line pt-4">{scheduleControls("Reschedule")}</div>}

      {unknownOutcome && (
        <div className="space-y-3 border-t border-line pt-4">
          {can.publish ? (
            <>
              <p className="text-[13px] text-ink-2">Open the Page and look for this post, then tell us. It will not be sent again until you do.</p>
              <Field label="Link to the post" htmlFor="sp-link-found" optional hint="Only if it is there.">
                <Input id="sp-link-found" type="url" inputMode="url" value={permalink} onChange={(e) => setPermalink(e.target.value)} placeholder="https://" className="text-[16px] sm:text-[14px]" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={busy("posted")} onClick={() => run("posted", () => resolveUnknownAction(post.id, "posted", permalink || null), "Marked as posted.")}>It is on the Page</Button>
                <Button variant="outline" loading={busy("notposted")} onClick={() => run("notposted", () => resolveUnknownAction(post.id, "not_posted"), "Marked as not posted.")}>It is not there</Button>
              </div>
            </>
          ) : <p className="text-[13px] text-muted">A manager needs to check the Page and say whether it was posted.</p>}
        </div>
      )}

      {s === "failed" && !unknownOutcome && (
        <div className="space-y-2 border-t border-line pt-4">
          {can.publish && post.approvedVersion === post.version && accountReady && <Button variant="brand" loading={busy("retry")} onClick={() => run("retry", () => retryPostAction(post.id), "Queued to try again.")}>Try again</Button>}
          {can.publish && post.approvedVersion === post.version && !accountReady && <p className="text-[12.5px] text-warning-ink">Reconnect the account before trying again.</p>}
          <p className="text-[12.5px] text-muted">Or edit the post, which sends it back to a draft for approval again.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {can.create && <Button variant="outline" size="sm" loading={busy("dup")} onClick={duplicate}>Duplicate</Button>}
        {can.edit && ["draft", "pending_approval", "changes_requested", "approved", "scheduled", "failed"].includes(s) && !unknownOutcome && <Button variant="ghost" size="sm" onClick={() => setConfirm("cancel")}>Cancel post</Button>}
      </div>
      {s === "publishing" && <p className="text-[12.5px] text-muted">While a post is being sent it cannot be changed or cancelled.</p>}

      <ConfirmDialog
        open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)} title="Cancel this post?" description="It will not be published. You can duplicate it later to use the text again."
        confirmLabel="Cancel post" danger loading={busy("cancel")} onConfirm={async () => { await run("cancel", () => cancelPostAction(post.id), "Post cancelled."); setConfirm(null); }}
      />
      <ConfirmDialog
        open={confirm === "reject"} onOpenChange={(o) => !o && setConfirm(null)} title="Reject this post?" description="It will not be published, and the writer is told. They can duplicate it to try again."
        confirmLabel="Reject" danger loading={busy("reject")} onConfirm={async () => { await run("reject", () => decideAction(post.id, { decision: "reject", version: post.version, note: note || null }), "Rejected."); setConfirm(null); }}
      />
    </section>
  );
}
