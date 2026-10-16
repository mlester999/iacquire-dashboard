"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Lock, MessageSquare, Send } from "lucide-react";
import { LogoMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { EmptyState, Select, Textarea } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { AvatarTile, StatusPill } from "@/components/ui/status";
import { replyTicketAction } from "@/app/actions/support";
import { agencyReplyAction } from "@/app/(admin)/admin/actions";
import { cn, formatDateTime } from "@/lib/utils";

interface Msg {
  id: string;
  author_kind: "client" | "agency" | "system";
  author_name: string | null;
  body: string;
  internal: boolean;
  created_at: string;
}

export function TicketThread({ ticketId, messages, closed, timeZone, audience }: { ticketId: string; messages: Msg[]; closed: boolean; timeZone: string; audience: "client" | "agency" }) {
  const router = useRouter();
  const [body, setBody] = React.useState("");
  const [internal, setInternal] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const mine = audience === "client" ? "client" : "agency";

  const send = async () => {
    setPending(true);
    const res = audience === "client" ? await replyTicketAction(ticketId, body) : await agencyReplyAction(ticketId, body, internal, status || undefined);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    setBody("");
    setStatus("");
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {messages.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-surface">
          <EmptyState compact icon={<MessageSquare className="size-5" />} title="No messages yet" description="The conversation starts with the first reply." />
        </div>
      ) : (
        <ol className="space-y-4">
          {messages.map((m, i) => {
            if (m.author_kind === "system") {
              return (
                <li key={m.id} className="flex justify-center">
                  <span className="inline-flex max-w-full items-center rounded-full bg-surface-2/80 px-3 py-1 text-center text-[12px] leading-snug text-muted ring-1 ring-inset ring-line">
                    {m.body} · {formatDateTime(m.created_at, timeZone)}
                  </span>
                </li>
              );
            }
            const own = m.author_kind === mine;
            const author = m.author_kind === "agency" ? (m.author_name ?? "iAcquire") : (m.author_name ?? "Client");
            return (
              <motion.li key={m.id} initial={false} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }} className={cn("page-in flex min-w-0 gap-3", own && "flex-row-reverse")}>
                {m.author_kind === "agency" ? (
                  <LogoMark className="size-8 shrink-0" />
                ) : (
                  <AvatarTile name={author} className="!size-8 !rounded-[9px]" />
                )}
                <div className={cn("min-w-0 max-w-[85%]", own && "text-right")}>
                  <div
                    className={cn(
                      "inline-block max-w-full break-words whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-left text-[14px] leading-relaxed",
                      m.internal ? "border border-dashed border-warning/50 bg-warning-soft/50" : own ? "bg-primary text-white dark:bg-primary/25 dark:text-ink dark:ring-1 dark:ring-inset dark:ring-primary/40" : "border border-line bg-surface shadow-soft",
                    )}
                  >
                    {m.internal && (
                      <span className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <StatusPill tone="warning" size="sm" icon={<Lock className="size-3" aria-hidden />}>Internal note</StatusPill>
                        <span className="text-[11.5px] font-medium text-warning-ink">Not visible to the client</span>
                      </span>
                    )}
                    {m.body}
                  </div>
                  <p className={cn("mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted", own && "justify-end")}>
                    <span className="min-w-0 max-w-full truncate font-medium text-ink-2" title={author}>{author}</span>
                    <StatusPill tone={m.author_kind === "agency" ? "primary" : "neutral"} size="sm" dot={false}>{m.author_kind === "agency" ? "iAcquire team" : "Client"}</StatusPill>
                    <time dateTime={new Date(m.created_at).toISOString()}>{formatDateTime(m.created_at, timeZone)}</time>
                  </p>
                </div>
              </motion.li>
            );
          })}
        </ol>
      )}
      {closed && audience === "client" ? (
        <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2/70 px-4 py-3.5 text-[13px] leading-relaxed text-ink-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-3 text-muted" aria-hidden><Lock className="size-4" /></span>
          <p className="pt-1">This request is closed. Open a new one if you still need help.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-line-strong bg-surface p-3 shadow-card focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
          <label htmlFor="ticket-reply" className="sr-only">
            Reply
          </label>
          <Textarea id="ticket-reply" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={3} placeholder={internal ? "Write an internal note for the team…" : "Write a reply…"} className="border-0 shadow-none focus:ring-0" />
          <div className="mt-2 flex flex-wrap items-center gap-2.5 border-t border-line pt-3">
            {audience === "agency" && (
              <>
                <label className={cn("inline-flex h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-[12.5px] font-medium transition sm:h-10", internal ? "border-warning/40 bg-warning-soft text-warning-ink" : "border-line bg-surface-2/60 text-ink-2 hover:border-line-strong")}>
                  <Switch checked={internal} onCheckedChange={setInternal} aria-label="Internal note" /> Internal note
                </label>
                <label className="sr-only" htmlFor="reply-status">
                  Set status
                </label>
                <Select id="reply-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:h-10 sm:w-64">
                  <option value="">{internal ? "Keep current status" : "Then: waiting for client"}</option>
                  <option value="in_progress">In progress</option>
                  <option value="waiting_for_client">Waiting for client</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </Select>
              </>
            )}
            <Button className="ml-auto" variant="brand" size="sm" disabled={!body.trim()} loading={pending} onClick={send}>
              <Send className="size-3.5" aria-hidden /> {internal ? "Add note" : "Send reply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
