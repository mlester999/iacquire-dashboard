"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Bot, CalendarClock, Check, CheckCheck, Clock, Hand, Inbox, Lock, Mail, MessageCircle, MessageSquareText, Search, Send, ShieldAlert, ShieldCheck, Sparkles, StickyNote, UserRound, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Input, Select, Textarea } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile } from "@/components/overview/panel";
import { addMemoryAction, addNoteAction, approveDraftAction, assignConversationAction, claimEscalationAction, declineEscalationAction, deleteMemoryAction, discardDraftAction, markReadAction, resolveEscalationAction, resumeAiAction, sendReplyAction, setConversationStateAction, takeOverAction } from "@/app/actions/inbox";
import { BLOCK_REASON_LABELS, CHANNEL_LABELS, MESSAGE_STATUS_LABELS, smsSegments, type Channel, type MessageStatus } from "@/lib/messaging";
import { ESCALATION_LABELS, type EscalationCategory } from "@/lib/escalation";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
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

const CHANNEL_ICON: Record<Channel, LucideIcon> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const CHANNEL_TONE: Record<Channel, StatusTone> = { sms: "primary", whatsapp: "success", email: "violet" };

function ChannelBadge({ channel }: { channel: Channel }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <StatusPill tone={CHANNEL_TONE[channel]} size="sm" dot={false} icon={<Icon className="size-3" aria-hidden />}>
      {CHANNEL_LABELS[channel]}
    </StatusPill>
  );
}

