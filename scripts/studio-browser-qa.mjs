// Real Chromium regression matrix against the isolated local app.
// node --conditions=react-server --import tsx scripts/studio-browser-qa.mjs
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ALL_TEMPLATE_KEYS, sampleSite } from "../src/lib/website/templates/index.ts";
import { contentHash } from "../src/server/websites/hash.ts";
const base = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href); }
const out = ".data/studio-qa/responsive";
await fs.mkdir(out, { recursive: true });
const browser = await pw.chromium.launch({ headless: true });
const results = [];
const errors = [];
try {
  const pending = [...ALL_TEMPLATE_KEYS()];
  const persist = () => fs.writeFile(".data/studio-qa/responsive-results.json", JSON.stringify({ results, errors }, null, 2));
  const worker = async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await page.routeWebSocket("**/_next/webpack-hmr", (socket) => socket.close());
    page.on("pageerror", (error) => errors.push(error.message));
    let key;
    while ((key = pending.shift())) {
    const content = sampleSite(key);
    const signature = contentHash(content);
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const item of content.pages) {
        const slug = item.slug;
        const response = await page.goto(`${base}/dev/frame/template?key=${encodeURIComponent(key)}&p=${slug}`, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.locator(`[data-template-signature="${signature}"] .iq-site[data-site-page="${slug}"] footer`).waitFor({ timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        const top = await page.evaluate(() => ({
          xOverflow: document.documentElement.scrollWidth - innerWidth,
          headingCount: document.querySelectorAll("h1").length,
          mainCount: document.querySelectorAll("main").length,
          initialScroll: scrollY,
          height: document.documentElement.scrollHeight,
          viewport: innerWidth,
        }));
        await page.mouse.move(width / 2, 750);
        await page.mouse.wheel(0, 100000);
        let reachable = true;
        try { await page.waitForFunction(() => document.querySelector("footer").getBoundingClientRect().bottom <= innerHeight + 2, null, { timeout: 5000 }); } catch { reachable = false; }
        const final = await page.evaluate(() => ({ scroll: scrollY, bottom: document.querySelector("footer").getBoundingClientRect().bottom, brokenImages: [...document.images].filter((image) => image.complete && !image.naturalWidth).map((image) => image.currentSrc) }));
        const result = { key, signature, page: slug, width, status: response.status(), ...top, ...final, footerReachable: reachable };
        results.push(result);
        if (slug === "home" && key.endsWith("." + ({ luxe: "maison", tech: "nova", bold: "riot", corp: "charter", minimal: "quiet", local: "corner", care: "haven", meridian: "estate", host: "terrace", agency: "thesis" }[key.split(".")[0]]))) {
          // Traverse the actual page so native below-the-fold images load before the full-page evidence capture.
          await page.evaluate(async () => {
            for (let y = 0; y < document.documentElement.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((resolve) => setTimeout(resolve, 35)); }
            await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
            window.scrollTo(0, 0);
          });
          await page.screenshot({ path: `${out}/${key}-${width}.png`, fullPage: true, style: "nextjs-portal{display:none!important}" });
          final.brokenImages = await page.evaluate(() => [...document.images].filter((image) => image.complete && !image.naturalWidth).map((image) => image.currentSrc));
          result.brokenImages = final.brokenImages;
        }
        if (!reachable || top.xOverflow > 1 || top.headingCount !== 1 || top.mainCount !== 1 || response.status() !== 200 || final.brokenImages.length) console.log("FAIL", JSON.stringify(result));
      }
    }
    console.log(`Checked ${key}: ${content.pages.length} pages × 4 widths`);
    await persist();
    }
    await page.close();
  };
  await Promise.all([worker(), worker()]);
  const failures = results.filter((row) => !row.footerReachable || row.xOverflow > 1 || row.headingCount !== 1 || row.mainCount !== 1 || row.status !== 200 || row.brokenImages.length);
  console.log(JSON.stringify({ cases: results.length, failures: failures.length, browserErrors: errors.length }));
  if (failures.length || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
