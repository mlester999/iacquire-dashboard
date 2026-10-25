"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, FileText, Info, ShieldAlert, UserRound, XCircle } from "lucide-react";
import { decideHeldVersionAction } from "@/app/(admin)/admin/actions";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { configSourceLabel, type ReviewVersionView } from "@/lib/config-review";
import { formatDateTime } from "@/lib/utils";

export function ConfigReviewCard({
  item,
  timeZone = "UTC",
  canDecide,
}: {
  item: ReviewVersionView;
  timeZone?: string;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] = React.useState<"approve" | "reject" | null>(null);
  const [note, setNote] = React.useState("");
  const [noteError, setNoteError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const blocked = item.review.decision === "blocked";

  const choose = (next: "approve" | "reject" | null) => {
    setDecision(next);
    setNoteError(null);
    setActionError(null);
  };

  const submit = async () => {
    if (!decision) return;
    if (note.trim().length < 5) {
      setNoteError("Add a short reason for this decision (at least 5 characters).");
      return;
    }
    setPending(true);
    setActionError(null);
    const res = await decideHeldVersionAction(item.orgId, item.id, decision === "approve", note.trim());
    setPending(false);
    if (!res.ok) {
      setActionError(res.error);
      toast.error(res.error);
      return;
    }
    toast.success(decision === "approve" ? "Approved and applied" : "Not approved");
    choose(null);
    setNote("");
    router.refresh();
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-[15px]">{item.agentName} · configuration v{item.version}</CardTitle>
              <Badge tone={blocked ? "danger" : "warning"}>{blocked ? "Blocked" : "Review required"}</Badge>
              <Badge tone="neutral">{configSourceLabel(item.source, item.orgKind)}</Badge>
            </div>
            <p className="mt-1 text-[13px] text-muted">
              {item.orgName} · submitted by {item.submittedBy}
              {item.submittedByRole ? ` (${item.submittedByRole})` : ""} · {formatDateTime(item.submittedAt, timeZone)}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-5 gap-y-3 rounded-xl border border-line bg-surface p-3.5 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">Client organization</dt>
              <dd className="mt-0.5 font-medium text-ink">{item.orgName}</dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">AI employee</dt>
              <dd className="mt-0.5 font-medium text-ink">{item.agentName}</dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">Proposed version</dt>
              <dd className="mt-0.5 font-medium text-ink">v{item.version}</dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">Submitted by</dt>
              <dd className="mt-0.5 text-ink-2">
                <UserRound className="mr-1 inline size-3.5 text-faint" aria-hidden />
                {item.submittedBy}{item.submittedByRole ? ` · ${item.submittedByRole}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">Submitted</dt>
              <dd className="mt-0.5 text-ink-2">{formatDateTime(item.submittedAt, timeZone)}</dd>
            </div>
            <div>
              <dt className="text-[12px] font-medium uppercase tracking-[.1em] text-faint">Current applied configuration</dt>
              <dd className="mt-0.5 text-ink-2">{item.appliedVersion ? `v${item.appliedVersion} remains active` : "No configuration is currently applied"}</dd>
            </div>
          </dl>

          <div className="rounded-xl border border-line bg-surface-2/60 p-3 text-[13px] text-ink-2">
            <p className="font-medium text-ink">{item.summary}</p>
            {item.changeRequest && <p className="mt-1 italic">Request: “{item.changeRequest}”</p>}
          </div>

          {item.review.reasons.length > 0 && (
            <div className="space-y-2">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Why it was flagged</p>
              {item.review.reasons.map((reason) => (
                <div key={`${reason.code}-${reason.field}`} className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft/30 p-3">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-ink">
                      {reason.label}
                      <span className="ml-2 text-[12px] font-normal uppercase tracking-wide text-warning-ink">{reason.severity === "block" ? "Blocked" : "Review required"}</span>
                    </p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{reason.detail}</p>
                    {reason.field && <p className="mt-1 font-mono text-[12px] text-faint">{reason.field}</p>}
                    {reason.match && <p className="mt-1 break-words rounded-lg bg-surface px-2 py-1 text-[12px] text-ink-2">“{reason.match}”</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {item.review.legacyNote && (
            <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 p-3 text-[13px] text-muted">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> {item.review.legacyNote}
            </p>
          )}

          {item.review.diff.length > 0 && (
            <div className="space-y-2">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Proposed changes</p>
              <div className="scrollbar-thin max-h-80 overflow-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Proposed configuration changes">
                {item.review.diff.map((change) => (
                  <div key={change.key} className="border-b border-line px-3 py-2.5 last:border-b-0">
                    <p className="text-[13px] font-medium text-ink">{change.label}</p>
                    <div className="mt-1 grid gap-1 text-[12px] sm:grid-cols-2">
                      <p className="whitespace-pre-wrap rounded-lg bg-surface-2 px-2 py-1 text-muted">
                        <span className="font-medium text-faint">Before: </span>{change.before}
                      </p>
                      <p className="whitespace-pre-wrap rounded-lg bg-primary-soft/40 px-2 py-1 text-ink-2">
                        <span className="font-medium text-primary-ink">After: </span>{change.after}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {canDecide && item.compiledInstructions && (
            <details className="group rounded-xl border border-line bg-surface">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-[13px] font-medium text-ink-2">
                <span className="flex items-center gap-2"><FileText className="size-4 text-faint" aria-hidden /> Compiled instruction evidence</span>
                <span className="text-[12px] text-faint">Authorized reviewers only</span>
              </summary>
              <div className="border-t border-line p-3">
                <p className="mb-2 text-[12px] leading-relaxed text-muted">
                  This is the exact instruction the employee would receive if this version were applied. Credential-like values are redacted.
                </p>
                <pre tabIndex={0} className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2.5 font-mono text-[12px] leading-relaxed text-ink-2">{item.compiledInstructions}</pre>
                {item.compiledInstructionsTruncated && <p className="mt-2 text-[12px] text-warning-ink">The preview is truncated for the browser. The full compiled instructions remain stored with the version.</p>}
              </div>
            </details>
          )}

          {!canDecide && (
            <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 p-3 text-[13px] text-muted">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> You can view this review, but your agency role can&apos;t decide it.
            </p>
          )}

          {canDecide && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => choose("approve")} disabled={blocked}>
                <CheckCircle2 className="size-4" /> Approve &amp; apply
              </Button>
              <Button size="sm" variant="secondary" onClick={() => choose("reject")}>
                <XCircle className="size-4" /> Reject
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={decision !== null}
        onOpenChange={(open) => !open && choose(null)}
        title={decision === "approve" ? `Approve configuration v${item.version}?` : `Reject configuration v${item.version}?`}
        description={
          blocked && decision === "approve"
            ? "This version contains blocked content and cannot be approved."
            : item.appliedVersion
              ? `Your decision and note are recorded in the audit trail. Configuration v${item.appliedVersion} remains active until an approval is applied.`
              : "Your decision and note are recorded in the audit trail. No configuration is currently applied."
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => choose(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={decision === "reject" ? "secondary" : "brand"}
              onClick={submit}
              loading={pending}
              disabled={blocked && decision === "approve"}
            >
              {decision === "approve" ? "Approve & apply" : "Reject"}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {actionError && (
            <p role="alert" className="rounded-xl border border-danger/25 bg-danger-soft/40 p-2.5 text-[13px] text-danger-ink">{actionError}</p>
          )}
          <label htmlFor={`review-note-${item.id}`} className="flex flex-wrap items-baseline justify-between gap-2 text-[14px] font-medium text-ink-2">
            <span>Reason for the decision <span className="text-danger-ink">(required)</span></span>
            <span className="text-[12px] font-normal text-faint">{note.length}/300</span>
          </label>
          <p id={`review-note-help-${item.id}`} className="text-[12px] leading-relaxed text-muted">
            Explain what you checked and why this decision is safe. At least 5 characters. The note is recorded in the audit trail.
          </p>
          <Textarea
            id={`review-note-${item.id}`}
            rows={3}
            maxLength={300}
            value={note}
            aria-invalid={Boolean(noteError)}
            aria-describedby={`review-note-help-${item.id}${noteError ? ` review-note-error-${item.id}` : ""}`}
            onChange={(event) => {
              setNote(event.target.value);
              if (noteError) setNoteError(null);
            }}
            placeholder={decision === "approve" ? "e.g. Reviewed the diff; the change is safe and keeps the approval guardrail." : "e.g. This removes an approval guardrail; please revise and resubmit."}
          />
          {noteError && (
            <p id={`review-note-error-${item.id}`} role="alert" className="text-[13px] text-danger-ink">{noteError}</p>
          )}
        </div>
      </Dialog>
    </>
  );
}
