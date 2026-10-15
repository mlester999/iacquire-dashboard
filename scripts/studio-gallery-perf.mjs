// Measures what a client's browser actually does to show the template gallery and open a preview. Real Chromium, real network stack, no invented numbers.
//
//   STUDIO_QA_URL=http://localhost:3240 COOKIE="iaq_session=..." node scripts/studio-gallery-perf.mjs [label]
//   STUDIO_QA_URL=http://localhost:3210 node scripts/studio-gallery-perf.mjs [label]        development server, gallery at /dev/gallery-preview (no sign-in)
//
// Use a production build (`next build` + `next start`) of the isolated app for timings that mean something: a development server compiles on demand and
// serves unminified code, so only its byte and request counts, and comparisons between two development servers, are meaningful. The page measured is
// the client gallery.
//
// Per run (fresh browser context, so a cold cache): requests and transferred bytes (images and everything else, from the network stack), live preview
// frames mounted, time until the first and the last above-the-fold thumbnail has decoded, layout shift, and - after scrolling through the whole
// gallery - the totals again. Then the time from clicking Preview to the website being usable. Each figure is the median of RUNS runs.
// Output: .data/studio-qa/gallery-perf-{label}.json
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3240";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
// Signed in (COOKIE=iaq_session=... from the isolated QA credentials, path /website/new) or, on a development server only, the same gallery with no sign-in.
const COOKIE = process.env.COOKIE;
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }

const label = process.argv[2] ?? "run";
// PROFILE=unthrottled or mobile-4g measures just that network profile.
const RUNS = Number(process.env.RUNS ?? 3);
const PATH = process.env.GALLERY_PATH ?? (COOKIE ? "/website/new" : "/dev/gallery-preview");
const PROFILES = { unthrottled: null, "mobile-4g": { latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (9 * 1024 * 1024) / 8 } };
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

