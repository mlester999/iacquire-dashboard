"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUp, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BuilderChat, ChatItem } from "@/components/automation-studio/chat/use-builder-chat";

const FOLLOW_UPS = ["Explain what this automation does", "What could go wrong with it?", "Add a short wait before the next step", "Why did this workflow fail?"];

function Bubble({ item }: { item: ChatItem }) {
  const mine = item.role === "user";
  const typing = item.streaming && !item.content;
  return (
    <div className={cn("flex gap-2.5", mine && "justify-end")} data-role={item.role} data-status={item.status}>
      {!mine && <span aria-hidden className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full brand-gradient text-white"><Sparkles className="size-3.5" /></span>}
      <div className={cn("max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed", mine ? "rounded-br-md bg-primary text-primary-on" : item.status === "error" || item.status === "refused" ? "rounded-bl-md border border-warning/30 bg-warning-soft text-warning-ink" : "rounded-bl-md border border-line bg-surface text-ink")}>
        {typing ? (
          <span className="inline-flex items-center gap-1 py-1" role="status" aria-label="The builder is writing"><i className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]" /><i className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]" /><i className="size-1.5 animate-bounce rounded-full bg-muted" /></span>
        ) : (
          <p className="whitespace-pre-wrap break-words">{item.content}{item.streaming && <span aria-hidden className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-current" />}</p>
        )}
        {mine && item.nodeKey && <p className="mt-1 text-[12px] opacity-80">About the selected step</p>}
        {!mine && item.status === "applied" && item.changes && item.changes.length > 0 && !item.streaming && <p className="mt-1.5 text-[12px] font-medium text-success-ink">Updated the canvas</p>}
        {item.notice?.code === "plan_required" && <Link href="/automation-studio" className="mt-1.5 inline-block text-[12px] font-medium underline">See what Automation Studio includes</Link>}
      </div>
    </div>
  );
}

export interface ChatPanelProps {
  chat: BuilderChat;
  /** The selected step's name, when one is selected. */
  selectedLabel: string | null;
  onClearSelection: () => void;
  selectedKey: string | null;
  /** Why the builder can't be used right now (not connected, plan lapsed, archived), or null. */
  unavailable: string | null;
  className?: string;
  autoFocus?: boolean;
}

export function ChatPanel({ chat, selectedLabel, onClearSelection, selectedKey, unavailable, className, autoFocus }: ChatPanelProps) {
  const [text, setText] = React.useState("");
  const box = React.useRef<HTMLTextAreaElement>(null);
  const log = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);

  React.useEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.items]);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);
  React.useEffect(() => { if (autoFocus) box.current?.focus({ preventScroll: true }); }, [autoFocus]);

  const submit = async (value = text) => {
    if (!value.trim() || chat.busy || unavailable) return;
    setText("");
    pinned.current = true;
    await chat.send(value, selectedKey);
    box.current?.focus({ preventScroll: true });
  };
  const disabled = chat.busy || Boolean(unavailable);
  const showFollowUps = !chat.busy && !unavailable && chat.items.length > 0 && chat.items.length < 8;

  return (
    <section aria-label="AI Automation Builder" className={cn("flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-surface", className)}>
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
        <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-xl brand-gradient text-white"><Sparkles className="size-4" /></span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink">AI Automation Builder</h2>
          <p className="truncate text-[12px] text-muted">Tell me what to build or change. I edit the draft; nothing goes out until you publish it.</p>
        </div>
      </header>

      <div
        ref={log}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation with the builder"
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {chat.items.length === 0 && (
          <div className="rounded-2xl border border-dashed border-line-strong bg-surface-2 p-4 text-[13px] leading-relaxed text-muted">
            <p className="font-medium text-ink">Describe the automation in your own words.</p>
            <p className="mt-1">For example: “When a new lead comes in, create a task for the owner and, two days later, remind us if nobody has followed up.” You can change it afterwards just by saying so.</p>
          </div>
        )}
        {chat.items.map((item) => <Bubble key={item.key} item={item} />)}
        {chat.busy && chat.status && (
          <p className="flex items-center gap-2 pl-9 text-[12px] text-muted" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden />{chat.status}</p>
        )}
      </div>

      <div className="shrink-0 border-t border-line bg-surface p-3">
        {unavailable && <p className="mb-2 rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] leading-snug text-warning-ink" role="note">{unavailable}</p>}
        {showFollowUps && (
          <div role="group" className="mb-2 flex flex-wrap gap-1.5" aria-label="Suggestions">
            {FOLLOW_UPS.map((s) => <button key={s} type="button" onClick={() => void submit(s)} className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-primary hover:text-primary">{s}</button>)}
          </div>
        )}
        {selectedLabel && (
          <div className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-primary-soft py-1 pl-2.5 pr-1 text-[12px] font-medium text-primary-ink">
            <span className="truncate">Talking about: {selectedLabel}</span>
            <button type="button" onClick={onClearSelection} aria-label="Stop talking about this step" className="inline-flex size-5 items-center justify-center rounded-full hover:bg-primary/15"><X className="size-3" aria-hidden /></button>
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface-2 p-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <label htmlFor="studio-chat-input" className="sr-only">Message the builder</label>
          <textarea
            id="studio-chat-input"
            ref={box}
            rows={1}
            value={text}
            disabled={Boolean(unavailable)}
            placeholder={selectedLabel ? `What should change about “${selectedLabel}”?` : "What would you like to build or change?"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
            maxLength={4000}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2.5 py-2 text-[14px] text-ink outline-none placeholder:text-faint disabled:opacity-60"
          />
          <Button type="submit" size="icon-sm" disabled={disabled || !text.trim()} aria-label="Send message" className="shrink-0"><ArrowUp className="size-4" aria-hidden /></Button>
        </form>
      </div>
    </section>
  );
}
