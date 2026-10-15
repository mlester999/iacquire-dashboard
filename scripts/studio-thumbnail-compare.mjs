// Thumbnail-versus-preview comparison for every built-in template, in a real browser.
//
//   npm run studio:qa                                          (another terminal: the isolated local app on :3210)
//   node scripts/studio-thumbnail-compare.mjs
//   KEYS=luxe.maison,tech.nova node scripts/studio-thumbnail-compare.mjs
//
// For each template it does what a client does: finds the card in the gallery, checks that the card shows the stored screenshot (and not the live
// fallback), opens Preview, and compares the top of the framed website with that screenshot. Three things are checked:
//   1. identity: the card, the screenshot's manifest entry and the framed website agree on template id, version and content signature;
//   2. the card really shows the screenshot file the manifest names, fully decoded, with no live iframe standing in for it;
//   3. the picture matches the preview, measured with a threshold that is calibrated against negative controls (the same screenshot against OTHER
//      templates' previews) rather than guessed: every real pair must sit well below the closest wrong pair.
// Evidence (development only, git-ignored): .data/studio-qa/thumbnail-compare.json and thumbnail-comparisons/{key}-compare.jpg (screenshot | preview | difference).
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }

const manifest = JSON.parse(await fs.readFile("src/lib/website/template-thumbnails.json", "utf8"));
const WORKERS = Number(process.env.WORKERS ?? 2);
const OUT = ".data/studio-qa";
const EVIDENCE = `${OUT}/thumbnail-comparisons`;
await fs.mkdir(EVIDENCE, { recursive: true });
// Roomy enough that the preview shows the website at its real 1440px width, unscaled.
const VIEW = { width: 1700, height: 1200 };
const W = 720, H = 450;

const retry = async (fn, tries = 4) => { let last; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; if (!/context was destroyed|navigation|Cannot read properties of null/.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 400)); } } throw last; };

async function allKeys() {
  const b = await pw.chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    await p.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.locator("article").first().waitFor({ timeout: 60000 });
    return (await p.evaluate(() => [...document.querySelectorAll("[data-thumbnail-key]")].map((e) => e.getAttribute("data-thumbnail-key")))).sort();
  } finally { await b.close(); }
}

const rgb = async (input) => (await sharp(input).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
/** Mean absolute channel difference, 0-100 (percent of full scale), and the share of pixels that differ visibly. */
function difference(a, b) {
  let sum = 0, changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    sum += d;
    if (d > 32) changed++;
  }
  return { mean: +(sum / a.length * 3 / 255 * 100).toFixed(3), changed: +(changed / (a.length / 3) * 100).toFixed(2) };
}

