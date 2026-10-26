"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, ShieldAlert, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Sheet, Tabs } from "@/components/ui/overlays";
import { StatusBadge, StatusIcon } from "@/components/setup/status";
import { CheckRow, eventLabel, MODE_HINT, MODE_LABEL, snapshotTasks, SwitchRow, type Act } from "@/components/admin/setup/common";
import {
  addTaskAttachmentAction,
  addTaskNoteAction,
  attestTaskAction,
  removeTaskAttachmentAction,
  requestClientActionAction,
  setTaskDependenciesAction,
  setTaskHiddenAction,
  setTaskStatusAction,
  updateTaskDetailsAction,
  verifyTaskAction,
} from "@/app/(admin)/admin/setup-actions";
import { CLIENT_ACTION_TYPES, STATUS_LABEL, TASK_STATUSES, type AgencySetupSnapshot, type AgencyTaskView, type ClientActionType, type TaskStatus } from "@/lib/setup";
import { formatDateTime, relativeTime } from "@/lib/utils";

interface Props {
  orgId: string;
  snapshot: AgencySetupSnapshot;
  task: AgencyTaskView | null;
  onClose: () => void;
  act: Act;
  busy: string | null;
  timeZone: string;
}

/**
 * The badge on a step left out of this client's setup. A step scoped to a CRM provider the client doesn't use says so, but only when its
 * service (if it has one) is purchased: a step outside the package is "Not in package" whichever provider it belongs to.
 */
export function excludedLabel(t: Pick<AgencyTaskView, "crmProvider" | "service">, services: readonly string[]): string {
  return t.crmProvider && (!t.service || services.includes(t.service)) ? "Not used by this CRM provider" : "Not in package";
}

export function TaskDrawer(props: Props) {
  const { task } = props;
  return (
    <Sheet open={Boolean(task)} onOpenChange={(o) => !o && props.onClose()} title={task?.title ?? "Setup step"} description={task ? `${MODE_LABEL[task.completionMode]} · ${task.section === "client" ? "Client section" : "Agency section"}` : undefined}>
      {task && <DrawerBody key={task.id} {...props} task={task} />}
    </Sheet>
  );
}

function DrawerBody({ orgId, snapshot, task, act, busy, timeZone }: Props & { task: AgencyTaskView }) {
  const [tab, setTab] = React.useState("status");
  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusIcon status={task.status} size="sm" />
        <StatusBadge status={task.status} />
        {!task.required && <Badge tone="outline">Optional</Badge>}
        {task.hidden && <Badge tone="outline">Hidden from client</Badge>}
        {task.serviceExcluded && <Badge tone="outline">{excludedLabel(task, snapshot.services)}</Badge>}
        <span className="text-[13px] text-muted">Updated {relativeTime(task.updatedAt)}</span>
      </div>
      <Tabs
        id="setup-drawer"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "status", label: "Status" },
          { value: "client", label: "Client" },
          { value: "details", label: "Details" },
          { value: "history", label: "History" },
        ]}
      >
      {tab === "status" && <StatusTab {...{ orgId, snapshot, task, act, busy, timeZone }} />}
      {tab === "client" && <ClientTab {...{ orgId, snapshot, task, act, busy, timeZone }} />}
      {tab === "details" && <DetailsTab {...{ orgId, snapshot, task, act, busy, timeZone }} />}
      {tab === "history" && <HistoryTab {...{ orgId, snapshot, task, act, busy, timeZone }} />}
      </Tabs>
    </div>
  );
}

type TabProps = { orgId: string; snapshot: AgencySetupSnapshot; task: AgencyTaskView; act: Act; busy: string | null; timeZone: string };

