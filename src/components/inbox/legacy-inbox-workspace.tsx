"use client";

// LEGACY INBOX. The inbox screen as it was before the Unified Inbox (master 22c68c2), kept unchanged so a workspace that has not been switched on in the
// Unified Inbox rollout keeps exactly the screen it had: human reply, takeover and escalation handling never disappear because of a rollout (see
// docs/unified-inbox/workspace-rollout.md). It talks to the same server actions and services as the new inbox. Delete this file, legacy-inbox.tsx and the
// legacy branch of the page when every workspace is on the new inbox.

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Clock, Hand, Inbox, Loader2, Lock, Mail, Globe, MessageCircle, MessageSquareQuote, MessageSquareText, Search, Send, ShieldAlert, Sparkles, StickyNote, UserRound, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input, Select, Textarea } from "@/components/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { addMemoryAction, addNoteAction, approveDraftAction, assignConversationAction, claimEscalationAction, declineEscalationAction, deleteMemoryAction, discardDraftAction, loadMessagesByIdAction, loadOlderMessagesAction, markReadAction, resolveEscalationAction, resumeAiAction, sendReplyAction, setConversationStateAction, takeOverAction } from "@/app/actions/inbox";
import { confirmIdentityAction } from "@/app/actions/contact-identity";
import { IdentityList } from "@/components/inbox/identity-list";
import { BLOCK_REASON_LABELS, CONVERSATION_CHANNEL_LABELS, MESSAGE_STATUS_LABELS, smsSegments, type ConversationChannel, type MessageStatus } from "@/lib/messaging";
import { anyTokenLabel, customValueKeyOf, renderTemplate, type CustomValueTokenDef, type TokenValues } from "@/lib/messaging/tokens";
import { pickFocusGuard } from "@/components/crm/templates/parts";
import { ESCALATION_LABELS, type EscalationCategory } from "@/lib/escalation";
import { cn, formatDateTime, initials, relativeTime, sentenceCase } from "@/lib/utils";
import type { ConversationDetail, ConversationListItem, MessageView } from "@/server/messaging/inbox";

/** A message with the provider that carried it and its delivery events, as the inbox page loads them. */
export type InboxMessage = MessageView & {
  /** The messaging provider's name (ghl, resend, twilio, meta_whatsapp); null before the message was handed to one. */
  provider: string | null;
  providerLabel: string | null;
  /** The provider's delivery reports, oldest first: normalized status, the provider's own status word, and any failure detail. */
  deliveryEvents: Array<{ status: string; rawStatus: string | null; detail: string | null; at: string }>;
};
export type InboxDetail = Omit<ConversationDetail, "messages"> & { messages: InboxMessage[] };
export interface CannedReplyOption {
  id: string;
  name: string;
  body: string;
  channel: ConversationChannel | null;
  folderName: string | null;
}

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
  detail: InboxDetail | null;
  /** The provider carrying each channel for this workspace (GoHighLevel, Resend, Twilio, WhatsApp Business). */
  channelProviders?: Partial<Record<ConversationChannel, string>>;
  cannedReplies?: CannedReplyOption[];
  /** Token values for the open conversation's contact, used to fill a canned reply when it is inserted. */
  cannedValues?: TokenValues;
  /** The workspace's configuration values (labels, required or not), so a gap left by an empty required one is named. */
  cannedCustomValues?: CustomValueTokenDef[];
  escalations: EscalationCard[];
  me: { id: string; isOwner: boolean };
  perms: { reply: boolean; assign: boolean; notes: boolean; resume: boolean; respond: boolean; editContacts: boolean };
  team: Array<{ id: string; name: string; role: string }>;
  /** Approved WhatsApp templates of the provider that carries WhatsApp now, with their approved wording. */
  templates: Array<{ id: string; name: string; body: string }>;
  timeZone: string;
  filters: { q: string; channel: string; owner: string; unread: boolean };
}

/**
 * What picking a WhatsApp template puts in the composer: the template's approved wording (WhatsApp delivers only that, so the inbox must
 * record the same text), and the values ({{1}}, {{2}} …) the person still has to replace before it can be sent.
 */
export function whatsappTemplateDraft(body: string): { text: string; holes: string[] } {
  return { text: body, holes: [...new Set(body.match(/\{\{\s*\d{1,2}\s*\}\}/g) ?? [])] };
}

const CHANNEL_ICON: Record<ConversationChannel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail, web_chat: Globe };
const CHANNEL_TONE: Record<ConversationChannel, string> = { sms: "text-primary", whatsapp: "text-success-ink", email: "text-violet-ink", web_chat: "text-primary" };

