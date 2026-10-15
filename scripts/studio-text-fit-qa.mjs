// Text-fit and readability audit for every template page at every responsive width, in a real browser.
//
//   npm run studio:qa                                   (another terminal: the isolated local app on :3210)
//   node scripts/studio-text-fit-qa.mjs
//   KEYS=bold.pop WIDTHS=390,1440 PAGES=home node scripts/studio-text-fit-qa.mjs
//   AXE_SOURCE=/path/to/axe.min.js node scripts/studio-text-fit-qa.mjs     (adds a colour-contrast check; axe-core is a QA tool, not an app dependency)
//
// Per page and width it reports: a word split across two lines (a column too narrow for its heading); horizontal overflow; text clipped by an
// element that hides overflow; body text under 12px; a header button squeezed onto three or more lines; content starting behind a floating header; and, with axe, text whose contrast fails WCAG AA. Evidence: .data/studio-qa/text-fit-results.json
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }
const axeSource = process.env.AXE_SOURCE ? await fs.readFile(process.env.AXE_SOURCE, "utf8") : null;

const WIDTHS = (process.env.WIDTHS ?? "390,768,1024,1440").split(",").map(Number);
const PAGES = (process.env.PAGES ?? "home,about,services,faq,gallery,contact").split(",");
const WORKERS = Number(process.env.WORKERS ?? 3);
const OUT = ".data/studio-qa";
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

/** Runs inside the page. */
function measure() {
  const site = document.querySelector(".iq-site");
  const found = { brokenWords: [], clipped: [], tiny: [], squeezed: [], overlap: [] };
  const visible = (el) => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05; };
  const walker = document.createTreeWalker(site, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const el = node.parentElement;
    if (!el || el.closest(".iq-sr, [hidden], .iq-marquee, [data-marquee], script, style, details:not([open]) > :not(summary)") || !visible(el)) continue;
    const text = node.nodeValue;
    // A break at a hyphen or after the @ of an address is a proper place to break; a word chopped anywhere else is not.
    for (const m of text.matchAll(/\S{5,}/g)) {
      let offset = m.index;
      for (const piece of m[0].split(/(?<=[-@])/)) {
        if (piece.replace(/[-@]/g, "").length >= 5) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + piece.length);
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top / 6)));
          if (lines.size > 1) found.brokenWords.push(`${piece} (${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]})`);
        }
        offset += piece.length;
      }
    }
    const style = getComputedStyle(el);
    if (text.trim().length > 20 && parseFloat(style.fontSize) < 12 && !el.closest(".iq-fine, .iq-small, small, label, .iq-eyebrow")) found.tiny.push(`${parseFloat(style.fontSize)}px: ${text.trim().slice(0, 40)}`);
  }
  // Clipped means the text itself runs past a box that hides overflow, not merely that something decorative inside the box does.
  for (const el of site.querySelectorAll("h1, h2, h3, p, a, button, li")) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    // Content inside a closed <details> (the phone menu) is laid out but not shown, so it cannot be clipped in any way a visitor sees.
    if ((s.overflowX !== "hidden" && s.overflowX !== "clip") || el.closest(".iq-marquee, [data-marquee], .iq-logos, .iq-gal, details:not([open]) > :not(summary)")) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = [...range.getClientRects()].filter((r) => r.width > 0.5);
    if (!text.length) continue;
    const box = el.getBoundingClientRect();
    if (Math.max(...text.map((r) => r.right)) > box.right + 1.5 || Math.min(...text.map((r) => r.left)) < box.left - 1.5) found.clipped.push(`${el.tagName.toLowerCase()}: ${el.textContent.trim().slice(0, 40)}`);
  }
  // A button in the header that has to stack its label on three or more lines is squeezed: the links should have folded into the menu instead.
  for (const el of site.querySelectorAll(".iq-header .iq-btn")) {
    if (!visible(el) || el.closest("details:not([open]) > :not(summary)") || el.getBoundingClientRect().width < 1) continue;
    // Lines are counted from the text itself (not from the boxes around it, which sit at slightly different heights).
    const tops = new Set();
    const words = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let part;
    while ((part = words.nextNode())) {
      if (!part.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(part);
      for (const r of range.getClientRects()) if (r.width > 0.5) tops.add(Math.round(r.top / 6));
    }
    if (tops.size > 2) found.squeezed.push(`${tops.size} lines: ${el.textContent.trim().slice(0, 40)}`);
  }
  // A floating header lies over the top of the first section, so nothing in that section may start behind it.
  const floating = site.querySelector(".iq-header.iq-float");
  const first = site.querySelector("main > .iq-sec");
  if (floating && first) {
    const bottom = floating.getBoundingClientRect().bottom;
    const content = [...first.querySelectorAll("h1, h2, h3, p, .iq-eyebrow, .iq-btn")].find((el) => !el.closest(".iq-bg, .iq-marquee, [data-marquee], details:not([open]) > :not(summary)") && visible(el) && el.getBoundingClientRect().width > 0);
    const top = content ? content.getBoundingClientRect().top : Infinity;
    if (content && top < bottom - 1) found.overlap.push(`"${content.textContent.trim().slice(0, 30)}" starts ${Math.round(top)}px, header ends ${Math.round(bottom)}px`);
  }
  return { ...found, xOverflow: document.documentElement.scrollWidth - innerWidth };
}

