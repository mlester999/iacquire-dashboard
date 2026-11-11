"use client";

import * as React from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand";
import { DemoNotice } from "@/components/demo/shell";
import { Markdown } from "@/components/markdown";
import type { Notice } from "@/lib/demo/outcomes";
import { newClientMessageId, type RoomChatState, type RoomLine } from "@/lib/demo/room-types";
import { SHORT_QUERY, useMediaQuery } from "@/components/demo/showroom/use-media";

// The demo room's chat. Without scripts it is a plain form (a post to the demo API, then the page again); with scripts it sends the message as JSON and shows the conversation the
// server returns, so what is on screen (the lines, the messages left, whether another can be sent) comes from the record and never from a guess.
//
// A message that may not have arrived (the connection dropped) keeps its key, so pressing Send again can never count it twice. A question put in the box from elsewhere on the page
// (a suggestion, a button on a feature) only fills the box: it is sent when the visitor presses Send, and only then does it count.
//
// While an answer is on its way the visitor's own message is already in the conversation (and the box is empty), and AQi is shown as writing. Legacy role attribution remains stored but is not shown in this single-guide demo. That message is only a picture of what was sent:
// the record the server returns replaces it, and if the message did not go through it goes back into the box.

export interface DemoChatProps {
  initial: RoomChatState;
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
  /** Told what the server returned after a message (the messages left, whether another can be sent), so the rest of the page can show the same number. */
  onRecord?: (chat: { messagesLeft: number; canSend: boolean }) => void;
  className?: string;
}

const MAX = 1000;

function speaker(line: RoomLine): string {
  return line.role === "user" ? "You" : "AQi";
}

/** AQi writes every new public demo answer. Said aloud once; the dots are only a picture. */
function Writing() {
  return (
    <div className="flex gap-2.5">
      <span className="mt-5 shrink-0" aria-hidden>
        <LogoMark className="size-6" title="AQi" />
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-muted" aria-hidden>
          AQi
        </p>
        <span className="sr-only">AQi is writing an answer.</span>
        <span aria-hidden className="sx-typing mt-0.5 inline-flex gap-1 rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-3 ring-1 ring-inset ring-line">
          <i className="size-1.5 rounded-full bg-muted" />
          <i className="size-1.5 rounded-full bg-muted" />
          <i className="size-1.5 rounded-full bg-muted" />
        </span>
      </div>
    </div>
  );
}

