// The storage policy, enforced where every upload passes (uploadPrivateFile): core files never wait on the plan; managed media is the maintenance plan's, time-aware, capped, never
// deleted by a lapse, and never crossing a workspace boundary. Embedded Postgres, real stored files on local disk, no provider.
import fs from "node:fs";
import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { PRIVATE_BUCKETS, BUCKET_STORAGE, storageDecision, type PrivateBucket } from "@/lib/storage-policy";
import { readPrivateFile, removePrivateFile, signPrivateFile, uploadPrivateFile } from "@/server/storage/private";
import { workspaceStorageUsage } from "@/server/storage/entitlement";
import { socialOrg, type SocialOrg } from "./support/social";
import { DAY, planRow } from "./support/billing-plan";

/** A PNG header with the given total size. */
const png = (bytes = 64) => {
  const b = Buffer.alloc(bytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  return b;
};
const keyFor = (orgId: string, name = "pic.png") => `${orgId}/${crypto.randomUUID()}/${name}`;

let a: SocialOrg;
let b: SocialOrg;
const asOwner = (s: SocialOrg) => ({ userId: s.m.people.owner.id, orgId: s.m.org.id });

async function uploadMedia(s: SocialOrg, bytes = png()) {
  return uploadPrivateFile({ ...asOwner(s), bucket: "social-media", path: keyFor(s.m.org.id), bytes, contentType: "image/png", filename: "pic.png" });
}
async function uploadCore(s: SocialOrg) {
  return uploadPrivateFile({ ...asOwner(s), bucket: "company-documents", path: keyFor(s.m.org.id, "notes.txt"), bytes: Buffer.from("Our hours are nine to five."), contentType: "text/plain", filename: "notes.txt" });
}

beforeAll(async () => {
  a = await socialOrg({ name: "Storage A" } as never);
  b = await socialOrg({ name: "Storage B" } as never);
});
afterEach(() => { delete process.env.SOCIAL_MEDIA_STORAGE_MB; resetEnvCache(); });

describe("the classification", () => {
  it("names a class for every private bucket, and the code's own list of buckets is the same list", () => {
    expect([...PRIVATE_BUCKETS].sort()).toEqual(Object.keys(BUCKET_STORAGE).sort());
    const source = fs.readFileSync("src/server/storage/private.ts", "utf8");
    const mimes = source.slice(source.indexOf("const MIMES: Record<PrivateBucket"), source.indexOf("export function validPrivateFilePath"));
    const keys = [...mimes.matchAll(/"([a-z-]+)":\s*\[/g)].map((m) => m[1]).sort();
    expect(keys).toEqual([...PRIVATE_BUCKETS].sort());
    expect(PRIVATE_BUCKETS.filter((x) => BUCKET_STORAGE[x].class === "managed_media")).toEqual(["social-media"]);
  });

  it("lets core files through whatever the plan says, and gates managed media on it, with the reason in the person's words", () => {
    for (const bucket of PRIVATE_BUCKETS.filter((x) => BUCKET_STORAGE[x].class === "core")) {
      expect(storageDecision(bucket, { managedStorage: false }), bucket).toMatchObject({ allowed: true, class: "core", reason: null });
    }
    expect(storageDecision("social-media", { managedStorage: true })).toMatchObject({ allowed: true });
    const refused = storageDecision("social-media", { managedStorage: false });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/Managed Maintenance plan/);
    expect(refused.reason).toMatch(/Google Drive or OneDrive/);
    expect(refused.reason).toMatch(/already uploaded stay safe/);
    expect(storageDecision("not-a-bucket" as PrivateBucket, { managedStorage: true }).allowed).toBe(false);
  });
});

describe("enforced at the one place every upload passes", () => {
  it("refuses managed media without the plan, while core files in the same workspace still go through", async () => {
    await expect(uploadMedia(a)).rejects.toMatchObject({ code: "plan_required" });
    await expect(uploadCore(a)).resolves.toMatchObject({ bucket: "company-documents" });
    expect((await workspaceStorageUsage(a.m.org.id)).managedMedia).toMatchObject({ bytes: 0, entitled: false });
  });

  it("allows managed media on an active plan and counts it", async () => {
    await planRow(a.m, { status: "active", paidThroughOn: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) });
    const stored = await uploadMedia(a, png(500));
    expect(stored.bucket).toBe("social-media");
    const usage = await workspaceStorageUsage(a.m.org.id);
    expect(usage.managedMedia).toMatchObject({ bytes: 500, entitled: true });
    expect(usage.rows.find((r) => r.bucket === "social-media")).toMatchObject({ files: 1, bytes: 500, class: "managed_media" });
    expect(usage.rows).toHaveLength(PRIVATE_BUCKETS.length);
    expect(usage.totalBytes).toBe(usage.rows.reduce((n, r) => n + r.bytes, 0));
  });

  it("on downgrade stops NEW managed media but keeps and still serves what was stored; reactivation restores it", async () => {
    const s = await socialOrg({ name: "Storage downgrade" } as never);
    const plan = await planRow(s.m, { status: "active", paidThroughOn: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) });
    const kept = await uploadMedia(s, png(300));
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now(), paid_through_on = null where id = $1", [plan]));
    // New managed media is refused ...
    await expect(uploadMedia(s)).rejects.toMatchObject({ code: "plan_required" });
    // ... nothing already stored is touched: the record is ready, the bytes are readable and a download link can still be issued ...
    const row = (await withSystem((db) => db.query<{ status: string; size_bytes: number }>("select status, size_bytes from private_files where id = $1", [kept.id]))).rows[0];
    expect(row).toMatchObject({ status: "ready", size_bytes: 300 });
    const read = await readPrivateFile({ ...asOwner(s), bucket: "social-media", path: kept.storageKey });
    expect(read.bytes.length).toBe(300);
    expect(await signPrivateFile({ ...asOwner(s), bucket: "social-media", path: kept.storageKey })).toBeTruthy();
    // ... core files keep working ...
    await expect(uploadCore(s)).resolves.toMatchObject({ bucket: "company-documents" });
    // ... and a renewed plan restores managed uploads.
    await planRow(s.m, { status: "active", paidThroughOn: new Date(Date.now() + 25 * DAY).toISOString().slice(0, 10) });
    await expect(uploadMedia(s)).resolves.toMatchObject({ bucket: "social-media" });
  });

  it("honours the grace period of a plan that is past due, and refuses the day it ends even if the scheduler has not expired it yet", async () => {
    const inGrace = await socialOrg({ name: "Storage grace" } as never);
    await planRow(inGrace.m, { status: "past_due", graceEndsAt: new Date(Date.now() + 3 * DAY), pastDueSince: new Date(Date.now() - 4 * DAY) });
    await expect(uploadMedia(inGrace)).resolves.toMatchObject({ bucket: "social-media" });
    const lapsed = await socialOrg({ name: "Storage lapsed" } as never);
    await planRow(lapsed.m, { status: "past_due", graceEndsAt: new Date(Date.now() - 1 * DAY), pastDueSince: new Date(Date.now() - 8 * DAY) });
    await expect(uploadMedia(lapsed)).rejects.toMatchObject({ code: "plan_required" });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from maintenance_subscriptions where org_id = $1", [lapsed.m.org.id]))).rows[0].status).toBe("past_due");
  });

  it("keeps managed media from being unlimited: one workspace's media stops at the ceiling, and removing a file frees room", async () => {
    process.env.SOCIAL_MEDIA_STORAGE_MB = "1";
    resetEnvCache();
    const s = await socialOrg({ name: "Storage cap" } as never);
    await planRow(s.m, { status: "active", paidThroughOn: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) });
    const first = await uploadMedia(s, png(700 * 1024));
    await expect(uploadMedia(s, png(700 * 1024))).rejects.toMatchObject({ code: "usage_limit", message: expect.stringMatching(/managed media storage is full/) });
    await removePrivateFile({ ...asOwner(s), bucket: "social-media", path: first.storageKey });
    await expect(uploadMedia(s, png(700 * 1024))).resolves.toMatchObject({ bucket: "social-media" });
    expect((await workspaceStorageUsage(s.m.org.id)).managedMedia.limitBytes).toBe(1024 * 1024);
  });
});

