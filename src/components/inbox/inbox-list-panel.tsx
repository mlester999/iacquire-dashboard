"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, Archive, Bot, Check, CheckCheck, ChevronDown, Clock, Inbox, Loader2, Mail, MessageCircle, MessageSquareText, PauseCircle, RotateCcw, Search, ShieldAlert, SquareCheckBig, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input, Select, Skeleton } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlays";
import { bulkConversationsAction } from "@/app/actions/inbox";
import { AGENT_ROLES } from "@/lib/agents";
import { ATTENTION_LABELS, CONVERSATION_OUTCOMES, INBOX_SORTS, INBOX_SORT_HELP, INBOX_SORT_LABELS, INBOX_VIEWS, INBOX_VIEW_HELP, INBOX_VIEW_LABELS, OUTCOME_LABELS, type InboxSort, type InboxView } from "@/lib/inbox";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { cn, initials, relativeTime, sentenceCase } from "@/lib/utils";
import type { ConversationListItem, ViewCounts } from "@/server/messaging/inbox-list";

const CHANNEL_ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const CHANNEL_TONE: Record<Channel, string> = { sms: "text-primary", whatsapp: "text-success-ink", email: "text-violet-ink" };

/** The views always on the tab row; the rest are under "More". */
export const PRIMARY_VIEWS: readonly InboxView[] = ["all", "unread", "attention", "mine", "ai"];
export const MORE_VIEWS: readonly InboxView[] = INBOX_VIEWS.filter((v) => !PRIMARY_VIEWS.includes(v));

export const EMPTY_COPY: Record<InboxView, { title: string; body: string }> = {
  all: { title: "No conversations yet", body: "Customer messages from SMS, WhatsApp and email appear here once a channel is verified and connected. Website enquiries land here too. Nothing is sent until you switch a channel on." },
  unread: { title: "You're all caught up", body: "Every customer message has been opened." },
  mine: { title: "Nothing is assigned to you", body: "Conversations you take over, or that a manager assigns to you, show up here." },
  ai: { title: "No conversation is with an AI employee", body: "When an AI employee is handling a customer, the conversation is listed here so you can watch it or step in." },
  unassigned: { title: "Everything has an owner", body: "New conversations nobody, person or AI, is handling would be listed here." },
  attention: { title: "Nothing needs attention", body: "A conversation shows here when a person was asked for, a message failed, it is marked urgent, or a customer has waited for a reply." },
  open: { title: "No open conversations", body: "Resolved and archived conversations are in their own views." },
  waiting: { title: "Not waiting on anyone", body: "Conversations where you replied last and are waiting for the customer show up here." },
  resolved: { title: "Nothing resolved yet", body: "Resolve a conversation when it's done and note how it ended." },
  archived: { title: "Nothing archived", body: "Archived conversations are kept out of the way. A new customer message brings one back." },
};

/** What "All" says for a role that sees only what is theirs (see inbox.view and inbox.view_all in src/lib/permissions.ts). */
export const RESTRICTED_EMPTY = { title: "Nothing is assigned to you yet", body: "You see the conversations you own or that a manager assigns to you. When one is, it shows up here." };

export interface ListPanelProps {
  items: ConversationListItem[];
  counts: ViewCounts | null;
  view: InboxView;
  sort: InboxSort;
  q: string;
  channel: string;
  selectedId: string | null;
  channelProviders?: Partial<Record<Channel, string>>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  perms: { reply: boolean; assign: boolean; viewAll?: boolean };
  team: Array<{ id: string; name: string; role: string }>;
  onChange: (next: { view?: InboxView; sort?: InboxSort; q?: string; channel?: string }) => void;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  /** After a bulk action: read the list again and let other tabs know. */
  onChanged: () => void;
  /** Rendered above the list (the "needs a person" queue). */
  aboveList?: React.ReactNode;
}

function ChannelMark({ channel, provider }: { channel: Channel; provider?: string | null }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", CHANNEL_TONE[channel])}>
      <Icon className="size-3.5" aria-hidden />
      {CHANNEL_LABELS[channel]}
      {provider && <span className="font-normal text-faint">via {provider}</span>}
    </span>
  );
}

