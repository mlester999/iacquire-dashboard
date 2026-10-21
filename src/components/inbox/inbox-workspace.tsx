"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Archive, ArrowLeft, Bot, Check, CheckCheck, Clock, EllipsisVertical, Inbox, Loader2, Lock, Mail, MessageCircle, MessageSquareQuote, MessageSquareText, PanelRightOpen, RotateCcw, Send, ShieldAlert, Sparkles, SquareCheckBig, StickyNote, UserRound, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input, Kbd, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Sheet } from "@/components/ui/overlays";
import { addMemoryAction, addNoteAction, approveDraftAction, assignAiEmployeeAction, assignConversationAction, claimEscalationAction, declineEscalationAction, deleteMemoryAction, discardDraftAction, loadMessagesByIdAction, loadOlderMessagesAction, markReadAction, markUnreadAction, resolveEscalationAction, retryMessageAction, sendReplyAction, setConversationStateAction } from "@/app/actions/inbox";
import { AiControls } from "@/components/inbox/ai-controls";
import { AiAssistPanel } from "@/components/inbox/ai-assist-panel";
import { requestSuggestedReply } from "@/components/inbox/assist-client";
import { ChannelHealthBar } from "@/components/inbox/channel-health-bar";
import { CrmContextPanel } from "@/components/inbox/crm-context-panel";
import { InboxListPanel } from "@/components/inbox/inbox-list-panel";
import { useInboxSync } from "@/components/inbox/use-inbox-sync";
import { BLOCK_REASON_LABELS, CHANNEL_LABELS, MESSAGE_STATUS_LABELS, smsSegments, type Channel, type MessageStatus } from "@/lib/messaging";
import { anyTokenLabel, customValueKeyOf, renderTemplate, type CustomValueTokenDef, type TokenValues } from "@/lib/messaging/tokens";
import { pickFocusGuard } from "@/components/crm/templates/parts";
import { ESCALATION_LABELS, type EscalationCategory } from "@/lib/escalation";
import { CONVERSATION_OUTCOMES, OUTCOME_LABELS, isInboxSort, isInboxView, type InboxSort, type InboxView } from "@/lib/inbox";
import { cn, formatDateTime, initials, sentenceCase } from "@/lib/utils";
import type { ConversationDetail, MessageView } from "@/server/messaging/inbox";
import type { ConversationListItem, ViewCounts } from "@/server/messaging/inbox-list";
import type { ChannelHealth } from "@/server/messaging/channel-health";
import type { ConversationAiEmployee } from "@/server/messaging/inbox-context";

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
  channel: Channel | null;
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
  channelProviders?: Partial<Record<Channel, string>>;
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
  filters: { q: string; channel: string; owner: string; unread: boolean; view?: InboxView; sort?: InboxSort };
  /** How many conversations each view holds, and where the list continues. */
  counts?: ViewCounts | null;
  nextCursor?: string | null;
  /** What each channel can really do right now (see src/server/messaging/channel-health.ts). */
  channelHealth?: ChannelHealth[];
  /** The customer-facing AI employees a manager may attach to a conversation. */
  aiEmployees?: ConversationAiEmployee[];
  /** Whether this person may ask for AI summaries and suggested replies (and the workspace has them). */
  aiAssist?: boolean;
  /** The database time the page was read at; live updates ask for changes from here. */
  syncFrom?: string | null;
  /** Off in tests and previews: no polling. */
  live?: boolean;
}

/**
 * What picking a WhatsApp template puts in the composer: the template's approved wording (WhatsApp delivers only that, so the inbox must
 * record the same text), and the values ({{1}}, {{2}} …) the person still has to replace before it can be sent.
 */
export function whatsappTemplateDraft(body: string): { text: string; holes: string[] } {
  return { text: body, holes: [...new Set(body.match(/\{\{\s*\d{1,2}\s*\}\}/g) ?? [])] };
}

const CHANNEL_ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const CHANNEL_TONE: Record<Channel, string> = { sms: "text-primary", whatsapp: "text-success-ink", email: "text-violet-ink" };