describe("workspace boundaries", () => {
  it("never lets one workspace's plan, member or path reach another's storage", async () => {
    // A has a plan; B has none. B's owner cannot upload media into B (no plan) and cannot upload into A's path (not a member of A, and the path names A).
    await expect(uploadMedia(b)).rejects.toMatchObject({ code: "plan_required" });
    await expect(uploadPrivateFile({ userId: b.m.people.owner.id, orgId: a.m.org.id, bucket: "social-media", path: keyFor(a.m.org.id), bytes: png(), contentType: "image/png" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(uploadPrivateFile({ userId: b.m.people.owner.id, orgId: b.m.org.id, bucket: "social-media", path: keyFor(a.m.org.id), bytes: png(), contentType: "image/png" })).rejects.toMatchObject({ code: "invalid_input" });
    // A stored file of A is not readable or linkable by B's owner, by A's path or B's.
    const mine = (await withSystem((db) => db.query<{ storage_key: string }>("select storage_key from private_files where org_id = $1 and bucket = 'social-media' and status = 'ready' limit 1", [a.m.org.id]))).rows[0];
    await expect(readPrivateFile({ userId: b.m.people.owner.id, orgId: a.m.org.id, bucket: "social-media", path: mine.storage_key })).rejects.toBeTruthy();
    await expect(signPrivateFile({ userId: b.m.people.owner.id, orgId: a.m.org.id, bucket: "social-media", path: mine.storage_key })).rejects.toBeTruthy();
    await expect(readPrivateFile({ userId: b.m.people.owner.id, orgId: b.m.org.id, bucket: "social-media", path: mine.storage_key })).rejects.toBeTruthy();
    // Usage is per workspace.
    expect((await workspaceStorageUsage(b.m.org.id)).managedMedia.bytes).toBe(0);
  });

  it("does not report an external drive as connected: Google Drive and OneDrive are not built, so a workspace without the plan has no managed media storage rather than a silent one", () => {
    const decision = storageDecision("social-media", { managedStorage: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/cannot be connected yet/);
  });
});
