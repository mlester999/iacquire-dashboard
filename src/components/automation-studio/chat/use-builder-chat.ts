"use client";

import * as React from "react";
import type { WorkflowChange } from "@/lib/crm/workflow/operations";
import type { BuilderEvent, MessageStatus, StudioMessage } from "@/lib/automation-studio/types";
import type { StudioEditor } from "@/components/automation-studio/editor/use-studio-editor";

/**
 * The conversation with the AI Automation Builder, as the page sees it. A message goes to the builder's endpoint; the reply streams in as it is
 * written; when the server reports that a change was validated and saved, the editor replays it onto the canvas. The text the person finally sees
 * is the one the server stored. Nothing is shown as done until the server says it is.
 */

export interface ChatItem {
  /** React key: stable across the optimistic message, the streaming one and the stored one. */
  key: string;
  id: number | null;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  streaming: boolean;
  nodeKey: string | null;
  changes: WorkflowChange[] | null;
  /** A notice from the app rather than the builder (a limit, a missing connection). */
  notice?: { code: string } | null;
}

export const toItem = (m: StudioMessage): ChatItem => ({ key: `m${m.id}`, id: m.id, role: m.role, content: m.content, status: m.status, streaming: false, nodeKey: m.nodeKey, changes: m.changes, notice: null });

export interface BuilderChat {
  items: ChatItem[];
  /** A turn is in progress (the workflow is locked to edits until it ends). */
  busy: boolean;
  /** What the builder is really doing right now, or null. */
  status: string | null;
  send: (text: string, selectedKey: string | null) => Promise<boolean>;
}

export function useBuilderChat(opts: { workflowId: string; initial: StudioMessage[]; editor: StudioEditor; available: boolean; onApplied?: () => void }): BuilderChat {
  const { workflowId, editor, available, onApplied } = opts;
  const [items, setItems] = React.useState<ChatItem[]>(() => opts.initial.map(toItem));
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const alive = React.useRef(true);
  const counter = React.useRef(0);
  const resumed = React.useRef(false);
  const editorRef = React.useRef(editor);
  editorRef.current = editor;
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const patch = React.useCallback((key: string, p: Partial<ChatItem>) => {
    if (alive.current) setItems((all) => all.map((i) => (i.key === key ? { ...i, ...p } : i)));
  }, []);
  const add = React.useCallback((item: ChatItem) => {
    if (alive.current) setItems((all) => [...all, item]);
  }, []);

  const turn = React.useCallback(async (body: { message?: string; selectedKey?: string | null; resume?: boolean }, placeholderUserKey: string | null): Promise<boolean> => {
    const n = ++counter.current;
    const replyKey = `reply${n}`;
    add({ key: replyKey, id: null, role: "assistant", content: "", status: "answered", streaming: true, nodeKey: null, changes: null });
    setBusy(true);
    setStatus("Sending…");
    editorRef.current.setLocked(true);
    let ok = true;
    try {
      const res = await fetch(`/api/automation-studio/${workflowId}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        patch(replyKey, { content: err?.error ?? "I couldn't reach the builder. Nothing was changed.", status: "error", streaming: false, notice: { code: err?.code ?? "error" } });
        // A refused request stored nothing, so the person's optimistic message goes too (they can send it again).
        if (placeholderUserKey && alive.current) setItems((all) => all.filter((i) => i.key !== placeholderUserKey));
        return false;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamed = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let ev: BuilderEvent;
          try {
            ev = JSON.parse(data) as BuilderEvent;
          } catch {
            continue;
          }
          switch (ev.type) {
            case "start":
              if (placeholderUserKey) patch(placeholderUserKey, { id: ev.messageId });
              break;
            case "status":
              if (alive.current) setStatus(ev.text);
              break;
            case "delta":
              streamed += ev.text;
              patch(replyKey, { content: streamed });
              break;
            case "applied":
              if (alive.current) setStatus("Updating your workflow…");
              await editorRef.current.replay(ev.operations, ev.definition, ev.revision, ev.summary.join(" ") || "Changed by the AI Builder");
              onApplied?.();
              break;
            case "refused":
              // The reply that streamed described a change that was not made: it is replaced by the honest one the server stored.
              streamed = "";
              patch(replyKey, { content: ev.message, status: "refused" });
              break;
            case "error":
              ok = false;
              patch(replyKey, { content: ev.message, status: "error", notice: { code: ev.code } });
              break;
            case "done":
              patch(replyKey, { id: ev.message.id, content: ev.message.content, status: ev.message.status, changes: ev.message.changes, streaming: false });
              if (placeholderUserKey) patch(placeholderUserKey, { status: "answered" });
              break;
          }
        }
      }
      patch(replyKey, { streaming: false });
    } catch {
      ok = false;
      patch(replyKey, { content: "The connection was interrupted before the builder finished. Nothing is lost: your message is saved and the builder will answer it when you reopen this workflow.", status: "error", streaming: false });
    } finally {
      editorRef.current.setLocked(false);
      if (alive.current) {
        setBusy(false);
        setStatus(null);
      }
    }
    return ok;
  }, [workflowId, add, patch, onApplied]);

  const send = React.useCallback(async (text: string, selectedKey: string | null) => {
    const message = text.trim();
    if (!message || busy) return false;
    // The builder reads the saved workflow: whatever was changed by hand has to be saved first.
    if (!(await editorRef.current.flush())) {
      add({ key: `note${++counter.current}`, id: null, role: "assistant", content: "I couldn't save your latest changes, so I'd be working from an older version. Reload the page, then ask me again.", status: "error", streaming: false, nodeKey: null, changes: null, notice: { code: "save_failed" } });
      return false;
    }
    const userKey = `user${++counter.current}`;
    add({ key: userKey, id: null, role: "user", content: message, status: "pending", streaming: false, nodeKey: selectedKey, changes: null });
    return turn({ message, selectedKey }, userKey);
  }, [busy, add, turn]);

  // A message that was stored but never answered (the page was closed, or it started this workflow) is answered when the workflow opens.
  React.useEffect(() => {
    if (resumed.current || !available) return;
    const last = opts.initial[opts.initial.length - 1];
    if (!last || last.role !== "user" || last.status !== "pending") return;
    resumed.current = true;
    queueMicrotask(() => void turn({ resume: true }, `m${last.id}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  return { items, busy, status, send };
}
