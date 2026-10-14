"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Clock, Hand, Inbox, Lock, Mail, MessageCircle, MessageSquareText, Search, Send, ShieldAlert, Sparkles, StickyNote, UserRound, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input, Select, Textarea } from "@/components/ui/primitives";
import { addMemoryAction, addNoteAction, approveDraftAction, assignConversationAction, claimEscalationAction, declineEscalationAction, deleteMemoryAction, discardDraftAction, markReadAction, resolveEscalationAction, resumeAiAction, sendReplyAction, setConversationStateAction, takeOverAction } from "@/app/actions/inbox";
import { BLOCK_REASON_LABELS, CHANNEL_LABELS, MESSAGE_STATUS_LABELS, smsSegments, type Channel, type MessageStatus } from "@/lib/messaging";
import { ESCALATION_LABELS, type EscalationCategory } from "@/lib/escalation";
import { cn, formatDateTime, initials, relativeTime, sentenceCase } from "@/lib/utils";
import type { ConversationDetail, ConversationListItem } from "@/server/messaging/inbox";

export interface EscalationCard {
  id: string;
  conversation_id: string;
  category: EscalationCategory;
  urgency: "urgent" | "normal";
  status: string;
  summary: string;
  owner_response: string;
  owner_deadline_at: string | null;
  claimed_name: string | null;
}

interface Props {
  list: ConversationListItem[];
  detail: ConversationDetail | null;
  escalations: EscalationCard[];
  me: { id: string; isOwner: boolean };
  perms: { reply: boolean; assign: boolean; notes: boolean; resume: boolean; respond: boolean; editContacts: boolean };
  team: Array<{ id: string; name: string; role: string }>;
  templates: Array<{ id: string; name: string }>;
  timeZone: string;
  filters: { q: string; channel: string; owner: string; unread: boolean };
}

const CHANNEL_ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const CHANNEL_TONE: Record<Channel, string> = { sms: "text-primary", whatsapp: "text-success-ink", email: "text-violet-ink" };

function ChannelBadge({ channel }: { channel: Channel }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", CHANNEL_TONE[channel])}>
      <Icon className="size-3.5" aria-hidden />
      {CHANNEL_LABELS[channel]}
    </span>
  );
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return <span className="tabular-nums" suppressHydrationWarning>{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</span>;
}

