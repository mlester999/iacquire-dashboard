import "server-only";
import { readSystem, withUser, type Queryable } from "@/server/db";
import { isUserId } from "@/lib/staff-messages/direct";
import { seqOf } from "@/lib/staff-messages/unread";

// One number per person (staff_inbox_state.revision), raised in the transaction of everything that changes what that person sees: a message in one of their conversations, a
// change to who is in it, a read, an edit. A poll or a stream compares it with the one it last saw and reads nothing else, so it costs one indexed read by primary key.
// The rows are written in user-id order so two writers touching the same people never wait on each other in opposite orders.

export async function bumpInbox(db: Queryable, orgId: string, userIds: readonly string[]): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  if (!ids.length) return;
  await db.query(
    `insert into staff_inbox_state (user_id, org_id, revision) select u, $2::uuid, 1 from unnest($1::uuid[]) as u order by u
     on conflict (user_id) do update set revision = staff_inbox_state.revision + 1, updated_at = now()`,
    [ids, orgId],
  );
}

/** Raises the revision of everyone who is in the conversation now, and of anyone named in `also` (someone who just left or was removed still has to see it go). */
export async function bumpConversation(db: Queryable, orgId: string, conversationId: string, also: readonly string[] = []): Promise<void> {
  await db.query(
    `insert into staff_inbox_state (user_id, org_id, revision)
     select u, $2::uuid, 1 from (select m.user_id as u from staff_conversation_members m where m.conversation_id = $1 and m.left_at is null union select x from unnest($3::uuid[]) as x) s order by u
     on conflict (user_id) do update set revision = staff_inbox_state.revision + 1, updated_at = now()`,
    [conversationId, orgId, [...new Set(also)]],
  );
}

export type InboxStatus =
  | { access: "ok"; revision: number }
  // The person's standing changed since the page opened: the page stops showing messages and says why. Nothing about any conversation is in the answer.
  | { access: "changed"; reason: "forbidden" | "not_enabled" };

/**
 * What a poll or a stream tick asks, in one indexed read: is the person still allowed (still an active account of the agency role the session names, holding the permission, the
 * module on) and, if so, their revision. The answer carries a number and nothing else, so it can be sent as it is.
 */
export async function inboxStatus(user: { id: string; platformRole: string }): Promise<InboxStatus> {
  if (!isUserId(user.id)) return { access: "changed", reason: "forbidden" };
  const { rows } = await readSystem((db) =>
    db.query<{ active: boolean; platform_role: string; can_use: boolean; enabled: boolean; revision: string }>(
      `select u.status = 'active' as active, u.platform_role, coalesce(app.user_has_agency_permission(u.id, 'agency.messages.use'), false) as can_use,
              exists (select 1 from org_features f join organizations o on o.id = f.org_id where o.kind = 'agency' and f.feature = 'staff_messages' and f.enabled) as enabled,
              coalesce((select s.revision::text from staff_inbox_state s where s.user_id = u.id), '0') as revision
         from users u where u.id = $1`,
      [user.id],
    ),
  );
  const r = rows[0];
  if (!r?.active || r.platform_role === "none" || r.platform_role !== user.platformRole || !r.can_use) return { access: "changed", reason: "forbidden" };
  if (!r.enabled) return { access: "changed", reason: "not_enabled" };
  return { access: "ok", revision: seqOf(r.revision) };
}

/** The person's revision (zero before anything has happened to them). Read under their own row-level security: nobody else's number can be read this way. */
export async function inboxRevision(userId: string): Promise<number> {
  const { rows } = await withUser(userId, (db) => db.query<{ revision: string }>("select revision::text as revision from staff_inbox_state where user_id = $1", [userId]));
  return rows[0] ? seqOf(rows[0].revision) : 0;
}
