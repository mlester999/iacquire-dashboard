"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { isManualPublish, statusExplain } from "@/lib/social/state";
import { httpsUrl, LINK_NOT_HTTPS } from "@/lib/social/links";
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
  /** Set when the schedule box was started on a day chosen in the calendar ("Friday, October 30"): said beside the box so the date is not a surprise. */
  defaultWhenDay?: string | null;
  accountReady: boolean;
  /** The account is a real (Meta) one and publishing to real accounts is switched off here: scheduled posts wait, and nothing says "sent". */
  liveBlocked?: boolean;
  /** The account is a test account: nothing it publishes leaves the product. */
  testAccount?: boolean;
  /** Why this person cannot approve this post (the server's rule, see approveBlockedReason), or null when they can. */
  approveBlock?: string | null;
}

const HELD_TOAST = "It will be sent once publishing to real accounts is switched on.";

export function PostActions({ post, job, tz, can, needsApproval, defaultWhen, defaultWhenDay, accountReady, liveBlocked = false, testAccount = false, approveBlock = null }: PostActionsProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [when, setWhen] = React.useState(post.scheduledAt ? toLocalInput(post.scheduledAt, tz) : defaultWhen);
  const [note, setNote] = React.useState("");
  const [found, setFound] = React.useState("");
  const [foundSeen, setFoundSeen] = React.useState(false);
  const [confirm, setConfirm] = React.useState<null | "cancel" | "reject">(null);
  const s = post.status;
  const blocking = post.problems.filter((p) => p.level === "blocking");
  const unknownOutcome = s === "needs_reconciliation" || (s === "failed" && post.failureCode === "unknown_outcome");
  // A post whose try did not work waits in the queue for the next one. Until that starts it can still be cancelled, changed or moved; the server decides, and
  // refuses one that may already have been sent.
  const waiting = s === "publishing" && job?.status === "queued";
  // A link typed in by a person is shown only if it is a real https address, whenever it was stored.
  const viewLink = httpsUrl(post.permalink, 2000);
  const manual = isManualPublish(post.providerPostId);
  const foundProblem = found.trim() && !httpsUrl(found) ? LINK_NOT_HTTPS : null;

  const duplicate = async () => {
    const r = await run("dup", () => duplicatePostAction(post.id), "A copy was saved as a draft.");
    if (r) router.push(`/social/posts/${(r as { id: string }).id}`);
  };

  const scheduleControls = (verb: "Schedule" | "Reschedule") => (
    <div className="space-y-3">
      {liveBlocked && (
        <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <span>Publishing to real Facebook and Instagram accounts is switched off in this environment. A post scheduled here will wait, and nothing is sent until iAcquire switches it on.</span>
        </p>
      )}
      <Field label={verb === "Schedule" ? "Publish at" : "Move to"} htmlFor="sp-when" hint={`In your workspace's time zone (${tz.replace(/_/g, " ")}).${defaultWhenDay && !post.scheduledAt ? ` Starts on ${defaultWhenDay}, the day you chose in the calendar. Nothing is scheduled until you press Schedule.` : ""}`}>
        <Input id="sp-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="text-[16px] sm:text-[14px]" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="brand" loading={busy("schedule")} disabled={!when || !accountReady || blocking.length > 0} onClick={() => run("schedule", () => (verb === "Schedule" ? scheduleAction(post.id, { atLocal: when }) : rescheduleAction(post.id, { atLocal: when })), verb === "Schedule" ? (liveBlocked ? `Scheduled. ${HELD_TOAST}` : "Scheduled.") : "Moved.")}>{verb}</Button>
        {verb === "Schedule" && <Button variant="secondary" loading={busy("asap")} disabled={!accountReady || blocking.length > 0} onClick={() => run("asap", () => scheduleAction(post.id, { asap: true }), liveBlocked ? `Queued. ${HELD_TOAST}` : "Queued to publish now.")}>Publish as soon as possible</Button>}
      </div>
      {!accountReady && <p className="text-[13px] text-warning-ink">This account needs to be reconnected before anything can be published to it.</p>}
      {blocking.length > 0 && <p className="text-[13px] text-danger-ink">Fix the problems listed beside the text first.</p>}
    </div>
  );

  return (
    <section aria-label="Status and actions" className="space-y-4 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s} providerPostId={post.providerPostId} liveBlocked={liveBlocked} testAccount={testAccount} />
        {post.origin === "ai" && <span className="rounded bg-violet-soft px-1.5 py-0.5 text-[12px] font-semibold text-violet-ink">AI-written draft</span>}
        {testAccount && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[12px] font-semibold text-ink-2">Test account: nothing is posted anywhere</span>}
        <span className="text-[13px] text-muted">Version {post.version}</span>
      </div>
      <p className="text-[14px] text-ink-2">{statusExplain(s, { providerPostId: post.providerPostId, liveBlocked, testAccount })}</p>
      {post.scheduledAt && ["scheduled", "publishing"].includes(s) && <p className="text-[14px] text-ink"><span className="font-medium">Planned for</span> {formatWhen(post.scheduledAt, tz)}</p>}
      {post.approvedByName && post.approvedVersion === post.version && <p className="text-[13px] text-muted">Approved by {post.approvedByName}{post.approvedAt ? `, ${formatWhen(post.approvedAt, tz)}` : ""}.</p>}
      {post.decisionNote && (s === "changes_requested" || s === "rejected") && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink"><span className="font-semibold">Reviewer&apos;s note: </span>{post.decisionNote}</p>}
      {post.failureMessage && (s === "failed" || s === "needs_reconciliation") && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[14px] text-danger-ink">{post.failureMessage}</p>}
      {job && s === "publishing" && <p className="text-[13px] text-muted">Attempt {job.attempt} of {job.maxAttempts}{job.nextAttemptAt ? `; next try ${formatWhen(job.nextAttemptAt, tz)}` : ""}{job.lastError ? `. Last problem: ${job.lastError}` : ""}</p>}
      {s === "published" && viewLink && !testAccount && (
        <a href={viewLink} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-primary-ink underline sm:min-h-8">
          View the post{manual ? " (link typed in by a person)" : ""} <ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">(opens in a new tab)</span>
        </a>
      )}

      {(s === "draft" || s === "changes_requested") && !can.edit && (
        <p className="border-t border-line pt-4 text-[14px] text-muted">Only the person who wrote this post, or a manager, can send it for approval.</p>
      )}
      {(s === "draft" || s === "changes_requested") && can.edit && (
        <div className="space-y-3 border-t border-line pt-4">
          {blocking.length > 0 && <p className="text-[13px] text-danger-ink">Fix the problems listed beside the text before sending it on.</p>}
          {!needsApproval && can.publish ? (
            <>
              <p className="text-[13px] text-muted">You can schedule your own post. It is recorded as approved by you.</p>
              {scheduleControls("Schedule")}
            </>
          ) : (
            <>
              <Button variant="brand" loading={busy("submit")} disabled={blocking.length > 0 || !accountReady} onClick={() => run("submit", () => submitForApprovalAction(post.id), "Sent for approval.")}>Send for approval</Button>
              {!accountReady && <p className="text-[13px] text-warning-ink">This account needs to be reconnected before the post can be sent for approval.</p>}
            </>
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
                {!approveBlock && <Button variant="brand" loading={busy("approve")} disabled={blocking.length > 0} onClick={() => run("approve", () => decideAction(post.id, { decision: "approve", version: post.version, note: note || null }), "Approved.")}>Approve</Button>}
                <Button variant="secondary" loading={busy("changes")} disabled={!note.trim()} onClick={() => run("changes", () => decideAction(post.id, { decision: "request_changes", version: post.version, note }), "Changes requested.")}>Request changes</Button>
                <Button variant="outline" onClick={() => setConfirm("reject")}>Reject</Button>
              </div>
              {approveBlock && <p className="text-[13px] text-muted">{approveBlock}</p>}
              {!approveBlock && blocking.length > 0 && <p className="text-[13px] text-danger-ink">This post has problems that would stop it being published. Ask for changes instead.</p>}
            </>
          ) : (
            <p className="text-[14px] text-muted">{approveBlock ?? "Only the business owner or a manager can approve it."}</p>
          )}
        </div>
      )}

      {s === "approved" && (can.publish ? <div className="border-t border-line pt-4">{scheduleControls("Schedule")}</div> : <p className="border-t border-line pt-4 text-[14px] text-muted">Approved. Someone who can publish needs to schedule it.</p>)}

      {(s === "scheduled" || waiting) && can.publish && <div className="border-t border-line pt-4">{scheduleControls("Reschedule")}</div>}

      {unknownOutcome && (
        <div className="space-y-3 border-t border-line pt-4">
          {can.publish ? (
            <>
              <p className="text-[14px] text-ink-2">Open the Page and look for this post, then tell us. It will not be sent again until you do.</p>
              <Field label="Link to the post" htmlFor="sp-link-found" optional hint="Only if it is there. It is shown as a link a person typed in; the platform is not asked to confirm it." error={foundSeen ? foundProblem : null}>
                <Input id="sp-link-found" type="url" inputMode="url" value={found} onChange={(e) => setFound(e.target.value)} onBlur={() => setFoundSeen(true)} placeholder="https://" aria-invalid={foundSeen && foundProblem ? true : undefined} className="text-[16px] sm:text-[14px]" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={busy("posted")} disabled={Boolean(foundProblem)} onClick={() => run("posted", () => resolveUnknownAction(post.id, "posted", found.trim() || null), "Marked as posted.")}>It is on the Page</Button>
                <Button variant="outline" loading={busy("notposted")} onClick={() => run("notposted", () => resolveUnknownAction(post.id, "not_posted"), "Marked as not posted.")}>It is not there</Button>
              </div>
            </>
          ) : <p className="text-[14px] text-muted">A manager needs to check the Page and say whether it was posted.</p>}
        </div>
      )}

      {s === "failed" && !unknownOutcome && (
        <div className="space-y-2 border-t border-line pt-4">
          {can.publish && post.approvedVersion === post.version && accountReady && <Button variant="brand" loading={busy("retry")} onClick={() => run("retry", () => retryPostAction(post.id), liveBlocked ? `Queued. ${HELD_TOAST}` : "Queued to try again.")}>Try again</Button>}
          {can.publish && post.approvedVersion === post.version && !accountReady && <p className="text-[13px] text-warning-ink">Reconnect the account before trying again.</p>}
          <p className="text-[13px] text-muted">Or edit the post, which sends it back to a draft for approval again.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {can.create && <Button variant="outline" size="sm" loading={busy("dup")} onClick={duplicate}>Duplicate</Button>}
        {can.edit && (["draft", "pending_approval", "changes_requested", "approved", "scheduled", "failed"].includes(s) || waiting) && !unknownOutcome && <Button variant="ghost" size="sm" onClick={() => setConfirm("cancel")}>Cancel post</Button>}
      </div>
      {s === "publishing" && !waiting && <p className="text-[13px] text-muted">While a post is being sent it cannot be changed or cancelled.</p>}
      {waiting && <p className="text-[13px] text-muted">This post is waiting for its next try. Until that starts you can cancel it, change it (which sends it back to a draft for approval) or move it to another time. If it is being sent at that moment you will be told it is too late.</p>}

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
