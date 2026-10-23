// The media library: who may store what, what is checked on the way in, and who can see it.
import fs from "node:fs";
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
/** A JPEG whose EXIF says how to turn it, the way a phone writes a portrait photo: stored landscape, shown upright. */
const jpegTurned = (w: number, h: number, orientation: number, order: "II" | "MM" = "II", opts: { tag?: number; cut?: boolean } = {}) => {
  const le = order === "II";
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(order, 0, "ascii");
  const put16 = (value: number, at: number) => (le ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const put32 = (value: number, at: number) => (le ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  put16(42, 2);
  put32(8, 4);
  put16(1, 8);
  put16(opts.tag ?? 0x0112, 10);
  put16(3, 12);
  put32(1, 14);
  put16(orientation, 18);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), opts.cut ? tiff.subarray(0, 12) : tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(exif.length + 2, 2);
  const frame = Buffer.alloc(24);
  frame[0] = 0xff; frame[1] = 0xc0;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(h, 5);
  frame.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exif, frame]);
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

  it("reads a JPEG as it is shown: a photo marked as turned a quarter turn has its sides swapped", () => {
    // A phone portrait: 4032 x 3024 as stored, Orientation 6 (turn to the right), shown 3024 x 4032.
    for (const order of ["II", "MM"] as const) {
      for (const o of [5, 6, 7, 8]) expect(imageSize(jpegTurned(4032, 3024, o, order), "image/jpeg"), `${order} ${o}`).toEqual({ width: 3024, height: 4032 });
      for (const o of [1, 2, 3, 4]) expect(imageSize(jpegTurned(4032, 3024, o, order), "image/jpeg"), `${order} ${o}`).toEqual({ width: 4032, height: 3024 });
    }
  });

  it("ignores an orientation it cannot trust: an unknown value, another tag, a cut-off EXIF block", () => {
    expect(imageSize(jpegTurned(4032, 3024, 9), "image/jpeg")).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpegTurned(4032, 3024, 0), "image/jpeg")).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpegTurned(4032, 3024, 6, "II", { tag: 0x0111 }), "image/jpeg")).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpegTurned(4032, 3024, 6, "II", { cut: true }), "image/jpeg")).toEqual({ width: 4032, height: 3024 });
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

  it("checks a turned phone photo by the shape it is shown in, not the shape it is stored in", async () => {
    const s = await socialOrg();
    await withManagedPlan(s);
    // Stored 4032 x 3024 (4:3, which Instagram takes) but shown 3024 x 4032 (3:4, which is taller than Instagram's 4:5 limit).
    const photo = await uploadMedia(s.sales, { filename: "portrait.jpg", contentType: "image/jpeg", bytes: jpegTurned(4032, 3024, 6) });
    expect(photo).toMatchObject({ width: 3024, height: 4032 });
    expect(photo.validation.facebook.ok).toBe(true);
    expect(photo.validation.instagram.ok).toBe(false);
    expect(photo.validation.instagram.problems.join(" ")).toMatch(/4:5/);
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
    const [spareFile] = await rows<{ private_file_id: string; storage_key: string }>("select a.private_file_id, f.storage_key from social_media_assets a join private_files f on f.id = a.private_file_id where a.id = $1", [spare.id]);
    await removeMedia(s.sales, spare.id);
    expect((await listMedia(s.sales)).map((m) => m.id)).toEqual([used.id]);
    expect((await rows<{ status: string }>("select status from private_files where id = $1", [spareFile.private_file_id]))[0].status).toBe("deleted");
    // The stored copy is gone too, and the asset no longer points at it.
    expect(fs.existsSync(`${process.env.UPLOAD_DIR ?? ".data/test-uploads"}/social-media/${spareFile.storage_key}`)).toBe(false);
    expect((await rows<{ status: string; private_file_id: string | null }>("select status, private_file_id from social_media_assets where id = $1", [spare.id]))[0]).toEqual({ status: "removed", private_file_id: null });
    await expect(readMediaForPreview(s.sales, spare.id)).rejects.toThrow(/not found/);
  });
});
