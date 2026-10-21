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
  ShieldCheck,
  Square,
  Wrench,
} from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { StatusPill, toneDotClass } from "@/components/ui/status";
import { Markdown } from "@/components/markdown";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog, Sheet, Tooltip } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { ChatRail, type ConversationItem, type ListState } from "@/components/chat/chat-rail";
import { EmployeeChatInfo } from "@/components/chat/employee-chat-info";
import { openHelp } from "@/components/help/help-widget";
import {
  deleteConversationAction,
  loadConversationAction,
  loadOlderMessagesAction,
  renameConversationAction,
  searchConversationsAction,
} from "@/app/actions/chat";
import { type AgentRoleMeta, type AgentStatus } from "@/lib/agents";
import { deriveEmployeeReadiness, type EmployeeReadiness } from "@/lib/workforce-readiness";
import { chatNavTargets } from "@/lib/chat-navigation";
import { operationsManagerRuntimeNotice } from "@/lib/operations-manager-runtime";
import { detectBrowserTimeZone, resolveChatTimeZone } from "@/lib/chat-timezone";
import { chatDateSeparatorLabel, conversationDateKey, formatChatTime } from "@/lib/conversation-time";
import { WorkJobPanel } from "@/components/work/job-progress";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "notice";
  content: string;
  status: "streaming" | "complete" | "failed" | "cancelled" | "superseded";
  run_id: string | null;
  work_job_id: string | null;
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
  canConfigure: boolean;
  configured: boolean;
  hasPendingReview: boolean;
  initialConversations: ConversationItem[];
  initialConversation: { id: string; title: string; messages: ChatMessage[]; hasMore?: boolean } | null;
  activeRunId: string | null;
  preferredTimeZone: string | null;
  /** The kind of workspace the viewer is in (client or agency), so "back" and "home" go to the right place. */
  orgKind: string;
  /** The server's clock at render time, so grouped dates and relative times hydrate identically. */
  nowIso: string;
  /** Pre-filled composer text (e.g. from "Ask Performance Analyst"). Never auto-sent. */
  initialInput?: string;
}