const rows = [];
const keys = process.env.KEYS ? process.env.KEYS.split(",") : await allKeys();
const queue = keys.flatMap((key) => WIDTHS.flatMap((width) => PAGES.map((page) => ({ key, width, page }))));
console.log(`Text-fit audit: ${queue.length} page views (${keys.length} templates x ${WIDTHS.join("/")} x ${PAGES.length} pages)${axeSource ? " with colour contrast" : ""}`);

async function worker() {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
    let job;
    while ((job = queue.shift())) {
      const row = { ...job, issues: [] };
      try {
        await page.setViewportSize({ width: job.width, height: 900 });
        await page.goto(`${BASE}/dev/frame/template?key=${encodeURIComponent(job.key)}&p=${job.page}`, { waitUntil: "load", timeout: 120000 });
        await page.locator("footer").first().waitFor({ timeout: 60000 });
        await page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
        await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 }); // the header folds its links into the menu once its scripts have measured them
        await page.waitForTimeout(100);
        const result = await page.evaluate(measure);
        row.xOverflow = result.xOverflow;
        if (result.xOverflow > 1) row.issues.push(`horizontal overflow ${result.xOverflow}px`);
        for (const word of [...new Set(result.brokenWords)].slice(0, 6)) row.issues.push(`word split across lines: ${word}`);
        for (const item of [...new Set(result.clipped)].slice(0, 3)) row.issues.push(`clipped text: ${item}`);
        for (const item of [...new Set(result.tiny)].slice(0, 3)) row.issues.push(`small text ${item}`);
        for (const item of [...new Set(result.squeezed)].slice(0, 2)) row.issues.push(`header button squeezed onto ${item}`);
        for (const item of [...new Set(result.overlap)].slice(0, 2)) row.issues.push(`floating header covers the first content: ${item}`);
        if (axeSource) {
          await page.evaluate(axeSource);
          const contrast = await page.evaluate(async () => {
            const result = await window.axe.run(document.querySelector(".iq-site"), { runOnly: ["color-contrast"], resultTypes: ["violations"] });
            return result.violations.flatMap((violation) => violation.nodes.map((node) => {
              const data = node.any[0]?.data ?? {};
              return { ratio: data.contrastRatio, fg: data.fgColor, bg: data.bgColor, size: data.fontSize, text: (node.html.match(/>([^<]{3,40})/)?.[1] ?? node.target.join(" ")).slice(0, 40) };
            }));
          });
          row.contrast = contrast;
          for (const c of contrast.slice(0, 4)) row.issues.push(`low contrast ${c.ratio}:1 (${c.fg} on ${c.bg}, ${c.size}) "${c.text}"`);
          if (contrast.length > 4) row.issues.push(`... and ${contrast.length - 4} more low-contrast items`);
        }
      } catch (error) { row.issues.push(`could not audit: ${String(error.message).split("\n")[0]}`); }
      rows.push(row);
      if (row.issues.length) console.log(`${job.key} p=${job.page} @${job.width}: ${row.issues.slice(0, 3).join(" | ")}`);
    }
  } finally { await browser.close(); }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
rows.sort((a, b) => a.key.localeCompare(b.key) || a.width - b.width || a.page.localeCompare(b.page));
const failing = rows.filter((r) => r.issues.length);
const byTemplate = {};
for (const r of failing) byTemplate[r.key] = (byTemplate[r.key] ?? 0) + 1;
await fs.writeFile(`${OUT}/text-fit-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, contrast: Boolean(axeSource), views: rows.length, failing: failing.length, templatesAffected: Object.keys(byTemplate).length, byTemplate, rows }, null, 2));
console.log(JSON.stringify({ views: rows.length, failing: failing.length, templatesAffected: Object.keys(byTemplate).length, evidence: `${OUT}/text-fit-results.json` }));
if (failing.length) process.exitCode = 1;
