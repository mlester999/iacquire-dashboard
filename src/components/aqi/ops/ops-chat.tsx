"use client";

import * as React from "react";
import { ArrowDown, Check, CircleAlert, History, Loader2, Lock, MessageSquarePlus, RotateCcw, Search, SendHorizontal, Sparkles, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/overlays";
import { Input, Skeleton, Textarea } from "@/components/ui/primitives";
import { Markdown } from "@/components/markdown";
import { OpsCardView } from "@/components/aqi/ops/ops-cards";
import { OpsScopePicker } from "@/components/aqi/ops/ops-scope-picker";
import type { OpsConversation, OpsMessage, useOpsChat } from "@/components/aqi/ops/use-ops-chat";
import { normalizeAqiNavigation } from "@/lib/aqi/navigation-links";
import { OPS_LINKS, isSafeOpsHref } from "@/lib/aqi/ops/links";
import { contextSuggestions, SCOPE_TYPE_LABEL } from "@/lib/aqi/ops/quick-actions";
import type { OpsCard, OpsScope, OpsToolRun } from "@/lib/aqi/ops/types";
import { cn, relativeTime } from "@/lib/utils";

export type OpsChatApi = ReturnType<typeof useOpsChat>;
const MAX = 2000;

function RunLine({ run }: { run: OpsToolRun }) {
  const icon = run.status === "running" ? <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
    : run.status === "ok" ? <Check className="size-3.5 text-success" aria-hidden />
      : run.status === "partial" ? <CircleAlert className="size-3.5 text-warning" aria-hidden />
        : run.status === "denied" ? <Lock className="size-3.5 text-danger" aria-hidden />
          : <CircleAlert className="size-3.5 text-danger" aria-hidden />;
  const word = run.status === "running" ? "Checking" : run.status === "ok" ? "Checked" : run.status === "partial" ? "Partly checked" : run.status === "denied" ? "Not permitted" : run.status === "timeout" ? "Timed out" : "Could not check";
  return (
    <li className="flex items-start gap-2 text-[12.5px] text-muted">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span><span className="font-medium text-ink-2">{word}:</span> {run.title}{run.durationMs !== undefined && run.status !== "running" ? <span className="tabular-nums"> · {run.durationMs} ms</span> : null}{run.note && run.status !== "ok" ? <span> · {run.note}</span> : null}</span>
    </li>
  );
}

function Answer({ message }: { message: OpsMessage }) {
  const routes = React.useMemo(() => {
    const extra = (message.ops?.evidence ?? []).filter((e) => e.href && isSafeOpsHref(e.href)).map((e) => ({ path: e.href!, label: e.label }));
    return [...OPS_LINKS, ...extra];
  }, [message.ops?.evidence]);
  const text = React.useMemo(
    () => normalizeAqiNavigation(message.content, { routes, currentPath: null, streaming: Boolean(message.streaming), externalLinks: "strip", rawPaths: true }),
    [message.content, message.streaming, routes],
  );
  if (!message.content) return null;
  return <div className="rounded-2xl border border-line bg-surface px-4 py-3"><Markdown className="prose-aqi text-[14px]">{text}</Markdown></div>;
}

function Evidence({ message }: { message: OpsMessage }) {
  const evidence = message.ops?.evidence ?? [];
  if (!evidence.length) return null;
  return (
    <details className="rounded-xl border border-line bg-surface-2/50 px-3 py-2 text-[12.5px] text-muted">
      <summary className="cursor-pointer select-none font-medium text-ink-2">Evidence and sources ({evidence.length})</summary>
      <ol className="mt-2 space-y-1.5">
        {evidence.map((e) => (
          <li key={e.id} className="leading-relaxed">
            <span className="mr-1.5 rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-2">{e.id}</span>
            <span className="font-medium text-ink-2">{e.label}</span> · {e.source} · retrieved <time dateTime={e.retrievedAt} suppressHydrationWarning>{new Date(e.retrievedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[12px]">Answers are built from this evidence. Earlier conversation is context, not proof of current state: ask again or use Refresh on a card for current data.</p>
    </details>
  );
}

function MessageView({ message, onRetry, onAsk, onPick, onRefresh, onOutcome, last }: {
  message: OpsMessage; last: boolean; onRetry: () => void; onAsk: (q: string) => void; onPick: (o: { type: OpsScope["type"]; id: string }) => void;
  onRefresh: (card: OpsCard) => Promise<string | null>; onOutcome: (actionId: string, cards: OpsCard[]) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[14px] leading-relaxed text-surface dark:text-bg">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
          {message.scope && message.scope.type !== "platform" && <p className="mt-1 text-[11.5px] opacity-70">{SCOPE_TYPE_LABEL[message.scope.type]}: {message.scope.label}</p>}
        </div>
      </div>
    );
  }
  const runs = message.streaming ? message.live?.runs ?? [] : [];
  const failed = (message.ops?.tools ?? []).filter((t) => !["ok"].includes(t.status));
  return (
    <article className="space-y-3" aria-label="AQi Operations answer" aria-busy={message.streaming || undefined}>
      {message.streaming && (
        <div role="status" aria-live="polite" className="rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
          {runs.length ? <ul className="space-y-1.5">{runs.map((r) => <RunLine key={r.id + r.status} run={r} />)}</ul> : <p className="flex items-center gap-2 text-[12.5px] text-muted"><Loader2 className="size-3.5 animate-spin" aria-hidden />Working on it…</p>}
        </div>
      )}
      {(message.ops?.cards ?? []).map((card) => (
        <OpsCardView key={card.id} card={card} onRefresh={message.streaming ? undefined : onRefresh} onPickScope={onPick} onActionOutcome={onOutcome} />
      ))}
      <Answer message={message} />
      {!message.streaming && failed.length > 0 && (
        <ul className="space-y-1.5 rounded-xl border border-warning/25 bg-warning-soft/40 px-3 py-2">{failed.map((r) => <RunLine key={r.id} run={r} />)}</ul>
      )}
      {message.error && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/25 bg-danger-soft/50 px-3 py-2.5 text-[13px] text-danger-ink" role="alert">
          <CircleAlert className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1">{message.error}</span>
          {last && message.status !== "cancelled" && <Button variant="secondary" size="sm" onClick={onRetry}><RotateCcw className="size-3.5" aria-hidden />Try again</Button>}
        </div>
      )}
      {!message.streaming && <Evidence message={message} />}
      {!message.streaming && last && message.suggestedQuestions && message.suggestedQuestions.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Suggested follow-up questions" role="group">
          {message.suggestedQuestions.map((q) => <button key={q} type="button" onClick={() => onAsk(q)} className="min-h-9 rounded-full border border-line bg-surface px-3 text-left text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">{q}</button>)}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistorySheet({ open, onOpenChange, currentId, onOpen, onDeleted }: { open: boolean; onOpenChange: (o: boolean) => void; currentId: string | null; onOpen: (id: string) => void; onDeleted: (id: string) => void }) {
  const [q, setQ] = React.useState("");
  const [items, setItems] = React.useState<OpsConversation[]>([]);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = React.useState(false);
  const [target, setTarget] = React.useState<OpsConversation | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const res = await fetch(`/api/aqi/ops/conversations?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error("history");
        const data = (await res.json()) as { conversations: OpsConversation[]; hasMore: boolean };
        setItems(data.conversations);
        setMore(data.hasMore);
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted) setStatus("error");
      }
    }, q ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, q]);

  async function loadMore() {
    const last = items.at(-1);
    if (!last) return;
    const res = await fetch(`/api/aqi/ops/conversations?q=${encodeURIComponent(q)}&before=${encodeURIComponent(last.lastMessageAt)}`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { conversations: OpsConversation[]; hasMore: boolean };
    setItems((c) => [...c, ...data.conversations]);
    setMore(data.hasMore);
  }

  async function confirmDelete() {
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await fetch(`/api/aqi/ops/conversations/${target.id}`, { method: "DELETE" }).catch(() => null);
    setDeleting(false);
    if (!res?.ok) { setDeleteError("That conversation could not be deleted. Please try again."); return; }
    setItems((c) => c.filter((i) => i.id !== target.id));
    onDeleted(target.id);
    setTarget(null);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title="Investigation history" description="Your saved AQi Operations conversations. Only you can see them.">
        <div className="space-y-3 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title" className="pl-9" aria-label="Search investigations" />
          </div>
          {status === "loading" && <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
          {status === "error" && <p className="text-[13px] text-danger-ink" role="alert">History could not be loaded. Close and reopen to try again.</p>}
          {status === "ready" && !items.length && <p className="text-[13px] text-muted">{q ? "No investigation matches that title." : "No saved investigations yet. Every question you ask is saved here."}</p>}
          <ul className="space-y-1.5">
            {items.map((c) => (
              <li key={c.id} className={cn("group flex items-center gap-1 rounded-xl border px-3 py-2", c.id === currentId ? "border-primary/40 bg-primary-soft/50" : "border-line bg-surface")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { onOpen(c.id); onOpenChange(false); }}>
                  <span className="line-clamp-2 text-[13px] font-medium text-ink">{c.title}</span>
                  <span className="block text-[11.5px] text-muted">{relativeTime(c.lastMessageAt)}</span>
                </button>
                <button type="button" onClick={() => { setDeleteError(null); setTarget(c); }} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-danger-ink sm:size-8" aria-label={`Delete ${c.title}`}><Trash2 className="size-4" aria-hidden /></button>
              </li>
            ))}
          </ul>
          {more && <Button variant="secondary" size="sm" className="w-full" onClick={() => void loadMore()}>Load more</Button>}
        </div>
      </Sheet>
      <Dialog
        open={target !== null}
        onOpenChange={(o) => { if (!o && !deleting) setTarget(null); }}
        title="Delete this investigation?"
        description="The conversation and its cards are removed. Actions you confirmed stay in the audit trail."
        size="sm"
        footer={<><Button variant="ghost" onClick={() => setTarget(null)} disabled={deleting}>Keep it</Button><Button variant="danger" onClick={() => void confirmDelete()} loading={deleting}>{deleting ? "Deleting…" : "Delete"}</Button></>}
      >
        <p className="text-[13.5px] text-ink-2">{target?.title}</p>
        {deleteError && <p className="mt-2 text-[12.5px] text-danger-ink" role="alert">{deleteError}</p>}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------

export function OpsChat({ chat, scope, onScopeChange, variant, pickerSignal, draft, onNavigate }: {
  chat: OpsChatApi; scope: OpsScope; onScopeChange: (s: OpsScope) => void; variant: "page" | "panel"; pickerSignal?: number;
  draft?: { text: string; nonce: number } | null; onNavigate?: () => void;
}) {
  const [input, setInput] = React.useState("");
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const nearBottom = React.useRef(true);
  const [showJump, setShowJump] = React.useState(false);
  const lastDraft = React.useRef(0);
  const { messages, sending, send, stop, reset, open, loading, loadError, hasMore, loadOlder, applyActionCards, refreshCard } = chat;

  React.useEffect(() => {
    if (draft && draft.nonce !== lastDraft.current) {
      lastDraft.current = draft.nonce;
      setInput(draft.text);
      textareaRef.current?.focus();
    }
  }, [draft]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) { el.scrollTop = el.scrollHeight; return; }
    if (!messages.length) return;
    // New content arrived while the reader is scrolled up: offer a way back instead of moving the page under them.
    const frame = requestAnimationFrame(() => setShowJump(true));
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom.current) setShowJump(false);
  }

  const ask = React.useCallback(async (text: string) => {
    const ok = text.trim();
    if (!ok || sending) return;
    nearBottom.current = true;
    setInput("");
    await send(ok, scope);
  }, [scope, send, sending]);

  function submit() {
    if (input.trim().length > MAX) { setNotice(`Keep questions under ${MAX.toLocaleString()} characters.`); return; }
    setNotice(null);
    void ask(input);
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastIndex = messages.length - 1;
  const suggestions = contextSuggestions(scope);

  function pickFromCard(option: { type: OpsScope["type"]; id: string }) {
    void (async () => {
      const res = await fetch("/api/aqi/ops/scope", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: { type: option.type, id: option.id } }) }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { scope?: OpsScope; error?: string } | null;
      if (!res?.ok || !body?.scope) { setNotice(body?.error ?? "That context could not be opened."); return; }
      onScopeChange(body.scope);
      await send(lastUser?.content ?? "What is blocking this client's onboarding?", body.scope);
    })();
  }

  return (
    <div className={cn("flex min-h-0 flex-col", variant === "page" ? "h-full" : "h-full")}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">{chat.title ?? "New investigation"}</h2>
          <p className="text-[11.5px] text-muted">Answers are built from recorded evidence with its source and time.</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => { reset(); setInput(""); setNotice(null); }} disabled={sending || (!messages.length && !chat.conversationId)}><MessageSquarePlus className="size-4" aria-hidden />New</Button>
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}><History className="size-4" aria-hidden />History</Button>
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4" role="log" aria-label="AQi Operations conversation" aria-relevant="additions">
        {loading && <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-40" /></div>}
        {loadError && <p className="rounded-xl border border-danger/25 bg-danger-soft/50 px-3 py-2 text-[13px] text-danger-ink" role="alert">{loadError}</p>}
        {!loading && hasMore && <div className="mb-3 text-center"><Button variant="secondary" size="sm" onClick={() => void loadOlder()}>Load earlier messages</Button></div>}
        {!loading && !messages.length && !loadError && (
          <div className="mx-auto flex max-w-xl flex-col items-center py-6 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card"><Sparkles className="size-5" aria-hidden /></span>
            <h3 className="mt-4 text-[17px] font-semibold tracking-[-0.025em] text-ink">What should we investigate?</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              {scope.type === "platform" ? "Ask about platform health, a client, AI Employees, support, security, costs or integrations." : <>Investigating <strong className="text-ink-2">{scope.label}</strong>. Evidence stays inside this context.</>}
              {" "}I show what I checked, when, and what cannot be determined. Changes are previewed and need your confirmation.
            </p>
            <div className="mt-5 grid w-full gap-2 sm:grid-cols-2" role="group" aria-label="Suggested questions">
              {suggestions.map((q) => <button key={q} type="button" onClick={() => void ask(q)} disabled={sending} className="min-h-11 rounded-xl border border-line bg-surface px-3 py-2 text-left text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-60">{q}</button>)}
            </div>
          </div>
        )}
        <div className="space-y-5">
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              message={m}
              last={i === lastIndex}
              onRetry={() => { if (lastUser) void ask(lastUser.content); }}
              onAsk={(q) => void ask(q)}
              onPick={pickFromCard}
              onRefresh={(card) => refreshCard(m.id, card)}
              onOutcome={(actionId, cards) => applyActionCards(m.id, actionId, cards)}
            />
          ))}
        </div>
        {showJump && (
          <button type="button" onClick={() => { const el = scrollRef.current; if (el) { el.scrollTop = el.scrollHeight; nearBottom.current = true; setShowJump(false); } }} className="sticky bottom-2 left-full ml-auto flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2 shadow-float">
            <ArrowDown className="size-3.5" aria-hidden />Latest
          </button>
        )}
      </div>

      <form className="border-t border-line bg-surface px-3 py-3 sm:px-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-muted" id="ops-scope-label">Investigating</span>
          <OpsScopePicker scope={scope} onChange={onScopeChange} disabled={sending} openSignal={pickerSignal} />
        </div>
        <div className="flex items-end gap-2">
          <label htmlFor={`ops-composer-${variant}`} className="sr-only">Ask AQi Operations</label>
          <Textarea
            id={`ops-composer-${variant}`}
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            }}
            rows={1}
            placeholder="Ask about health, a client, AI Employees, support, security or costs"
            className="max-h-40 min-h-11 resize-none"
            maxLength={MAX + 200}
            aria-describedby="ops-composer-hint"
          />
          {sending ? (
            <Button type="button" variant="secondary" size="icon" onClick={stop} aria-label="Stop"><Square className="size-4" aria-hidden /></Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim()} aria-label="Send"><SendHorizontal className="size-4" aria-hidden /></Button>
          )}
        </div>
        <p id="ops-composer-hint" className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11.5px] text-muted">
          <span>Enter to send, Shift+Enter for a new line</span>
          {input.length > MAX - 200 && <span className={input.length > MAX ? "text-danger-ink" : undefined}>{input.length}/{MAX}</span>}
          {notice && <span className="text-danger-ink" role="alert">{notice}</span>}
        </p>
      </form>

      <HistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        currentId={chat.conversationId}
        onOpen={(id) => { void open(id); onNavigate?.(); }}
        onDeleted={(id) => { if (id === chat.conversationId) reset(); }}
      />
    </div>
  );
}
