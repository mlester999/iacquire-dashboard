"use client";

import * as React from "react";
import { AlertCircle, Check, CheckCheck, Download, FileImage, FileText, Loader2, Lock, RotateCcw } from "lucide-react";
import { LogoMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { AvatarTile, StatusPill } from "@/components/ui/status";
import { isImageFile } from "@/lib/support/lifecycle";
import { cn, formatBytes, formatDateTime } from "@/lib/utils";
import type { ThreadAttachment, ThreadMessage, TimelineEntry } from "@/server/support/types";

/** A file attached to a message, as a download link (downloads are checked on the server every time). */
export function AttachmentChips({ files, className }: { files: ThreadAttachment[]; className?: string }) {
  if (!files.length) return null;
  return (
    <ul className={cn("mt-2 flex flex-wrap gap-2", className)} aria-label="Attachments">
      {files.map((f) => (
        <li key={f.id}>
          <a
            href={`/api/support/attachments/${f.id}`}
            className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink shadow-soft transition hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            title={`Download ${f.filename}`}
          >
            {isImageFile(f.filename) ? <FileImage className="size-3.5 shrink-0 text-muted" aria-hidden /> : <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />}
            <span className="min-w-0 truncate font-medium">{f.filename}</span>
            <span className="shrink-0 text-[12px] text-muted">{formatBytes(f.sizeBytes)}</span>
            {f.visibility === "internal" && <Lock className="size-3 shrink-0 text-warning-ink" aria-label="Team only" />}
            <Download className="size-3.5 shrink-0 text-faint" aria-hidden />
          </a>
        </li>
      ))}
    </ul>
  );
}

export interface PendingMessage {
  clientMessageId: string;
  body: string;
  files: Array<{ id: string; name: string; sizeBytes: number }>;
  state: "sending" | "failed";
  error?: string;
  internal?: boolean;
}

/** The conversation, oldest first. Own messages sit on the right. Unsent and failed messages are shown inline with a way to retry. */
export function MessageList({
  messages, pending, viewer, timeZone, seenAt, onRetry, onDiscard,
}: {
  messages: ThreadMessage[];
  pending: PendingMessage[];
  viewer: "client" | "agency";
  timeZone: string;
  /** For the client: when the iAcquire team last opened the request, to mark their messages "seen". */
  seenAt?: string | null;
  onRetry: (p: PendingMessage) => void;
  onDiscard: (p: PendingMessage) => void;
}) {
  const known = new Set(messages.map((m) => m.clientMessageId).filter(Boolean));
  const waiting = pending.filter((p) => !known.has(p.clientMessageId));
  return (
    <ol className="space-y-4" aria-label="Conversation">
      {messages.map((m) => {
        if (m.authorKind === "system") {
          return (
            <li key={m.id} className="flex justify-center">
              <span className="inline-flex max-w-full items-center rounded-full bg-surface-2/80 px-3 py-1 text-center text-[12px] leading-snug text-muted ring-1 ring-inset ring-line">
                {m.body} · {formatDateTime(m.createdAt, timeZone)}
              </span>
            </li>
          );
        }
        const own = m.authorKind === viewer;
        const author = m.authorKind === "agency" ? (m.authorName ?? "iAcquire Support") : (m.authorName ?? "Client");
        const seen = viewer === "client" && own && seenAt ? new Date(seenAt).getTime() >= new Date(m.createdAt).getTime() : false;
        return (
          <li key={m.id} className={cn("flex min-w-0 gap-3", own && "flex-row-reverse")}>
            {m.authorKind === "agency" ? <LogoMark className="size-8 shrink-0" /> : <AvatarTile name={author} className="!size-8 !rounded-[9px]" />}
            <div className={cn("min-w-0 max-w-[88%]", own && "text-right")}>
              <div className={cn(
                "inline-block max-w-full break-words whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-left text-[14px] leading-relaxed",
                m.internal ? "border border-dashed border-warning/50 bg-warning-soft/50" : own ? "bg-primary text-white dark:bg-primary/25 dark:text-ink dark:ring-1 dark:ring-inset dark:ring-primary/40" : "border border-line bg-surface shadow-soft",
              )}>
                {m.internal && (
                  <span className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StatusPill tone="warning" size="sm" icon={<Lock className="size-3" aria-hidden />}>Internal note</StatusPill>
                    <span className="text-[12px] font-medium text-warning-ink">Not visible to the client</span>
                  </span>
                )}
                {m.body}
              </div>
              <AttachmentChips files={m.attachments} className={cn(own && "justify-end")} />
              <p className={cn("mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted", own && "justify-end")}>
                <span className="min-w-0 max-w-full truncate font-medium text-ink-2" title={author}>{author}</span>
                {viewer === "agency" && <StatusPill tone={m.authorKind === "agency" ? "primary" : "neutral"} size="sm" dot={false}>{m.authorKind === "agency" ? "iAcquire team" : "Client"}</StatusPill>}
                <time dateTime={m.createdAt}>{formatDateTime(m.createdAt, timeZone)}</time>
                {own && viewer === "client" && (
                  <span className="inline-flex items-center gap-1" title={seen ? "The iAcquire team has opened this request since you sent it" : "Sent"}>
                    {seen ? <CheckCheck className="size-3.5 text-primary" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                    {seen ? "Seen by iAcquire" : "Sent"}
                  </span>
                )}
              </p>
            </div>
          </li>
        );
      })}
      {waiting.map((p) => (
        <li key={p.clientMessageId} className="flex min-w-0 flex-row-reverse gap-3" aria-live="polite">
          <AvatarTile name="You" className="!size-8 !rounded-[9px] opacity-60" />
          <div className="min-w-0 max-w-[88%] text-right">
            <div className={cn("inline-block max-w-full break-words whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-left text-[14px] leading-relaxed", p.state === "failed" ? "border border-danger/40 bg-danger-soft/50" : "bg-primary/70 text-white opacity-80 dark:bg-primary/15 dark:text-ink", p.internal && "border border-dashed border-warning/50 bg-warning-soft/50 text-ink")}>{p.body}</div>
            {p.files.length > 0 && <p className="mt-1 text-[12px] text-muted">{p.files.length} file{p.files.length === 1 ? "" : "s"} attached</p>}
            {p.state === "sending" ? (
              <p className="mt-1.5 inline-flex items-center justify-end gap-1.5 text-[12px] text-muted"><Loader2 className="size-3 animate-spin" aria-hidden /> Sending…</p>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2 text-[12px] text-danger-ink" role="alert">
                <span className="inline-flex items-center gap-1"><AlertCircle className="size-3.5" aria-hidden /> {p.error ?? "This message wasn't sent."}</span>
                <Button type="button" size="sm" variant="secondary" onClick={() => onRetry(p)}><RotateCcw className="size-3.5" aria-hidden /> Try again</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => onDiscard(p)}>Discard</Button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

const EVENT_TEXT: Record<string, (e: TimelineEntry, viewer: "client" | "agency") => string | null> = {
  created: (e, v) => (v === "client" ? "Request sent" : "Request received"),
  status_changed: (e) => `Status: ${e.from ? `${e.from.replace(/_/g, " ")} → ` : ""}${(e.to ?? "").replace(/_/g, " ")}`,
  feedback_stage: (e) => `Feedback status: ${(e.to ?? "").replace(/_/g, " ")}`,
  assigned: (e, v) => (v === "client" ? "A team member picked this up" : `Assigned${e.to ? ` to ${e.to}` : ""}${e.from ? ` (from ${e.from})` : ""}`),
  unassigned: () => "Unassigned",
  reopened: (e, v) => (v === "client" ? "Request reopened" : `Reopened${e.detail ? `: ${e.detail}` : ""}`),
  resolved: (e) => `Marked as resolved${e.detail ? `: ${e.detail}` : ""}`,
  closed: (e) => `Closed${e.detail ? `: ${e.detail}` : ""}`,
  priority_changed: (e) => `Priority: ${e.from ?? "?"} → ${e.to ?? "?"}${e.detail ? ` (${e.detail})` : ""}`,
  escalated: (e) => `Escalated${e.detail ? `: ${e.detail}` : ""}`,
  de_escalated: () => "Escalation cleared",
  linked: (e) => `${e.detail ?? "Linked"}${e.to ? ` ${e.to}` : ""}`,
  merged: (e) => e.detail ?? `Merged ${e.to ?? ""}`,
  sla_alert: (e) => (e.to === "overdue" ? "Reply overdue" : "Reply due soon"),
  note: () => "Internal note added",
  reply: () => null,
  attachment: () => "File attached",
  ai_assist: () => "AI help used",
};

/** The request's history as a short list. Replies are left out: they are in the conversation above. */
export function Timeline({ entries, viewer, timeZone }: { entries: TimelineEntry[]; viewer: "client" | "agency"; timeZone: string }) {
  const rows = entries
    .map((e) => ({ e, text: (EVENT_TEXT[e.kind] ?? (() => null))(e, viewer) }))
    .filter((r): r is { e: TimelineEntry; text: string } => Boolean(r.text));
  if (!rows.length) return <p className="text-[14px] text-muted">Nothing has happened yet beyond the request being sent.</p>;
  return (
    <ol className="relative space-y-3 border-l border-line pl-5" aria-label="Activity">
      {rows.map(({ e, text }) => (
        <li key={e.id} className="relative text-[14px] leading-snug text-ink-2">
          <span className="absolute -left-[25px] top-1.5 size-2 rounded-full bg-line-strong ring-4 ring-surface" aria-hidden />
          <span className="font-medium text-ink">{text.replace(/^./, (c) => c.toUpperCase())}</span>
          <span className="ml-2 text-[12px] text-muted"><time dateTime={e.createdAt}>{formatDateTime(e.createdAt, timeZone)}</time></span>
        </li>
      ))}
    </ol>
  );
}
