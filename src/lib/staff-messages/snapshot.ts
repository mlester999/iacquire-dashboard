// What the snapshot endpoint answers and the open page keeps. Plain data the server built from the person's own conversations; the types come from the services that make them
// (type imports only, so nothing from src/server reaches a browser bundle). The revision is the person's inbox revision at the moment the answer was started: if something
// changed while the answer was being built, the next ask sees a higher number and asks again, so an answer is never newer than its revision claims.

import type { RailEntry } from "@/lib/staff-messages/view";
import type { ConversationView } from "@/server/staff-messages/conversations";
import type { MessageView } from "@/server/staff-messages/messages";

export interface MessagesPage {
  messages: MessageView[];
  /** True when older messages exist above the first one returned. */
  hasMore: boolean;
  lastSeq: number;
  lastReadSeq: number;
}

export interface SnapshotPayload {
  revision: number;
  /** Unread messages that count toward the badge in the navigation (absent when the request was for an older page only). */
  unread?: number;
  /** All the person's conversations (absent for a badge-only or older-page request). */
  rail?: RailEntry[];
  /** The conversation asked for. `null` means it is not there for this person: they left it, it was never theirs, or the id is wrong (the words are the same for all three). */
  conversation?: ConversationView | null;
  /** The newest page of that conversation's main view (absent for a conversation the person has only previewed, such as an open channel they have not joined). */
  page?: MessagesPage;
  /** The open thread, the message that started it first; `null` when it is no longer there. */
  thread?: MessagesPage | null;
  /** A page older than the one the person already has (only for a request that named `before`). */
  older?: MessagesPage;
}

/** The answer when nothing changed since the revision the page already holds. */
export interface SnapshotUnchanged {
  unchanged: true;
  revision: number;
}

export type SnapshotResponse = SnapshotPayload | SnapshotUnchanged;

export const isUnchanged = (response: SnapshotResponse): response is SnapshotUnchanged => "unchanged" in response && response.unchanged === true;

/** The error body of a refused snapshot or stream request. `reason` is set when the person's standing changed, so the page can say why it stopped. */
export interface AccessError {
  error: string;
  code: string;
  reason?: "forbidden" | "not_enabled";
}

/** A message number the newest page should end near, so a search hit can be shown with some of what came before it. */
export const AROUND_AFTER = 25;
