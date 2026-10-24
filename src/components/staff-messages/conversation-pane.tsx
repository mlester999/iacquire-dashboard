"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ChevronLeft, Hash, Info, Loader2, Lock, RefreshCw, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AvatarTile } from "@/components/ui/status";
import { cn } from "@/lib/utils";
import type { ConversationView } from "@/server/staff-messages/conversations";
import type { MessageView } from "@/server/staff-messages/messages";
import type { ChosenMention, PendingMessage } from "@/lib/staff-messages/composer";
import { plainMentions } from "@/lib/staff-messages/mentions";
import { canRetry, failureText } from "@/lib/staff-messages/pending";
import { isNearBottom, scrollPlan } from "@/lib/staff-messages/scroll";
import { conversationHref, headerSubtitle, messageAllowances, MESSAGES_HOME, railTitle, timeline } from "@/lib/staff-messages/view";
import type { Reaction } from "@/lib/staff-messages/reactions";
import { Composer } from "@/components/staff-messages/composer";
import { MessageRow } from "@/components/staff-messages/message-row";
import { CONVERSATION_GONE_TEXT, CONVERSATION_GONE_TITLE } from "@/components/staff-messages/text";

// The open conversation: its header, its messages by day and by run of one author, the unread marker, messages being sent, and the message box. It draws what it is given and
// reports what the person does; the page decides what happens. Scrolling follows the rules in src/lib/staff-messages/scroll.ts: new messages follow a person who is at the
// bottom and never pull one who is reading up the page, and older messages loaded above do not move what is being read.

export interface PaneActions {
  onOpenThread: (message: MessageView) => void;
  onStartEdit: (message: MessageView) => void;
  onCancelEdit: () => void;
  onSaveEdit: (message: MessageView, body: string) => Promise<{ ok: true } | { ok: false; error: string; code: string }>;
  onDelete: (message: MessageView) => void;
  onReact: (message: MessageView, reaction: Reaction, on: boolean) => void;
  onSend: (message: PendingMessage) => void;
  onRetry: (clientId: string) => void;
  onDiscardPending: (clientId: string) => void;
  onLoadOlder: () => void;
  onOpenDetails: () => void;
  onSearch: () => void;
  onJoin: () => void;
  onJumpToLatest: () => void;
  onAtBottomChange: (atBottom: boolean) => void;
}

export interface ConversationPaneProps {
  view: ConversationView | null | undefined;
  messages: readonly MessageView[];
  hasMore: boolean;
  loadingOlder: boolean;
  pending: readonly PendingMessage[];
  names: ReadonlyMap<string, string>;
  mentionable: readonly ChosenMention[];
  me: { id: string; canChannels: boolean; canModerate: boolean; timeZone: string };
  now: number;
  /** What the person had read when they opened the conversation, for the "New messages" marker (null when nothing was unread). */
  markerAfterSeq: number | null;
  /** A message to scroll to and mark (a search hit). */
  highlightSeq: number | null;
  /** The window shows messages around an older one, not the newest. */
  readingAround: boolean;
  editingId: string | null;
  busyJoin: boolean;
  actions: PaneActions;
}

function Title({ view }: { view: ConversationView }) {
  const c = view.conversation;
  const Icon = c.kind === "channel" ? (c.visibility === "private" ? Lock : Hash) : c.kind === "group" ? Users : null;
  return (
    <span className="flex min-w-0 items-center gap-3">
      {Icon ? (
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-3 text-ink-2">
          <Icon className="size-4" />
        </span>
      ) : (
        <AvatarTile name={c.name || "?"} />
      )}
      <span className="min-w-0">
        <span className="block truncate text-[16px] font-semibold tracking-tight text-ink">{railTitle({ kind: c.kind, name: c.name })}</span>
        <span className="block truncate text-[12.5px] text-muted">{headerSubtitle({ kind: c.kind, topic: c.topic, memberCount: view.memberCount, archived: c.archived })}</span>
      </span>
    </span>
  );
}

