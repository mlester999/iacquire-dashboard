import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { withSystem, withUser } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { createSupabaseAdminClient } from "@/server/supabase/clients";
import { assertStorageAllowed } from "@/server/fairuse/service";

export type PrivateBucket = "company-documents" | "support-attachments" | "project-files" | "project-uploads" | "portfolio-assets" | "brand-assets";
export interface PrivateFileInput { userId: string; orgId: string; bucket: PrivateBucket; path: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIMES: Record<PrivateBucket, string[]> = {
  "company-documents": ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown", "text/csv"],
  "support-attachments": ["application/pdf", "image/png", "image/jpeg", "text/plain"],
  "project-files": ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/png", "image/jpeg", "text/plain", "text/markdown", "text/csv"],
  "project-uploads": ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/png", "image/jpeg", "text/plain", "text/markdown", "text/csv"],
  "portfolio-assets": ["image/png", "image/jpeg", "image/webp"],
  "brand-assets": ["image/png", "image/jpeg", "image/webp"],
};
export function validPrivateFilePath(orgId: string, key: string): boolean {
  const parts = key.split("/");
  return UUID.test(orgId) && parts.length >= 2 && parts.length <= 3 && parts[0] === orgId && UUID.test(parts[1]) &&
    (parts.length === 2 || /^[A-Za-z0-9_. ()-]{1,200}$/.test(parts[2]) && parts[2] !== "." && parts[2] !== "..");
}
function assertInput(input: PrivateFileInput) {
  if (!UUID.test(input.userId) || !Object.hasOwn(MIMES, input.bucket) || !validPrivateFilePath(input.orgId, input.path)) {
    throw new AppError("invalid_input", "Invalid private file path.");
  }
}
function localMode() { return env().AUTH_PROVIDER === "local" && env().NODE_ENV !== "production"; }
function localPath(input: PrivateFileInput) {
  // Local synthetic demos only (production uses Supabase Storage). The runtime directory is
  // intentionally not traced into the build output, so the bundler must not follow it.
  const root = path.resolve(/* turbopackIgnore: true */ process.cwd(), env().UPLOAD_DIR);
  // Company documents keep their original local layout so existing demo files remain readable.
  return path.join(/* turbopackIgnore: true */ root, ...(input.bucket === "company-documents" ? [] : [input.bucket]), input.path);
}
async function requirePermission(input: PrivateFileInput, write: boolean, visibility: "client" | "internal") {
  assertInput(input);
  const allowed = await withUser(input.userId, async (db) => (await db.query<{ allowed: boolean }>(
    "select app.file_permission($1, $2, $3, $4) as allowed", [input.orgId, input.bucket, write, visibility],
  )).rows[0]?.allowed);
  if (!allowed) throw new AppError("forbidden", "You don't have access to this file.");
}
async function requireFile(input: PrivateFileInput) {
  assertInput(input);
  const file = await withUser(input.userId, async (db) => (await db.query<{
    id: string; filename: string; mime_type: string; visibility: "client" | "internal";
  }>("select id, filename, mime_type, visibility from private_files where org_id = $1 and bucket = $2 and storage_key = $3",
  [input.orgId, input.bucket, input.path])).rows[0]);
  if (!file) throw new AppError("not_found", "File not found.");
  return file;
}
function validSignature(bytes: Buffer, mime: string) {
  if (mime === "application/pdf") return bytes.subarray(0, 4).equals(Buffer.from("%PDF"));
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/webp") return bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP"));
  if (mime.includes("wordprocessingml")) return bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
  return !bytes.subarray(0, 8192).includes(0);
}

/** Saves validated bytes to a private bucket. Server authorization is rechecked from PostgreSQL. */
export async function uploadPrivateFile(input: PrivateFileInput & {
  bytes: Buffer; contentType: string; visibility?: "client" | "internal"; filename?: string;
}) {
  const visibility = input.visibility ?? (input.bucket === "project-files" ? "internal" : "client");
  await requirePermission(input, true, visibility);
  if (!input.bytes.length || input.bytes.length > 10 * 1024 * 1024 || !MIMES[input.bucket].includes(input.contentType) || !validSignature(input.bytes, input.contentType)) {
    throw new AppError("invalid_input", "Choose a supported file up to 10 MB with contents matching its type.");
  }
  // Refuses only NEW storage, and only when the agency set a limit and chose to enforce it. Nothing existing is touched.
  await assertStorageAllowed(input.orgId, input.bytes.length);
  const id = crypto.randomUUID();
  const filename = (input.filename ?? input.path.split("/").at(-1) ?? "document").slice(0, 200);
  await withSystem((db) => db.query(
    "insert into private_files(id,org_id,bucket,storage_key,filename,mime_type,size_bytes,visibility,uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id,input.orgId,input.bucket,input.path,filename,input.contentType,input.bytes.length,visibility,input.userId],
  ));
  try {
    if (localMode()) {
      const filename = localPath(input);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, input.bytes, { flag: "wx" });
    } else {
      const { error } = await createSupabaseAdminClient().storage.from(input.bucket).upload(input.path, input.bytes, { contentType: input.contentType, upsert: false });
      if (error) throw new AppError("integration_unavailable", "Private storage could not save this file. Please try again.");
    }
    await withSystem((db) => db.query("update private_files set status = 'ready' where id = $1", [id]));
  } catch (error) {
    await withSystem((db) => db.query("update private_files set status = 'deleted' where id = $1", [id]));
    throw error;
  }
  return { id, storageKey: input.path, bucket: input.bucket };
}

