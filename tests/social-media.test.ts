// The media library: who may store what, what is checked on the way in, and who can see it.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { imageSize } from "@/lib/social/image-size";
import { getMediaPolicy, listMedia, readMediaForPreview, removeMedia, uploadMedia } from "@/server/social/media";
import { createPost, submitForApproval } from "@/server/social/posts";
import { connect, rows, socialOrg, type SocialOrg } from "./support/social";

const png = (w: number, h: number) => {
  const b = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) => {
  const b = Buffer.alloc(40);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0; // SOI, then a frame header
  b.writeUInt16BE(17, 4);
  b[6] = 8;
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
};
const mp4 = () => {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(32, 0);
  b.write("ftyp", 4, "ascii");
  b.write("isom", 8, "ascii");
  return b;
};
const webpLossy = (w: number, h: number) => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
};

async function withManagedPlan(s: SocialOrg) {
  await withSystem((db) => db.query(
    "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now() - interval '30 days', current_date - 30)",
    [s.m.org.id, s.m.people.owner.id],
  ));
}

describe("reading a picture's shape", () => {
  it("reads PNG, JPEG and WebP headers, and says null for what it cannot read", () => {
    expect(imageSize(png(1080, 1350), "image/png")).toEqual({ width: 1080, height: 1350 });
    expect(imageSize(jpeg(1200, 628), "image/jpeg")).toEqual({ width: 1200, height: 628 });
    expect(imageSize(webpLossy(800, 600), "image/webp")).toEqual({ width: 800, height: 600 });
    expect(imageSize(Buffer.from("not an image at all, really not"), "image/png")).toBeNull();
    expect(imageSize(png(0, 10), "image/png")).toBeNull();
    expect(imageSize(Buffer.alloc(10), "image/jpeg")).toBeNull();
    expect(imageSize(png(10, 10), "application/pdf")).toBeNull();
  });
});

describe("where media may be stored", () => {
  it("says plainly that no storage is available without the managed plan, and refuses an upload", async () => {
    const s = await socialOrg();
    const policy = await getMediaPolicy(s.viewer);
    expect(policy.managedUploadAllowed).toBe(false);
    expect(policy.summary).toMatch(/No media storage is available/);
    expect(policy.options.filter((o) => o.available)).toEqual([]);
    await expect(uploadMedia(s.sales, { filename: "a.jpg", contentType: "image/jpeg", bytes: jpeg(1080, 1080) })).rejects.toThrow(/No media storage is available/);
    expect(await rows("select id from private_files where org_id = $1 and bucket = 'social-media'", [s.m.org.id])).toHaveLength(0);
  });

  it("offers managed storage on the managed plan", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const policy = await getMediaPolicy(s.viewer);
    expect(policy.managedUploadAllowed).toBe(true);
    expect(policy.options.find((o) => o.source === "managed")?.available).toBe(true);
  });
});

describe("adding and checking a file", () => {
  it("stores a picture, reads its shape, and says per platform whether it can be posted", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const ok = await uploadMedia(s.sales, { filename: "spring tune-up.jpg", contentType: "image/jpeg", bytes: jpeg(1080, 1350), altText: "A technician servicing an air conditioner" });
    expect(ok).toMatchObject({ kind: "image", width: 1080, height: 1350, status: "ready", filename: "spring tune-up.jpg" });
    expect(ok.validation.facebook.ok).toBe(true);
    expect(ok.validation.instagram.ok).toBe(true);
    const wide = await uploadMedia(s.sales, { filename: "banner.png", contentType: "image/png", bytes: png(4000, 1000) });
    expect(wide.validation.facebook.ok).toBe(true);
    expect(wide.validation.instagram.ok).toBe(false);
    expect(wide.validation.instagram.problems.join(" ")).toMatch(/JPEG|4:5/);
    const stored = await rows<{ bucket: string; status: string }>("select bucket, status from private_files where org_id = $1", [s.m.org.id]);
    expect(stored.every((f) => f.bucket === "social-media" && f.status === "ready")).toBe(true);
  });

  it("refuses a renamed file, an unknown type, an unreadable picture and an empty file", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    await expect(uploadMedia(s.sales, { filename: "x.jpg", contentType: "image/jpeg", bytes: Buffer.from("MZ this is an executable, not a picture") })).rejects.toThrow(/do not match its type/);
    await expect(uploadMedia(s.sales, { filename: "x.gif", contentType: "image/gif", bytes: png(10, 10) })).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(uploadMedia(s.sales, { filename: "x.png", contentType: "image/png", bytes: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)]) })).rejects.toThrow(/could not be read/);
    await expect(uploadMedia(s.sales, { filename: "x.jpg", contentType: "image/jpeg", bytes: Buffer.alloc(0) })).rejects.toThrow(/up to 50 MB/);
  });

  it("accepts an MP4 and does not pretend to know its length", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const v = await uploadMedia(s.sales, { filename: "tour.mp4", contentType: "video/mp4", bytes: mp4() });
    expect(v).toMatchObject({ kind: "video", width: null, height: null });
  });

  it("is for people who write posts", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    await expect(uploadMedia(s.viewer, { filename: "a.jpg", contentType: "image/jpeg", bytes: jpeg(1080, 1080) })).rejects.toThrow(/can't add media/);
  });

  it("neutralizes a hostile filename", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const v = await uploadMedia(s.sales, { filename: "../../etc/passwd<script>.jpg", contentType: "image/jpeg", bytes: jpeg(1080, 1080) });
    expect(v.filename).not.toMatch(/[/\\<>]/);
    const [f] = await rows<{ storage_key: string }>("select storage_key from private_files where org_id = $1", [s.m.org.id]);
    expect(f.storage_key.startsWith(`${s.m.org.id}/`)).toBe(true);
    expect(f.storage_key).not.toContain("..");
  });
});

describe("who can see it", () => {
  it("keeps a workspace's files from every other workspace", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    await withManagedPlan(a);
    const file = await uploadMedia(a.sales, { filename: "a.jpg", contentType: "image/jpeg", bytes: jpeg(1080, 1080) });
    expect(await listMedia(b.owner)).toEqual([]);
    await expect(readMediaForPreview(b.owner, file.id)).rejects.toThrow(/not found/);
    await expect(removeMedia(b.owner, file.id)).rejects.toThrow(/not found/);
    const mine = await readMediaForPreview(a.viewer, file.id);
    expect(mine.mimeType).toBe("image/jpeg");
    expect(mine.bytes.length).toBeGreaterThan(0);
  });

  it("will not remove a file a waiting post needs, and removes one nothing uses", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    const acc = await connect(s);
    const used = await uploadMedia(s.sales, { filename: "used.jpg", contentType: "image/jpeg", bytes: jpeg(1080, 1080) });
    const spare = await uploadMedia(s.sales, { filename: "spare.jpg", contentType: "image/jpeg", bytes: jpeg(1080, 1080) });
    const post = await createPost(s.sales, { accountId: acc.id, kind: "image", caption: "Look", mediaAssetIds: [used.id] });
    await submitForApproval(s.sales, post.id);
    await expect(removeMedia(s.sales, used.id)).rejects.toThrow(/used by 1 post/);
    await removeMedia(s.sales, spare.id);
    expect((await listMedia(s.sales)).map((m) => m.id)).toEqual([used.id]);
    expect((await rows<{ status: string }>("select status from private_files where id = (select private_file_id from social_media_assets where id = $1)", [spare.id]))[0].status).toBe("deleted");
    await expect(readMediaForPreview(s.sales, spare.id)).rejects.toThrow(/not found/);
  });
});