/** Time left, as "3h 51m" while it is long and "12:30" once it is close, so it never reads as a raw counter. */
function Countdown({ until }: { until: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  const text = left >= 3600 ? `${Math.floor(left / 3600)}h ${String(Math.floor((left % 3600) / 60)).padStart(2, "0")}m` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return <span className="tabular-nums" suppressHydrationWarning>{text}</span>;
}

/** On desktop the panes share one comfortable height and scroll inside; on phones the page simply flows. */
const PANE_H = "lg:h-[max(48rem,calc(100dvh-10rem))]";
const PANE_MAX = "lg:max-h-[max(48rem,calc(100dvh-10rem))]";
const filterChip = "inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition sm:min-h-9";

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

  const countFor = (key: string) => (key === "unread" ? list.filter((c) => c.unread > 0).length : 0);
  return (
    <div className={cn("grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]", detail && "xl:grid-cols-[360px_minmax(0,1fr)_320px]")}>
      <section aria-label="Conversations" className={cn("scrollbar-thin min-h-0 min-w-0 flex-col gap-3 lg:overflow-y-auto lg:pr-1 [&>*]:shrink-0", PANE_MAX, selected ? "hidden lg:flex" : "flex")}>
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
        <div className="card-surface space-y-2.5 rounded-2xl p-2.5">
          <div role="group" aria-label="Filter by channel" className="flex flex-wrap gap-1.5">
            {[["", "All", null], ["sms", "SMS", MessageSquareText], ["whatsapp", "WhatsApp", MessageCircle], ["email", "Email", Mail]].map(([value, label, Icon]) => {
              const I = Icon as LucideIcon | null;
              return (
                <button key={value as string} aria-pressed={filters.channel === value} onClick={() => go({ channel: (value as string) || null })} className={cn(filterChip, filters.channel === value ? "bg-ink text-bg shadow-soft" : "bg-surface-2 text-muted hover:text-ink")}>
                  {I && <I className="size-3.5" aria-hidden />}
                  {label as string}
                </button>
              );
            })}
          </div>
          <div role="group" aria-label="Filter by owner" className="flex flex-wrap gap-1.5">
            {[["", "Everyone"], ["mine", "Mine"], ["ai", "AI"], ["unassigned", "Unassigned"]].map(([value, label]) => (
              <button key={value} aria-pressed={filters.owner === value && !needsOnly} onClick={() => { setNeedsOnly(false); go({ owner: value || null }); }} className={cn(filterChip, filters.owner === value && !needsOnly ? "bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20" : "bg-surface-2 text-muted hover:text-ink")}>
                {label}
              </button>
            ))}
            <button aria-pressed={needsOnly} onClick={() => setNeedsOnly((v) => !v)} className={cn(filterChip, needsOnly ? "bg-warning-soft text-warning-ink ring-1 ring-inset ring-warning/25" : "bg-surface-2 text-muted hover:text-ink")}>
              Needs a person
              {waiting.length > 0 && <span className="min-w-5 rounded-full bg-warning-soft px-1.5 text-center text-[11px] font-semibold tabular-nums text-warning-ink ring-1 ring-inset ring-warning/25">{waiting.length}</span>}
            </button>
            <button aria-pressed={filters.unread} onClick={() => go({ unread: filters.unread ? null : "1" })} className={cn(filterChip, filters.unread ? "bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20" : "bg-surface-2 text-muted hover:text-ink")}>
              Unread
              {countFor("unread") > 0 && !filters.unread && <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-semibold tabular-nums text-white">{countFor("unread")}</span>}
            </button>
          </div>
        </div>

        {waiting.length > 0 && <EscalationQueue items={waiting} me={props.me} canRespond={props.perms.respond} onOpen={(id) => go({ conversation: id })} />}

        <ul className="flex flex-col gap-1.5" aria-label="Conversation list">
          {visible.map((c) => {
            const needs = c.escalation && ["awaiting_owner", "open"].includes(c.escalation.status);
            return (
              <li key={c.id}>
                <button
                  onClick={() => go({ conversation: c.id })}
                  aria-current={selected === c.id ? "true" : undefined}
                  className={cn("group flex w-full gap-3 rounded-2xl border p-3 text-left transition", selected === c.id ? "border-primary/40 bg-primary-soft/40 shadow-soft" : "border-line bg-surface hover:-translate-y-px hover:border-line-strong hover:shadow-card")}
                >
                  <span className="relative shrink-0">
                    <AvatarTile name={c.contactName} size="md" className="size-10 rounded-xl" />
                    {c.unread > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-3 rounded-full bg-primary ring-2 ring-surface" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn("truncate text-[14px] text-ink", c.unread ? "font-semibold" : "font-medium")} title={c.contactName}>{c.contactName}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-faint" suppressHydrationWarning>{c.lastMessageAt ? relativeTime(c.lastMessageAt) : ""}</span>
                    </span>
                    <span className={cn("mt-0.5 block truncate text-[12.5px]", c.unread ? "text-ink-2" : "text-muted")}>{c.preview ?? "No messages yet"}</span>
                    <span className="mt-2 flex flex-wrap items-center gap-1.5">
                      <ChannelBadge channel={c.channel} />
                      <OwnerPill kind={c.ownerKind} name={c.ownerName} />
                      {needs && c.escalation && <StatusPill size="sm" tone={c.escalation.urgency === "urgent" ? "danger" : "warning"}>Needs a person</StatusPill>}
                      {c.priority === "urgent" && !c.escalation && <StatusPill size="sm" tone="danger">Urgent</StatusPill>}
                      {c.unread > 0 && <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-white" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {!visible.length && (
          <div className="card-surface rounded-2xl">
            <EmptyState
              compact
              icon={<Inbox className="size-5" aria-hidden />}
              title={list.length ? "Nothing matches these filters" : "No conversations yet"}
              description={list.length ? "Try a different channel or owner." : "Customer messages from SMS, WhatsApp and email appear here once a channel is verified and connected. Nothing is sent until you switch it on."}
              action={!list.length ? <Link href="/settings/messaging" className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-[13px] font-medium text-ink shadow-soft transition hover:bg-surface-2">Check channel setup</Link> : undefined}
            />
          </div>
        )}
      </section>

      <section aria-label="Conversation" className={cn("min-h-0 min-w-0", selected ? "block" : "hidden lg:block")}>
        {detail ? (
          <>
            <Thread key={detail.conversation.id} {...props} detail={detail} onBack={() => go({ conversation: null })} />
            <details className="card-surface mt-4 rounded-2xl p-3 xl:hidden">
              <summary className="min-h-10 cursor-pointer py-2 text-[13px] font-semibold">Customer details, consent and activity</summary>
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
  if (kind === "ai") return <StatusPill tone="violet" size="sm" dot={false} icon={<Bot className="size-3" aria-hidden />}>AI</StatusPill>;
  if (kind === "human") return <StatusPill tone="primary" size="sm" dot={false} icon={<UserRound className="size-3" aria-hidden />}>{name?.split(" ")[0] ?? "Person"}</StatusPill>;
  return <StatusPill tone="neutral" size="sm">Unassigned</StatusPill>;
}

function EmptyThread({ hasList }: { hasList: boolean }) {
  return (
    <div className={cn("card-surface flex min-h-72 items-center justify-center rounded-2xl", PANE_H)}>
      <EmptyState
        icon={<Inbox className="size-5" aria-hidden />}
        title={hasList ? "Choose a conversation" : "Your inbox is empty"}
        description="Every message shows its real delivery state. Your AI team handles conversations it is allowed to, and hands the rest to a person."
        action={
          <>
            <InfoChip icon={<Bot />}>AI handles routine replies</InfoChip>
            <InfoChip icon={<Hand />}>People take over when needed</InfoChip>
          </>
        }
      />
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
    <section aria-label="Needs a person" className="relative overflow-hidden rounded-2xl border border-warning/30 bg-warning-soft/40 p-3">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-warning to-warning/10" />
      <div className="mb-2.5 flex items-center gap-2.5">
        <IconTile tone="warning" size="sm"><ShieldAlert /></IconTile>
        <h2 className="min-w-0 flex-1 text-[13.5px] font-semibold text-ink">Needs a person</h2>
        <StatusPill tone="warning" size="sm">{items.length} waiting</StatusPill>
      </div>
      <ul className="scrollbar-thin max-h-[26rem] space-y-2 overflow-y-auto pr-0.5">
        {items.slice(0, 5).map((e) => (
          <li key={e.id} className="rounded-xl bg-surface p-3 text-[12.5px] shadow-soft ring-1 ring-inset ring-line">
            <button onClick={() => onOpen(e.conversation_id)} className="block w-full min-w-0 text-left">
              <span className="flex flex-wrap items-center gap-1.5">
                {e.urgency === "urgent" && <StatusPill tone="danger" size="sm">Urgent</StatusPill>}
                <span className="text-[13px] font-semibold text-ink">{ESCALATION_LABELS[e.category]}</span>
              </span>
              <span className="mt-1.5 line-clamp-3 block leading-relaxed text-muted">{e.summary}</span>
            </button>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {e.status === "awaiting_owner" && e.owner_deadline_at && (
                <StatusPill tone="warning" size="sm" icon={<Clock className="size-3" aria-hidden />}>Owner first priority · <Countdown until={e.owner_deadline_at} /></StatusPill>
              )}
              {e.status === "awaiting_owner" && !e.owner_deadline_at && <StatusPill tone="warning" size="sm">Waiting for the business owner</StatusPill>}
              {e.status === "open" && <StatusPill tone="primary" size="sm">Open to teammates</StatusPill>}
            </div>
            {e.status === "open" && <p className="mt-1.5 text-[12px] text-muted">First authorized teammate to accept owns it.</p>}
            {canRespond && (
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" variant="brand" loading={busy === `c${e.id}`} onClick={() => run(`c${e.id}`, async () => { const r = await claimEscalationAction(e.id); if (r.ok) onOpen(e.conversation_id); return r; }, "It's yours.")}>Accept</Button>
                {me.isOwner && e.status === "awaiting_owner" && <Button size="sm" variant="secondary" loading={busy === `d${e.id}`} onClick={() => run(`d${e.id}`, () => declineEscalationAction(e.id), "Passed to your team.")}>Decline</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_TONE: Record<MessageStatus, StatusTone> = {
  received: "neutral",
  note: "warning",
  draft: "warning",
  queued: "neutral",
  sending: "primary",
  sent: "neutral",
  delivered: "success",
  read: "success",
  failed: "danger",
  blocked: "danger",
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
    <article className={cn("card-surface flex min-h-[32rem] flex-col overflow-hidden rounded-2xl", PANE_H)}>
      <header className="flex items-center gap-3 border-b border-line p-3 sm:p-4">
        <button onClick={props.onBack} className="flex size-11 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2 lg:hidden" aria-label="Back to conversations"><ArrowLeft className="size-4" /></button>
        <AvatarTile name={detail.contact.name} size="lg" className="size-11 rounded-2xl text-[13px]" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold tracking-tight" title={detail.contact.name}>{detail.contact.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-1.5"><ChannelBadge channel={c.channel} /><InfoChip>{sentenceCase(detail.contact.lifecycleStage)}</InfoChip>{c.status === "closed" && <StatusPill tone="neutral" size="sm">Closed</StatusPill>}</p>
        </div>
        {perms.reply && <Button size="sm" variant="secondary" onClick={() => run("state", () => setConversationStateAction(c.id, { status: c.status === "closed" ? "open" : "closed" }), c.status === "closed" ? "Reopened." : "Closed.")}>{c.status === "closed" ? "Reopen" : "Close"}</Button>}
      </header>

      <OwnershipBar detail={detail} me={me} perms={perms} busy={busy} run={run} />
      {detail.escalation && <EscalationBanner detail={detail} me={me} perms={perms} busy={busy} run={run} />}

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4" role="log" aria-label="Messages" aria-live="polite">
        {detail.messages.map((m) => {
          if (m.direction === "internal") {
            return (
              <div key={m.id} className="mx-auto max-w-[85%] rounded-xl border border-dashed border-warning/50 bg-warning-soft/40 px-3 py-2 text-[13px]">
                <p className="mb-1 flex flex-wrap items-center gap-1.5"><StatusPill tone="warning" size="sm" dot={false} icon={<Lock className="size-3" aria-hidden />}>Internal note</StatusPill><span className="text-[11px] font-medium text-warning-ink">{m.authorName ?? "System"} · only your team sees this</span></p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            );
          }
          const out = m.direction === "outbound";
          const reason = m.blockedReason ? (BLOCK_REASON_LABELS[m.blockedReason] ?? m.blockedReason) : null;
          return (
            <div key={m.id} className={cn("flex", out ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed", out ? (m.authorKind === "ai" ? "bg-violet-soft text-ink" : "bg-primary-soft text-ink") : "bg-surface-2", m.status === "draft" && "border border-dashed border-warning/60")}>
                {out && <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-ink-2">{m.authorKind === "ai" ? <Bot className="size-3 text-violet-ink" aria-hidden /> : <UserRound className="size-3 text-primary-ink" aria-hidden />}{m.authorKind === "ai" ? (m.scope === "followup" ? "AI follow-up" : "AI") : (m.authorName ?? "Teammate")}</p>}
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                  <span className="tabular-nums" suppressHydrationWarning>{formatDateTime(m.createdAt, timeZone)}</span>
                  {out && <StatusMark status={m.status} />}
                  {out && (m.status === "blocked" || m.status === "failed" || m.status === "draft") && reason && <span className="text-ink-2">{reason}</span>}
                  {out && m.status === "failed" && m.statusDetail && <span className="text-ink-2">{m.statusDetail}</span>}
                </p>
                {m.status === "draft" && m.authorKind === "ai" && perms.reply && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="brand" loading={busy === `a${m.id}`} onClick={() => run(`a${m.id}`, () => approveDraftAction(m.id), "Approved and queued.")}><Check className="size-3.5" />Approve &amp; send</Button>
                    <Button size="sm" variant="secondary" loading={busy === `x${m.id}`} onClick={() => run(`x${m.id}`, () => discardDraftAction(m.id), "Draft discarded.")}><XCircle className="size-3.5" />Discard</Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <footer className="border-t border-line p-3 sm:p-4">
        {optedOut && <p role="status" className="mb-2 flex items-center gap-2 rounded-xl bg-danger-soft p-2.5 text-[12.5px] text-danger-ink ring-1 ring-inset ring-danger/20"><AlertTriangle className="size-4 shrink-0" aria-hidden />This customer opted out of messages on this channel. Nothing can be sent to them here.</p>}
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
        {c.ownerKind === "ai" && perms.reply && mode === "reply" && <p className="mb-2 flex items-start gap-2 rounded-xl bg-violet-soft/60 px-3 py-2 text-[12px] leading-relaxed text-violet-ink"><Bot className="mt-0.5 size-3.5 shrink-0" aria-hidden />The AI is handling this. Sending a reply takes over and stops the AI for this conversation.</p>}
        {otherOwner && !perms.assign && <p className="mb-2 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-ink-2"><UserRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />{c.ownerName ?? "A teammate"} is handling this conversation.</p>}
        <div className="mb-2 flex gap-1" role="tablist" aria-label="Composer mode">
          <button role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")} className={cn("min-h-10 rounded-xl px-3 text-[12.5px] font-medium transition sm:min-h-9", mode === "reply" ? "bg-ink text-bg shadow-soft" : "text-muted hover:bg-surface-2 hover:text-ink")}><Send className="mr-1 inline size-3.5" aria-hidden />Reply</button>
          {perms.notes && <button role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")} className={cn("min-h-10 rounded-xl px-3 text-[12.5px] font-medium transition sm:min-h-9", mode === "note" ? "bg-warning-soft text-warning-ink ring-1 ring-inset ring-warning/25" : "text-muted hover:bg-surface-2 hover:text-ink")}><StickyNote className="mr-1 inline size-3.5" aria-hidden />Internal note</button>}
        </div>
        <label className="sr-only" htmlFor="composer">{mode === "note" ? "Internal note" : `Reply by ${CHANNEL_LABELS[c.channel]}`}</label>
        <Textarea
          id="composer"
          data-composer-dirty={text.trim() ? "true" : "false"}
          rows={2}
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
  return <StatusPill tone={STATUS_TONE[status]} size="sm" dot={false} icon={<Icon className="size-3" aria-hidden />}>{MESSAGE_STATUS_LABELS[status]}</StatusPill>;
}

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) => Promise<boolean>;

function OwnershipBar({ detail, me, perms, busy, run }: { detail: ConversationDetail; me: Props["me"]; perms: Props["perms"]; busy: string | null; run: Run }) {
  const c = detail.conversation;
  const mine = c.ownerKind === "human" && c.ownerUserId === me.id;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-3 py-2.5 text-[12.5px] sm:px-4">
      <span className="flex min-w-0 items-center gap-2.5">
        {c.ownerKind === "ai" ? <><IconTile tone="violet" size="sm"><Bot /></IconTile><span className="min-w-0"><strong>AI is handling this.</strong><span className="hidden 2xl:inline"> It follows your rules and hands off when a person is needed.</span></span></> : c.ownerKind === "human" ? <><IconTile tone="primary" size="sm"><UserRound /></IconTile><span className="min-w-0"><strong>{mine ? "You are" : `${c.ownerName ?? "A teammate"} is`} handling this.</strong><span className="hidden sm:inline"> The AI will not reply.</span></span></> : <><IconTile tone="neutral" size="sm"><Hand /></IconTile><span className="min-w-0"><strong>Nobody owns this yet.</strong><span className="hidden sm:inline"> The AI will not reply.</span></span></>}
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
    <div role="status" className={cn("border-b px-3 py-3 text-[12.5px] sm:px-4", e.urgency === "urgent" ? "border-danger/30 bg-danger-soft/60" : "border-warning/30 bg-warning-soft/60")}>
      <p className="flex flex-wrap items-center gap-1.5 font-medium">
        <IconTile tone={e.urgency === "urgent" ? "danger" : "warning"} size="sm"><ShieldAlert /></IconTile>
        {e.urgency === "urgent" && <StatusPill tone="danger" size="sm">Urgent</StatusPill>}
        <span className="text-[13px] font-semibold text-ink">{ESCALATION_LABELS[e.category as EscalationCategory] ?? sentenceCase(e.category)}</span>
        {e.status === "awaiting_owner" && e.ownerDeadlineAt && <StatusPill tone="warning" size="sm" icon={<Clock className="size-3" aria-hidden />}>Owner first priority · <Countdown until={e.ownerDeadlineAt} /></StatusPill>}
        {e.status === "open" && <StatusPill tone="primary" size="sm">Open to teammates</StatusPill>}
        {e.status === "claimed" && <StatusPill tone="success" size="sm">Taken by {e.claimedByName ?? "a teammate"}</StatusPill>}
      </p>
      <p className="mt-1.5 line-clamp-2 leading-relaxed text-ink-2" title={`${e.summary} (AI summary for your team, not shown to the customer.)`}>{e.summary} <span className="text-muted">(AI summary for your team, not shown to the customer.)</span></p>
      {perms.respond && e.status !== "claimed" && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="brand" loading={busy === "claim"} onClick={() => run("claim", () => claimEscalationAction(e.id), "It's yours.")}>Accept</Button>
          {me.isOwner && e.status === "awaiting_owner" && <Button size="sm" variant="secondary" loading={busy === "decline"} onClick={() => run("decline", () => declineEscalationAction(e.id), "Passed to your team.")}>Decline</Button>}
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
  const section = "card-surface rounded-2xl p-4";
  const heading = (icon: React.ReactNode, title: string, tone: StatusTone = "primary") => (
    <h2 className="flex items-center gap-2.5 text-[13.5px] font-semibold text-ink">
      <IconTile tone={tone} size="sm">{icon}</IconTile>
      {title}
    </h2>
  );
  const subhead = "text-[11px] font-semibold uppercase tracking-[0.12em]";
  return (
    <aside aria-label={inline ? "Customer details (compact)" : "Customer details"} className={cn("scrollbar-thin min-h-0 min-w-0 space-y-4", inline ? "block" : cn("hidden xl:block xl:overflow-y-auto xl:pr-1", PANE_MAX))}>
      <section className={section}>
        <div className="flex items-center gap-3">
          <AvatarTile name={detail.contact.name} size="md" />
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-ink" title={detail.contact.name}>{detail.contact.name}</h2>
            <p className="text-[12px] text-muted">Customer</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusPill tone="primary" size="sm">{sentenceCase(detail.contact.lifecycleStage)}</StatusPill>
          {detail.contact.temperature && <StatusPill tone={detail.contact.temperature === "hot" ? "danger" : detail.contact.temperature === "warm" ? "warning" : "neutral"} size="sm">{sentenceCase(detail.contact.temperature)}</StatusPill>}
          <InfoChip>{sentenceCase(detail.contact.source)}</InfoChip>
        </div>
        <ul className="mt-3 space-y-1.5 text-[12.5px]">
          {detail.contact.identities.map((i) => (
            <li key={`${i.kind}-${i.value}`} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2/70 px-2.5 py-1.5 ring-1 ring-inset ring-line">
              <span className="truncate" title={i.value}>{i.value}</span>
              <StatusPill tone={i.verified ? "success" : "neutral"} size="sm">{i.verified ? "Verified" : "Unverified"}</StatusPill>
            </li>
          ))}
        </ul>
        <h3 className={cn(subhead, "mt-4 text-muted")}>Consent</h3>
        <ul className="mt-2 space-y-1.5 text-[12.5px]">
          {detail.contact.consent.length ? detail.contact.consent.map((x) => (
            <li key={`${x.channel}-${x.purpose}`} className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{CHANNEL_LABELS[x.channel as Channel] ?? x.channel} · {sentenceCase(x.purpose)}</span><StatusPill status={x.status} tone={x.status === "revoked" ? "danger" : x.status === "granted" || x.status === "active" ? "success" : undefined} size="sm" /></li>
          )) : <li className="text-muted">No consent recorded.</li>}
        </ul>
      </section>

      <section className={section}>
        {heading(<CalendarClock />, "Follow-up", "violet")}
        {detail.followUp ? (
          <>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <StatusPill tone="primary" size="sm">{detail.followUp.remaining} remaining</StatusPill>
              {detail.followUp.nextDueAt && <InfoChip icon={<Clock />}>Next {formatDateTime(detail.followUp.nextDueAt, timeZone)}</InfoChip>}
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">It stops if the customer replies, books, opts out or a person takes over.</p>
          </>
        ) : (
          <p className="mt-2 text-[12.5px] text-muted">No follow-ups scheduled.</p>
        )}
      </section>

      {perms.assign && (
        <section className={section}>
          {heading(<UserRound />, "Assignment", "neutral")}
          <label className="sr-only" htmlFor={`${idp}assign`}>Assign to</label>
          <Select id={`${idp}assign`} value={c.assignedUserId ?? ""} onChange={(e) => run("assign", () => assignConversationAction(c.id, e.target.value || null), "Assignment updated.")} className="mt-3" disabled={busy === "assign"}>
            <option value="">Unassigned</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.name} · {sentenceCase(t.role)}</option>)}
          </Select>
          <label className="sr-only" htmlFor={`${idp}priority`}>Priority</label>
          <Select id={`${idp}priority`} value={c.priority} onChange={(e) => run("priority", () => setConversationStateAction(c.id, { priority: e.target.value }), "Priority updated.")} className="mt-2" disabled={busy === "priority"}>
            {["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{sentenceCase(p)} priority</option>)}
          </Select>
        </section>
      )}

      <section className={section}>
        {heading(<ShieldCheck />, "What we know", "success")}
        <h3 className={cn(subhead, "mt-3 text-success-ink")}>Confirmed by your team</h3>
        <ul className="mt-1.5 space-y-1.5 text-[12.5px]">
          {confirmed.length ? confirmed.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-2 rounded-lg bg-success-soft/50 px-2.5 py-1.5"><span>{m.content}</span>{perms.editContacts && <button aria-label="Delete this note" onClick={() => run(`m${m.id}`, () => deleteMemoryAction(m.id), "Removed.")} className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-danger-ink"><XCircle className="size-3.5" /></button>}</li>
          )) : <li className="text-muted">Nothing confirmed yet.</li>}
        </ul>
        <h3 className={cn(subhead, "mt-3 text-violet-ink")}>AI-written summaries (not verified)</h3>
        <ul className="mt-1.5 space-y-1.5 text-[12.5px]">
          {summaries.length ? summaries.map((m) => <li key={m.id} className="rounded-lg bg-violet-soft/50 px-2.5 py-1.5 text-ink-2">{m.content}</li>) : <li className="text-muted">None.</li>}
        </ul>
        {perms.editContacts && (
          <form className="mt-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (fact.trim() && (await run("fact", () => addMemoryAction(detail.contact.id, "confirmed_fact", fact), "Saved."))) setFact(""); }}>
            <label className="sr-only" htmlFor={`${idp}fact`}>Add a confirmed fact</label>
            <Input id={`${idp}fact`} value={fact} onChange={(e) => setFact(e.target.value)} placeholder="Add a confirmed fact" maxLength={1000} />
            <Button size="sm" variant="secondary" type="submit" loading={busy === "fact"}>Add</Button>
          </form>
        )}
      </section>

      <section className={section}>
        {heading(<Clock />, "Activity", "neutral")}
        <ol className="mt-3 space-y-2.5 border-l border-line pl-3 text-[12.5px]">
          {detail.timeline.length ? detail.timeline.slice(-8).map((t, i) => (
            <li key={`${t.at}-${i}`}><span className="block text-ink-2">{t.text}</span><span className="text-[11px] text-faint" suppressHydrationWarning>{formatDateTime(t.at, timeZone)}</span></li>
          )) : <li className="text-muted">No activity recorded yet.</li>}
        </ol>
        <p className="mt-3 text-[11.5px] text-muted">Only real events are listed.</p>
      </section>
    </aside>
  );
}
