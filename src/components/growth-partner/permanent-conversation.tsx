"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Clock3, MessageSquareText, RefreshCw, RotateCcw, Search, Send, ShieldCheck, Square } from "lucide-react";
import { toast } from "sonner";
import { loadOlderGrowthPartnerMessagesAction, refreshGrowthPartnerConversationAction, searchGrowthPartnerConversationAction } from "@/app/actions/ai-growth-partner-conversation";
import { EvidenceChip } from "@/components/chat/evidence-chip";
import { Markdown } from "@/components/markdown";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui/primitives";
import { chatDateSeparatorLabel, conversationDateKey, formatChatTime } from "@/lib/conversation-time";
import type { EvidenceMarker } from "@/lib/evidence-class";

interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "notice";
  authorUserId: string | null;
  authorLabel: string | null;
  content: string;
  status: "streaming" | "complete" | "failed" | "cancelled" | "superseded";
  runId: string | null;
  workJobId: string | null;
  errorCode: string | null;
  evidence: EvidenceMarker | null;
  workJobRunning: boolean;
  createdAt: string;
}

interface ConversationSnapshot {
  conversation: { id: string; title: string; lastMessageAt: string | null; createdAt: string };
  messages: ConversationMessage[];
  hasMore: boolean;
  nextCursor?: { createdAt: string; id: string } | null;
}

interface SearchResult {
  id: string;
  role: "user" | "assistant" | "notice";
  authorLabel: string | null;
  source: "growth_partner" | "previous_profile";
  profileLabel: string | null;
  excerpt: string;
  createdAt: string;
}

function messageLabel(message: Pick<ConversationMessage, "role" | "authorLabel">) {
  if (message.role === "assistant") return "AI Growth Partner";
  if (message.role === "notice") return "iAcquireOS";
  return message.authorLabel || "Workspace member";
}

function mergeConversationMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return [...byId.values()].sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return byTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

function mergeLatestConversationPage(current: ConversationMessage[], incoming: ConversationMessage[]) {
  if (incoming.length === 0) return current;
  const oldestIncoming = incoming.reduce((oldest, message) => {
    const byTime = Date.parse(message.createdAt) - Date.parse(oldest.createdAt);
    return byTime < 0 || (byTime === 0 && message.id < oldest.id) ? message : oldest;
  });
  const olderPages = current.filter((message) => {
    const byTime = Date.parse(message.createdAt) - Date.parse(oldestIncoming.createdAt);
    return byTime < 0 || (byTime === 0 && message.id < oldestIncoming.id);
  });
  return mergeConversationMessages(olderPages, incoming);
}

function friendlyError(errorCode: string | null) {
  const messages: Record<string, string> = {
    interrupted: "The response stopped before it finished. You can try again.",
    connection_lost: "The connection dropped before the answer finished. You can try again.",
    timeout: "The response took too long and was stopped. You can try again.",
    upstream_timeout: "The response took too long. You can try again.",
    execution_failed: "The response could not be completed. You can try again.",
  };
  return errorCode ? messages[errorCode] ?? "The response could not be completed. You can try again." : null;
}

