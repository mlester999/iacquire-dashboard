import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { AUTHORIZATION_CHANGED_MESSAGE, NOT_ENABLED_MESSAGE, type StaffUser } from "@/server/staff-messages/access";
import { getConversation, listConversations } from "@/server/staff-messages/conversations";
import { inboxStatus } from "@/server/staff-messages/inbox";
import { listMessages } from "@/server/staff-messages/messages";
import type { SnapshotQuery } from "@/lib/staff-messages/live";
import { AROUND_AFTER, type SnapshotPayload, type SnapshotResponse } from "@/lib/staff-messages/snapshot";
import { PAGE_SIZE } from "@/lib/staff-messages/limits";
import { badgeTotal, seqOf } from "@/lib/staff-messages/unread";

// What an open Messages page asks for, and what the first render of a page is built from. The person's standing and the revision are read first, in one statement; if the page
// already holds that revision, nothing else is read at all. Every other read goes through the services, which check the person's membership again.

/** Throws the error a refused snapshot or stream request answers with (403, and the reason the page shows). */
export function accessRefusal(reason: "forbidden" | "not_enabled"): AppError {
  return reason === "not_enabled" ? new AppError("not_enabled", NOT_ENABLED_MESSAGE) : new AppError("forbidden", AUTHORIZATION_CHANGED_MESSAGE);
}

/** The unread messages the navigation badge counts for one person: the sum over conversations that are neither muted nor archived (the same rule as badgeTotal, in one read). */
export async function unreadTotal(userId: string): Promise<number> {
  const { rows } = await withUser(userId, (db) =>
    db.query<{ n: string }>(
      `select coalesce(sum(greatest(0, c.last_seq - least(m.last_read_seq, c.last_seq))), 0)::text as n
         from staff_conversation_members m join staff_conversations c on c.id = m.conversation_id
        where m.user_id = $1 and m.left_at is null and not m.muted and c.archived_at is null`,
      [userId],
    ),
  );
  return seqOf(rows[0]?.n ?? "0");
}

/**
 * The answer to one snapshot request. Throws forbidden or not_enabled when the person's standing changed (the page stops and says why).
 *
 *  - badge only: the revision and the unread total;
 *  - `before`: one older page of the conversation, nothing else;
 *  - otherwise: the rail, the conversation asked for (null if it is not there for them), its newest page (or the page ending a little after `around`), and the open thread.
 *
 * `since` is the revision the page already holds: when it is the current one, the answer is just that.
 */
export async function buildSnapshot(user: StaffUser, q: SnapshotQuery): Promise<SnapshotResponse> {
  const status = await inboxStatus(user);
  if (status.access === "changed") throw accessRefusal(status.reason);
  const { revision } = status;
  if (q.since !== null && q.since === revision) return { unchanged: true, revision };
  if (q.badgeOnly) return { revision, unread: await unreadTotal(user.id) };
  if (q.beforeSeq !== null && q.conversationId) {
    return { revision, older: await listMessages(user, q.conversationId, { beforeSeq: q.beforeSeq }) };
  }
  const rail = await listConversations(user);
  const out: SnapshotPayload = { revision, unread: badgeTotal(rail), rail };
  if (!q.conversationId) return out;
  const conversation = await getConversation(user, q.conversationId).catch((error) => {
    if (error instanceof AppError && error.code === "not_found") return null;
    throw error;
  });
  out.conversation = conversation;
  // A person who has only found an open channel cannot read it: the page offers to join, and there is nothing to list.
  if (!conversation || !conversation.conversation.memberRole) return out;
  // `beforeSeq` is exclusive, so add one to include the message a little after the hit. The page still ends with AROUND_AFTER messages after the asked-for one.
  const around = q.aroundSeq && q.aroundSeq > 0 ? q.aroundSeq + AROUND_AFTER + 1 : null;
  out.page = await listMessages(user, q.conversationId, { beforeSeq: around, limit: PAGE_SIZE });
  if (q.threadRootId) {
    const thread = await listMessages(user, q.conversationId, { threadRootId: q.threadRootId }).catch((error) => {
      if (error instanceof AppError && error.code === "not_found") return null;
      throw error;
    });
    // A thread whose first message is not the one asked for is not a thread of this conversation. A reply is not a thread root either: asking for one would otherwise
    // return that reply alone and the page would open it as if it started a thread.
    const first = thread?.messages[0];
    out.thread = thread && first?.id === q.threadRootId.toLowerCase() && first.threadRootId === null ? thread : null;
  }
  return out;
}
