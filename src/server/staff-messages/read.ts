import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { isId, loadStaffActor, type StaffUser } from "@/server/staff-messages/access";
import { bumpInbox } from "@/server/staff-messages/inbox";
import { noticeLink } from "@/lib/staff-messages/notices";
import { seqOf } from "@/lib/staff-messages/unread";

export interface ReadResult {
  lastReadSeq: number;
  /** False when the person had already read this far: nothing was written. */
  moved: boolean;
}

/**
 * Says the person has read a conversation up to message number `seq`. The cursor only moves forward and never past the newest message (greatest() in the statement, and the same
 * rule in a trigger), so a late request, a replayed one or a second tab can never mark anything unread. When it moves, the person's own revision is raised so their other tabs
 * update, and the staff notices for that conversation are marked read with it.
 */
export async function markRead(user: StaffUser, conversationId: unknown, seq: unknown): Promise<ReadResult> {
  const actor = await loadStaffActor(user);
  if (!isId(conversationId)) throw new AppError("not_found", "That conversation was not found.");
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) throw new AppError("invalid_input", "That is not a message number.");
  const limit = await consumeRateLimit(RATE_LIMITS.staffMessageReadByUser, actor.userId);
  if (!limit.allowed) throw new AppError("rate_limited", "Too many requests. Try again in a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  return withSystem(async (db) => {
    const mine = (await db.query<{ last_read_seq: string }>(
      "select last_read_seq::text as last_read_seq from staff_conversation_members where conversation_id = $1 and user_id = $2 and left_at is null for update",
      [conversationId, actor.userId],
    )).rows[0];
    if (!mine) throw new AppError("not_found", "That conversation was not found.");
    const moved = (await db.query<{ last_read_seq: string }>(
      `update staff_conversation_members m set last_read_seq = greatest(m.last_read_seq, least($3::bigint, c.last_seq)), last_read_at = now()
         from staff_conversations c
        where c.id = m.conversation_id and m.conversation_id = $1 and m.user_id = $2 and m.left_at is null and m.last_read_seq < least($3::bigint, c.last_seq)
        returning m.last_read_seq::text as last_read_seq`,
      [conversationId, actor.userId, seq],
    )).rows[0];
    if (!moved) return { lastReadSeq: seqOf(mine.last_read_seq), moved: false };
    await db.query(
      "update notifications set read_at = now() where user_id = $1 and audience = 'staff' and read_at is null and link = $2 and kind in ('staff_message_direct', 'staff_message_mention')",
      [actor.userId, noticeLink(conversationId)],
    );
    await bumpInbox(db, actor.agencyOrgId, [actor.userId]);
    return { lastReadSeq: seqOf(moved.last_read_seq), moved: true };
  });
}
