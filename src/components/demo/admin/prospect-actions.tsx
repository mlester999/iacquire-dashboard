"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Eye, FileText, Hourglass, Plus, RotateCcw, ShieldBan, Trash2, UserCheck, UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { deliverySummary } from "@/components/admin/resend-invitation";
import {
  addProspectNoteAction, assignProspectAction, blockProspectAction, consultationDoneAction, convertProspectAction, declineProspectAction, eraseProspectAction, exportProspectAction,
  expireDemoAction, extendDemoAction, readTranscriptAction, reopenProspectAction,
} from "@/app/actions/demo-admin";
import type { ActionSet } from "@/lib/demo/admin-view";
import { MAX_NOTE_CHARS, MAX_REASON_CHARS, MIN_REASON_CHARS } from "@/lib/demo/rules";
import { formatDateTime } from "@/lib/utils";

// What an agency person can do to one prospect. The buttons shown follow the prospect's state and the person's permissions (src/lib/demo/admin-view.ts), but they are a
// convenience: every action is decided again on the server when it is pressed. Anything that ends a demo, erases details or makes a client asks for a reason or a confirmation first.

type Kind = "extend" | "expire" | "block" | "decline" | "erase" | "convert";

interface TranscriptLine {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  employeeRole: string | null;
  body: string;
  state: string | null;
  at: string;
}

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "Europe/London", "Australia/Sydney", "Asia/Manila", "Asia/Singapore", "UTC"];

const WORDS: Record<"expire" | "block" | "decline" | "erase", { title: string; description: string; confirm: string; danger: boolean }> = {
  expire: { title: "End this demo now", description: "The demo window closes at once. They can still read their conversation and ask for a consultation. You can extend the demo later.", confirm: "End the demo", danger: false },
  block: { title: "Block this prospect", description: "Their link and session stop working, the chat refuses them, and asking for a demo again sends them nothing. You can reopen them later.", confirm: "Block", danger: true },
  decline: { title: "Mark as not a fit", description: "Their access stops the same way a block does, but the record says only that they are not a fit. You can reopen them later.", confirm: "Mark as not a fit", danger: false },
  erase: { title: "Erase this prospect's details", description: "Removes their name, email address, business name, conversation, links and the copies of their emails, and the words your team wrote about them. The record that a demo was asked for stays, without any of it. This cannot be undone.", confirm: "Erase their details", danger: true },
};

