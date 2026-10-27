"use client";

import * as React from "react";
import { Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { DemoNotice } from "@/components/demo/shell";
import type { Notice } from "@/lib/demo/outcomes";
import { newClientMessageId, type RoomChatState, type RoomLine } from "@/lib/demo/room-types";

// The demo room's chat. Without scripts it is a plain form (a post to the demo API, then the page again); with scripts it sends the message as JSON and shows the conversation the
// server returns, so what is on screen (the lines, the messages left, whether another can be sent) comes from the record and never from a guess.
//
// A message that may not have arrived (the connection dropped) keeps its key, so pressing Send again can never count it twice. A question put in the box from elsewhere on the page
// (a suggestion, a button on a feature) only fills the box: it is sent when the visitor presses Send, and only then does it count.

export interface DemoChatProps {
  initial: RoomChatState;
  roles: ReadonlyArray<{ key: string; name: string }>;
  /** The key the form without scripts sends, made on the server so a second press of that form is the same message. */
  fallbackMessageId: string;
  /** What the page was sent back with after a form without scripts (a held message, a busy moment). */
  pageNotice: Notice | null;
  /** A question to put in the box (not send). A new `nonce` puts it there again. */
  draft?: { text: string; nonce: number } | null;
  /** Questions to offer as buttons that fill the box. */
  suggestions?: readonly string[];
  /** Shown under the sentence that says why a message cannot be sent (for example, a way to talk to a person). */
  closedFooter?: React.ReactNode;
  className?: string;
}

const MAX = 1000;

function speaker(line: RoomLine, roles: DemoChatProps["roles"]): string {
  if (line.role === "user") return "You";
  const role = roles.find((r) => r.key === line.employeeRole);
  return role ? `${role.name} (AI)` : "AI assistant";
}

const isRole = (k: string | null): k is AgentRoleKey => !!k && k in AGENT_BY_KEY;

export function DemoChat({ initial, roles, fallbackMessageId, pageNotice, draft = null, suggestions = [], closedFooter, className }: DemoChatProps) {
  const [state, setState] = React.useState<RoomChatState>(initial);
  const [text, setText] = React.useState("");
  const [employee, setEmployee] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(pageNotice);
  const pendingKey = React.useRef<string | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLTextAreaElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.transcript.length, sending]);

  // A question put in the box from elsewhere: only a new nonce is a new draft, so the same question can be asked for again. It fills the box when the form is open and sends nothing.
  const nonce = draft?.nonce;
  const [seenNonce, setSeenNonce] = React.useState(nonce);
  if (draft && nonce !== seenNonce) {
    setSeenNonce(nonce);
    if (state.canSend) setText(draft.text.slice(0, MAX));
  }
  React.useEffect(() => {
    if (nonce !== undefined && boxRef.current) boxRef.current.focus();
  }, [nonce]);

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (!body || sending || !state.canSend) return;
    const key = pendingKey.current ?? newClientMessageId();
    pendingKey.current = key;
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/public/demo/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ text: body, clientMessageId: key, employeeRole: employee }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        kind?: string;
        message?: string;
        error?: { code?: string; message?: string };
        room?: { transcript: RoomLine[]; messagesLeft: number; messageAllowance: number; chat: { canSend: boolean; refusalMessage: string | null } } | null;
      } | null;
      if (json?.ok) {
        // The server answered for this key, so the next message is a new one.
        pendingKey.current = null;
        if (json.room) setState({ transcript: json.room.transcript, messagesLeft: json.room.messagesLeft, messageAllowance: json.room.messageAllowance, canSend: json.room.chat.canSend, refusalMessage: json.room.chat.refusalMessage });
        if (json.kind === "held") setNotice({ tone: "error", text: json.message ?? "That message was not counted. Please try again." });
        else setText("");
      } else if (json?.error) {
        pendingKey.current = null;
        const message = json.error.message ?? "That message could not be sent.";
        // A refusal that is about the demo itself (not a busy moment) ends the form, and the sentence takes its place: it is said once, where the form was.
        if (["limit_reached", "window_ended", "ai_off", "closed", "blocked", "not_verified", "no_session"].includes(json.error.code ?? "")) setState((s) => ({ ...s, canSend: false, refusalMessage: message }));
        else setNotice({ tone: "error", text: message });
      } else {
        setNotice({ tone: "error", text: "We could not confirm your message was sent. Press Send again; it will not be counted twice." });
      }
    } catch {
      setNotice({ tone: "error", text: "We could not confirm your message was sent. Check your connection and press Send again; it will not be counted twice." });
    } finally {
      setSending(false);
      boxRef.current?.focus();
    }
  }

  const low = state.canSend && state.messagesLeft > 0 && state.messagesLeft <= 2;

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div
        ref={logRef}
        role="log"
        tabIndex={0}
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions"
        className="sx-scroll min-h-40 flex-1 space-y-4 overflow-y-auto rounded-2xl border border-line bg-black/20 p-3.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {state.transcript.length === 0 && (
          <div className="space-y-3 py-1">
            <p className="text-[14px] leading-relaxed text-ink-2">Nothing here yet. Ask a question about what the AI team does or what it costs.</p>
          </div>
        )}
        {state.transcript.map((l) => (
          <div key={l.id} className={cn("flex gap-2.5", l.role === "user" ? "flex-row-reverse" : "")}>
            {l.role !== "user" && (
              <span className="mt-5 shrink-0">
                {isRole(l.employeeRole) ? (
                  <AgentAvatar role={AGENT_BY_KEY[l.employeeRole]} size="xs" eager />
                ) : (
                  <span className="grid size-6 place-items-center rounded-lg bg-gradient-to-br from-primary to-violet text-primary-on" aria-hidden>
                    <Sparkles className="size-3.5" />
                  </span>
                )}
              </span>
            )}
            <div className={cn("min-w-0 max-w-[88%]", l.role === "user" ? "text-right" : "")}>
              <p className="text-[12px] font-medium text-muted">{speaker(l, roles)}</p>
              <p
                className={cn(
                  "mt-0.5 whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-left text-[14px] leading-relaxed",
                  l.role === "user" ? "rounded-tr-md bg-gradient-to-br from-[#3856e8] to-[#6945e2] text-white" : "rounded-tl-md bg-surface-2 text-ink ring-1 ring-inset ring-line",
                )}
              >
                {l.body}
              </p>
              {l.state === "failed" && <p className="mt-1 text-[12px] text-warning-ink">Not counted: no answer came.</p>}
              {l.state === "pending" && <p className="mt-1 text-[12px] text-muted">Waiting for an answer.</p>}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2.5" aria-hidden>
            <span className="grid size-6 place-items-center rounded-lg bg-gradient-to-br from-primary to-violet text-primary-on">
              <Sparkles className="size-3.5" />
            </span>
            <span className="sx-typing inline-flex gap-1 rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-3 ring-1 ring-inset ring-line">
              <i className="size-1.5 rounded-full bg-muted" />
              <i className="size-1.5 rounded-full bg-muted" />
              <i className="size-1.5 rounded-full bg-muted" />
            </span>
          </div>
        )}
      </div>

      <DemoNotice notice={notice} />

      {state.canSend ? (
        <form ref={formRef} method="post" action="/api/public/demo/message" onSubmit={send} className="space-y-2.5">
          <input type="hidden" name="clientMessageId" value={fallbackMessageId} />
          {suggestions.length > 0 && state.transcript.length === 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions" role="group">
              {suggestions.map((q) => (
                <button key={q} type="button" onClick={() => { setText(q); boxRef.current?.focus(); }} className="sx-btn-quiet rounded-full px-3 py-1.5 text-left text-[12.5px] font-medium leading-snug">
                  {q}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="demo-employee" className="shrink-0 text-[13px] font-medium text-muted">
              Ask
            </label>
            <select
              id="demo-employee"
              name="employeeRole"
              value={employee}
              onChange={(e) => setEmployee(e.target.value)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <option value="">Any AI Employee</option>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="demo-message" className="sr-only">
              Your question
            </label>
            <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface-2/80 p-2 focus-within:border-primary-hover focus-within:shadow-[var(--glow)]">
              <textarea
                ref={boxRef}
                id="demo-message"
                name="text"
                required
                rows={2}
                maxLength={MAX}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
                placeholder="For example: what does the Appointment Setter do?"
                className="max-h-32 min-h-11 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint"
              />
              <button type="submit" disabled={sending} aria-label={sending ? "Sending" : "Send"} className="sx-btn-primary grid size-11 shrink-0 place-items-center rounded-xl disabled:opacity-60">
                <Send className="size-[18px]" aria-hidden />
                <span className="sr-only">{sending ? "Sending" : "Send"}</span>
              </button>
            </div>
          </div>
          <p aria-live="polite" className={cn("text-[13px]", low ? "font-medium text-warning-ink" : "text-muted")}>
            {state.messagesLeft} of {state.messageAllowance} messages left
          </p>
        </form>
      ) : (
        <div className="space-y-3">
          <p role="status" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
            {state.refusalMessage ?? "Messages cannot be sent right now."}
          </p>
          {closedFooter}
        </div>
      )}
    </div>
  );
}