function ConversationTimeline({
  messages,
  now,
  timeZone,
  onStop,
  onRetry,
}: {
  messages: ConversationMessage[];
  now: Date;
  timeZone: string;
  onStop: (message: ConversationMessage) => void;
  onRetry: (message: ConversationMessage) => void;
}) {
  const datedMessages = messages.map((message, index) => {
    const dateKey = conversationDateKey(message.createdAt, timeZone);
    const previousDate = index === 0 ? null : conversationDateKey(messages[index - 1].createdAt, timeZone);
    return {
      message,
      dateLabel: dateKey && dateKey !== previousDate ? chatDateSeparatorLabel(message.createdAt, now, timeZone) : null,
    };
  });
  return (
    <ol className="space-y-5" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Permanent conversation history">
      {datedMessages.map(({ message, dateLabel }) => {
        const isUser = message.role === "user";
        const isNotice = message.role === "notice";
        return (
          <li key={message.id}>
            {dateLabel && <div className="mb-4 flex items-center gap-3 text-[12px] text-faint"><span className="h-px flex-1 bg-line" /><span>{dateLabel}</span><span className="h-px flex-1 bg-line" /></div>}
            <article className={isUser ? "ml-auto max-w-[min(760px,92%)]" : "mr-auto max-w-[min(820px,96%)]"}>
              <header className={`mb-1.5 flex flex-wrap items-center gap-2 text-[12px] ${isUser ? "justify-end" : ""}`}>
                <span className="font-semibold text-ink-2">{messageLabel(message)}</span>
                <time className="text-faint" dateTime={message.createdAt} title={new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(message.createdAt))}>{formatChatTime(message.createdAt, timeZone)}</time>
                {message.status !== "complete" && <Badge tone={message.status === "streaming" ? "primary" : "warning"}>{message.status === "streaming" ? "In progress" : message.status === "failed" ? "Interrupted" : message.status}</Badge>}
              </header>
              <div className={isNotice ? "rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-muted" : isUser ? "rounded-2xl rounded-tr-md border border-primary/15 bg-primary-soft/60 px-4 py-3 text-[14px] text-ink" : "rounded-2xl rounded-tl-md border border-line bg-surface px-4 py-3 text-[14px] text-ink shadow-soft"}>
                <Markdown>{message.content || (message.status === "streaming" ? "Working on a response…" : "No message text was saved.")}</Markdown>
                {message.evidence && <EvidenceChip evidence={message.evidence} timeZone={timeZone} className="mt-3" />}
                {message.workJobId && <div className="mt-3 text-[13px]"><Link href={`/work?job=${encodeURIComponent(message.workJobId)}`} className="font-medium text-primary-ink underline underline-offset-2">{message.workJobRunning ? "View work in progress" : "View work"}</Link></div>}
                {message.evidence?.ledger && <div className="mt-2 text-[13px]"><Link href="/approvals" className="font-medium text-primary-ink underline underline-offset-2">Open ledger evidence</Link></div>}
                {message.status === "failed" && friendlyError(message.errorCode) && <p className="mt-2 text-[13px] text-danger-ink">{friendlyError(message.errorCode)}</p>}
                {message.status === "streaming" && message.runId && <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => onStop(message)}><Square className="size-3.5" aria-hidden /> Stop response</Button>}
                {message.role === "assistant" && (message.status === "failed" || message.status === "cancelled") && <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => onRetry(message)}><RotateCcw className="size-3.5" aria-hidden /> Try again</Button>}
              </div>
            </article>
          </li>
        );
      })}
    </ol>
  );
}

type GrowthPartnerStreamEvent =
  | { type: "ready"; conversationId: string; userMessageId: string | null; assistantMessageId: string; runId: string }
  | { type: "snapshot"; content: string }
  | { type: "delta"; text: string }
  | { type: "done"; content: string; evidence?: EvidenceMarker }
  | { type: "cancelled"; content: string }
  | { type: "error"; code: string; message: string };

async function* readGrowthPartnerEvents(response: Response): AsyncGenerator<GrowthPartnerStreamEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as GrowthPartnerStreamEvent;
      } catch {
        // Ignore malformed stream frames and keep the conversation connected.
      }
    }
  }
}

