"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Copy,
  Menu as MenuIcon,
  Circle,
  Paperclip,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  UserRound,
  Wrench,
} from "lucide-react";
import { AgentAvatar, ThinkingDots } from "@/components/brand";
import { StatusPill } from "@/components/ui/status";
import { Markdown } from "@/components/markdown";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog, Segmented, Sheet, Tooltip } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { ChatRail, type ConversationItem, type ListState } from "@/components/chat/chat-rail";
import { openHelp } from "@/components/help/help-widget";
import {
  deleteConversationAction,
  loadConversationAction,
  loadOlderMessagesAction,
  renameConversationAction,
  searchConversationsAction,
  setReplyLengthAction,
} from "@/app/actions/chat";
import { agentIdentityLabel, type AgentRoleMeta, type AgentStatus } from "@/lib/agents";
import { deriveEmployeeReadiness, type EmployeeReadiness } from "@/lib/workforce-readiness";
import { chatNavTargets } from "@/lib/chat-navigation";
import type { ReplyLength } from "@/lib/agent-settings";
import { cn, formatTime } from "@/lib/utils";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "notice";
  content: string;
  status: "streaming" | "complete" | "failed" | "cancelled" | "superseded";
  run_id: string | null;
  error_code: string | null;
  created_at: string;
}

interface Props {
  meta: AgentRoleMeta;
  agentName: string;
  status: AgentStatus;
  statusDetail: string | null;
  configVersion: number | null;
  lastHealthCheckAt: string | null;
  lastHealthOk: boolean | null;
  inventoryContract: string | null;
  inventoryDigest: string | null;
  inventoryVerifiedAt: string | null;
  inventoryExpiresAt: string | null;
  inventoryToolCount: number | null;
  credentialReady: boolean;
  isAgencyEmployee: boolean;
  identityCurrent: boolean | null;
  acknowledgementCurrent: boolean | null;
  taskExecuting: boolean;
  replyLength: ReplyLength;
  canConfigure: boolean;
  configured: boolean;
  hasPendingReview: boolean;
  initialConversations: ConversationItem[];
  initialConversation: { id: string; title: string; messages: ChatMessage[]; hasMore?: boolean } | null;
  activeRunId: string | null;
  timeZone: string;
  /** The kind of workspace the viewer is in (client or agency), so "back" and "home" go to the right place. */
  orgKind: string;
  /** The server's clock at render time, so grouped dates and relative times hydrate identically. */
  nowIso: string;
  /** Pre-filled composer text (e.g. from "Ask Performance Analyst"). Never auto-sent. */
  initialInput?: string;
}