/** Short role name for the pill ("Sales Assistant"), falling back to the employee's own display name. */
export function employeeShortName(agent: { name: string; roleKey: string }): string {
  return AGENT_ROLES.find((r) => r.key === agent.roleKey)?.shortName ?? agent.name.replace(/^AI\s+/i, "");
}

export function OwnerPill({ item }: { item: Pick<ConversationListItem, "ownerKind" | "ownerName" | "aiAgent" | "aiPaused"> }) {
  if (item.ownerKind === "ai") {
    const label = item.aiAgent ? employeeShortName(item.aiAgent) : "AI";
    if (item.aiPaused) return <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-ink"><PauseCircle className="size-3" aria-hidden />{label} · paused</span>;
    return <span className="inline-flex items-center gap-1 rounded-full bg-violet-soft px-2 py-0.5 text-[11px] font-medium text-violet-ink"><Bot className="size-3" aria-hidden />{label}</span>;
  }
  if (item.ownerKind === "human") return <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary-ink"><UserRound className="size-3" aria-hidden />{item.ownerName?.split(" ")[0] ?? "Person"}</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-ink-2">Unassigned</span>;
}

/** The chips that say why a row matters. Each is a fact from the database (see ATTENTION_LABELS), never a guess. */
function StatusChips({ c }: { c: ConversationListItem }) {
  const chips: React.ReactNode[] = [];
  if (c.attention.includes("needs_person")) chips.push(<Badge key="p" tone={c.escalation?.urgency === "urgent" ? "danger" : "warning"}>Needs a person</Badge>);
  if (c.attention.includes("send_failed")) chips.push(<Badge key="f" tone="danger"><AlertTriangle className="size-3" aria-hidden />Send failed</Badge>);
  if (c.attention.includes("urgent") && !c.attention.includes("needs_person")) chips.push(<Badge key="u" tone="danger">Urgent</Badge>);
  if (c.attention.includes("awaiting_reply")) chips.push(<Badge key="a" tone="warning"><Clock className="size-3" aria-hidden />Awaiting reply</Badge>);
  if (c.waitingOnCustomer && !chips.length) chips.push(<Badge key="w" tone="outline">Waiting on customer</Badge>);
  if (c.archivedAt) chips.push(<Badge key="x" tone="outline"><Archive className="size-3" aria-hidden />Archived</Badge>);
  else if (c.status === "closed") chips.push(<Badge key="r" tone="success"><Check className="size-3" aria-hidden />{c.outcome ? OUTCOME_LABELS[c.outcome] : "Resolved"}</Badge>);
  return <>{chips}</>;
}

