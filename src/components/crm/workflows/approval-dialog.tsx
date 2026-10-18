"use client";

import * as React from "react";
import { Bot, Send, ShieldAlert, ShieldCheck, Webhook, Workflow } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { useCrmAction } from "@/components/crm/ui";
import { requestWorkflowApprovalAction } from "@/app/actions/crm-workflows";
import { TRIGGERS, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { CrmScope } from "@/server/crm/page";
import { effectLongLabel, namesFrom, triggerLine } from "@/components/crm/workflows/summaries";
import { effectItems } from "@/components/crm/workflows/editor-logic";
import { Toggle } from "@/components/crm/workflows/pickers";
import type { EditorOptions, VersionItem } from "@/components/crm/workflows/types";

const ICON = { send_message: Send, webhook: Webhook, n8n: Workflow, ai_task: Bot } as const;

/**
 * Shows the owner exactly what a published version will send and call, and requests their approval of that version. The approval is bound
 * to the version's content fingerprint: any later change is a new version that needs approving again.
 */
export function ApprovalDialog({ scope, workflowId, workflowStatus, version, options, canRequest, approvalsHref, onClose }: {
  scope: CrmScope;
  workflowId: string;
  workflowStatus: "draft" | "active" | "paused" | "archived";
  version: VersionItem;
  options: EditorOptions;
  canRequest: boolean;
  approvalsHref: string | null;
  onClose: () => void;
}) {
  const { run, busy } = useCrmAction();
  const def = version.definition as WorkflowDefinition;
  const items = effectItems(def, options);
  const names = namesFrom(options);
  const blocked = items.some((i) => i.warning);
  const pending = version.approval === "pending";
  const approved = version.approval === "approved";
  const [activate, setActivate] = React.useState(workflowStatus !== "active");
  const request = async () => {
    const out = await run(
      "request",
      () => requestWorkflowApprovalAction(scope.orgId, workflowId, version.id, { activate }),
      (d) => (d.status === "requested" ? `Approval requested. The owner decides in Approvals${activate ? "; approving also turns the workflow on" : ""}.` : d.status === "pending" ? "An approval is already waiting for the owner." : d.status === "approved" ? "This version is already approved." : "This version doesn't need approval."),
    );
    if (out) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={approved ? `Version ${version.version} is approved` : pending ? `Approval requested for version ${version.version}` : `Approve version ${version.version} before it runs`}
      description="Workflows that message customers or call outside systems run only after the business owner approves the exact version. Here is everything this version can do."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {approved ? null : pending ? (
            approvalsHref ? <ButtonLink href={approvalsHref}>Open Approvals</ButtonLink> : null
          ) : canRequest ? (
            <Button loading={busy("request")} disabled={blocked} onClick={request}>
              <ShieldCheck className="size-4" aria-hidden />Request owner approval
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-line bg-surface-2/50 p-3 text-[13px]">
          <p className="font-medium text-ink">Starts when: {triggerLine(def.trigger, names)}</p>
          <p className="mt-1 text-muted">{TRIGGERS[def.trigger.type]?.description}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{version.effects.map((e) => <Badge key={e} tone="warning">{effectLongLabel(e)}</Badge>)}</div>
        </div>
        <ol className="space-y-3">
          {items.map((it) => {
            const Icon = ICON[it.kind];
            return (
              <li key={it.stepKey} className="rounded-2xl border border-line p-3">
                <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink">
                  <Icon className="size-4 text-muted" aria-hidden />Step {it.stepNumber}: {it.title}
                  {it.asksFirst && <Badge tone="warning" className="h-5 px-2 text-[11px] font-medium">Also asks a person each time</Badge>}
                </p>
                <dl className="mt-2 grid gap-x-3 gap-y-1 text-[12.5px] sm:grid-cols-[max-content_minmax(0,1fr)]">
                  {it.lines.map((l) => (
                    <React.Fragment key={l.label}>
                      <dt className="text-muted">{l.label}</dt>
                      <dd className="break-words text-ink-2">{l.value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                {it.message && (
                  <div className="mt-2 rounded-xl bg-surface-2 p-3">
                    <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wider text-faint">Exact wording</p>
                    {it.message.subject && <p className="text-[13px] font-medium text-ink">{it.message.subject}</p>}
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{it.message.body}</p>
                    <p className="mt-1.5 text-[11.5px] text-muted">Placeholders like {"{{contact.first_name}}"} are filled in for each contact. A message missing a value isn&apos;t sent.</p>
                  </div>
                )}
                {it.warning && <p className="mt-2 flex gap-1.5 rounded-xl bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />{it.warning}</p>}
              </li>
            );
          })}
        </ol>
        <p className="text-[12.5px] leading-relaxed text-muted">
          The approval covers version {version.version} only (fingerprint <span className="font-mono">#{version.contentHash.slice(0, 10)}</span>). Changing any step makes a new version that needs approving again. A paused workspace, a paused AI employee or missing consent still stops a message at the moment it would send.
        </p>
        {blocked && !approved && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink">The steps marked above can&apos;t run as they are, so approval can&apos;t be requested yet. Change them and publish again, or wait until what they need is ready.</p>}
        {canRequest && !pending && !approved && !blocked && workflowStatus !== "active" && (
          <Toggle id="wf-approval-activate" label="Turn the workflow on as soon as the owner approves" hint="Leave this off to approve it now and turn it on yourself later." checked={activate} onChange={setActivate} />
        )}
        {approved && <p className="rounded-xl bg-success-soft px-3 py-2 text-[12.5px] text-success-ink">Approved{version.approvedByName ? ` by ${version.approvedByName}` : ""}. The approval stands while this version is the one running.</p>}
        {!canRequest && !pending && !approved && <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-muted">Someone who can change automations requests the approval; the workspace owner decides.</p>}
        {pending && <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-muted">{scope.agency ? "The workspace owner decides in their Approval Center." : "Only the workspace owner can approve it, in Approvals."}</p>}
      </div>
    </Dialog>
  );
}
