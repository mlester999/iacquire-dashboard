import "server-only";
import crypto from "node:crypto";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { readAuthorizedPrivateFile, removeStoredObjectTrusted, uploadPrivateFile } from "@/server/storage/private";
import { factsOf, isId, loadReadableConversation, loadStaffActor, standingOf, type StaffUser } from "@/server/staff-messages/access";
import { canPost } from "@/lib/staff-messages/conversations";
import { attachmentProblem, mimeForFilename, safeFilename } from "@/lib/staff-messages/attachments";
import { MAX_ATTACHMENT_BYTES, MAX_STAGED_PER_PERSON, STAGED_UPLOAD_TTL_HOURS } from "@/lib/staff-messages/limits";
import type { AttachmentView } from "@/server/staff-messages/messages";

// Files on a message. A file is first staged (saved in the private bucket 'staff-messages', owned by the person who chose it, attached to nothing) and becomes part of a message
// when that message is sent. Staged files nobody sends are removed. The bucket is closed to every browser (its read rule in migration 0090 is false): a file comes out only
// through downloadAttachment, which checks the person's membership of the conversation first. There is no virus scanning in this deployment; the types are limited to
// non-executable ones, each file's first bytes must match its type, and every file is downloaded as an attachment, never shown in the page.

/** Saves a file the person has chosen for a conversation they are in. It belongs to them alone until the message that carries it is sent. */
export async function stageAttachment(user: StaffUser, conversationId: unknown, file: { name: string; bytes: Buffer }): Promise<AttachmentView> {
  const actor = await loadStaffActor(user);
  const limit = await consumeRateLimit(RATE_LIMITS.staffMessageUploadByUser, actor.userId);
  if (!limit.allowed) throw new AppError("rate_limited", "Upload limit reached. Try again later.", { retryAfterSeconds: limit.retryAfterSeconds });
  const filename = safeFilename(file.name);
  const problem = attachmentProblem({ name: filename, size: file.bytes.length });
  if (problem) throw new AppError("invalid_input", problem);
  const mime = mimeForFilename(filename) as string;
  const conversation = await withSystem(async (db) => {
    const c = await loadReadableConversation(db, actor, conversationId);
    if (!canPost(factsOf(c), standingOf(actor, c))) throw new AppError("conflict", "This conversation is archived, so nothing can be added to it.");
    const pending = await db.query<{ n: number }>("select count(*)::int as n from staff_message_attachments where uploaded_by = $1 and status = 'staged' and expires_at > now()", [actor.userId]);
    // A person can have a handful of unsent files at a time; anything more is almost certainly a script.
    if ((pending.rows[0]?.n ?? 0) >= MAX_STAGED_PER_PERSON) throw new AppError("rate_limited", "You have several files waiting to be sent. Send or remove some first.");
    return c;
  });
  // Visibility 'client' is the bucket's one setting: the read rule, not the visibility, keeps these files agency-only (see migration 0090).
  const stored = await uploadPrivateFile({
    userId: actor.userId, orgId: actor.agencyOrgId, bucket: "staff-messages", path: `${actor.agencyOrgId}/${crypto.randomUUID()}/${filename}`, bytes: file.bytes, contentType: mime, filename,
    visibility: "client", maxBytes: MAX_ATTACHMENT_BYTES,
  });
  try {
    return await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into staff_message_attachments (org_id, conversation_id, private_file_id, uploaded_by, status, expires_at, filename, mime_type, size_bytes)
         values ($1, $2, $3, $4, 'staged', now() + make_interval(hours => $5), $6, $7, $8) returning id`,
        [actor.agencyOrgId, conversation.id, stored.id, actor.userId, STAGED_UPLOAD_TTL_HOURS, filename, mime, file.bytes.length],
      );
      return { id: rows[0].id, filename, mimeType: mime, sizeBytes: file.bytes.length };
    });
  } catch (error) {
    await discardFile(stored.id, actor.agencyOrgId, stored.storageKey).catch(() => undefined);
    throw error;
  }
}

/** Withdraws access to a stored file first and then removes its bytes; if the bytes cannot be removed this time the caller is told and a later run finishes it. */
async function discardFile(privateFileId: string, orgId: string, storageKey: string): Promise<void> {
  await withSystem((db) => db.query("update private_files set status = 'deleted' where id = $1", [privateFileId]));
  await removeStoredObjectTrusted({ orgId, bucket: "staff-messages", storageKey });
}

/** The person taking back a file they staged and then decided not to send. A file that is someone else's, or already sent, reads as not found. */
export async function discardStaged(user: StaffUser, attachmentId: unknown): Promise<void> {
  const actor = await loadStaffActor(user);
  if (!isId(attachmentId)) throw new AppError("not_found", "Attachment not found.");
  const row = await withSystem(async (db) =>
    (await db.query<{ id: string; private_file_id: string; org_id: string; storage_key: string }>(
      `select a.id, a.private_file_id, a.org_id, f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id
        where a.id = $1 and a.uploaded_by = $2 and a.status = 'staged'`,
      [attachmentId, actor.userId],
    )).rows[0],
  );
  if (!row) throw new AppError("not_found", "Attachment not found.");
  await withSystem((db) => db.query("update staff_message_attachments set status = 'removed' where id = $1 and status = 'staged'", [row.id]));
  await discardFile(row.private_file_id, row.org_id, row.storage_key).catch(() => undefined);
}

export interface Download {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * A file's bytes, for a route to send as a download. The person must be an active member of the conversation the file was sent in (row-level security on the attachment, which
 * follows their membership right now), the message must still stand, and a staged file is the uploader's alone. Nothing else reads this bucket.
 */
export async function downloadAttachment(user: StaffUser, attachmentId: unknown): Promise<Download> {
  const actor = await loadStaffActor(user);
  if (!isId(attachmentId)) throw new AppError("not_found", "Attachment not found.");
  const row = await withUser(actor.userId, async (db) =>
    (await db.query<{ private_file_id: string; filename: string; mime_type: string }>(
      `select a.private_file_id, a.filename, a.mime_type from staff_message_attachments a
        where a.id = $1 and a.status in ('staged', 'attached')
          and (a.status = 'staged' and a.uploaded_by = $2 or a.status = 'attached' and exists (select 1 from staff_messages m where m.id = a.message_id and m.deleted_at is null))`,
      [attachmentId, actor.userId],
    )).rows[0],
  );
  if (!row) throw new AppError("not_found", "Attachment not found.");
  const file = await readAuthorizedPrivateFile(row.private_file_id);
  return { bytes: file.bytes, filename: row.filename, mimeType: row.mime_type };
}

/** Removes staged files nobody sent, once their time is up. Reads are withdrawn first; a file whose bytes cannot be removed now stays listed for the next run. */
export async function cleanupStagedAttachments(opts: { now?: Date; limit?: number } = {}): Promise<number> {
  const rows = await withSystem(async (db) =>
    (await db.query<{ id: string; org_id: string; private_file_id: string; storage_key: string }>(
      `select a.id, a.org_id, a.private_file_id, f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id
        where a.status = 'staged' and a.expires_at < coalesce($1::timestamptz, now()) order by a.expires_at limit $2`,
      [opts.now?.toISOString() ?? null, opts.limit ?? 100],
    )).rows,
  );
  let done = 0;
  for (const r of rows) {
    try {
      await discardFile(r.private_file_id, r.org_id, r.storage_key);
    } catch {
      continue;
    }
    await withSystem((db) => db.query("update staff_message_attachments set status = 'removed' where id = $1", [r.id]));
    done += 1;
  }
  return done;
}
