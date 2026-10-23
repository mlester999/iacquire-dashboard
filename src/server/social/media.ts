import "server-only";
import crypto from "node:crypto";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { readPrivateFile, removePrivateFile, uploadPrivateFile, validPrivateFileSignature } from "@/server/storage/private";
import type { OrgContext } from "@/server/tenancy/context";
import { draftProblems, IMAGE_MIMES, MEDIA_MAX_BYTES, PLATFORMS, VIDEO_MIMES, type MediaFacts, type Platform } from "@/lib/social/rules";
import { imageSize } from "@/lib/social/image-size";
import { mediaStoragePolicy, type StoragePolicy } from "@/lib/social/media-policy";

// The media library for posts. Bytes live in the workspace's private storage (the `social-media` bucket) only for clients whose plan includes managed storage; for
// everyone else the policy says honestly that no storage is available yet (connecting Google Drive or OneDrive is not built). A file is checked on the way in:
// its type, its contents (a renamed file is refused), its size, and for pictures its shape, against each platform's rules. Nothing is shown to another workspace.

export interface MediaView {
  id: string;
  filename: string;
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  status: "ready" | "invalid" | "removed";
  /** Per platform: whether it can be posted there, and why not. */
  validation: Record<string, { ok: boolean; problems: string[] }>;
  usedBy: number;
  createdAt: string;
}

const MANAGED_STATUSES = ["active", "past_due", "cancel_requested"];

/** Where this workspace's media may live right now. */
export async function getMediaPolicy(ctx: OrgContext): Promise<StoragePolicy> {
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  const managed = await withSystem(async (db) => (await db.query("select 1 from maintenance_subscriptions where org_id = $1 and status = any($2::text[]) limit 1", [ctx.org.orgId, MANAGED_STATUSES])).rows.length > 0);
  // Google Drive and OneDrive connections are not built (they need an OAuth app registered with each provider), so they are never reported as connected.
  return mediaStoragePolicy({ managedPlanActive: managed, googleDriveConnected: false, onedriveConnected: false });
}

function platformValidation(facts: MediaFacts): Record<string, { ok: boolean; problems: string[] }> {
  const out: Record<string, { ok: boolean; problems: string[] }> = {};
  for (const p of PLATFORMS as readonly Platform[]) {
    const kind = facts.kind;
    const problems = draftProblems(p, { kind, caption: "x", hashtags: [], linkUrl: null }, [facts]).filter((x) => x.code.startsWith("media") || x.code.startsWith("instagram_image") || x.code === "image_size_unknown" || x.code === "kind_unsupported");
    out[p] = { ok: !problems.some((x) => x.level === "blocking"), problems: problems.map((x) => x.message) };
  }
  return out;
}

const SAFE_NAME = /[^A-Za-z0-9_. ()-]/g;
const cleanName = (n: string) => n.normalize("NFKD").replace(SAFE_NAME, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 120) || "file";

/** Adds a picture or video to the library. */
export async function uploadMedia(ctx: OrgContext, input: { filename: string; contentType: string; bytes: Buffer; altText?: string | null }): Promise<MediaView> {
  if (!ctx.can("social.create")) throw new AppError("forbidden", "Your role can't add media.");
  const policy = await getMediaPolicy(ctx);
  if (!policy.managedUploadAllowed) throw new AppError("forbidden", policy.summary);
  const isImage = (IMAGE_MIMES as readonly string[]).includes(input.contentType);
  const isVideo = (VIDEO_MIMES as readonly string[]).includes(input.contentType);
  if (!isImage && !isVideo) throw new AppError("invalid_input", "Choose a JPEG, PNG or WebP picture, or an MP4 video.");
  if (!input.bytes.length || input.bytes.length > MEDIA_MAX_BYTES) throw new AppError("invalid_input", "Choose a file up to 50 MB.");
  if (!validPrivateFileSignature(input.bytes, input.contentType)) throw new AppError("invalid_input", "That file's contents do not match its type. Choose the original picture or video.");
  const size = isImage ? imageSize(input.bytes, input.contentType) : null;
  if (isImage && !size) throw new AppError("invalid_input", "That picture could not be read. Choose another file.");
  const name = cleanName(input.filename);
  const fileKey = crypto.randomUUID();
  const stored = await uploadPrivateFile({
    userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "social-media", path: `${ctx.org.orgId}/${fileKey}/${name}`, bytes: input.bytes, contentType: input.contentType,
    filename: name, maxBytes: MEDIA_MAX_BYTES,
  });
  const facts: MediaFacts = { id: "pending", kind: isImage ? "image" : "video", mimeType: input.contentType, sizeBytes: input.bytes.length, width: size?.width ?? null, height: size?.height ?? null, status: "ready" };
  const validation = platformValidation(facts);
  const sha = crypto.createHash("sha256").update(input.bytes).digest("hex");
  const alt = input.altText?.replace(/\s+/g, " ").trim().slice(0, 400) || null;
  const id = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into social_media_assets (org_id, source, private_file_id, kind, filename, mime_type, size_bytes, width, height, sha256, alt_text, status, validation, uploaded_by)
       values ($1, 'managed', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ready', $11::jsonb, $12) returning id`,
      [ctx.org.orgId, stored.id, facts.kind, name, input.contentType, input.bytes.length, facts.width, facts.height, sha, alt, JSON.stringify(validation), ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.media_added", targetType: "social_media_asset", targetId: rows[0].id, result: "success", metadata: { kind: facts.kind, bytes: input.bytes.length } }, db);
    return rows[0].id;
  });
  const v = (await listMedia(ctx)).find((m) => m.id === id);
  if (!v) throw new AppError("internal", "The file was saved but could not be read back.");
  return v;
}

