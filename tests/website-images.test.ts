import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { allowedWidth, IMAGE_WIDTHS, srcSetFor } from "@/lib/website/responsive-image";
import { resizedVariant } from "@/server/sites/image-variants";
import { assetResolver } from "@/server/sites/render";
import type { SiteAsset } from "@/server/sites/runtime";

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer();

describe("responsive pictures", () => {
  it("only ever serves a few fixed widths, so nobody can ask for a thousand sizes", () => {
    for (const w of IMAGE_WIDTHS) expect(allowedWidth(String(w))).toBe(w);
    for (const bad of [null, undefined, "", "0", "1", "479", "481", "9999", "abc", "480.5", "-480", "480; drop", "1e3"]) expect(allowedWidth(bad as string)).toBeNull();
  });

  it("describes every smaller size plus the original, and leaves small pictures alone", () => {
    expect(srcSetFor("/_a/abc", 2400)).toBe("/_a/abc?w=480 480w, /_a/abc?w=768 768w, /_a/abc?w=1080 1080w, /_a/abc?w=1440 1440w, /_a/abc?w=1920 1920w, /_a/abc 2400w");
    expect(srcSetFor("/_a/abc", 1000)).toBe("/_a/abc?w=480 480w, /_a/abc?w=768 768w, /_a/abc 1000w");
    expect(srcSetFor("/_a/abc", 480)).toBeUndefined();
    expect(srcSetFor("/_a/abc", null)).toBeUndefined();
  });

  it("makes a smaller WebP copy, and serves the original when the picture is already small", async () => {
    const big = await png(2000, 1000);
    const v = (await resizedVariant("a".repeat(64), big, 768))!;
    expect(v.mimeType).toBe("image/webp");
    const meta = await sharp(v.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(768);
    expect(v.bytes.length).toBeLessThan(big.length);
    expect(await resizedVariant("b".repeat(64), await png(400, 300), 768)).toBeNull();
  });

  it("returns nothing for bytes that aren't a picture, instead of failing the request", async () => {
    expect(await resizedVariant("c".repeat(64), Buffer.from("not an image"), 480)).toBeNull();
  });

  it("gives a live site's pictures a srcset keyed by their content hash", () => {
    const asset: SiteAsset = { assetId: "11111111-1111-4111-8111-111111111111", sha256: "d".repeat(64), mimeType: "image/png", width: 2000, height: 1000, alt: "A roof" };
    const resolve = assetResolver(new Map([[asset.assetId, asset]]));
    const r = resolve(asset.assetId)!;
    expect(r.src).toBe(`/_a/${asset.sha256}`);
    expect(r.srcSet).toContain(`/_a/${asset.sha256}?w=480 480w`);
    expect(resolve("22222222-2222-4222-8222-222222222222")).toBeNull();
  });
});