export function InboxWorkspace(props: Props) {
  const { list, detail, escalations, filters } = props;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("conversation");
  const [q, setQ] = React.useState(filters.q);
  const [needsOnly, setNeedsOnly] = React.useState(false);

  // Live-ish updates: refresh the server data every 15 seconds while the tab is visible. Typing is never interrupted.
  React.useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible" && !document.querySelector("[data-composer-dirty='true']")) router.refresh();
    }, 15000);
    return () => window.clearInterval(t);
  }, [router]);

  React.useEffect(() => {
    if (detail && detail.conversation.unread > 0) void markReadAction(detail.conversation.id);
  }, [detail?.conversation.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function go(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    router.push(`${pathname}?${sp.toString()}`);
  }

  const visible = needsOnly ? list.filter((c) => c.escalation && ["awaiting_owner", "open"].includes(c.escalation.status)) : list;
  const waiting = escalations.filter((e) => ["awaiting_owner", "open"].includes(e.status));

  return (
    <div className="grid min-h-[calc(100dvh-9rem)] gap-4 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_320px]">
      <section aria-label="Conversations" className={cn("min-w-0 flex-col gap-3", selected ? "hidden lg:flex" : "flex")}>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: q.trim() || null, conversation: null });
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden />
          <label className="sr-only" htmlFor="inbox-search">Search conversations</label>
          <Input id="inbox-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number, email or message" className="pl-9" />
        </form>
        <div role="group" aria-label="Filter by channel" className="flex flex-wrap gap-1.5">
          {[["", "All"], ["sms", "SMS"], ["whatsapp", "WhatsApp"], ["email", "Email"]].map(([value, label]) => (
            <button key={value} aria-pressed={filters.channel === value} onClick={() => go({ channel: value || null })} className={cn("min-h-9 rounded-xl px-3 text-[12.5px] font-medium transition", filters.channel === value ? "bg-ink text-bg" : "bg-surface-2 text-muted hover:text-ink")}>
              {label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Filter by owner" className="flex flex-wrap gap-1.5">
          {[["", "Everyone"], ["mine", "Mine"], ["ai", "AI"], ["unassigned", "Unassigned"]].map(([value, label]) => (
            <button key={value} aria-pressed={filters.owner === value && !needsOnly} onClick={() => { setNeedsOnly(false); go({ owner: value || null }); }} className={cn("min-h-9 rounded-xl px-3 text-[12.5px] font-medium transition", filters.owner === value && !needsOnly ? "bg-primary-soft text-primary-ink" : "bg-surface-2 text-muted hover:text-ink")}>
              {label}
            </button>
          ))}
          <button aria-pressed={needsOnly} onClick={() => setNeedsOnly((v) => !v)} className={cn("min-h-9 rounded-xl px-3 text-[12.5px] font-medium transition", needsOnly ? "bg-warning-soft text-warning-ink" : "bg-surface-2 text-muted hover:text-ink")}>
            Needs a person{waiting.length ? ` (${waiting.length})` : ""}
          </button>
          <button aria-pressed={filters.unread} onClick={() => go({ unread: filters.unread ? null : "1" })} className={cn("min-h-9 rounded-xl px-3 text-[12.5px] font-medium transition", filters.unread ? "bg-primary-soft text-primary-ink" : "bg-surface-2 text-muted hover:text-ink")}>
            Unread
          </button>
        </div>

        {waiting.length > 0 && <EscalationQueue items={waiting} me={props.me} canRespond={props.perms.respond} onOpen={(id) => go({ conversation: id })} />}

        <ul className="flex flex-col gap-1.5" aria-label="Conversation list">
          {visible.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => go({ conversation: c.id })}
                aria-current={selected === c.id ? "true" : undefined}
                className={cn("flex w-full gap-3 rounded-2xl border p-3 text-left transition", selected === c.id ? "border-primary/40 bg-primary-soft/40" : "border-line bg-surface hover:bg-surface-2")}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/80 to-violet/80 text-[12px] font-semibold text-white">{initials(c.contactName)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn("truncate text-[14px]", c.unread ? "font-semibold" : "font-medium")}>{c.contactName}</span>
                    <span className="shrink-0 text-[11px] text-faint" suppressHydrationWarning>{c.lastMessageAt ? relativeTime(c.lastMessageAt) : ""}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[12.5px] text-muted">{c.preview ?? "No messages yet"}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-2">
                    <ChannelBadge channel={c.channel} />
                    <OwnerPill kind={c.ownerKind} name={c.ownerName} />
                    {c.escalation && ["awaiting_owner", "open"].includes(c.escalation.status) && <Badge tone={c.escalation.urgency === "urgent" ? "danger" : "warning"}>Needs a person</Badge>}
                    {c.priority === "urgent" && !c.escalation && <Badge tone="danger">Urgent</Badge>}
                    {c.unread > 0 && <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-white" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!visible.length && (
          <div className="rounded-2xl border border-dashed border-line-strong p-8 text-center">
            <Inbox className="mx-auto size-6 text-muted" aria-hidden />
            <h2 className="mt-3 text-[15px] font-semibold">{list.length ? "Nothing matches these filters" : "No conversations yet"}</h2>
            <p className="mx-auto mt-1 max-w-xs text-[13px] leading-relaxed text-muted">
              {list.length ? "Try a different channel or owner." : "Customer messages from SMS, WhatsApp and email appear here once a channel is verified and connected. Nothing is sent until you switch it on."}
            </p>
            {!list.length && <Link href="/settings/messaging" className="mt-3 inline-block text-[13px] font-medium text-primary">Check channel setup</Link>}
          </div>
        )}
      </section>

      <section aria-label="Conversation" className={cn("min-w-0", selected ? "block" : "hidden lg:block")}>
        {detail ? (
          <>
            <Thread key={detail.conversation.id} {...props} detail={detail} onBack={() => go({ conversation: null })} />
            <details className="mt-4 rounded-2xl border border-line bg-surface p-3 xl:hidden">
              <summary className="min-h-10 cursor-pointer text-[13px] font-semibold">Customer details, consent and activity</summary>
              <div className="mt-3">
                <ContactPanel key={`m-${detail.conversation.id}`} {...props} detail={detail} inline />
              </div>
            </details>
          </>
        ) : (
          <EmptyThread hasList={list.length > 0} />
        )}
      </section>

      {detail && <ContactPanel key={`c-${detail.conversation.id}`} {...props} detail={detail} />}
    </div>
  );
}

function OwnerPill({ kind, name }: { kind: "ai" | "human" | "unassigned"; name: string | null }) {
  if (kind === "ai") return <span className="inline-flex items-center gap-1 rounded-full bg-violet-soft px-2 py-0.5 text-[11px] font-medium text-violet-ink"><Bot className="size-3" aria-hidden />AI</span>;
  if (kind === "human") return <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary-ink"><UserRound className="size-3" aria-hidden />{name?.split(" ")[0] ?? "Person"}</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-ink-2">Unassigned</span>;
}

function EmptyThread({ hasList }: { hasList: boolean }) {
  return (
    <div className="flex h-full min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong p-10 text-center">
      <Inbox className="size-7 text-muted" aria-hidden />
      <h2 className="mt-3 text-[16px] font-semibold">{hasList ? "Choose a conversation" : "Your inbox is empty"}</h2>
      <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted">Every message shows its real delivery state. Your AI team handles conversations it is allowed to, and hands the rest to a person.</p>
    </div>
  );
}

function EscalationQueue({ items, me, canRespond, onOpen }: { items: EscalationCard[]; me: Props["me"]; canRespond: boolean; onOpen: (conversationId: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) toast.error(r.error ?? "That didn't work.");
    else {
      toast.success(ok);
      router.refresh();
    }
  }
  return (
    <section aria-label="Needs a person" className="space-y-2 rounded-2xl border border-warning/30 bg-warning-soft/50 p-3">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold text-warning-ink"><ShieldAlert className="size-4" aria-hidden />Needs a person ({items.length})</h2>
      <ul className="space-y-2">
        {items.slice(0, 5).map((e) => (
          <li key={e.id} className="rounded-xl bg-surface p-3 text-[12.5px]">
            <div className="flex items-start justify-between gap-2">
              <button onClick={() => onOpen(e.conversation_id)} className="min-w-0 text-left">
                <span className="block font-medium">{e.urgency === "urgent" ? "Urgent · " : ""}{ESCALATION_LABELS[e.category]}</span>
                <span className="mt-0.5 block text-muted">{e.summary}</span>
              </button>
            </div>
            {e.status === "awaiting_owner" && e.owner_deadline_at && (
              <p className="mt-1.5 flex items-center gap-1 text-[12px] text-warning-ink"><Clock className="size-3" aria-hidden />Owner has first priority: <Countdown until={e.owner_deadline_at} /></p>
            )}
            {e.status === "awaiting_owner" && !e.owner_deadline_at && <p className="mt-1.5 text-[12px] text-warning-ink">Waiting for the business owner.</p>}
            {e.status === "open" && <p className="mt-1.5 text-[12px] text-warning-ink">Open to authorized teammates. First to accept owns it.</p>}
            {canRespond && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="brand" loading={busy === `c${e.id}`} onClick={() => run(`c${e.id}`, async () => { const r = await claimEscalationAction(e.id); if (r.ok) onOpen(e.conversation_id); return r; }, "It's yours.")}>Accept</Button>
                {me.isOwner && e.status === "awaiting_owner" && <Button size="sm" variant="ghost" loading={busy === `d${e.id}`} onClick={() => run(`d${e.id}`, () => declineEscalationAction(e.id), "Passed to your team.")}>Decline</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_STYLE: Record<MessageStatus, string> = {
  received: "text-muted",
  note: "text-warning-ink",
  draft: "text-warning-ink",
  queued: "text-muted",
  sending: "text-muted",
  sent: "text-muted",
  delivered: "text-success-ink",
  read: "text-success-ink",
  failed: "text-danger-ink",
  blocked: "text-danger-ink",
};

function Thread(props: Props & { detail: ConversationDetail; onBack: () => void }) {
  const { detail, me, perms, templates, timeZone } = props;
  const c = detail.conversation;
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [mode, setMode] = React.useState<"reply" | "note">("reply");
  const [templateId, setTemplateId] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [detail.messages.length]);

  const otherOwner = c.ownerKind === "human" && c.ownerUserId !== me.id;
  const optedOut = detail.contact.consent.some((x) => x.channel === c.channel && x.purpose === "service" && x.status === "revoked");
  const windowClosed = c.channel === "whatsapp" && c.whatsappWindowOpen === false;
  const needsTemplate = windowClosed && !templateId;
  const segments = c.channel === "sms" ? smsSegments(text) : 0;
  const canReply = perms.reply && !optedOut && !(otherOwner && !perms.assign);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error ?? "That didn't work.");
      return false;
    }
    if (ok) toast.success(ok);
    router.refresh();
    return true;
  }

  async function submit() {
    if (!text.trim()) return;
    const sent =
      mode === "note"
        ? await run("send", () => addNoteAction(c.id, text), "Note added.")
        : await run("send", async () => {
            const r = await sendReplyAction(c.id, text, windowClosed ? templateId : null);
            if (r.ok && r.data.status === "blocked") toast.warning("It couldn't be sent yet. The message shows why.");
            else if (r.ok && r.data.status === "sent") toast.success("Sent to the provider. Delivery shows once it confirms.");
            return r;
          });
    if (sent) setText("");
  }

  return (
    <article className="flex h-full min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-3 border-b border-line p-3 sm:p-4">
        <button onClick={props.onBack} className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 lg:hidden" aria-label="Back to conversations"><ArrowLeft className="size-4" /></button>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/80 to-violet/80 text-[12px] font-semibold text-white">{initials(detail.contact.name)}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold tracking-tight">{detail.contact.name}</h1>
          <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted"><ChannelBadge channel={c.channel} /><span>{sentenceCase(detail.contact.lifecycleStage)}</span>{c.status === "closed" && <Badge>Closed</Badge>}</p>
        </div>
        {perms.reply && <Button size="sm" variant="ghost" onClick={() => run("state", () => setConversationStateAction(c.id, { status: c.status === "closed" ? "open" : "closed" }), c.status === "closed" ? "Reopened." : "Closed.")}>{c.status === "closed" ? "Reopen" : "Close"}</Button>}
      </header>

      <OwnershipBar detail={detail} me={me} perms={perms} busy={busy} run={run} />
      {detail.escalation && <EscalationBanner detail={detail} me={me} perms={perms} busy={busy} run={run} />}

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4" role="log" aria-label="Messages" aria-live="polite">
        {detail.messages.map((m) => {
          if (m.direction === "internal") {
            return (
              <div key={m.id} className="mx-auto max-w-[85%] rounded-xl border border-dashed border-warning/50 bg-warning-soft/40 px-3 py-2 text-[13px]">
                <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-warning-ink"><Lock className="size-3" aria-hidden />Internal note · {m.authorName ?? "System"} · only your team sees this</p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            );
          }
          const out = m.direction === "outbound";
          const reason = m.blockedReason ? (BLOCK_REASON_LABELS[m.blockedReason] ?? m.blockedReason) : null;
          return (
            <div key={m.id} className={cn("flex", out ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed", out ? (m.authorKind === "ai" ? "bg-violet-soft text-ink" : "bg-primary-soft text-ink") : "bg-surface-2", m.status === "draft" && "border border-dashed border-warning/60")}>
                {out && <p className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-muted">{m.authorKind === "ai" ? <Bot className="size-3" aria-hidden /> : <UserRound className="size-3" aria-hidden />}{m.authorKind === "ai" ? (m.scope === "followup" ? "AI follow-up" : "AI") : (m.authorName ?? "Teammate")}</p>}
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className={cn("mt-1 flex flex-wrap items-center gap-x-2 text-[11px]", STATUS_STYLE[m.status])}>
                  <span suppressHydrationWarning>{formatDateTime(m.createdAt, timeZone)}</span>
                  {out && <StatusMark status={m.status} />}
                  {out && (m.status === "blocked" || m.status === "failed" || m.status === "draft") && reason && <span>· {reason}</span>}
                  {out && m.status === "failed" && m.statusDetail && <span>· {m.statusDetail}</span>}
                </p>
                {m.status === "draft" && m.authorKind === "ai" && perms.reply && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="brand" loading={busy === `a${m.id}`} onClick={() => run(`a${m.id}`, () => approveDraftAction(m.id), "Approved and queued.")}><Check className="size-3.5" />Approve &amp; send</Button>
                    <Button size="sm" variant="ghost" loading={busy === `x${m.id}`} onClick={() => run(`x${m.id}`, () => discardDraftAction(m.id), "Draft discarded.")}><XCircle className="size-3.5" />Discard</Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <footer className="border-t border-line p-3 sm:p-4">
        {optedOut && <p role="status" className="mb-2 flex items-center gap-2 rounded-xl bg-danger-soft p-2.5 text-[12.5px] text-danger-ink"><AlertTriangle className="size-4 shrink-0" aria-hidden />This customer opted out of messages on this channel. Nothing can be sent to them here.</p>}
        {windowClosed && !optedOut && (
          <div role="status" className="mb-2 rounded-xl bg-warning-soft p-2.5 text-[12.5px] text-warning-ink">
            <p className="flex items-start gap-2"><Clock className="mt-0.5 size-4 shrink-0" aria-hidden />WhatsApp&apos;s reply window has closed. Only an approved template can be sent.</p>
            {templates.length ? (
              <Select aria-label="Approved WhatsApp template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="mt-2">
                <option value="">Choose an approved template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            ) : <p className="mt-1">No templates are approved yet.</p>}
          </div>
        )}
        {c.ownerKind === "ai" && perms.reply && mode === "reply" && <p className="mb-2 text-[12px] text-muted">The AI is handling this. Sending a reply takes over and stops the AI for this conversation.</p>}
        {otherOwner && !perms.assign && <p className="mb-2 text-[12px] text-muted">{c.ownerName ?? "A teammate"} is handling this conversation.</p>}
        <div className="mb-2 flex gap-1" role="tablist" aria-label="Composer mode">
          <button role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")} className={cn("min-h-9 rounded-lg px-3 text-[12.5px] font-medium", mode === "reply" ? "bg-ink text-bg" : "text-muted hover:bg-surface-2")}><Send className="mr-1 inline size-3.5" aria-hidden />Reply</button>
          {perms.notes && <button role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")} className={cn("min-h-9 rounded-lg px-3 text-[12.5px] font-medium", mode === "note" ? "bg-warning-soft text-warning-ink" : "text-muted hover:bg-surface-2")}><StickyNote className="mr-1 inline size-3.5" aria-hidden />Internal note</button>}
        </div>
        <label className="sr-only" htmlFor="composer">{mode === "note" ? "Internal note" : `Reply by ${CHANNEL_LABELS[c.channel]}`}</label>
        <Textarea
          id="composer"
          data-composer-dirty={text.trim() ? "true" : "false"}
          rows={3}
          value={text}
          maxLength={mode === "note" ? 2000 : 5000}
          disabled={mode === "reply" ? !canReply : !perms.notes}
          placeholder={mode === "note" ? "Write a note for your team. The customer never sees it." : `Reply by ${CHANNEL_LABELS[c.channel]}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-muted">{mode === "reply" && c.channel === "sms" && text ? `${segments} SMS segment${segments === 1 ? "" : "s"}` : mode === "reply" ? `Sends from your verified ${CHANNEL_LABELS[c.channel]} sender` : "Visible to your team only"}</span>
          <Button variant={mode === "note" ? "soft" : "brand"} size="sm" loading={busy === "send"} disabled={!text.trim() || (mode === "reply" && (!canReply || needsTemplate))} onClick={submit}>{mode === "note" ? "Add note" : "Send"}</Button>
        </div>
      </footer>
    </article>
  );
}

function StatusMark({ status }: { status: MessageStatus }) {
  const Icon = status === "delivered" || status === "read" ? CheckCheck : status === "sent" ? Check : status === "failed" || status === "blocked" ? AlertTriangle : Clock;
  return <span className="inline-flex items-center gap-1 font-medium"><Icon className="size-3" aria-hidden />{MESSAGE_STATUS_LABELS[status]}</span>;
}

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) => Promise<boolean>;

function OwnershipBar({ detail, me, perms, busy, run }: { detail: ConversationDetail; me: Props["me"]; perms: Props["perms"]; busy: string | null; run: Run }) {
  const c = detail.conversation;
  const mine = c.ownerKind === "human" && c.ownerUserId === me.id;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-3 py-2 text-[12.5px] sm:px-4">
      <span className="flex items-center gap-2">
        {c.ownerKind === "ai" ? <><Bot className="size-4 text-violet-ink" aria-hidden /><span><strong>AI is handling this.</strong> It follows your rules and hands off when a person is needed.</span></> : c.ownerKind === "human" ? <><UserRound className="size-4 text-primary" aria-hidden /><span><strong>{mine ? "You are" : `${c.ownerName ?? "A teammate"} is`} handling this.</strong> The AI will not reply.</span></> : <><Hand className="size-4 text-muted" aria-hidden /><span><strong>Nobody owns this yet.</strong> The AI will not reply.</span></>}
      </span>
      <span className="flex gap-2">
        {c.ownerKind !== "human" && perms.reply && <Button size="sm" variant="secondary" loading={busy === "takeover"} onClick={() => run("takeover", () => takeOverAction(c.id), "You're handling this now.")}>Take over</Button>}
        {c.ownerKind !== "ai" && perms.resume && (mine || perms.assign) && <Button size="sm" variant="soft" loading={busy === "resume"} onClick={() => run("resume", () => resumeAiAction(c.id), "Handed back to the AI.")}><Sparkles className="size-3.5" />Hand back to AI</Button>}
      </span>
    </div>
  );
}

function EscalationBanner({ detail, me, perms, busy, run }: { detail: ConversationDetail; me: Props["me"]; perms: Props["perms"]; busy: string | null; run: Run }) {
  const e = detail.escalation!;
  const [resolution, setResolution] = React.useState("");
  return (
    <div role="status" className={cn("border-b px-3 py-2.5 text-[12.5px] sm:px-4", e.urgency === "urgent" ? "border-danger/30 bg-danger-soft/60" : "border-warning/30 bg-warning-soft/60")}>
      <p className="flex flex-wrap items-center gap-x-2 font-medium"><ShieldAlert className="size-4" aria-hidden />{e.urgency === "urgent" ? "Urgent · " : ""}{ESCALATION_LABELS[e.category as EscalationCategory] ?? sentenceCase(e.category)}
        {e.status === "awaiting_owner" && e.ownerDeadlineAt && <span className="flex items-center gap-1 font-normal"><Clock className="size-3" aria-hidden />Owner first priority <Countdown until={e.ownerDeadlineAt} /></span>}
        {e.status === "open" && <span className="font-normal">Open to teammates</span>}
        {e.status === "claimed" && <span className="font-normal">Taken by {e.claimedByName ?? "a teammate"}</span>}
      </p>
      <p className="mt-0.5 text-ink-2">{e.summary} <span className="text-muted">(AI summary for your team, not shown to the customer.)</span></p>
      {perms.respond && e.status !== "claimed" && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="brand" loading={busy === "claim"} onClick={() => run("claim", () => claimEscalationAction(e.id), "It's yours.")}>Accept</Button>
          {me.isOwner && e.status === "awaiting_owner" && <Button size="sm" variant="ghost" loading={busy === "decline"} onClick={() => run("decline", () => declineEscalationAction(e.id), "Passed to your team.")}>Decline</Button>}
        </div>
      )}
      {e.status === "claimed" && perms.respond && (
        <form className="mt-2 flex gap-2" onSubmit={(ev) => { ev.preventDefault(); void run("resolve", () => resolveEscalationAction(e.id, resolution), "Marked resolved."); }}>
          <label className="sr-only" htmlFor="resolution">How was it resolved?</label>
          <Input id="resolution" value={resolution} onChange={(ev) => setResolution(ev.target.value)} placeholder="How was it resolved? (optional)" maxLength={500} />
          <Button size="sm" variant="secondary" type="submit" loading={busy === "resolve"}>Resolve</Button>
        </form>
      )}
    </div>
  );
}

function ContactPanel({ detail, perms, team, timeZone, inline = false }: Props & { detail: ConversationDetail; inline?: boolean }) {
  const idp = inline ? "m-" : "";
  const router = useRouter();
  const c = detail.conversation;
  const [fact, setFact] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) toast.error(r.error ?? "That didn't work.");
    else {
      if (ok) toast.success(ok);
      router.refresh();
    }
    return r.ok;
  }
  const confirmed = detail.memories.filter((m) => m.kind === "confirmed_fact");
  const summaries = detail.memories.filter((m) => m.kind === "ai_summary");
  return (
    <aside aria-label={inline ? "Customer details (compact)" : "Customer details"} className={cn("min-w-0 space-y-4", inline ? "block" : "hidden xl:block")}>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[13px] font-semibold">Customer</h2>
        <dl className="mt-3 space-y-2 text-[12.5px]">
          <div className="flex justify-between gap-2"><dt className="text-muted">Stage</dt><dd>{sentenceCase(detail.contact.lifecycleStage)}</dd></div>
          {detail.contact.temperature && <div className="flex justify-between gap-2"><dt className="text-muted">Temperature</dt><dd>{sentenceCase(detail.contact.temperature)}</dd></div>}
          <div className="flex justify-between gap-2"><dt className="text-muted">Source</dt><dd>{sentenceCase(detail.contact.source)}</dd></div>
        </dl>
        <ul className="mt-3 space-y-1.5 text-[12.5px]">
          {detail.contact.identities.map((i) => (
            <li key={`${i.kind}-${i.value}`} className="flex items-center justify-between gap-2">
              <span className="truncate">{i.value}</span>
              <Badge tone={i.verified ? "success" : "neutral"}>{i.verified ? "Verified" : "Unverified"}</Badge>
            </li>
          ))}
        </ul>
        <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wider text-muted">Consent</h3>
        <ul className="mt-1.5 space-y-1 text-[12.5px]">
          {detail.contact.consent.length ? detail.contact.consent.map((x) => (
            <li key={`${x.channel}-${x.purpose}`} className="flex justify-between gap-2"><span>{CHANNEL_LABELS[x.channel as Channel] ?? x.channel} · {x.purpose}</span><span className={x.status === "revoked" ? "font-medium text-danger-ink" : "text-success-ink"}>{sentenceCase(x.status)}</span></li>
          )) : <li className="text-muted">No consent recorded.</li>}
        </ul>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[13px] font-semibold">Follow-up</h2>
        <p className="mt-1.5 text-[12.5px] text-muted">
          {detail.followUp ? `${detail.followUp.remaining} follow-up${detail.followUp.remaining === 1 ? "" : "s"} remaining${detail.followUp.nextDueAt ? `, next ${formatDateTime(detail.followUp.nextDueAt, timeZone)}` : ""}. It stops if the customer replies, books, opts out or a person takes over.` : "No follow-ups scheduled."}
        </p>
      </section>

      {perms.assign && (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-[13px] font-semibold">Assignment</h2>
          <label className="sr-only" htmlFor={`${idp}assign`}>Assign to</label>
          <Select id={`${idp}assign`} value={c.assignedUserId ?? ""} onChange={(e) => run("assign", () => assignConversationAction(c.id, e.target.value || null), "Assignment updated.")} className="mt-2" disabled={busy === "assign"}>
            <option value="">Unassigned</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.name} · {sentenceCase(t.role)}</option>)}
          </Select>
          <label className="sr-only" htmlFor={`${idp}priority`}>Priority</label>
          <Select id={`${idp}priority`} value={c.priority} onChange={(e) => run("priority", () => setConversationStateAction(c.id, { priority: e.target.value }), "Priority updated.")} className="mt-2" disabled={busy === "priority"}>
            {["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{sentenceCase(p)} priority</option>)}
          </Select>
        </section>
      )}

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[13px] font-semibold">What we know</h2>
        <h3 className="mt-2 text-[11.5px] font-semibold uppercase tracking-wider text-success-ink">Confirmed by your team</h3>
        <ul className="mt-1 space-y-1.5 text-[12.5px]">
          {confirmed.length ? confirmed.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-2"><span>{m.content}</span>{perms.editContacts && <button aria-label="Delete this note" onClick={() => run(`m${m.id}`, () => deleteMemoryAction(m.id), "Removed.")} className="text-muted hover:text-danger-ink"><XCircle className="size-3.5" /></button>}</li>
          )) : <li className="text-muted">Nothing confirmed yet.</li>}
        </ul>
        <h3 className="mt-3 text-[11.5px] font-semibold uppercase tracking-wider text-violet-ink">AI-written summaries (not verified)</h3>
        <ul className="mt-1 space-y-1.5 text-[12.5px]">
          {summaries.length ? summaries.map((m) => <li key={m.id} className="text-ink-2">{m.content}</li>) : <li className="text-muted">None.</li>}
        </ul>
        {perms.editContacts && (
          <form className="mt-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (fact.trim() && (await run("fact", () => addMemoryAction(detail.contact.id, "confirmed_fact", fact), "Saved."))) setFact(""); }}>
            <label className="sr-only" htmlFor={`${idp}fact`}>Add a confirmed fact</label>
            <Input id={`${idp}fact`} value={fact} onChange={(e) => setFact(e.target.value)} placeholder="Add a confirmed fact" maxLength={1000} />
            <Button size="sm" variant="secondary" type="submit" loading={busy === "fact"}>Add</Button>
          </form>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[13px] font-semibold">Activity</h2>
        <ol className="mt-2 space-y-2 border-l border-line pl-3 text-[12.5px]">
          {detail.timeline.length ? detail.timeline.slice(-8).map((t, i) => (
            <li key={`${t.at}-${i}`}><span className="block text-ink-2">{t.text}</span><span className="text-[11px] text-faint" suppressHydrationWarning>{formatDateTime(t.at, timeZone)}</span></li>
          )) : <li className="text-muted">No activity recorded yet.</li>}
        </ol>
        <p className="mt-2 text-[11.5px] text-muted">Only real events are listed.</p>
      </section>
    </aside>
  );
}
