// The media library's storage: removing a file when the storage service fails, the per-workspace cap, and the client-workspace rule. Embedded Postgres; the
// stored files are local files, and a failing storage service is simulated by making the trusted delete throw.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { getMediaPolicy, listMedia, finishPendingMediaRemovals, readMediaForPreview, removeMedia, uploadMedia } from "@/server/social/media";
import { createPost } from "@/server/social/posts";
import { connect, rows, socialOrg, type SocialOrg } from "./support/social";

const storage = vi.hoisted(() => ({ failDelete: false }));
vi.mock("@/server/storage/private", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/private")>();
  return {
    ...actual,
    removeStoredObjectTrusted: async (...args: Parameters<typeof actual.removeStoredObjectTrusted>) => {
      if (storage.failDelete) throw new Error("storage unavailable");
      return actual.removeStoredObjectTrusted(...args);
    },
  };
});

/** A JPEG of the given size in bytes whose header says 1080 x 1080. */
const jpeg = (bytes = 40) => {
  const b = Buffer.alloc(bytes);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(1080, 7);
  b.writeUInt16BE(1080, 9);
  return b;
};

async function withManagedPlan(s: SocialOrg) {
  await withSystem((db) => db.query(
    "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now() - interval '30 days', current_date - 30)",
    [s.m.org.id, s.m.people.owner.id],
  ));
}

const onDisk = (storageKey: string) => fs.existsSync(`${process.env.UPLOAD_DIR ?? ".data/test-uploads"}/social-media/${storageKey}`);
/** The asset and the stored file it points at (only while it still points at one). */
const fileOf = async (assetId: string) => (await rows<{ private_file_id: string; storage_key: string; file_status: string; asset_status: string }>(
  "select a.private_file_id, f.storage_key, f.status as file_status, a.status as asset_status from social_media_assets a join private_files f on f.id = a.private_file_id where a.id = $1", [assetId],
))[0];

afterEach(() => {
  storage.failDelete = false;
  delete process.env.SOCIAL_MEDIA_STORAGE_MB;
  resetEnvCache();
});

describe("removing a file when storage fails", () => {
  it("never leaves a ready library file on a deleted copy: the file is removed from the library at once, and the clean-up finishes the storage delete", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const acc = await connect(s);
    const file = await uploadMedia(s.sales, { filename: "spare.jpg", contentType: "image/jpeg", bytes: jpeg() });
    const before = await fileOf(file.id);
    expect(onDisk(before.storage_key)).toBe(true);

    storage.failDelete = true;
    await expect(removeMedia(s.sales, file.id)).resolves.toBeUndefined(); // the person's removal worked; only the clean-up is outstanding

    // Not offered, cannot be previewed, cannot be put on a post; reads of the stored copy are already closed.
    expect(await listMedia(s.sales)).toEqual([]);
    await expect(readMediaForPreview(s.sales, file.id)).rejects.toThrow(/not found/);
    await expect(createPost(s.sales, { accountId: acc.id, kind: "image", caption: "Look", mediaAssetIds: [file.id] })).rejects.toThrow(/not found in your media library/);
    expect(await fileOf(file.id)).toMatchObject({ asset_status: "removed", file_status: "deleted", private_file_id: before.private_file_id });
    expect(onDisk(before.storage_key)).toBe(true); // the delete failed

    // The sweep retries while storage is down, then finishes.
    await finishPendingMediaRemovals();
    expect(onDisk(before.storage_key)).toBe(true);
    expect((await rows<{ private_file_id: string | null }>("select private_file_id from social_media_assets where id = $1", [file.id]))[0].private_file_id).toBe(before.private_file_id);
    storage.failDelete = false;
    expect(await finishPendingMediaRemovals()).toBeGreaterThanOrEqual(1);
    expect(onDisk(before.storage_key)).toBe(false);
    expect((await rows<{ private_file_id: string | null; status: string }>("select private_file_id, status from social_media_assets where id = $1", [file.id]))[0]).toEqual({ private_file_id: null, status: "removed" });
    expect(await finishPendingMediaRemovals()).toBe(0); // nothing left to do
  });

  it("removes a file whose stored record was already marked deleted by an earlier failed removal", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const file = await uploadMedia(s.sales, { filename: "stuck.jpg", contentType: "image/jpeg", bytes: jpeg() });
    await withSystem((db) => db.query("update private_files set status = 'deleted' where org_id = $1 and bucket = 'social-media'", [s.m.org.id]));
    await removeMedia(s.sales, file.id); // used to fail with "File not found" every time, leaving the asset ready
    expect((await rows<{ status: string }>("select status from social_media_assets where id = $1", [file.id]))[0].status).toBe("removed");
    expect(await listMedia(s.sales)).toEqual([]);
  });

  it("does not remove a file in use, and the file stays whole", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const acc = await connect(s);
    const file = await uploadMedia(s.sales, { filename: "used.jpg", contentType: "image/jpeg", bytes: jpeg() });
    await createPost(s.sales, { accountId: acc.id, kind: "image", caption: "Look", mediaAssetIds: [file.id] });
    await expect(removeMedia(s.sales, file.id)).rejects.toThrow(/used by 1 post/);
    const f = await fileOf(file.id);
    expect(f).toMatchObject({ asset_status: "ready", file_status: "ready" });
    expect(onDisk(f.storage_key)).toBe(true);
  });
});

