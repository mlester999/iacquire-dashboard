import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { workspaceEntitlements } from "@/server/entitlements";
import { BUCKET_STORAGE, PRIVATE_BUCKETS, storageDecision, type PrivateBucket } from "@/lib/storage-policy";
import { formatMetricValue } from "@/lib/fair-use";

// The server's side of the storage policy (src/lib/storage-policy.ts): asked by uploadPrivateFile for every new file, so no feature can store managed media for a workspace the plan
// does not cover. It reads the plan from the database on every call (a plan can lapse between two uploads), applies the time-aware entitlement the rest of the product uses (a plan
// past due keeps managed storage through its grace period and not a day longer, whether or not the scheduler has marked it expired), and keeps a ceiling on managed media so it is never
// unlimited. It only ever refuses NEW files: nothing stored is read-blocked, moved or deleted by a lapse.

const MANAGED_MEDIA_BUCKETS = PRIVATE_BUCKETS.filter((b) => BUCKET_STORAGE[b].class === "managed_media");

/** The most managed media one workspace may keep (SOCIAL_MEDIA_STORAGE_MB, 2 GB until the founder says otherwise). */
export const managedMediaLimitBytes = () => env().SOCIAL_MEDIA_STORAGE_MB * 1024 * 1024;

export async function assertStorageEntitled(orgId: string, bucket: PrivateBucket, addBytes: number): Promise<void> {
  const entry = BUCKET_STORAGE[bucket];
  if (!entry) throw new AppError("invalid_input", "That storage area does not exist.");
  if (entry.class !== "managed_media") return; // core files never wait on the plan
  const verdict = await withSystem(async (db) => {
    const entitlements = await workspaceEntitlements(db, orgId);
    const decision = storageDecision(bucket, { managedStorage: entitlements.managedStorage });
    if (!decision.allowed) return { kind: "plan" as const, reason: decision.reason ?? "" };
    const used = Number((await db.query<{ n: string }>(
      "select coalesce(sum(size_bytes), 0)::text as n from private_files where org_id = $1 and bucket = any($2::text[]) and status = 'ready'", [orgId, MANAGED_MEDIA_BUCKETS],
    )).rows[0].n);
    return used + addBytes > managedMediaLimitBytes() ? { kind: "full" as const, used } : null;
  });
  if (!verdict) return;
  if (verdict.kind === "plan") throw new AppError("plan_required", verdict.reason);
  throw new AppError("usage_limit", `Your managed media storage is full (${formatMetricValue("storage_bytes", verdict.used)} of ${formatMetricValue("storage_bytes", managedMediaLimitBytes())}). Remove files you no longer need to free up space.`);
}

export interface StorageUsageRow {
  bucket: PrivateBucket;
  class: "core" | "managed_media";
  what: string;
  files: number;
  bytes: number;
}

/** What a workspace stores, bucket by bucket, from its stored-file records (deleted files do not count), and what its managed media may grow to. */
export async function workspaceStorageUsage(orgId: string): Promise<{ rows: StorageUsageRow[]; totalBytes: number; managedMedia: { bytes: number; limitBytes: number; entitled: boolean } }> {
  const { found, entitled } = await withSystem(async (db) => ({
    found: (await db.query<{ bucket: PrivateBucket; files: number; bytes: string }>(
      "select bucket, count(*)::int as files, coalesce(sum(size_bytes), 0)::text as bytes from private_files where org_id = $1 and status = 'ready' group by bucket", [orgId],
    )).rows,
    entitled: (await workspaceEntitlements(db, orgId)).managedStorage,
  }));
  const byBucket = new Map(found.map((r) => [r.bucket, r]));
  const rows = PRIVATE_BUCKETS.map((bucket): StorageUsageRow => ({ bucket, class: BUCKET_STORAGE[bucket].class, what: BUCKET_STORAGE[bucket].what, files: byBucket.get(bucket)?.files ?? 0, bytes: Number(byBucket.get(bucket)?.bytes ?? 0) }));
  return {
    rows,
    totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
    managedMedia: { bytes: rows.filter((r) => r.class === "managed_media").reduce((n, r) => n + r.bytes, 0), limitBytes: managedMediaLimitBytes(), entitled },
  };
}
