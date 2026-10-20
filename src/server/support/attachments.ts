import "server-only";
import crypto from "node:crypto";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { uploadPrivateFile, signPrivateFile, removePrivateFile, removeStoredObjectTrusted } from "@/server/storage/private";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { mimeForFilename, safeFilename } from "@/lib/support/content";
import { loadSupportSettings } from "@/server/support/settings";

// Support attachments live in the private `support-attachments` bucket. Uploads are validated for type, size and the file's real
// contents (the bucket rejects a file whose bytes don't match its type), saved privately, and read back only through a short-lived
// link issued after tenant and visibility checks. A file is first *staged* (saved, owned by the uploader, not yet part of any
// request) and becomes part of a request when the message or request that carries it is sent. Files nobody sends are removed.
//
// Limitation: there is no virus-scanning service in this deployment. Files are restricted to non-executable types, SVG and HTML are
// never accepted, and every file is downloaded as an attachment (never rendered in the portal), but they are not scanned.

export interface SupportAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  visibility: "client" | "internal";
  created_at: Date;
  message_id?: string | null;
}

export async function listSupportAttachments(userId: string, ticketId: string): Promise<SupportAttachment[]> {
  return withUser(userId, async (db) => (await db.query<SupportAttachment>(
    `select a.id, f.filename, f.mime_type, f.size_bytes, a.visibility, a.created_at, a.message_id from support_attachments a
     join private_files f on f.id = a.private_file_id and f.status = 'ready'
     where a.ticket_id = $1 and a.status = 'attached' order by a.created_at`, [ticketId],
  )).rows);
}

interface StageInput { name: string; bytes: Buffer }

function checkFile(file: StageInput, maxMb: number) {
  const filename = safeFilename(file.name);
  const mime = mimeForFilename(filename);
  if (!mime) throw new AppError("invalid_input", "Choose a PNG, JPG, WebP, PDF, Word, CSV or text file.");
  if (!file.bytes.length) throw new AppError("invalid_input", "That file is empty.");
  if (file.bytes.length > maxMb * 1024 * 1024) throw new AppError("invalid_input", `Files can be up to ${maxMb} MB.`);
  return { filename, mime };
}

async function save(userId: string, orgId: string, file: StageInput, visibility: "client" | "internal", maxMb: number) {
  const limit = await consumeRateLimit(RATE_LIMITS.uploadByUser, userId);
  if (!limit.allowed) throw new AppError("rate_limited", "Upload limit reached. Try again later.");
  const { filename, mime } = checkFile(file, maxMb);
  const stored = await uploadPrivateFile({
    userId, orgId, bucket: "support-attachments", path: `${orgId}/${crypto.randomUUID()}/${filename}`, bytes: file.bytes, contentType: mime, filename, visibility, maxBytes: maxMb * 1024 * 1024,
  });
  return { stored, filename, mime };
}

/**
 * Saves a file the person has chosen but not yet sent. It belongs to its uploader alone until the message or request that carries
 * it is submitted, and is removed automatically if that never happens.
 */