/** Authorizes each read. Production uses Supabase private Storage; demo mode retains local files. */
export async function readPrivateFile(input: PrivateFileInput) {
  const file = await requireFile(input);
  if (localMode()) return { ...file, bytes: await fs.readFile(localPath(input)) };
  const { data, error } = await createSupabaseAdminClient().storage.from(input.bucket).download(input.path);
  if (error || !data) throw new AppError("integration_unavailable", "Private storage is unavailable. Please try again.");
  return { ...file, bytes: Buffer.from(await data.arrayBuffer()) };
}

/**
 * Reads a stored file for content the caller has ALREADY authorized by other means (for example a
 * published portfolio image that every signed-in client may see). It performs no permission check of
 * its own, so it must never be reachable with a file id taken directly from a request.
 */
export async function readAuthorizedPrivateFile(fileId: string) {
  if (!UUID.test(fileId)) throw new AppError("invalid_input", "Invalid file.");
  const file = (await withSystem((db) => db.query<{ org_id: string; bucket: PrivateBucket; storage_key: string; filename: string; mime_type: string }>(
    "select org_id, bucket, storage_key, filename, mime_type from private_files where id = $1 and status = 'ready'", [fileId],
  ))).rows[0];
  if (!file) throw new AppError("not_found", "File not found.");
  const input = { userId: "00000000-0000-0000-0000-000000000000", orgId: file.org_id, bucket: file.bucket, path: file.storage_key };
  if (localMode()) return { ...file, bytes: await fs.readFile(localPath(input)) };
  const { data, error } = await createSupabaseAdminClient().storage.from(file.bucket).download(file.storage_key);
  if (error || !data) throw new AppError("integration_unavailable", "Private storage is unavailable. Please try again.");
  return { ...file, bytes: Buffer.from(await data.arrayBuffer()) };
}

/** Short-lived bearer URL issued only after tenant + file visibility checks. Never logged. */
export async function signPrivateFile(input: PrivateFileInput & { expiresIn?: number }): Promise<string> {
  const file = await requireFile(input);
  if (localMode()) return `/api/files/${file.id}`; // Local route rechecks the session on every request.
  const expiresIn = Math.max(1, Math.min(120, Math.floor(input.expiresIn ?? 60)));
  const { data, error } = await createSupabaseAdminClient().storage.from(input.bucket).createSignedUrl(input.path, expiresIn, { download: file.filename });
  if (error || !data) throw new AppError("integration_unavailable", "Private storage could not create a download link.");
  return data.signedUrl;
}

export async function removePrivateFile(input: PrivateFileInput) {
  const file = await requireFile(input);
  await requirePermission(input, true, file.visibility);
  // Revoke future reads before deleting bytes. Failed cleanup never reopens access.
  await withSystem((db) => db.query("update private_files set status = 'deleted' where id = $1", [file.id]));
  if (localMode()) await fs.rm(localPath(input), { force: true });
  else {
    const { error } = await createSupabaseAdminClient().storage.from(input.bucket).remove([input.path]);
    if (error) throw new AppError("integration_unavailable", "Access has been removed; storage cleanup needs another attempt.");
  }
}

/**
 * Removes the stored bytes of a file for an offboarding purge that has already been authorized in full. It performs no per-user check, so
 * it must never be reachable with a file id taken from a request.
 */
export async function removeStoredObjectTrusted(file: { orgId: string; bucket: PrivateBucket; storageKey: string }): Promise<void> {
  const input = { userId: "00000000-0000-0000-0000-000000000000", orgId: file.orgId, bucket: file.bucket, path: file.storageKey };
  if (localMode()) {
    await fs.rm(localPath(input), { force: true });
    return;
  }
  const { error } = await createSupabaseAdminClient().storage.from(file.bucket).remove([file.storageKey]);
  if (error) throw new AppError("integration_unavailable", "A stored file could not be removed.");
}
