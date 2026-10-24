"use client";

import * as React from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/primitives";
import { DemoNotice } from "@/components/demo/shell";
import type { Notice } from "@/lib/demo/outcomes";
import { newClientMessageId, type RoomChatState, type RoomLine } from "@/lib/demo/room-types";

// The demo room's chat. Without scripts it is a plain form (a post to the demo API, then the page again); with scripts it sends the message as JSON and shows the conversation the
// server returns, so what is on screen (the lines, the messages left, whether another can be sent) comes from the record and never from a guess.
//
// A message that may not have arrived (the connection dropped) keeps its key, so pressing Send again can never count it twice.

export interface DemoChatProps {
  initial: RoomChatState;
  roles: ReadonlyArray<{ key: string; name: string }>;
  /** The key the form without scripts sends, made on the server so a second press of that form is the same message. */
  fallbackMessageId: string;
  /** What the page was sent back with after a form without scripts (a held message, a busy moment). */
  pageNotice: Notice | null;
}

const MAX = 1000;

function speaker(line: RoomLine, roles: DemoChatProps["roles"]): string {
  if (line.role === "user") return "You";
  const role = roles.find((r) => r.key === line.employeeRole);
  return role ? `${role.name} (AI)` : "AI assistant";
}

export function DemoChat({ initial, roles, fallbackMessageId, pageNotice }: DemoChatProps) {
  const [state, setState] = React.useState<RoomChatState>(initial);
  const [text, setText] = React.useState("");
  const [employee, setEmployee] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(pageNotice);
  const pendingKey = React.useRef<string | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.transcript.length]);

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

  return (
    <div className="space-y-3">
      <div
        ref={logRef}
        role="log"
        tabIndex={0}
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions"
        className="max-h-[55dvh] min-h-24 space-y-3 overflow-y-auto rounded-xl border border-line bg-surface-2/50 p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {state.transcript.length === 0 && <p className="text-[13.5px] text-muted">Nothing here yet. Ask a question about what the AI team does or what it costs.</p>}
        {state.transcript.map((l) => (
          <div key={l.id} className={l.role === "user" ? "ml-6" : "mr-6"}>
            <p className="text-[12px] font-medium text-muted">{speaker(l, roles)}</p>
            <p className={`mt-0.5 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[14px] leading-relaxed ${l.role === "user" ? "bg-primary-soft text-primary-ink" : "bg-surface text-ink ring-1 ring-inset ring-line"}`}>{l.body}</p>
            {l.state === "failed" && <p className="mt-1 text-[12px] text-warning-ink">Not counted: no answer came.</p>}
            {l.state === "pending" && <p className="mt-1 text-[12px] text-muted">Waiting for an answer.</p>}
          </div>
        ))}
      </div>

      <DemoNotice notice={notice} />

      {state.canSend ? (
        <form method="post" action="/api/public/demo/message" onSubmit={send} className="space-y-3">
          <input type="hidden" name="clientMessageId" value={fallbackMessageId} />
          <div className="space-y-1.5">
            <label htmlFor="demo-employee" className="text-[13px] font-medium text-ink-2">
              Ask
            </label>
            <Select id="demo-employee" name="employeeRole" value={employee} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">Any AI Employee</option>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="demo-message" className="text-[13px] font-medium text-ink-2">
              Your question
            </label>
            <Textarea
              ref={boxRef}
              id="demo-message"
              name="text"
              required
              rows={3}
              maxLength={MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="For example: what does the Appointment Setter do?"
              className="min-h-24"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" className="text-[13px] text-muted">
              {state.messagesLeft} of {state.messageAllowance} messages left
            </p>
            <Button type="submit" loading={sending}>
              <Send className="size-4" aria-hidden />
              {sending ? "Sending" : "Send"}
            </Button>
          </div>
        </form>
      ) : (
        <p role="status" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
          {state.refusalMessage ?? "Messages cannot be sent right now."}
        </p>
      )}
    </div>
  );
}
