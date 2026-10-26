"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Info, LifeBuoy, Loader2, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { AttachmentPicker, type PickerState } from "@/components/support/attachment-picker";
import { ASSISTANT_REQUEST_TYPES, CATEGORIES_BY_TYPE, REQUEST_TYPE_LABELS, categoryLabel, type RequestType } from "@/lib/support/lifecycle";
import { newIdempotencyKey } from "@/lib/support/content";
import { cn } from "@/lib/utils";

interface Draft {
  subject: string;
  description: string;
  requestType: RequestType;
  category: string;
  reason: string;
  excerpt: Array<{ role: "user" | "assistant"; text: string }>;
  pageContext: string;
  sharedSummary: string;
  limits: { maxMb: number; maxFiles: number };
  expectation: string | null;
}

type Phase = "loading" | "edit" | "sending" | "sent" | "failed";

/**
 * "Prepare support request": AQi drafts a request from the person's conversation and the person decides everything. They can edit
 * the subject, description and topic, choose whether any of the conversation is shared (and must agree to it explicitly), add files, and
 * only then press Send. A reference is shown only after the server confirms the request exists; if sending fails, no request is
 * claimed, and sending again can't create a duplicate.
 */
export function AqiSupportDialog({ open, conversationId, onClose }: { open: boolean; conversationId: string | null; onClose: () => void }) {
  // The body is mounted only while the dialog is open, so every opening starts from a clean slate and a fresh proposal.
  return <AnimatePresence>{open && <SupportDialogBody key="aqi-support" conversationId={conversationId} onClose={onClose} />}</AnimatePresence>;
}

