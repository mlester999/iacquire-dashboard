import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { TEMPLATE_IMAGE_ASSETS, TEMPLATE_IMAGE_FULL_WIDTH, TEMPLATE_IMAGE_SIZES, templateImageSrcSet, templateImageUrl } from "@/lib/website/template-image-assets";

// A phone is offered smaller copies of the starter photographs. They are made from the originals by `node scripts/generate-template-image-sizes.mjs`,
// so they must exist, be the right size, be lighter than the original, and be of the photograph that is there now.

const PUBLIC = path.resolve("public");
const SIZED = path.join(PUBLIC, "template-images-sized");
const manifest = JSON.parse(fs.readFileSync(path.join(SIZED, "manifest.json"), "utf8")) as { widths: number[]; sources: Record<string, string> };
const fileOf = (url: string) => path.join(PUBLIC, url.replace(/^\//, ""));

describe("responsive starter photographs", () => {
  it("offers each photograph at every width, largest last, all pointing at files that exist", () => {
    expect(manifest.widths).toEqual([...TEMPLATE_IMAGE_SIZES]);
    for (const { id } of TEMPLATE_IMAGE_ASSETS) {
      const candidates = templateImageSrcSet(id).split(",").map((c) => c.trim().split(" "));
      expect(candidates.map(([, w]) => w), id).toEqual([...TEMPLATE_IMAGE_SIZES.map((w) => `${w}w`), `${TEMPLATE_IMAGE_FULL_WIDTH}w`]);
      expect(candidates[candidates.length - 1][0], id).toBe(templateImageUrl(id));
      for (const [url] of candidates) expect(fs.existsSync(fileOf(url)), `${id}: ${url}`).toBe(true);
    }
  });

  it("are the width they claim and far lighter than the original", async () => {
    for (const { id } of TEMPLATE_IMAGE_ASSETS) {
      const original = fs.statSync(fileOf(templateImageUrl(id))).size;
      for (const width of TEMPLATE_IMAGE_SIZES) {
        const file = path.join(SIZED, `${id}-${width}.webp`);
        const meta = await sharp(file).metadata();
        expect(`${id} ${width} ${meta.width} ${meta.format}`).toBe(`${id} ${width} ${width} webp`);
        expect(fs.statSync(file).size, `${id} ${width}w`).toBeLessThan(original * (width === 640 ? 0.45 : 0.75));
      }
    }
  });

  it("were made from the photographs as they are now, with nothing left over", () => {
    expect(Object.keys(manifest.sources).sort()).toEqual(TEMPLATE_IMAGE_ASSETS.map((a) => a.id).sort());
    for (const { id } of TEMPLATE_IMAGE_ASSETS) {
      const digest = createHash("sha256").update(fs.readFileSync(fileOf(templateImageUrl(id)))).digest("hex");
      expect(digest, `${id}: the photograph changed after its smaller copies were made; run node scripts/generate-template-image-sizes.mjs`).toBe(manifest.sources[id]);
    }
    const expected = new Set(TEMPLATE_IMAGE_ASSETS.flatMap(({ id }) => TEMPLATE_IMAGE_SIZES.map((w) => `${id}-${w}.webp`)).concat("manifest.json"));
    expect(fs.readdirSync(SIZED).filter((n) => !expected.has(n))).toEqual([]);
  });
});
