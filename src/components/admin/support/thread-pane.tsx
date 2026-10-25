"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Lightbulb, Loader2, Lock, MessageSquare, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Select, Textarea } from "@/components/ui/primitives";
import { AttachmentPicker, type PickerState } from "@/components/support/attachment-picker";
import { MessageList, type PendingMessage } from "@/components/support/parts";
import { agencyMessageAction, draftReplyAction, missingInfoAction } from "@/app/actions/support-agency";
import { cn } from "@/lib/utils";
import type { AgencyRequestDetail } from "@/server/support/agency";
import type { TicketStatus } from "@/lib/support/lifecycle";

type Mode = "reply" | "note";
type Draft = { text: string; warnings: string[] } | { reason: string };

/**
 * The conversation and the composer. A public reply and an internal note are different things and look different: the composer says
 * which one is being written, a note is outlined and labelled as hidden from the client, and the buttons never share a label.
 * Sending is safe to retry: a message that fails stays on screen with a "Try again" and cannot be duplicated.
 */
export function ThreadPane({ detail, timeZone, onChanged, focusReply }: {
  detail: AgencyRequestDetail;
  timeZone: string;
  onChanged: () => Promise<unknown>;
  focusReply: number;
}) {
  const t = detail.ticket;
  const caps = detail.caps;
  const canNote = caps["agency.support.notes"] && caps["agency.support.manage"];
  const [mode, setMode] = React.useState<Mode>("reply");
  const [body, setBody] = React.useState("");
  const [after, setAfter] = React.useState<"" | "keep" | TicketStatus>("");
  const [files, setFiles] = React.useState<PickerState>({ ids: [], busy: false, failed: false });
  const [pickerKey, setPickerKey] = React.useState(0);
  const [pending, setPending] = React.useState<PendingMessage[]>([]);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  const [questions, setQuestions] = React.useState<{ items: string[] } | { reason: string } | null>(null);
  const areaRef = React.useRef<HTMLTextAreaElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const internal = mode === "note";
  const closed = t.status === "closed";
  const canWrite = caps["agency.support.manage"];
  const finished = t.status === "resolved" || t.status === "closed";

  // The "r" shortcut in the workspace bumps this counter to bring the cursor to the reply box.
  React.useEffect(() => {
    if (focusReply > 0) areaRef.current?.focus();
  }, [focusReply]);

  // Scroll to the newest message when the conversation changes.
  const count = detail.messages.length + pending.length;
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [count, t.id]);

  const send = async (m: PendingMessage & { status?: TicketStatus }) => {
    setPending((list) => (list.some((p) => p.clientMessageId === m.clientMessageId) ? list.map((p) => (p.clientMessageId === m.clientMessageId ? { ...m, state: "sending", error: undefined } : p)) : [...list, m]));
    const res = await agencyMessageAction(t.id, { body: m.body, internal: m.internal ?? false, status: m.status, clientMessageId: m.clientMessageId, attachmentIds: m.files.map((f) => f.id) });
    if (!res.ok) {
      setPending((list) => list.map((p) => (p.clientMessageId === m.clientMessageId ? { ...p, state: "failed", error: res.error } : p)));
      return;
    }
    await onChanged();
    setPending((list) => list.filter((p) => p.clientMessageId !== m.clientMessageId));
  };
  const statusFor = (): TicketStatus | undefined => (after === "keep" ? t.status : after === "" ? undefined : after);
  // A retry resends exactly what was attempted (same message id, so it can never post twice).
  const attempts = React.useRef(new Map<string, TicketStatus | undefined>());

  const submit = async () => {
    const text = body.trim();
    if (!text || files.busy || files.failed || !canWrite) return;
    const message: PendingMessage = { clientMessageId: crypto.randomUUID(), body: text, files: files.ids.map((id) => ({ id, name: "", sizeBytes: 0 })), state: "sending", internal };
    const status = internal ? undefined : t.requestType === "feedback" ? undefined : statusFor();
    attempts.current.set(message.clientMessageId, status);
    setBody(""); setAfter(""); setDraft(null); setQuestions(null);
    setFiles({ ids: [], busy: false, failed: false });
    setPickerKey((k) => k + 1);
    await send({ ...message, status });
  };

  const suggest = async () => {
    setDrafting(true);
    setDraft(null);
    const res = await draftReplyAction(t.id, body.trim() || undefined);
    setDrafting(false);
    if (!res.ok) setDraft({ reason: res.error });
    else if (!res.data.ok) setDraft({ reason: res.data.reason });
    else setDraft(res.data.data);
  };
  const missing = async () => {
    const res = await missingInfoAction(t.id);
    if (!res.ok) setQuestions({ reason: res.error });
    else if (!res.data.ok) setQuestions({ reason: res.data.reason });
    else setQuestions({ items: res.data.data });
  };

  return (
    <div className="space-y-4">
      {detail.messages.length === 0 && pending.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-surface"><EmptyState compact icon={<MessageSquare className="size-5" />} title="No messages yet" description="The conversation starts with the first message." /></div>
      ) : (
        <MessageList messages={detail.messages} pending={pending} viewer="agency" timeZone={timeZone}
          onRetry={(p) => void send({ ...p, status: attempts.current.get(p.clientMessageId) })} onDiscard={(p) => setPending((list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))} />
      )}
      <div ref={bottomRef} />

      {!canWrite ? (
        <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2/70 px-4 py-3.5 text-[13px] text-ink-2"><Lock className="mt-0.5 size-4 shrink-0" aria-hidden /> You can read this request, but your role doesn&apos;t allow replying to it.</div>
      ) : (
        <div className={cn("rounded-2xl border bg-surface p-3 shadow-card focus-within:ring-4", internal ? "border-warning/50 bg-warning-soft/30 focus-within:ring-warning/15" : "border-line-strong focus-within:border-primary focus-within:ring-primary/10")}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div role="radiogroup" aria-label="Message type" className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5">
              {([["reply", "Reply to client"], ["note", "Internal note"]] as const).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={value === "note" && !canNote} onClick={() => setMode(value)}
                  title={value === "note" && !canNote ? "Your role doesn't allow internal notes" : undefined}
                  className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium transition disabled:opacity-50", mode === value ? (value === "note" ? "bg-warning-soft text-warning-ink shadow-soft" : "bg-surface text-ink shadow-soft") : "text-muted hover:text-ink")}>
                  {value === "note" && <Lock className="size-3" aria-hidden />}{label}
                </button>
              ))}
            </div>
            {internal ? <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-warning-ink"><Lock className="size-3.5" aria-hidden /> Only your team will see this. The client is not notified.</span>
              : <span className="text-[12px] text-muted">The client is notified.</span>}
          </div>
          <label htmlFor="agency-reply" className="sr-only">{internal ? "Internal note" : "Reply to the client"}</label>
          <Textarea id="agency-reply" ref={areaRef} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={4} aria-keyshortcuts="r"
            placeholder={internal ? "Write a note for the team…" : "Write a reply to the client…"} className="border-0 bg-transparent shadow-none focus:ring-0"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); } if (e.key === "Escape") (e.target as HTMLElement).blur(); }} />

          {!internal && (
            <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
              <Button type="button" size="sm" variant="soft" onClick={() => void suggest()} disabled={drafting}>{drafting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />} Suggest a reply</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => void missing()}><Lightbulb className="size-3.5" aria-hidden /> What&apos;s missing?</Button>
              <span className="text-[12px] text-muted">AI drafts are suggestions. Read, edit and send yourself.</span>
            </div>
          )}
          {draft && (
            <div className="mt-2 rounded-xl border border-primary/20 bg-primary-soft/40 p-3.5" role="region" aria-label="Suggested reply">
              {"reason" in draft ? <p className="text-[13px] text-ink-2">{draft.reason}</p> : (
                <>
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-primary-ink">Suggested reply (not sent)</p>
                  <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{draft.text}</p>
                  {draft.warnings.length > 0 && (
                    <ul className="mt-2.5 space-y-1" aria-label="Check before sending">
                      {draft.warnings.map((w) => <li key={w} className="flex items-start gap-1.5 text-[12.5px] text-warning-ink"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {w}</li>)}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="brand" onClick={() => { setBody(draft.text); setDraft(null); areaRef.current?.focus(); }}>Use this draft</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
                  </div>
                </>
              )}
              {"reason" in draft && <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setDraft(null)}>Dismiss</Button>}
            </div>
          )}
          {questions && (
            <div className="mt-2 rounded-xl border border-line bg-surface-2/60 p-3.5" role="region" aria-label="Missing information">
              {"reason" in questions ? <p className="text-[13px] text-ink-2">{questions.reason}</p> : questions.items.length === 0 ? <p className="text-[13px] text-ink-2">Nothing obvious is missing from this request.</p> : (
                <>
                  <p className="text-[12.5px] font-medium text-ink-2">Questions that could move this forward:</p>
                  <ul className="mt-1.5 space-y-1">{questions.items.map((q) => (
                    <li key={q} className="flex items-start justify-between gap-3 text-[13px] text-ink"><span>{q}</span><button type="button" className="shrink-0 text-[12px] font-medium text-primary-ink hover:underline" onClick={() => setBody((b) => `${b}${b && !b.endsWith("\n") ? "\n" : ""}${q}`)}>Add to reply</button></li>
                  ))}</ul>
                </>
              )}
              <button type="button" aria-label="Close" className="mt-2 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink" onClick={() => setQuestions(null)}><X className="size-3" aria-hidden /> Close</button>
            </div>
          )}

          <div className="mt-2 border-t border-line pt-2.5">
            <AttachmentPicker key={`${pickerKey}-${internal}`} compact maxMb={detail.maxAttachmentMb} maxFiles={detail.maxAttachments} onChange={setFiles} ticketId={t.id} internal={internal} label="Attach" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            {!internal && t.requestType !== "feedback" && (
              <>
                <label className="sr-only" htmlFor="agency-after">What happens to the status after sending</label>
                <Select id="agency-after" value={after} onChange={(e) => setAfter(e.target.value as typeof after)} className="w-full sm:h-10 sm:w-60">
                  <option value="">{closed ? "Reopen? Choose a status" : "Then: waiting on client"}</option>
                  <option value="keep">Keep current status ({t.status.replace(/_/g, " ")})</option>
                  {t.status !== "in_progress" && <option value="in_progress">Then: in progress</option>}
                  {caps["agency.support.resolve"] && !finished && <option value="resolved">Then: resolved</option>}
                  {caps["agency.support.resolve"] && t.status !== "closed" && <option value="closed">Then: closed</option>}
                  {caps["agency.support.resolve"] && closed && <option value="open">Reopen as open</option>}
                </Select>
              </>
            )}
            <span className="hidden text-[12px] text-muted sm:inline">Ctrl or ⌘ + Enter to send</span>
            <Button type="button" className="ml-auto" variant={internal ? "secondary" : "brand"} size="sm" disabled={!body.trim() || files.busy || files.failed} onClick={() => void submit()}>
              <Send className="size-3.5" aria-hidden /> {files.busy ? "Uploading…" : internal ? "Add internal note" : "Send reply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function toastFor(res: { ok: boolean; error?: string }, success: string) {
  if (res.ok) toast.success(success);
  else toast.error(res.error ?? "That didn't work. Please try again.");
}