async function once(browser, profile) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", extraHTTPHeaders: COOKIE ? { cookie: COOKIE } : {} });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  if (PROFILES[profile]) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...PROFILES[profile] });
  const requests = new Map();
  cdp.on("Network.requestWillBeSent", (e) => requests.set(e.requestId, { url: e.request.url, type: e.type, bytes: 0 }));
  cdp.on("Network.loadingFinished", (e) => { const r = requests.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
  const totals = () => {
    const all = [...requests.values()].filter((r) => !r.url.startsWith("data:") && !r.url.includes("webpack-hmr"));
    const sum = (xs) => xs.reduce((n, r) => n + r.bytes, 0);
    const images = all.filter((r) => r.type === "Image");
    const documents = all.filter((r) => r.type === "Document");
    return { requests: all.length, bytes: sum(all), imageRequests: images.length, imageBytes: sum(images), documentRequests: documents.length, documentBytes: sum(documents), scriptBytes: sum(all.filter((r) => r.type === "Script")) };
  };
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  });
  const started = Date.now();
  await page.goto(`${BASE}${PATH}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator("article").first().waitFor({ timeout: 60000 });
  const tour = page.locator('[aria-labelledby="tour-title"]');
  if (await tour.count()) await tour.getByRole("button", { name: /skip/i }).first().click().catch(() => {});
  const timeToCards = Date.now() - started;

  // Thumbnails that start inside the first screen.
  const firstScreen = await page.evaluate(() => [...document.querySelectorAll("[data-thumbnail-key]")].filter((e) => e.getBoundingClientRect().top < innerHeight).map((e) => e.getAttribute("data-thumbnail-key")));
  await page.waitForFunction((keys) => keys.every((k) => { const img = document.querySelector(`[data-thumbnail-key="${k}"] img`); return img && img.complete && img.naturalWidth > 0; }) || performance.now() > 25000, firstScreen, { timeout: 30000, polling: 50 }).catch(() => {});
  const firstScreenDone = Date.now() - started;
  const above = await page.evaluate(() => ({ imgs: document.querySelectorAll("[data-thumbnail-key] img").length, frames: document.querySelectorAll("[data-thumbnail-key] iframe").length }));
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  const first = totals();
  const clsFirst = await page.evaluate(() => window.__cls);

  // Scroll through everything, the way a client browsing fifty designs does.
  let peakFrames = above.frames;
  for (let y = 0; y < 60000; y += 500) {
    const more = await page.evaluate((to) => { window.scrollTo(0, to); return { max: document.documentElement.scrollHeight - innerHeight, frames: document.querySelectorAll("iframe").length }; }, y);
    peakFrames = Math.max(peakFrames, more.frames);
    await page.waitForTimeout(60);
    if (y > more.max) break;
  }
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  const full = totals();
  const end = await page.evaluate(() => ({ cards: document.querySelectorAll("[data-thumbnail-key]").length, stills: document.querySelectorAll("[data-thumbnail-key] img").length, frames: document.querySelectorAll("[data-thumbnail-key] iframe").length, cls: window.__cls }));
  await page.evaluate(() => window.scrollTo(0, 0));

  // Opening a preview.
  const trigger = page.locator('article button[aria-label^="Preview "]').first();
  await trigger.scrollIntoViewIfNeeded();
  // A button clicked before the page's scripts have attached does nothing, so wait for it to be live, as a person's click would be.
  await page.waitForFunction(() => { const b = document.querySelector('article button[aria-label^="Preview "]'); return b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 60000 });
  const openStarted = Date.now();
  await trigger.click();
  await page.locator("dialog[open]").waitFor({ timeout: 15000 });
  const handle = await page.locator("dialog iframe").elementHandle();
  const frame = await handle.contentFrame();
  await frame.waitForSelector("footer", { timeout: 60000 });
  await page.locator('dialog [role="status"]').waitFor({ state: "detached", timeout: 60000 });
  const previewReady = Date.now() - openStarted;
  const previewTotals = totals();
  await context.close();
  return {
    timeToCardsMs: timeToCards, firstScreenThumbnailsMs: firstScreenDone, firstScreenCount: firstScreen.length, firstScreenFrames: above.frames,
    firstLoad: first, afterScrollingEverything: full, peakLiveFrames: peakFrames, cards: end.cards, stills: end.stills, liveFramesAtEnd: end.frames,
    clsFirstScreen: +clsFirst.toFixed(4), clsAfterScrolling: +end.cls.toFixed(4), previewReadyMs: previewReady, previewExtraBytes: previewTotals.bytes - full.bytes,
  };
}

const browser = await pw.chromium.launch({ headless: true });
const report = { label, base: BASE, path: PATH, runs: RUNS, ranAt: new Date().toISOString(), profiles: {} };
try {
  for (const profile of Object.keys(PROFILES).filter((p) => !process.env.PROFILE || p === process.env.PROFILE)) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) samples.push(await once(browser, profile));
    const pick = (f) => median(samples.map(f));
    report.profiles[profile] = {
      timeToCardsMs: pick((s) => s.timeToCardsMs), firstScreenThumbnailsMs: pick((s) => s.firstScreenThumbnailsMs), firstScreenCount: samples[0].firstScreenCount,
      firstScreenLiveFrames: pick((s) => s.firstScreenFrames),
      firstLoadRequests: pick((s) => s.firstLoad.requests), firstLoadKB: Math.round(pick((s) => s.firstLoad.bytes) / 1024), firstLoadImageKB: Math.round(pick((s) => s.firstLoad.imageBytes) / 1024),
      firstLoadImageRequests: pick((s) => s.firstLoad.imageRequests), firstLoadDocumentRequests: pick((s) => s.firstLoad.documentRequests),
      scrolledRequests: pick((s) => s.afterScrollingEverything.requests), scrolledKB: Math.round(pick((s) => s.afterScrollingEverything.bytes) / 1024), scrolledImageKB: Math.round(pick((s) => s.afterScrollingEverything.imageBytes) / 1024),
      scrolledDocumentRequests: pick((s) => s.afterScrollingEverything.documentRequests), peakLiveFrames: pick((s) => s.peakLiveFrames), cards: samples[0].cards, stills: pick((s) => s.stills), liveFramesAtEnd: pick((s) => s.liveFramesAtEnd),
      clsFirstScreen: pick((s) => s.clsFirstScreen), clsAfterScrolling: pick((s) => s.clsAfterScrolling), previewReadyMs: pick((s) => s.previewReadyMs), previewExtraKB: Math.round(pick((s) => s.previewExtraBytes) / 1024),
      samples,
    };
    const p = report.profiles[profile];
    console.log(`[${label} / ${profile}] cards ${p.timeToCardsMs}ms | first-screen thumbnails ${p.firstScreenThumbnailsMs}ms (${p.firstScreenCount}, ${p.firstScreenLiveFrames} live frames) | first load ${p.firstLoadRequests} req ${p.firstLoadKB}KB (images ${p.firstLoadImageKB}KB) | whole gallery ${p.scrolledRequests} req ${p.scrolledKB}KB (images ${p.scrolledImageKB}KB, ${p.scrolledDocumentRequests} documents, peak ${p.peakLiveFrames} live frames, ${p.stills}/${p.cards} stills) | CLS ${p.clsFirstScreen}/${p.clsAfterScrolling} | preview ready ${p.previewReadyMs}ms`);
  }
} finally { await browser.close(); }
await fs.mkdir(".data/studio-qa", { recursive: true });
await fs.writeFile(`.data/studio-qa/gallery-perf-${label}.json`, JSON.stringify(report, null, 2));