export function ProspectActions({
  id,
  actions,
  owners,
  ownerUserId,
  extension,
  defaults,
  timeZone,
}: {
  id: string;
  actions: ActionSet;
  owners: Array<{ id: string; name: string }>;
  ownerUserId: string | null;
  extension: { hoursLeft: number; messagesLeft: number };
  defaults: { business: string; email: string };
  timeZone: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [dialog, setDialog] = React.useState<Kind | null>(null);
  const [reason, setReason] = React.useState("");
  const [hours, setHours] = React.useState("24");
  const [messages, setMessages] = React.useState("0");
  const [note, setNote] = React.useState("");
  const [owner, setOwner] = React.useState(ownerUserId ?? "");
  const [convert, setConvert] = React.useState({ name: defaults.business, email: defaults.email, timezone: "America/New_York" });
  const [problem, setProblem] = React.useState<string | null>(null);
  const [transcript, setTranscript] = React.useState<TranscriptLine[] | null>(null);
  const [converted, setConverted] = React.useState<{ orgId: string; emailStatus: string; emailError: string | null; inviteLink: string | null } | null>(null);

  function close() {
    setDialog(null);
    setReason("");
    setProblem(null);
  }

  /** Runs one action: a spinner on the buttons, the server's own sentence if it refuses, a fresh page when it works. */
  async function run<T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done: (data: T) => string | void, after?: () => void) {
    setBusy(true);
    setProblem(null);
    try {
      const r = await call();
      if (!r.ok) {
        setProblem(r.error);
        toast.error(r.error);
        return;
      }
      const message = done(r.data);
      if (message) toast.success(message);
      after?.();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const reasonShort = reason.trim().length < MIN_REASON_CHARS;

  function submitReason(kind: "expire" | "block" | "decline" | "erase") {
    const call = { expire: expireDemoAction, block: blockProspectAction, decline: declineProspectAction, erase: eraseProspectAction }[kind];
    return run<unknown>(() => call(id, reason), () => ({ expire: "The demo has ended.", block: "Blocked.", decline: "Marked as not a fit.", erase: "Their details were erased." })[kind], close);
  }

  async function download() {
    setBusy(true);
    try {
      const r = await exportProspectAction(id);
      if (!r.ok) return void toast.error(r.error);
      const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "prospect-export.json";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("The export was downloaded and recorded in the audit log.");
    } finally {
      setBusy(false);
    }
  }

  const any = Object.values(actions).some(Boolean);
  if (!any) return null;

  return (
    <section aria-labelledby="actions-heading" className="card-surface space-y-4 rounded-2xl p-4">
      <h2 id="actions-heading" className="text-[15px] font-semibold text-ink">
        Actions
      </h2>
      <div className="flex flex-wrap gap-2">
        {actions.readTranscript && (
          <Button variant="secondary" loading={busy} onClick={() => run(() => readTranscriptAction(id), (d) => void setTranscript(d.lines))}>
            <Eye className="size-4" aria-hidden />
            Read the conversation
          </Button>
        )}
        {actions.extend && (
          <Button variant="secondary" onClick={() => setDialog("extend")}>
            <Plus className="size-4" aria-hidden />
            Extend
          </Button>
        )}
        {actions.expireNow && (
          <Button variant="secondary" onClick={() => setDialog("expire")}>
            <Hourglass className="size-4" aria-hidden />
            End now
          </Button>
        )}
        {actions.consultationDone && (
          <Button variant="secondary" loading={busy} onClick={() => run(() => consultationDoneAction(id), () => "Marked as held.")}>
            <UserCheck className="size-4" aria-hidden />
            Consultation held
          </Button>
        )}
        {actions.convert && (
          <Button onClick={() => setDialog("convert")}>
            <UserRoundPlus className="size-4" aria-hidden />
            Make a client
          </Button>
        )}
        {actions.reopen && (
          <Button variant="secondary" loading={busy} onClick={() => run(() => reopenProspectAction(id), () => "Reopened.")}>
            <RotateCcw className="size-4" aria-hidden />
            Reopen
          </Button>
        )}
        {actions.decline && (
          <Button variant="outline" onClick={() => setDialog("decline")}>
            Not a fit
          </Button>
        )}
        {actions.block && (
          <Button variant="outline" onClick={() => setDialog("block")}>
            <ShieldBan className="size-4" aria-hidden />
            Block
          </Button>
        )}
        {actions.exportData && (
          <Button variant="ghost" loading={busy} onClick={download}>
            <Download className="size-4" aria-hidden />
            Export their data
          </Button>
        )}
        {actions.erase && (
          <Button variant="ghost" onClick={() => setDialog("erase")}>
            <Trash2 className="size-4" aria-hidden />
            Erase
          </Button>
        )}
      </div>

      {actions.assign && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => assignProspectAction(id, owner || null), () => "Saved.");
          }}
        >
          <Field label="Followed by" htmlFor="prospect-assign">
            <Select id="prospect-assign" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Nobody yet</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" loading={busy} disabled={(ownerUserId ?? "") === owner}>
            Save
          </Button>
        </form>
      )}

      {actions.note && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => addProspectNoteAction(id, note), () => "Note added.", () => setNote(""));
          }}
        >
          <Field label="Add a note" htmlFor="prospect-note" hint="Notes are kept on this prospect's timeline and are erased with them.">
            <Textarea id="prospect-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={MAX_NOTE_CHARS} rows={3} />
          </Field>
          <Button type="submit" variant="secondary" loading={busy} disabled={!note.trim()}>
            <FileText className="size-4" aria-hidden />
            Add the note
          </Button>
        </form>
      )}

      {problem && !dialog && (
        <p role="alert" className="text-[14px] text-danger-ink">
          {problem}
        </p>
      )}

      {transcript && (
        <div className="space-y-2" aria-live="polite">
          <p role="status" className="text-[13px] text-muted">
            You read this conversation just now. That was recorded on the timeline and in the audit log (who and how many lines, not the words).
          </p>
          {transcript.length === 0 ? (
            <p className="text-[14px] text-muted">They wrote nothing.</p>
          ) : (
            <ol className="max-h-[60dvh] space-y-2 overflow-y-auto rounded-xl border border-line bg-surface-2/50 p-3" tabIndex={0} aria-label="Conversation">
              {transcript.map((l) => (
                <li key={l.id}>
                  <p className="text-[12px] font-medium text-muted">
                    {l.role === "user" ? "Prospect" : l.role === "assistant" ? "AI assistant" : "System"} · {formatDateTime(l.at, timeZone)}
                    {l.state === "failed" ? " · not counted (no answer came)" : ""}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{l.body}</p>
                </li>
              ))}
            </ol>
          )}
          <Button variant="ghost" size="sm" onClick={() => setTranscript(null)}>
            Hide the conversation
          </Button>
        </div>
      )}

      {/* Reason dialogs: end now, block, not a fit, erase. */}
      {(["expire", "block", "decline", "erase"] as const).map((kind) => (
        <Dialog
          key={kind}
          open={dialog === kind}
          onOpenChange={(o) => !o && close()}
          title={WORDS[kind].title}
          description={WORDS[kind].description}
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant={WORDS[kind].danger ? "danger" : "primary"} loading={busy} disabled={reasonShort} onClick={() => submitReason(kind)}>
                {WORDS[kind].confirm}
              </Button>
            </>
          }
        >
          <Field label="Why" htmlFor={`reason-${kind}`} hint={`A few words, kept with the change (${MIN_REASON_CHARS} to ${MAX_REASON_CHARS} characters).`} error={dialog === kind ? problem : null}>
            <Textarea id={`reason-${kind}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_REASON_CHARS} rows={3} />
          </Field>
        </Dialog>
      ))}

      <Dialog
        open={dialog === "extend"}
        onOpenChange={(o) => !o && close()}
        title="Extend this demo"
        description={`You can add up to ${extension.hoursLeft} more hour${extension.hoursLeft === 1 ? "" : "s"} and ${extension.messagesLeft} more message${extension.messagesLeft === 1 ? "" : "s"} to this prospect, in all. An ended demo opens again from now.`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={reasonShort}
              onClick={() => run(() => extendDemoAction(id, { hours: Number(hours), extraMessages: Number(messages), reason }), () => "The demo was extended.", close)}
            >
              Extend
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hours to add" htmlFor="extend-hours">
            <Input id="extend-hours" type="number" inputMode="numeric" min={0} max={extension.hoursLeft} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          <Field label="Messages to add" htmlFor="extend-messages">
            <Input id="extend-messages" type="number" inputMode="numeric" min={0} max={extension.messagesLeft} step={1} value={messages} onChange={(e) => setMessages(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Why" htmlFor="reason-extend" hint="Required. Kept with the change." error={dialog === "extend" ? problem : null}>
            <Textarea id="reason-extend" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_REASON_CHARS} rows={3} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={dialog === "convert"}
        onOpenChange={(o) => {
          if (!o) {
            close();
            setConverted(null);
          }
        }}
        title="Make this prospect a client"
        description="Creates a client workspace, with six AI Employees that need setting up, and emails an invitation to the owner. The prospect's conversation is not copied into it. This is the same as creating a client by hand."
        footer={
          converted ? (
            <Button
              onClick={() => {
                const org = converted.orgId;
                setConverted(null);
                close();
                router.push(`/admin/clients/${org}`);
              }}
            >
              Open the client
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!convert.name.trim() || !convert.email.trim()} onClick={() => run(() => convertProspectAction(id, { name: convert.name, ownerEmail: convert.email, timezone: convert.timezone }), (d) => { setConverted(d); return "The client workspace was created."; })}>
                Create the client
              </Button>
            </>
          )
        }
      >
        {converted ? (
          (() => {
            const s = deliverySummary(converted.emailStatus, converted.emailError, convert.email);
            return (
              <div className="space-y-2 text-[14px] leading-relaxed" role="status">
                <p className="font-semibold text-ink">{s.title}</p>
                <p className="text-ink-2">{s.body}</p>
                {converted.inviteLink && (
                  <div className="space-y-1">
                    <p className="text-[13px] text-muted">The invitation link, to send to the owner yourself. It works once.</p>
                    <Input readOnly value={converted.inviteLink} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
                  </div>
                )}
              </div>
            );
          })()
        ) : (
          <div className="space-y-3">
            <Field label="Workspace name" htmlFor="convert-name">
              <Input id="convert-name" value={convert.name} onChange={(e) => setConvert({ ...convert, name: e.target.value })} maxLength={120} />
            </Field>
            <Field label="Owner's email" htmlFor="convert-email" hint="The invitation goes here. It starts as the address the prospect confirmed.">
              <Input id="convert-email" type="email" value={convert.email} onChange={(e) => setConvert({ ...convert, email: e.target.value })} maxLength={254} />
            </Field>
            <Field label="Time zone" htmlFor="convert-zone">
              <Select id="convert-zone" value={convert.timezone} onChange={(e) => setConvert({ ...convert, timezone: e.target.value })}>
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
            {problem && dialog === "convert" && (
              <p role="alert" className="text-[14px] text-danger-ink">
                {problem}
              </p>
            )}
          </div>
        )}
      </Dialog>
    </section>
  );
}
