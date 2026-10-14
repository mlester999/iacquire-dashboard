import "server-only";
import crypto from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { readPrivateFile, removePrivateFile, uploadPrivateFile } from "@/server/storage/private";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { removeSolidBackground } from "@/server/assets/background";
import type { OrgContext } from "@/server/tenancy/context";

/** Pooled hosting has real costs, so each workspace gets a bounded number of brand assets. */
export const MAX_ASSETS_PER_ORG = 60;
const MIN_SIDE = 16;
const MAX_SIDE = 8000;

export type AssetKind = "logo" | "image" | "reference";
export interface AssetView {
  id: string;
  kind: AssetKind;
  altText: string;
  width: number | null;
  height: number | null;
  processingStatus: "none" | "processed" | "failed" | "unsupported";
  processingNote: string | null;
  useVariant: "original" | "processed";
  hasProcessed: boolean;
  createdAt: string;
  url: string;
  processedUrl: string | null;
}

interface AssetRow {
  id: string;
  kind: AssetKind;
  alt_text: string;
  width: number | null;
  height: number | null;
  processing_status: AssetView["processingStatus"];
  processing_note: string | null;
  use_variant: "original" | "processed";
  processed_file_id: string | null;
  created_at: Date;
}

const toView = (r: AssetRow): AssetView => ({
  id: r.id,
  kind: r.kind,
  altText: r.alt_text,
  width: r.width,
  height: r.height,
  processingStatus: r.processing_status,
  processingNote: r.processing_note,
  useVariant: r.use_variant,
  hasProcessed: Boolean(r.processed_file_id),
  createdAt: new Date(r.created_at).toISOString(),
  url: `/api/assets/${r.id}`,
  processedUrl: r.processed_file_id ? `/api/assets/${r.id}?variant=processed` : null,
});

const safeName = (name: string) => name.normalize("NFKD").replace(/[^A-Za-z0-9_. ()-]/g, "").replace(/^\.+/, "").slice(0, 80) || "image";

/** Re-encodes the upload: proves it is a real raster image, applies orientation, and drops EXIF/metadata. */
async function normalizeImage(bytes: Buffer, kind: AssetKind) {
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw new AppError("invalid_input", "That doesn't look like a valid image. Use a PNG, JPG or WebP file.");
  }
  if (!meta.format || !["png", "jpeg", "webp"].includes(meta.format)) throw new AppError("invalid_input", "Use a PNG, JPG or WebP image.");
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_SIDE) throw new AppError("invalid_input", "That image is too small to use.");
  if (Math.max(meta.width, meta.height) > MAX_SIDE) throw new AppError("invalid_input", "That image is too large. Use one up to 8000 pixels on the longest side.");
  const maxSide = kind === "logo" ? 3000 : 2400;
  const pipeline = sharp(bytes, { limitInputPixels: 50_000_000 }).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
  // Logos keep their format (PNG stays lossless); photos become WebP, which is much lighter to host.
  if (kind === "logo" && meta.format === "png") return { bytes: await pipeline.png({ compressionLevel: 9 }).toBuffer(), contentType: "image/png", ext: "png" };
  if (kind === "logo" && meta.format === "jpeg") return { bytes: await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer(), contentType: "image/jpeg", ext: "jpg" };
  return { bytes: await pipeline.webp({ quality: kind === "logo" ? 92 : 84 }).toBuffer(), contentType: "image/webp", ext: "webp" };
}