export function PermanentGrowthPartnerConversation({
  initial,
  initialInput,
  timeZone,
  nowIso,
}: {
  initial: ConversationSnapshot | null;
  initialInput?: string;
  timeZone: string;
  nowIso: string;
}) {
  const [messages, setMessages] = React.useState(initial?.messages ?? []);
  const [hasMore, setHasMore] = React.useState(initial?.hasMore ?? false);
  const [nextCursor, setNextCursor] = React.useState(initial?.nextCursor ?? (initial?.hasMore && initial.messages[0]
    ? { createdAt: initial.messages[0].createdAt, id: initial.messages[0].id }
    : null));
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[] | null>(null);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [input, setInput] = React.useState(initialInput ?? "");
  const [sending, setSending] = React.useState(false);
  const retryClientMessageId = React.useRef<{ id: string; content: string } | null>(null);
  const messageEndRef = React.useRef<HTMLDivElement>(null);
  const hasLoadedOlderPages = React.useRef(false);
  const hasActiveWork = messages.some((message) => message.status === "streaming" || message.workJobRunning);
  const newestMessage = messages[messages.length - 1];
  const now = new Date(nowIso);

  const search = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = query.trim();
    if (!clean) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const response = await searchGrowthPartnerConversationAction(clean);
      if (!response.ok) return toast.error(response.error);
      setResults(response.data);
    } catch {
      toast.error("Search could not reach the conversation. Try again.");
    } finally {
      setSearching(false);
    }
  };

  const loadOlder = async () => {
    if (!nextCursor || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const response = await loadOlderGrowthPartnerMessagesAction(nextCursor);
      if (!response.ok) return toast.error(response.error);
      setMessages((current) => mergeConversationMessages(current, response.data.messages as ConversationMessage[]));
      if (response.data.messages.length > 0) hasLoadedOlderPages.current = true;
      setHasMore(response.data.hasMore);
      setNextCursor(response.data.nextCursor ?? null);
    } catch {
      toast.error("Older messages could not be loaded. Try again.");
    } finally {
      setLoadingOlder(false);
    }
  };

  const refreshConversation = React.useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const response = await refreshGrowthPartnerConversationAction();
      if (!response.ok || !isCurrent()) return false;
      setMessages((current) => mergeLatestConversationPage(current, response.data.messages as ConversationMessage[]));
      if (!hasLoadedOlderPages.current) {
        setHasMore(response.data.hasMore);
        setNextCursor(response.data.nextCursor ?? null);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshHistory = async () => {
    setRefreshing(true);
    const refreshed = await refreshConversation();
    setRefreshing(false);
    if (!refreshed) toast.error("The saved conversation could not be refreshed. Try again.");
  };

  React.useEffect(() => {
    if (!hasActiveWork || sending || refreshing) return;
    let stopped = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      await refreshConversation(() => !stopped);
      inFlight = false;
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1800);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [hasActiveWork, sending, refreshing, refreshConversation]);

  React.useEffect(() => {
    messageEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [newestMessage?.id, newestMessage?.content, newestMessage?.status]);

  const stopMessage = async (message: ConversationMessage) => {
    if (!message.runId) return;
    try {
      const response = await fetch(`/api/chat/runs/${encodeURIComponent(message.runId)}/stop`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        toast.error(data?.error ?? "The response could not be stopped.");
        return;
      }
      if (!await refreshConversation()) toast.error("The stop request succeeded. Refresh the conversation to see its status.");
    } catch {
      toast.error("The response could not be stopped because the connection dropped.");
    }
  };

  const applyResponseFrame = (assistantId: string | null, frame: Exclude<GrowthPartnerStreamEvent, { type: "ready" }>) => {
    if (frame.type === "error") toast.error(frame.message);
    if (!assistantId) return;
    setMessages((current) => current.map((message) => {
      if (message.id !== assistantId) return message;
      switch (frame.type) {
        case "snapshot":
          return { ...message, content: frame.content };
        case "delta":
          return { ...message, content: message.content + frame.text };
        case "done":
          return { ...message, content: frame.content, status: "complete", evidence: frame.evidence ?? message.evidence };
        case "cancelled":
          return { ...message, content: frame.content, status: "cancelled" };
        case "error":
          return { ...message, status: "failed", errorCode: frame.code };
      }
    }));
  };

  const retryAssistant = async (message: ConversationMessage) => {
    if (!initial || sending || refreshing) return;
    setSending(true);
    try {
      const response = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "growth_partner", conversationId: initial.conversation.id, regenerateMessageId: message.id }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        toast.error(data?.error ?? "The AI Growth Partner couldn't retry that response.");
        return;
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        let assistantId: string | null = null;
        for await (const frame of readGrowthPartnerEvents(response)) {
          if (frame.type === "ready") {
            assistantId = frame.assistantMessageId;
            setMessages((current) => mergeConversationMessages(current, [{
              id: frame.assistantMessageId,
              role: "assistant",
              authorUserId: null,
              authorLabel: "AI Growth Partner",
              content: "",
              status: "streaming",
              runId: frame.runId,
              workJobId: null,
              workJobRunning: false,
              errorCode: null,
              evidence: null,
              createdAt: new Date().toISOString(),
            }]));
          } else {
            applyResponseFrame(assistantId, frame);
          }
        }
      }
      if (!await refreshConversation()) toast.error("The saved response could not be refreshed. Try refreshing the conversation.");
    } catch {
      toast.error("The retry connection dropped. Refreshing the saved conversation.");
      await refreshConversation();
    } finally {
      setSending(false);
    }
  };

  const sendMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = input.trim();
    if (!initial || !content || sending || refreshing) return;
    const clientMessageId = retryClientMessageId.current?.content === content
      ? retryClientMessageId.current.id
      : crypto.randomUUID();
    const localId = "local-" + clientMessageId;
    retryClientMessageId.current = { id: clientMessageId, content };
    setSending(true);
    setInput("");
    setResults(null);
    setMessages((current) => [...current, {
      id: localId,
      role: "user",
      authorUserId: null,
      authorLabel: "You",
      content,
      status: "complete",
      runId: null,
      workJobId: null,
      workJobRunning: false,
      errorCode: null,
      evidence: null,
      createdAt: new Date().toISOString(),
    }]);

    let response: Response;
    try {
      response = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "growth_partner",
          conversationId: initial.conversation.id,
          content,
          clientMessageId,
        }),
      });
    } catch {
      setMessages((current) => current.filter((message) => message.id !== localId));
      setInput(content);
      setSending(false);
      toast.error("Network problem — your message wasn't sent.");
      return;
    }

    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string } | null;
      setMessages((current) => current.filter((message) => message.id !== localId));
      setInput(content);
      setSending(false);
      toast.error(data?.error ?? "The AI Growth Partner couldn't receive that message.");
      return;
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      let assistantId: string | null = null;
      try {
        for await (const frame of readGrowthPartnerEvents(response)) {
          if (frame.type === "ready") {
            retryClientMessageId.current = null;
            assistantId = frame.assistantMessageId;
            setMessages((current) => {
              const next = current.map((message) => message.id === localId && frame.userMessageId
                ? { ...message, id: frame.userMessageId }
                : message);
              if (next.some((message) => message.id === frame.assistantMessageId)) return next;
              return [...next, {
                id: frame.assistantMessageId,
                role: "assistant" as const,
                authorUserId: null,
                authorLabel: "AI Growth Partner",
                content: "",
                status: "streaming" as const,
                runId: frame.runId,
                workJobId: null,
                workJobRunning: false,
                errorCode: null,
                evidence: null,
                createdAt: new Date().toISOString(),
              }];
            });
          } else {
            applyResponseFrame(assistantId, frame);
          }
        }
      } catch {
        toast.error("The response stream disconnected. Refreshing the saved conversation.");
      }
      if (!assistantId) {
        setMessages((current) => current.filter((message) => message.id !== localId));
        setInput(content);
      }
      if (!await refreshConversation()) toast.error("The saved conversation could not be refreshed. Try again.");
      setSending(false);
      return;
    }

    const result = await response.json().catch(() => null) as { conversationId?: string; runId?: string | null; assistantMessageId?: string; error?: string } | null;
    if (!result?.conversationId) {
      setMessages((current) => current.filter((message) => message.id !== localId));
      setInput(content);
      setSending(false);
      toast.error(result?.error ?? "The AI Growth Partner couldn't receive that message.");
      return;
    }
    retryClientMessageId.current = null;
    setMessages((current) => current.filter((message) => message.id !== localId));
    if (!await refreshConversation()) toast.error("The saved conversation could not be refreshed. Try again.");
    setSending(false);
  };

  return (
    <div className="mx-auto w-full max-w-[1120px] space-y-5 pb-10">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <ButtonLink href="/growth-partner" variant="ghost" size="sm" className="mb-3 -ml-2"><ArrowLeft className="size-4" aria-hidden /> Partner Control Center</ButtonLink>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-[26px] font-semibold tracking-[-0.035em] text-ink sm:text-[30px]">AI Growth Partner</h1><Badge tone={initial ? "success" : "warning"}>{initial ? "One shared conversation" : "Setup in progress"}</Badge></div>
          <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-muted">Your workspace shares one lasting conversation with the AI Growth Partner. There are no separate chats for roles, tasks or scheduled work.</p>
        </div>
        {initial?.conversation.lastMessageAt && <span className="inline-flex items-center gap-1.5 text-[12px] text-faint"><Clock3 className="size-3.5" aria-hidden /> Updated {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone }).format(new Date(initial.conversation.lastMessageAt))}</span>}
      </div>

      {!initial ? (
        <Card className="border border-line bg-surface shadow-soft">
          <CardContent className="flex flex-col items-center px-6 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-line bg-surface-2 text-muted"><MessageSquareText className="size-5" aria-hidden /></div>
            <h2 className="mt-4 text-[17px] font-semibold text-ink">Your AI Growth Partner is still being set up</h2>
            <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-muted">Your shared conversation will be ready when setup is complete. Previous role profile histories remain saved.</p>
            <ButtonLink href="/growth-partner" variant="secondary" size="md" className="mt-5">Review setup <ArrowUpRight className="size-4" aria-hidden /></ButtonLink>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border border-line bg-surface shadow-soft">
          <CardHeader className="flex-wrap items-center border-b border-line pb-4">
            <div className="min-w-0">
              <CardTitle>{initial.conversation.title || "AI Growth Partner"}</CardTitle>
              <p className="mt-1 text-[12px] text-muted">Conversation history is shared with members who have AI access.</p>
            </div>
            <form onSubmit={search} className="flex w-full gap-2 sm:w-auto">
              <label className="sr-only" htmlFor="growth-conversation-search">Search permanent conversation</label>
              <Input id="growth-conversation-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this history" className="min-w-0 sm:w-[240px]" />
              <Button type="submit" variant="secondary" size="sm" loading={searching}><Search className="size-4" aria-hidden /><span className="sr-only sm:not-sr-only">Search</span></Button>
              {results && <Button type="button" variant="ghost" size="sm" onClick={() => { setResults(null); setQuery(""); }}>Clear</Button>}
            </form>
            <Button type="button" variant="ghost" size="sm" loading={refreshing} disabled={sending} onClick={refreshHistory}>
              <RefreshCw className="size-4" aria-hidden /> Refresh conversation
            </Button>
          </CardHeader>
          <CardContent className="space-y-5 px-4 py-4 sm:px-6 sm:py-5">
            {results ? (
              <section aria-live="polite" aria-label="Search results" className="space-y-3">
                <p className="text-[12px] text-muted">{results.length} {results.length === 1 ? "match" : "matches"} in the shared conversation or your saved history with previous profiles. Only you can see that earlier history.</p>
                {results.length === 0 ? <p className="rounded-xl border border-line bg-surface-2/50 px-4 py-7 text-center text-[13px] text-muted">No messages matched that search.</p> : results.map((result) => (
                  <article key={result.id} className="rounded-xl border border-line bg-surface-2/40 p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]"><span className="font-semibold text-ink-2">{result.source === "previous_profile" && result.role === "assistant" ? result.profileLabel || "Previous profile" : result.role === "assistant" ? "AI Growth Partner" : result.authorLabel || (result.role === "notice" ? "iAcquireOS" : "Workspace member")}</span>{result.source === "previous_profile" && <Badge tone="neutral">Previous profile history</Badge>}<time className="text-faint" dateTime={result.createdAt}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(result.createdAt))}</time></div>
                    <Markdown>{result.excerpt}</Markdown>
                  </article>
                ))}
              </section>
            ) : (
              <>
                {hasMore && <div className="text-center"><Button type="button" variant="secondary" size="sm" loading={loadingOlder} onClick={loadOlder}>Load older messages</Button></div>}
                {messages.length > 0 ? <><ConversationTimeline messages={messages} now={now} timeZone={timeZone} onStop={stopMessage} onRetry={retryAssistant} /><div ref={messageEndRef} /></> : <p className="rounded-xl border border-line bg-surface-2/50 px-4 py-8 text-center text-[13px] text-muted">No messages have been saved in this thread yet.</p>}
              </>
            )}
            <form onSubmit={sendMessage} className="rounded-xl border border-line bg-surface-2/45 p-3">
              <label className="sr-only" htmlFor="growth-partner-message">Message the AI Growth Partner</label>
              <textarea
                id="growth-partner-message"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                maxLength={8000}
                rows={3}
                placeholder="Ask about growth, customers, pipeline or operations…"
                disabled={sending}
                className="min-h-[84px] w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-[16px] text-ink outline-none transition placeholder:text-faint focus:border-primary/50 focus:ring-2 focus:ring-primary/10 disabled:opacity-60"
              />
              <div className="mt-2 flex flex-col-reverse justify-between gap-2 sm:flex-row sm:items-center">
                <p className="text-[12px] leading-relaxed text-muted">Each member sees the same thread. Work that changes records or contacts people remains permission and approval gated.</p>
                <Button type="submit" variant="primary" size="sm" loading={sending} disabled={!input.trim() || sending}>
                  <Send className="size-3.5" aria-hidden /> Send
                </Button>
              </div>
            </form>
            <div role="note" className="flex items-start gap-2.5 rounded-xl border border-primary/15 bg-primary-soft/35 px-4 py-3 text-[12px] leading-relaxed text-ink-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /><span>Replies use this workspace’s verified Growth Partner profile and active Business Brain. Owners and admins can change the saved tone, language or reply length by asking here. Work history stays in this shared conversation.</span></div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
