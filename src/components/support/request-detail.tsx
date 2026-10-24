"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, CalendarClock, CheckCircle2, Clock3, History, Hourglass, Info, Lock, MessageCircleReply, MessageSquare, RotateCcw, Send, ShieldCheck, Tag, UserCheck, UserRound, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { AccentStrip, IconTile, Notice, type PanelTone } from "@/components/settings/panel";
import { AttachmentPicker, type PickerState } from "@/components/support/attachment-picker";
import { SupportSurveyCard } from "@/components/support/survey-card";
import { MessageList, Timeline, type PendingMessage } from "@/components/support/parts";
import { markRequestReadAction, postMessageAction, reopenRequestAction } from "@/app/actions/support";
import {
  REQUEST_TYPE_LABELS, categoryLabel, clientProgressSentence, featureLabel, statusLabelForClient, type FeedbackStage,
} from "@/lib/support/lifecycle";
import { describeDiagnostics } from "@/lib/support/content";
import { CHANGE_ORDER_STATUS_LABEL, type ChangeOrderStatus } from "@/lib/project-change-orders";
import { formatDateTime, relativeTime } from "@/lib/utils";
import type { ClientRequestDetail } from "@/server/support/types";
import type { SurveyView } from "@/lib/support/surveys";

const tone = (status: string): PanelTone => (status === "resolved" ? "success" : status === "closed" ? "neutral" : status === "waiting_for_client" ? "warning" : "primary");

const POLL_MS = 20_000;

/**
 * One request as its owner sees it: where it stands in plain words, the conversation, a reply box that survives a flaky connection
 * (a failed message stays on screen with a retry, and sending twice never duplicates), the history, and a way to reopen it.
 * The page refreshes itself every few seconds while it is open and visible; if that ever fails it simply keeps what it has.
 */
