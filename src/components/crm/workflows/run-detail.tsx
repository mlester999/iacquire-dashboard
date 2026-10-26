"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Ban, ExternalLink, RotateCcw, ShieldAlert, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { ConfirmDialog, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { cancelRunAction, retryRunStepAction, skipRunStepAction } from "@/app/actions/crm-workflows";
import { cn, formatDateTime } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import { RunStatusBadge, STEP_STATUS, StepIcon, StepStatusIcon, stepTone } from "@/components/crm/workflows/parts";
import { durationText } from "@/components/crm/workflows/summaries";
import type { RunDetail as RunDetailData } from "@/components/crm/workflows/types";

/** One run from start to now: every step attempt with when it ran, what it did or why it failed, and links to what it touched. */
export function RunDetail({ scope, run: data, canManage }: { scope: CrmScope; run: RunDetailData; canManage: boolean }) {
  const { run, busy } = useCrmAction();
  const [confirm, setConfirm] = React.useState<null | "cancel" | "retry" | "skip">(null);
  const tz = scope.timezone;
  const isTest = data.startedVia === "test";
  const back = `${scope.base}/workflows/${data.workflowId}?tab=runs`;
  const stoppedAt = data.status === "failed" || data.status === "dead" ? data.currentStep : null;

  const lead =
    isTest ? "A dry run: it shows what each step would do. It sent nothing, called nothing outside iAcquire and changed no records."
    : data.status === "awaiting_approval" ? "Paused on a step that asks a person first. It continues once someone approves it in Approvals, and stops if they decline."
    : data.status === "waiting" ? `Waiting${data.waitingUntil ?? data.nextRunAt ? ` until ${formatDateTime(data.waitingUntil ?? data.nextRunAt, tz)}` : ""}. The scheduler picks it up then.`
    : data.status === "queued" ? "Queued: the scheduler runs its next step within a few minutes."
    : data.status === "running" ? "Running its next step now."
    : data.externalUnknown ? "Stopped on a call to an outside system that may or may not have run. It isn't retried, so it can't run twice: check whether it ran there, then skip this step to continue."
    : data.status === "dead" ? "Stopped after repeated failures. Fix the cause, then retry the failed step or skip past it."
    : data.status === "failed" ? "Stopped on a step that can't succeed as it is. Fix the cause, then retry it or skip past it."
    : null;

  return (
    <div className="space-y-5">
      <div>
        <Link href={back} className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-0"><ArrowLeft className="size-4" aria-hidden />{data.workflowName}</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-[20px] font-semibold tracking-[-0.03em] text-ink">
              {isTest ? "Test run" : "Run"}
              <RunStatusBadge status={data.status} test={isTest} />
            </h2>
            {lead && <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">{lead}</p>}
          </div>
          {canManage && !isTest && (data.canCancel || data.canRetry || data.canSkip) && (
            <div className="flex flex-wrap gap-2">
              {data.canRetry && <Button onClick={() => setConfirm("retry")}><RotateCcw className="size-4" aria-hidden />Retry {stoppedAt ? `“${stoppedAt}”` : "the failed step"}</Button>}
              {data.canSkip && <Button variant="secondary" onClick={() => setConfirm("skip")}><SkipForward className="size-4" aria-hidden />Skip it and continue</Button>}
              {data.canCancel && <Button variant="secondary" onClick={() => setConfirm("cancel")}><Ban className="size-4" aria-hidden />Cancel run</Button>}
            </div>
          )}
        </div>
      </div>
      {!canManage && scope.readOnly && <ReadOnlyNotice />}
      {data.status === "awaiting_approval" && !scope.agency && (
        <p className="flex flex-wrap items-center gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink">
          <ShieldAlert className="size-4 shrink-0" aria-hidden />A person needs to approve this step before it acts.
          <Link href="/approvals" className="font-semibold underline underline-offset-2">Open Approvals</Link>
        </p>
      )}

      <Card className="p-0">
        <dl className="grid gap-x-6 gap-y-3 p-4 text-[14px] sm:grid-cols-2 lg:grid-cols-3">
          <Meta label="Contact">
            {data.contactId ? (scope.can["contacts.view"] ? <Link href={`${scope.base}/contacts/${data.contactId}`} className="font-medium text-primary hover:underline">{data.contactName ?? "Open contact"}</Link> : data.contactName ?? "A contact") : "None"}
          </Meta>
          {data.opportunityId && (
            <Meta label="Deal">{scope.can["sales.view"] ? <Link href={`${scope.base}/opportunities/${data.opportunityId}`} className="font-medium text-primary hover:underline">{data.opportunityName ?? "Open deal"}</Link> : data.opportunityName ?? "A deal"}</Meta>
          )}
          <Meta label="Started by">{data.triggerLabel}</Meta>
          <Meta label="Version">{data.version ? `v${data.version}` : "—"}</Meta>
          <Meta label="Started"><time dateTime={data.createdAt}>{formatDateTime(data.createdAt, tz)}</time></Meta>
          <Meta label={data.status === "cancelled" ? "Cancelled" : "Finished"}>
            {data.finishedAt ? <time dateTime={data.finishedAt}>{formatDateTime(data.finishedAt, tz)}</time> : "Not yet"}
          </Meta>
          {data.currentStep && !data.finishedAt && <Meta label="Current step">{data.currentStep}</Meta>}
          {data.depth > 0 && <Meta label="Chain depth">{data.depth} (started by another workflow&apos;s change)</Meta>}
        </dl>
        {(data.outcome || (data.lastError && data.status !== "completed")) && (
          <p className={cn("border-t border-line px-4 py-3 text-[14px]", data.status === "cancelled" ? "bg-surface-2 text-ink-2" : "bg-danger-soft/60 text-danger-ink")} role="status">{data.outcome ?? data.lastError}</p>
        )}
      </Card>

      <section aria-labelledby="run-steps-h">
        <h3 id="run-steps-h" className="mb-2 text-[14px] font-semibold text-ink">Steps</h3>
        {!data.steps.length && !data.pending.length ? (
          <Card className="px-4 py-6 text-center text-[14px] text-muted">No step has run yet. Queued runs start on the scheduler&apos;s next pass.</Card>
        ) : (
          <ol className="space-y-3">
            {data.steps.map((s) => (
              <li key={s.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span className={cn("mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl", stepTone(s.kind))}><StepIcon kind={s.kind} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium text-ink">{s.label}</span>
                        <Badge tone={STEP_STATUS[s.status]?.tone ?? "neutral"}><StepStatusIcon status={s.status} className="size-3.5 text-current" />{isTest && s.status === "skipped" ? "Dry run" : STEP_STATUS[s.status]?.label ?? s.status}</Badge>
                        {s.attempt > 1 && <Badge tone="outline">Attempt {s.attempt}</Badge>}
                      </div>
                      <p className="mt-0.5 text-[14px] text-ink-2">{s.summary}</p>
                      <p className="mt-1 text-[12px] text-muted">
                        <time dateTime={s.startedAt}>{formatDateTime(s.startedAt, tz)}</time>
                        {s.finishedAt && s.finishedAt !== s.startedAt ? ` · took ${durationText(s.startedAt, s.finishedAt)}` : ""}
                        {!s.finishedAt && (s.status === "running" || s.status === "waiting" || s.status === "awaiting_approval") ? " · not finished" : ""}
                      </p>
                      {s.details.length > 0 && (
                        <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-xl bg-surface-2 px-3 py-2 text-[13px] sm:grid-cols-[max-content_minmax(0,1fr)]">
                          {s.details.map((d, i) => (
                            <React.Fragment key={`${d.label}-${i}`}>
                              <dt className="text-muted">{d.label}</dt>
                              <dd className="min-w-0 break-words text-ink-2">{d.value}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      )}
                      {s.error && <p className="mt-2 rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{s.error}</p>}
                      {s.links.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {s.links.map((l) => (
                            <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-primary hover:bg-primary-soft sm:min-h-8">
                              {l.label}<ExternalLink className="size-3" aria-hidden />
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
            {data.pending.map((p) => (
              <li key={`pending-${p.stepKey}`}>
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-line px-4 py-3">
                  <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted"><StepIcon kind={p.kind} /></span>
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-ink-2">{p.label} <span className="font-normal text-muted">· {data.canCancel ? "not reached yet" : "not run on this path"}</span></p>
                    <p className="mt-0.5 text-[13px] text-muted">{p.summary}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={confirm === "cancel"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this run?"
        description="It stops before its next step and a step waiting for approval is withdrawn. Steps that already ran aren't undone, and a message already handed to the provider can't be recalled."
        confirmLabel="Cancel run"
        danger
        loading={busy("cancel")}
        onConfirm={async () => {
          if (await run("cancel", () => cancelRunAction(scope.orgId, data.id), "Run cancelled.")) setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "retry"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Retry the failed step?"
        description="It runs again on the scheduler's next pass, with every check applied again. A message, webhook or n8n call that already went out is never repeated, and one whose outcome is unknown isn't sent again."
        confirmLabel="Retry"
        loading={busy("retry")}
        onConfirm={async () => {
          if (await run("retry", () => retryRunStepAction(scope.orgId, data.id), "Queued to retry.")) setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "skip"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Skip the failed step?"
        description="The run continues with the step after it, as if this one had been done. Use this when you've done the step by hand or it no longer matters."
        confirmLabel="Skip and continue"
        loading={busy("skip")}
        onConfirm={async () => {
          if (await run("skip", () => skipRunStepAction(scope.orgId, data.id), "Skipped. The run continues.")) setConfirm(null);
        }}
      />
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 text-ink-2">{children}</dd>
    </div>
  );
}
