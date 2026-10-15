// Responsive verification for every built-in template's home page.
// Requires the isolated local QA server and a Playwright module path in PLAYWRIGHT_MODULE.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_TEMPLATE_KEYS, sampleSite } from "../src/lib/website/templates/index.ts";

const base = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("Run QA only against the isolated local app.");
const playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) throw new Error("Set PLAYWRIGHT_MODULE to the installed Playwright module path.");
const { chromium } = await import(playwrightPath.startsWith("file:") ? playwrightPath : pathToFileURL(playwrightPath).href);
const keys = ALL_TEMPLATE_KEYS();
if (keys.length !== 50) throw new Error("Expected 50 built-in templates; got " + keys.length);
const representative = new Set(["luxe.maison", "tech.nova", "bold.riot", "corp.charter", "minimal.quiet", "local.corner", "care.haven", "meridian.estate", "host.terrace", "agency.thesis"]);
const widths = [390, 768, 1024, 1440];
const out = path.resolve(".data/studio-qa/imagery-responsive");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const results = [];
const errors = [];
const failedImages = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (response.request().resourceType() === "image" && response.status() >= 400) failedImages.push({ url: response.url(), status: response.status() });
});
try {
  for (const key of keys) {
    const sample = sampleSite(key);
    if (!sample.pages.some((item) => item.slug === "home")) throw new Error("Missing home page in " + key);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      let status = 0;
      let navigationError = null;
      try {
        const response = await page.goto(base + "/dev/frame/template?key=" + encodeURIComponent(key) + "&p=home", { waitUntil: "domcontentloaded", timeout: 90000 });
        status = response?.status() ?? 0;
        await page.locator('.iq-site[data-site-page="home"] footer').waitFor({ timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(async () => {
          const images = Array.from(document.images);
          for (const image of images) image.loading = "eager";
          await Promise.all(images.map((image) => image.decode().then(() => true, () => false)));
        });
      } catch (error) {
        navigationError = error instanceof Error ? error.message : String(error);
      }
      let metrics;
      try {
        metrics = await page.evaluate(() => {
          const footer = document.querySelector(".iq-site[data-site-page=home] footer");
          const images = Array.from(document.images);
          return {
            viewport: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            xOverflow: document.documentElement.scrollWidth - innerWidth,
            pageHeight: document.documentElement.scrollHeight,
            headingCount: document.querySelectorAll('.iq-site[data-site-page="home"] h1').length,
            mainCount: document.querySelectorAll('.iq-site[data-site-page="home"] main').length,
            brokenImages: images.filter((image) => image.complete && !image.naturalWidth).map((image) => image.currentSrc),
            footerReachable: Boolean(footer),
          };
        });
      } catch (error) {
        navigationError ??= error instanceof Error ? error.message : String(error);
        metrics = { viewport: width, documentWidth: width, xOverflow: 0, pageHeight: 0, headingCount: 0, mainCount: 0, brokenImages: [], footerReachable: false };
      }
      if (metrics.footerReachable) {
        try {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          metrics.footerReachable = await page.evaluate(() => {
            const footer = document.querySelector('.iq-site[data-site-page="home"] footer');
            return Boolean(footer && footer.getBoundingClientRect().bottom <= innerHeight + 2);
          });
        } catch (error) {
          navigationError ??= error instanceof Error ? error.message : String(error);
          metrics.footerReachable = false;
        }
      }
      const result = { key, width, status, ...metrics, navigationError };
      results.push(result);
      if (representative.has(key)) {
        try {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: path.join(out, key + "-" + width + ".png"), fullPage: true, style: "nextjs-portal{display:none!important}" });
        } catch (error) {
          navigationError ??= error instanceof Error ? error.message : String(error);
        }
      }
      result.navigationError = navigationError;
      await fs.writeFile(path.join(out, "results.json"), JSON.stringify({ results, errors, failedImages }, null, 2));
      if (status !== 200 || navigationError || !metrics.footerReachable || metrics.xOverflow > 1 || metrics.headingCount !== 1 || metrics.mainCount !== 1 || metrics.brokenImages.length) {
        console.log("FAIL", JSON.stringify(result));
      }
    }
    console.log("Checked " + key + " at four viewport widths");
  }
} finally {
  await page.close();
  await browser.close();
}
const failures = results.filter((row) => row.status !== 200 || row.navigationError || !row.footerReachable || row.xOverflow > 1 || row.headingCount !== 1 || row.mainCount !== 1 || row.brokenImages.length);
const summary = { cases: results.length, templates: keys.length, widths, failures: failures.length, browserErrors: errors.length, failedImageResponses: failedImages.length };
await fs.writeFile(path.join(out, "summary.json"), JSON.stringify({ summary, failures, errors, failedImages }, null, 2));
console.log(JSON.stringify(summary));
if (failures.length || errors.length || failedImages.length) process.exitCode = 1;