export function DemoChat({ initial, fallbackMessageId, pageNotice, draft = null, suggestions = [], closedFooter, onRecord, className }: DemoChatProps) {
  const [state, setState] = React.useState<RoomChatState>(initial);
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  /** The message on its way, shown under the single public demo guide. */
  const [outgoing, setOutgoing] = React.useState<{ body: string } | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(pageNotice);
  const pendingKey = React.useRef<string | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLTextAreaElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.transcript.length, sending, outgoing]);

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
    // The message shows at once and the box empties; anything that does not go through gives it back to the box, to be sent again with the same key.
    setOutgoing({ body });
    setText("");
    const giveBack = () => {
      setOutgoing(null);
      setText((current) => current || body);
    };
    try {
      const res = await fetch("/api/public/demo/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ text: body, clientMessageId: key }),
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
        if (json.room) {
          setState({ transcript: json.room.transcript, messagesLeft: json.room.messagesLeft, messageAllowance: json.room.messageAllowance, canSend: json.room.chat.canSend, refusalMessage: json.room.chat.refusalMessage });
          onRecord?.({ messagesLeft: json.room.messagesLeft, canSend: json.room.chat.canSend });
        }
        // The record now holds the message (and its answer), so the picture of it goes; a message that was given back (not counted) also returns to the box.
        setOutgoing(null);
        if (json.kind === "held") {
          setNotice({ tone: "error", text: json.message ?? "That message was not counted. Please try again." });
          setText((current) => current || body);
        }
      } else if (json?.error) {
        pendingKey.current = null;
        giveBack();
        const message = json.error.message ?? "That message could not be sent.";
        // A refusal that is about the demo itself (not a busy moment) ends the form, and the sentence takes its place: it is said once, where the form was.
        if (["limit_reached", "window_ended", "ai_off", "closed", "blocked", "not_verified", "no_session"].includes(json.error.code ?? "")) setState((s) => ({ ...s, canSend: false, refusalMessage: message }));
        else setNotice({ tone: "error", text: message });
      } else {
        giveBack();
        setNotice({ tone: "error", text: "We could not confirm your message was sent. Press Send again; it will not be counted twice." });
      }
    } catch {
      giveBack();
      setNotice({ tone: "error", text: "We could not confirm your message was sent. Check your connection and press Send again; it will not be counted twice." });
    } finally {
      setSending(false);
      boxRef.current?.focus();
    }
  }

  const low = state.canSend && state.messagesLeft > 0 && state.messagesLeft <= 2;
  const short = useMediaQuery(SHORT_QUERY);

  return (
    <div className={cn("flex min-h-0 flex-col gap-3 [@media(max-height:500px)]:gap-2", className)}>
      <div
        ref={logRef}
        role="log"
        tabIndex={0}
        aria-label="AQi conversation"
        aria-live="polite"
        aria-relevant="additions"
        className="sx-scroll min-h-24 [@media(max-height:500px)]:min-h-16 flex-1 space-y-4 overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface-2/60 p-3.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-40"
      >
        {state.transcript.length === 0 && (
          <div className="space-y-3 py-1">
            <p className="text-[14px] leading-relaxed text-ink-2">Nothing here yet. Ask AQi about the AI Growth Partner, iAcquireOS or current pricing.</p>
            {/* The starter questions live in the scrolling part, not above the question box: on a short phone the box (and the Send button) must never be pushed out of reach by them. */}
            {state.canSend && suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions" role="group">
                {suggestions.map((q) => (
                  <button key={q} type="button" onClick={() => { setText(q); boxRef.current?.focus(); }} className="sx-btn-quiet min-h-11 rounded-full px-3.5 py-2 text-left text-[13px] font-medium leading-snug sm:min-h-0 sm:px-3 sm:py-1.5 sm:text-[12.5px]">
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {state.transcript.map((l) => (
          <div key={l.id} className={cn("flex gap-2.5", l.role === "user" ? "flex-row-reverse" : "")}>
            {l.role !== "user" && (
              <span className="mt-5 shrink-0" aria-hidden>
                <LogoMark className="size-6" title="AQi" />
              </span>
            )}
            <div className={cn("min-w-0 max-w-[88%]", l.role === "user" ? "text-right" : "")}>
              <p className="text-[12px] font-medium text-muted">{speaker(l)}</p>
              {l.role === "user" ? (
                <p className="mt-0.5 whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-gradient-to-br from-[#3856e8] to-[#6945e2] px-3.5 py-2.5 text-left text-[14px] leading-relaxed text-white">
                  {l.body}
                </p>
              ) : (
                <div className="mt-0.5 break-words rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5 text-left text-ink ring-1 ring-inset ring-line">
                  <Markdown className="prose-aqi">{l.body}</Markdown>
                </div>
              )}
              {l.state === "failed" && <p className="mt-1 text-[12px] text-warning-ink">Not counted: no answer came.</p>}
              {l.state === "pending" && <p className="mt-1 text-[12px] text-muted">Waiting for an answer.</p>}
            </div>
          </div>
        ))}
        {outgoing && (
          <>
            {/* A picture of what was just sent: hidden from assistive technology, which hears the record's own line once the answer comes back. */}
            <div className="flex flex-row-reverse gap-2.5" aria-hidden>
              <div className="min-w-0 max-w-[88%] text-right">
                <p className="text-[12px] font-medium text-muted">You</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-gradient-to-br from-[#3856e8] to-[#6945e2] px-3.5 py-2.5 text-left text-[14px] leading-relaxed text-white">{outgoing.body}</p>
              </div>
            </div>
            <Writing />
          </>
        )}
      </div>

      <DemoNotice notice={notice} />

      {state.canSend ? (
        <form ref={formRef} method="post" action="/api/public/demo/message" onSubmit={send} className="shrink-0 space-y-2.5 [@media(max-height:500px)]:space-y-1.5">
          <input type="hidden" name="clientMessageId" value={fallbackMessageId} />
          <div className="flex items-center gap-2">
            <label htmlFor="demo-message" className="shrink-0 text-[13px] font-medium text-muted">Ask AQi</label>
            <span className="text-[12px] text-muted">iAcquire guide</span>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="demo-message" className="sr-only">
              Your question
            </label>
            <div className="demo-chat-composer flex items-end gap-2 rounded-2xl border border-line-strong bg-surface-2/80 p-2 focus-within:border-primary-hover focus-within:shadow-[var(--glow)]">
              <textarea
                ref={boxRef}
                id="demo-message"
                name="text"
                required
                rows={2}
                maxLength={MAX}
                value={text}
                readOnly={sending}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
                placeholder={short ? "Ask about the Growth Partner or pricing" : "For example: how does the Growth Partner use the CRM?"}
                className="max-h-32 min-h-11 [@media(max-height:500px)]:h-11 [@media(max-height:500px)]:max-h-11 flex-1 resize-none bg-transparent px-2 py-1.5 text-[16px] leading-relaxed text-ink outline-none sm:text-[14px] placeholder:text-faint focus-visible:outline-none focus-visible:ring-0"
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
