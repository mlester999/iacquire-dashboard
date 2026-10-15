// A section reached through a link to its anchor (#services) must land below a sticky or floating header, not behind it, on every template.
//
//   npm run studio:qa
//   node scripts/studio-anchor-qa.mjs                      (all 50 templates, home page, 1440 and 390)
//   KEYS=luxe.noir WIDTHS=390 node scripts/studio-anchor-qa.mjs
//   CONTROL=1 KEYS=luxe.noir node scripts/studio-anchor-qa.mjs     negative control: removes the anchor offset, so the check MUST report covered sections
//
// For each section with an id the page is opened at that hash, exactly as a visitor following the link would see it, and the section's top edge is
// compared with the bottom of the header. Evidence: .data/studio-qa/anchor-results.json
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }
const WIDTHS = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);
const WORKERS = Number(process.env.WORKERS ?? 2);
const OUT = ".data/studio-qa";

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
      const row = { ...job, header: null, sections: 0, covered: [] };
      try {
        const page = await browser.newPage({ viewport: { width: job.width, height: 900 }, reducedMotion: "reduce" });
        await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
        await page.goto(`${BASE}/dev/frame/template?key=${encodeURIComponent(job.key)}`, { waitUntil: "load", timeout: 120000 });
        await page.locator("footer").first().waitFor({ timeout: 60000 });
        await page.evaluate(() => document.fonts.ready);
        if (process.env.CONTROL === "1") await page.addStyleTag({ content: ".iq-site :where(section[id], main[id]) { scroll-margin-top: 0 !important; }" });
        const ids = await page.evaluate(() => [...document.querySelectorAll("main section[id], main [data-site-main] section[id]")].map((s) => s.id).slice(1, 9));
        const header = await page.evaluate(() => { const h = document.querySelector("header.iq-header"); if (!h) return null; const s = getComputedStyle(h); return { position: s.position, sticky: h.classList.contains("iq-sticky"), floating: h.classList.contains("iq-float") }; });
        row.header = header;
        row.sections = ids.length;
        for (const id of ids) {
          // Follow the anchor as a link does, from the top of the page.
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.evaluate((target) => { location.hash = ""; location.hash = `#${target}`; }, id);
          await page.waitForTimeout(250);
          const m = await page.evaluate((target) => {
            const section = document.getElementById(target);
            const h = document.querySelector("header.iq-header");
            const hb = h ? h.getBoundingClientRect() : null;
            const covering = hb && getComputedStyle(h).position !== "static" && getComputedStyle(h).position !== "relative" && hb.height > 0 ? hb.bottom : 0;
            const top = section.getBoundingClientRect().top;
            const atBottom = Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 1;
            return { top: Math.round(top), covering: Math.round(covering), atBottom };
          }, id);
          // A section near the end of the page cannot scroll to the top; it is fine as long as it is not behind the header.
          if (m.top < m.covering - 1 && !m.atBottom) row.covered.push(`#${id} starts ${m.top}px, header covers to ${m.covering}px`);
        }
        await page.close();
      } catch (error) { row.covered.push(`could not check: ${String(error.message).split("\n")[0]}`); }
      rows.push(row);
      if (row.covered.length) console.log(`${job.key} @${job.width}: ${row.covered.slice(0, 3).join(" | ")}`);
    }
  } finally { await browser.close(); }
}
console.log(`Anchor check: ${queue.length} template views against ${BASE}`);
await Promise.all(Array.from({ length: WORKERS }, worker));
rows.sort((a, b) => a.key.localeCompare(b.key) || a.width - b.width);
const failing = rows.filter((r) => r.covered.length);
const pinned = rows.filter((r) => r.header && (r.header.sticky || r.header.floating)).length;
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(`${OUT}/anchor-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, views: rows.length, viewsWithPinnedHeader: pinned, failing: failing.length, rows }, null, 2));
console.log(JSON.stringify({ views: rows.length, viewsWithPinnedHeader: pinned, failing: failing.length, evidence: `${OUT}/anchor-results.json` }));
if (failing.length) process.exitCode = 1;