export function RequestDetailView({ initial, timeZone, survey = null }: { initial: ClientRequestDetail; timeZone: string; survey?: SurveyView | null }) {
  const [detail, setDetail] = React.useState(initial);
  const [body, setBody] = React.useState("");
  const [files, setFiles] = React.useState<PickerState>({ ids: [], busy: false, failed: false });
  const [pickerKey, setPickerKey] = React.useState(0);
  const [pending, setPending] = React.useState<PendingMessage[]>([]);
  const [reopenOpen, setReopenOpen] = React.useState(false);
  const [reopenNote, setReopenNote] = React.useState("");
  const [reopening, setReopening] = React.useState(false);
  const [live, setLive] = React.useState<"live" | "paused">("live");
  const lastAgencyId = React.useRef<string | null>(initial.messages.filter((m) => m.authorKind === "agency").at(-1)?.id ?? null);
  const t = detail.ticket;

  // The reply box needs the bottom of a phone screen; the floating AQi launcher moves above it (src/app/globals.css reads this attribute).
  React.useEffect(() => {
    document.body.dataset.aqiComposer = "true";
    return () => {
      delete document.body.dataset.aqiComposer;
    };
  }, []);

  const refresh = React.useCallback(async (): Promise<ClientRequestDetail | null> => {
    try {
      const res = await fetch(`/api/support/${t.id}/thread`, { cache: "no-store" });
      if (!res.ok) return null;
      const next = (await res.json()) as ClientRequestDetail;
      setDetail(next);
      const newest = next.messages.filter((m) => m.authorKind === "agency").at(-1)?.id ?? null;
      if (newest && newest !== lastAgencyId.current) {
        if (lastAgencyId.current !== null) toast.message("New reply from iAcquire");
        lastAgencyId.current = newest;
        void markRequestReadAction(t.id);
      }
      return next;
    } catch {
      return null;
    }
  }, [t.id]);

  React.useEffect(() => {
    void markRequestReadAction(t.id);
  }, [t.id]);

  // Keep the page current while it is visible; pause while the tab is hidden and catch up when it returns.
  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
      setLive("live");
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") { void refresh(); start(); } else { if (timer) clearInterval(timer); setLive("paused"); }
    };
    start();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  const send = async (message: PendingMessage) => {
    setPending((list) => (list.some((p) => p.clientMessageId === message.clientMessageId) ? list.map((p) => (p.clientMessageId === message.clientMessageId ? { ...message, state: "sending", error: undefined } : p)) : [...list, message]));
    const res = await postMessageAction(t.id, { body: message.body, clientMessageId: message.clientMessageId, attachmentIds: message.files.map((f) => f.id) });
    if (!res.ok) {
      setPending((list) => list.map((p) => (p.clientMessageId === message.clientMessageId ? { ...p, state: "failed", error: res.error } : p)));
      return;
    }
    await refresh();
    setPending((list) => list.filter((p) => p.clientMessageId !== message.clientMessageId));
  };

  const submit = async () => {
    const text = body.trim();
    if (!text || files.busy || files.failed) return;
    const message: PendingMessage = { clientMessageId: crypto.randomUUID(), body: text, files: files.ids.map((id) => ({ id, name: "", sizeBytes: 0 })), state: "sending" };
    setBody("");
    setFiles({ ids: [], busy: false, failed: false });
    setPickerKey((k) => k + 1);
    await send(message);
  };

  const reopen = async () => {
    setReopening(true);
    const res = await reopenRequestAction(t.id, reopenNote.trim() || undefined);
    setReopening(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setReopenOpen(false);
    setReopenNote("");
    toast.success("Your request has been reopened.");
    await refresh();
  };

  const done = t.status === "resolved" || t.status === "closed";
  const assigned = t.isAssigned;
  const hasAgencyReply = detail.messages.some((m) => m.authorKind === "agency");
  const progress = clientProgressSentence({ status: t.status, type: t.requestType, stage: t.feedbackStage as FeedbackStage | null, assigned, hasAgencyReply });
  const progressTone: PanelTone = t.status === "waiting_for_client" ? "warning" : done ? "success" : assigned ? "primary" : "neutral";
  const ProgressIcon = t.status === "waiting_for_client" ? MessageCircleReply : done ? CheckCircle2 : assigned ? UserCheck : Hourglass;
  const statusText = statusLabelForClient(t.status, t.requestType, t.feedbackStage as FeedbackStage | null);

  return (
    <div className="mx-auto min-w-0 max-w-3xl space-y-5">
      <Link href="/support/requests" className="inline-flex h-10 items-center gap-1.5 rounded-lg pr-2 text-[13px] font-medium text-muted transition hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> My Requests
      </Link>

      <Card className="relative overflow-hidden p-5 sm:p-6">
        <AccentStrip tone={tone(t.status)} />
        <div className="flex items-start gap-4">
          <IconTile icon={<MessageSquare />} tone={tone(t.status)} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <InfoChip className="font-mono text-[11px] tracking-tight">{t.ref}</InfoChip>
              <StatusPill tone={tone(t.status)}>{statusText}</StatusPill>
              <InfoChip icon={<Wrench aria-hidden />}>{REQUEST_TYPE_LABELS[t.requestType].label}</InfoChip>
              <InfoChip icon={<Tag aria-hidden />}>{categoryLabel(t.category)}</InfoChip>
              {t.affectedFeature && <InfoChip>{featureLabel(t.affectedFeature)}</InfoChip>}
            </div>
            <h1 className="mt-3 break-words text-[22px] font-semibold leading-snug tracking-tight text-ink">{t.subject}</h1>
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <InfoChip icon={<CalendarClock aria-hidden />}>Sent {formatDateTime(t.createdAt, timeZone)}</InfoChip>
              {t.createdByName && <InfoChip icon={<UserRound aria-hidden />}>By {t.createdByName}</InfoChip>}
              <InfoChip icon={<Clock3 aria-hidden />}><span suppressHydrationWarning>Updated {relativeTime(t.lastActivityAt)}</span></InfoChip>
            </div>
          </div>
        </div>
        <Notice className="mt-5" tone={progressTone} icon={<ProgressIcon />} role="status">
          {progress}
          {detail.expectation && <span className="mt-1 block text-[12.5px] text-muted">{detail.expectation}</span>}
        </Notice>
        {t.status === "resolved" && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-success/25 bg-success-soft/60 p-3.5">
            <CheckCircle2 className="size-5 shrink-0 text-success-ink" aria-hidden />
            <p className="min-w-0 flex-1 text-[13.5px] text-ink-2">Marked resolved{t.resolvedAt ? ` on ${formatDateTime(t.resolvedAt, timeZone)}` : ""}. {detail.canReopen ? `If it isn't sorted, you can reopen it for ${detail.reopenWindowDays} days.` : ""}</p>
            {detail.canReopen && <Button type="button" variant="secondary" size="sm" onClick={() => setReopenOpen(true)}><RotateCcw className="size-3.5" aria-hidden /> Reopen</Button>}
          </div>
        )}
      </Card>

      {survey && <SupportSurveyCard survey={survey} />}

      {detail.linkedChange && (
        <Card className="p-5" role="region" aria-labelledby="linked-change-title">
          <h2 id="linked-change-title" className="text-[15px] font-semibold tracking-tight text-ink">Also on your project&apos;s change list</h2>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
            <span className="font-mono text-[12px] text-muted">{detail.linkedChange.ref}</span> {detail.linkedChange.title}
            <StatusPill size="sm" tone={detail.linkedChange.status === "quoted" ? "warning" : detail.linkedChange.status === "accepted" || detail.linkedChange.status === "applied" ? "success" : detail.linkedChange.status === "declined" || detail.linkedChange.status === "withdrawn" ? "neutral" : "primary"}>{CHANGE_ORDER_STATUS_LABEL[detail.linkedChange.status as ChangeOrderStatus] ?? detail.linkedChange.status}</StatusPill>
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">On {detail.linkedChange.projectRef} Â· {detail.linkedChange.projectTitle}. A quote, if the team sends one, waits there for the owner&apos;s decision.</p>
          <Link href={`/projects/${detail.linkedChange.projectId}#project-changes`} className="mt-2 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline">Open the project&apos;s change requests</Link>
        </Card>
      )}

      <section aria-labelledby="conv-title" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="conv-title" className="text-[17px] font-semibold tracking-tight text-ink">Conversation</h2>
          <span className="text-[11.5px] text-muted" aria-live="off">{live === "live" ? "Updates automatically" : "Paused while this tab is hidden"}</span>
        </div>
        {detail.messages.length === 0 && pending.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-strong bg-surface">
            <EmptyState compact icon={<MessageSquare className="size-5" />} title="No messages yet" description="The conversation starts with your first message." />
          </div>
        ) : (
          <MessageList messages={detail.messages} pending={pending} viewer="client" timeZone={timeZone} seenAt={detail.teamLastReadAt}
            onRetry={(p) => void send(p)} onDiscard={(p) => setPending((list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))} />
        )}

        {detail.canReply ? (
          <div className="rounded-2xl border border-line-strong bg-surface p-3 shadow-card focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
            <label htmlFor="request-reply" className="sr-only">Your reply</label>
            <Textarea id="request-reply" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={3} placeholder={done ? "Add a message to reopen this requestâ€¦" : "Write a replyâ€¦"}
              className="border-0 shadow-none focus:ring-0"
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }} />
            <div className="border-t border-line pt-3">
              <AttachmentPicker key={pickerKey} compact maxMb={detail.maxAttachmentMb} maxFiles={detail.maxAttachments} onChange={setFiles} label="Add files" />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11.5px] text-muted">Press Ctrl or âŒ˜ + Enter to send</p>
              <Button type="button" variant="brand" size="sm" disabled={!body.trim() || files.busy || files.failed} onClick={() => void submit()}>
                <Send className="size-3.5" aria-hidden /> {files.busy ? "Uploading filesâ€¦" : done ? "Reopen and send" : "Send reply"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2/70 px-4 py-3.5 text-[13px] leading-relaxed text-ink-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-3 text-muted" aria-hidden><Lock className="size-4" /></span>
            <div className="min-w-0 flex-1 pt-1">
              <p>{detail.replyBlockedReason}</p>
              <Link href="/support" className="mt-1 inline-flex items-center gap-1 font-medium text-primary-ink hover:underline">Start a new request</Link>
            </div>
          </div>
        )}
      </section>

      {t.diagnostics && (
        <Card className="p-5">
          <div className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-xl bg-surface-2 text-ink-2" aria-hidden><ShieldCheck className="size-4" /></span><h2 className="text-[15px] font-semibold tracking-tight text-ink">Technical details you shared</h2></div>
          <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
            {describeDiagnostics(t.diagnostics).map((r) => (<React.Fragment key={r.label}><dt className="text-muted">{r.label}</dt><dd className="min-w-0 break-words font-medium text-ink">{r.value}</dd></React.Fragment>))}
          </dl>
        </Card>
      )}

      <Card className="p-5">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
            <span className="grid size-8 place-items-center rounded-xl bg-surface-2 text-ink-2" aria-hidden><History className="size-4" /></span>
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">Activity</h2>
            <span className="ml-auto text-[12px] text-muted group-open:hidden">Show</span>
            <span className="ml-auto hidden text-[12px] text-muted group-open:inline">Hide</span>
          </summary>
          <div className="mt-4"><Timeline entries={detail.timeline} viewer="client" timeZone={timeZone} /></div>
        </details>
      </Card>

      <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-muted"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Please don&apos;t share passwords, API keys or payment details in this conversation.</p>

      <Dialog open={reopenOpen} onOpenChange={setReopenOpen} title="Reopen this request?" icon={<RotateCcw />} size="sm" description="The iAcquire team will be told, and the request goes back to their queue."
        footer={<><Button variant="secondary" onClick={() => setReopenOpen(false)}>Cancel</Button><Button variant="brand" loading={reopening} onClick={() => void reopen()}>Reopen request</Button></>}>
        <label htmlFor="reopen-note" className="text-[13px] font-medium text-ink-2">What&apos;s still not right? <span className="text-[12px] font-normal text-faint">Optional</span></label>
        <Textarea id="reopen-note" className="mt-1.5" rows={3} maxLength={1000} value={reopenNote} onChange={(e) => setReopenNote(e.target.value)} placeholder="A sentence or two helps the team pick up where they left off." />
      </Dialog>
    </div>
  );
}

