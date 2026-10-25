"use client";

import * as React from "react";
import { PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { logCallAction } from "@/app/actions/crm-calls";
import { formatPhone } from "@/lib/crm/types";
import type { CrmScope } from "@/server/crm/page";
import { CALL_STATUS_LABELS, MANUAL_STATUSES, type ConsentKey } from "@/components/crm/calls/model";

type Picked = { id: string; name: string };
type ManualStatus = "completed" | "no_answer" | "busy" | "voicemail" | "failed";

/** The current moment as a datetime-local value in the browser's own time. */
function nowLocal(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * A person logs a call they made or took: with whom, which way, how it ended, when and how long, an outcome label and summary,
 * whether it was recorded (a recording link only with the caller told or agreeing), and optionally a follow-up task.
 */
interface LogCallDialogProps {
  scope: CrmScope;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Logging from a contact's page: the contact is already chosen. */
  contact?: Picked | null;
  members: Array<{ id: string; name: string }>;
  canFollowUp: boolean;
}

export function LogCallDialog(props: LogCallDialogProps) {
  // A fresh form each time the dialog opens (the time defaults to that moment), without resetting state from an effect.
  const [session, setSession] = React.useState(0);
  const [wasOpen, setWasOpen] = React.useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setSession((s) => s + 1);
  }
  return <LogCallForm key={session} {...props} />;
}

function LogCallForm({ scope, open, onOpenChange, contact: fixed, members, canFollowUp }: LogCallDialogProps) {
  const { run, busy } = useCrmAction();
  const ids = React.useId();
  const [contact, setContact] = React.useState<Picked | null>(fixed ?? null);
  const [direction, setDirection] = React.useState<"outbound" | "inbound">("outbound");
  const [status, setStatus] = React.useState<ManualStatus>("completed");
  const [when, setWhen] = React.useState(nowLocal);
  const [minutes, setMinutes] = React.useState("");
  const [seconds, setSeconds] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [disposition, setDisposition] = React.useState("");
  const [summary, setSummary] = React.useState("");
  const [consent, setConsent] = React.useState<ConsentKey>("not_recorded");
  const [recordingUrl, setRecordingUrl] = React.useState("");
  const [followUp, setFollowUp] = React.useState(false);
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskDue, setTaskDue] = React.useState("");
  const [assignee, setAssignee] = React.useState(scope.userId ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const search = React.useCallback(async (q: string) => {
    const r = await searchContactsAction(scope.orgId, q);
    return r.ok ? r.data : [];
  }, [scope.orgId]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!contact) e.contact = "Choose who the call was with.";
    const started = Date.parse(when);
    if (!when || !Number.isFinite(started)) e.when = "Enter when the call took place.";
    else if (started > Date.now() + 5 * 60_000) e.when = "A call can't be logged in the future.";
    const m = minutes.trim() ? Number(minutes) : 0;
    const s = seconds.trim() ? Number(seconds) : 0;
    if (!Number.isInteger(m) || m < 0 || m > 1440 || !Number.isInteger(s) || s < 0 || s > 59) e.duration = "Use whole minutes (up to 1,440) and seconds (0–59).";
    if (phone.trim() && !E164.test(phone.trim())) e.phone = "Use international format, for example +639171234567.";
    if (recordingUrl.trim() && !/^https:\/\//i.test(recordingUrl.trim())) e.recording = "The recording link must start with https://.";
    if (followUp && taskDue && !Number.isFinite(Date.parse(taskDue))) e.taskDue = "Enter a valid date and time.";
    setErrors(e);
    if (Object.keys(e).length || !contact) return;
    const durationSeconds = status === "completed" && (minutes.trim() || seconds.trim()) ? m * 60 + s : null;
    const ok = await run(
      "log-call",
      () => logCallAction(scope.orgId, {
        contactId: contact.id, direction, status, startedAt: new Date(started).toISOString(), durationSeconds, phone: phone.trim() || null,
        disposition: disposition.trim() || null, summary: summary.trim() || null, recordingConsent: consent,
        recordingUrl: consent === "announced" || consent === "granted" ? recordingUrl.trim() || null : null,
        followUp: followUp ? { title: taskTitle.trim() || null, dueAt: taskDue ? new Date(Date.parse(taskDue)).toISOString() : null, assigneeId: assignee || null } : null,
      }),
      followUp ? "Call logged with a follow-up task." : "Call logged.",
    );
    if (ok) {
      onOpenChange(false);
      setMinutes(""); setSeconds(""); setPhone(""); setDisposition(""); setSummary(""); setRecordingUrl(""); setConsent("not_recorded"); setFollowUp(false); setTaskTitle(""); setTaskDue("");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Log a call"
      description="Record a call you made or took. It appears on the contact's timeline and counts as a completed call for workflows."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={busy("log-call")} onClick={submit}><PhoneCall className="size-4" aria-hidden />Log call</Button>
        </>
      }
    >
      <div className="space-y-4">
        {!fixed && (
          <Field label="Who was it with?" htmlFor={`${ids}-contact`} error={errors.contact}>
            <RecordPicker<{ id: string; name: string; email: string | null; phone: string | null }>
              id={`${ids}-contact`}
              label="Contact"
              placeholder="Search by name, email or phone"
              search={search}
              render={(c) => (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-ink">{c.name || "Unnamed contact"}</span>
                  <span className="truncate text-[12px] text-muted">{c.phone ? formatPhone(c.phone) : c.email ?? "No phone on file"}</span>
                </span>
              )}
              onPick={(c) => setContact({ id: c.id, name: c.name || "Unnamed contact" })}
              value={contact?.name}
              onClear={() => setContact(null)}
            />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-[14px] font-medium text-ink-2" id={`${ids}-dir`}>Direction</p>
            <Segmented id={`${ids}-direction`} ariaLabel="Direction" value={direction} onChange={setDirection} options={[{ value: "outbound", label: "I called them" }, { value: "inbound", label: "They called" }]} />
          </div>
          <Field label="How it ended" htmlFor={`${ids}-status`}>
            <Select id={`${ids}-status`} value={status} onChange={(e) => setStatus(e.target.value as ManualStatus)}>
              {MANUAL_STATUSES.map((s) => <option key={s} value={s}>{CALL_STATUS_LABELS[s]}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When" htmlFor={`${ids}-when`} error={errors.when} hint="In your own time zone.">
            <Input id={`${ids}-when`} type="datetime-local" value={when} max={nowLocal()} onChange={(e) => setWhen(e.target.value)} aria-invalid={errors.when ? true : undefined} />
          </Field>
          {status === "completed" && (
            <Field label="Duration" htmlFor={`${ids}-min`} optional error={errors.duration}>
              <div className="flex items-center gap-2">
                <Input id={`${ids}-min`} inputMode="numeric" aria-label="Minutes" placeholder="0" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ""))} className="w-24" />
                <span className="text-[14px] text-muted">min</span>
                <Input inputMode="numeric" aria-label="Seconds" placeholder="0" value={seconds} onChange={(e) => setSeconds(e.target.value.replace(/[^0-9]/g, ""))} className="w-24" />
                <span className="text-[14px] text-muted">s</span>
              </div>
            </Field>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Number used" htmlFor={`${ids}-phone`} optional error={errors.phone} hint="Leave empty to use the contact's phone number.">
            <Input id={`${ids}-phone`} type="tel" inputMode="tel" placeholder="+639171234567" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={errors.phone ? true : undefined} />
          </Field>
          <Field label="Outcome" htmlFor={`${ids}-disposition`} optional hint="A short label, for example Booked or Call back.">
            <Input id={`${ids}-disposition`} maxLength={60} value={disposition} onChange={(e) => setDisposition(e.target.value)} />
          </Field>
        </div>
        <Field label="Summary" htmlFor={`${ids}-summary`} optional>
          <Textarea id={`${ids}-summary`} maxLength={4000} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What was discussed and agreed" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Recording" htmlFor={`${ids}-consent`}>
            <Select id={`${ids}-consent`} value={consent} onChange={(e) => setConsent(e.target.value as ConsentKey)}>
              <option value="not_recorded">Not recorded</option>
              <option value="announced">Recorded, and the caller was told</option>
              <option value="granted">Recorded, and the caller agreed</option>
              <option value="unknown">Not sure</option>
            </Select>
          </Field>
          {(consent === "announced" || consent === "granted") && (
            <Field label="Recording link" htmlFor={`${ids}-rec`} optional error={errors.recording} hint="Where the recording is kept. Only a link is stored.">
              <Input id={`${ids}-rec`} type="url" inputMode="url" placeholder="https://" value={recordingUrl} onChange={(e) => setRecordingUrl(e.target.value)} aria-invalid={errors.recording ? true : undefined} />
            </Field>
          )}
        </div>
        {canFollowUp && (
          <div className="space-y-3 rounded-2xl border border-line p-3">
            <label className="flex cursor-pointer items-center gap-2 text-[14px] font-medium text-ink">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} />
              Create a follow-up task
            </label>
            {followUp && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Task" htmlFor={`${ids}-task`} optional className="sm:col-span-2">
                  <Input id={`${ids}-task`} maxLength={200} value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder={`Follow up on the call with ${contact?.name || "them"}`} />
                </Field>
                <Field label="Due" htmlFor={`${ids}-due`} optional error={errors.taskDue}>
                  <Input id={`${ids}-due`} type="datetime-local" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
                </Field>
                <Field label="For" htmlFor={`${ids}-assignee`}>
                  <Select id={`${ids}-assignee`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                    <option value="">Nobody yet</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                </Field>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