async function inspect(browser, key) {
  const row = { key, notes: [] };
  const entry = manifest.templates[key];
  if (!entry) { row.notes.push("no screenshot in the manifest"); return { row }; }
  const context = await browser.newContext({ viewport: VIEW, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
    await page.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => { const b = document.querySelector('article button[aria-label^="Preview "]'); return b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 90000 });

    // 2) the card shows the stored screenshot
    const card = page.locator(`[data-thumbnail-key="${key}"]`).first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForFunction((k) => { const img = document.querySelector(`[data-thumbnail-key="${k}"] img`); return !img || (img.complete && img.naturalWidth > 0); }, key, { timeout: 30000 }).catch(() => {});
    row.card = await card.evaluate((el) => {
      const img = el.querySelector("img");
      return { signature: el.getAttribute("data-thumbnail-signature"), version: el.getAttribute("data-thumbnail-version"), hasImg: Boolean(img), liveFrame: Boolean(el.querySelector("iframe")),
        src: img?.getAttribute("src") ?? null, currentSrc: img?.currentSrc ?? null, naturalWidth: img?.naturalWidth ?? 0, loading: img?.getAttribute("loading") ?? null };
    });
    if (!row.card.hasImg || row.card.liveFrame) row.notes.push(row.card.liveFrame ? "card falls back to a live iframe (the screenshot is stale or missing)" : "card shows no screenshot");
    if (row.card.hasImg && !row.card.naturalWidth) row.notes.push("card screenshot did not decode");
    if (row.card.src && row.card.src !== entry.src) row.notes.push(`card shows ${row.card.src}, not ${entry.src}`);
    if (row.card.signature !== entry.signature) row.notes.push(`card signature ${row.card.signature} is not the manifest's ${entry.signature}`);
    if (Number(row.card.version) !== entry.version) row.notes.push(`card version ${row.card.version} is not the manifest's ${entry.version}`);

    // 1) the preview a client opens
    await page.locator(`article:has([data-thumbnail-key="${key}"]) button[aria-label^="Preview "]`).first().click();
    await page.locator("dialog[open]").waitFor({ timeout: 15000 });
    const handle = await page.locator("dialog iframe").elementHandle();
    const frame = await handle.contentFrame();
    await frame.waitForSelector("footer", { timeout: 60000 });
    await frame.waitForLoadState("load", { timeout: 60000 });
    await frame.waitForSelector('.iq-site[data-nav-fit="ready"]', { state: "attached", timeout: 30000 });
    await page.locator('dialog [role="status"]').waitFor({ state: "detached", timeout: 60000 });
    await retry(() => frame.evaluate(async () => {
      await document.fonts.ready;
      const near = [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight * 1.2);
      await Promise.all(near.map((i) => Promise.race([i.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))])));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }));
    row.preview = await retry(() => frame.evaluate(() => { const r = document.querySelector("[data-template-frame]"); return { key: r?.getAttribute("data-template-frame"), version: r?.getAttribute("data-template-version"), signature: r?.getAttribute("data-template-signature"), width: innerWidth }; }));
    if (row.preview.key !== key) row.notes.push(`preview shows ${row.preview.key}`);
    if (Number(row.preview.version) !== entry.version) row.notes.push(`preview is version ${row.preview.version}, the screenshot is version ${entry.version}`);
    if (row.preview.signature !== entry.signature) row.notes.push(`preview content signature ${row.preview.signature} differs from the screenshot's ${entry.signature}`);
    if (row.preview.width !== 1440) row.notes.push(`preview rendered at ${row.preview.width}px, not 1440`);

    // The screenshots are taken in a 1440x900 window, and a section sized in vh (a 90vh hero) follows the window, so compare like with like: size this
    // browser window so that the framed website sees a 900px-tall window too.
    let innerH = await frame.evaluate(() => innerHeight);
    if (innerH !== 900) {
      await page.setViewportSize({ width: VIEW.width, height: VIEW.height - (innerH - 900) });
      await page.waitForTimeout(700);
      await frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      innerH = await frame.evaluate(() => innerHeight);
    }
    row.previewWindowHeight = innerH;
    if (innerH !== 900) row.notes.push(`could not give the preview a 900px-tall window (it has ${innerH}px)`);

    // The top 1440x900 of the website, however the dialog scaled it.
    const box = await handle.boundingBox();
    const scale = box.width / 1440;
    const clipHeight = Math.min(box.height, 900 * scale);
    const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: clipHeight }, style: "nextjs-portal{display:none!important}" });
    row.previewScale = +scale.toFixed(3);
    if (clipHeight < 900 * scale - 2) row.notes.push(`the preview shows only ${Math.round(clipHeight / scale)}px of the top 900px`);
    await page.keyboard.press("Escape");
    return { row, shot, entry };
  } finally { await context.close().catch(() => {}); }
}

const keys = process.env.KEYS ? process.env.KEYS.split(",") : await allKeys();
const queue = [...keys];
const results = [];
console.log(`Comparing ${keys.length} screenshots with their previews against ${BASE}`);

