// Text laid over a photograph must stay readable. A colour-contrast checker cannot judge that (the background is a picture), so this measures it:
// for every section whose background is an image, the text is made invisible, the section is photographed, and the pixels that were behind each piece of
// text are compared with that text's colour. A line of text passes when at least 90% of the pixels behind it give it WCAG contrast of 3:1 (large text) or
// 4.5:1 (body text).
//
//   npm run studio:qa
//   node scripts/studio-image-text-qa.mjs                           (all 50 templates, home page, 1440 and 390)
//   KEYS=agency.method WIDTHS=1440 node scripts/studio-image-text-qa.mjs
//   OVERLAY=dark:66 KEYS=agency.method node scripts/studio-image-text-qa.mjs     experiment: what if every photograph carried this overlay?
//
// Evidence: .data/studio-qa/image-text-results.json and .data/studio-qa/image-text/{key}-{width}.png (the section as a visitor sees it, with failing text marked)
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }
const WIDTHS = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);
const PAGES = (process.env.PAGES ?? "home").split(",");
const WORKERS = Number(process.env.WORKERS ?? 2);
const SHARE = Number(process.env.SHARE ?? 0.9);
const OUT = ".data/studio-qa";
await fs.mkdir(`${OUT}/image-text`, { recursive: true });

async function allKeys() {
  const b = await pw.chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    await p.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.locator("article").first().waitFor({ timeout: 60000 });
    return (await p.evaluate(() => [...document.querySelectorAll("[data-thumbnail-key]")].map((e) => e.getAttribute("data-thumbnail-key")))).sort();
  } finally { await b.close(); }
}

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Text that sits directly on a section's image: its box and colour, one entry per element that owns text. */
function collect() {
  const out = [];
  const sections = [...document.querySelectorAll(".iq-site section[data-bgkind='image'], .iq-site header[data-bgkind='image']")];
  for (const section of sections) {
    const sr = section.getBoundingClientRect();
    for (const el of section.querySelectorAll("h1, h2, h3, h4, p, li, small, .iq-eyebrow, .iq-lede, dt, dd, figcaption, blockquote")) {
      if (el.closest(".iq-btn, details:not([open]) > :not(summary), .iq-sr, .iq-marquee, [data-marquee], .iq-card, .iq-col[data-surface]")) continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) < 0.05) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (!own && !el.querySelector("em, strong, span, i, b, a")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      // Browsers report a mixed colour as color(srgb 0.9 0.9 0.9 / 0.92), on a 0-1 scale, and a plain one as rgb(230 230 230).
      const m = st.color.match(/[\d.]+/g).map(Number);
      if (st.color.startsWith("color(")) for (let k = 0; k < 3; k++) m[k] *= 255;
      const size = parseFloat(st.fontSize), weight = Number(st.fontWeight) || 400;
      out.push({ text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 44), tag: el.tagName.toLowerCase(), rgba: m, size, large: size >= 24 || (size >= 18.66 && weight >= 700),
        box: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }, section: section.id || section.className.slice(0, 20), sectionBox: { x: sr.left + scrollX, y: sr.top + scrollY, w: sr.width, h: sr.height } });
    }
  }
  return out;
}

