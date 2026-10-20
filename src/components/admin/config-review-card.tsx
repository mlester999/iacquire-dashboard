"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Info, ShieldAlert, XCircle } from "lucide-react";
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
  const [pending, setPending] = React.useState(false);
  const blocked = item.review.decision === "blocked";

  const submit = async () => {
    if (!decision) return;
    setPending(true);
    const res = await decideHeldVersionAction(item.orgId, item.id, decision === "approve", note);
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(decision === "approve" ? "Approved and applied" : "Rejected");
    setDecision(null);
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
            <p className="mt-1 text-[12.5px] text-muted">
              {item.orgName} · submitted by {item.submittedBy}
              {item.submittedByRole ? ` (${item.submittedByRole})` : ""} · {formatDateTime(item.submittedAt, timeZone)}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-line bg-surface-2/60 p-3 text-[12.5px] text-ink-2">
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
                    <p className="text-[13px] font-medium text-ink">
                      {reason.label}
                      <span className="ml-2 text-[11px] font-normal uppercase tracking-wide text-warning-ink">{reason.severity}</span>
                    </p>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{reason.detail}</p>
                    {reason.field && <p className="mt-1 font-mono text-[11px] text-faint">{reason.field}</p>}
                    {reason.match && <p className="mt-1 break-words rounded-lg bg-surface px-2 py-1 text-[12px] text-ink-2">“{reason.match}”</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {item.review.legacyNote && (
            <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 p-3 text-[12.5px] text-muted">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> {item.review.legacyNote}
            </p>
          )}

          {item.review.diff.length > 0 && (
            <div className="space-y-2">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Proposed changes</p>
              <div className="scrollbar-thin max-h-80 overflow-auto rounded-xl border border-line">
                {item.review.diff.map((change) => (
                  <div key={change.key} className="border-b border-line px-3 py-2.5 last:border-b-0">
                    <p className="text-[12.5px] font-medium text-ink">{change.label}</p>
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

          {!canDecide && (
            <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 p-3 text-[12.5px] text-muted">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> You can view this review, but your agency role can&apos;t decide it.
            </p>
          )}

          {canDecide && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setDecision("approve")} disabled={blocked}>
                <CheckCircle2 className="size-4" /> Approve &amp; apply
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDecision("reject")}>
                <XCircle className="size-4" /> Reject
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={decision !== null}
        onOpenChange={(open) => !open && setDecision(null)}
        title={decision === "approve" ? `Approve configuration v${item.version}?` : `Reject configuration v${item.version}?`}
        description={
          blocked && decision === "approve"
            ? "This version contains blocked content and cannot be approved."
            : "The decision and reason are recorded in the audit trail."
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDecision(null)} disabled={pending}>
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
        <label htmlFor={`review-note-${item.id}`} className="text-[13px] font-medium text-ink-2">
          Reason for the decision <span className="font-normal text-muted">(optional, recorded in the audit log)</span>
        </label>
        <Textarea
          id={`review-note-${item.id}`}
          className="mt-2"
          rows={3}
          maxLength={300}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={decision === "approve" ? "e.g. Reviewed the diff; the change is safe." : "e.g. This removes an approval guardrail; please revise."}
        />
      </Dialog>
    </>
  );
}
