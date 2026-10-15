// How many image bytes a visitor downloads to see each template's home page, at phone and desktop width. Real Chromium, cold cache, bytes from the
// network stack (compressed transfer size), page scrolled to the footer so lazy images are fetched too.
//
//   npm run studio:qa
//   node scripts/studio-frame-weight.mjs [label]                    all 50 templates at 390 and 1440
//   KEYS=luxe.maison WIDTHS=390 node scripts/studio-frame-weight.mjs before
//
// Output: .data/studio-qa/frame-weight-{label}.json. Image bytes are the same on a development server and a production one; the other figures are not,
// so only images are reported.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }
const WIDTHS = (process.env.WIDTHS ?? "390,1440").split(",").map(Number);
const WORKERS = Number(process.env.WORKERS ?? 2);
const label = process.argv[2] ?? "run";

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
const queue = keys.flatMap((key) => WIDTHS.map((width) => ({ key, width })));
const rows = [];

async function worker() {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    let job;
    while ((job = queue.shift())) {
      const context = await browser.newContext({ viewport: { width: job.width, height: 900 }, reducedMotion: "reduce", deviceScaleFactor: job.width < 800 ? 2 : 1 });
      const page = await context.newPage();
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        const seen = new Map();
        cdp.on("Network.requestWillBeSent", (e) => seen.set(e.requestId, { url: e.request.url, type: e.type, bytes: 0 }));
        cdp.on("Network.loadingFinished", (e) => { const r = seen.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
        await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
        await page.goto(`${BASE}/dev/frame/template?key=${encodeURIComponent(job.key)}`, { waitUntil: "load", timeout: 120000 });
        await page.locator("footer").first().waitFor({ timeout: 60000 });
        await page.evaluate(async () => {
          for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
          await Promise.all([...document.images].map((i) => Promise.race([i.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 4000))])));
        });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        const images = [...seen.values()].filter((r) => r.type === "Image" && !r.url.startsWith("data:"));
        const shown = await page.evaluate(() => [...document.images].filter((i) => i.currentSrc).map((i) => ({ src: i.currentSrc.replace(location.origin, ""), natural: i.naturalWidth, drawn: Math.round(i.getBoundingClientRect().width) })));
        rows.push({ ...job, imageRequests: images.length, imageBytes: images.reduce((n, r) => n + r.bytes, 0), shown });
      } catch (error) { rows.push({ ...job, error: String(error.message).split("\n")[0] }); }
      await context.close().catch(() => {});
    }
  } finally { await browser.close(); }
}
console.log(`Image weight: ${queue.length} page loads (${keys.length} templates x ${WIDTHS.join("/")}) against ${BASE}`);
await Promise.all(Array.from({ length: WORKERS }, worker));
rows.sort((a, b) => a.key.localeCompare(b.key) || a.width - b.width);
const summary = { label, base: BASE, ranAt: new Date().toISOString(), views: rows.length, errors: rows.filter((r) => r.error).length, byWidth: {} };
for (const width of WIDTHS) {
  const ok = rows.filter((r) => r.width === width && !r.error);
  const kb = ok.map((r) => r.imageBytes / 1024).sort((a, b) => a - b);
  const total = kb.reduce((n, x) => n + x, 0);
  summary.byWidth[width] = { templates: ok.length, meanImageKB: Math.round(total / ok.length), medianImageKB: Math.round(kb[Math.floor((kb.length - 1) / 2)]), maxImageKB: Math.round(kb[kb.length - 1]), meanImageRequests: +(ok.reduce((n, r) => n + r.imageRequests, 0) / ok.length).toFixed(1) };
}
await fs.mkdir(".data/studio-qa", { recursive: true });
await fs.writeFile(`.data/studio-qa/frame-weight-${label}.json`, JSON.stringify({ ...summary, rows }, null, 2));
console.log(JSON.stringify(summary));
