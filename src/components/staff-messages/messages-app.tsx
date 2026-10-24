"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessagesSquare, Settings2, TriangleAlert, WifiOff } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/ui";
import { cn } from "@/lib/utils";
import { deleteMessageAction, editMessageAction, joinChannelAction, markReadAction, reactAction, sendMessageAction } from "@/app/actions/staff-messages";
import type { MessageView } from "@/server/staff-messages/messages";
import type { SnapshotPayload } from "@/lib/staff-messages/snapshot";
import type { ChosenMention, PendingMessage } from "@/lib/staff-messages/composer";
import { accessLostText, connectionNotice } from "@/lib/staff-messages/live";
import { UNREAD_EVENT } from "@/lib/staff-messages/nav";
import { addPending, markFailed, markSending, pendingFor, removePending } from "@/lib/staff-messages/pending";
import { readTarget } from "@/lib/staff-messages/scroll";
import { withDeletedMessage, withEditedMessage, withReactions, withReadMark, withSentMessage } from "@/lib/staff-messages/state";
import { badgeTotal } from "@/lib/staff-messages/unread";
import { MESSAGES_HOME, railTitle, type StaffRole } from "@/lib/staff-messages/view";
import type { Reaction } from "@/lib/staff-messages/reactions";
import { ConversationPane, type PaneActions } from "@/components/staff-messages/conversation-pane";
import { DetailsPanel } from "@/components/staff-messages/details-panel";
import { NoticeBanner } from "@/components/staff-messages/notice-banner";
import { AddPeopleDialog, ChannelDirectoryDialog, NewConversationDialog, type NewKind } from "@/components/staff-messages/pickers";
import { Rail } from "@/components/staff-messages/rail";
import { SearchPanel } from "@/components/staff-messages/search-panel";
import { ThreadPanel } from "@/components/staff-messages/thread-panel";
import { useAction } from "@/components/staff-messages/use-action";
import { useLiveMessages } from "@/components/staff-messages/use-live-messages";

// The Messages page: the list of conversations beside the open one, with the dialogs and panels that belong to them. On a phone only one of the two is shown (the list at
// /admin/messages, the conversation at /admin/messages/<id>) and the conversation has a way back. This component owns what the person is doing (messages being sent, the
// message being edited, the thread that is open); what the database holds comes from useLiveMessages, which the server answers from the person's own access.

export interface MessagesAppProps {
  me: { id: string; name: string; role: StaffRole; canChannels: boolean; canModerate: boolean; timeZone: string };
  initial: SnapshotPayload;
  conversationId: string | null;
  /** The newest page ends a little after this message (a search hit). */
  aroundSeq: number | null;
  /** A thread to open at once (a search hit that is a reply). */
  threadId: string | null;
  /** The server's clock when the page was built: relative times are measured from it until this component has a clock of its own. */
  now: number;
  /** Off for design previews and tests: no stream and no polling. */
  live?: boolean;
}

