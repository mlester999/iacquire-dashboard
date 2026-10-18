"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, FileText, ListTodo, PhoneIncoming, PhoneOutgoing, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlays";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { createCallFollowUpAction, updateCallAction } from "@/app/actions/crm-calls";
import { formatDateTime } from "@/lib/utils";
import { formatPhone } from "@/lib/crm/types";
import type { CrmScope } from "@/server/crm/page";
import type { CallRecordView } from "@/server/crm/calls";
import { CALL_PROVIDER_LABELS, CALL_STATUS_LABELS, CALL_STATUS_TONES, CONSENT_LABELS, dispositionLabel, durationLabel } from "@/components/crm/calls/model";

/**
 * One call: what the provider (or the person who logged it) recorded, the recording and transcript references when the workspace keeps
 * them, and the team's own notes. An unmatched call can be linked to a contact by hand; nothing the provider reported is edited.
 */
interface CallDetailProps {
  scope: CrmScope;
  call: CallRecordView | null;
  onClose: () => void;
  canLog: boolean;
  canFollowUp: boolean;
  members: Array<{ id: string; name: string }>;
}

export function CallDetailSheet(props: CallDetailProps) {
  if (!props.call) return <Sheet open={false} onOpenChange={() => props.onClose()} title="Call"><span /></Sheet>;
  // Keyed by call, so the notes and task fields start fresh when another call is opened (not on every refresh of the same one).
  return <CallDetailBody key={props.call.id} {...props} call={props.call} />;
}