export async function listMedia(ctx: OrgContext): Promise<MediaView[]> {
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; filename: string; kind: "image" | "video"; mime_type: string; size_bytes: number; width: number | null; height: number | null; alt_text: string | null; status: "ready" | "invalid" | "removed"; validation: MediaView["validation"]; created_at: Date; used: string }>(
      `select a.id, a.filename, a.kind, a.mime_type, a.size_bytes, a.width, a.height, a.alt_text, a.status, a.validation, a.created_at,
         (select count(*)::text from social_posts p where p.org_id = a.org_id and a.id = any(p.media_asset_ids)) as used
       from social_media_assets a where a.org_id = $1 and a.status <> 'removed' order by a.created_at desc limit 300`, [ctx.org.orgId],
    );
    return rows.map((r) => ({ id: r.id, filename: r.filename, kind: r.kind, mimeType: r.mime_type, sizeBytes: r.size_bytes, width: r.width, height: r.height, altText: r.alt_text, status: r.status, validation: r.validation, usedBy: Number(r.used), createdAt: new Date(r.created_at).toISOString() }));
  });
}

/** Removes a file from the library. A file a post still needs (one not yet published, cancelled or rejected) cannot be removed. */
export async function removeMedia(ctx: OrgContext, id: string): Promise<void> {
  if (!ctx.can("social.create")) throw new AppError("forbidden", "Your role can't remove media.");
  const row = await withSystem(async (db) => {
    const a = (await db.query<{ id: string; private_file_id: string | null }>("select id, private_file_id from social_media_assets where id = $1 and org_id = $2 and status <> 'removed'", [id, ctx.org.orgId])).rows[0];
    if (!a) throw new AppError("not_found", "That file was not found.");
    const inUse = await db.query<{ n: string }>("select count(*)::text as n from social_posts where org_id = $1 and $2::uuid = any(media_asset_ids) and status not in ('published', 'cancelled', 'rejected')", [ctx.org.orgId, id]);
    if (Number(inUse.rows[0].n) > 0) throw new AppError("conflict", `This file is used by ${inUse.rows[0].n} post${inUse.rows[0].n === "1" ? "" : "s"} that ${inUse.rows[0].n === "1" ? "has" : "have"} not been published yet. Change or cancel ${inUse.rows[0].n === "1" ? "it" : "them"} first.`);
    return a;
  });
  if (row.private_file_id) {
    const f = (await withSystem((db) => db.query<{ storage_key: string }>("select storage_key from private_files where id = $1 and org_id = $2", [row.private_file_id, ctx.org.orgId]))).rows[0];
    if (f) await removePrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "social-media", path: f.storage_key });
  }
  await withSystem(async (db) => {
    await db.query("update social_media_assets set status = 'removed' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.media_removed", targetType: "social_media_asset", targetId: id, result: "success" }, db);
  });
}

/** The bytes of a library file for the person's own preview. Only a file of this workspace, only for someone who may see social media. */
export async function readMediaForPreview(ctx: OrgContext, id: string): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  const a = (await withSystem((db) => db.query<{ private_file_id: string | null; mime_type: string; filename: string }>("select private_file_id, mime_type, filename from social_media_assets where id = $1 and org_id = $2 and status = 'ready'", [id, ctx.org.orgId]))).rows[0];
  if (!a?.private_file_id) throw new AppError("not_found", "That file was not found.");
  const f = (await withSystem((db) => db.query<{ storage_key: string }>("select storage_key from private_files where id = $1 and org_id = $2 and status = 'ready'", [a.private_file_id, ctx.org.orgId]))).rows[0];
  if (!f) throw new AppError("not_found", "That file was not found.");
  const file = await readPrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "social-media", path: f.storage_key });
  return { bytes: file.bytes, mimeType: a.mime_type, filename: a.filename };
}
