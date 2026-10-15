// Development tool. Uses the real Next renderer; no browser dependency enters the app.
// node --conditions=react-server --import tsx scripts/generate-template-thumbnails.mjs
// Set PLAYWRIGHT_MODULE to the installed playwright ESM entry when it isn't in node_modules.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ALL_TEMPLATE_KEYS, sampleSite } from "../src/lib/website/templates/index.ts";
import { contentHash } from "../src/server/websites/hash.ts";
import { TEMPLATE_RENDER_REVISION, THUMBNAIL_VIEWPORT } from "../src/lib/website/thumbnail-contract.ts";

const base = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("Thumbnail generation requires the isolated local application.");
let browserModule;
try { browserModule = await import("playwright"); } catch {
  const entry = process.env.PLAYWRIGHT_MODULE;
  if (!entry) throw new Error("Set PLAYWRIGHT_MODULE to the installed playwright/index.mjs path. No production dependency is required.");
  browserModule = await import(pathToFileURL(entry).href);
}
const rendererFiles = (await fs.readdir("src/components/website/render")).filter((name) => /\.(tsx|css|ts)$/.test(name)).sort();
const rendererHash = createHash("sha256");
for (const name of rendererFiles) rendererHash.update(name).update(await fs.readFile(`src/components/website/render/${name}`));
for (const name of ["src/lib/website/css.ts", "src/lib/website/fonts.ts", "src/lib/website/font-keys.ts"]) rendererHash.update(await fs.readFile(name));
const digest = rendererHash.digest("hex");
const manifest = { rendererRevision: TEMPLATE_RENDER_REVISION, rendererHash: digest, viewport: THUMBNAIL_VIEWPORT, templates: {} };
const out = "public/website-thumbnails";
const evidence = ".data/studio-qa/thumbnail-comparisons";
await fs.mkdir(out, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const browser = await browserModule.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: THUMBNAIL_VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await page.routeWebSocket("**/_next/webpack-hmr", (socket) => socket.close());
  for (const key of ALL_TEMPLATE_KEYS()) {
    const content = sampleSite(key);
    const signature = contentHash(content);
    await page.goto(`${base}/dev/frame/template?key=${encodeURIComponent(key)}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator(`[data-template-signature="${signature}"]`).waitFor({ timeout: 30000 });
    // The header folds its links into the menu once its scripts have measured them in the loaded fonts; photograph the page after that.
    await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      const images = [...document.images].filter((image) => image.getBoundingClientRect().top < innerHeight);
      await Promise.all(images.map((image) => image.decode()));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const image = await page.screenshot({ style: "nextjs-portal{display:none!important}" });
    const stem = `${key}.${signature.slice(0, 12)}.${digest.slice(0, 8)}`;
    await sharp(image).resize(720, 450).webp({ quality: 82, effort: 6 }).toFile(`${out}/${stem}.webp`);
    await sharp(image).resize(1080, 675).webp({ quality: 82, effort: 6 }).toFile(`${out}/${stem}@2x.webp`);
    await fs.writeFile(`${evidence}/${key}-canonical.png`, image);
    manifest.templates[key] = { src: `/website-thumbnails/${stem}.webp`, srcSet: `/website-thumbnails/${stem}.webp 720w, /website-thumbnails/${stem}@2x.webp 1080w`, width: 720, height: 450, signature, version: content.origin.version };
    console.log(`Captured ${key} v${content.origin.version}`);
  }
  await fs.writeFile("src/lib/website/template-thumbnails.json", JSON.stringify(manifest, null, 2) + "\n");
  // The manifest is complete, so anything it does not reference is a superseded screenshot. Removing those keeps stale pictures from lingering in
  // the repository or being served; the file names change whenever content or the renderer does, so no live URL is ever replaced in place.
  const keep = new Set(Object.values(manifest.templates).flatMap((entry) => [entry.src, entry.srcSet.split(",")[1].trim().split(" ")[0]].map((url) => url.replace("/website-thumbnails/", ""))));
  let pruned = 0;
  for (const name of await fs.readdir(out)) if (name.endsWith(".webp") && !keep.has(name)) { await fs.rm(`${out}/${name}`); pruned++; }
  console.log(`Generated ${Object.keys(manifest.templates).length} canonical thumbnails; removed ${pruned} superseded file${pruned === 1 ? "" : "s"}.`);
} finally { await browser.close(); }