async function worker() {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    let key;
    while ((key = queue.shift())) {
      let out;
      for (let attempt = 1; attempt <= 2 && !out; attempt++) {
        try { out = await inspect(browser, key); } catch (error) {
          if (attempt === 2) out = { row: { key, notes: [`could not compare: ${String(error.message).split("\n")[0]}`] } };
        }
      }
      results.push(out);
      console.log(`${out.row.notes.length ? "FLAG" : "ok  "} ${key}${out.row.notes.length ? `: ${out.row.notes.join(" | ")}` : ""}`);
    }
  } finally { await browser.close(); }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
results.sort((a, b) => a.row.key.localeCompare(b.row.key));

// 3) picture against preview, and the calibration that makes the threshold meaningful.
const withShots = results.filter((r) => r.shot && r.entry);
const thumbs = new Map(), previews = new Map();
for (const r of withShots) {
  thumbs.set(r.row.key, await rgb(path.join("public", r.entry.src)));
  previews.set(r.row.key, await rgb(r.shot));
}
const matched = [], wrong = [];
for (const r of withShots) {
  r.row.match = difference(thumbs.get(r.row.key), previews.get(r.row.key));
  matched.push(r.row.match.mean);
  // The closest look-alikes are the other designs of the same family, so those are the controls that matter.
  const family = r.row.key.split(".")[0];
  for (const other of withShots) if (other !== r) {
    const sameFamily = other.row.key.startsWith(`${family}.`);
    if (sameFamily || (hash(r.row.key + other.row.key) % 9 === 0)) wrong.push({ shot: r.row.key, preview: other.row.key, ...difference(thumbs.get(r.row.key), previews.get(other.row.key)) });
  }
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
const worstMatched = Math.max(0, ...matched);
const closestWrong = wrong.length ? wrong.reduce((a, b) => (b.mean < a.mean ? b : a)) : null;
// Real pairs must sit well clear of the closest wrong pair: the limit is a quarter of the way up from the worst real pair to the best wrong one.
const limit = closestWrong ? +(worstMatched + (closestWrong.mean - worstMatched) * 0.25).toFixed(3) : 5;
const separated = closestWrong ? closestWrong.mean > worstMatched * 2 : false;
for (const r of withShots) {
  if (r.row.match.mean > limit) r.row.notes.push(`picture differs from the preview by ${r.row.match.mean}% (limit ${limit}%)`);
  // Evidence: screenshot | preview | difference, side by side.
  const a = thumbs.get(r.row.key), b = previews.get(r.row.key);
  const diff = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) diff[i] = Math.min(255, Math.abs(a[i] - b[i]) * 4);
  const tile = (raw) => sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  const [ta, tb, td] = await Promise.all([tile(a), tile(b), tile(diff)]);
  await sharp({ create: { width: W * 3 + 40, height: H + 20, channels: 3, background: "#e9ebf0" } })
    .composite([{ input: ta, left: 10, top: 10 }, { input: tb, left: 20 + W, top: 10 }, { input: td, left: 30 + W * 2, top: 10 }])
    .jpeg({ quality: 82 }).toFile(`${EVIDENCE}/${r.row.key}-compare.jpg`);
}
const rows = results.map((r) => r.row);
const flagged = rows.filter((r) => r.notes.length);
const summary = {
  ranAt: new Date().toISOString(), base: BASE, templates: rows.length, flagged: flagged.length,
  calibration: { worstRealPairMeanDiffPercent: +worstMatched.toFixed(3), closestWrongPair: closestWrong, wrongPairsMeasured: wrong.length, limitPercent: limit, realAndWrongSeparated: separated },
};
await fs.writeFile(`${OUT}/thumbnail-compare.json`, JSON.stringify({ ...summary, rows }, null, 2));
console.log(JSON.stringify(summary));
if (!separated) { console.log("The comparison cannot tell a right picture from a wrong one on this data, so it proves nothing."); process.exitCode = 1; }
if (flagged.length) process.exitCode = 1;