export function ConversationPane(props: ConversationPaneProps) {
  const { view, messages, hasMore, loadingOlder, pending, names, mentionable, me, now, markerAfterSeq, highlightSeq, readingAround, editingId, busyJoin, actions } = props;
  const scroller = React.useRef<HTMLDivElement>(null);
  const atBottom = React.useRef(true);
  const previous = React.useRef<{ firstId: string | null; lastId: string | null; pendingCount: number; height: number } | null>(null);
  const [showJump, setShowJump] = React.useState(false);
  const { onAtBottomChange } = actions;

  const items = React.useMemo(() => timeline(messages, { now, timeZone: me.timeZone, afterSeq: markerAfterSeq }), [messages, now, me.timeZone, markerAfterSeq]);
  const firstId = messages[0]?.id ?? null;
  const lastId = messages[messages.length - 1]?.id ?? null;
  const lastMine = messages[messages.length - 1]?.authorId === me.id || pending.length > 0;

  // After every change to what is shown: decide where the scroll goes, from facts measured before the change (the last scroll event) and after it.
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const before = previous.current;
    const plan = scrollPlan({
      initial: before === null,
      wasAtBottom: atBottom.current,
      appendedNewest: before !== null && (lastId !== before.lastId || pending.length > before.pendingCount),
      prependedOlder: before !== null && firstId !== before.firstId && lastId === before.lastId,
      ownMessage: lastMine,
    });
    if (before === null) {
      const target = (highlightSeq !== null && el.querySelector(`[data-seq="${highlightSeq}"]`)) || el.querySelector('[data-marker="unread"]');
      if (target) (target as HTMLElement).scrollIntoView({ block: highlightSeq !== null ? "center" : "start" });
      else el.scrollTop = el.scrollHeight;
    } else if (plan === "bottom") el.scrollTop = el.scrollHeight;
    else if (plan === "keep-position") el.scrollTop += el.scrollHeight - before.height;
    previous.current = { firstId, lastId, pendingCount: pending.length, height: el.scrollHeight };
    const near = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    atBottom.current = near;
    onAtBottomChange(near);
    setShowJump(!near);
  }, [firstId, lastId, pending.length, lastMine, highlightSeq, onAtBottomChange, items.length]);

  if (view === null || view === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-16 items-center gap-2 border-b border-line px-3">
          <Link href={MESSAGES_HOME} className="inline-flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 md:hidden" aria-label="Back to conversations">
            <ChevronLeft className="size-5" aria-hidden />
          </Link>
          <h2 className="text-[16px] font-semibold text-ink">Conversation</h2>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center" role="status">
          <Info className="size-6 text-muted" aria-hidden />
          <h3 className="text-[16px] font-semibold text-ink">{CONVERSATION_GONE_TITLE}</h3>
          <p className="max-w-sm text-[13.5px] leading-relaxed text-muted">{CONVERSATION_GONE_TEXT}</p>
          <Link href={MESSAGES_HOME} className="mt-2 text-[13px] font-medium text-primary-ink underline">Back to your conversations</Link>
        </div>
      </div>
    );
  }

  const c = view.conversation;
  const member = c.memberRole !== null;
  const caps = { channels: me.canChannels, moderate: me.canModerate };
  const label = `Message ${railTitle({ kind: c.kind, name: c.name })}`;
  const blocked = c.archived ? "This conversation is archived. Bring it back from its details to write in it." : !view.can.post ? "You can't write in this conversation." : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-16 items-center gap-1 border-b border-line px-2 sm:px-3">
        <Link href={MESSAGES_HOME} className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 md:hidden" aria-label="Back to conversations">
          <ChevronLeft className="size-5" aria-hidden />
        </Link>
        <h2 className="min-w-0 flex-1">
          <Title view={view} />
        </h2>
        <Button variant="ghost" size="icon" aria-label="Search messages" onClick={actions.onSearch}>
          <Search className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Conversation details" onClick={actions.onOpenDetails}>
          <Info className="size-4" aria-hidden />
        </Button>
      </header>

      {!member ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <h3 className="text-[16px] font-semibold text-ink">You haven&apos;t joined this channel</h3>
          <p className="max-w-sm text-[13.5px] leading-relaxed text-muted">
            It is open to the whole team. Join to read what has been said and to write in it{view.memberCount > 0 ? ` (${view.memberCount} ${view.memberCount === 1 ? "person is" : "people are"} in it)` : ""}.
          </p>
          {view.can.join && <Button onClick={actions.onJoin} loading={busyJoin}>Join {railTitle({ kind: c.kind, name: c.name })}</Button>}
        </div>
      ) : (
        <>
          {c.archived && (
            <p className="border-b border-line bg-warning-soft px-4 py-2 text-[13px] text-warning-ink" role="status">
              This conversation is archived. Nothing new can be written in it.
            </p>
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroller}
              role="log"
              aria-label={`Messages in ${railTitle({ kind: c.kind, name: c.name })}`}
              aria-relevant="additions"
              tabIndex={0}
              onScroll={(e) => {
                const el = e.currentTarget;
                const near = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
                if (near !== atBottom.current) {
                  atBottom.current = near;
                  onAtBottomChange(near);
                  setShowJump(!near);
                }
              }}
              className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            >
              {hasMore && (
                <div className="flex justify-center px-3 py-2">
                  <Button variant="secondary" size="sm" onClick={actions.onLoadOlder} loading={loadingOlder}>
                    Show older messages
                  </Button>
                </div>
              )}
              {!hasMore && messages.length === 0 && pending.length === 0 && (
                <p className="px-6 py-10 text-center text-[13.5px] text-muted">No messages yet. Write the first one below.</p>
              )}
              <ul className="space-y-0">
                {items.map((item) => {
                  if (item.type === "day") {
                    return (
                      <li key={item.key} role="separator" aria-label={item.label} className="flex items-center gap-3 px-4 py-3">
                        <span className="h-px flex-1 bg-line" aria-hidden />
                        <span className="text-[12px] font-medium text-muted">{item.label}</span>
                        <span className="h-px flex-1 bg-line" aria-hidden />
                      </li>
                    );
                  }
                  if (item.type === "unread") {
                    return (
                      <li key={item.key} data-marker="unread" role="separator" aria-label="New messages" className="flex items-center gap-3 px-4 py-2">
                        <span className="h-px flex-1 bg-danger/40" aria-hidden />
                        <span className="text-[12px] font-semibold text-danger-ink">New messages</span>
                        <span className="h-px flex-1 bg-danger/40" aria-hidden />
                      </li>
                    );
                  }
                  const m = item.message;
                  return (
                    <MessageRow
                      key={item.key}
                      message={m}
                      header={item.header}
                      names={names}
                      selfId={me.id}
                      timeZone={me.timeZone}
                      allow={messageAllowances({ kind: c.kind, visibility: c.visibility, archived: c.archived, memberRole: c.memberRole }, caps, me.id, { authorId: m.authorId, deleted: m.deleted })}
                      highlighted={highlightSeq !== null && m.seq === highlightSeq}
                      editing={editingId === m.id}
                      onOpenThread={actions.onOpenThread}
                      onStartEdit={actions.onStartEdit}
                      onCancelEdit={actions.onCancelEdit}
                      onSaveEdit={actions.onSaveEdit}
                      onDelete={actions.onDelete}
                      onReact={actions.onReact}
                    />
                  );
                })}
                {pending.map((p) => (
                  <li key={p.clientId} data-pending={p.clientId} className="flex gap-3 px-3 py-1">
                    <div className="w-9 shrink-0" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className={cn("whitespace-pre-wrap break-words text-[15px] leading-relaxed [overflow-wrap:anywhere]", p.status === "sending" ? "text-ink-2" : "text-ink")}>{plainMentions(p.body, (id) => names.get(id) ?? null)}</p>
                      {p.attachments.length > 0 && <p className="text-[12.5px] text-muted">{p.attachments.length} {p.attachments.length === 1 ? "file" : "files"}</p>}
                      {p.status === "sending" ? (
                        <p className="flex items-center gap-1.5 text-[12.5px] text-muted" role="status">
                          <Loader2 className="size-3 animate-spin" aria-hidden /> Sending…
                        </p>
                      ) : (
                        <div role="alert" className="mt-1 space-y-1">
                          <p className="text-[12.5px] text-danger-ink">{failureText(p.error, p.errorCode)}</p>
                          <div className="flex flex-wrap gap-2">
                            {canRetry(p.errorCode) && (
                              <Button size="sm" variant="secondary" onClick={() => actions.onRetry(p.clientId)}>
                                <RefreshCw className="size-3.5" aria-hidden /> Try again
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => actions.onDiscardPending(p.clientId)}>Discard</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {showJump && !readingAround && (
              <Button
                variant="secondary"
                size="sm"
                className="absolute bottom-3 right-4 shadow-float"
                onClick={() => {
                  const el = scroller.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}
              >
                <ArrowDown className="size-3.5" aria-hidden /> Latest
              </Button>
            )}
          </div>
          {readingAround && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-primary-soft px-4 py-2 text-[13px] text-primary-ink" role="status">
              <span>You are reading older messages. New ones are not shown here.</span>
              <Link href={conversationHref(c.id)} onClick={actions.onJumpToLatest} className="inline-flex min-h-11 items-center font-medium underline sm:min-h-8">Jump to the newest</Link>
            </div>
          )}
          <Composer conversationId={c.id} threadRootId={null} label={label} placeholder={`Message ${railTitle({ kind: c.kind, name: c.name })}`} members={mentionable} selfId={me.id} blocked={blocked} onSend={actions.onSend} />
        </>
      )}
    </div>
  );
}
