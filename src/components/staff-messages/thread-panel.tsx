"use client";

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/overlays";
import type { ConversationView } from "@/server/staff-messages/conversations";
import type { MessageView } from "@/server/staff-messages/messages";
import type { ChosenMention, PendingMessage } from "@/lib/staff-messages/composer";
import { plainMentions } from "@/lib/staff-messages/mentions";
import { canRetry, failureText } from "@/lib/staff-messages/pending";
import { messageAllowances, railTitle } from "@/lib/staff-messages/view";
import { Composer } from "@/components/staff-messages/composer";
import { MessageRow } from "@/components/staff-messages/message-row";
import type { PaneActions } from "@/components/staff-messages/conversation-pane";

// A thread: the message that started it and the replies under it, in a panel beside the conversation (full width on a phone), with its own message box. Replies are numbered
// with the rest of the conversation, so they count toward what is unread there.

export interface ThreadPanelProps {
  /** The message that started the thread, or null when the panel is closed. */
  rootId: string | null;
  onClose: () => void;
  /** undefined: still loading. null: the thread is no longer there. */
  thread: readonly MessageView[] | null | undefined;
  view: ConversationView;
  pending: readonly PendingMessage[];
  names: ReadonlyMap<string, string>;
  mentionable: readonly ChosenMention[];
  me: { id: string; canChannels: boolean; canModerate: boolean; timeZone: string };
  editingId: string | null;
  actions: Pick<PaneActions, "onStartEdit" | "onCancelEdit" | "onSaveEdit" | "onDelete" | "onReact" | "onSend" | "onRetry" | "onDiscardPending">;
  onReload: () => void;
}

export function ThreadPanel({ rootId, onClose, thread, view, pending, names, mentionable, me, editingId, actions, onReload }: ThreadPanelProps) {
  const c = view.conversation;
  const caps = { channels: me.canChannels, moderate: me.canModerate };
  const blocked = c.archived ? "This conversation is archived, so nothing can be added to the thread." : !view.can.post ? "You can't write in this conversation." : null;
  const open = rootId !== null;
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} side="right" title="Thread" description={`In ${railTitle({ kind: c.kind, name: c.name })}`}>
      <div className="flex min-h-full flex-col">
        <div className="flex-1 px-2 py-3">
          {thread === undefined && (
            <p role="status" className="flex items-center gap-2 px-3 py-6 text-[14px] text-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the thread…
            </p>
          )}
          {thread === null && (
            <div className="space-y-3 px-3 py-6" role="status">
              <p className="text-[14px] text-muted">This thread isn&apos;t available any more. The message may have been removed.</p>
              <Button size="sm" variant="secondary" onClick={onReload}>
                <RefreshCw className="size-3.5" aria-hidden /> Check again
              </Button>
            </div>
          )}
          {thread && (
            <ul aria-label="Messages in this thread">
              {thread.map((m, i) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  header={i === 0 || m.authorId !== thread[i - 1].authorId || thread[i - 1].deleted || m.deleted}
                  names={names}
                  selfId={me.id}
                  timeZone={me.timeZone}
                  allow={messageAllowances({ kind: c.kind, visibility: c.visibility, archived: c.archived, memberRole: c.memberRole }, caps, me.id, { authorId: m.authorId, deleted: m.deleted })}
                  inThread
                  editing={editingId === m.id}
                  onStartEdit={actions.onStartEdit}
                  onCancelEdit={actions.onCancelEdit}
                  onSaveEdit={actions.onSaveEdit}
                  onDelete={actions.onDelete}
                  onReact={actions.onReact}
                />
              ))}
              {pending.map((p) => (
                <li key={p.clientId} data-pending={p.clientId} className="px-3 py-1">
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{plainMentions(p.body, (id) => names.get(id) ?? null)}</p>
                  {p.status === "sending" ? (
                    <p className="flex items-center gap-1.5 text-[13px] text-muted" role="status">
                      <Loader2 className="size-3 animate-spin" aria-hidden /> Sending…
                    </p>
                  ) : (
                    <div role="alert" className="mt-1 space-y-1">
                      <p className="text-[13px] text-danger-ink">{failureText(p.error, p.errorCode)}</p>
                      <div className="flex flex-wrap gap-2">
                        {canRetry(p.errorCode) && <Button size="sm" variant="secondary" onClick={() => actions.onRetry(p.clientId)}>Try again</Button>}
                        <Button size="sm" variant="ghost" onClick={() => actions.onDiscardPending(p.clientId)}>Discard</Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {thread && rootId && (
          <div className="sticky bottom-0 bg-surface">
            <Composer key={rootId} conversationId={c.id} threadRootId={rootId} label="Reply in this thread" placeholder="Reply" members={mentionable} selfId={me.id} blocked={blocked} onSend={actions.onSend} />
          </div>
        )}
      </div>
    </Sheet>
  );
}
