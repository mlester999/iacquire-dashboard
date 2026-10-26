// Threads are one level deep: a reply points at the message that started the thread, never at another reply. Replying to a reply therefore joins the same thread. Pure.

export interface ThreadTarget {
  id: string;
  /** Null for a message that is not itself a reply. */
  threadRootId: string | null;
}

/** The message a new reply is attached to when the person chose to reply to `target`. */
export const threadRootFor = (target: ThreadTarget): string => target.threadRootId ?? target.id;

export interface ThreadReply {
  authorId: string | null;
  seq: number;
  createdAt: Date | string;
  deleted?: boolean;
}

export interface ThreadSummary {
  /** Replies still standing; a deleted reply is not counted. */
  replies: number;
  lastReplyAt: string | null;
  /** The people who replied (the author of a deleted reply included only if another reply of theirs stands), oldest first, each once. */
  participants: string[];
}

export function summariseThread(replies: readonly ThreadReply[]): ThreadSummary {
  const standing = replies.filter((r) => !r.deleted).sort((a, b) => a.seq - b.seq);
  const last = standing[standing.length - 1];
  return {
    replies: standing.length,
    lastReplyAt: last ? new Date(last.createdAt).toISOString() : null,
    participants: [...new Set(standing.flatMap((r) => (r.authorId ? [r.authorId] : [])))],
  };
}
