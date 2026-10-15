// Development tool. Makes the smaller copies of the built-in template photographs that a page offers to phones and tablets (srcset), so a visitor on a
// 390px screen does not download a 1536px picture. The full-size files in public/template-images are never touched; this only reads them.
//   node scripts/generate-template-image-sizes.mjs
// Writes public/template-images-sized/{id}-{width}.webp and manifest.json, which records the SHA-256 of each source photograph so that a replaced
// photograph is detected (tests/website-template-image-sizes.test.ts fails until this is run again).
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SOURCE = "public/template-images";
const OUT = "public/template-images-sized";
const WIDTHS = [640, 1024];
await fs.mkdir(OUT, { recursive: true });
const manifest = { widths: WIDTHS, sources: {} };
let before = 0, after = 0;
for (const name of (await fs.readdir(SOURCE)).filter((n) => n.endsWith(".webp")).sort()) {
  const id = path.basename(name, ".webp");
  const bytes = await fs.readFile(path.join(SOURCE, name));
  manifest.sources[id] = createHash("sha256").update(bytes).digest("hex");
  before += bytes.length;
  for (const width of WIDTHS) {
    const file = path.join(OUT, `${id}-${width}.webp`);
    await sharp(bytes).resize({ width, withoutEnlargement: true }).webp({ quality: 80, effort: 6 }).toFile(file);
    after += (await fs.stat(file)).size;
  }
}
const wanted = new Set(Object.keys(manifest.sources).flatMap((id) => WIDTHS.map((w) => `${id}-${w}.webp`)).concat("manifest.json"));
for (const name of await fs.readdir(OUT)) if (!wanted.has(name)) await fs.rm(path.join(OUT, name));
await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`${Object.keys(manifest.sources).length} photographs, ${WIDTHS.join(" and ")}px copies: ${(before / 1024 / 1024).toFixed(1)} MB of originals, ${(after / 1024 / 1024).toFixed(1)} MB of copies.`);
