import "server-only";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { removeStoredObjectTrusted } from "@/server/storage/private";
import { staffMessagesEnabled, loadStaffMessageSettings } from "@/server/staff-messages/settings";
import { cleanupStagedAttachments } from "@/server/staff-messages/attachments";
import { addEvent, ensureOwner } from "@/server/staff-messages/conversations";
import { bumpConversation } from "@/server/staff-messages/inbox";
import { MAINTENANCE_BATCH, MAINTENANCE_BUDGET_MS } from "@/lib/staff-messages/limits";

// The scheduled clean-up (job staffMessagesMaintenance, every hour, off until the scheduler stage that names it). It does nothing at all while staff Messages is switched off.
//   * staged files nobody sent are removed once their day is up;
//   * files of deleted messages whose bytes could not be removed at the time are removed;
//   * people who are no longer on the agency team (disabled, or no longer an agency account) are taken out of their conversations, so history stays truthful and nobody is left
//     holding a membership they cannot use (messages keep their author and the screens say "Former team member"; a returning person is added again by hand, except in their
//     direct messages, which reopen);
//   * messages older than the retention period, only when a Super Admin set one (none by default).
// Every step is idempotent and works in batches inside a time budget, so a tick (cut off at 120 seconds) is never held up. There is one agency workspace, so there is no
// fairness to keep between workspaces.

export interface MaintenanceResult {
  stagedRemoved: number;
  filesFinished: number;
  membershipsClosed: number;
  messagesExpired: number;
}

const ZERO: MaintenanceResult = { stagedRemoved: 0, filesFinished: 0, membershipsClosed: 0, messagesExpired: 0 };
const total = (r: MaintenanceResult) => r.stagedRemoved + r.filesFinished + r.membershipsClosed + r.messagesExpired;

interface FileRow {
  id: string;
  org_id: string;
  file_id: string;
  storage_key: string;
}

/** Withdraws access to each file, removes its bytes, and only then marks its attachment removed; one whose bytes cannot be removed stays for the next run. */
async function removeFiles(rows: readonly FileRow[], deadline: number): Promise<number> {
  let done = 0;
  for (const r of rows) {
    if (Date.now() > deadline) break;
    await withSystem((db) => db.query("update private_files set status = 'deleted' where id = $1", [r.file_id]));
    try {
      await removeStoredObjectTrusted({ orgId: r.org_id, bucket: "staff-messages", storageKey: r.storage_key });
    } catch {
      continue;
    }
    await withSystem((db) => db.query("update staff_message_attachments set status = 'removed' where id = $1", [r.id]));
    done += 1;
  }
  return done;
}

async function finishDeletedMessageFiles(limit: number, deadline: number): Promise<number> {
  const rows = (await withSystem((db) =>
    db.query<FileRow>(
      `select a.id, a.org_id, f.id as file_id, f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id
        where a.status = 'attached' and (f.status = 'deleted' or exists (select 1 from staff_messages m where m.id = a.message_id and m.deleted_at is not null))
        order by a.created_at limit $1`,
      [limit],
    ),
  )).rows;
  return removeFiles(rows, deadline);
}

/** Takes people who are no longer on the agency team out of every conversation they are in. */
async function closeFormerMembers(limit: number): Promise<number> {
  return withSystem(async (db) => {
    const closed = await db.query<{ conversation_id: string; user_id: string; org_id: string }>(
      `update staff_conversation_members m set left_at = now()
        where (m.conversation_id, m.user_id) in (
          select x.conversation_id, x.user_id from staff_conversation_members x join users u on u.id = x.user_id
           where x.left_at is null and (u.status <> 'active' or u.platform_role not in ('agency_staff', 'agency_manager', 'agency_super_admin'))
           order by x.conversation_id, x.user_id limit $1)
        returning m.conversation_id, m.user_id, m.org_id`,
      [limit],
    );
    if (!closed.rows.length) return 0;
    const byConversation = new Map<string, { org: string; people: string[] }>();
    for (const r of closed.rows) {
      const entry = byConversation.get(r.conversation_id) ?? { org: r.org_id, people: [] };
      entry.people.push(r.user_id);
      byConversation.set(r.conversation_id, entry);
    }
    for (const [conversationId, { org, people }] of byConversation) {
      await ensureOwner(db, conversationId);
      for (const person of people) await addEvent(db, org, conversationId, "member_removed", null, person);
      await bumpConversation(db, org, conversationId, people);
    }
    const org = closed.rows[0].org_id;
    await recordAudit({ orgId: org, actorKind: "system", action: "staff_messages.former_members_closed", targetType: "organization", targetId: org, result: "success", metadata: { memberships: closed.rows.length } }, db);
    return closed.rows.length;
  });
}