function ChannelBadge({ channel, provider }: { channel: Channel; provider?: string | null }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", CHANNEL_TONE[channel])}>
      <Icon className="size-3.5" aria-hidden />
      {CHANNEL_LABELS[channel]}
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

/** What the child components call after they change something: re-read what is on screen, and let other tabs know. */
const InboxActions = React.createContext<{ refresh: () => void } | null>(null);
function useInboxRefresh(): () => void {
  const ctx = React.useContext(InboxActions);
  const router = useRouter();
  return ctx ? ctx.refresh : () => router.refresh();
}

/** The view a link that predates views (owner / unread filters) means. */
function legacyView(f: { owner: string; unread: boolean }): InboxView {
  if (f.unread) return "unread";
  if (f.owner === "mine") return "mine";
  if (f.owner === "ai") return "ai";
  if (f.owner === "unassigned") return "unassigned";
  return "all";
}

interface Filters {
  view: InboxView;
  sort: InboxSort;
  q: string;
  channel: string;
}

const filterQuery = (f: Filters, extra: Record<string, string | null> = {}) => {
  const sp = new URLSearchParams();
  if (f.view !== "all") sp.set("view", f.view);
  if (f.sort !== "priority") sp.set("sort", f.sort);
  if (f.q) sp.set("q", f.q);
  if (f.channel) sp.set("channel", f.channel);
  for (const [k, v] of Object.entries(extra)) if (v) sp.set(k, v);
  return sp;
};

type JsonResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };
type ListPage = { items: ConversationListItem[]; nextCursor: string | null };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<JsonResult<T>> {
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin", signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: (body as { error?: string } | null)?.error ?? "That didn't work." };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: "The connection dropped. Check your internet and try again." };
  }
}

/** True on screens wide enough for the customer panel to sit beside the thread (the 2xl breakpoint: with the sidebar, anything narrower leaves the thread too thin). Server and first paint assume yes, as before. */
function useIsWide(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(min-width: 1536px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(min-width: 1536px)").matches,
    () => true,
  );
}