function ChannelBadge({ channel, provider }: { channel: ConversationChannel; provider?: string | null }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", CHANNEL_TONE[channel])}>
      <Icon className="size-3.5" aria-hidden />
      {CONVERSATION_CHANNEL_LABELS[channel]}
      {provider && <span className="font-normal text-faint">via {provider}</span>}
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

export function LegacyInboxWorkspace(props: Props) {
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
      {!detail && <h1 className="sr-only">Inbox</h1>}
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
                    <ChannelBadge channel={c.channel} provider={props.channelProviders?.[c.channel]} />
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

/** Whether message a comes before message b in the thread (by time, then id, as the database orders them). */
const isBefore = (a: Pick<InboxMessage, "createdAt" | "id">, b: Pick<InboxMessage, "createdAt" | "id">) => a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
const byTime = (a: InboxMessage, b: InboxMessage) => (isBefore(a, b) ? -1 : isBefore(b, a) ? 1 : 0);

type PageView = Pick<InboxDetail, "messages" | "olderMessages">;

/** The oldest message of the newest page, where older messages begin; none when the page is the whole conversation. */
function pageBoundary(detail: PageView): InboxMessage | undefined {
  const boundaryId = detail.olderMessages?.beforeId;
  return boundaryId ? detail.messages.find((m) => m.id === boundaryId) : undefined;
}

/** Whether a message is older than the newest page (a held draft, or one only a loaded older page has): a refresh doesn't show it again. */
export function isOlderThanPage(message: Pick<InboxMessage, "createdAt" | "id">, detail: PageView): boolean {
  const boundary = pageBoundary(detail);
  return Boolean(boundary && isBefore(message, boundary));
}

/**
 * The loaded messages older than the page, newest copy of each (a later copy replaces an earlier one), split into those to show and the
 * stale drafts. A loaded copy that is a draft the page no longer lists is stale: the page carries every older draft still waiting for
 * approval, so that draft was approved or discarded since (in the inbox, the Approval Center or by a teammate), or its row is gone.
 */
function splitLoaded(loaded: InboxMessage[], detail: PageView): { shown: InboxMessage[]; stale: InboxMessage[] } {
  const boundary = pageBoundary(detail);
  if (!boundary) return { shown: [], stale: [] };
  const listed = new Set(detail.messages.map((m) => m.id));
  const latest = new Map<string, InboxMessage>();
  for (const m of loaded) latest.set(m.id, m);
  const shown: InboxMessage[] = [];
  const stale: InboxMessage[] = [];
  for (const m of latest.values()) {
    if (listed.has(m.id) || !isBefore(m, boundary)) continue;
    (m.status === "draft" ? stale : shown).push(m);
  }
  return { shown: shown.sort(byTime), stale: stale.sort(byTime) };
}

/**
 * The older messages to show above the newest page, from everything "Load older messages" brought in (newest copy of each wins), oldest
 * first. Only messages older than the page the server sent now, and not in it: what the page lists is always the current version, and a
 * message inside the page's range that it no longer lists is gone. A loaded draft is left out only while it is stale (see
 * staleLoadedDrafts): until its re-read copy arrives, or for good when no row comes back. Once the re-read copy (approved, sent, failed or
 * discarded) is loaded it takes its place in the history again. Nothing when the page is the whole conversation.
 */
export function olderMessagesToShow(loaded: InboxMessage[], detail: PageView): InboxMessage[] {
  return splitLoaded(loaded, detail).shown;
}

/**
 * The ids of loaded drafts the page has stopped listing, newest first: their loaded copies are out of date (approved or discarded since, or
 * gone), so the thread re-reads them by id (loadMessagesByIdAction) rather than dropping them from the history. A re-read that brings back
 * the same draft (still waiting, beyond the held-draft limit) or nothing (gone) leaves the list as it was, so it isn't asked again.
 */
export function staleLoadedDrafts(loaded: InboxMessage[], detail: PageView): string[] {
  return splitLoaded(loaded, detail).stale.reverse().map((m) => m.id);
}

/** At most this many stale drafts are re-read at once: the server's cap (MESSAGES_BY_ID_LIMIT in src/server/messaging/inbox.ts). */
export const STALE_DRAFT_REREAD_LIMIT = 50;

/** How a draft was handled in this thread: approved (with the status sending reached) or discarded. */
export type DraftOutcome = MessageStatus | "skipped" | "discarded";

/**
 * Immediate feedback for a draft approved or discarded here that is older than the newest page: the refresh won't list it again, so its
 * loaded copies take the status it now has (added as a loaded copy when none was loaded), and it keeps its place while the full current
 * version is re-read. A discard mirrors what discardDraft records. A draft in the newest page is left to the refresh.
 */
export function settleLoadedDraft(loaded: InboxMessage[], message: InboxMessage, outcome: DraftOutcome, detail: PageView): InboxMessage[] {
  if (!isOlderThanPage(message, detail)) return loaded;
  const patch: Partial<InboxMessage> =
    outcome === "discarded"
      ? { status: "blocked", blockedReason: "discarded", statusDetail: "Discarded by a teammate." }
      : { status: outcome === "skipped" || outcome === "draft" ? "queued" : outcome, blockedReason: null, statusDetail: null };
  return loaded.some((m) => m.id === message.id) ? loaded.map((m) => (m.id === message.id ? { ...m, ...patch } : m)) : [...loaded, { ...message, ...patch }];
}

/** The toast after approving a draft: what sending actually reached, not always "queued". */
export function approvedDraftToast(status: MessageStatus | "skipped"): { tone: "success" | "warning" | "error"; text: string } {
  if (status === "sent") return { tone: "success", text: "Approved and sent to the provider. Delivery shows once it confirms." };
  if (status === "delivered" || status === "read") return { tone: "success", text: "Approved and delivered." };
  if (status === "failed") return { tone: "error", text: "Approved, but sending failed. The message shows why." };
  if (status === "blocked") return { tone: "warning", text: "Approved, but it couldn't be sent yet. The message shows why." };
  return { tone: "success", text: "Approved and queued." };
}

/**
 * What the thread's auto-scroll follows: the newest message of the page. Not the count, which stays the same once a thread is longer than
 * one page (each new message pushes the page's oldest off). Held drafts sit in front of the page, so the last message is always the newest.
 */
export function newestMessageId(detail: { messages: ReadonlyArray<Pick<MessageView, "id">> }): string | null {
  return detail.messages.at(-1)?.id ?? null;
}

/** Whether a scrolled box shows its end, within a small margin: only then is a new message followed to the bottom. */
export function isScrolledToEnd(box: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">, margin = 64): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= margin;
}

/**
 * What the status line says when a page of older messages came in. A live region announces only a change, so a later load also says how
 * many have come in so far: two full pages in a row would otherwise both read "Loaded 200 older messages." and the second would be silent.
 */
export function olderLoadedNote(count: number, total: number): string {
  const noun = (n: number) => `${n} older ${n === 1 ? "message" : "messages"}`;
  if (count <= 0) return "There are no older messages.";
  return total > count ? `Loaded ${count} more, ${noun(total)} so far.` : `Loaded ${noun(count)}.`;
}

/**
 * The thread in time order, as two blocks: what sits above the newest page (the older messages shown, with the older drafts still waiting
 * for approval that the page carries in front of itself, each in its place by time) and the newest page itself. Without loaded older
 * pages the held drafts simply lead, as before; once a loaded page covers a held draft's time, the draft sits among those messages rather
 * than after all of them. Nothing moves when the page is the whole conversation. shownCount is how many of the newest messages show in
 * one unbroken run: the page and the older messages shown, plus the held drafts inside that run (not those older than all of it).
 * runStart is the oldest message of that run when the thread knows it (the newest page's first message before any load, the oldest loaded
 * page's first message after one, null once the start is reached), so a handled draft kept in its place outside the run isn't counted;
 * left out, the run starts at the oldest older message shown.
 */
export function threadBlocks(
  olderShown: InboxMessage[],
  detail: PageView,
  runStart?: Pick<InboxMessage, "createdAt" | "id"> | null,
): { olderBlock: InboxMessage[]; newestPage: InboxMessage[]; shownCount: number } {
  const pageStart = detail.olderMessages ? detail.messages.findIndex((m) => m.id === detail.olderMessages!.beforeId) : -1;
  const newestPage = pageStart > 0 ? detail.messages.slice(pageStart) : detail.messages;
  const held = pageStart > 0 ? detail.messages.slice(0, pageStart) : [];
  const start = runStart === undefined ? (olderShown[0] ?? newestPage[0]) : runStart;
  const inRun = (m: InboxMessage) => !start || !isBefore(m, start);
  return {
    olderBlock: held.length ? [...olderShown, ...held].sort(byTime) : olderShown,
    newestPage,
    shownCount: newestPage.length + olderShown.filter(inRun).length + held.filter(inRun).length,
  };
}

/**
 * The line above a long thread: how many messages show, and "Load older messages" until the start is reached. While a page loads the
 * button stays focusable (aria-disabled, not the native disabled that drops keyboard focus to the page); the start-of-conversation line
 * can take focus, so the thread can hand it there when the last page replaces the button.
 */
export function OlderMessagesNotice({ nextBefore, shownCount, loading, onLoad, buttonRef, startRef }: {
  nextBefore: string | null;
  shownCount: number;
  loading: boolean;
  onLoad: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  startRef?: React.Ref<HTMLParagraphElement>;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-1 text-center text-[12px] text-muted">
      {nextBefore ? (
        <>
          <p>Showing the newest {shownCount} messages.</p>
          <Button ref={buttonRef} size="sm" variant="ghost" aria-disabled={loading || undefined} aria-busy={loading || undefined} className="aria-disabled:opacity-60" onClick={loading ? undefined : onLoad}>
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Load older messages
          </Button>
        </>
      ) : (
        <p ref={startRef} tabIndex={-1} className="rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-primary">This is the start of the conversation.</p>
      )}
    </div>
  );
}

/**
 * After "Load older messages" finished: when keyboard focus was on the button as the load began, it goes back to the button, or to the
 * start-of-conversation line when the last page replaced the button. Focus elsewhere is left alone.
 */
export function restoreOlderFocus(hadFocus: boolean, button: Pick<HTMLElement, "focus"> | null, start: Pick<HTMLElement, "focus"> | null): void {
  if (!hadFocus) return;
  (button ?? start)?.focus({ preventScroll: true });
}

function Thread(props: Props & { detail: InboxDetail; onBack: () => void }) {
  const { detail, me, perms, templates, timeZone } = props;
  const c = detail.conversation;
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [mode, setMode] = React.useState<"reply" | "note">("reply");
  const [templateId, setTemplateId] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  // Gaps a canned reply left where the contact's details were missing ("[First name]"). Sending waits until the person fills them in.
  const [markers, setMarkers] = React.useState<string[]>([]);
  // The values a picked WhatsApp template still needs ({{1}}, {{2}} …). Sending waits until each is replaced.
  const [holes, setHoles] = React.useState<string[]>([]);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  // Follows the newest message to the bottom: on open, after the person's own send or note, and when a message arrives while the log shows
  // its end (not while someone reads further up). Keyed on the newest message, not the count: on a thread longer than one page the count
  // stays the same as each new message pushes the page's oldest off. Measured at the last scroll, before the new message is laid out.
  const followRef = React.useRef(true);
  const newestId = newestMessageId(detail);
  React.useLayoutEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [newestId]);
  // A long conversation opens with its newest page; "Load older messages" adds earlier pages above it.
  const logRef = React.useRef<HTMLDivElement>(null);
  const [loadedOlder, setLoadedOlder] = React.useState<InboxMessage[]>([]);
  // Where the next older page starts: undefined until one is loaded (the page's own marker), null once the start is reached.
  const [olderBefore, setOlderBefore] = React.useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [olderNote, setOlderNote] = React.useState("");
  // How many older messages the loads brought in so far, for the status line.
  const olderTotal = React.useRef(0);
  const truncated = Boolean(detail.olderMessages) || olderBefore !== undefined;
  const nextBefore = olderBefore === undefined ? (detail.olderMessages?.beforeId ?? null) : olderBefore;
  const olderShown = React.useMemo(() => olderMessagesToShow(loadedOlder, detail), [loadedOlder, detail]);
  // The oldest message of the unbroken run on screen: the page's first before any load, the oldest loaded page's first after one, none
  // once the start is reached. A handled draft kept in its place outside that run isn't counted in "Showing the newest N".
  const runStart =
    olderBefore === null ? null : olderBefore === undefined ? pageBoundary(detail) : (olderShown.find((m) => m.id === olderBefore) ?? detail.messages.find((m) => m.id === olderBefore));
  // The held older drafts take their place by time among the older messages; the newest page follows.
  const { olderBlock, newestPage, shownCount } = threadBlocks(olderShown, detail, runStart);

  // A draft loaded with an older page that the page stopped listing was approved or discarded since (here, in the Approval Center or by a
  // teammate): re-read it, so it keeps its place in the history with its real status instead of dropping out. Its current copy is added
  // (the newest copy of each wins). Keyed on the ids, so each change is read once; a draft that comes back unchanged, or not at all, isn't
  // asked for again.
  const staleKey = React.useMemo(() => staleLoadedDrafts(loadedOlder, detail).slice(0, STALE_DRAFT_REREAD_LIMIT).join(","), [loadedOlder, detail]);
  React.useEffect(() => {
    if (!staleKey) return;
    void loadMessagesByIdAction(c.id, staleKey.split(",")).then((r) => {
      if (r.ok && r.data.messages.length) setLoadedOlder((o) => [...o, ...r.data.messages]);
    });
  }, [c.id, staleKey]);
  /**
   * A draft approved or discarded here that is older than the newest page keeps its place with the status it now has, then its current
   * copy is re-read for the full detail (a failure's reason, the provider, delivery events).
   */
  function settleDraft(m: InboxMessage, outcome: DraftOutcome) {
    if (!isOlderThanPage(m, detail)) return;
    setLoadedOlder((o) => settleLoadedDraft(o, m, outcome, detail));
    void loadMessagesByIdAction(c.id, [m.id]).then((r) => {
      if (r.ok && r.data.messages.length) setLoadedOlder((o) => [...o, ...r.data.messages]);
    });
  }
  const olderBtnRef = React.useRef<HTMLButtonElement>(null);
  const startRef = React.useRef<HTMLParagraphElement>(null);
  // Whether keyboard focus was on "Load older messages" when the current load began; handed back once the result is on screen.
  const refocusOlder = React.useRef(false);
  React.useLayoutEffect(() => {
    if (loadingOlder) return;
    const hadFocus = refocusOlder.current;
    refocusOlder.current = false;
    restoreOlderFocus(hadFocus, olderBtnRef.current, startRef.current);
  }, [loadingOlder, olderBefore]);

  async function loadOlder() {
    if (!nextBefore || loadingOlder) return;
    const el = logRef.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    refocusOlder.current = typeof document !== "undefined" && document.activeElement === olderBtnRef.current;
    setLoadingOlder(true);
    // Emptied first (committed before the request returns), so the result is announced even when it reads like the last one.
    setOlderNote("");
    const r = await loadOlderMessagesAction(c.id, nextBefore);
    setLoadingOlder(false);
    if (!r.ok) {
      toast.error(r.error ?? "Older messages couldn't be loaded. Try again.");
      return;
    }
    // The newest page as it is now is kept too: when a refresh later moves the page on, the messages it drops stay in the thread.
    setLoadedOlder((o) => [...o, ...detail.messages, ...r.data.messages]);
    setOlderBefore(r.data.olderMessages?.beforeId ?? null);
    olderTotal.current += r.data.messages.length;
    setOlderNote(olderLoadedNote(r.data.messages.length, olderTotal.current));
    // Keep the messages the person was reading where they were, rather than jumping as the older ones appear above.
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - fromBottom;
    });
  }

  const otherOwner = c.ownerKind === "human" && c.ownerUserId !== me.id;
  const optedOut = detail.contact.consent.some((x) => x.channel === c.channel && x.purpose === "service" && x.status === "revoked");
  const windowClosed = c.channel === "whatsapp" && c.whatsappWindowOpen === false;
  const needsTemplate = windowClosed && !templateId;
  const segments = c.channel === "sms" ? smsSegments(text) : 0;
  const canReply = perms.reply && !optedOut && !(otherOwner && !perms.assign);
  const openGaps = markers.filter((m) => text.includes(m));
  const openHoles = windowClosed && templateId ? holes.filter((h) => text.includes(h)) : [];
  const replies = (props.cannedReplies ?? []).filter((r) => r.channel === null || r.channel === c.channel);
  const pickedTemplate = templates.find((t) => t.id === templateId) ?? null;

  /**
   * WhatsApp delivers a template's approved wording, filled with values, and nothing else. Picking one puts that wording in the composer, so
   * what the inbox records is what the customer gets; the person only replaces its {{1}}, {{2}} … with values.
   */
  function pickTemplate(id: string) {
    const previous = templates.find((t) => t.id === templateId);
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) {
      setHoles([]);
      return;
    }
    const draft = text.trim();
    if (draft && draft !== previous?.body.trim()) toast.info("Your draft was replaced with the template's approved wording.");
    const next = whatsappTemplateDraft(t.body);
    setText(next.text);
    setMarkers([]);
    setHoles(next.holes);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const first = t.body.search(/\{\{\s*\d{1,2}\s*\}\}/);
      if (first >= 0) el.setSelectionRange(first, first + (t.body.slice(first).match(/^\{\{\s*\d{1,2}\s*\}\}/)?.[0].length ?? 0));
    });
  }

  /** Fills a canned reply with this contact's details and puts it where the person is typing, to edit before sending. */
  function insertCanned(body: string) {
    const gaps: string[] = [];
    const emptyValues: string[] = [];
    const out = renderTemplate(body, props.cannedValues ?? {}, {
      customValues: props.cannedCustomValues ?? null,
      missingAs: (key) => {
        const gap = `[${anyTokenLabel(key, props.cannedCustomValues) ?? "Missing detail"}]`;
        if (customValueKeyOf(key) !== null) emptyValues.push(gap);
        else gaps.push(gap);
        return gap;
      },
    });
    const el = composerRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.trim() ? `${text.slice(0, start)}${out.text}${text.slice(end)}` : out.text;
    setText(next);
    setMarkers((m) => [...new Set([...m, ...gaps, ...emptyValues])]);
    requestAnimationFrame(() => {
      el?.focus();
      const at = text.trim() ? start + out.text.length : out.text.length;
      el?.setSelectionRange(at, at);
    });
    if (gaps.length) toast.warning(`Fill in ${[...new Set(gaps)].join(", ")} before sending: it isn't on this contact's record.`);
    if (emptyValues.length) toast.warning(`Fill in ${[...new Set(emptyValues)].join(", ")} before sending: that configuration value is empty (CRM Settings → Configuration Values).`);
  }

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
    if (mode === "reply" && openGaps.length) {
      toast.error(`Replace ${openGaps.join(", ")} with the real details before sending.`);
      composerRef.current?.focus();
      return;
    }
    if (mode === "reply" && openHoles.length) {
      toast.error(`Replace ${openHoles.join(", ")} in the template with ${openHoles.length === 1 ? "its value" : "their values"} before sending.`);
      composerRef.current?.focus();
      return;
    }
    const sent =
      mode === "note"
        ? await run("send", async () => {
            const r = await addNoteAction(c.id, text);
            if (r.ok) followRef.current = true;
            return r;
          }, "Note added.")
        : await run("send", async () => {
            const r = await sendReplyAction(c.id, text, windowClosed ? templateId : null);
            if (r.ok) followRef.current = true;
            if (r.ok && r.data.status === "blocked") toast.warning("It couldn't be sent yet. The message shows why.");
            else if (r.ok && r.data.status === "sent") toast.success("Sent to the provider. Delivery shows once it confirms.");
            return r;
          });
    if (sent) {
      setText("");
      setMarkers([]);
      setHoles([]);
      setTemplateId("");
    }
  }

  /** One message of the thread: a teammate's internal note, or a customer, AI or teammate message with its status and delivery detail. */
  function renderMessage(m: InboxMessage) {
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
            {m.providerLabel && <span className="text-faint">· via {m.providerLabel}</span>}
          </p>
          {out && m.deliveryEvents.length > 0 && <DeliveryDetails events={m.deliveryEvents} timeZone={timeZone} failed={m.status === "failed"} />}
          {m.status === "draft" && m.authorKind === "ai" && perms.reply && (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="brand"
                loading={busy === `a${m.id}`}
                onClick={() => run(`a${m.id}`, async () => {
                  const r = await approveDraftAction(m.id);
                  if (r.ok) {
                    const t = approvedDraftToast(r.data.status);
                    toast[t.tone](t.text);
                    settleDraft(m, r.data.status);
                  }
                  return r;
                })}
              ><Check className="size-3.5" />Approve &amp; send</Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === `x${m.id}`}
                onClick={() => run(`x${m.id}`, async () => {
                  const r = await discardDraftAction(m.id);
                  if (r.ok) settleDraft(m, "discarded");
                  return r;
                }, "Draft discarded.")}
              ><XCircle className="size-3.5" />Discard</Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <article className="flex h-full min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-3 border-b border-line p-3 sm:p-4">
        <button onClick={props.onBack} className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 lg:hidden" aria-label="Back to conversations"><ArrowLeft className="size-4" /></button>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/80 to-violet/80 text-[12px] font-semibold text-white">{initials(detail.contact.name)}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold tracking-tight">{detail.contact.name}</h1>
          <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted"><ChannelBadge channel={c.channel} provider={props.channelProviders?.[c.channel]} /><span>{sentenceCase(detail.contact.lifecycleStage)}</span>{c.status === "closed" && <Badge>Closed</Badge>}</p>
        </div>
        {perms.reply && <Button size="sm" variant="ghost" onClick={() => run("state", () => setConversationStateAction(c.id, { status: c.status === "closed" ? "open" : "closed" }), c.status === "closed" ? "Reopened." : "Closed.")}>{c.status === "closed" ? "Reopen" : "Close"}</Button>}
      </header>

      <OwnershipBar detail={detail} me={me} perms={perms} busy={busy} run={run} />
      {detail.escalation && <EscalationBanner detail={detail} me={me} perms={perms} busy={busy} run={run} />}

      <div ref={logRef} onScroll={(e) => { followRef.current = isScrolledToEnd(e.currentTarget); }} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4" role="log" tabIndex={0} aria-label="Messages" aria-live="polite">
        {truncated && (
          // Older messages arrive as a page at once: not announced one by one (the status line below says how many came in).
          <div aria-live="off" className="space-y-3">
            <OlderMessagesNotice nextBefore={nextBefore} shownCount={shownCount} loading={loadingOlder} onLoad={loadOlder} buttonRef={olderBtnRef} startRef={startRef} />
            {olderBlock.map(renderMessage)}
          </div>
        )}
        {newestPage.map(renderMessage)}
        <div ref={endRef} />
      </div>
      <p role="status" className="sr-only">{olderNote}</p>

      <footer className="border-t border-line p-3 sm:p-4">
        {optedOut && <p role="status" className="mb-2 flex items-center gap-2 rounded-xl bg-danger-soft p-2.5 text-[12.5px] text-danger-ink"><AlertTriangle className="size-4 shrink-0" aria-hidden />This customer opted out of messages on this channel. Nothing can be sent to them here.</p>}
        {windowClosed && !optedOut && (
          <div role="status" className="mb-2 rounded-xl bg-warning-soft p-2.5 text-[12.5px] text-warning-ink">
            <p className="flex items-start gap-2"><Clock className="mt-0.5 size-4 shrink-0" aria-hidden />WhatsApp&apos;s reply window has closed. Only an approved template can be sent.</p>
            {templates.length ? (
              <>
                <Select aria-label="Approved WhatsApp template" value={templateId} onChange={(e) => pickTemplate(e.target.value)} className="mt-2" aria-describedby={pickedTemplate ? "wa-template-hint" : undefined}>
                  <option value="">Choose an approved template…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
                {pickedTemplate && (
                  <p id="wa-template-hint" className="mt-1.5">
                    {holes.length
                      ? "Its approved wording is in the message box. Replace each {{1}}, {{2}} … with a value and keep the rest as it is: WhatsApp delivers only the approved text."
                      : "Its approved wording is in the message box. Send it as it is: WhatsApp delivers only the approved text."}
                  </p>
                )}
              </>
            ) : <p className="mt-1">No templates are approved yet.</p>}
          </div>
        )}
        {c.ownerKind === "ai" && perms.reply && mode === "reply" && <p className="mb-2 text-[12px] text-muted">The AI is handling this. Sending a reply takes over and stops the AI for this conversation.</p>}
        {otherOwner && !perms.assign && <p className="mb-2 text-[12px] text-muted">{c.ownerName ?? "A teammate"} is handling this conversation.</p>}
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Composer mode">
            <button role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")} className={cn("min-h-9 rounded-lg px-3 text-[12.5px] font-medium", mode === "reply" ? "bg-ink text-bg" : "text-muted hover:bg-surface-2")}><Send className="mr-1 inline size-3.5" aria-hidden />Reply</button>
            {perms.notes && <button role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")} className={cn("min-h-9 rounded-lg px-3 text-[12.5px] font-medium", mode === "note" ? "bg-warning-soft text-warning-ink" : "text-muted hover:bg-surface-2")}><StickyNote className="mr-1 inline size-3.5" aria-hidden />Internal note</button>}
          </div>
          {/* Outside the tablist: a tablist may only own tabs. */}
          {mode === "reply" && canReply && replies.length > 0 && <CannedReplyPicker replies={replies} onPick={insertCanned} />}
        </div>
        <label className="sr-only" htmlFor="composer">{mode === "note" ? "Internal note" : c.channel === "web_chat" ? "Reply in the website chat" : `Reply by ${CONVERSATION_CHANNEL_LABELS[c.channel]}`}</label>
        <Textarea
          id="composer"
          ref={composerRef}
          data-composer-dirty={text.trim() ? "true" : "false"}
          rows={3}
          value={text}
          maxLength={mode === "note" ? 2000 : 5000}
          disabled={mode === "reply" ? !canReply : !perms.notes}
          placeholder={mode === "note" ? "Write a note for your team. The customer never sees it." : c.channel === "web_chat" ? "Reply in the website chat…" : `Reply by ${CONVERSATION_CHANNEL_LABELS[c.channel]}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
        />
        {mode === "reply" && openGaps.length > 0 && (
          <p role="status" className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-ink"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />Replace {openGaps.join(", ")} before sending. These details aren&apos;t on the contact&apos;s record.</p>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-muted">{mode === "reply" && c.channel === "sms" && text ? `${segments} SMS segment${segments === 1 ? "" : "s"}` : mode === "reply" ? `Sends from your verified ${CONVERSATION_CHANNEL_LABELS[c.channel]} sender` : "Visible to your team only"}</span>
          <Button variant={mode === "note" ? "soft" : "brand"} size="sm" loading={busy === "send"} disabled={!text.trim() || (mode === "reply" && (!canReply || needsTemplate))} onClick={submit}>{mode === "note" ? "Add note" : "Send"}</Button>
        </div>
      </footer>
    </article>
  );
}

/** The provider's own delivery reports for one message: its status words and any failure detail, so "failed" always says why. */
function DeliveryDetails({ events, timeZone, failed }: { events: InboxMessage["deliveryEvents"]; timeZone: string; failed: boolean }) {
  const last = events[events.length - 1];
  return (
    <details className="group mt-1 text-[11px] text-muted" open={failed && Boolean(last?.detail || last?.rawStatus) ? true : undefined}>
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 font-medium hover:text-ink [&::-webkit-details-marker]:hidden">
        Delivery details<span aria-hidden className="transition group-open:rotate-90">›</span>
      </summary>
      <ol className="mt-1 space-y-0.5 border-l border-line pl-2">
        {events.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <span className="font-medium text-ink-2">{MESSAGE_STATUS_LABELS[e.status as MessageStatus] ?? sentenceCase(e.status)}</span>
            {e.rawStatus && e.rawStatus !== e.status && <span> · provider status &ldquo;{e.rawStatus}&rdquo;</span>}
            {e.detail && <span> · {e.detail}</span>}
            <span className="text-faint" suppressHydrationWarning> · {formatDateTime(e.at, timeZone)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Saved answers for the composer. Picking one fills it with the contact's details; the person edits it and sends it themselves. */
function CannedReplyPicker({ replies, onPick }: { replies: CannedReplyOption[]; onPick: (body: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  // After a pick the composer takes focus (insertCanned); after Escape or a click outside, focus goes back to this button.
  const [focus] = React.useState(pickFocusGuard);
  const term = q.trim().toLowerCase();
  const shown = replies.filter((r) => !term || `${r.name} ${r.body} ${r.folderName ?? ""}`.toLowerCase().includes(term));
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger asChild>
        <button type="button" className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-lg px-3 text-[12.5px] font-medium text-muted hover:bg-surface-2 hover:text-ink" aria-haspopup="dialog">
          <MessageSquareQuote className="size-3.5" aria-hidden />Canned replies
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(360px,calc(100vw-32px))] p-2"
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        <label className="sr-only" htmlFor="canned-search">Search canned replies</label>
        <Input id="canned-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search canned replies" autoFocus />
        <ul className="scrollbar-thin mt-2 max-h-72 space-y-1 overflow-y-auto" aria-label="Canned replies">
          {shown.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => { focus.markPicked(); onPick(r.body); setOpen(false); setQ(""); }} className="w-full rounded-xl px-3 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none">
                <span className="flex items-center justify-between gap-2"><span className="truncate text-[13px] font-medium text-ink">{r.name}</span>{r.folderName && <span className="shrink-0 text-[11px] text-faint">{r.folderName}</span>}</span>
                <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted">{r.body}</span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="px-3 py-3 text-center text-[12.5px] text-muted">No canned replies match.</li>}
        </ul>
        <p className="mt-2 px-1 text-[11px] text-faint">Inserted with this contact&apos;s details. Check it before sending.</p>
      </PopoverContent>
    </Popover>
  );
}

function StatusMark({ status }: { status: MessageStatus }) {
  const Icon = status === "delivered" || status === "read" ? CheckCheck : status === "sent" ? Check : status === "failed" || status === "blocked" ? AlertTriangle : Clock;
  return <span className="inline-flex items-center gap-1 font-medium"><Icon className="size-3" aria-hidden />{MESSAGE_STATUS_LABELS[status]}</span>;
}

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) => Promise<boolean>;

function OwnershipBar({ detail, me, perms, busy, run }: { detail: InboxDetail; me: Props["me"]; perms: Props["perms"]; busy: string | null; run: Run }) {
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

function EscalationBanner({ detail, me, perms, busy, run }: { detail: InboxDetail; me: Props["me"]; perms: Props["perms"]; busy: string | null; run: Run }) {
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

function ContactPanel({ detail, perms, team, timeZone, inline = false }: Props & { detail: InboxDetail; inline?: boolean }) {
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
        <IdentityList identities={detail.contact.identities} canConfirm={perms.editContacts} idPrefix={idp} onConfirm={(identityId, how) => run("identity", () => confirmIdentityAction(identityId, how), "Confirmed as theirs.")} />
        <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wider text-muted">Consent</h3>
        <ul className="mt-1.5 space-y-1 text-[12.5px]">
          {detail.contact.consent.length ? detail.contact.consent.map((x) => (
            <li key={`${x.channel}-${x.purpose}`} className="flex justify-between gap-2"><span>{CONVERSATION_CHANNEL_LABELS[x.channel as ConversationChannel] ?? x.channel} · {x.purpose}</span><span className={x.status === "revoked" ? "font-medium text-danger-ink" : "text-success-ink"}>{sentenceCase(x.status)}</span></li>
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