function completionLine(t: AgencyTaskView, timeZone: string) {
  if (t.status !== "completed" || !t.completedAt) return null;
  const when = formatDateTime(t.completedAt, timeZone);
  if (t.completionSource === "connector") return `Completed ${when}: verified by a system check${t.verifiedDetail ? ` (${t.verifiedDetail})` : ""}.`;
  if (t.completionSource === "attestation") return `Completed ${when} on ${t.completedBy ?? "a team member"}'s attestation. Not machine-verified.`;
  if (t.completionSource === "activation") return `Completed ${when} when activation was approved${t.completedBy ? ` by ${t.completedBy}` : ""}.`;
  return `Completed ${when}${t.completedBy ? ` by ${t.completedBy}` : ""}.`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function StatusTab({ orgId, snapshot, task, act, busy, timeZone }: TabProps) {
  const byId = snapshotTasks(snapshot);
  const unmet = task.unmetDependencies.map((id) => byId.get(id)?.title).filter(Boolean) as string[];
  const [status, setStatus] = React.useState<TaskStatus>(task.status);
  const [note, setNote] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [evidence, setEvidence] = React.useState("");
  const [notify, setNotify] = React.useState(true);

  const verified = task.completionMode === "verified";
  const activation = task.completionMode === "activation";
  const check = snapshot.checks.find((c) => c.key === task.checkKey);
  const options = TASK_STATUSES.filter((s) => !(verified && s === "completed"));
  const reopening = task.status === "completed" && status !== "completed";
  const needsApproval = status === "completed" && task.requiresClientResponse && !task.clientRespondedAt;
  const needsEvidence = status === "completed" && task.requiresEvidence && task.attachments.length === 0 && !evidence;
  const hasRequest = Boolean(task.clientAction || task.clientNote);

  let problem: string | null = null;
  if (status === task.status) problem = "Choose a different status.";
  else if ((status === "completed" || status === "waiting_for_client") && unmet.length) problem = `Finish “${unmet[0]}” first.`;
  else if (needsApproval) problem = "The client's approval is required before this can be completed.";
  else if (needsEvidence) problem = "Add an evidence link before completing this step.";
  else if (status === "blocked" && !note.trim()) problem = "Explain why it is blocked. The client will read this.";
  else if (status === "waiting_for_client" && !note.trim() && !hasRequest) problem = "Tell the client what you need from them.";
  else if (reopening && !reason.trim()) problem = "Add a reason for reopening.";

  const notifies = status === "completed" || status === "waiting_for_client" || status === "blocked";
  const noteLabel = status === "completed" ? "Completion note for the client" : status === "blocked" ? "Why is this blocked? (shown to the client)" : status === "waiting_for_client" ? "What do you need from the client?" : "Message for the client";

  return (
    <div className="space-y-5">
      {completionLine(task, timeZone) && (
        <p className="flex items-start gap-2 rounded-xl bg-success-soft px-3 py-2.5 text-[14px] leading-relaxed text-success-ink">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> {completionLine(task, timeZone)}
        </p>
      )}
      {task.completionNote && <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2">Client sees: “{task.completionNote}”</p>}
      {task.blockedReason && <p className="rounded-xl bg-danger-soft px-3 py-2.5 text-[14px] text-danger-ink">Blocked: {task.blockedReason}</p>}
      {unmet.length > 0 && task.status !== "completed" && (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-[14px] text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Waiting on: {unmet.join(", ")}
        </p>
      )}

      {verified && <VerificationCard {...{ orgId, task, check, act, busy }} />}

      {activation ? (
        <p className="rounded-xl bg-surface-2 px-3 py-3 text-[14px] leading-relaxed text-muted">{MODE_HINT.activation} Use “Mark ready for final review” and “Approve activation” in the readiness panel.</p>
      ) : (
        <div className="space-y-4 rounded-2xl border border-line bg-surface-2/40 p-4">
          <h3 className="text-[14px] font-semibold text-ink">Change status</h3>
          {verified && <p className="text-[13px] leading-relaxed text-muted">A passing system check completes this step. Agency evidence is retained for review and does not verify the connection.</p>}
          <Field label="New status" htmlFor="ts-status">
            <Select id="ts-status" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {options.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                  {s === task.status ? " (current)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {reopening && (
            <Field label="Reason for reopening" htmlFor="ts-reason" hint="Internal. The client doesn't see this.">
              <Textarea id="ts-reason" rows={2} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          <Field label={noteLabel} htmlFor="ts-note" optional={status !== "blocked" && !(status === "waiting_for_client" && !hasRequest)} hint={status === "completed" ? "For example: “Your new website has been built and is ready for review.”" : undefined}>
            <Textarea id="ts-note" rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {status === "completed" && (
            <Field label="Evidence link" htmlFor="ts-evidence" optional={!task.requiresEvidence} hint="A staging URL, screenshot or document. Stays internal.">
              <Input id="ts-evidence" type="url" inputMode="url" placeholder="https://…" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            </Field>
          )}
          {notifies && <CheckRow id="ts-notify" label="Notify the client in their portal" checked={notify} onChange={setNotify} />}
          {problem && status !== task.status && (
            <p role="alert" className="text-[13px] text-warning-ink">
              {problem}
            </p>
          )}
          <Button
            variant="brand"
            loading={busy === "status"}
            disabled={Boolean(problem)}
            onClick={async () => {
              const res = await act("status", () => setTaskStatusAction(orgId, task.id, { status, note, reason, evidenceUrl: evidence, notifyClient: notify }), `Saved as ${STATUS_LABEL[status]}`);
              if (res?.ok) {
                setNote("");
                setReason("");
                setEvidence("");
              }
            }}
          >
            Save status
          </Button>
        </div>
      )}
    </div>
  );
}

function VerificationCard({ orgId, task, check, act, busy }: { orgId: string; task: AgencyTaskView; check: AgencySetupSnapshot["checks"][number] | undefined; act: Act; busy: string | null }) {
  const [attest, setAttest] = React.useState({ note: "", evidenceUrl: "", clientNote: "" });
  const [confirm, setConfirm] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const status = check?.status ?? "unverified";
  const tone = status === "verified" ? "success" : status === "attested" ? "violet" : status === "failed" ? "danger" : "neutral";
  const label = status === "verified" ? "Verified by system" : status === "attested" ? "Attested by agency" : status === "failed" ? "Failing" : "Not verified";
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <ShieldCheck className="size-4 text-primary" /> Integration check
        </h3>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <p className="text-[13px] leading-relaxed text-muted">
        <span className="font-medium text-ink-2">{check?.label ?? "Check"}</span>
        {check?.connectorImplemented && check.detail ? `: ${check.detail}` : "."} Task progress and integration health are tracked separately.
      </p>
      {check?.status === "attested" && check.attestedBy && <p className="text-[13px] text-violet-ink">Attested by {check.attestedBy}. This is a statement by the team, not a system test.</p>}
      {result && <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{result}</p>}

      {check?.connectorImplemented ? (
        task.status === "completed" ? (
          <p className="text-[13px] text-muted">This step is already complete. Re-run the check from the readiness panel to confirm it still passes.</p>
        ) : (
          <Button
            variant="secondary"
            loading={busy === "verify"}
            onClick={async () => {
              const res = await act("verify", () => verifyTaskAction(orgId, task.id));
              if (res?.ok) setResult((res.data as { detail: string; completed: boolean }).completed ? `Verified and completed. ${(res.data as { detail: string }).detail}` : `Not completed: ${(res.data as { detail: string }).detail}`);
            }}
          >
            <ShieldCheck className="size-4" /> Verify now
          </Button>
        )
      ) : task.status === "completed" ? null : (
        <div className="space-y-3 rounded-xl border border-dashed border-line-strong p-3">
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            {check?.connectorNote ?? "The portal can't test this yet."} If you have confirmed it yourself, record an attestation. It is labelled as an attestation everywhere and never counts as a connected integration.
          </p>
          <Field label="What did you confirm, and how?" htmlFor="at-note">
            <Textarea id="at-note" rows={3} value={attest.note} maxLength={2000} onChange={(e) => setAttest({ ...attest, note: e.target.value })} />
          </Field>
          <Field label="Evidence link" htmlFor="at-evidence" optional>
            <Input id="at-evidence" type="url" inputMode="url" placeholder="https://…" value={attest.evidenceUrl} onChange={(e) => setAttest({ ...attest, evidenceUrl: e.target.value })} />
          </Field>
          <Field label="Message for the client" htmlFor="at-client" optional>
            <Input id="at-client" value={attest.clientNote} maxLength={2000} onChange={(e) => setAttest({ ...attest, clientNote: e.target.value })} />
          </Field>
          <CheckRow id="at-confirm" label="I confirm I checked this myself" checked={confirm} onChange={setConfirm} />
          <Button variant="secondary" disabled={!confirm || attest.note.trim().length < 10} loading={busy === "attest"} onClick={() => act("attest", () => attestTaskAction(orgId, task.id, attest), "Attestation recorded")}>
            Record evidence for review
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function ClientTab({ orgId, task, act, busy }: TabProps) {
  const [note, setNote] = React.useState(task.clientNote ?? "");
  const [notifyNote, setNotifyNote] = React.useState(false);
  const [req, setReq] = React.useState<{ type: ClientActionType; label: string; instructions: string; requireResponse: boolean; notify: boolean }>({
    type: task.clientAction?.type ?? "provide_info",
    label: task.clientAction?.label ?? "",
    instructions: task.clientAction?.instructions ?? "",
    requireResponse: task.requiresClientResponse,
    notify: true,
  });
  type LinkKind = "evidence" | "documentation" | "website_preview" | "instructions";
  const [link, setLink] = React.useState<{ label: string; url: string; kind: LinkKind; visibility: "internal" | "client" }>({ label: "", url: "", kind: "website_preview", visibility: "client" });
  const resp = task.clientResponse;
  const [document, setDocument] = React.useState<File | null>(null);
  const [documentVisibility, setDocumentVisibility] = React.useState<"client" | "internal">("internal");
  const [documentLabel, setDocumentLabel] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement>(null);
  const approvalNeeded = task.requiresClientResponse && !task.clientRespondedAt;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold text-ink">Client-visible note</h3>
        <p className="text-[13px] text-muted">Shown on this step in the client&apos;s Setup Center. Leave empty to remove it.</p>
        <Textarea aria-label="Client-visible note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        <CheckRow id="note-notify" label="Also notify the client" checked={notifyNote} onChange={setNotifyNote} disabled={!note.trim()} />
        <Button variant="secondary" size="sm" loading={busy === "note"} disabled={note.trim() === (task.clientNote ?? "")} onClick={() => act("note", () => addTaskNoteAction(orgId, task.id, { body: note, visibility: "client", notifyClient: notifyNote }), "Client note saved")}>
          Save note
        </Button>
      </section>

      <section className="space-y-3 rounded-2xl border border-line bg-surface-2/40 p-4">
        <h3 className="text-[14px] font-semibold text-ink">Ask the client for something</h3>
        <p className="text-[13px] leading-relaxed text-muted">Moves the step to Waiting for client and gives them one clear button. Their answer sends it to Ready for review. It never completes the step by itself.</p>
        {task.clientAction && (
          <p className="rounded-lg bg-surface px-3 py-2 text-[13px] text-ink-2">
            Current request: <span className="font-medium">{task.clientAction.label}</span>
            {approvalNeeded && <span className="ml-1 text-warning-ink">· approval required before completion</span>}
          </p>
        )}
        <Field label="Type" htmlFor="rq-type" hint={CLIENT_ACTION_TYPES.find((t) => t.value === req.type)?.hint}>
          <Select id="rq-type" value={req.type} onChange={(e) => setReq({ ...req, type: e.target.value as ClientActionType })}>
            {CLIENT_ACTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Button and dialog title" htmlFor="rq-label">
          <Input id="rq-label" value={req.label} maxLength={120} placeholder="e.g. Review your website" onChange={(e) => setReq({ ...req, label: e.target.value })} />
        </Field>
        <Field label="Instructions" htmlFor="rq-instr">
          <Textarea id="rq-instr" rows={3} maxLength={1000} value={req.instructions} onChange={(e) => setReq({ ...req, instructions: e.target.value })} />
        </Field>
        <SwitchRow id="rq-resp" label="Client's response is required" hint="The step can't be completed until they respond positively." checked={req.requireResponse} onChange={(v) => setReq({ ...req, requireResponse: v })} />
        <CheckRow id="rq-notify" label="Notify the client" checked={req.notify} onChange={(v) => setReq({ ...req, notify: v })} />
        <Button
          variant="brand"
          loading={busy === "request"}
          disabled={req.label.trim().length < 2 || req.instructions.trim().length < 5 || task.status === "completed"}
          onClick={() => act("request", () => requestClientActionAction(orgId, task.id, { type: req.type, label: req.label, instructions: req.instructions, requireResponse: req.requireResponse, notifyClient: req.notify }), "Request sent to the client")}
        >
          Request from client
        </Button>
        {task.status === "completed" && <p className="text-[13px] text-muted">Reopen this step first to ask the client for something.</p>}
      </section>

      {resp && (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h3 className="text-[14px] font-semibold text-ink">Client response</h3>
          <p className="mt-1 text-[14px] text-ink-2">
            {resp.decision === "request_changes" ? "Asked for changes" : resp.decision === "approve" ? "Approved" : resp.decision === "confirm" ? "Confirmed it is done" : "Sent information"}
            {resp.at ? ` · ${relativeTime(resp.at)}` : ""}
          </p>
          {resp.message && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-[14px] text-ink-2">{resp.message}</p>}
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold text-ink">Links and documentation</h3>
        {task.attachments.length === 0 ? (
          <p className="text-[13px] text-muted">No links or documents yet.</p>
        ) : (
          <ul className="space-y-2">
            {task.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
                <Link2 className="size-4 shrink-0 text-muted" />
                <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink hover:text-primary">
                  {a.label} <ExternalLink className="ml-0.5 inline size-3" />
                </a>
                <Badge tone={a.visibility === "client" ? "primary" : "neutral"}>{a.visibility === "client" ? "Client sees" : "Internal"}</Badge>
                <button type="button" aria-label={`Remove ${a.label}`} className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink" onClick={() => act("rm-att", () => removeTaskAttachmentAction(orgId, a.id), "Link removed")}>
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 rounded-2xl border border-dashed border-line-strong p-3 sm:grid-cols-2">
          <Field label="Label" htmlFor="at-l">
            <Input id="at-l" value={link.label} maxLength={120} placeholder="Website preview" onChange={(e) => setLink({ ...link, label: e.target.value })} />
          </Field>
          <Field label="Link" htmlFor="at-u">
            <Input id="at-u" type="url" inputMode="url" value={link.url} placeholder="https://…" onChange={(e) => setLink({ ...link, url: e.target.value })} />
          </Field>
          <Field label="Kind" htmlFor="at-k">
            <Select id="at-k" value={link.kind} onChange={(e) => setLink({ ...link, kind: e.target.value as LinkKind })}>
              <option value="website_preview">Website preview (shown in the review dialog)</option>
              <option value="documentation">Documentation</option>
              <option value="instructions">Instructions</option>
              <option value="evidence">Evidence</option>
            </Select>
          </Field>
          <Field label="Visible to" htmlFor="at-v">
            <Select id="at-v" value={link.visibility} onChange={(e) => setLink({ ...link, visibility: e.target.value as "internal" | "client" })}>
              <option value="client">Client and team</option>
              <option value="internal">Team only</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "add-att"}
              disabled={!link.label.trim() || !link.url.trim()}
              onClick={async () => {
                const res = await act("add-att", () => addTaskAttachmentAction(orgId, task.id, link), "Link added");
                if (res?.ok) setLink({ ...link, label: "", url: "" });
              }}
            >
              Add link
            </Button>
          </div>
        </div>
        <div className="space-y-3 rounded-2xl border border-dashed border-line-strong p-3">
          <h4 className="text-[14px] font-semibold text-ink">Attach a private document</h4>
          <p className="text-[13px] text-muted">Documents are stored privately. Downloads require authorized access. PDF, Word, PNG, JPEG, text and CSV; up to 10 MB.</p>
          <Field label="Document" htmlFor="setup-document"><Input id="setup-document" ref={fileRef} type="file" className="h-auto py-2 text-[12px]" accept=".pdf,.docx,.png,.jpg,.jpeg,.txt,.md,.csv" onChange={(e) => { const file = e.target.files?.[0] ?? null; setDocument(file); if (file) setDocumentLabel(file.name.slice(0, 120)); }} /></Field>
          <Field label="Document label" htmlFor="setup-document-label"><Input id="setup-document-label" value={documentLabel} maxLength={120} onChange={(e) => setDocumentLabel(e.target.value)} /></Field>
          <Field label="Document visibility" htmlFor="setup-document-visibility"><Select id="setup-document-visibility" value={documentVisibility} onChange={(e) => setDocumentVisibility(e.target.value as "internal" | "client")}><option value="internal">Team only</option><option value="client">Client and team</option></Select></Field>
          <Button variant="secondary" size="sm" loading={busy === "upload-document"} disabled={!document || !documentLabel.trim()} onClick={async () => {
            if (!document) return;
            const form = new FormData();
            form.set("taskId", task.id); form.set("file", document); form.set("label", documentLabel); form.set("visibility", documentVisibility);
            const res = await act("upload-document", async () => {
              const response = await fetch(`/api/admin/setup/${orgId}/documents`, { method: "POST", body: form, signal: AbortSignal.timeout(45000) });
              return await response.json() as { ok: true; data: unknown } | { ok: false; error: string };
            }, "Document attached privately");
            if (res?.ok) { setDocument(null); setDocumentLabel(""); if (fileRef.current) fileRef.current.value = ""; }
          }}><Upload className="size-3.5" /> Upload document</Button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function DetailsTab({ orgId, snapshot, task, act, busy }: TabProps) {
  const custom = !task.templateKey;
  const [f, setF] = React.useState({
    title: task.title,
    clientTitle: task.clientTitle ?? "",
    description: task.description,
    assignedTo: task.assignedTo ?? "",
    estimate: task.estimatedCompletionAt ?? "",
    required: task.required,
    requiresEvidence: task.requiresEvidence,
  });
  const [deps, setDeps] = React.useState<string[]>(task.dependsOn);
  const others = snapshot.tasks.filter((t) => t.id !== task.id);
  const activation = task.completionMode === "activation";

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h3 className="text-[14px] font-semibold text-ink">Step details</h3>
        {custom ? (
          <Field label="Name" htmlFor="d-title">
            <Input id="d-title" value={f.title} maxLength={160} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </Field>
        ) : (
          <Field label="Client sees this as" htmlFor="d-ctitle" optional hint={`Built-in steps keep their name (“${task.title}”). Add friendlier wording for the client.`}>
            <Input id="d-ctitle" value={f.clientTitle} maxLength={160} onChange={(e) => setF({ ...f, clientTitle: e.target.value })} />
          </Field>
        )}
        <Field label="Description shown to the client" htmlFor="d-desc" optional>
          <Textarea id="d-desc" rows={3} maxLength={600} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Assigned to" htmlFor="d-assign">
          <Select id="d-assign" value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
            <option value="">Unassigned</option>
            {snapshot.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.role === "agency_super_admin" ? " (super admin)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estimated completion" htmlFor="d-est" optional hint="Only shown to the client when you know it. Leave empty if unknown.">
          <div className="flex gap-2">
            <Input id="d-est" type="date" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} />
            {f.estimate && (
              <Button variant="ghost" size="sm" onClick={() => setF({ ...f, estimate: "" })}>
                Clear
              </Button>
            )}
          </div>
        </Field>
        <SwitchRow id="d-req" label="Required" hint="Optional steps never count against progress or block activation." checked={f.required} onChange={(v) => setF({ ...f, required: v })} disabled={activation} />
        {!task.templateKey || task.completionMode === "manual" ? <SwitchRow id="d-evi" label="Require an evidence link to complete" checked={f.requiresEvidence} onChange={(v) => setF({ ...f, requiresEvidence: v })} /> : null}
        <Button
          variant="secondary"
          loading={busy === "details"}
          onClick={() =>
            act(
              "details",
              () =>
                updateTaskDetailsAction(orgId, task.id, {
                  ...(custom ? { title: f.title } : { clientTitle: f.clientTitle || null }),
                  description: f.description,
                  assignedTo: f.assignedTo || null,
                  estimatedCompletionAt: f.estimate || null,
                  required: f.required,
                  requiresEvidence: f.requiresEvidence,
                }),
              "Details saved",
            )
          }
        >
          Save details
        </Button>
      </section>

      {!activation && (
        <section className="space-y-3">
          <h3 className="text-[14px] font-semibold text-ink">Visibility</h3>
          {task.required ? (
            <p className="text-[13px] text-muted">Required steps can&apos;t be hidden. Mark the step optional (above, then save) to hide it.</p>
          ) : (
            <Button variant="secondary" size="sm" loading={busy === "hide"} onClick={() => act("hide", () => setTaskHiddenAction(orgId, task.id, !task.hidden), task.hidden ? "Step is visible again" : "Step hidden from the client")}>
              {task.hidden ? "Show to the client again" : "Hide from the client"}
            </Button>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold text-ink">Prerequisites</h3>
        <p className="text-[13px] text-muted">This step can&apos;t be completed (or requested from the client) until these are done. Hidden and out-of-package steps are ignored.</p>
        <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
          {others.map((o) => (
            <CheckRow key={o.id} id={`dep-${o.id}`} label={o.title} hint={o.hidden || o.serviceExcluded ? "Not applicable" : STATUS_LABEL[o.status]} checked={deps.includes(o.id)} onChange={(v) => setDeps(v ? [...deps, o.id] : deps.filter((d) => d !== o.id))} />
          ))}
        </div>
        <Button variant="secondary" size="sm" loading={busy === "deps"} disabled={JSON.stringify([...deps].sort()) === JSON.stringify([...task.dependsOn].sort())} onClick={() => act("deps", () => setTaskDependenciesAction(orgId, task.id, deps), "Prerequisites saved")}>
          Save prerequisites
        </Button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTab({ orgId, snapshot, task, act, busy, timeZone }: TabProps) {
  const [note, setNote] = React.useState("");
  const tasks = snapshotTasks(snapshot);
  const events = snapshot.events.filter((e) => e.taskId === task.id);
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-[14px] font-semibold text-ink">Internal note</h3>
        <Textarea aria-label="Internal note" rows={2} maxLength={2000} value={note} placeholder="Only the iAcquire team sees this." onChange={(e) => setNote(e.target.value)} />
        <Button
          variant="secondary"
          size="sm"
          loading={busy === "inote"}
          disabled={!note.trim()}
          onClick={async () => {
            const res = await act("inote", () => addTaskNoteAction(orgId, task.id, { body: note, visibility: "internal" }), "Note added");
            if (res?.ok) setNote("");
          }}
        >
          Add internal note
        </Button>
      </section>
      <section>
        <h3 className="mb-3 text-[14px] font-semibold text-ink">Change history</h3>
        {events.length === 0 ? (
          <p className="text-[13px] text-muted">No changes recorded yet.</p>
        ) : (
          <ol className="relative space-y-4 border-l border-line pl-4">
            {events.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-primary" aria-hidden />
                <p className="text-[14px] leading-snug text-ink">{eventLabel(e, tasks)}</p>
                {e.body && (
                  <p className="mt-1 rounded-lg bg-primary-soft px-2.5 py-1.5 text-[13px] text-primary-ink">
                    <span className="font-medium">Client sees: </span>
                    {e.body}
                  </p>
                )}
                {e.reason && (
                  <p className="mt-1 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink-2">
                    <span className="font-medium">Internal: </span>
                    {e.reason}
                  </p>
                )}
                <p className="mt-1 text-[12px] text-faint">{formatDateTime(e.at, timeZone)}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