export function InboxWorkspace(props: Props) {
  const pathname = usePathname();
  const params = useSearchParams();
  const wide = useIsWide();
  const [filters, setFilters] = React.useState<Filters>({ view: props.filters.view ?? legacyView(props.filters), sort: props.filters.sort ?? "priority", q: props.filters.q, channel: props.filters.channel });
  const [items, setItems] = React.useState<ConversationListItem[]>(props.list);
  const [nextCursor, setNextCursor] = React.useState<string | null>(props.nextCursor ?? null);
  const [counts, setCounts] = React.useState<ViewCounts | null>(props.counts ?? null);
  const [detail, setDetail] = React.useState<InboxDetail | null>(props.detail);
  const [selectedId, setSelectedId] = React.useState<string | null>(props.detail?.conversation.id ?? params.get("conversation"));
  const [escalations, setEscalations] = React.useState(props.escalations);
  const [list, setList] = React.useState({ loading: false, loadingMore: false, error: null as string | null });
  const [thread, setThread] = React.useState({ loading: false, error: null as string | null });
  const [panelOpen, setPanelOpen] = React.useState(false);
  const live = props.live !== false;

  // A new server render (a link that navigates here, or the router refreshing after a server action) is adopted as the latest known state.
  const [seenProps, setSeenProps] = React.useState({ list: props.list, detail: props.detail, escalations: props.escalations });
  if (seenProps.list !== props.list || seenProps.detail !== props.detail || seenProps.escalations !== props.escalations) {
    setSeenProps({ list: props.list, detail: props.detail, escalations: props.escalations });
    setItems(props.list);
    setNextCursor(props.nextCursor ?? null);
    if (props.counts) setCounts(props.counts);
    setEscalations(props.escalations);
    if (props.detail) {
      setDetail(props.detail);
      setSelectedId(props.detail.conversation.id);
    }
  }

  const filtersRef = React.useRef(filters);
  const selectedRef = React.useRef(selectedId);
  const pages = React.useRef(1);
  const listSeq = React.useRef(0);
  const threadSeq = React.useRef(0);
  React.useEffect(() => {
    filtersRef.current = filters;
    selectedRef.current = selectedId;
  });

  const loadList = React.useCallback(async (f: Filters, o: { pages?: number; silent?: boolean } = {}) => {
    const mine = ++listSeq.current;
    if (!o.silent) setList((s) => ({ ...s, loading: true, error: null }));
    const want = Math.max(1, Math.min(o.pages ?? 1, 4));
    let cursor: string | null = null;
    const all: ConversationListItem[] = [];
    let loaded = 0;
    for (let i = 0; i < want; i += 1) {
      const r: JsonResult<ListPage> = await getJson<ListPage>(`/api/inbox/conversations?${filterQuery(f, { cursor })}`);
      if (mine !== listSeq.current) return; // a newer request (another view, another search) took over
      if (!r.ok) {
        setList((s) => ({ ...s, loading: false, error: r.error }));
        return;
      }
      all.push(...r.data.items);
      cursor = r.data.nextCursor;
      loaded += 1;
      if (!cursor) break;
    }
    const seen = new Set<string>();
    setItems(all.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true))));
    setNextCursor(cursor);
    pages.current = loaded;
    setList({ loading: false, loadingMore: false, error: null });
  }, []);

  const loadThread = React.useCallback(async (id: string, o: { silent?: boolean } = {}) => {
    const mine = ++threadSeq.current;
    if (!o.silent) setThread({ loading: true, error: null });
    const r = await getJson<InboxDetail>(`/api/inbox/conversations/${id}`);
    if (mine !== threadSeq.current || selectedRef.current !== id) return;
    if (!r.ok) {
      if (r.status === 404 && o.silent) {
        // It disappeared from under the person (resolved elsewhere into a view they cannot see, or access changed).
        setDetail(null);
        setSelectedId(null);
      }
      setThread({ loading: false, error: r.status === 404 ? "This conversation isn't available to you any more." : r.error });
      return;
    }
    setDetail(r.data);
    setThread({ loading: false, error: null });
  }, []);

  const loadEscalations = React.useCallback(async () => {
    const r = await getJson<EscalationCard[]>("/api/inbox/escalations");
    if (r.ok) setEscalations(r.data);
  }, []);

  const known = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.id, i.revision);
    if (detail && detail.conversation.revision !== undefined) m.set(detail.conversation.id, detail.conversation.revision);
    return m;
  }, [items, detail]);
  const knownRef = React.useRef(known);
  React.useEffect(() => {
    knownRef.current = known;
  });

  const sync = useInboxSync({
    enabled: live,
    initialServerTime: props.syncFrom ?? null,
    openId: selectedId,
    getKnown: () => knownRef.current,
    onCounts: setCounts,
    onRefreshList: async () => {
      await Promise.all([loadList(filtersRef.current, { pages: pages.current, silent: true }), loadEscalations()]);
    },
    onRefreshThread: async () => {
      if (selectedRef.current) await loadThread(selectedRef.current, { silent: true });
    },
  });

  const refresh = React.useCallback(() => {
    void loadList(filtersRef.current, { pages: pages.current, silent: true });
    void loadEscalations();
    if (selectedRef.current) void loadThread(selectedRef.current, { silent: true });
    sync.poke();
  }, [loadList, loadEscalations, loadThread, sync]);
  const actions = React.useMemo(() => ({ refresh }), [refresh]);

  const urlFor = (f: Filters, id: string | null) => {
    const qs = filterQuery(f, { conversation: id }).toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  function changeFilters(next: Partial<Filters>) {
    const f = { ...filtersRef.current, ...next };
    setFilters(f);
    filtersRef.current = f;
    window.history.replaceState(null, "", urlFor(f, selectedRef.current));
    pages.current = 1;
    void loadList(f);
  }

  function openConversation(id: string) {
    setSelectedId(id);
    selectedRef.current = id;
    setPanelOpen(false);
    setDetail((d) => (d?.conversation.id === id ? d : null));
    window.history.pushState(null, "", urlFor(filtersRef.current, id));
    void loadThread(id);
  }

  function closeConversation() {
    threadSeq.current += 1;
    setSelectedId(null);
    selectedRef.current = null;
    setDetail(null);
    setThread({ loading: false, error: null });
    window.history.pushState(null, "", urlFor(filtersRef.current, null));
  }

  // Back and forward move between the conversations and views the person visited, without a page load.
  React.useEffect(() => {
    const onPop = () => {
      const sp = new URLSearchParams(window.location.search);
      const view = sp.get("view");
      const sort = sp.get("sort");
      const f: Filters = { view: isInboxView(view) ? view : "all", sort: isInboxSort(sort) ? sort : "priority", q: sp.get("q") ?? "", channel: sp.get("channel") ?? "" };
      setFilters(f);
      filtersRef.current = f;
      void loadList(f);
      const id = sp.get("conversation");
      setSelectedId(id);
      selectedRef.current = id;
      if (id) void loadThread(id);
      else setDetail(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [loadList, loadThread]);

  // Opening a conversation marks it read for the team (the unread count is shared), then everything else catches up.
  const openedId = detail?.conversation.id ?? null;
  const openedUnread = detail?.conversation.unread ?? 0;
  React.useEffect(() => {
    if (!openedId || openedUnread <= 0) return;
    void markReadAction(openedId).then((r) => {
      if (!r || !r.ok) return;
      setItems((cur) => cur.map((i) => (i.id === openedId ? { ...i, unread: 0 } : i)));
      sync.poke();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedId]);

  // j / k move through the list, Escape leaves a conversation on a phone. Never while typing.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (e.key === "j" || e.key === "k") {
        const ids = items.map((i) => i.id);
        const at = selectedRef.current ? ids.indexOf(selectedRef.current) : -1;
        const next = ids[e.key === "j" ? Math.min(ids.length - 1, at + 1) : Math.max(0, at - 1)];
        if (next && next !== selectedRef.current) {
          e.preventDefault();
          openConversation(next);
        }
      } else if (e.key === "Escape" && selectedRef.current && window.matchMedia("(max-width: 1279px)").matches) {
        closeConversation();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const waiting = escalations.filter((e) => ["awaiting_owner", "open"].includes(e.status));
  const showDetail = detail && selectedId === detail.conversation.id ? detail : null;

  return (
    <InboxActions.Provider value={actions}>
      <div className="space-y-3">
        {props.channelHealth && <div className={cn(selectedId && "hidden xl:block")}><ChannelHealthBar channels={props.channelHealth} status={sync.status} lastSyncAt={sync.lastSyncAt} /></div>}
        {/* One pane below xl (the list, or the open conversation, filling the height so the messages scroll above the composer); two columns from xl, three from 2xl. */}
        <div className={cn("grid grid-rows-[minmax(0,1fr)] gap-4 xl:h-[calc(100dvh-13rem)] xl:min-h-[560px] xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)_340px]", selectedId && "h-[calc(100dvh-9rem)] min-h-[480px] xl:h-[calc(100dvh-13rem)]")}>
          {!showDetail && <h1 className="sr-only">Inbox</h1>}
          <div className={cn("min-w-0 xl:overflow-y-auto xl:pr-1", selectedId ? "hidden xl:block" : "block")}>
            <InboxListPanel
              items={items}
              counts={counts}
              view={filters.view}
              sort={filters.sort}
              q={filters.q}
              channel={filters.channel}
              selectedId={selectedId}
              channelProviders={props.channelProviders}
              loading={list.loading}
              loadingMore={list.loadingMore}
              error={list.error}
              hasMore={nextCursor !== null}
              perms={props.perms}
              team={props.team}
              onChange={changeFilters}
              onOpen={openConversation}
              onRetry={() => void loadList(filtersRef.current)}
              onChanged={refresh}
              onLoadMore={async () => {
                if (!nextCursor) return;
                setList((s) => ({ ...s, loadingMore: true }));
                const r = await getJson<{ items: ConversationListItem[]; nextCursor: string | null }>(`/api/inbox/conversations?${filterQuery(filtersRef.current, { cursor: nextCursor })}`);
                if (!r.ok) {
                  setList((s) => ({ ...s, loadingMore: false }));
                  toast.error(r.error);
                  return;
                }
                setItems((cur) => {
                  const have = new Set(cur.map((i) => i.id));
                  return [...cur, ...r.data.items.filter((i) => !have.has(i.id))];
                });
                setNextCursor(r.data.nextCursor);
                pages.current += 1;
                setList((s) => ({ ...s, loadingMore: false }));
              }}
              aboveList={waiting.length > 0 ? <EscalationQueue items={waiting} me={props.me} canRespond={props.perms.respond} onOpen={openConversation} /> : undefined}
            />
          </div>

          <section aria-label="Conversation" className={cn("min-h-0 min-w-0", selectedId ? "block" : "hidden xl:block")}>
            {showDetail ? (
              <Thread
                key={showDetail.conversation.id}
                {...props}
                detail={showDetail}
                onBack={closeConversation}
                onOpenCustomer={() => setPanelOpen(true)}
                aiEmployees={props.aiEmployees ?? []}
                aiAssist={props.aiAssist ?? false}
              />
            ) : selectedId && thread.loading ? (
              <div className="flex h-full min-h-72 flex-col gap-3 rounded-2xl border border-line bg-surface p-4" aria-busy="true" aria-label="Loading conversation">
                <Skeleton className="h-10 w-2/5" />
                <Skeleton className="h-16 w-3/5" />
                <Skeleton className="ml-auto h-12 w-1/2" />
                <Skeleton className="h-14 w-2/3" />
              </div>
            ) : selectedId && thread.error ? (
              <div role="alert" className="flex h-full min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong p-10 text-center">
                <ShieldAlert className="size-6 text-muted" aria-hidden />
                <h2 className="mt-3 text-[15px] font-semibold">{thread.error}</h2>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void loadThread(selectedId)}>Try again</Button>
                  <Button size="sm" variant="ghost" onClick={closeConversation}>Back to the list</Button>
                </div>
              </div>
            ) : (
              <EmptyThread hasList={items.length > 0} />
            )}
          </section>

          {showDetail && wide && (
            <div className="min-w-0 xl:overflow-y-auto xl:pr-1">
              <ContactPanel key={`c-${showDetail.conversation.id}`} {...props} detail={showDetail} aiAssist={props.aiAssist ?? false} timeZone={props.timeZone} />
            </div>
          )}
        </div>
        {showDetail && !wide && (
          <Sheet open={panelOpen} onOpenChange={setPanelOpen} title="Customer details" description="CRM record, deals, tasks, consent and activity for this customer." side="right">
            <div className="p-4">
              <ContactPanel key={`m-${showDetail.conversation.id}`} {...props} detail={showDetail} aiAssist={props.aiAssist ?? false} timeZone={props.timeZone} inline />
            </div>
          </Sheet>
        )}
        <p className="hidden text-[11.5px] text-faint xl:block">Shortcuts: <Kbd>/</Kbd> search · <Kbd>J</Kbd> <Kbd>K</Kbd> next and previous conversation · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> send</p>
      </div>
    </InboxActions.Provider>
  );
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
  const refresh = useInboxRefresh();
  const [busy, setBusy] = React.useState<string | null>(null);
  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) toast.error(r.error ?? "That didn't work.");
    else {
      toast.success(ok);
      refresh();
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

function Thread(props: Props & { detail: InboxDetail; onBack: () => void; onOpenCustomer: () => void; aiEmployees: ConversationAiEmployee[]; aiAssist: boolean }) {
  const { detail, me, perms, templates, timeZone } = props;
  const c = detail.conversation;
  const refresh = useInboxRefresh();
  const [text, setText] = React.useState("");
  const [mode, setMode] = React.useState<"reply" | "note">("reply");
  const [templateId, setTemplateId] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  // A reply the AI suggested on request. It is only ever offered here; the person decides whether it goes into the box, and then sends it.
  const [suggestion, setSuggestion] = React.useState<{ text: string; warnings: string[] } | null>(null);
  const [suggesting, setSuggesting] = React.useState(false);
  const suggestAbort = React.useRef<AbortController | null>(null);
  // A failed message the person is about to send again that may already have reached the customer (needs their confirmation).
  const [confirmRetry, setConfirmRetry] = React.useState<InboxMessage | null>(null);
  const [outcome, setOutcome] = React.useState("");
  const [resolveOpen, setResolveOpen] = React.useState(false);
  React.useEffect(() => () => suggestAbort.current?.abort(), []);
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
    refresh();
    return true;
  }

  /** Asks for a suggested reply. It appears below the box as a draft; nothing is put in the box or sent until the person chooses to. */
  async function suggest() {
    suggestAbort.current?.abort();
    const ac = new AbortController();
    suggestAbort.current = ac;
    setSuggesting(true);
    setSuggestion(null);
    const r = await requestSuggestedReply(c.id, ac.signal);
    if (ac.signal.aborted) return;
    setSuggesting(false);
    if (!r.ok) toast.error(r.reason);
    else setSuggestion({ text: r.data.text, warnings: r.data.warnings });
  }

  function acceptSuggestion() {
    if (!suggestion) return;
    setText(suggestion.text);
    setMarkers([]);
    setHoles([]);
    setSuggestion(null);
    setMode("reply");
    requestAnimationFrame(() => composerRef.current?.focus());
    toast.info("The AI's draft is in the box. Check it, change what you need to, then send it yourself.");
  }

  /** Sends a failed message again. If it may already have reached the customer, the person confirms first. */
  async function retry(m: InboxMessage, acknowledged = false) {
    if (m.failureKind === "unconfirmed" && !acknowledged) {
      setConfirmRetry(m);
      return;
    }
    setConfirmRetry(null);
    await run(`retry${m.id}`, async () => {
      const r = await retryMessageAction(m.id, acknowledged);
      if (r.ok) {
        followRef.current = true;
        if (r.data.status === "blocked") toast.warning("It couldn't be sent yet. The new message shows why.");
        else if (r.data.status === "sent") toast.success("Sent again. Delivery shows once the provider confirms.");
      }
      return r;
    });
  }

  async function resolve() {
    const ok = await run("state", () => setConversationStateAction(c.id, { status: "closed", outcome: outcome || null, seenInboundAt: c.lastInboundAt }), "Resolved.");
    if (ok) {
      setResolveOpen(false);
      setOutcome("");
    }
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
    // "The provider rejected the message" is only true when it answered; a send nobody confirmed says what happened in its own detail.
    const reason = m.blockedReason && !(m.status === "failed" && m.failureKind === "unconfirmed") ? (BLOCK_REASON_LABELS[m.blockedReason] ?? m.blockedReason) : null;
    const canRetry = out && m.status === "failed" && !m.retriedBy && perms.reply && (m.scope === "human" || m.scope === "reply");
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
          {out && m.status === "failed" && (
            <div className="mt-2 space-y-1.5 text-[12px]">
              {m.failureKind === "unconfirmed" && !m.retriedBy && <p className="text-warning-ink">The provider never confirmed this. The customer may already have it.</p>}
              {m.failureKind === "rejected" && !m.retriedBy && <p className="text-muted">The provider refused it, so the customer did not get it.</p>}
              {m.retriedBy && <p className="text-muted">Sent again as a new message below.</p>}
              {canRetry && (
                <Button size="sm" variant="secondary" loading={busy === `retry${m.id}`} onClick={() => retry(m)}><RotateCcw className="size-3.5" aria-hidden />Send again</Button>
              )}
            </div>
          )}
          {m.retryOf && <p className="mt-1 text-[11px] text-faint">Sent again after an earlier attempt failed.</p>}
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

  /** A change of hands, an AI pause, a resolve: said once, in place, between the messages it happened between. */
  function renderEvent(e: { id: string; at: string; text: string }) {
    return (
      <div key={e.id} role="note" className="flex items-center gap-2 text-[11.5px] text-faint">
        <span aria-hidden className="h-px flex-1 bg-line" />
        <span className="max-w-[80%] text-center"><span className="text-muted">{e.text}</span> · <span suppressHydrationWarning>{formatDateTime(e.at, timeZone)}</span></span>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>
    );
  }

  // Events sit among the messages by time. When only a page of the thread is shown, events from before the oldest shown message are left out.
  const shownMessages = [...olderBlock, ...newestPage];
  const floor = truncated && shownMessages.length ? shownMessages[0].createdAt : null;
  const lifecycle = (detail.events ?? []).filter((e) => floor === null || e.at >= floor);
  const newestStart = newestPage[0]?.createdAt ?? "";
  // At the same moment (a database transaction has one clock): what a person changed comes before the message they sent, a request for a person after the message that caused it.
  const merge = (msgs: InboxMessage[], evs: Array<{ id: string; at: string; text: string; after?: boolean }>) => {
    const rows: Array<{ at: string; rank: number; node: React.ReactNode }> = [
      ...msgs.map((m) => ({ at: m.createdAt, rank: 1, node: renderMessage(m) })),
      ...evs.map((e) => ({ at: e.at, rank: e.after ? 2 : 0, node: renderEvent(e) })),
    ];
    return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.at < b.r.at ? -1 : a.r.at > b.r.at ? 1 : a.r.rank - b.r.rank || a.i - b.i)).map((x) => x.r.node);
  };
  const olderRows = merge(olderBlock, lifecycle.filter((e) => e.at < newestStart));
  const newestRows = merge(newestPage, lifecycle.filter((e) => e.at >= newestStart));
  const archived = Boolean(c.archivedAt);

  return (
    <article className="flex h-full min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line p-3 sm:gap-3 sm:p-4">
        <button onClick={props.onBack} className="flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 sm:size-9 xl:hidden" aria-label="Back to conversations"><ArrowLeft className="size-4" /></button>
        <span className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/80 to-violet/80 text-[12px] font-semibold text-white sm:flex" aria-hidden>{initials(detail.contact.name)}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold tracking-tight">{detail.contact.name}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <ChannelBadge channel={c.channel} provider={props.channelProviders?.[c.channel]} />
            <span className="hidden sm:inline">{sentenceCase(detail.contact.lifecycleStage)}</span>
            {archived ? <Badge tone="outline"><Archive className="size-3" aria-hidden />Archived</Badge> : c.status === "closed" ? <Badge tone="success"><Check className="size-3" aria-hidden />Resolved{c.outcome ? ` · ${OUTCOME_LABELS[c.outcome]}` : ""}</Badge> : null}
            {c.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" className="2xl:hidden" onClick={props.onOpenCustomer} aria-label="Customer details"><PanelRightOpen className="size-4" aria-hidden /><span className="hidden sm:inline">Customer</span></Button>
          {perms.reply && c.status !== "closed" && (
            <Popover open={resolveOpen} onOpenChange={setResolveOpen}>
              <PopoverTrigger asChild><Button size="sm" variant="secondary" aria-label="Resolve"><SquareCheckBig className="size-3.5" aria-hidden /><span className="hidden sm:inline">Resolve</span></Button></PopoverTrigger>
              <PopoverContent align="end" className="w-[min(300px,calc(100vw-32px))] p-3">
                <label htmlFor="resolve-outcome" className="text-[12.5px] font-medium">How did it end?</label>
                <Select id="resolve-outcome" className="mt-1.5" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  <option value="">No outcome</option>
                  {CONVERSATION_OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
                </Select>
                <p className="mt-1.5 text-[11.5px] text-muted">A new message from the customer reopens it.</p>
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setResolveOpen(false)}>Cancel</Button>
                  <Button size="sm" variant="brand" loading={busy === "state"} onClick={resolve}>Resolve</Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {perms.reply && c.status === "closed" && (
            <Button size="sm" variant="secondary" aria-label="Reopen" loading={busy === "state"} onClick={() => run("state", () => setConversationStateAction(c.id, { status: "open" }), "Reopened.")}><RotateCcw className="size-3.5" aria-hidden /><span className="hidden sm:inline">Reopen</span></Button>
          )}
          {perms.reply && (
            <Menu>
              <MenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="More actions"><EllipsisVertical className="size-4" aria-hidden /></Button></MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => void run("unread", () => markUnreadAction(c.id), "Marked unread.")}>Mark unread</MenuItem>
                {c.status === "closed" && !archived && <MenuItem onSelect={() => void run("archive", () => setConversationStateAction(c.id, { archived: true }), "Archived.")}><Archive className="size-4" aria-hidden />Archive</MenuItem>}
                {archived && <MenuItem onSelect={() => void run("unarchive", () => setConversationStateAction(c.id, { archived: false }), "Moved back to the inbox.")}>Move back to the inbox</MenuItem>}
                <MenuSeparator />
                <MenuItem onSelect={() => void run("priority", () => setConversationStateAction(c.id, { priority: c.priority === "urgent" ? "normal" : "urgent" }), c.priority === "urgent" ? "No longer urgent." : "Marked urgent.")}>{c.priority === "urgent" ? "Remove urgent" : "Mark urgent"}</MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </header>

      <AiControls c={c} me={me} perms={perms} team={props.team} aiEmployees={props.aiEmployees} busy={busy} run={run} />
      {detail.escalation && <EscalationBanner detail={detail} me={me} perms={perms} busy={busy} run={run} />}

      <div ref={logRef} onScroll={(e) => { followRef.current = isScrolledToEnd(e.currentTarget); }} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4" role="log" aria-label="Messages" aria-live="polite">
        {truncated && (
          // Older messages arrive as a page at once: not announced one by one (the status line below says how many came in).
          <div aria-live="off" className="space-y-3">
            <OlderMessagesNotice nextBefore={nextBefore} shownCount={shownCount} loading={loadingOlder} onLoad={loadOlder} buttonRef={olderBtnRef} startRef={startRef} />
            {olderRows}
          </div>
        )}
        {newestRows}
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
        {c.ownerKind === "ai" && perms.reply && mode === "reply" && <p className="mb-2 text-[12px] text-muted">{c.aiPaused ? "AI replies are paused here. " : "The AI is handling this. "}Sending a reply takes over and stops the AI for this conversation.</p>}
        {otherOwner && !perms.assign && <p className="mb-2 text-[12px] text-muted">{c.ownerName ?? "A teammate"} is handling this conversation.</p>}
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Composer mode">
            <button role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")} className={cn("min-h-9 rounded-lg px-3 text-[12.5px] font-medium", mode === "reply" ? "bg-ink text-bg" : "text-muted hover:bg-surface-2")}><Send className="mr-1 inline size-3.5" aria-hidden />Reply</button>
            {perms.notes && <button role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")} className={cn("min-h-9 rounded-lg px-3 text-[12.5px] font-medium", mode === "note" ? "bg-warning-soft text-warning-ink" : "text-muted hover:bg-surface-2")}><StickyNote className="mr-1 inline size-3.5" aria-hidden />Internal note</button>}
          </div>
          {/* Outside the tablist: a tablist may only own tabs. */}
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {mode === "reply" && canReply && props.aiAssist && (
              <button type="button" onClick={suggest} disabled={suggesting} aria-busy={suggesting || undefined} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-3 text-[12.5px] font-medium text-violet-ink hover:bg-violet-soft disabled:opacity-60">
                {suggesting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}<span className="hidden sm:inline">Suggest reply</span><span className="sr-only sm:hidden">Suggest reply</span>
              </button>
            )}
            {mode === "reply" && canReply && replies.length > 0 && <CannedReplyPicker replies={replies} onPick={insertCanned} />}
          </span>
        </div>
        {suggestion && mode === "reply" && (
          <div role="region" aria-label="Suggested reply" className="mb-2 rounded-xl border border-violet/30 bg-violet-soft/50 p-3 text-[13px]">
            <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-violet-ink"><Sparkles className="size-3.5" aria-hidden />AI suggestion · not sent · not verified</p>
            <p className="mt-1.5 whitespace-pre-wrap">{suggestion.text}</p>
            {suggestion.warnings.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12px] text-warning-ink">{suggestion.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="brand" onClick={acceptSuggestion}>Put it in the box</Button>
              <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>Dismiss</Button>
            </div>
          </div>
        )}
        <label className="sr-only" htmlFor="composer">{mode === "note" ? "Internal note" : `Reply by ${CHANNEL_LABELS[c.channel]}`}</label>
        <Textarea
          id="composer"
          ref={composerRef}
          data-composer-dirty={text.trim() ? "true" : "false"}
          rows={2}
          className="min-h-[64px]"
          value={text}
          maxLength={mode === "note" ? 2000 : 5000}
          disabled={mode === "reply" ? !canReply : !perms.notes}
          placeholder={mode === "note" ? "Write a note for your team. The customer never sees it." : `Reply by ${CHANNEL_LABELS[c.channel]}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
        />
        {mode === "reply" && openGaps.length > 0 && (
          <p role="status" className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-ink"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />Replace {openGaps.join(", ")} before sending. These details aren&apos;t on the contact&apos;s record.</p>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-muted">{mode === "reply" && c.channel === "sms" && text ? `${segments} SMS segment${segments === 1 ? "" : "s"}` : mode === "reply" ? `Sends from your verified ${CHANNEL_LABELS[c.channel]} sender` : "Visible to your team only"}</span>
          <Button variant={mode === "note" ? "soft" : "brand"} size="sm" loading={busy === "send"} disabled={!text.trim() || (mode === "reply" && (!canReply || needsTemplate))} onClick={submit}>{mode === "note" ? "Add note" : "Send"}</Button>
        </div>
      </footer>

      <Dialog
        open={confirmRetry !== null}
        onOpenChange={(o) => { if (!o) setConfirmRetry(null); }}
        title="Send this message again?"
        description="The first attempt was never confirmed, so the customer may already have received it. Sending again could mean they get it twice."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRetry(null)}>Cancel</Button>
            <Button variant="brand" onClick={() => confirmRetry && retry(confirmRetry, true)}>Send again anyway</Button>
          </>
        }
      >
        <blockquote className="whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-[13px]">{confirmRetry?.body}</blockquote>
      </Dialog>
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

function ContactPanel({ detail, perms, team, timeZone, aiAssist, inline = false, ...props }: Props & { detail: InboxDetail; aiAssist: boolean; inline?: boolean }) {
  const idp = inline ? "m-" : "";
  const refresh = useInboxRefresh();
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
      refresh();
    }
    return r.ok;
  }
  const confirmed = detail.memories.filter((m) => m.kind === "confirmed_fact");
  const summaries = detail.memories.filter((m) => m.kind === "ai_summary");
  return (
    <aside aria-label={inline ? "Customer details (compact)" : "Customer details"} className="block min-w-0 space-y-4">
      <AiAssistPanel conversationId={c.id} newestInboundId={[...detail.messages].reverse().find((m) => m.direction === "inbound")?.id ?? null} canUse={aiAssist} />
      <CrmContextPanel conversationId={c.id} version={c.revision} timeZone={timeZone} onChanged={refresh} />
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[13px] font-semibold">Identity and consent</h2>
        <dl className="mt-3 space-y-2 text-[12.5px]">
          <div className="flex justify-between gap-2"><dt className="text-muted">Stage</dt><dd>{sentenceCase(detail.contact.lifecycleStage)}</dd></div>
          {detail.contact.temperature && <div className="flex justify-between gap-2"><dt className="text-muted">Temperature</dt><dd>{sentenceCase(detail.contact.temperature)}</dd></div>}
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
          {(props.aiEmployees ?? []).length > 0 && (
            <>
              <label className="sr-only" htmlFor={`${idp}ai-employee`}>AI employee on this conversation</label>
              <Select id={`${idp}ai-employee`} value={c.aiAgent?.id ?? ""} onChange={(e) => { const v = e.target.value; if (v) void run("ai-employee", () => assignAiEmployeeAction(c.id, v), "AI employee updated."); }} className="mt-2" disabled={busy === "ai-employee"}>
                {!c.aiAgent && <option value="">AI employee: none chosen</option>}
                {(props.aiEmployees ?? []).map((a) => <option key={a.id} value={a.id}>AI employee: {a.name}{a.ready ? "" : ` (${a.problem?.toLowerCase() ?? "not ready"})`}</option>)}
              </Select>
            </>
          )}
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
