// Full-page captures of every template's home page at desktop and phone width, composed into one contact sheet per family, so all 50 designs can
// be reviewed side by side before zooming into a problem. Development evidence only: written under .data (git-ignored), never part of the app.
//
//   npm run studio:qa                                       (another terminal)
//   node scripts/studio-visual-review.mjs                   all 50, widths 1440 and 390
//   KEYS=luxe.maison WIDTHS=390 node scripts/studio-visual-review.mjs
//
// Output: .data/studio-qa/visual-review/{key}-{width}.png and sheet-{family}.jpg (desktop on the top row, phone below).
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }

const OUT = ".data/studio-qa/visual-review";
const WIDTHS = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);
const WORKERS = Number(process.env.WORKERS ?? 2);
await fs.mkdir(OUT, { recursive: true });

async function allKeys() {
  const b = await pw.chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    await p.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.locator("article").first().waitFor({ timeout: 60000 });
    return (await p.evaluate(() => [...document.querySelectorAll("[data-thumbnail-key]")].map((e) => e.getAttribute("data-thumbnail-key")))).sort();
  } finally { await b.close(); }
}

const keys = process.env.KEYS ? process.env.KEYS.split(",") : await allKeys();
const exists = (file) => fs.access(file).then(() => true, () => false);
const queue = [];
for (const key of keys) for (const width of WIDTHS) if (process.env.FORCE === "1" || !(await exists(`${OUT}/${key}-${width}.png`))) queue.push({ key, width });
const failures = [];
console.log(`Capturing ${queue.length} full pages (${keys.length} templates x ${WIDTHS.join("/")}; existing captures are kept unless FORCE=1) against ${BASE}`);

const within = (ms, work, what) => Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms))]);

async function capture(browser, job) {
  const page = await browser.newPage({ viewport: { width: job.width, height: 900 }, reducedMotion: "reduce" });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 160)));
  try {
    await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
    await page.goto(`${BASE}/dev/frame/template?key=${encodeURIComponent(job.key)}`, { waitUntil: "load", timeout: 120000 });
    await page.locator("footer").first().waitFor({ timeout: 60000 });
    await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
    // Walk the page so below-the-fold images load, then settle fonts and decoding before the capture. A picture that cannot be decoded must not hang the run.
    await within(90000, page.evaluate(async () => {
      await document.fonts.ready;
      for (let y = 0; y < document.documentElement.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
      await Promise.all([...document.images].map((i) => Promise.race([i.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])));
      window.scrollTo(0, 0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }), "walking the page");
    // The app's own error screen replaces the page when something throws after the site has drawn; a screenshot of it is not a capture.
    if (await page.getByRole("heading", { name: "This page couldn't load" }).count()) throw new Error(`the page crashed into the error screen (${pageErrors.join(" | ") || "no page error captured"})`);
    const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && !i.naturalWidth).length);
    await within(60000, page.screenshot({ path: `${OUT}/${job.key}-${job.width}.png`, fullPage: true, style: "nextjs-portal{display:none!important}" }), "the screenshot");
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    return { height, broken, pageErrors };
  } finally { await page.close().catch(() => {}); }
}

async function worker() {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    let job;
    while ((job = queue.shift())) {
      let outcome;
      for (let attempt = 1; attempt <= 2 && !outcome; attempt++) {
        try { outcome = await capture(browser, job); } catch (error) {
          const reason = String(error.message).split("\n")[0];
          if (attempt === 2) { console.log(`FAIL ${job.key} @${job.width}: ${reason}`); failures.push(`${job.key}@${job.width}: ${reason}`); } else console.log(`retry ${job.key} @${job.width}: ${reason}`);
        }
      }
      if (!outcome) continue;
      console.log(`ok   ${job.key} @${job.width} ${outcome.height}px tall${outcome.broken ? ` | ${outcome.broken} BROKEN IMAGE(S)` : ""}${outcome.pageErrors.length ? ` | page errors: ${outcome.pageErrors.join(" | ")}` : ""}`);
      if (outcome.broken) failures.push(`${job.key}@${job.width}: ${outcome.broken} broken image(s)`);
      if (outcome.pageErrors.length) failures.push(`${job.key}@${job.width}: ${outcome.pageErrors.length} page error(s)`);
    }
  } finally { await browser.close(); }
}
await Promise.all(Array.from({ length: WORKERS }, worker));

// Contact sheets: one per family, desktop on top and phone beneath, each design scaled to the same column width.
const families = [...new Set(keys.map((k) => k.split(".")[0]))];
const COLUMN = 300;
for (const family of families) {
  const members = keys.filter((k) => k.startsWith(`${family}.`)).sort();
  const tiles = [];
  for (const width of WIDTHS) {
    const row = [];
    for (const key of members) {
      try {
        const scaled = await sharp(`${OUT}/${key}-${width}.png`).resize({ width: width === WIDTHS[0] ? COLUMN : Math.round(COLUMN * 0.55) }).jpeg({ quality: 82 }).toBuffer();
        row.push({ input: scaled, meta: await sharp(scaled).metadata() });
      } catch { /* a failed capture is already reported above */ }
    }
    tiles.push(row);
  }
  const gap = 12;
  const rowHeights = tiles.map((row) => Math.max(0, ...row.map((t) => t.meta.height)));
  const rowWidths = tiles.map((row) => row.reduce((sum, t) => sum + t.meta.width + gap, gap));
  const width = Math.max(...rowWidths);
  const height = rowHeights.reduce((sum, h) => sum + h + gap, gap);
  if (!width || !height) continue;
  const layers = [];
  let y = gap;
  tiles.forEach((row, rowIndex) => {
    let x = gap;
    for (const tile of row) { layers.push({ input: tile.input, left: x, top: y }); x += tile.meta.width + gap; }
    y += rowHeights[rowIndex] + gap;
  });
  await sharp({ create: { width, height, channels: 3, background: "#e9ebf0" } }).composite(layers).jpeg({ quality: 80 }).toFile(`${OUT}/sheet-${family}.jpg`);
  console.log(`sheet-${family}.jpg ${width}x${height}`);
}
await fs.writeFile(`${OUT}/results.json`, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, templates: keys.length, widths: WIDTHS, failures }, null, 2));
console.log(JSON.stringify({ templates: keys.length, failures: failures.length }));
if (failures.length) process.exitCode = 1;
