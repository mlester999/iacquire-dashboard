"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronLeft,
  Copy,
  History,
  LifeBuoy,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { LogoMark } from "@/components/brand";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { cn, relativeTime } from "@/lib/utils";

interface Bootstrap {
  config: { identity: string; description: string; greeting: string; tone: string };
  suggestions: Array<{ id: string; question: string }>;
  page: { path: string; label: string; description: string } | null;
  allowedPaths: string[];
  health: { available: boolean; provider: string | null; model: string | null; detail: string };
}

interface Conversation {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  feedbackRating: number | null;
  feedbackComment: string | null;
  createdAt: string;
  sources?: Array<{ id: string; title: string; category: string }>;
  citationWarning?: string | null;
}

type View = "chat" | "history";

function internalLinksAllowed(content: string, allowedPaths: string[]) {
  return content.replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (whole, label: string, href: string) => {
    const allowed = allowedPaths.some((path) => href === path || href.startsWith(`${path}/`));
    return allowed ? whole : label;
  });
}

function parseSseBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function AqiWidget({ raised = false }: { raised?: boolean }) {
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const [open, setOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [view, setView] = React.useState<View>("chat");
  const [bootstrap, setBootstrap] = React.useState<Bootstrap | null>(null);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [historySearch, setHistorySearch] = React.useState("");
  const [renaming, setRenaming] = React.useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [olderLoading, setOlderLoading] = React.useState(false);
  const [feedbackFor, setFeedbackFor] = React.useState<{ id: string; rating: 1 | -1 } | null>(null);
  const [feedbackText, setFeedbackText] = React.useState("");
  const [supportOpen, setSupportOpen] = React.useState(false);
  const [supportSubject, setSupportSubject] = React.useState("");
  const [supportConsent, setSupportConsent] = React.useState(false);
  const [supportBusy, setSupportBusy] = React.useState(false);
  const [supportError, setSupportError] = React.useState<string | null>(null);
  const [supportResult, setSupportResult] = React.useState<{ id: string; ref: string; existing: boolean } | null>(null);
  const [closeConfirm, setCloseConfirm] = React.useState(false);
  const [newSession, setNewSession] = React.useState(false);
  const [loadingConversation, setLoadingConversation] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const nearBottom = React.useRef(true);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const meaningful = newSession && messages.filter((message) => message.role === "user").length >= 2;

  const loadBootstrap = React.useCallback(async () => {
    const res = await fetch(`/api/aqi/bootstrap?path=${encodeURIComponent(pathname ?? "")}`, { cache: "no-store" });
    const data = (await res.json()) as Bootstrap & { error?: string };
    if (res.ok) setBootstrap(data);
  }, [pathname]);

  const loadConversations = React.useCallback(async () => {
    const res = await fetch("/api/aqi/conversations", { cache: "no-store" });
    const data = (await res.json()) as { conversations?: Conversation[] };
    if (res.ok && data.conversations) setConversations(data.conversations);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    // Fetching external bootstrap/history is the effect's purpose; state updates happen after the requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBootstrap();
    void loadConversations();
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [open, loadBootstrap, loadConversations]);

  React.useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBootstrap();
  }, [pathname, open, loadBootstrap]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (closeConfirm) setCloseConfirm(false);
        else if (supportOpen) setSupportOpen(false);
        else requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  React.useEffect(() => {
    if (nearBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function requestClose() {
    if (meaningful) setCloseConfirm(true);
    else {
      setOpen(false);
      launcherRef.current?.focus();
    }
  }

  function closeNow() {
    setOpen(false);
    setCloseConfirm(false);
    launcherRef.current?.focus();
  }

  async function discardAndClose() {
    if (conversationId) await fetch(`/api/aqi/conversations/${conversationId}`, { method: "DELETE" }).catch(() => null);
    setConversationId(null);
    setMessages([]);
    setNewSession(false);
    closeNow();
    void loadConversations();
  }

  function startNew() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setConversationId(null);
    setMessages([]);
    setError(null);
    setHasMore(false);
    setNewSession(false);
    setView("chat");
    setInput("");
    window.setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function loadOlder() {
    if (!conversationId || !hasMore || olderLoading || !messages[0]) return;
    setOlderLoading(true);
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    try {
      const res = await fetch(`/api/aqi/conversations/${conversationId}?before=${encodeURIComponent(messages[0].createdAt)}`, { cache: "no-store" });
      const data = (await res.json()) as { messages?: Message[]; hasMore?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Earlier messages could not be loaded.");
      setMessages((current) => [...(data.messages ?? []), ...current]);
      setHasMore(Boolean(data.hasMore));
      window.requestAnimationFrame(() => {
        if (element) element.scrollTop += element.scrollHeight - previousHeight;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Earlier messages could not be loaded.");
    } finally {
      setOlderLoading(false);
    }
  }

  async function openConversation(id: string) {
    setLoadingConversation(true);
    setError(null);
    try {
      const res = await fetch(`/api/aqi/conversations/${id}`, { cache: "no-store" });
      const data = (await res.json()) as { conversation?: Conversation; messages?: Message[]; hasMore?: boolean; error?: string };
      if (!res.ok || !data.conversation) throw new Error(data.error ?? "That conversation could not be opened.");
      setConversationId(data.conversation.id);
      setMessages(data.messages ?? []);
      setHasMore(Boolean(data.hasMore));
      setNewSession(false);
      setView("chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That conversation could not be opened.");
    } finally {
      setLoadingConversation(false);
    }
  }

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || streaming) return;
    if (bootstrap && !bootstrap.health.available) {
      setError(bootstrap.health.detail);
      return;
    }
    setError(null);
    setInput("");
    let id = conversationId;
    setStreaming(true);
    const userMessage: Message = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: clean,
      status: "complete",
      feedbackRating: null,
      feedbackComment: null,
      createdAt: new Date().toISOString(),
    };
    const assistantMessage: Message = {
      id: `local-assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      status: "streaming",
      feedbackRating: null,
      feedbackComment: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    nearBottom.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (!id) {
        const res = await fetch("/api/aqi/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: pathname }),
        });
        const data = (await res.json()) as { conversation?: Conversation; error?: string };
        if (!res.ok || !data.conversation) throw new Error(data.error ?? "AQi could not start a conversation.");
        id = data.conversation.id;
        setConversationId(id);
        setNewSession(true);
      }
      const res = await fetch("/api/aqi/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: id, message: clean, path: pathname }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "AQi could not answer right now.");
      }
      if (!res.body) throw new Error("AQi returned an empty response.");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = parseSseBlock(block);
          if (!event) continue;
          if (event.type === "meta") {
            setConversationId(String(event.conversationId));
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id ? { ...message, id: String(event.messageId) } : message)));
          } else if (event.type === "delta") {
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id || message.status === "streaming" ? { ...message, content: message.content + String(event.text) } : message)));
          } else if (event.type === "done") {
            const saved = { ...(event.message as Message), sources: Array.isArray(event.sources) ? (event.sources as Message["sources"]) : undefined };
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id || message.status === "streaming" ? saved : message)));
            setStreaming(false);
            void loadConversations();
          } else if (event.type === "error") {
            throw new Error(String(event.message));
          }
        }
      }
      setStreaming(false);
    } catch (err) {
      const aborted = controller.signal.aborted;
      setStreaming(false);
      setMessages((current) => current.map((message) => (message.status === "streaming" ? { ...message, status: aborted ? "cancelled" : "failed" } : message)));
      if (!aborted) setError(err instanceof Error ? err.message : "AQi could not answer right now.");
    } finally {
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages((current) => current.map((message) => (message.status === "streaming" ? { ...message, status: "cancelled" } : message)));
  }

  function retry() {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    setMessages((current) => {
      const copy = [...current];
      while (copy.length && copy[copy.length - 1].role === "assistant" && copy[copy.length - 1].status !== "complete") copy.pop();
      return copy;
    });
    void send(lastUser.content);
  }

  async function feedback(message: Message, rating: 1 | -1, comment?: string) {
    setMessages((current) => current.map((item) => (item.id === message.id ? { ...item, feedbackRating: rating } : item)));
    const res = await fetch("/api/aqi/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: message.id, rating, comment: comment?.trim() || undefined }),
    });
    if (!res.ok) setError("Your feedback could not be saved. Please try again.");
  }

  async function createSupportRequest() {
    if (!conversationId || !supportConsent) return;
    setSupportBusy(true);
    setSupportError(null);
    try {
      const res = await fetch("/api/aqi/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, subject: supportSubject, consent: true }),
      });
      const data = (await res.json().catch(() => null)) as { id?: string; ref?: string; existing?: boolean; error?: string } | null;
      if (!res.ok || !data?.id || !data.ref) throw new Error(data?.error ?? "The support request could not be created.");
      setSupportResult({ id: data.id, ref: data.ref, existing: Boolean(data.existing) });
    } catch (err) {
      setSupportError(err instanceof Error ? err.message : "The support request could not be created.");
    } finally {
      setSupportBusy(false);
    }
  }

  async function rename() {
    if (!renaming) return;
    const res = await fetch(`/api/aqi/conversations/${renaming.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: renaming.title }),
    });
    if (!res.ok) setError("That name could not be saved.");
    else {
      setRenaming(null);
      void loadConversations();
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/aqi/conversations/${id}`, { method: "DELETE" });
    if (!res.ok) setError("That conversation could not be deleted.");
    else {
      setDeleting(null);
      if (conversationId === id) startNew();
      void loadConversations();
    }
  }

  const visibleConversations = conversations.filter((conversation) => conversation.title.toLowerCase().includes(historySearch.toLowerCase()));
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const canRetry = Boolean(lastAssistant && (lastAssistant.status === "failed" || lastAssistant.status === "cancelled") && !streaming);

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            ref={launcherRef}
            type="button"
            onClick={() => setOpen(true)}
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.7, opacity: 0 }}
            whileHover={reduced ? undefined : { y: -2, scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 24 }}
            className="fixed z-40 flex h-14 items-center gap-2 rounded-2xl brand-gradient px-3.5 text-white shadow-[0_14px_40px_-10px_rgba(44,91,255,0.65)] ring-1 ring-white/20"
            style={{
              right: "max(16px, env(safe-area-inset-right))",
              bottom: raised ? "calc(max(14px, env(safe-area-inset-bottom)) + 150px)" : "max(16px, env(safe-area-inset-bottom))",
            }}
            aria-label="Open AQi, the iAcquireOS assistant"
          >
            <span className="grid size-8 place-items-center rounded-xl bg-white/15"><Sparkles className="size-4" /></span>
            <span className="text-[13px] font-semibold tracking-tight">AQi</span>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] sm:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={requestClose}
              aria-hidden
            />
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="AQi, the iAcquireOS assistant"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              className={cn(
                "fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-float",
                "inset-x-0 bottom-0 h-[92dvh] rounded-t-3xl sm:inset-auto sm:bottom-5 sm:right-5 sm:rounded-3xl",
                expanded ? "sm:h-[min(780px,calc(100dvh-40px))] sm:w-[min(760px,calc(100vw-40px))]" : "sm:h-[min(680px,calc(100dvh-40px))] sm:w-[410px]",
              )}
            >
              <header className="relative shrink-0 overflow-hidden border-b border-line bg-surface">
                <div aria-hidden className="absolute inset-0 opacity-90" style={{ background: "radial-gradient(420px 170px at 0% 0%, rgba(44,91,255,0.16), transparent 70%), radial-gradient(320px 160px at 100% 0%, rgba(139,92,255,0.14), transparent 70%)" }} />
                <div className="relative flex items-center gap-3 px-4 pb-3 pt-4">
                  {view === "history" ? (
                    <button type="button" onClick={() => setView("chat")} className="flex size-9 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2" aria-label="Back to AQi chat"><ArrowLeft className="size-4" /></button>
                  ) : (
                    <span className="grid size-9 place-items-center rounded-xl brand-gradient text-white"><LogoMark className="size-5" /></span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-ink">{view === "history" ? "Conversations" : "AQi"} {view === "chat" && <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-primary-ink">Platform guide</span>}</p>
                    <p className="truncate text-[12px] text-muted">{view === "history" ? "Your private AQi history" : bootstrap?.page ? `Helping with ${bootstrap.page.label}` : "Help with iAcquireOS"}</p>
                  </div>
                  {view === "chat" && (
                    <>
                      <button type="button" onClick={() => setView("history")} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Conversation history"><History className="size-4" /></button>
                      <button type="button" onClick={() => setExpanded((value) => !value)} className="hidden size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink sm:flex" aria-label={expanded ? "Collapse AQi" : "Expand AQi"}>{expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
                    </>
                  )}
                  <button type="button" onClick={requestClose} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close AQi"><X className="size-4" /></button>
                </div>
              </header>

              {view === "history" ? (
                <HistoryView
                  conversations={visibleConversations}
                  search={historySearch}
                  setSearch={setHistorySearch}
                  renaming={renaming}
                  setRenaming={setRenaming}
                  deleting={deleting}
                  setDeleting={setDeleting}
                  loading={loadingConversation}
                  onOpen={(id) => void openConversation(id)}
                  onRename={() => void rename()}
                  onDelete={(id) => void remove(id)}
                  onNew={startNew}
                />
              ) : (
                <>
                  <div ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                    {messages.length === 0 ? (
                      <div className="space-y-4">
                        <div className="rounded-2xl border border-line bg-surface-2/60 p-4">
                          <p className="text-[13.5px] leading-relaxed text-ink">{bootstrap?.config.greeting ?? "Hi, I'm AQi. What can I help you with?"}</p>
                          <p className="mt-2 text-[12px] leading-relaxed text-muted">I explain iAcquireOS, help you find the right page and tell you honestly when something is unavailable. I can&apos;t change settings or act on your behalf.</p>
                        </div>
                        {bootstrap && !bootstrap.health.available && (
                          <div className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft p-3 text-[12px] text-warning-ink"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{bootstrap.health.detail}</span></div>
                        )}
                        <div>
                          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Try asking</p>
                          <div className="grid gap-2">
                            {(bootstrap?.suggestions ?? []).map((suggestion) => (
                              <button key={suggestion.id} type="button" onClick={() => void send(suggestion.question)} disabled={!bootstrap?.health.available} className="rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[12.5px] leading-snug text-ink-2 transition hover:border-line-strong hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50">
                                {suggestion.question}
                              </button>
                            ))}
                          </div>
                        </div>
                        <p className="text-center text-[11.5px] text-muted">Still stuck? <button type="button" onClick={() => { setSupportOpen(true); setSupportError(null); setSupportResult(null); }} className="font-medium text-primary hover:underline">Get help from iAcquire</button> or <Link href="/support" className="font-medium text-primary hover:underline">open Support</Link>.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {hasMore && (
                          <div className="flex justify-center pb-1">
                            <Button type="button" variant="ghost" size="sm" loading={olderLoading} onClick={() => void loadOlder()}>
                              Load earlier messages
                            </Button>
                          </div>
                        )}
                        {messages.map((message) => (
                          <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                            <div className={cn("max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed", message.role === "user" ? "bg-primary text-white" : "border border-line bg-surface text-ink")}>
                              {message.role === "assistant" ? (
                                <>
                                  {message.content ? <Markdown>{internalLinksAllowed(message.content, bootstrap?.allowedPaths ?? [])}</Markdown> : <span className="flex items-center gap-1.5 text-muted"><span className="size-1.5 animate-pulse rounded-full bg-primary" /><span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:120ms]" /><span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:240ms]" /><span className="ml-1">Thinking…</span></span>}
                                  {message.status === "streaming" && message.content && <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-primary align-middle" aria-label="AQi is writing" />}
                                  {message.status !== "streaming" && message.content && (
                                    <div className="mt-2 flex items-center gap-0.5 border-t border-line/70 pt-1.5">
                                      <button type="button" onClick={() => void navigator.clipboard.writeText(message.content)} className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" aria-label="Copy answer"><Copy className="size-3.5" /></button>
                                      <button type="button" onClick={() => { setFeedbackFor(null); void feedback(message, 1); }} className={cn("flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink", message.feedbackRating === 1 && "text-success-ink")} aria-label="Helpful" aria-pressed={message.feedbackRating === 1}><ThumbsUp className="size-3.5" /></button>
                                      <button type="button" onClick={() => { setFeedbackFor({ id: message.id, rating: -1 }); setFeedbackText(""); void feedback(message, -1); }} className={cn("flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink", message.feedbackRating === -1 && "text-danger-ink")} aria-label="Not helpful" aria-pressed={message.feedbackRating === -1}><ThumbsDown className="size-3.5" /></button>
                                      {message.feedbackRating && <span className="ml-1 text-[10.5px] text-muted">Thanks</span>}
                                    </div>
                                  )}
                                  {message.sources?.length ? (
                                    <div className="mt-2 border-t border-line/70 pt-1.5">
                                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Sources</p>
                                      <ul className="mt-1 space-y-0.5">
                                        {message.sources.slice(0, 5).map((source) => <li key={source.id} className="text-[10.5px] leading-snug text-muted">{source.title} <span className="text-faint">· {source.category}</span></li>)}
                                      </ul>
                                    </div>
                                  ) : null}
                                  {message.citationWarning && <p className="mt-1.5 text-[10.5px] leading-snug text-warning-ink">{message.citationWarning}</p>}
                                  {feedbackFor?.id === message.id && feedbackFor.rating === -1 && (
                                    <div className="mt-2 space-y-1.5 border-t border-line/70 pt-2">
                                      <Textarea
                                        rows={2}
                                        maxLength={1000}
                                        value={feedbackText}
                                        onChange={(event) => setFeedbackText(event.target.value)}
                                        placeholder="What was wrong? (optional)"
                                        aria-label="Feedback about this answer"
                                        className="min-h-14 text-[12px]"
                                      />
                                      <div className="flex gap-1.5">
                                        <Button type="button" size="sm" variant="secondary" onClick={() => { void feedback(message, -1, feedbackText); setFeedbackFor(null); }}>Send feedback</Button>
                                        <Button type="button" size="sm" variant="ghost" onClick={() => setFeedbackFor(null)}>Cancel</Button>
                                      </div>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <p className="whitespace-pre-wrap">{message.content}</p>
                              )}
                            </div>
                          </div>
                        ))}
                        {error && (
                          <div className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft p-3 text-[12px] text-danger-ink">
                            <AlertCircle className="mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0 flex-1"><p>{error}</p>{canRetry && <button type="button" onClick={retry} className="mt-1 font-semibold underline">Retry</button>}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 border-t border-line bg-surface px-3 pb-3 pt-2.5">
                    {streaming ? (
                      <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-muted"><span className="flex items-center gap-2"><span className="size-1.5 animate-pulse rounded-full bg-primary" /> AQi is answering…</span><button type="button" onClick={stop} className="flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-ink-2 hover:bg-surface"><Square className="size-3" /> Stop</button></div>
                    ) : canRetry ? (
                      <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-muted"><span>That answer didn&apos;t finish.</span><button type="button" onClick={retry} className="flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-ink-2 hover:bg-surface"><RotateCcw className="size-3" /> Retry</button></div>
                    ) : null}
                    <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 shadow-soft focus-within:border-primary/40">
                      <Textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void send(input);
                          }
                        }}
                        rows={1}
                        maxLength={2000}
                        placeholder={bootstrap && !bootstrap.health.available ? "AQi is unavailable until a provider is connected" : "Ask about iAcquireOS…"}
                        disabled={Boolean(bootstrap && !bootstrap.health.available) || streaming}
                        aria-label="Ask AQi"
                        className="max-h-28 min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] shadow-none focus-visible:ring-0"
                      />
                      <Button type="button" size="icon" variant="brand" onClick={() => void send(input)} disabled={!input.trim() || streaming || Boolean(bootstrap && !bootstrap.health.available)} aria-label="Send to AQi"><Send className="size-4" /></Button>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                      <p className="text-[10.5px] text-faint">AQi can make mistakes. Check important details or ask Support.</p>
                      <button type="button" onClick={() => { setSupportOpen(true); setSupportError(null); setSupportResult(null); }} className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-primary hover:underline"><LifeBuoy className="size-3" /> Get help</button>
                    </div>
                  </div>
                </>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {closeConfirm && (
          <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-black/35 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div role="alertdialog" aria-modal="true" aria-labelledby="aqi-close-title" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-float">
              <h2 id="aqi-close-title" className="text-[16px] font-semibold tracking-tight">Save this conversation?</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">You&apos;ve exchanged a few messages. Save them to your private AQi history, or discard this new conversation.</p>
              <div className="mt-4 flex flex-col gap-2">
                <Button variant="brand" onClick={() => { setNewSession(false); closeNow(); }}><Check className="size-4" /> Save &amp; close</Button>
                <Button variant="secondary" onClick={() => void discardAndClose()}>Close without saving</Button>
                <Button variant="ghost" onClick={() => setCloseConfirm(false)}>Keep chatting</Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {supportOpen && (
          <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-black/35 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div role="dialog" aria-modal="true" aria-labelledby="aqi-support-title" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-float">
              <h2 id="aqi-support-title" className="text-[16px] font-semibold tracking-tight">Get help from iAcquire</h2>
              {supportResult ? (
                <div className="mt-3 space-y-3">
                  <p className="rounded-xl border border-success/25 bg-success-soft p-3 text-[12.5px] text-success-ink">{supportResult.existing ? "An open request already exists" : "Support request created"}: <strong>{supportResult.ref}</strong>. The iAcquire team can see it in the existing Support queue.</p>
                  <div className="flex gap-2"><Button variant="brand" onClick={() => { setSupportOpen(false); setSupportResult(null); setSupportConsent(false); setSupportSubject(""); }}>Done</Button><Link href={`/support/${supportResult.id}`} className="inline-flex h-9 items-center rounded-xl border border-line px-3 text-[12px] font-medium">Open request</Link></div>
                </div>
              ) : (
                <>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">This creates a real request in the existing Support system. The last messages in this AQi conversation and the current page may be shared. Nothing is sent until you confirm.</p>
                  {!conversationId && <p className="mt-2 rounded-xl border border-warning/25 bg-warning-soft p-2.5 text-[12px] text-warning-ink">Start a conversation first so there is context to share.</p>}
                  <div className="mt-3 space-y-3">
                    <Field label="Subject (optional)" htmlFor="aqi-support-subject"><Input id="aqi-support-subject" maxLength={160} value={supportSubject} onChange={(event) => setSupportSubject(event.target.value)} placeholder="What do you need help with?" /></Field>
                    <label className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-2"><input type="checkbox" className="mt-0.5" checked={supportConsent} onChange={(event) => setSupportConsent(event.target.checked)} disabled={!conversationId} /> I agree to share this conversation&apos;s messages and current page with iAcquire support.</label>
                    {supportError && <p className="rounded-xl border border-danger/25 bg-danger-soft p-2.5 text-[12px] text-danger-ink">{supportError}</p>}
                    <div className="flex flex-wrap gap-2"><Button variant="brand" disabled={!conversationId || !supportConsent} loading={supportBusy} onClick={() => void createSupportRequest()}><LifeBuoy className="size-4" /> Create request</Button><Button variant="ghost" onClick={() => { setSupportOpen(false); setSupportError(null); }}>Cancel</Button></div>
                    <p className="text-[10.5px] text-faint">If Support is unavailable, open <Link href="/support" className="text-primary underline">Support</Link> or contact an administrator. AQi never claims a ticket exists without this confirmed result.</p>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function HistoryView({
  conversations,
  search,
  setSearch,
  renaming,
  setRenaming,
  deleting,
  setDeleting,
  loading,
  onOpen,
  onRename,
  onDelete,
  onNew,
}: {
  conversations: Conversation[];
  search: string;
  setSearch: (value: string) => void;
  renaming: { id: string; title: string } | null;
  setRenaming: (value: { id: string; title: string } | null) => void;
  deleting: string | null;
  setDeleting: (value: string | null) => void;
  loading: boolean;
  onOpen: (id: string) => void;
  onRename: () => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <Button variant="brand" className="w-full" onClick={onNew}><Plus className="size-4" /> New chat</Button>
        <label className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5">
          <Search className="size-3.5 text-muted" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" className="h-9 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" aria-label="Search conversations" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? <p className="p-3 text-[12.5px] text-muted">Opening conversation…</p> : conversations.length === 0 ? <p className="p-3 text-[12.5px] text-muted">No conversations yet. Start a new chat and it will appear here.</p> : (
          <ul className="space-y-1">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="rounded-xl border border-transparent p-2.5 hover:border-line hover:bg-surface-2">
                {renaming?.id === conversation.id ? (
                  <div className="flex items-center gap-1.5">
                    <input autoFocus value={renaming.title} onChange={(event) => setRenaming({ ...renaming, title: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") onRename(); if (event.key === "Escape") setRenaming(null); }} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[12.5px] outline-none" aria-label="Conversation name" />
                    <button type="button" onClick={onRename} className="grid size-8 place-items-center rounded-lg text-success-ink hover:bg-success-soft" aria-label="Save name"><Check className="size-3.5" /></button>
                    <button type="button" onClick={() => setRenaming(null)} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface" aria-label="Cancel rename"><X className="size-3.5" /></button>
                  </div>
                ) : deleting === conversation.id ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-danger-ink">Delete this chat?</span>
                    <div className="flex gap-1"><button type="button" onClick={() => onDelete(conversation.id)} className="rounded-lg bg-danger px-2 py-1 text-[11px] font-semibold text-white">Delete</button><button type="button" onClick={() => setDeleting(null)} className="rounded-lg px-2 py-1 text-[11px] text-muted">Cancel</button></div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <button type="button" onClick={() => onOpen(conversation.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-[12.5px] font-medium text-ink">{conversation.title}</p>
                      <p className="mt-0.5 text-[10.5px] text-muted"><span suppressHydrationWarning>{relativeTime(conversation.lastMessageAt)}</span></p>
                    </button>
                    <button type="button" onClick={() => setRenaming({ id: conversation.id, title: conversation.title })} className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink" aria-label={`Rename ${conversation.title}`}><Pencil className="size-3" /></button>
                    <button type="button" onClick={() => setDeleting(conversation.id)} className="grid size-7 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink" aria-label={`Delete ${conversation.title}`}><Trash2 className="size-3" /></button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line p-3"><Link href="/support" className="flex items-center justify-center gap-1.5 text-[12px] font-medium text-primary hover:underline">Talk to the iAcquire team <ChevronLeft className="size-3 rotate-180" /></Link></div>
    </div>
  );
}
