import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import { assertAgencyAccess, lockAgencySetupAccess, mutateSetup, recordSetupEvent } from "@/server/setup/core";
import { uploadPrivateFile, removePrivateFile, signPrivateFile } from "@/server/storage/private";

const visibilitySchema = z.enum(["internal", "client"]);
const labelSchema = z.string().trim().min(1).max(120);

export async function attachSetupDocument(admin: SessionUser, orgId: string, taskId: string, input: { file: File; visibility: unknown; label: unknown }) {
  await assertAgencyAccess(admin, orgId);
  const visibility = visibilitySchema.parse(input.visibility);
  const label = labelSchema.parse(input.label);
  if (!z.string().uuid().safeParse(taskId).success) throw new AppError("not_found", "Setup step not found.");
  if (input.file.size <= 0 || input.file.size > 10 * 1024 * 1024) throw new AppError("invalid_input", "Choose a document up to 10 MB.");
  const exists = await withSystem((db) => db.query("select 1 from client_setup_tasks where id = $1 and org_id = $2", [taskId, orgId]));
  if (!exists.rows.length) throw new AppError("not_found", "Setup step not found.");
  const filename = input.file.name.replace(/[^A-Za-z0-9_. ()-]/g, "_").slice(0, 180) || "document";
  const stored = await uploadPrivateFile({ userId: admin.id, orgId, bucket: "project-files", path: `${orgId}/${crypto.randomUUID()}/${filename}`, bytes: Buffer.from(await input.file.arrayBuffer()), contentType: input.file.type, visibility, filename });
  try {
    return await mutateSetup(orgId, async (db, inst) => {
      await lockAgencySetupAccess(db,admin,orgId);
      const id = crypto.randomUUID();
      await db.query("insert into client_setup_task_attachments (id,org_id,task_id,label,url,kind,visibility,created_by,storage_bucket,storage_key) values ($1,$2,$3,$4,$5,'documentation',$6,$7,$8,$9)",
        [id,orgId,taskId,label,`/api/setup/attachments/${id}`,visibility,admin.id,stored.bucket,stored.storageKey]);
      await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "attachment_added", visibility: "internal", metadata: { kind: "documentation", visibility, privateStorage: true } });
      await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.document_attached", targetType: "setup_task", targetId: taskId, result: "success", metadata: { visibility, bytes: input.file.size } }, db);
      return { attachmentId: id };
    });
  } catch (error) {
    await removePrivateFile({ userId: admin.id, orgId, bucket: stored.bucket, path: stored.storageKey }).catch(() => undefined);
    throw error;
  }
}

/** Resolve an opaque attachment ID under RLS before issuing any private signed link. */
export async function setupDocumentLink(userId: string, attachmentId: string): Promise<string> {
  const { rows } = await withUser(userId, (db) => db.query<{ org_id: string; storage_bucket: "project-files" | null; storage_key: string | null }>(
    "select org_id,storage_bucket,storage_key from client_setup_task_attachments where id=$1", [attachmentId],
  ));
  const file = rows[0];
  if (!file?.storage_bucket || !file.storage_key) throw new AppError("not_found", "Document not found.");
  return signPrivateFile({ userId, orgId: file.org_id, bucket: file.storage_bucket, path: file.storage_key, expiresIn: 60 });
}
