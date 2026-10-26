// What the open Messages page holds and how an answer from the server changes it. The server is the authority for everything here; this only decides how a newer answer joins
// what the page already shows (an older answer arriving late is ignored, a page of newest messages replaces the tail it covers, a message the person just sent appears at
// once and is corrected by the next answer). Pure.

import type { ConversationView } from "@/server/staff-messages/conversations";
import type { MessageView } from "@/server/staff-messages/messages";
import type { MessagesPage, SnapshotPayload } from "@/lib/staff-messages/snapshot";
import { mergeLatest, mergeOlder, type RailEntry } from "@/lib/staff-messages/view";
import { unreadCount } from "@/lib/staff-messages/unread";

export interface PageState {
  revision: number;
  rail: RailEntry[];
  /** undefined: no conversation is open. null: the one asked for is not there for this person. */
  conversation: ConversationView | null | undefined;
  /** The main view, oldest first. */
  messages: MessageView[];
  hasMore: boolean;
  lastSeq: number;
  lastReadSeq: number;
  /** The open thread, the message that started it first. undefined: none is open. null: it is no longer there. */
  thread: MessageView[] | null | undefined;
}

export function initialState(payload: SnapshotPayload): PageState {
  return {
    revision: payload.revision,
    rail: payload.rail ?? [],
    conversation: payload.conversation,
    messages: payload.page?.messages ?? [],
    hasMore: payload.page?.hasMore ?? false,
    lastSeq: payload.page?.lastSeq ?? 0,
    lastReadSeq: payload.page?.lastReadSeq ?? 0,
    thread: payload.thread === undefined ? undefined : (payload.thread?.messages ?? null),
  };
}

/**
 * Joins a full answer to the page. An answer for an older revision than the page holds is dropped (it was overtaken). With `replace` the newest page replaces the whole list
 * (used when the window moves, for example back to the newest messages after reading around an old one); otherwise it replaces only the tail it covers.
 */
export function applySnapshot(prev: PageState, payload: SnapshotPayload, mode: "live" | "replace" = "live"): PageState {
  if (payload.revision < prev.revision) return prev;
  const next: PageState = { ...prev, revision: payload.revision };
  if (payload.rail) next.rail = payload.rail;
  if (payload.conversation !== undefined) next.conversation = payload.conversation;
  if (payload.conversation === null) {
    next.messages = [];
    next.hasMore = false;
    next.thread = undefined;
  }
  if (payload.page) {
    const merged = mode === "replace" ? payload.page.messages : mergeLatest(prev.messages, payload.page.messages);
    next.messages = merged;
    // The oldest message on screen came from this page: the page knows whether more lie above it. Otherwise older ones were loaded earlier and that answer still stands.
    next.hasMore = mode === "replace" || merged.length === 0 || merged[0]?.seq === payload.page.messages[0]?.seq ? payload.page.hasMore : prev.hasMore;
    next.lastSeq = payload.page.lastSeq;
    next.lastReadSeq = payload.page.lastReadSeq;
  }
  if (payload.thread !== undefined) next.thread = payload.thread?.messages ?? null;
  return next;
}

/** An older page goes above what is shown. */
export function applyOlder(prev: PageState, older: MessagesPage): PageState {
  return { ...prev, messages: mergeOlder(prev.messages, older.messages), hasMore: older.hasMore };
}

/** Inserts or replaces a message by its id, keeping the list in the order of the numbers. */
export function upsertMessage<T extends { id: string; seq: number }>(list: readonly T[], message: T): T[] {
  const without = list.filter((m) => m.id !== message.id);
  const at = without.findIndex((m) => m.seq > message.seq);
  return at === -1 ? [...without, message] : [...without.slice(0, at), message, ...without.slice(at)];
}

/**
 * The rail row for a conversation where the person has just written: the newest message is theirs and everything up to it counts as read (the server does the same), and the
 * conversation moves to the top, where the server's order puts it.
 */
