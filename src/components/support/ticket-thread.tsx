"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Lock, Send } from "lucide-react";
import { LogoMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { replyTicketAction } from "@/app/actions/support";
import { agencyReplyAction } from "@/app/(admin)/admin/actions";
import { cn, formatDateTime, initials } from "@/lib/utils";

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
      <ol className="space-y-4">
        {messages.map((m, i) => {
          if (m.author_kind === "system") {
            return (
              <li key={m.id} className="text-center text-[12px] text-faint">
                {m.body} · {formatDateTime(m.created_at, timeZone)}
              </li>
            );
          }
          const own = m.author_kind === mine;
          return (
            <motion.li key={m.id} initial={false} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }} className={cn("page-in flex min-w-0 gap-3", own && "flex-row-reverse")}>
              {m.author_kind === "agency" ? (
                <LogoMark className="size-8 shrink-0" />
              ) : (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-[11px] font-semibold text-ink-2">{initials(m.author_name)}</span>
              )}
              <div className={cn("min-w-0 max-w-[85%]", own && "text-right")}>
                <div
                  className={cn(
                    "inline-block max-w-full break-words whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-left text-[14px] leading-relaxed",
                    m.internal ? "border border-dashed border-warning/50 bg-warning-soft/50" : own ? "bg-primary text-white" : "border border-line bg-surface shadow-soft",
                  )}
                >
                  {m.internal && (
                    <span className="mb-1 flex items-center gap-1 text-[11.5px] font-medium text-warning-ink">
                      <Lock className="size-3" /> Internal note — not visible to the client
                    </span>
                  )}
                  {m.body}
                </div>
                <p className="mt-1 text-[11.5px] text-faint">
                  {m.author_kind === "agency" ? `${m.author_name ?? "iAcquire"} · iAcquire team` : (m.author_name ?? "Client")} · {formatDateTime(m.created_at, timeZone)}
                </p>
              </div>
            </motion.li>
          );
        })}
      </ol>
      {closed && audience === "client" ? (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-center text-[13px] text-muted">This request is closed. Open a new one if you still need help.</p>
      ) : (
        <div className="rounded-2xl border border-line-strong bg-surface p-3 shadow-card focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
          <label htmlFor="ticket-reply" className="sr-only">
            Reply
          </label>
          <Textarea id="ticket-reply" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={3} placeholder="Write a reply…" className="border-0 shadow-none focus:ring-0" />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {audience === "agency" && (
              <>
                <label className="flex items-center gap-2 text-[12.5px] text-muted">
                  <Switch checked={internal} onCheckedChange={setInternal} aria-label="Internal note" /> Internal note
                </label>
                <label className="sr-only" htmlFor="reply-status">
                  Set status
                </label>
                <Select id="reply-status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 w-full text-[12.5px] sm:w-48">
                  <option value="">{internal ? "Keep current status" : "Then: waiting for client"}</option>
                  <option value="in_progress">In progress</option>
                  <option value="waiting_for_client">Waiting for client</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </Select>
              </>
            )}
            <Button className="ml-auto" variant="brand" size="sm" disabled={!body.trim()} loading={pending} onClick={send}>
              <Send className="size-3.5" /> {internal ? "Add note" : "Send reply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