type StreamEvent =
  | { type: "ready"; conversationId: string; userMessageId: string | null; assistantMessageId: string; runId: string }
  | { type: "snapshot"; content: string }
  | { type: "activity"; label: string }
  | { type: "delta"; text: string }
  | { type: "approval"; approvalId: string; title: string }
  | { type: "done"; content: string }
  | { type: "cancelled"; content: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

async function* readEvents(res: Response): AsyncGenerator<StreamEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as StreamEvent;
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

type ChatStatusTone = "success" | "primary" | "warning" | "violet" | "neutral" | "danger";

function chatStatusMeta(readiness: EmployeeReadiness): { label: string; tone: ChatStatusTone } {
  return { label: readiness.label, tone: readiness.tone };
}

const ERROR_TEXT: Record<string, string> = {
  start_failed: "Couldn't reach your AI employee.",
  connection_lost: "The connection dropped before the answer finished.",
  timeout: "This took too long and was stopped.",
  run_failed: "Your AI employee couldn't finish this request.",
  interrupted: "The AI service restarted while answering.",
  stream_ended: "The response ended unexpectedly.",
};

const RAIL_KEY = "iaq-chat-rail";
let memoryCompact = false;
const railListeners = new Set<() => void>();
function readCompactRail() {
  try {
    return localStorage.getItem(RAIL_KEY) === "compact";
  } catch {
    return memoryCompact;
  }
}
function subscribeRail(callback: () => void) {
  railListeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    railListeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}
/** The desktop rail's collapsed state, remembered per browser so switching employee does not reset it. */
function useCompactRail() {
  const compact = React.useSyncExternalStore(subscribeRail, readCompactRail, () => false);
  const toggle = React.useCallback(() => {
    memoryCompact = !readCompactRail();
    try {
      localStorage.setItem(RAIL_KEY, memoryCompact ? "compact" : "full");
    } catch {
      /* storage blocked: the in-memory value still applies for this page */
    }
    railListeners.forEach((listener) => listener());
  }, []);
  return [compact, toggle] as const;
}

function useNow(initialIso: string) {
  const [now, setNow] = React.useState(() => new Date(initialIso));
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function ChatWorkspace(props: Props) {
  const { meta } = props;
  const reduce = useReducedMotion();
  const now = useNow(props.nowIso);
  const readiness = deriveEmployeeReadiness({
    displayName: props.agentName,
    enabled: props.status !== "disabled",
    status: props.status,
    configVersion: props.configVersion,
    hasPendingReview: props.hasPendingReview,
    lastHealthCheckAt: props.lastHealthCheckAt,
    lastHealthOk: props.lastHealthOk,
    lastHealthDetail: props.statusDetail,
    inventoryContract: props.inventoryContract,
    inventoryDigest: props.inventoryDigest,
    inventoryVerifiedAt: props.inventoryVerifiedAt,
    inventoryExpiresAt: props.inventoryExpiresAt,
    inventoryToolCount: props.inventoryToolCount,
    credentialCurrent: props.credentialReady,
    isAgencyEmployee: props.isAgencyEmployee,
    identityCurrent: props.identityCurrent,
    acknowledgementCurrent: props.acknowledgementCurrent,
    taskExecuting: props.taskExecuting,
    evaluatedAt: now,
  });
  const ready = readiness.chatAvailable;
  const statusMeta = chatStatusMeta(readiness);
  const [conversations, setConversations] = React.useState(props.initialConversations);
  const [conversationId, setConversationId] = React.useState<string | null>(props.initialConversation?.id ?? null);
  const [messages, setMessages] = React.useState<ChatMessage[]>(props.initialConversation?.messages ?? []);
  const [hasMore, setHasMore] = React.useState(Boolean(props.initialConversation?.hasMore));
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  // A response still streaming when the page loaded is re-attached below; start in that state.
  const [streaming, setStreaming] = React.useState<{ runId: string | null; assistantId: string | null } | null>(() =>
    props.activeRunId ? { runId: props.activeRunId, assistantId: null } : null,
  );
  const [activity, setActivity] = React.useState<string | null>(null);
  const [input, setInput] = React.useState(props.initialInput ?? "");
  const [search, setSearch] = React.useState("");
  const [railOpen, setRailOpen] = React.useState(false);
  const [listState, setListState] = React.useState<ListState>("idle");
  const [compactRail, toggleCompactRail] = useCompactRail();
  const targets = chatNavTargets(props.orgKind, meta.slug);
  const [replyLength, setReplyLength] = React.useState<ReplyLength>(props.replyLength);
  const [renaming, setRenaming] = React.useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const stickRef = React.useRef(true);

  const scrollToBottom = React.useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? "smooth" : "auto" });
  }, [reduce]);

  React.useEffect(() => {
    if (stickRef.current) scrollToBottom(false);
  }, [messages, activity, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickRef.current = near;
    setAtBottom(near);
  };

  // --- conversation list ----------------------------------------------------
  // The first list is rendered by the server page. Re-fetching it on mount cost another five
  // transactions (viewer resolution + agent + list) before the chat was usable, so only a changed
  // search term triggers a request now. A response that a newer request has overtaken is dropped,
  // so typing "ab" can never be overwritten by the slower answer for "a".
  const listSeq = React.useRef(0);
  const loadList = React.useCallback(
    async (query: string, quiet: boolean) => {
      const seq = ++listSeq.current;
      const res = await searchConversationsAction(meta.key, query);
      if (seq !== listSeq.current) return;
      if (res.ok) {
        setConversations(res.data);
        setListState("idle");
      } else {
        // A failed background refresh keeps the list the person is already reading.
        setListState((s) => (quiet ? (s === "loading" ? "idle" : s) : "error"));
      }
    },
    [meta.key],
  );
  const skipInitialList = React.useRef(true);
  React.useEffect(() => {
    if (skipInitialList.current) {
      skipInitialList.current = false;
      if (!search) return;
    }
    const t = setTimeout(() => void loadList(search, false), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [search, loadList]);

  const refreshList = React.useCallback(() => loadList(search, true), [loadList, search]);
  const changeSearch = (q: string) => {
    setSearch(q);
    setListState("loading");
  };
  const retryList = () => {
    setListState("loading");
    void loadList(search, false);
  };

  const setUrl = (id: string | null) => {
    const url = id ? `/chat/${meta.slug}?c=${id}` : `/chat/${meta.slug}`;
    window.history.replaceState(null, "", url);
  };

  const selectConversation = async (id: string) => {
    setRailOpen(false);
    if (id === conversationId) return;
    if (streaming) return toast.info("Wait for the current answer to finish, or stop it first.");
    const res = await loadConversationAction(id);
    if (!res.ok) return toast.error(res.error);
    setConversationId(id);
    setMessages(res.data.messages as ChatMessage[]);
    setHasMore(Boolean(res.data.hasMore));
    setActivity(null);
    stickRef.current = true;
    setUrl(id);
    requestAnimationFrame(() => scrollToBottom(false));
  };

  const newChat = () => {
    setRailOpen(false);
    if (streaming) return toast.info("Wait for the current answer to finish, or stop it first.");
    setConversationId(null);
    setMessages([]);
    setHasMore(false);
    setActivity(null);
    setUrl(null);
    textareaRef.current?.focus();
  };

  const loadOlder = async () => {
    const first = messages[0];
    if (!conversationId || !first || loadingOlder || !hasMore) return;
    const el = scrollRef.current;
    const previousHeight = el?.scrollHeight ?? 0;
    const previousTop = el?.scrollTop ?? 0;
    setLoadingOlder(true);
    // A reader who is looking at older messages must not be pulled to the newest one when the page is prepended.
    stickRef.current = false;
    const res = await loadOlderMessagesAction(conversationId, first.created_at);
    setLoadingOlder(false);
    if (!res.ok) {
      stickRef.current = true;
      return toast.error(res.error);
    }
    setMessages((prev) => [...(res.data.messages as ChatMessage[]), ...prev]);
    setHasMore(res.data.hasMore);
    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight - previousHeight + previousTop;
    });
  };

  // --- streaming ------------------------------------------------------------
  const consume = React.useCallback(
    async (res: Response, placeholderUserId: string | null) => {
      let assistantId: string | null = null;
      try {
        for await (const ev of readEvents(res)) {
          switch (ev.type) {
            case "ready": {
              assistantId = ev.assistantMessageId;
              setStreaming({ runId: ev.runId, assistantId: ev.assistantMessageId });
              if (!conversationId || conversationId !== ev.conversationId) {
                setConversationId(ev.conversationId);
                setUrl(ev.conversationId);
              }
              setMessages((prev) => {
                const next = prev.map((m) => (placeholderUserId && m.id === placeholderUserId && ev.userMessageId ? { ...m, id: ev.userMessageId } : m));
                if (next.some((m) => m.id === ev.assistantMessageId)) return next;
                return [
                  ...next,
                  { id: ev.assistantMessageId, role: "assistant", content: "", status: "streaming", run_id: ev.runId, error_code: null, created_at: new Date().toISOString() },
                ];
              });
              break;
            }
            case "snapshot":
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: ev.content } : m)));
              break;
            case "delta":
              setActivity(null);
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + ev.text } : m)));
              break;
            case "activity":
              setActivity(ev.label);
              break;
            case "approval":
              toast(ev.title, { description: "Waiting for approval in the Approval Center.", action: { label: "Review", onClick: () => window.open("/approvals", "_self") } });
              break;
            case "done":
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: ev.content, status: "complete" } : m)));
              break;
            case "cancelled":
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: ev.content, status: "cancelled" } : m)));
              break;
            case "error":
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, status: "failed", error_code: ev.code } : m)));
              break;
          }
        }
      } catch {
        if (assistantId) setMessages((prev) => prev.map((m) => (m.id === assistantId && m.status === "streaming" ? { ...m, status: "failed", error_code: "connection_lost" } : m)));
      } finally {
        setStreaming(null);
        setActivity(null);
        void refreshList();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, refreshList],
  );

  const send = async (text: string, opts?: { regenerateMessageId?: string }) => {
    const content = text.trim();
    if ((!content && !opts?.regenerateMessageId) || streaming || !ready) return;
    stickRef.current = true;
    const clientMessageId = crypto.randomUUID();
    let placeholderId: string | null = null;
    if (!opts?.regenerateMessageId) {
      placeholderId = `local-${clientMessageId}`;
      setMessages((prev) => [...prev, { id: placeholderId!, role: "user", content, status: "complete", run_id: null, error_code: null, created_at: new Date().toISOString() }]);
      setInput("");
    } else {
      setMessages((prev) => prev.filter((m) => m.id !== opts.regenerateMessageId));
    }
    setStreaming({ runId: null, assistantId: null });
    let res: Response;
    try {
      res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: meta.key, conversationId, content: opts?.regenerateMessageId ? undefined : content, clientMessageId, regenerateMessageId: opts?.regenerateMessageId }),
      });
    } catch {
      setStreaming(null);
      toast.error("Network problem — your message wasn't sent.");
      if (placeholderId) setMessages((prev) => prev.filter((m) => m.id !== placeholderId));
      setInput(content);
      return;
    }
    if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
      const data = await res.json().catch(() => ({ error: "Something went wrong." }));
      setStreaming(null);
      if (placeholderId) setMessages((prev) => prev.filter((m) => m.id !== placeholderId));
      setInput(content);
      toast.error(data.error ?? "Something went wrong.");
      return;
    }
    await consume(res, placeholderId);
  };

  // Re-attach to a response that was still streaming when the page loaded.
  React.useEffect(() => {
    if (!props.activeRunId) return;
    const ctrl = new AbortController();
    fetch(`/api/chat/runs/${props.activeRunId}/stream`, { signal: ctrl.signal })
      .then((res) => (res.ok && res.headers.get("content-type")?.includes("text/event-stream") ? consume(res, null) : setStreaming(null)))
      .catch(() => setStreaming(null));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.activeRunId]);

  const stop = async () => {
    const runId = streaming?.runId;
    if (!runId) return;
    await fetch(`/api/chat/runs/${runId}/stop`, { method: "POST" }).catch(() => undefined);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  const changeLength = async (v: ReplyLength) => {
    const prev = replyLength;
    setReplyLength(v);
    const res = await setReplyLengthAction(meta.key, v);
    if (!res.ok) {
      setReplyLength(prev);
      toast.error(res.error);
    } else if (res.data.status === "pending_agency_review") {
      // The quick control changed a draft that contains sensitive changes. Nothing is active yet,
      // so show the active value again and send the person to the review status.
      setReplyLength(prev);
      toast.warning("Submitted for review", { description: "Your current reply length stays active until the whole configuration is approved." });
    } else if (res.data.version) {
      toast.success(`Replies will be ${v}`, { description: `Saved as configuration v${res.data.version}.` });
    }
  };

  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const awaitingFirstToken = Boolean(streaming) && !messages.some((m) => m.id === streaming?.assistantId && m.content);

  const activeTitle = conversationId
    ? (conversations.find((c) => c.id === conversationId)?.title ?? (props.initialConversation?.id === conversationId ? props.initialConversation.title : null))
    : null;
  const railProps = {
    role: meta.key,
    agentName: props.agentName,
    currentStatus: props.status,
    conversations,
    activeId: conversationId,
    search,
    listState,
    onSearch: changeSearch,
    onRetry: retryList,
    onSelect: selectConversation,
    onNew: newChat,
    onRename: (id: string) => setRenaming({ id, title: conversations.find((c) => c.id === id)?.title ?? "" }),
    onDelete: (id: string) => setDeleting(id),
    canManage: props.canConfigure,
    now,
    timeZone: props.timeZone,
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-surface">
      <aside className={cn("hidden shrink-0 border-r border-white/10 lg:block", compactRail ? "w-20" : "w-[280px]")}>
        <ChatRail {...railProps} compact={compactRail} onToggleCompact={toggleCompactRail} />
      </aside>
      <Sheet open={railOpen} onOpenChange={setRailOpen} side="left" title="Chat navigation" description="Switch AI specialist, open a conversation, or return to AI Employees." hideHeader className="!bg-[#0c101b]">
        <ChatRail {...railProps} idPrefix="conv-search-drawer" onNavigate={() => setRailOpen(false)} onClose={() => setRailOpen(false)} />
      </Sheet>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex min-h-20 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] sm:px-6" data-aqi-target="chat.employee">
          <button type="button" onClick={() => setRailOpen(true)} className="flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 lg:hidden" aria-label="Open chat navigation" aria-haspopup="dialog" aria-expanded={railOpen}>
            <MenuIcon className="size-5" />
          </button>
          <AgentAvatar role={meta} size="md" thinking={Boolean(streaming)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[17px] font-semibold tracking-tight text-ink" title={agentIdentityLabel(props.agentName, meta)}>{agentIdentityLabel(props.agentName, meta)}</h1>
              <span className="hidden rounded-md bg-surface-2 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted xl:inline">Private workspace</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-x-2">
              <StatusPill tone={statusMeta.tone} size="sm" className="shrink-0">{statusMeta.label}</StatusPill>
              <span className="min-w-0 truncate text-[12px] text-muted" title={activeTitle ?? undefined}>{activeTitle ?? "New conversation"}</span>
            </div>
            {ready && !readiness.inventoryAttestationCurrent && (
              <p className="mt-1 text-[10.5px] leading-tight text-muted">Runtime tools are reverified before a new message is saved.</p>
            )}
          </div>
          {props.canConfigure && ready && !props.hasPendingReview && (
            <Tooltip content="How much detail new replies use. Saved as a configuration change.">
              <div className="hidden xl:block">
                <Segmented
                  id="reply-length"
                  ariaLabel="Reply length"
                  size="sm"
                  value={replyLength}
                  onChange={changeLength}
                  options={[
                    { value: "concise", label: "Concise" },
                    { value: "balanced", label: "Balanced" },
                    { value: "detailed", label: "Detailed" },
                  ]}
                />
              </div>
            </Tooltip>
          )}
          {props.hasPendingReview && (
            <span className="hidden rounded-full border border-warning/25 bg-warning-soft/40 px-2.5 py-1 text-[11px] font-medium text-warning-ink xl:inline-flex">Configuration review pending</span>
          )}
          <Tooltip content="New chat">
            <Button variant="secondary" size="icon" onClick={newChat} aria-label="New chat">
              <Plus className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip content={`${props.agentName} profile`}>
            <ButtonLink href={targets.profile} prefetch={false} variant="ghost" size="icon" aria-label={`Open ${props.agentName} profile`} className="hidden sm:inline-flex">
              <UserRound className="size-4" />
            </ButtonLink>
          </Tooltip>
          {props.canConfigure && (
            <Tooltip content="Manage employee">
              <ButtonLink href={targets.manage} prefetch={false} variant="ghost" size="icon" aria-label="Manage employee" className="hidden sm:inline-flex">
                <Settings2 className="size-4" />
              </ButtonLink>
            </Tooltip>
          )}
        </header>

        {/* Messages */}
        <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text" aria-busy={Boolean(streaming)}>
          <div className="mx-auto w-full max-w-3xl px-4 pb-8 pt-8 sm:px-6">
            {messages.length === 0 ? (
              <EmptyState meta={meta} readiness={readiness} ready={ready} configured={props.configured} canConfigure={props.canConfigure} onPick={(p) => send(p)} />
            ) : (
              <ol className="space-y-6">
                {hasMore && (
                  <li className="flex justify-center">
                    <Button type="button" size="sm" variant="ghost" onClick={() => void loadOlder()} loading={loadingOlder} aria-label="Load earlier messages">
                      {!loadingOlder && <ArrowDown className="size-3.5 rotate-180" aria-hidden />} Load earlier messages
                    </Button>
                  </li>
                )}
                <AnimatePresence initial={false}>
                  {messages.map((m) => (
                    <motion.li
                      key={m.id}
                      layout="position"
                      initial={reduce ? false : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {m.role === "user" ? (
                        <UserBubble message={m} timeZone={props.timeZone} />
                      ) : (
                        <AssistantBubble
                          message={m}
                          meta={meta}
                          timeZone={props.timeZone}
                          isLast={m.id === lastAssistantId}
                          streaming={streaming?.assistantId === m.id}
                          activity={streaming?.assistantId === m.id ? activity : null}
                          canRetry={ready && !streaming}
                          onCopy={() => copy(m.content)}
                          onRegenerate={() => send("", { regenerateMessageId: m.id })}
                        />
                      )}
                    </motion.li>
                  ))}
                </AnimatePresence>
                {streaming && !streaming.assistantId && (
                  <li>
                    <div className="flex items-start gap-3">
                      <AgentAvatar role={meta} size="sm" thinking />
                      <div className="flex h-9 items-center gap-2 rounded-2xl border border-line bg-surface px-3.5 text-muted shadow-soft">
                        <ThinkingDots /> <span className="text-[12.5px]">Sending…</span>
                      </div>
                    </div>
                  </li>
                )}
              </ol>
            )}
          </div>
        </div>

        <AnimatePresence>
          {!atBottom && messages.length > 0 && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              onClick={() => {
                stickRef.current = true;
                scrollToBottom();
              }}
              className="absolute bottom-36 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-float hover:text-ink"
              aria-label="Scroll to latest message"
            >
              <ArrowDown className="size-4" />
            </motion.button>
          )}
        </AnimatePresence>

        {ready ? (
          <Composer
            value={input}
            onChange={setInput}
            onSend={() => send(input)}
            onStop={stop}
            streaming={Boolean(streaming)}
            canStop={Boolean(streaming?.runId)}
            disabled={false}
            textareaRef={textareaRef}
            placeholder={`Message ${props.agentName}…`}
            awaitingFirstToken={awaitingFirstToken}
          />
        ) : messages.length > 0 ? (
          <ChatUnavailableDock meta={meta} readiness={readiness} configured={props.configured} canConfigure={props.canConfigure} />
        ) : null}
      </main>

      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename conversation"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!renaming) return;
                const res = await renameConversationAction(renaming.id, renaming.title);
                if (!res.ok) return toast.error(res.error);
                setConversations((cs) => cs.map((c) => (c.id === renaming.id ? { ...c, title: renaming.title.trim() } : c)));
                setRenaming(null);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <label htmlFor="rename-input" className="sr-only">
          Conversation name
        </label>
        <Input id="rename-input" value={renaming?.title ?? ""} maxLength={120} onChange={(e) => setRenaming((r) => (r ? { ...r, title: e.target.value } : r))} autoFocus />
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this conversation?"
        description="The messages are removed for good. This can't be undone."
        size="sm"
        hideBodyWhenEmpty
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                const res = await deleteConversationAction(deleting);
                if (!res.ok) return toast.error(res.error);
                setConversations((cs) => cs.filter((c) => c.id !== deleting));
                if (deleting === conversationId) newChat();
                setDeleting(null);
                toast.success("Conversation deleted");
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

function EmptyState({ meta, readiness, ready, configured, canConfigure, onPick }: { meta: AgentRoleMeta; readiness: EmployeeReadiness; ready: boolean; configured: boolean; canConfigure: boolean; onPick: (p: string) => void }) {
  const reduce = useReducedMotion();
  const statusMeta = chatStatusMeta(readiness);
  const headline = { operations_manager: ["Turn priorities", "into a clear plan."], lead_hunter: ["Start with the right", "next customer."], appointment_setter: ["Make room for", "better conversations."], sales_assistant: ["Keep opportunities", "moving forward."], crm_manager: ["Give every customer", "a clearer story."], performance_analyst: ["See the signal", "behind the numbers."] }[meta.key];
  const title = ready ? null : readiness.title;
  const explanation = ready ? null : readiness.description;
  return (
    <div className="flex min-h-[52dvh] flex-col items-start justify-center py-6 text-left sm:py-10">
      <p className="mb-5 text-[10px] font-semibold uppercase tracking-[.18em] text-muted">Your dedicated {meta.shortName}</p>
      <div className="flex w-full items-center justify-between gap-5">
        <div className="min-w-0">
          <h2 className="max-w-md text-[28px] font-semibold leading-[1.08] tracking-[-.035em] text-ink sm:text-[38px]">
            {ready ? <>{headline[0]}<br /><span className="text-primary">{headline[1]}</span></> : title}
          </h2>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-muted">{ready ? `${meta.tagline} This conversation stays in your private company workspace.${readiness.inventoryAttestationCurrent ? "" : " The server rechecks runtime tools before saving your message."}` : explanation}</p>
        </div>
        <motion.div initial={reduce ? false : { scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }} className="relative shrink-0">
          <div aria-hidden className="pointer-events-none absolute inset-0 rounded-full blur-2xl" style={{ background: `${meta.accent}33` }} />
          <AgentAvatar role={meta} size="xl" className="relative" />
        </motion.div>
      </div>

      {ready ? (
        <div className="mt-8 grid w-full gap-2.5">
          {meta.suggestedPrompts.map((p, i) => (
            <motion.button
              key={p}
              type="button"
              onClick={() => onPick(p)}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.06 }}
              whileHover={reduce ? undefined : { y: -2 }}
              className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface-2/60 p-4 text-left text-[14px] leading-snug text-ink-2 transition-colors hover:border-primary/30 hover:bg-primary-soft/30 hover:text-ink"
            >
              <span className="flex items-center gap-3"><span className="font-mono text-[10px] text-muted">0{i + 1}</span>{p}</span><ArrowUpRight className="size-4 shrink-0 text-muted" />
            </motion.button>
          ))}
        </div>
      ) : (
        <div className="mt-8 w-full max-w-2xl rounded-3xl border border-line bg-surface-2/70 p-5 text-left shadow-soft">
          <div className="flex items-center justify-between gap-3">
            <StatusPill tone={statusMeta.tone} size="sm">{statusMeta.label}</StatusPill>
            <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-muted">Setup path</span>
          </div>
          <ol className="mt-4 space-y-2.5">
            {readiness.steps.map((step) => (
              <li key={step.label} className="flex items-start gap-3 rounded-xl border border-transparent px-2.5 py-2">
                {step.state === "done" ? <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />}
                <div><p className="text-[13px] font-medium text-ink">{step.label}</p><p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{step.description}</p></div>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            {canConfigure && <ButtonLink size="sm" variant="brand" href={`/employees/${meta.slug}?tab=configure`}>{configured ? "Review configuration" : "Complete setup"} <ArrowUpRight className="size-3.5" /></ButtonLink>}
            <ButtonLink size="sm" variant="secondary" href={`/employees/${meta.slug}`}>View employee</ButtonLink>
            <Button size="sm" variant="ghost" onClick={() => openHelp("human")}>Contact iAcquire</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatUnavailableDock({ meta, readiness, configured, canConfigure }: { meta: AgentRoleMeta; readiness: EmployeeReadiness; configured: boolean; canConfigure: boolean }) {
  const title = chatStatusMeta(readiness).label;
  const detail = readiness.description;
  return (
    <div className="shrink-0 bg-gradient-to-t from-surface via-surface to-transparent px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-2xl border border-line bg-surface-2/80 p-4 shadow-soft sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <AgentAvatar role={meta} size="sm" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink">{title}</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{detail}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canConfigure && <ButtonLink size="sm" variant="brand" href={`/employees/${meta.slug}?tab=configure`}>{configured ? "Review setup" : "Complete setup"}</ButtonLink>}
          <ButtonLink size="sm" variant="secondary" href={`/employees/${meta.slug}`}>View employee</ButtonLink>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ message, timeZone }: { message: ChatMessage; timeZone: string }) {
  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-primary to-[#4b54ff] px-4 py-2.5 text-[14.5px] leading-relaxed text-white shadow-[0_6px_20px_-10px_rgba(44,91,255,0.7)]">
        {message.content}
      </div>
      <time className="mt-1 pr-1 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100" dateTime={message.created_at}>
        {formatTime(message.created_at, timeZone)}
      </time>
    </div>
  );
}

function AssistantBubble({
  message,
  meta,
  timeZone,
  isLast,
  streaming,
  activity,
  canRetry,
  onCopy,
  onRegenerate,
}: {
  message: ChatMessage;
  meta: AgentRoleMeta;
  timeZone: string;
  isLast: boolean;
  streaming: boolean;
  activity: string | null;
  canRetry: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const thinking = streaming && !message.content;
  return (
    <div className="group flex items-start gap-3">
      <AgentAvatar role={meta} size="sm" thinking={streaming} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <AnimatePresence>
          {streaming && activity && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-2 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 shadow-soft"
              role="status"
            >
              {activity.startsWith("Waiting") ? <ShieldCheck className="size-3.5 text-warning" /> : <Wrench className="size-3.5 animate-pulse text-primary" />}
              {activity}
            </motion.div>
          )}
        </AnimatePresence>
        {thinking ? (
          <div className="flex h-9 items-center gap-2 text-muted" role="status">
            <ThinkingDots className="text-primary" />
            <span className="text-[13px]">Thinking</span>
          </div>
        ) : (
          <div className={cn("rounded-2xl px-1 py-2 text-ink", message.status === "failed" && "border border-danger/25 bg-danger-soft/30 px-4")}>
            {message.content ? <Markdown>{message.content}</Markdown> : message.status === "cancelled" ? <p className="text-[13.5px] italic text-muted">Stopped before a reply was written.</p> : null}
            {streaming && message.content && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-primary align-middle" aria-hidden />}
            {message.status === "failed" && (
              <div className={cn("flex items-start gap-2 text-[13px] text-danger-ink", message.content && "mt-3 border-t border-line pt-3")}>
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{ERROR_TEXT[message.error_code ?? ""] ?? "Something went wrong."} Review the recorded activity before retrying; a step that had already run may not have completed.</span>
              </div>
            )}
          </div>
        )}
        {!streaming && (
          <div className="mt-1.5 flex items-center gap-1 text-faint">
            {message.content && (
              <Tooltip content={copied ? "Copied" : "Copy"}>
                <button
                  type="button"
                  onClick={() => {
                    onCopy();
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="flex size-7 items-center justify-center rounded-lg hover:bg-surface-2 hover:text-ink"
                  aria-label="Copy response"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
              </Tooltip>
            )}
            {isLast && canRetry && (
              <Tooltip content={message.status === "failed" ? "Try again" : "Regenerate"}>
                <button type="button" onClick={onRegenerate} className="flex size-7 items-center justify-center rounded-lg hover:bg-surface-2 hover:text-ink" aria-label={message.status === "failed" ? "Try again" : "Regenerate response"}>
                  <RefreshCw className="size-3.5" />
                </button>
              </Tooltip>
            )}
            <time className="ml-1 text-[11px]" dateTime={message.created_at}>
              {formatTime(message.created_at, timeZone)}
            </time>
            {message.status === "cancelled" && <span className="ml-1 text-[11px]">· Stopped</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  canStop,
  disabled,
  disabledReason,
  textareaRef,
  placeholder,
  awaitingFirstToken,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  canStop: boolean;
  disabled: boolean;
  disabledReason?: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  awaitingFirstToken: boolean;
}) {
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [value, textareaRef]);

  return (
    <div className="shrink-0 bg-gradient-to-t from-surface via-surface to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-5" data-aqi-target="chat.composer">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            "rounded-[22px] border bg-surface-2/60 p-2 shadow-[0_6px_24px_-12px_rgba(20,30,60,.2)] transition",
            disabled ? "border-line opacity-80" : "border-line-strong focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10",
          )}
        >
          <label htmlFor="chat-input" className="sr-only">
            {placeholder}
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            maxLength={8000}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!streaming) onSend();
              }
            }}
            placeholder={disabled ? disabledReason : placeholder}
            className="block max-h-[200px] w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed"
          />
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <Tooltip content="Attachments aren't supported by AI employees yet">
              <span>
                <button type="button" disabled className="flex size-9 items-center justify-center rounded-xl text-faint" aria-label="Attach a file (not available)">
                  <Paperclip className="size-4" />
                </button>
              </span>
            </Tooltip>
            <div className="flex items-center gap-2">
              <span className="hidden text-[11.5px] text-faint sm:inline">{disabled?"Chat is unavailable until the employee is ready":awaitingFirstToken ? "Waiting for the first words…" : "Enter to send · Shift+Enter for a new line"}</span>
              {streaming ? (
                <Button type="button" size="icon" variant="secondary" onClick={onStop} disabled={!canStop} aria-label="Stop generating" className="rounded-xl">
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button type="button" size="icon" variant="brand" onClick={onSend} disabled={disabled || !value.trim()} aria-label="Send message" className="rounded-xl">
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-faint">AI employees can make mistakes. Customer-facing actions always need your approval.</p>
      </div>
    </div>
  );
}
