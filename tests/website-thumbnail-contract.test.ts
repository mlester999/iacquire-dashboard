import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import manifestJson from "@/lib/website/template-thumbnails.json";
import { TEMPLATE_RENDER_REVISION, THUMBNAIL_VIEWPORT, type TemplateThumbnail } from "@/lib/website/thumbnail-contract";
import { ALL_TEMPLATE_KEYS, sampleSite } from "@/lib/website/templates";
import { canonicalThumbnail } from "@/server/websites/thumbnails";
import { contentHash } from "@/server/websites/hash";

// A gallery picture is a screenshot of one template's sample site, taken by the real renderer. It may be shown only for exactly that template,
// that version, that content and that renderer. When any of them changes the picture is stale and `npm run thumbnails:generate` must be run;
// until it is, this file fails, so a stale or mismatched picture cannot reach the gallery unnoticed.

const manifest = manifestJson as { rendererRevision: string; rendererHash: string; viewport: { width: number; height: number }; templates: Record<string, TemplateThumbnail> };
const PUBLIC = path.resolve("public");
const THUMBS = path.join(PUBLIC, "website-thumbnails");
const fileOf = (url: string) => path.join(PUBLIC, url.replace(/^\//, ""));
const secondUrl = (entry: TemplateThumbnail) => entry.srcSet.split(",")[1].trim().split(" ")[0];

/** The same fingerprint of the renderer that the generator writes, recomputed from the files as they are now. */
function rendererHash() {
  const hash = createHash("sha256");
  const dir = path.resolve("src/components/website/render");
  for (const name of fs.readdirSync(dir).filter((n) => /\.(tsx|css|ts)$/.test(n)).sort()) hash.update(name).update(fs.readFileSync(path.join(dir, name)));
  for (const name of ["src/lib/website/css.ts", "src/lib/website/fonts.ts", "src/lib/website/font-keys.ts"]) hash.update(fs.readFileSync(path.resolve(name)));
  return hash.digest("hex");
}

describe("template gallery screenshots", () => {
  const keys = ALL_TEMPLATE_KEYS();

  it("exist for exactly the built-in templates, at the canonical viewport", () => {
    expect(keys).toHaveLength(50);
    expect(Object.keys(manifest.templates).sort()).toEqual([...keys].sort());
    expect(manifest.viewport).toEqual(THUMBNAIL_VIEWPORT);
    expect(manifest.rendererRevision).toBe(TEMPLATE_RENDER_REVISION);
  });

  it("were taken by the renderer as it is now", () => {
    // If this fails, a renderer file, the CSS engine or the font list changed after the screenshots were taken.
    expect(rendererHash()).toBe(manifest.rendererHash);
  });

  it("are tied to each template's exact id, version and content", () => {
    for (const key of keys) {
      const content = sampleSite(key);
      const entry = manifest.templates[key];
      expect(entry.version, `${key} version`).toBe(content.origin.version);
      expect(entry.signature, `${key} content signature`).toBe(contentHash(content));
      const stem = `${key}.${entry.signature.slice(0, 12)}.${manifest.rendererHash.slice(0, 8)}`;
      expect(entry.src, key).toBe(`/website-thumbnails/${stem}.webp`);
      expect(secondUrl(entry), key).toBe(`/website-thumbnails/${stem}@2x.webp`);
      expect(canonicalThumbnail(key, content), key).toEqual(entry);
    }
  });

  it("refuse to stand in for a different document, version or template", () => {
    const key = "luxe.maison";
    const content = sampleSite(key);
    const edited = structuredClone(content);
    edited.business.name = "A different business";
    expect(canonicalThumbnail(key, edited)).toBeUndefined();
    const reversioned = structuredClone(content);
    reversioned.origin.version += 1;
    expect(canonicalThumbnail(key, reversioned)).toBeUndefined();
    expect(canonicalThumbnail(key, sampleSite("luxe.atelier"))).toBeUndefined();
    expect(canonicalThumbnail("custom.not-a-built-in", content)).toBeUndefined();
  });

  it("are real, correctly sized, lightweight files, and no superseded file is left behind", async () => {
    const referenced = new Set<string>();
    for (const key of keys) {
      const entry = manifest.templates[key];
      for (const [url, width, height, budgetKb] of [[entry.src, 720, 450, 100], [secondUrl(entry), 1080, 675, 180]] as const) {
        const file = fileOf(url);
        referenced.add(path.basename(file));
        const meta = await sharp(file).metadata();
        expect(`${key} ${meta.width}x${meta.height} ${meta.format}`).toBe(`${key} ${width}x${height} webp`);
        expect(fs.statSync(file).size / 1024, `${key} ${width}w size`).toBeLessThan(budgetKb);
      }
      expect(entry.width, key).toBe(720);
      expect(entry.height, key).toBe(450);
    }
    const stray = fs.readdirSync(THUMBS).filter((name) => name.endsWith(".webp") && !referenced.has(name));
    expect(stray, "superseded screenshots that nothing references").toEqual([]);
  });
});