async function inspect(browser, job) {
  const page = await browser.newPage({ viewport: { width: job.width, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
    await page.goto(`${BASE}/dev/frame/template?key=${encodeURIComponent(job.key)}&p=${job.page}`, { waitUntil: "load", timeout: 120000 });
    await page.locator("footer").first().waitFor({ timeout: 60000 });
    await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      for (let y = 0; y < document.documentElement.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); }
      await Promise.all([...document.images].map((i) => Promise.race([i.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])));
      window.scrollTo(0, 0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    // Experiment: OVERLAY="dark:66" (or "bg:80") paints every photograph's overlay that way, to find the weakest overlay that keeps its text readable.
    if (process.env.OVERLAY) {
      const [color, opacity] = process.env.OVERLAY.split(":");
      await page.addStyleTag({ content: `.iq-site [data-bgkind='image'] .iq-ov{background:color-mix(in srgb,${color === "dark" ? "var(--c-dark)" : "var(--bg)"} ${Number(opacity)}%,transparent)!important}` });
    }
    const items = await page.evaluate(collect);
    if (!items.length) return { ...job, items: 0, failing: [] };
    const sectionsOf = [...new Map(items.map((i) => [i.section, i.sectionBox])).entries()];
    const failing = [];
    let worst = 100;
    for (const [id, sb] of sectionsOf) {
      // The section as a visitor sees it, then with every piece of its text invisible, so the pixels behind the text can be read.
      const clip = { x: Math.max(0, sb.x), y: Math.max(0, sb.y), width: Math.min(sb.w, job.width), height: Math.min(sb.h, 2200) };
      const seen = await page.screenshot({ clip, fullPage: true, style: "nextjs-portal{display:none!important}" });
      await page.addStyleTag({ content: ".iq-site [data-bgkind='image'] :is(h1,h2,h3,h4,p,li,small,dt,dd,figcaption,blockquote,span,em,strong,i,b,a:not(.iq-btn)){color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}", });
      const bare = await page.screenshot({ clip, fullPage: true, style: "nextjs-portal{display:none!important}" });
      await page.evaluate(() => document.querySelectorAll("style").forEach((s) => { if (s.textContent.startsWith(".iq-site [data-bgkind='image'] :is(h1")) s.remove(); }));
      const { data, info } = await sharp(bare).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const marks = [];
      for (const it of items.filter((i) => i.section === id)) {
        const x0 = Math.max(0, Math.floor(it.box.x - sb.x)), y0 = Math.max(0, Math.floor(it.box.y - sb.y));
        const x1 = Math.min(info.width, Math.ceil(it.box.x - sb.x + it.box.w)), y1 = Math.min(info.height, Math.ceil(it.box.y - sb.y + it.box.h));
        if (x1 <= x0 || y1 <= y0) continue;
        const [tr, tg, tb] = it.rgba; const alpha = it.rgba[3] ?? 1;
        const need = it.large ? 3 : 4.5;
        let ok = 0, total = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
          const i = (y * info.width + x) * info.channels;
          const br = data[i], bg = data[i + 1], bb = data[i + 2];
          // Text drawn at partial opacity is blended with the pixel behind it.
          const fr = tr * alpha + br * (1 - alpha), fg = tg * alpha + bg * (1 - alpha), fb = tb * alpha + bb * (1 - alpha);
          total++;
          if (ratio(lum(fr, fg, fb), lum(br, bg, bb)) >= need) ok++;
        }
        const share = total ? ok / total : 1;
        worst = Math.min(worst, share * 100);
        if (share < SHARE) { failing.push({ text: it.text, tag: it.tag, size: Math.round(it.size), need, readablePercent: Math.round(share * 100), section: id }); marks.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }); }
      }
      if (marks.length) {
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}">${marks.map((m) => `<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="none" stroke="#ff2d55" stroke-width="3"/>`).join("")}</svg>`);
        await sharp(seen).composite([{ input: svg }]).png().toFile(`${OUT}/image-text/${job.key}-${job.width}-${job.page}-${id}.png`);
      }
    }
    return { ...job, items: items.length, sections: sectionsOf.length, failing, worstReadablePercent: Math.round(worst) };
  } finally { await page.close().catch(() => {}); }
}

const keys = process.env.KEYS ? process.env.KEYS.split(",") : await allKeys();
const queue = keys.flatMap((key) => WIDTHS.flatMap((width) => PAGES.map((page) => ({ key, width, page }))));
const rows = [];
console.log(`Text over photographs: ${queue.length} page views against ${BASE}`);
async function worker() {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    let job;
    while ((job = queue.shift())) {
      let row;
      try { row = await inspect(browser, job); } catch (error) { row = { ...job, failing: [{ text: `could not check: ${String(error.message).split("\n")[0]}` }] }; }
      rows.push(row);
      if (row.failing.length) console.log(`${job.key} p=${job.page} @${job.width}: ${row.failing.slice(0, 3).map((f) => `"${f.text}" ${f.readablePercent ?? ""}% readable`).join(" | ")}`);
    }
  } finally { await browser.close(); }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
rows.sort((a, b) => a.key.localeCompare(b.key) || a.width - b.width);
const failing = rows.filter((r) => r.failing.length);
await fs.writeFile(`${OUT}/image-text-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, requiredShare: SHARE, views: rows.length, viewsWithText: rows.filter((r) => r.items).length, failing: failing.length, templatesAffected: new Set(failing.map((r) => r.key)).size, rows }, null, 2));
console.log(JSON.stringify({ views: rows.length, viewsWithTextOverPhotos: rows.filter((r) => r.items).length, failing: failing.length, templatesAffected: new Set(failing.map((r) => r.key)).size, evidence: `${OUT}/image-text-results.json` }));
if (failing.length) process.exitCode = 1;