/** Deletes messages older than the retention period, for good, a batch at a time. A message that starts a thread waits until its newest reply is old enough too. */
async function applyRetention(days: number, now: Date, limit: number, deadline: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  let deleted = 0;
  while (Date.now() < deadline) {
    const expired = (await withSystem((db) =>
      db.query<{ id: string }>(
        `select m.id from staff_messages m
          where m.created_at < $1::timestamptz
            and not exists (select 1 from staff_messages r where r.thread_root_id = m.id and r.created_at >= $1::timestamptz)
          order by m.created_at, m.id limit $2`,
        [cutoff, limit],
      ),
    )).rows.map((r) => r.id);
    if (!expired.length) break;
    // Files first: a message is deleted only once its files are gone, so no stored file is left without a row that points at it.
    const files = (await withSystem((db) =>
      db.query<FileRow>(
        `select a.id, a.org_id, f.id as file_id, f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id
          where a.message_id = any($1::uuid[]) and a.status = 'attached'`,
        [expired],
      ),
    )).rows;
    await removeFiles(files, deadline);
    const gone = await withSystem(async (db) => {
      const removed = await db.query<{ conversation_id: string; org_id: string }>(
        `delete from staff_messages m where m.id = any($1::uuid[])
            and not exists (select 1 from staff_message_attachments a where a.message_id = m.id and a.status = 'attached')
          returning m.conversation_id, m.org_id`,
        [expired],
      );
      const conversations = new Map(removed.rows.map((r) => [r.conversation_id, r.org_id]));
      for (const [conversationId, org] of conversations) await bumpConversation(db, org, conversationId);
      if (removed.rows.length) {
        const org = removed.rows[0].org_id;
        await recordAudit({ orgId: org, actorKind: "system", action: "staff_messages.retention_applied", targetType: "organization", targetId: org, result: "success", metadata: { deleted: removed.rows.length, retentionDays: days } }, db);
      }
      return removed.rows.length;
    });
    deleted += gone;
    // Nothing was deleted this round (every candidate still has a file that could not be removed): stop rather than ask for the same batch again.
    if (gone === 0) break;
  }
  return deleted;
}

export async function staffMessagesMaintenance(opts: { now?: Date; budgetMs?: number; batch?: number } = {}): Promise<MaintenanceResult> {
  if (!(await staffMessagesEnabled())) return { ...ZERO };
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? MAINTENANCE_BATCH;
  const deadline = Date.now() + (opts.budgetMs ?? MAINTENANCE_BUDGET_MS);
  const result: MaintenanceResult = { ...ZERO };
  result.stagedRemoved = await cleanupStagedAttachments({ now, limit: batch });
  result.filesFinished = await finishDeletedMessageFiles(batch, deadline);
  result.membershipsClosed = await closeFormerMembers(batch);
  const { retentionDays } = await loadStaffMessageSettings();
  if (retentionDays !== null) result.messagesExpired = await applyRetention(retentionDays, now, batch, deadline);
  return result;
}

/** The scheduler's entry: the number of things done. */
export async function runStaffMessagesMaintenance(opts: { now?: Date; budgetMs?: number; batch?: number } = {}): Promise<number> {
  return total(await staffMessagesMaintenance(opts));
}
