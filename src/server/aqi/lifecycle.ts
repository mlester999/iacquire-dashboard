import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { removePrivateFile } from "@/server/storage/private";
import type { AqiViewer } from "@/server/aqi/access";

/**
 * AQi conversation lifecycle.
 *
 * A chat is written while the person is talking to AQi, but it is temporary until the person
 * explicitly saves it. Temporary chats never appear in conversation history and cannot be deleted
 * through the saved-conversation delete action. These functions keep the three destructive
 * operations separate: explicit save, explicit temporary discard, and saved-conversation delete.
 */

/** Save a temporary chat to the person's permanent AQi history. Idempotent. */
export async function saveAqiConversation(viewer: AqiViewer, conversationId: string): Promise<{ savedAt: string }> {
  return withUser(viewer.user.id, async (db) => {
    const result = await db.query<{ saved_at: Date }>(
      `update aqi_conversations
       set saved_at = coalesce(saved_at, now()), saved_by = coalesce(saved_by, $3), updated_at = now()
       where id = $1 and user_id = $2 and (($4::uuid is null and org_id is null) or org_id = $4::uuid)
       returning saved_at`,
      [conversationId, viewer.user.id, viewer.user.id, viewer.org?.orgId ?? null],
    );
    if (!result.rows[0]) throw new AppError("not_found", "Conversation not found.");
    return { savedAt: new Date(result.rows[0].saved_at).toISOString() };
  });
}

/**
 * Explicitly discard one temporary chat. Saved conversations are never eligible, so this can never
 * remove something the person sees in history. Attachment cleanup and the row delete happen in one
 * user-scoped transaction; stored files are removed after it commits.
 */
export async function discardAqiTemporaryConversation(viewer: AqiViewer, conversationId: string): Promise<void> {
  const files = await withUser(viewer.user.id, async (db) => {
    const owned = await db.query<{ id: string }>(
      `select id from aqi_conversations
       where id = $1 and user_id = $2 and (($3::uuid is null and org_id is null) or org_id = $3::uuid) and saved_at is null`,
      [conversationId, viewer.user.id, viewer.org?.orgId ?? null],
    );
    if (!owned.rows[0]) throw new AppError("not_found", "Conversation not found.");
    const attachments = await db.query<{ org_id: string; storage_key: string }>(
      `select a.org_id, p.storage_key
       from aqi_attachments a join private_files p on p.id = a.private_file_id
       where a.conversation_id = $1 and a.user_id = $2 and a.status = 'ready'`,
      [conversationId, viewer.user.id],
    );
    const deleted = await db.query(
      `delete from aqi_conversations
       where id = $1 and user_id = $2 and (($3::uuid is null and org_id is null) or org_id = $3::uuid) and saved_at is null`,
      [conversationId, viewer.user.id, viewer.org?.orgId ?? null],
    );
    if (!deleted.rowCount) throw new AppError("not_found", "Conversation not found.");
    return attachments.rows;
  });
  for (const file of files) {
    await removePrivateFile({ userId: viewer.user.id, orgId: file.org_id, bucket: "aqi-attachments", path: file.storage_key }).catch(() => undefined);
  }
}

/**
 * Bounded lazy cleanup for chats that were started but never saved and never discarded (for example
 * the browser tab was closed). They are already invisible in history; removing the stale rows keeps
 * unsaved content from living on the server indefinitely. Saved chats are never touched.
 */
export async function purgeStaleAqiTemporaryConversations(viewer: AqiViewer, olderThanHours = 24, limit = 10): Promise<number> {
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(olderThanHours)));
  const rows = await withUser(viewer.user.id, async (db) => (await db.query<{ id: string }>(
    `select id from aqi_conversations
     where user_id = $1 and (($2::uuid is null and org_id is null) or org_id = $2::uuid)
       and saved_at is null and last_message_at < now() - ($3::int * interval '1 hour')
     order by last_message_at asc limit $4`,
    [viewer.user.id, viewer.org?.orgId ?? null, hours, Math.max(1, Math.min(25, Math.floor(limit)))],
  )).rows);
  let removed = 0;
  for (const row of rows) {
    try {
      await discardAqiTemporaryConversation(viewer, row.id);
      removed += 1;
    } catch {
      // A row may have been saved or removed in another tab between the select and the discard.
    }
  }
  return removed;
}