function subscribeToTimeZoneChanges(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

const serverBrowserTimeZone = () => null;

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
  const operationsNotice = operationsManagerRuntimeNotice(meta.key, props.orgKind);
  const reduce = useReducedMotion();
  const now = useNow(props.nowIso);
  // useSyncExternalStore gives server rendering and hydration the same fallback before reading the browser zone.
  const browserTimeZone = React.useSyncExternalStore(subscribeToTimeZoneChanges, detectBrowserTimeZone, serverBrowserTimeZone);
  const timeZone = resolveChatTimeZone(props.preferredTimeZone, browserTimeZone);
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
    [meta.key, setConversations],
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
                  { id: ev.assistantMessageId, role: "assistant", content: "", status: "streaming", run_id: ev.runId, work_job_id: null, error_code: null, created_at: new Date().toISOString() },
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
      setMessages((prev) => [...prev, { id: placeholderId!, role: "user", content, status: "complete", run_id: null, work_job_id: null, error_code: null, created_at: new Date().toISOString() }]);
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
    if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
      // The Lead Hunter accepted a durable research job (or asked one focused question). Reload
      // the persisted turn so the message and its work panel are server-backed, not optimistic.
      const data = (await res.json().catch(() => null)) as { conversationId?: string; error?: string } | null;
      setStreaming(null);
      if (!data?.conversationId) {
        if (placeholderId) setMessages((prev) => prev.filter((m) => m.id !== placeholderId));
        setInput(content);
        toast.error(data?.error ?? "Something went wrong.");
        return;
      }
      setConversationId(data.conversationId);
      const loaded = await loadConversationAction(data.conversationId);
      if (loaded.ok) setMessages(loaded.data.messages as ChatMessage[]);
      if (typeof window !== "undefined") window.history.replaceState(null, "", `/chat/${meta.slug}?c=${data.conversationId}`);
      void refreshList();
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

  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const awaitingFirstToken = Boolean(streaming) && !messages.some((m) => m.id === streaming?.assistantId && m.content);

  const employeeName = props.agentName.trim() || meta.shortName;
  const showRole = !employeeName.toLowerCase().endsWith(meta.shortName.toLowerCase());
  const headerStatus = readiness.stage === "ready" ? "Ready"
    : readiness.stage === "working" ? "Working"
    : readiness.stage === "approval" ? "Awaiting approval"
    : readiness.stage === "attention" ? "Needs attention"
    : readiness.stage === "connection" ? "Check connection"
    : readiness.stage === "inventory" || readiness.stage === "identity" ? "Verification required"
    : readiness.label;
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
    timeZone,
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
        <header aria-label="Employee chat" className="shrink-0 border-b border-line/80 bg-surface px-3 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] sm:px-6" data-aqi-target="chat.employee">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-2 sm:gap-3">
            <button type="button" onClick={() => setRailOpen(true)} className="flex size-10 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary lg:hidden" aria-label="Open chat navigation" aria-haspopup="dialog" aria-expanded={railOpen}>
              <MenuIcon className="size-5" />
            </button>
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2/70 sm:size-11">
              <AgentAvatar role={meta} size="md" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink sm:text-[17px]" title={employeeName}>{employeeName}</h1>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] text-muted">
                {showRole && <span className="hidden min-w-0 truncate sm:inline" title={meta.shortName}>{meta.shortName}</span>}
                {showRole && <span className="hidden text-faint sm:inline" aria-hidden>·</span>}
                <span role="status" aria-live="polite" aria-label={readiness.label} title={readiness.label} className="inline-flex min-w-0 items-center gap-1.5">
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDotClass(statusMeta.tone))} />
                  <span className="truncate">{headerStatus}</span>
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <Tooltip content="New chat">
                <Button variant="ghost" size="icon" onClick={newChat} aria-label="New chat" className="size-10 shadow-none">
                  <Plus className="size-4" />
                </Button>
              </Tooltip>
              <EmployeeChatInfo agentName={employeeName} roleTitle={meta.shortName} readiness={readiness} operationsSnapshot={Boolean(operationsNotice)} hasPendingReview={props.hasPendingReview} canConfigure={props.canConfigure} profileHref={targets.profile} manageHref={targets.manage} />
            </div>
          </div>
        </header>

        {/* Messages */}
        <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text" aria-busy={Boolean(streaming)}>
          <div className="mx-auto w-full max-w-4xl px-4 pb-10 pt-7 sm:px-6 sm:pt-9">
            {messages.length === 0 ? (
              <EmptyState meta={meta} readiness={readiness} ready={ready} configured={props.configured} canConfigure={props.canConfigure} onPick={(p) => send(p)} />
            ) : (
              <ol className="space-y-7">
                {hasMore && (
                  <li className="flex justify-center">
                    <Button type="button" size="sm" variant="ghost" onClick={() => void loadOlder()} loading={loadingOlder} aria-label="Load earlier messages">
                      {!loadingOlder && <ArrowDown className="size-3.5 rotate-180" aria-hidden />} Load earlier messages
                    </Button>
                  </li>
                )}
                <AnimatePresence initial={false}>
                  {messages.map((m, index) => {
                    const currentDay = conversationDateKey(m.created_at, timeZone);
                    const previousDay = index > 0 ? conversationDateKey(messages[index - 1].created_at, timeZone) : null;
                    const dayLabel = currentDay && currentDay !== previousDay ? chatDateSeparatorLabel(m.created_at, now, timeZone) : "";
                    return (
                      <motion.li
                        key={m.id}
                        layout="position"
                        initial={reduce ? false : { opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {dayLabel && <div role="separator" aria-label={dayLabel} className="-mt-1 mb-1 flex items-center gap-3 text-[11px] text-faint"><span className="h-px flex-1 bg-line" /><span>{dayLabel}</span><span className="h-px flex-1 bg-line" /></div>}
                        {m.role === "user" ? (
                          <UserBubble message={m} timeZone={timeZone} />
                        ) : (
                          <AssistantBubble
                            message={m}
                            meta={meta}
                            agentName={props.agentName}
                            snapshotReview={Boolean(operationsNotice)}
                            timeZone={timeZone}
                            isLast={m.id === lastAssistantId}
                            streaming={streaming?.assistantId === m.id}
                            activity={streaming?.assistantId === m.id ? activity : null}
                            canRetry={ready && !streaming}
                            onCopy={() => copy(m.content)}
                            onRegenerate={() => send("", { regenerateMessageId: m.id })}
                          />
                        )}
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
                {streaming && !streaming.assistantId && (
                  <li>
                    <AssistantLoadingState meta={meta} agentName={props.agentName} snapshotReview={Boolean(operationsNotice)} phase="preflight" />
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
            operationsReadOnly={Boolean(operationsNotice)}
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
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-muted">{ready ? meta.tagline : explanation}</p>
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
      <div className="max-w-[min(88%,44rem)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-3 text-[14.5px] leading-relaxed text-white shadow-[0_8px_22px_-16px_rgba(44,91,255,.72)] sm:px-5">
        {message.content}
      </div>
      <time className="mt-1.5 pr-1 text-[11px] tabular-nums text-faint transition-colors group-hover:text-muted" dateTime={message.created_at}>
        {formatChatTime(message.created_at, timeZone)}
      </time>
    </div>
  );
}

function AssistantBubble({
  message,
  meta,
  agentName,
  snapshotReview,
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
  agentName: string;
  snapshotReview: boolean;
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
    <div className="group flex items-start gap-3 sm:gap-3.5">
      {!thinking && <span className="mt-1 grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2/70 shadow-[inset_0_1px_0_rgb(255_255_255/.7)]"><AgentAvatar role={meta} size="sm" /></span>}
      <div className="min-w-0 flex-1">
        <AnimatePresence>
          {streaming && activity && !thinking && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-2 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 shadow-soft"
              role="status"
            >
              {activity.startsWith("Waiting") ? <ShieldCheck className="size-3.5 shrink-0 text-warning" /> : <Wrench className="size-3.5 shrink-0 text-primary" />}
              <span className="truncate">{activity}</span>
            </motion.div>
          )}
        </AnimatePresence>
        {thinking ? (
          <AssistantLoadingState
            meta={meta}
            agentName={agentName}
            snapshotReview={snapshotReview}
            phase={activity ? activity.startsWith("Waiting") ? "waiting" : "active" : "starting"}
            activity={activity}
          />
        ) : (
          <div className={cn("rounded-2xl border border-line/80 bg-surface px-4 py-3 text-ink shadow-[0_5px_20px_-17px_rgb(20_30_60/.3)] sm:px-5 sm:py-4", message.status === "failed" && "border-danger/25 bg-danger-soft/30 shadow-none")}>
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
        {message.work_job_id && <WorkJobPanel jobId={message.work_job_id} className="mt-2" compact />}
        {!streaming && (
          <div className="mt-2 flex min-h-7 items-center gap-1 text-faint">
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
            <time className="ml-1 text-[11px] tabular-nums" dateTime={message.created_at}>
              {formatChatTime(message.created_at, timeZone)}
            </time>
            {message.status === "cancelled" && <span className="ml-1 text-[11px]">· Stopped</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantLoadingState({ meta, agentName, snapshotReview, phase, activity }: { meta: AgentRoleMeta; agentName: string; snapshotReview: boolean; phase: "preflight" | "starting" | "active" | "waiting"; activity?: string | null }) {
  const reduce = useReducedMotion();
  const statusLabel = phase === "preflight"
    ? "Verifying access before the run starts…"
    : phase === "starting"
      ? "Starting the authorized response…"
      : phase === "waiting"
        ? activity ?? "Waiting for a response…"
        : snapshotReview ? `${agentName} is reviewing your workspace snapshot…` : `${agentName} is responding…`;
  const detailLabel = phase === "preflight"
    ? "Your message is checked before it is saved"
    : phase === "starting"
      ? "Preparing the response"
      : phase === "waiting"
        ? "The run is waiting for its next step"
        : activity ?? "Using authorized context";
  return (
    <div className="flex min-h-[76px] w-full max-w-2xl items-center gap-3 rounded-2xl border border-line/80 bg-surface px-3.5 py-3 shadow-[0_5px_20px_-17px_rgb(20_30_60/.3)] sm:px-4" role="status" aria-live="polite" aria-busy="true">
      <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl border border-primary/10 bg-primary/[.035]">
        {!reduce && <motion.span aria-hidden className="absolute inset-0 rounded-xl bg-primary/[.06]" animate={{ opacity: [0.3, 0.8, 0.3] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }} />}
        <AgentAvatar role={meta} size="sm" className="relative" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-snug text-ink">{statusLabel}</p>
        <p className="mt-1 truncate text-[11.5px] leading-snug text-muted">{detailLabel}</p>
      </div>
      <span className="flex shrink-0 items-center gap-1.5 px-1" aria-hidden>
        {[0, 1, 2].map((index) => (
          <motion.span
            key={index}
            className="size-1.5 rounded-full bg-primary/70"
            animate={reduce ? { opacity: 0.65 } : { opacity: [0.25, 0.9, 0.25], y: [0, -1, 0] }}
            transition={reduce ? { duration: 0 } : { duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: index * 0.16 }}
          />
        ))}
      </span>
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
  operationsReadOnly,
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
  operationsReadOnly: boolean;
}) {
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [value, textareaRef]);

  return (
    <div className="shrink-0 border-t border-line/70 bg-surface/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:px-6 sm:pb-5" data-aqi-target="chat.composer">
      <div className="mx-auto w-full max-w-4xl">
        <div
          className={cn(
            "rounded-[22px] border bg-surface p-2 shadow-[0_8px_26px_-18px_rgba(20,30,60,.28)] transition-[border-color,box-shadow,background-color] duration-200",
            disabled ? "border-line opacity-80" : "border-line-strong/80 focus-within:border-primary/55 focus-within:ring-4 focus-within:ring-primary/10 focus-within:shadow-[0_10px_30px_-18px_rgba(44,91,255,.32)]",
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
            className="block max-h-[200px] w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed"
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
        <p className="mt-2 text-center text-[11px] text-faint">
          {operationsReadOnly ? "Read-only chat. No records are changed and no messages are sent externally." : "AI employees can make mistakes. Customer-facing actions always need your approval."}
        </p>
      </div>
    </div>
  );
}