describe("the storage cap", () => {
  const MB = 1024 * 1024;

  it("is 2 GB by default, reported with what is used, and absent when managed storage is not allowed", async () => {
    const s = await socialOrg();
    expect(await getMediaPolicy(s.viewer)).toMatchObject({ managedUploadAllowed: false, usedBytes: 0, limitBytes: null });
    await withManagedPlan(s);
    expect(await getMediaPolicy(s.viewer)).toMatchObject({ managedUploadAllowed: true, usedBytes: 0, limitBytes: 2048 * MB });
    await uploadMedia(s.sales, { filename: "a.jpg", contentType: "image/jpeg", bytes: jpeg(1000) });
    expect(await getMediaPolicy(s.viewer)).toMatchObject({ usedBytes: 1000, limitBytes: 2048 * MB });
  });

  it("follows SOCIAL_MEDIA_STORAGE_MB, refuses an upload that does not fit with how much is used, and counts only what is not removed", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    process.env.SOCIAL_MEDIA_STORAGE_MB = "1";
    resetEnvCache();
    expect((await getMediaPolicy(s.viewer)).limitBytes).toBe(MB);
    const first = await uploadMedia(s.sales, { filename: "one.jpg", contentType: "image/jpeg", bytes: jpeg(600_000) });
    const refused = await uploadMedia(s.sales, { filename: "two.jpg", contentType: "image/jpeg", bytes: jpeg(600_000) }).catch((e) => e);
    expect(refused).toMatchObject({ code: "usage_limit", message: expect.stringMatching(/doesn't fit in your social media storage: 586 KB of 1\.0 MB is used and it needs 586 KB\. Remove files/) });
    // Nothing was stored for the refused file.
    expect(await rows("select id from private_files where org_id = $1 and bucket = 'social-media'", [s.m.org.id])).toHaveLength(1);
    expect(await rows("select id from social_media_assets where org_id = $1", [s.m.org.id])).toHaveLength(1);
    // A smaller file still fits; removing one frees the room.
    await uploadMedia(s.sales, { filename: "small.jpg", contentType: "image/jpeg", bytes: jpeg(100_000) });
    await expect(uploadMedia(s.sales, { filename: "two.jpg", contentType: "image/jpeg", bytes: jpeg(600_000) })).rejects.toMatchObject({ code: "usage_limit" });
    await removeMedia(s.sales, first.id);
    expect((await getMediaPolicy(s.viewer)).usedBytes).toBe(100_000);
    await expect(uploadMedia(s.sales, { filename: "two.jpg", contentType: "image/jpeg", bytes: jpeg(600_000) })).resolves.toMatchObject({ filename: "two.jpg" });
  });

  it("is per workspace: one workspace being full does not stop another", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    await withManagedPlan(a);
    await withManagedPlan(b);
    process.env.SOCIAL_MEDIA_STORAGE_MB = "1";
    resetEnvCache();
    await uploadMedia(a.sales, { filename: "a.jpg", contentType: "image/jpeg", bytes: jpeg(900_000) });
    await expect(uploadMedia(a.sales, { filename: "a2.jpg", contentType: "image/jpeg", bytes: jpeg(900_000) })).rejects.toMatchObject({ code: "usage_limit" });
    await expect(uploadMedia(b.sales, { filename: "b.jpg", contentType: "image/jpeg", bytes: jpeg(900_000) })).resolves.toMatchObject({ filename: "b.jpg" });
  });

  it("holds when two uploads arrive together: both fit alone, only one fits, and the loser's stored copy is erased", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    process.env.SOCIAL_MEDIA_STORAGE_MB = "1";
    resetEnvCache();
    const results = await Promise.allSettled([
      uploadMedia(s.sales, { filename: "x.jpg", contentType: "image/jpeg", bytes: jpeg(600_000) }),
      uploadMedia(s.sales, { filename: "y.jpg", contentType: "image/jpeg", bytes: jpeg(600_000) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "usage_limit" });
    expect(await rows("select id from social_media_assets where org_id = $1", [s.m.org.id])).toHaveLength(1);
    const files = await rows<{ status: string; storage_key: string }>("select status, storage_key from private_files where org_id = $1 and bucket = 'social-media' order by status", [s.m.org.id]);
    expect(files.map((f) => f.status)).toEqual(["deleted", "ready"]);
    expect(files.filter((f) => onDisk(f.storage_key))).toHaveLength(1);
  });
});

describe("social media belongs to the client's workspace", () => {
  it("refuses every media action in an agency workspace, in the same words", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const file = await uploadMedia(s.sales, { filename: "a.jpg", contentType: "image/jpeg", bytes: jpeg() });
    const asAgency = { ...s.owner, org: { ...s.owner.org, kind: "agency" as const } };
    const words = /Social media is managed inside each client's workspace/;
    await expect(getMediaPolicy(asAgency)).rejects.toThrow(words);
    await expect(listMedia(asAgency)).rejects.toThrow(words);
    await expect(uploadMedia(asAgency, { filename: "a.jpg", contentType: "image/jpeg", bytes: jpeg() })).rejects.toThrow(words);
    await expect(removeMedia(asAgency, file.id)).rejects.toThrow(words);
    await expect(readMediaForPreview(asAgency, file.id)).rejects.toThrow(words);
    // The client's own workspace is unaffected.
    expect(await listMedia(s.owner)).toHaveLength(1);
  });
});