export function ConversationRow({ c, selected, onOpen, provider, selectMode, checked, onCheck }: { c: ConversationListItem; selected: boolean; onOpen: (id: string) => void; provider?: string | null; selectMode: boolean; checked: boolean; onCheck: (id: string, on: boolean) => void }) {
  const attention = c.attention.map((a) => ATTENTION_LABELS[a]).join(". ");
  return (
    <li className="flex items-stretch gap-2">
      {selectMode && (
        <label className="flex w-9 shrink-0 cursor-pointer items-center justify-center">
          <span className="sr-only">Select {c.contactName}</span>
          <input type="checkbox" checked={checked} onChange={(e) => onCheck(c.id, e.target.checked)} className="size-4 accent-[var(--color-primary)]" />
        </label>
      )}
      <button
        onClick={() => onOpen(c.id)}
        aria-current={selected ? "true" : undefined}
        className={cn("flex min-w-0 flex-1 gap-3 rounded-2xl border p-3 text-left transition", selected ? "border-primary/40 bg-primary-soft/40" : "border-line bg-surface hover:bg-surface-2", c.archivedAt && "opacity-75")}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/80 to-violet/80 text-[12px] font-semibold text-white" aria-hidden>{initials(c.contactName)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className={cn("truncate text-[14px]", c.unread ? "font-semibold" : "font-medium")}>{c.contactName}</span>
            <span className="shrink-0 text-[11px] text-faint" suppressHydrationWarning>{c.lastMessageAt ? relativeTime(c.lastMessageAt) : ""}</span>
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted">{c.preview ?? "No messages yet"}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ChannelMark channel={c.channel} provider={provider} />
            <OwnerPill item={c} />
            <StatusChips c={c} />
            {c.priority === "high" && !c.attention.length && <Badge tone="warning">High</Badge>}
            {c.unread > 0 && <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-white" aria-label={`${c.unread} unread`}>{c.unread}</span>}
          </span>
          {attention && <span className="sr-only">{attention}.</span>}
        </span>
      </button>
    </li>
  );
}

function ViewTabs({ view, counts, onChange }: { view: InboxView; counts: ViewCounts | null; onChange: (v: InboxView) => void }) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const count = (v: InboxView) => (counts ? counts[v] : null);
  const tab = (v: InboxView) => (
    <button
      key={v}
      ref={(el) => {
        refs.current[v] = el;
      }}
      role="tab"
      id={`inbox-view-${v}`}
      aria-selected={view === v}
      aria-controls="inbox-list"
      tabIndex={view === v ? 0 : -1}
      onClick={() => onChange(v)}
      className={cn(
        "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition",
        view === v ? "bg-ink text-bg" : "bg-surface-2 text-muted hover:text-ink",
      )}
    >
      {INBOX_VIEW_LABELS[v]}
      {count(v) !== null && count(v)! > 0 && (
        <>
          <span className="sr-only"> </span>
          <span className={cn("rounded-full px-1.5 text-[11px] font-semibold tabular-nums", view === v ? "bg-bg/20" : v === "attention" ? "bg-warning-soft text-warning-ink" : "bg-surface-3 text-ink-2")}>{count(v)! > 99 ? "99+" : count(v)}</span>
        </>
      )}
    </button>
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const shown = [...PRIMARY_VIEWS, ...(MORE_VIEWS.includes(view) ? [view] : [])];
    const i = shown.indexOf(view);
    const next = shown[(i + (e.key === "ArrowRight" ? 1 : -1) + shown.length) % shown.length];
    onChange(next);
    refs.current[next]?.focus();
    e.preventDefault();
  };
  const moreActive = MORE_VIEWS.includes(view);
  return (
    // One scrolling row on a phone (three wrapped rows of tabs would push the list off the screen); wrapped from sm up.
    <div className="scrollbar-thin -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
      <div role="tablist" aria-label="Conversation views" onKeyDown={onKeyDown} className="flex shrink-0 items-center gap-1.5 sm:flex-wrap">
        {PRIMARY_VIEWS.map(tab)}
        {moreActive && tab(view)}
      </div>
      <Menu>
        <MenuTrigger asChild>
          <button className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-xl bg-surface-2 px-3 text-[12.5px] font-medium text-muted transition hover:text-ink" aria-label="More views">
            More<ChevronDown className="size-3.5" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>More views</MenuLabel>
          {MORE_VIEWS.map((v) => (
            <MenuItem key={v} onSelect={() => onChange(v)} aria-label={INBOX_VIEW_LABELS[v]}>
              <span className="flex w-full items-center justify-between gap-3">
                <span className="flex items-center gap-2">{view === v ? <Check className="size-3.5" aria-hidden /> : <span className="size-3.5" aria-hidden />}{INBOX_VIEW_LABELS[v]}</span>
                {count(v) !== null && <span className="text-[11.5px] tabular-nums text-faint">{count(v)}</span>}
              </span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

export function BulkBar({ selected, perms, team, onClear, onDone }: { selected: string[]; perms: { reply: boolean; assign: boolean }; team: ListPanelProps["team"]; onClear: () => void; onDone: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState("");
  async function run(key: string, action: Parameters<typeof bulkConversationsAction>[1], ok: string) {
    setBusy(key);
    const r = await bulkConversationsAction(selected, action);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error ?? "That didn't work.");
      return;
    }
    const { done, skipped } = r.data;
    if (skipped.length) toast.warning(`${ok} for ${done}. ${skipped.length} skipped: ${skipped[0].reason}${skipped.length > 1 ? " (and others)" : ""}`);
    else toast.success(`${ok} for ${done}.`);
    onDone();
  }
  return (
    <div role="region" aria-label="Bulk actions" className="space-y-2 rounded-2xl border border-primary/30 bg-primary-soft/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold" aria-live="polite">{selected.length} selected</p>
        <button onClick={onClear} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] text-muted hover:text-ink"><X className="size-3.5" aria-hidden />Clear</button>
      </div>
      <p className="text-[11.5px] text-muted">Nothing here sends a message to a customer.</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" loading={busy === "read"} disabled={!selected.length} onClick={() => run("read", { kind: "mark_read" }, "Marked read")}><CheckCheck className="size-3.5" aria-hidden />Mark read</Button>
        {perms.reply && (
          <>
            <Button size="sm" variant="secondary" loading={busy === "unread"} disabled={!selected.length} onClick={() => run("unread", { kind: "mark_unread" }, "Marked unread")}>Mark unread</Button>
            <Button size="sm" variant="secondary" loading={busy === "resolve"} disabled={!selected.length} onClick={() => run("resolve", { kind: "resolve", outcome: outcome || null }, "Resolved")}><SquareCheckBig className="size-3.5" aria-hidden />Resolve</Button>
            <Button size="sm" variant="secondary" loading={busy === "reopen"} disabled={!selected.length} onClick={() => run("reopen", { kind: "reopen" }, "Reopened")}><RotateCcw className="size-3.5" aria-hidden />Reopen</Button>
            <Button size="sm" variant="secondary" loading={busy === "archive"} disabled={!selected.length} onClick={() => run("archive", { kind: "archive" }, "Archived")}><Archive className="size-3.5" aria-hidden />Archive</Button>
          </>
        )}
      </div>
      {perms.reply && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          <div>
            <label className="sr-only" htmlFor="bulk-outcome">How these ended (when resolving)</label>
            <Select id="bulk-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">Resolve without an outcome</option>
              {CONVERSATION_OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
            </Select>
          </div>
          {perms.assign && (
            <div>
              <label className="sr-only" htmlFor="bulk-assign">Assign selected to</label>
              <Select id="bulk-assign" value="" disabled={!selected.length || busy === "assign"} onChange={(e) => { const v = e.target.value; if (v) void run("assign", { kind: "assign", userId: v === "none" ? null : v }, "Assigned"); }}>
                <option value="">Assign to…</option>
                <option value="none">Remove assignment</option>
                {team.map((t) => <option key={t.id} value={t.id}>{t.name} · {sentenceCase(t.role)}</option>)}
              </Select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function InboxListPanel(p: ListPanelProps) {
  const [q, setQ] = React.useState(p.q);
  const [selectMode, setSelectMode] = React.useState(false);
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const searchRef = React.useRef<HTMLInputElement>(null);
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // The search box follows the URL (back/forward, or a link to a search) without fighting what the person is typing: it changes only when the
  // value it was given changes.
  const [seenQ, setSeenQ] = React.useState(p.q);
  if (seenQ !== p.q) {
    setSeenQ(p.q);
    setQ(p.q);
  }
  React.useEffect(() => {
    // "/" focuses the search, like most inboxes. Not while typing in a field.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function typed(value: string) {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => p.onChange({ q: value.trim() }), 350);
  }

  // Someone who sees only their own conversations is told that, instead of being sent to check the channels: nothing is wrong with them.
  const restricted = p.perms.viewAll === false;
  const empty = restricted && p.view === "all" ? RESTRICTED_EMPTY : EMPTY_COPY[p.view];
  const searching = Boolean(p.q || p.channel);
  const selectedIds = [...checked].filter((id) => p.items.some((i) => i.id === id));

  return (
    <section aria-label="Conversations" className="flex min-w-0 flex-col gap-3">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (debounce.current) clearTimeout(debounce.current);
          p.onChange({ q: q.trim() });
        }}
        className="relative"
      >
        <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden />
        <label className="sr-only" htmlFor="inbox-search">Search conversations</label>
        <Input ref={searchRef} id="inbox-search" value={q} onChange={(e) => typed(e.target.value)} placeholder="Search customers or messages" className="pl-9" />
      </form>

      <ViewTabs view={p.view} counts={p.counts} onChange={(v) => { setChecked(new Set()); p.onChange({ view: v }); }} />
      <p className="-mt-1 text-[11.5px] text-muted" id="inbox-view-help">{INBOX_VIEW_HELP[p.view]}</p>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="sr-only" htmlFor="inbox-channel">Channel</label>
          <Select id="inbox-channel" value={p.channel} onChange={(e) => p.onChange({ channel: e.target.value })}>
            <option value="">All channels</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
          </Select>
        </div>
        <div>
          <label className="sr-only" htmlFor="inbox-sort">Sort by</label>
          <Select id="inbox-sort" title={INBOX_SORT_HELP[p.sort]} value={p.sort} onChange={(e) => p.onChange({ sort: e.target.value as InboxSort })}>
            {INBOX_SORTS.map((s) => <option key={s} value={s}>{INBOX_SORT_LABELS[s]}</option>)}
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => { setSelectMode((v) => !v); setChecked(new Set()); }}
          aria-pressed={selectMode}
          className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition", selectMode ? "bg-primary-soft text-primary-ink" : "bg-surface-2 text-muted hover:text-ink")}
        >
          <SquareCheckBig className="size-3.5" aria-hidden />{selectMode ? "Done selecting" : "Select"}
        </button>
        {selectMode && p.items.length > 0 && (
          <button onClick={() => setChecked(new Set(p.items.slice(0, 50).map((i) => i.id)))} className="min-h-9 rounded-lg px-2 text-[12.5px] text-muted hover:text-ink">Select first {Math.min(50, p.items.length)}</button>
        )}
      </div>
      {selectMode && <BulkBar selected={selectedIds} perms={p.perms} team={p.team} onClear={() => setChecked(new Set())} onDone={() => { setChecked(new Set()); p.onChanged(); }} />}

      {p.aboveList}

      <div id="inbox-list" role="tabpanel" aria-labelledby={`inbox-view-${p.view}`} aria-busy={p.loading || undefined}>
        {p.error && (
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-soft/50 p-4 text-[13px] text-danger-ink">
            <p className="flex items-center gap-2 font-medium"><ShieldAlert className="size-4" aria-hidden />The list couldn&apos;t be loaded.</p>
            <p className="mt-1 text-ink-2">{p.error}</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={p.onRetry}><RotateCcw className="size-3.5" aria-hidden />Try again</Button>
          </div>
        )}
        {p.loading && !p.items.length && !p.error && (
          <ul className="flex flex-col gap-1.5" aria-label="Loading conversations">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="flex gap-3 rounded-2xl border border-line bg-surface p-3">
                <Skeleton className="size-10 rounded-xl" />
                <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-2/5" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-1/3" /></div>
              </li>
            ))}
          </ul>
        )}
        <ul className="flex flex-col gap-1.5" aria-label="Conversation list">
          {p.items.map((c) => (
            <ConversationRow
              key={c.id}
              c={c}
              selected={p.selectedId === c.id}
              onOpen={p.onOpen}
              provider={p.channelProviders?.[c.channel]}
              selectMode={selectMode}
              checked={checked.has(c.id)}
              onCheck={(id, on) => setChecked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; })}
            />
          ))}
        </ul>
        {!p.loading && !p.error && !p.items.length && (
          <div className="rounded-2xl border border-dashed border-line-strong p-8 text-center">
            <Inbox className="mx-auto size-6 text-muted" aria-hidden />
            <h2 className="mt-3 text-[15px] font-semibold">{searching ? "Nothing matches" : empty.title}</h2>
            <p className="mx-auto mt-1 max-w-xs text-[13px] leading-relaxed text-muted">{searching ? "Try different words, or clear the channel filter." : empty.body}</p>
            {searching && <Button size="sm" variant="secondary" className="mt-3" onClick={() => { setQ(""); p.onChange({ q: "", channel: "" }); }}>Clear search and filters</Button>}
            {!searching && p.view === "all" && !restricted && <Link href="/settings/messaging" className="mt-3 inline-block text-[13px] font-medium text-primary">Check channel setup</Link>}
          </div>
        )}
        {p.hasMore && (
          <div className="mt-2 flex justify-center">
            <Button size="sm" variant="secondary" loading={p.loadingMore} onClick={p.onLoadMore}>{p.loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}Load more conversations</Button>
          </div>
        )}
      </div>
    </section>
  );
}