export function MessagesApp({ me, initial, conversationId, aroundSeq, threadId: initialThread, now: serverNow, live = true }: MessagesAppProps) {
  const router = useRouter();
  const { run } = useAction();
  const [threadId, setThreadId] = React.useState<string | null>(initialThread);
  const { state, commit, connection, error, offline, accessLost, refresh, loadOlder, loadingOlder } = useLiveMessages({ initial, conversationId, aroundSeq, threadRootId: threadId, enabled: live });
  const [pending, setPending] = React.useState<PendingMessage[]>([]);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<MessageView | null>(null);
  const [details, setDetails] = React.useState(false);
  const [dialog, setDialog] = React.useState<null | { type: "new"; kind: NewKind } | { type: "browse" } | { type: "search" } | { type: "add" }>(null);
  // False until the conversation has been drawn and has said where the person is: opening one at its unread marker must not count as having read it.
  const [atBottom, setAtBottom] = React.useState(false);
  // Whether the tab is on screen (nothing is marked read in a hidden one). Not drawn anywhere, so the server's answer and the browser's cannot disagree about it.
  const [visible, setVisible] = React.useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const [joining, setJoining] = React.useState(false);
  const [clock, setClock] = React.useState(serverNow);
  const sentSeq = React.useRef(0);
  // What had been read when the conversation was opened: the "New messages" marker stays where it was until the person comes back.
  const [markerAfterSeq] = React.useState<number | null>(() => (initial.page && initial.page.lastSeq > initial.page.lastReadSeq ? initial.page.lastReadSeq : null));

  const view = state.conversation;
  const conversation = view?.conversation ?? null;
  const unread = badgeTotal(state.rail);

  // The clock for relative times ("5m ago") moves forward once a minute.
  React.useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // The navigation badge follows this page at once.
  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: { unread } }));
  }, [unread]);

  React.useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Telling the server what has been read: only when the person is looking at the newest messages in a visible tab, and only forward.
  React.useEffect(() => {
    if (!conversation || conversation.memberRole === null) return;
    const target = readTarget({ visible, atBottom, showingNewest: aroundSeq === null, lastSeq: state.lastSeq, lastReadSeq: state.lastReadSeq, sentSeq: sentSeq.current });
    if (target === null) return;
    sentSeq.current = target;
    const id = conversation.id;
    commit((previous) => withReadMark(previous, id, target));
    markReadAction({ conversationId: id, seq: target })
      .then((res) => {
        if (!res.ok) sentSeq.current = 0;
      })
      .catch(() => {
        sentSeq.current = 0;
      });
  }, [conversation, visible, atBottom, aroundSeq, state.lastSeq, state.lastReadSeq, commit]);

  const names = React.useMemo(() => new Map((view?.members ?? []).map((m) => [m.userId, m.name])), [view?.members]);
  const mentionable = React.useMemo<ChosenMention[]>(() => (view?.members ?? []).filter((m) => !m.former).map((m) => ({ id: m.userId, name: m.name })), [view?.members]);

  // ---- sending -----------------------------------------------------------

  const transmit = React.useCallback(
    async (message: PendingMessage) => {
      const res = await run(`send:${message.clientId}`, () => sendMessageAction({ conversationId: message.conversationId, clientMessageId: message.clientId, body: message.body, threadRootId: message.threadRootId, attachmentIds: message.attachments.map((a) => a.id) }), { quiet: true });
      if (res.ok) {
        setPending((list) => removePending(list, message.clientId));
        commit((previous) => withSentMessage(previous, res.data.message));
      } else {
        // No answer at all (a dropped connection) is the case where trying again is safe: the message keeps its id, so the server posts it once.
        setPending((list) => markFailed(list, message.clientId, res.code === "network" ? null : res.error, res.code === "network" ? null : res.code));
      }
    },
    [run, commit],
  );
  const send = React.useCallback(
    (message: PendingMessage) => {
      setPending((list) => addPending(list, message));
      void transmit(message);
    },
    [transmit],
  );

  const actions = React.useMemo<PaneActions>(
    () => ({
      onOpenThread: (m) => setThreadId(m.id),
      onStartEdit: (m) => setEditingId(m.id),
      onCancelEdit: () => setEditingId(null),
      onSaveEdit: async (m, body) => {
        const res = await run(`edit:${m.id}`, () => editMessageAction({ messageId: m.id, body, expectedEditedAt: m.editedAt }), { quiet: true });
        if (res.ok) {
          commit((previous) => withEditedMessage(previous, res.data));
          setEditingId(null);
          return { ok: true as const };
        }
        // Someone (this person in another tab) edited it first: bring the latest in, so reopening the editor starts from it.
        if (res.code === "conflict") void refresh({ force: true });
        return res;
      },
      onDelete: (m) => setDeleting(m),
      onReact: (m, reaction: Reaction, on) => {
        void run(`react:${m.id}`, () => reactAction({ messageId: m.id, reaction, on })).then((res) => {
          if (res.ok) commit((previous) => withReactions(previous, m.id, res.data));
        });
      },
      onSend: send,
      onRetry: (clientId) => {
        const message = pending.find((p) => p.clientId === clientId);
        if (!message) return;
        setPending((list) => markSending(list, clientId));
        void transmit({ ...message, status: "sending", error: null, errorCode: null });
      },
      onDiscardPending: (clientId) => setPending((list) => removePending(list, clientId)),
      onLoadOlder: () => void loadOlder(),
      onOpenDetails: () => setDetails(true),
      onSearch: () => setDialog({ type: "search" }),
      onJoin: async () => {
        if (!conversation) return;
        setJoining(true);
        const res = await run("join", () => joinChannelAction(conversation.id));
        setJoining(false);
        // Now a member: the next answer carries the messages and the members.
        if (res.ok) void refresh({ force: true, replace: true });
      },
      onJumpToLatest: () => undefined,
      onAtBottomChange: setAtBottom,
    }),
    [run, commit, refresh, loadOlder, send, transmit, pending, conversation],
  );

  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;
    const res = await run(`delete:${target.id}`, () => deleteMessageAction(target.id), { success: "Message deleted." });
    if (res.ok) {
      commit((previous) => withDeletedMessage(previous, target.id));
      setDeleting(null);
    }
  };

  // ---- layout ------------------------------------------------------------

  const later = (fn: () => void) => window.setTimeout(fn, 0);
  const noticeText = connectionNotice(connection, offline);
  const open = conversationId !== null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-[-0.03em] text-ink sm:text-[27px]">
            <MessagesSquare className="size-6 shrink-0 text-primary" aria-hidden /> Messages
          </h1>
          <p className="mt-1 text-[13px] text-muted">The agency team&apos;s own conversations. Customers and clients never see them.</p>
        </div>
        {me.role === "agency_super_admin" && (
          <ButtonLink href="/admin/messages/settings" variant="secondary" size="sm">
            <Settings2 className="size-4" aria-hidden /> Messages settings
          </ButtonLink>
        )}
      </div>

      <NoticeBanner />

      {accessLost && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[13.5px] text-danger-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {accessLostText(accessLost)}{" "}
            {accessLost === "signed_out" && <Link href="/login" className="font-medium underline">Sign in</Link>}
          </p>
        </div>
      )}
      {!accessLost && noticeText && (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-2 text-[13px] text-ink-2">
          <WifiOff className="size-4 shrink-0" aria-hidden /> {noticeText}
        </p>
      )}
      {!accessLost && !noticeText && error && (
        <p role="alert" className="rounded-xl border border-line bg-surface-2 px-4 py-2 text-[13px] text-danger-ink">
          {error}
        </p>
      )}

      <div className="flex h-[calc(100dvh-14rem)] min-h-[520px] overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        <aside aria-label="Conversation list" className={cn("min-h-0 w-full flex-col border-line md:flex md:w-[320px] md:shrink-0 md:border-r", open ? "hidden" : "flex")}>
          <Rail
            entries={state.rail}
            activeId={conversationId}
            now={clock}
            canChannels={me.canChannels}
            onNew={(kind) => later(() => setDialog({ type: "new", kind }))}
            onBrowse={() => later(() => setDialog({ type: "browse" }))}
            onSearch={() => setDialog({ type: "search" })}
          />
        </aside>
        <section aria-label={conversation ? railTitle({ kind: conversation.kind, name: conversation.name }) : "Conversation"} className={cn("min-h-0 min-w-0 flex-1 flex-col", open ? "flex" : "hidden md:flex")}>
          {open ? (
            <ConversationPane
              view={view}
              messages={state.messages}
              hasMore={state.hasMore}
              loadingOlder={loadingOlder}
              pending={pendingFor(pending, conversationId, null)}
              names={names}
              mentionable={mentionable}
              me={me}
              now={clock}
              markerAfterSeq={markerAfterSeq}
              highlightSeq={aroundSeq}
              readingAround={aroundSeq !== null}
              editingId={editingId}
              busyJoin={joining}
              actions={actions}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <MessagesSquare className="size-8 text-faint" aria-hidden />
              <h2 className="text-[16px] font-semibold text-ink">Choose a conversation</h2>
              <p className="max-w-sm text-[13.5px] leading-relaxed text-muted">Pick one from the list, or start a direct message, a group or a channel with the button above it.</p>
            </div>
          )}
        </section>
      </div>

      {view && view.conversation.memberRole !== null && (
        <ThreadPanel
          rootId={threadId}
          onClose={() => setThreadId(null)}
          thread={state.thread}
          view={view}
          pending={threadId ? pendingFor(pending, conversationId, threadId) : []}
          names={names}
          mentionable={mentionable}
          me={me}
          editingId={editingId}
          actions={actions}
          onReload={() => void refresh({ force: true })}
        />
      )}
      {view && (
        <DetailsPanel
          open={details}
          onOpenChange={setDetails}
          view={view}
          selfId={me.id}
          timeZone={me.timeZone}
          onChanged={() => void refresh({ force: true })}
          onLeft={() => router.push(MESSAGES_HOME)}
          onAddPeople={() => later(() => setDialog({ type: "add" }))}
        />
      )}
      {dialog?.type === "new" && <NewConversationDialog kind={dialog.kind} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog?.type === "browse" && <ChannelDirectoryDialog open onOpenChange={(o) => !o && setDialog(null)} canCreate={me.canChannels} onCreate={() => later(() => setDialog({ type: "new", kind: "channel" }))} />}
      {dialog?.type === "search" && (
        <SearchPanel open onOpenChange={(o) => !o && setDialog(null)} conversationId={conversation?.id ?? null} conversationName={conversation ? railTitle({ kind: conversation.kind, name: conversation.name }) : null} timeZone={me.timeZone} />
      )}
      {dialog?.type === "add" && conversation && (
        <AddPeopleDialog conversationId={conversation.id} memberIds={new Set((view?.members ?? []).map((m) => m.userId))} open onOpenChange={(o) => !o && setDialog(null)} onAdded={() => void refresh({ force: true })} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this message?"
        description="Its text and files are removed for everyone in the conversation. A note that a message was deleted stays. This can't be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