export async function stageSupportFile(userId: string, orgId: string, file: StageInput, opts: { internal?: boolean } = {}) {
  const settings = await loadSupportSettings();
  const visibility = opts.internal ? "internal" : "client";
  // A person can have a handful of unsent files at a time; anything more is almost certainly a script.
  const pending = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from support_attachments where created_by = $1 and org_id = $2 and status = 'staged'", [userId, orgId]));
  if ((pending.rows[0]?.n ?? 0) >= 20) throw new AppError("rate_limited", "You have several files waiting to be sent. Send or remove some first.");
  if (opts.internal) {
    const staff = await withUser(userId, async (db) => (await db.query<{ staff: boolean }>("select app.staff_assigned($1) as staff", [orgId])).rows[0]?.staff === true);
    if (!staff) throw new AppError("forbidden", "Internal attachments require assigned agency access.");
  }
  const { stored, filename, mime } = await save(userId, orgId, file, visibility, settings.maxAttachmentMb);
  try {
    return await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into support_attachments (org_id, ticket_id, private_file_id, visibility, created_by, status, expires_at)
         values ($1, null, $2, $3, $4, 'staged', now() + make_interval(hours => $5)) returning id`,
        [orgId, stored.id, visibility, userId, settings.stagedUploadTtlHours],
      );
      return { id: rows[0].id, filename, mime_type: mime, size_bytes: file.bytes.length, visibility: visibility as "client" | "internal" };
    });
  } catch (error) {
    await removePrivateFile({ userId, orgId, bucket: stored.bucket, path: stored.storageKey }).catch(() => undefined);
    throw error;
  }
}

/** The uploader taking back a file they staged and then decided not to send. */
export async function discardStagedFile(userId: string, attachmentId: string): Promise<void> {
  const row = await withSystem(async (db) =>
    (await db.query<{ id: string; org_id: string; created_by: string | null; status: string; storage_key: string; private_file_id: string }>(
      `select a.id, a.org_id, a.created_by, a.status, f.storage_key, a.private_file_id from support_attachments a join private_files f on f.id = a.private_file_id where a.id = $1`,
      [attachmentId],
    )).rows[0],
  );
  // Someone else's file, or one already sent, reads as not found: there is nothing here for this person to remove.
  if (!row || row.created_by !== userId || row.status !== "staged") throw new AppError("not_found", "Attachment not found.");
  await withSystem(async (db) => {
    await db.query("update support_attachments set status = 'removed' where id = $1 and status = 'staged'", [attachmentId]);
    await db.query("update private_files set status = 'deleted' where id = $1", [row.private_file_id]);
  });
  await removeStoredObjectTrusted({ orgId: row.org_id, bucket: "support-attachments", storageKey: row.storage_key }).catch(() => undefined);
}

/**
 * Attaches staged files to a request (and optionally one message). Every file must be the sender's own, from this workspace,
 * still staged and unexpired, with the visibility the message needs; anything else is refused instead of silently dropped.
 */
export async function bindStagedAttachments(
  db: Queryable,
  p: { ticketId: string; orgId: string; messageId: string | null; userId: string; ids: readonly string[]; visibility: "client" | "internal"; maxCount: number },
): Promise<number> {
  const ids = [...new Set(p.ids)];
  if (!ids.length) return 0;
  if (ids.length > p.maxCount) throw new AppError("invalid_input", `You can attach up to ${p.maxCount} files at a time.`);
  const { rows } = await db.query<{ id: string }>(
    `update support_attachments set ticket_id = $2, message_id = $3, status = 'attached', expires_at = null
     where id = any($1::uuid[]) and org_id = $4 and created_by = $5 and status = 'staged' and visibility = $6 and (expires_at is null or expires_at > now())
     returning id`,
    [ids, p.ticketId, p.messageId, p.orgId, p.userId, p.visibility],
  );
  if (rows.length !== ids.length) throw new AppError("invalid_input", "One of the attachments is no longer available. Remove it and add it again.");
  return rows.length;
}

/** Direct upload to an existing request (outside a message): the original behaviour, now with the wider file types and settings limits. */
export async function attachSupportFile(userId: string, ticketId: string, file: StageInput, internal = false) {
  const ticket = await withUser(userId, async (db) => (await db.query<{ org_id: string; status: string; staff: boolean }>(
    "select org_id, status, app.staff_assigned(org_id) as staff from support_tickets where id = $1", [ticketId],
  )).rows[0]);
  if (!ticket) throw new AppError("not_found", "Support request not found.");
  if (ticket.status === "closed") throw new AppError("conflict", "This request is closed.");
  if (internal && !ticket.staff) throw new AppError("forbidden", "Internal attachments require assigned agency access.");
  const settings = await loadSupportSettings();
  const visibility = internal ? "internal" : "client";
  const { stored, filename } = await save(userId, ticket.org_id, file, visibility, settings.maxAttachmentMb);
  try {
    return await withSystem(async (db) => {
      const inserted = await db.query<{ id: string }>(
        "insert into support_attachments (org_id, ticket_id, private_file_id, visibility, created_by, status) values ($1, $2, $3, $4, $5, 'attached') returning id",
        [ticket.org_id, ticketId, stored.id, visibility, userId],
      );
      await recordAudit({ orgId: ticket.org_id, actorKind: ticket.staff ? "agency" : "user", actorUserId: userId, action: "support.attachment_added", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { visibility, size: file.bytes.length } }, db);
      return { id: inserted.rows[0].id, filename };
    });
  } catch (error) {
    await removePrivateFile({ userId, orgId: ticket.org_id, bucket: stored.bucket, path: stored.storageKey }).catch(() => undefined);
    throw error;
  }
}

/** A short-lived link, issued only if the person can see the attachment (row-level security) and the file is intact. */
export async function supportAttachmentDownload(userId: string, id: string) {
  const file = await withUser(userId, async (db) => (await db.query<{ org_id: string; storage_key: string }>(
    `select a.org_id, f.storage_key from support_attachments a join private_files f on f.id = a.private_file_id and f.status = 'ready'
     where a.id = $1 and a.status <> 'removed'`, [id],
  )).rows[0]);
  if (!file) throw new AppError("not_found", "Attachment not found.");
  return signPrivateFile({ userId, orgId: file.org_id, bucket: "support-attachments", path: file.storage_key });
}

// ---------------------------------------------------------------------------
// Scheduled cleanup
// ---------------------------------------------------------------------------

async function purge(rows: Array<{ id: string; org_id: string; private_file_id: string; storage_key: string }>, mark: "removed"): Promise<number> {
  let done = 0;
  for (const r of rows) {
    // Reads are revoked first; if the bytes cannot be removed this time the row stays and the next run tries again.
    await withSystem((db) => db.query("update private_files set status = 'deleted' where id = $1", [r.private_file_id]));
    try {
      await removeStoredObjectTrusted({ orgId: r.org_id, bucket: "support-attachments", storageKey: r.storage_key });
    } catch {
      continue;
    }
    await withSystem((db) => db.query("update support_attachments set status = $2 where id = $1", [r.id, mark]));
    done += 1;
  }
  return done;
}

/** Removes files that were staged but never sent, once their hold has expired. */
export async function cleanupStagedUploads(limit = 100): Promise<number> {
  const rows = await withSystem(async (db) =>
    (await db.query<{ id: string; org_id: string; private_file_id: string; storage_key: string }>(
      `select a.id, a.org_id, a.private_file_id, f.storage_key from support_attachments a join private_files f on f.id = a.private_file_id
       where a.status = 'staged' and a.expires_at < now() order by a.expires_at limit $1`,
      [limit],
    )).rows,
  );
  return purge(rows, "removed");
}

/** Deletes the files of requests that have been closed longer than the retention period the Super Admin configured (off by default). */
export async function purgeRetainedAttachments(limit = 100): Promise<number> {
  const settings = await loadSupportSettings();
  if (!settings.attachmentRetentionDays) return 0;
  const rows = await withSystem(async (db) =>
    (await db.query<{ id: string; org_id: string; private_file_id: string; storage_key: string }>(
      `select a.id, a.org_id, a.private_file_id, f.storage_key from support_attachments a
       join private_files f on f.id = a.private_file_id join support_tickets t on t.id = a.ticket_id
       where a.status = 'attached' and t.status = 'closed' and t.closed_at < now() - make_interval(days => $2)
       order by t.closed_at limit $1`,
      [limit, settings.attachmentRetentionDays],
    )).rows,
  );
  return purge(rows, "removed");
}