function SupportDialogBody({ conversationId, onClose }: { conversationId: string | null; onClose: () => void }) {
  const [phase, setPhase] = React.useState<Phase>(conversationId ? "loading" : "failed");
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [error, setError] = React.useState<string | null>(conversationId ? null : "Ask AQi something first, then I can help you prepare a request.");
  const [subject, setSubject] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [requestType, setRequestType] = React.useState<RequestType>("support");
  const [category, setCategory] = React.useState("general");
  const [share, setShare] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [files, setFiles] = React.useState<PickerState>({ ids: [], busy: false, failed: false });
  const [result, setResult] = React.useState<{ id: string; ref: string; status: string; existing: boolean; expectation: string | null } | null>(null);
  const key = React.useRef(newIdempotencyKey());
  const lock = React.useRef(false);
  const subjectRef = React.useRef<HTMLInputElement>(null);

  // Ask the server for a proposal. Nothing is created by this.
  React.useEffect(() => {
    if (!conversationId) return;
    let live = true;
    void fetch("/api/aqi/support/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId }) })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as (Draft & { error?: string }) | null;
        if (!live) return;
        if (!res.ok || !data || !("subject" in data)) throw new Error(data?.error ?? "I couldn't prepare a request just now.");
        setDraft(data); setSubject(data.subject); setDescription(data.description); setRequestType(data.requestType); setCategory(data.category); setPhase("edit");
      })
      .catch((err: unknown) => { if (live) { setError(err instanceof Error ? err.message : "I couldn't prepare a request just now."); setPhase("failed"); } });
    return () => { live = false; };
  }, [conversationId]);

  React.useEffect(() => {
    if (phase === "edit") subjectRef.current?.focus();
  }, [phase]);

  // Escape closes the dialog, except while a send is in flight (closing then would hide whether the request was made).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || phase === "sending") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, onClose]);

  const categories = CATEGORIES_BY_TYPE[requestType];
  const changeType = (t: RequestType) => {
    setRequestType(t);
    if (!(CATEGORIES_BY_TYPE[t] as readonly string[]).includes(category)) setCategory(CATEGORIES_BY_TYPE[t][0]);
  };

  const canSend = phase === "edit" && subject.trim().length >= 3 && description.trim().length >= 5 && (!share || consent) && !files.busy && !files.failed;

  async function send() {
    if (!canSend || lock.current || !conversationId) return;
    lock.current = true;
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch("/api/aqi/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, subject, description, requestType, category, includeConversation: share, consent: share && consent, idempotencyKey: key.current, attachmentIds: files.ids }),
      });
      const data = (await res.json().catch(() => null)) as { id?: string; ref?: string; status?: string; existing?: boolean; expectation?: string | null; error?: string } | null;
      if (!res.ok || !data?.id || !data.ref) throw new Error(data?.error ?? "Your request could not be sent.");
      setResult({ id: data.id, ref: data.ref, status: data.status ?? "new", existing: Boolean(data.existing), expectation: data.expectation ?? null });
      setPhase("sent");
    } catch (err) {
      setError(err instanceof TypeError ? "We couldn't reach the server, so we can't confirm your request was sent. Check your connection and press Send again; it won't create a duplicate." : err instanceof Error ? err.message : "Your request could not be sent.");
      setPhase("edit");
    } finally {
      lock.current = false;
    }
  }

  return (
    <>
      {(
        <motion.div className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-black/35 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div role="dialog" aria-modal="true" aria-labelledby="aqi-support-title" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="my-auto w-full max-w-lg rounded-2xl border border-line bg-surface p-5 shadow-float">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink" aria-hidden><LifeBuoy className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <h2 id="aqi-support-title" className="text-[16px] font-semibold tracking-tight text-ink">{phase === "sent" ? "Your request has been sent" : "Prepare a support request"}</h2>
                {phase !== "sent" && <p className="mt-1 text-[13px] leading-relaxed text-muted">I&apos;ve drafted this from our chat. Check it, change anything, then send it. Nothing is sent until you press <strong className="font-medium text-ink-2">Send</strong>.</p>}
              </div>
            </div>

            {phase === "loading" && <p role="status" className="mt-6 flex items-center justify-center gap-2 py-8 text-[14px] text-muted"><Loader2 className="size-4 animate-spin" aria-hidden /> Preparing your request…</p>}

            {phase === "failed" && (
              <div className="mt-4 space-y-3">
                <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft p-3 text-[13px] text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}</p>
                <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Link href="/support" className="inline-flex h-9 items-center rounded-xl border border-line px-3 text-[13px] font-medium hover:bg-surface-2">Open the Support page instead</Link></div>
              </div>
            )}

            {phase === "sent" && result && (
              <div className="mt-4 space-y-4" role="status" aria-live="polite">
                <div className="flex flex-col items-center rounded-xl border border-success/25 bg-success-soft/60 p-5 text-center">
                  <CheckCircle2 className="size-7 text-success-ink" aria-hidden />
                  <p className="mt-2 text-[14px] text-ink-2">{result.existing ? "This request had already been sent, so nothing was duplicated." : "The iAcquire team has your request and will reply in the Support area."}</p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2"><span className="rounded-lg bg-surface px-2.5 py-1 font-mono text-[14px] font-semibold text-ink ring-1 ring-inset ring-line">{result.ref}</span><StatusPill status={result.status} tone="primary">Received</StatusPill></div>
                  {result.expectation && <p className="mt-3 text-[13px] text-ink-2">{result.expectation}</p>}
                </div>
                <div className="flex flex-wrap gap-2"><Link href={`/support/${result.id}`} className="inline-flex h-9 items-center rounded-xl bg-primary px-3.5 text-[13px] font-semibold text-primary-on hover:brightness-110" onClick={onClose}>View your request</Link><Button variant="ghost" onClick={onClose}>Done</Button></div>
              </div>
            )}

            {(phase === "edit" || phase === "sending") && draft && (
              <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); void send(); }} aria-busy={phase === "sending"}>
                {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft p-3 text-[13px] leading-relaxed text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span>{error}<span className="mt-1 block text-[12px] opacity-90">No request has been created.</span></span></p>}
                <Field label="Subject" htmlFor="aqi-support-subject"><Input ref={subjectRef} id="aqi-support-subject" maxLength={160} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={phase === "sending"} /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="This is a" htmlFor="aqi-support-type"><Select id="aqi-support-type" value={requestType} onChange={(e) => changeType(e.target.value as RequestType)} disabled={phase === "sending"}>{ASSISTANT_REQUEST_TYPES.map((t) => <option key={t} value={t}>{REQUEST_TYPE_LABELS[t].label}</option>)}</Select></Field>
                  <Field label="Topic" htmlFor="aqi-support-category"><Select id="aqi-support-category" value={category} onChange={(e) => setCategory(e.target.value)} disabled={phase === "sending"}>{categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</Select></Field>
                </div>
                <p className="-mt-1 text-[12px] text-muted">{draft.reason}</p>
                <Field label="Description" htmlFor="aqi-support-description" hint={<span className="tabular-nums">{description.length.toLocaleString("en-US")} / 2,500</span>}>
                  <Textarea id="aqi-support-description" rows={5} maxLength={2500} value={description} onChange={(e) => setDescription(e.target.value)} disabled={phase === "sending"} />
                </Field>

                <fieldset className="rounded-xl border border-line bg-surface-2/50 p-3.5" disabled={phase === "sending"}>
                  <legend className="px-1 text-[13px] font-semibold text-ink">What to share from our chat</legend>
                  <label className="flex items-start gap-2.5 text-[14px] leading-relaxed text-ink-2"><input type="checkbox" className="mt-1" checked={share} onChange={(e) => { setShare(e.target.checked); if (!e.target.checked) setConsent(false); }} /> <span><strong className="font-medium text-ink">Share my conversation with AQi.</strong> It helps the team see what you already tried.</span></label>
                  {!share && <p className="mt-2 flex items-start gap-1.5 pl-6 text-[12px] text-muted"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Only the subject and description above will be sent. Nothing from our chat is shared.</p>}
                  {share && (
                    <div className="mt-3 space-y-3 pl-6">
                      <div>
                        <p className="text-[12px] font-medium text-ink-2">This is exactly what would be shared:</p>
                        <ul className="mt-1.5 max-h-44 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-surface p-2.5 text-[13px] leading-relaxed" aria-label="Messages that would be shared">
                          {draft.excerpt.map((m, i) => <li key={i} className={cn("whitespace-pre-wrap break-words", m.role === "user" ? "text-ink" : "text-muted")}><strong className="font-medium">{m.role === "user" ? "Me" : "AQi"}:</strong> {m.text}</li>)}
                        </ul>
                        <p className="mt-1.5 text-[12px] text-muted">Plus the page you were on: <code className="rounded bg-surface-3 px-1 text-ink-2">{draft.pageContext}</code>. Passwords and keys are removed.</p>
                      </div>
                      <label className="flex items-start gap-2.5 text-[13px] leading-relaxed text-ink-2"><input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I agree to share these messages and this page with iAcquire support.</label>
                    </div>
                  )}
                </fieldset>

                <div>
                  <p className="mb-1.5 text-[14px] font-medium text-ink-2">Attach files <span className="text-[12px] font-normal text-faint">Optional</span></p>
                  <AttachmentPicker compact maxMb={draft.limits.maxMb} maxFiles={draft.limits.maxFiles} onChange={setFiles} disabled={phase === "sending"} />
                  <p className="mt-1.5 text-[12px] text-muted">Files from your AQi chat are never copied. Add only what you want the team to see.</p>
                </div>

                {draft.expectation && <p className="flex items-start gap-2 text-[13px] text-ink-2"><Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />{draft.expectation}</p>}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button type="submit" variant="brand" disabled={!canSend} loading={phase === "sending"}>{phase !== "sending" && <Send className="size-4" aria-hidden />} {phase === "sending" ? "Sending…" : "Send to iAcquire support"}</Button>
                  <Button type="button" variant="ghost" onClick={onClose} disabled={phase === "sending"}>Cancel</Button>
                  {share && !consent && <span className="text-[12px] text-warning-ink">Tick the box above to share the conversation, or turn sharing off.</span>}
                </div>
                <p className="text-[12px] text-faint">AQi never claims a request exists until it is confirmed here. If something goes wrong you can also use the <Link href="/support" className="text-primary underline">Support page</Link>.</p>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