export async function createAsset(ctx: OrgContext, input: { kind: AssetKind; bytes: Buffer; filename: string; altText?: string }): Promise<AssetView> {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only owners and managers can upload brand assets.");
  const limit = await consumeRateLimit(RATE_LIMITS.uploadByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're uploading quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  const { rows: count } = await withSystem((db) => db.query<{ n: string }>("select count(*) as n from org_assets where org_id = $1 and deleted_at is null", [ctx.org.orgId]));
  if (Number(count[0].n) >= MAX_ASSETS_PER_ORG) throw new AppError("usage_limit", `Your workspace can hold up to ${MAX_ASSETS_PER_ORG} brand images. Remove one to add another.`);

  const original = await normalizeImage(input.bytes, input.kind);
  const meta = await sharp(original.bytes).metadata();
  const base = { userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "brand-assets" as const };
  const name = safeName(input.filename.replace(/\.[^.]+$/, ""));
  const originalFile = await uploadPrivateFile({ ...base, path: `${ctx.org.orgId}/${crypto.randomUUID()}/${name}.${original.ext}`, bytes: original.bytes, contentType: original.contentType, filename: `${name}.${original.ext}` });

  // Logos get an optional transparent version. The original is always kept, and a failure is only a note.
  let processedFileId: string | null = null;
  let status: AssetView["processingStatus"] = "none";
  let note: string | null = null;
  if (input.kind === "logo") {
    try {
      const result = await removeSolidBackground(original.bytes);
      status = result.status;
      note = result.note;
      if (result.status === "processed") {
        const file = await uploadPrivateFile({ ...base, path: `${ctx.org.orgId}/${crypto.randomUUID()}/${name}-transparent.png`, bytes: result.bytes, contentType: "image/png", filename: `${name}-transparent.png` });
        processedFileId = file.id;
      }
    } catch {
      status = "failed";
      note = "Background removal isn't available right now; your original is unchanged.";
    }
  }

  const row = await withSystem(async (db) => {
    const { rows } = await db.query<AssetRow>(
      `insert into org_assets (org_id, kind, private_file_id, processed_file_id, processing_status, processing_note, width, height, alt_text, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id, kind, alt_text, width, height, processing_status, processing_note, use_variant, processed_file_id, created_at`,
      [ctx.org.orgId, input.kind, originalFile.id, processedFileId, status, note, meta.width ?? null, meta.height ?? null, (input.altText ?? "").slice(0, 200), ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "asset.uploaded", targetType: "org_asset", targetId: rows[0].id, result: "success", metadata: { kind: input.kind, bytes: original.bytes.length, processing: status } }, db);
    return rows[0];
  });
  return toView(row);
}

export async function listAssets(ctx: OrgContext, kind?: AssetKind): Promise<AssetView[]> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<AssetRow>(
      `select id, kind, alt_text, width, height, processing_status, processing_note, use_variant, processed_file_id, created_at
       from org_assets where org_id = $1 and ($2::text is null or kind = $2) order by created_at desc`,
      [ctx.org.orgId, kind ?? null],
    );
    return rows.map(toView);
  });
}

export async function assetsByIds(ctx: OrgContext, ids: string[]): Promise<AssetView[]> {
  if (!ids.length) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<AssetRow>(
      `select id, kind, alt_text, width, height, processing_status, processing_note, use_variant, processed_file_id, created_at
       from org_assets where org_id = $1 and id = any($2::uuid[])`,
      [ctx.org.orgId, ids],
    );
    return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is AssetRow => Boolean(r)).map(toView);
  });
}

async function owned(ctx: OrgContext, id: string) {
  const row = await withUser(ctx.user.id, async (db) => (await db.query<{ id: string; private_file_id: string; processed_file_id: string | null }>(
    "select id, private_file_id, processed_file_id from org_assets where id = $1 and org_id = $2", [id, ctx.org.orgId])).rows[0]);
  if (!row) throw new AppError("not_found", "Image not found.");
  return row;
}

export async function setAssetVariant(ctx: OrgContext, id: string, variant: "original" | "processed") {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only owners and managers can change brand assets.");
  const row = await owned(ctx, id);
  if (variant === "processed" && !row.processed_file_id) throw new AppError("invalid_input", "There is no transparent version of this image.");
  await withSystem((db) => db.query("update org_assets set use_variant = $3 where id = $1 and org_id = $2", [id, ctx.org.orgId, variant]));
}

export async function setAssetAlt(ctx: OrgContext, id: string, altText: string) {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only owners and managers can change brand assets.");
  await owned(ctx, id);
  await withSystem((db) => db.query("update org_assets set alt_text = $3 where id = $1 and org_id = $2", [id, ctx.org.orgId, altText.trim().slice(0, 200)]));
}

export async function deleteAsset(ctx: OrgContext, id: string) {
  if (!ctx.can("workspace.manage_profile")) throw new AppError("forbidden", "Only owners and managers can remove brand assets.");
  const row = await owned(ctx, id);
  const files = await withSystem((db) => db.query<{ id: string; storage_key: string }>(
    "select id, storage_key from private_files where id = any($1::uuid[]) and org_id = $2", [[row.private_file_id, row.processed_file_id].filter(Boolean), ctx.org.orgId]));
  await withSystem(async (db) => {
    await db.query("update org_assets set deleted_at = now() where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "asset.deleted", targetType: "org_asset", targetId: id, result: "success" }, db);
  });
  for (const f of files.rows) await removePrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "brand-assets", path: f.storage_key }).catch(() => undefined);
}

/** Reads an asset's bytes for the signed-in user's own organization. */
export async function readAsset(ctx: OrgContext, id: string, variant: "original" | "processed") {
  const row = await owned(ctx, id);
  const fileId = variant === "processed" ? row.processed_file_id : row.private_file_id;
  if (!fileId) throw new AppError("not_found", "Image not found.");
  const file = await withUser(ctx.user.id, async (db) => (await db.query<{ storage_key: string }>(
    "select storage_key from private_files where id = $1 and org_id = $2 and bucket = 'brand-assets'", [fileId, ctx.org.orgId])).rows[0]);
  if (!file) throw new AppError("not_found", "Image not found.");
  const data = await readPrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "brand-assets", path: file.storage_key });
  return { bytes: data.bytes, mimeType: data.mime_type };
}