export function bumpRail(rail: readonly RailEntry[], conversationId: string, message: Pick<MessageView, "seq" | "createdAt">): RailEntry[] {
  const row = rail.find((r) => r.id === conversationId);
  if (!row) return [...rail];
  const lastSeq = Math.max(row.lastSeq, message.seq);
  const updated: RailEntry = { ...row, lastSeq, lastReadSeq: lastSeq, unread: 0, lastMessageAt: message.createdAt };
  return [updated, ...rail.filter((r) => r.id !== conversationId)];
}

/** Shows a message the person has just sent (the server's answer to their send) without waiting for the next snapshot. */
export function withSentMessage(prev: PageState, message: MessageView): PageState {
  const next: PageState = { ...prev, lastSeq: Math.max(prev.lastSeq, message.seq), lastReadSeq: Math.max(prev.lastReadSeq, message.seq) };
  if (!prev.conversation || prev.conversation.conversation.id !== message.conversationId) return next;
  next.rail = bumpRail(prev.rail, message.conversationId, message);
  if (message.threadRootId === null) {
    next.messages = upsertMessage(prev.messages, message);
    return next;
  }
  const threadOpen = prev.thread && prev.thread[0]?.id === message.threadRootId;
  const alreadyCounted = prev.thread?.some((m) => m.id === message.id) ?? false;
  if (threadOpen && prev.thread) next.thread = upsertMessage(prev.thread, message);
  // The message that started the thread shows how many replies it has.
  if (!alreadyCounted) next.messages = prev.messages.map((m) => (m.id === message.threadRootId ? { ...m, replyCount: m.replyCount + 1 } : m));
  return next;
}

/** Replaces a message the person edited (the server's answer to their edit) wherever it is shown. */
export function withEditedMessage(prev: PageState, message: MessageView): PageState {
  const swap = (list: MessageView[]) => list.map((m) => (m.id === message.id ? { ...message, replyCount: m.replyCount } : m));
  return { ...prev, messages: swap(prev.messages), thread: prev.thread ? swap(prev.thread) : prev.thread };
}

/** Marks a message as deleted wherever it is shown, the way the server stores it: its place stays, its text, reactions and files go. */
export function withDeletedMessage(prev: PageState, messageId: string): PageState {
  const gone = (m: MessageView): MessageView => (m.id === messageId ? { ...m, deleted: true, body: "", mentions: [], reactions: [], attachments: [] } : m);
  return { ...prev, messages: prev.messages.map(gone), thread: prev.thread ? prev.thread.map(gone) : prev.thread };
}

/** Replaces the reactions on one message (the server's answer to a reaction). */
export function withReactions(prev: PageState, messageId: string, reactions: MessageView["reactions"]): PageState {
  const swap = (m: MessageView): MessageView => (m.id === messageId ? { ...m, reactions } : m);
  return { ...prev, messages: prev.messages.map(swap), thread: prev.thread ? prev.thread.map(swap) : prev.thread };
}

/** The person has read the open conversation up to a number: the page's own cursor and its rail row move together, so the count and the badge fall at once. */
export function withReadMark(prev: PageState, conversationId: string, seq: number): PageState {
  if (prev.conversation?.conversation.id !== conversationId) return { ...prev, rail: withRead(prev.rail, conversationId, seq) };
  return { ...prev, lastReadSeq: Math.max(prev.lastReadSeq, Math.min(seq, prev.lastSeq)), rail: withRead(prev.rail, conversationId, seq) };
}

/** The rail with one conversation marked read up to a number (the person has seen it), so its count and the badge fall at once. */
export function withRead(rail: readonly RailEntry[], conversationId: string, seq: number): RailEntry[] {
  return rail.map((r) => {
    if (r.id !== conversationId) return r;
    const lastReadSeq = Math.max(r.lastReadSeq, Math.min(seq, r.lastSeq));
    return { ...r, lastReadSeq, unread: unreadCount(r.lastSeq, lastReadSeq) };
  });
}
