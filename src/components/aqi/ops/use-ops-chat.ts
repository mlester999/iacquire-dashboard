"use client";

import * as React from "react";
import { PLATFORM_SCOPE, type OpsCard, type OpsMessageContext, type OpsScope, type OpsToolRun } from "@/lib/aqi/ops/types";

export interface OpsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  createdAt: string;
  streaming?: boolean;
  error?: string | null;
  scope?: OpsScope;
  ops?: OpsMessageContext;
  suggestedQuestions?: string[];
  /** While a turn is running: the planned checks and how each is going. */
  live?: { plan: Array<{ id: string; title: string }>; runs: OpsToolRun[] };
}

export interface OpsConversation { id: string; title: string; lastMessageAt: string; createdAt: string }

function parseSseBlock(block: string): Record<string, unknown> | null {
  const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
  if (!data) return null;
  try { return JSON.parse(data) as Record<string, unknown>; } catch { return null; }
}

const emptyOps = (scope: OpsScope): OpsMessageContext => ({ scope, cards: [], evidence: [], tools: [], actionIds: [], narrative: "evidence_only" });

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 401) return "Your session has ended. Please sign in again.";
  if (res.status === 403) return body?.error ?? "AQi Operations is available to Super Admins only.";
  return body?.error ?? "AQi Operations could not answer that. Please try again.";
}