function CallDetailBody({ scope, call, onClose, canLog, canFollowUp, members }: CallDetailProps & { call: CallRecordView }) {
  const { run, busy } = useCrmAction();
  const ids = React.useId();
  const [notes, setNotes] = React.useState(call.notes ?? "");
  const [disposition, setDisposition] = React.useState(call.disposition ?? "");
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskDue, setTaskDue] = React.useState("");
  const [assignee, setAssignee] = React.useState(scope.userId ?? "");
  const [linking, setLinking] = React.useState(false);

  const search = React.useCallback(async (q: string) => {
    const r = await searchContactsAction(scope.orgId, q);
    return r.ok ? r.data : [];
  }, [scope.orgId]);

  const Icon = call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  const who = call.contact?.name ?? (call.customerNumber ? formatPhone(call.customerNumber) : "Unknown caller");
  const facts: Array<[string, React.ReactNode]> = [
    ["Started", call.startedAt ? formatDateTime(call.startedAt, scope.timezone) : "Not reported"],
    ["Ended", call.endedAt ? formatDateTime(call.endedAt, scope.timezone) : "Not reported"],
    ["Duration", durationLabel(call.durationSeconds) || "Not reported"],
    ["From", call.fromNumber ? formatPhone(call.fromNumber) : "Not reported"],
    ["To", call.toNumber ? formatPhone(call.toNumber) : "Not reported"],
    ["Source", CALL_PROVIDER_LABELS[call.provider]],
  ];
  if (call.provider !== "manual" && call.disposition) facts.push(["Ended because", dispositionLabel(call.disposition)]);
  if (call.providerCallId) facts.push(["Provider call id", <span key="id" className="break-all font-mono text-[12px]">{call.providerCallId}</span>]);
  if (call.owner) facts.push(["Logged by", call.owner.name]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`${call.direction === "inbound" ? "Call from" : "Call to"} ${who}`} description={call.startedAt ? formatDateTime(call.startedAt, scope.timezone) : undefined}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={CALL_STATUS_TONES[call.status]}><Icon className="size-3" aria-hidden />{CALL_STATUS_LABELS[call.status]}</Badge>
          <Badge tone="outline">{CALL_PROVIDER_LABELS[call.provider]}</Badge>
        </div>

        <section aria-label="Contact" className="rounded-2xl border border-line p-3">
          {call.contact ? (
            <p className="text-[13.5px] text-ink-2">With <Link href={`${scope.base}/contacts/${call.contact.id}`} className="font-medium text-ink hover:underline">{call.contact.name}</Link></p>
          ) : (
            <div className="space-y-2">
              <p className="text-[13.5px] text-ink-2">
                {call.customerNumber ? <>{formatPhone(call.customerNumber)} doesn&apos;t belong to exactly one contact, so the call isn&apos;t linked.</> : "The provider didn't report the caller's number, so the call isn't linked to a contact."}
              </p>
              {canLog && (linking ? (
                <RecordPicker<{ id: string; name: string; email: string | null; phone: string | null }>
                  id={`${ids}-link`}
                  label="Contact to link"
                  placeholder="Search by name, email or phone"
                  search={search}
                  render={(c) => <span className="flex min-w-0 flex-col"><span className="truncate font-medium text-ink">{c.name || "Unnamed contact"}</span><span className="truncate text-[12px] text-muted">{c.phone ? formatPhone(c.phone) : c.email ?? ""}</span></span>}
                  onPick={(c) => run("link-call", () => updateCallAction(scope.orgId, call.id, { contactId: c.id }), `Linked to ${c.name || "the contact"}.`).then((ok) => ok && onClose())}
                />
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setLinking(true)}><UserPlus className="size-4" aria-hidden />Link to a contact</Button>
              ))}
            </div>
          )}
        </section>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          {facts.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 text-ink-2">{v}</dd>
            </React.Fragment>
          ))}
        </dl>

        {call.summary && (
          <section aria-labelledby={`${ids}-summary`}>
            <h3 id={`${ids}-summary`} className="text-[13px] font-semibold text-ink">{call.provider === "manual" ? "Summary" : "Summary from the provider"}</h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{call.summary}</p>
          </section>
        )}

        <section aria-labelledby={`${ids}-rec`} className="space-y-2 rounded-2xl border border-line p-3">
          <h3 id={`${ids}-rec`} className="text-[13px] font-semibold text-ink">Recording and transcript</h3>
          <p className="text-[12.5px] text-muted">Consent: {CONSENT_LABELS[call.recordingConsent]}</p>
          {call.recordingRef ? (
            <a href={call.recordingRef} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
              Open the recording<ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">(opens in a new tab, where {CALL_PROVIDER_LABELS[call.provider]} keeps it)</span>
            </a>
          ) : (
            <p className="text-[13px] text-ink-2">{call.provider === "manual" ? "No recording link was added." : "No recording link is kept for this call."}</p>
          )}
          {call.transcriptRef && (
            <p className="flex items-start gap-1.5 text-[13px] text-ink-2"><FileText className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />The transcript is kept in {CALL_PROVIDER_LABELS[call.provider]} under this call&apos;s id; iAcquire stores only that reference.</p>
          )}
        </section>

        {canLog ? (
          <section aria-labelledby={`${ids}-notes`} className="space-y-3">
            <h3 id={`${ids}-notes`} className="text-[13px] font-semibold text-ink">Your team&apos;s notes</h3>
            {call.provider === "manual" && (
              <Field label="Outcome" htmlFor={`${ids}-disp`} optional>
                <Input id={`${ids}-disp`} maxLength={60} value={disposition} onChange={(e) => setDisposition(e.target.value)} placeholder="For example Booked or Call back" />
              </Field>
            )}
            <Field label="Notes" htmlFor={`${ids}-n`} optional>
              <Textarea id={`${ids}-n`} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" loading={busy("save-call")} disabled={notes === (call.notes ?? "") && disposition === (call.disposition ?? "")}
                onClick={() => run("save-call", () => updateCallAction(scope.orgId, call.id, { notes: notes.trim() || null, disposition: call.provider === "manual" ? disposition.trim() || null : undefined }), "Notes saved.")}>
                Save notes
              </Button>
            </div>
          </section>
        ) : call.notes ? (
          <section aria-labelledby={`${ids}-notes`}>
            <h3 id={`${ids}-notes`} className="text-[13px] font-semibold text-ink">Your team&apos;s notes</h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{call.notes}</p>
          </section>
        ) : null}

        <section aria-labelledby={`${ids}-fu`} className="space-y-3 border-t border-line pt-4">
          <h3 id={`${ids}-fu`} className="text-[13px] font-semibold text-ink">Follow-up</h3>
          {call.followUpTaskId ? (
            <Link href={`${scope.base}/tasks?task=${call.followUpTaskId}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline"><ListTodo className="size-4" aria-hidden />Open the follow-up task</Link>
          ) : canFollowUp ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Task" htmlFor={`${ids}-task`} optional className="sm:col-span-2">
                <Input id={`${ids}-task`} maxLength={200} value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder={`Follow up on the call with ${who}`} />
              </Field>
              <Field label="Due" htmlFor={`${ids}-due`} optional>
                <Input id={`${ids}-due`} type="datetime-local" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
              </Field>
              <Field label="For" htmlFor={`${ids}-who`}>
                <Select id={`${ids}-who`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">Nobody yet</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <div className="sm:col-span-2 flex justify-end">
                <Button size="sm" variant="secondary" loading={busy("call-task")}
                  onClick={() => run("call-task", () => createCallFollowUpAction(scope.orgId, call.id, { title: taskTitle.trim() || null, dueAt: taskDue && Number.isFinite(Date.parse(taskDue)) ? new Date(Date.parse(taskDue)).toISOString() : null, assigneeId: assignee || null }), "Follow-up task created.")}>
                  <ListTodo className="size-4" aria-hidden />Create follow-up task
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-muted">No follow-up task.</p>
          )}
        </section>
      </div>
    </Sheet>
  );
}