export function useOpsChat() {
  const [messages, setMessages] = React.useState<OpsMessage[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const lock = React.useRef(false);
  const conversationRef = React.useRef<string | null>(null);

  const patchAssistant = React.useCallback((id: string, patch: (m: OpsMessage) => OpsMessage) => {
    setMessages((current) => current.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  const send = React.useCallback(async (text: string, scope: OpsScope): Promise<boolean> => {
    const message = text.trim();
    if (!message || lock.current) return false;
    lock.current = true;
    setSending(true);
    const stamp = Date.now();
    const userId = `u-${stamp}`;
    let assistantId = `a-${stamp}`;
    const now = new Date().toISOString();
    setMessages((c) => [
      ...c,
      { id: userId, role: "user", content: message, status: "complete", createdAt: now, scope },
      { id: assistantId, role: "assistant", content: "", status: "streaming", createdAt: now, streaming: true, scope, ops: emptyOps(scope), live: { plan: [], runs: [] } },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/aqi/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversationRef.current, message, path: window.location.pathname, scope: { type: scope.type, id: scope.id } }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        patchAssistant(assistantId, (m) => ({ ...m, streaming: false, status: "failed", error: "" }));
        const text = await errorFrom(res);
        patchAssistant(assistantId, (m) => ({ ...m, error: text }));
        return false;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const event = parseSseBlock(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (!event) continue;
          const type = event.type;
          if (type === "meta") {
            const previous = assistantId;
            assistantId = String(event.messageId);
            conversationRef.current = String(event.conversationId);
            setConversationId(conversationRef.current);
            setMessages((c) => c.map((m) => (m.id === previous ? { ...m, id: assistantId, scope: event.scope as OpsScope, ops: emptyOps(event.scope as OpsScope) } : m)));
          } else if (type === "plan") {
            const plan = event.tools as Array<{ id: string; title: string }>;
            patchAssistant(assistantId, (m) => ({ ...m, live: { plan, runs: plan.map((p) => ({ id: p.id, toolId: p.id, title: p.title, status: "running" as const })) } }));
          } else if (type === "tool") {
            const run = event.run as OpsToolRun;
            patchAssistant(assistantId, (m) => ({
              ...m,
              live: { plan: m.live?.plan ?? [], runs: (m.live?.runs ?? []).map((r) => (r.toolId === run.toolId && r.status === "running" ? run : r)) },
              ops: m.ops ? { ...m.ops, tools: [...m.ops.tools, run] } : m.ops,
            }));
          } else if (type === "cards") {
            const cards = event.cards as OpsCard[];
            patchAssistant(assistantId, (m) => ({ ...m, ops: m.ops ? { ...m.ops, cards: [...m.ops.cards, ...cards] } : m.ops }));
          } else if (type === "delta") {
            patchAssistant(assistantId, (m) => ({ ...m, content: m.content + String(event.text ?? "") }));
          } else if (type === "done") {
            const doneMessage = event.message as OpsMessage & { ops: OpsMessageContext };
            patchAssistant(assistantId, (m) => ({
              ...m, content: doneMessage.content, status: "complete", streaming: false, live: undefined, ops: doneMessage.ops ?? m.ops, suggestedQuestions: doneMessage.suggestedQuestions, error: null,
            }));
          } else if (type === "error") {
            patchAssistant(assistantId, (m) => ({ ...m, streaming: false, status: "failed", live: undefined, error: String(event.message ?? "AQi Operations could not finish that answer.") }));
          }
        }
      }
      patchAssistant(assistantId, (m) => (m.streaming ? { ...m, streaming: false, status: "failed", live: undefined, error: "The connection was interrupted before the answer finished." } : m));
      return true;
    } catch (err) {
      const aborted = controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
      patchAssistant(assistantId, (m) => ({ ...m, streaming: false, live: undefined, status: aborted ? "cancelled" : "failed", error: aborted ? "Stopped." : "The connection was interrupted. Try again." }));
      return false;
    } finally {
      lock.current = false;
      abortRef.current = null;
      setSending(false);
    }
  }, [patchAssistant]);

  const stop = React.useCallback(() => { abortRef.current?.abort(); }, []);

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    conversationRef.current = null;
    setConversationId(null);
    setTitle(null);
    setMessages([]);
    setHasMore(false);
    setLoadError(null);
  }, []);

  const open = React.useCallback(async (id: string) => {
    abortRef.current?.abort();
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/aqi/ops/conversations/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await errorFrom(res));
      const data = (await res.json()) as { conversation: OpsConversation; messages: OpsMessage[]; hasMore: boolean };
      conversationRef.current = data.conversation.id;
      setConversationId(data.conversation.id);
      setTitle(data.conversation.title);
      setMessages(data.messages);
      setHasMore(data.hasMore);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "That conversation could not be opened.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOlder = React.useCallback(async () => {
    const id = conversationRef.current;
    const first = messages[0];
    if (!id || !first) return;
    const res = await fetch(`/api/aqi/ops/conversations/${id}?before=${encodeURIComponent(first.createdAt)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { messages: OpsMessage[]; hasMore: boolean };
    setMessages((c) => [...data.messages, ...c]);
    setHasMore(data.hasMore);
  }, [messages]);

  /** Replaces the preview card of an action with its current outcome (preview + verified result). */
  const applyActionCards = React.useCallback((messageId: string, actionId: string, cards: OpsCard[]) => {
    patchAssistant(messageId, (m) => {
      if (!m.ops) return m;
      const rest = m.ops.cards.filter((c) => !("actionId" in c && c.actionId === actionId));
      return { ...m, ops: { ...m.ops, cards: [...rest, ...cards] } };
    });
  }, [patchAssistant]);

  const refreshCard = React.useCallback(async (messageId: string, card: OpsCard): Promise<string | null> => {
    const message = messages.find((m) => m.id === messageId);
    if (!card.refresh || !message) return "This card cannot be refreshed.";
    const scope = message.scope ?? PLATFORM_SCOPE;
    const res = await fetch("/api/aqi/ops/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolId: card.refresh.toolId, args: card.refresh.args, scope: { type: scope.type, id: scope.id } }),
    }).catch(() => null);
    if (!res || !res.ok) return res ? await errorFrom(res) : "The refresh could not be sent. Check your connection.";
    const data = (await res.json()) as { run: OpsToolRun; cards: OpsCard[] };
    if (!data.cards.length) return data.run.note ?? "No fresh data was returned.";
    patchAssistant(messageId, (m) => {
      if (!m.ops) return m;
      // Only cards produced by the same check are replaced, matched by kind and title, so a refresh never touches other evidence.
      const cards = m.ops.cards.map((c) => {
        if (c.refresh?.toolId !== card.refresh?.toolId) return c;
        return data.cards.find((n) => n.kind === c.kind && n.title === c.title) ?? c;
      });
      return { ...m, ops: { ...m.ops, cards } };
    });
    return null;
  }, [messages, patchAssistant]);

  return { messages, conversationId, title, sending, loading, loadError, hasMore, send, stop, reset, open, loadOlder, applyActionCards, refreshCard, setTitle };
}
