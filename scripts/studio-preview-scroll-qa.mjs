// Real Chromium regression for scrolling inside the template Preview dialog (the real flow: gallery -> Preview -> framed website).
// The older matrix (studio-browser-qa.mjs) loads the frame as a top-level page, so it cannot catch a defect in the dialog itself.
//
//   npm run studio:qa                      (another terminal: the isolated local app on :3210)
//   node scripts/studio-preview-scroll-qa.mjs
//   KEYS=luxe.maison,tech.nova WIDTHS=390,1440 node scripts/studio-preview-scroll-qa.mjs     (a subset)
//
// For every template: at each preview width the website really renders at that width, a real mouse wheel reaches the footer (over the website
// AND over the empty area beside it), keys reach the footer from the dialog's own controls, switching width keeps the reader in the same
// section, all six pages scroll to their footers, and Escape closes the dialog, returns focus and releases the page's scroll lock.
// Touch gestures are exercised for a sample of templates. Evidence: .data/studio-qa/preview-scroll-results.json
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }

const VIEW = { width: 1440, height: 900 };
const DEVICES = [["Desktop", 1440], ["Landscape", 1024], ["Tablet", 768], ["Phone", 390]];
const WIDTHS = process.env.WIDTHS ? process.env.WIDTHS.split(",").map(Number) : DEVICES.map((d) => d[1]);
const ONLY = process.env.KEYS ? process.env.KEYS.split(",") : null;
const WORKERS = Number(process.env.WORKERS ?? 2);
const TOUCH_SAMPLE = new Set((process.env.TOUCH_KEYS ?? "luxe.maison,tech.nova,local.corner,care.haven").split(","));
const OUT = ".data/studio-qa";
await fs.mkdir(OUT, { recursive: true });

const retry = async (fn, tries = 4) => { let last; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; if (!/context was destroyed|navigation|Cannot read properties of null/.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 250)); } } throw last; };

async function keysOnPage() {
  const b = await pw.chromium.launch({ headless: true });
  try {
    const p = await b.newPage({ viewport: VIEW });
    await p.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.locator("article").first().waitFor({ timeout: 60000 });
    return await p.evaluate(() => [...document.querySelectorAll("[data-thumbnail-key]")].map((e) => e.getAttribute("data-thumbnail-key")));
  } finally { await b.close(); }
}

async function runTemplate(key) {
  const row = { key, devices: {}, pages: {}, notes: [], events: [] };
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: VIEW });
    const page = await context.newPage();
    page.on("crash", () => row.events.push("page crashed"));
    page.on("pageerror", (e) => row.events.push(`pageerror: ${e.message.slice(0, 120)}`));
    await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
    await page.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => { const b = document.querySelector('article button[aria-label^="Preview "]'); return b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 90000 });

    const frameOf = async () => { const h = await page.locator("dialog iframe").elementHandle(); return { h, f: await h.contentFrame() }; };
    const metrics = (f) => retry(() => f.evaluate(() => {
      const foot = document.querySelector("footer");
      const sections = [...document.querySelectorAll("main > [id], main [data-site-main] > [id]")];
      const top = sections.filter((s) => s.getBoundingClientRect().top <= 4).pop();
      return { scrollY: Math.round(scrollY), docH: document.documentElement.scrollHeight, innerH: innerHeight, innerW: innerWidth, xOverflow: document.documentElement.scrollWidth - innerWidth,
        footerBottom: foot ? Math.round(foot.getBoundingClientRect().bottom) : null, topSection: top?.id ?? null,
        broken: [...document.images].filter((i) => i.complete && !i.naturalWidth && i.currentSrc).length };
    }));
    const atFooter = (m) => m.footerBottom !== null && m.footerBottom <= m.innerH + 2;
    // A reader acts on a page that has finished loading (the preview attaches its Escape handling in the handler that then removes its "Opening website…" status), so wait for that too.
    const settle = async (f) => { await f.waitForLoadState("load", { timeout: 60000 }); await page.locator('dialog [role="status"]').waitFor({ state: "detached", timeout: 60000 }); await retry(() => f.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })); };
    const wheelUntilFooter = async (f, x, y) => {
      await page.mouse.move(x, y);
      let last;
      for (let i = 0; i < 100; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(20); last = await metrics(f); if (atFooter(last)) return { reached: true, last }; }
      return { reached: false, last };
    };

    const trigger = page.locator(`article:has([data-thumbnail-key="${key}"]) button[aria-label^="Preview "]`).first();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await page.locator("dialog[open]").waitFor({ timeout: 15000 });
    let { h, f } = await frameOf();
    await f.waitForSelector("footer", { timeout: 60000 });
    await settle(f);
    row.identity = await retry(() => f.evaluate(() => { const root = document.querySelector("[data-template-frame]"); return { key: root?.getAttribute("data-template-frame"), version: root?.getAttribute("data-template-version"), h1: document.querySelectorAll("h1").length, title: document.querySelector("h1")?.textContent?.trim().slice(0, 70) }; }));
    if (row.identity.key !== key) row.notes.push(`identity: frame shows ${row.identity.key}`);
    if (row.identity.h1 !== 1) row.notes.push(`headings: ${row.identity.h1} h1 elements`);
    row.header = await page.locator("dialog > div").first().innerText();
    if (/sample content/i.test(row.header)) row.notes.push("preview header still says 'sample content'");

    for (const [label, w] of DEVICES.filter((d) => WIDTHS.includes(d[1]))) {
      await page.locator(`dialog button[aria-label="${label} ${w}px"]`).click();
      await page.waitForTimeout(450);
      ({ h, f } = await frameOf());
      await settle(f);
      await retry(() => f.evaluate(() => window.scrollTo(0, 0)));
      const top = await metrics(f);
      const box = await h.boundingBox();
      const stage = await page.locator('dialog [aria-label="Website preview area"]').boundingBox();
      const entry = { vw: top.innerW, docH: top.docH, xOverflow: top.xOverflow };

      // 1) wheel over the website
      const over = await wheelUntilFooter(f, box.x + box.width / 2, box.y + Math.min(box.height - 10, 300));
      entry.wheelOverSite = over.reached;
      entry.broken = over.last.broken;
      // 2) wheel over the empty stage beside the website (only exists when the site is narrower than the stage)
      const margin = box.x - stage.x;
      if (margin > 60) {
        await retry(() => f.evaluate(() => window.scrollTo(0, 0)));
        const side = await wheelUntilFooter(f, stage.x + margin / 2, box.y + 300);
        entry.wheelBesideSite = side.reached;
        if (!side.reached) row.notes.push(`${w}: wheel beside the website does nothing (scrollY=${side.last.scrollY})`);
      }
      // 3) keys from the dialog's own controls (nothing inside the website focused)
      await retry(() => f.evaluate(() => window.scrollTo(0, 0)));
      await page.locator(`dialog button[aria-label="${label} ${w}px"]`).focus();
      await page.keyboard.press("PageDown"); await page.waitForTimeout(350);
      const pd = await metrics(f);
      let kbEnd = false;
      for (let i = 0; i < 3 && !kbEnd; i++) { await page.keyboard.press("End"); await page.waitForTimeout(450); kbEnd = atFooter(await metrics(f)); }
      await page.keyboard.press("Home"); await page.waitForTimeout(450);
      const home = await metrics(f);
      entry.keysFromControls = { pageDown: pd.scrollY > 100, end: kbEnd, home: home.scrollY <= 2 };
      // 4) keys with the website itself focused
      await h.focus();
      await f.waitForFunction(() => document.hasFocus(), null, { timeout: 5000 }).catch(() => {});
      let inEnd = false;
      for (let i = 0; i < 3 && !inEnd; i++) { await page.keyboard.press("End"); await page.waitForTimeout(450); inEnd = atFooter(await metrics(f)); }
      entry.keysInSite = inEnd;
      row.devices[w] = entry;
      if (!over.reached) row.notes.push(`${w}: wheel over the website never reached the footer`);
      if (top.xOverflow > 1) row.notes.push(`${w}: ${top.xOverflow}px horizontal overflow`);
      if (top.innerW !== w) row.notes.push(`${w}: website rendered at ${top.innerW}px`);
      if (!entry.keysFromControls.pageDown || !entry.keysFromControls.end || !entry.keysFromControls.home) row.notes.push(`${w}: keys from controls ${JSON.stringify(entry.keysFromControls)}`);
      if (!inEnd) row.notes.push(`${w}: End inside the website did not reach the footer`);
      if (entry.broken) row.notes.push(`${w}: ${entry.broken} broken image(s)`);
    }

    // Switching width keeps the reader in the same section
    if (WIDTHS.includes(1440) && WIDTHS.includes(390)) {
      await page.locator('dialog button[aria-label="Desktop 1440px"]').click();
      await page.waitForTimeout(450);
      ({ h, f } = await frameOf());
      await settle(f);
      await retry(() => f.evaluate(() => { const secs = [...document.querySelectorAll("main > [id], main [data-site-main] > [id]")]; const mid = secs[Math.floor(secs.length / 2)]; if (mid) window.scrollTo(0, mid.getBoundingClientRect().top + scrollY + 40); }));
      await page.waitForTimeout(250);
      const before = await metrics(f);
      // Record every correction the preview makes to the reader's position while the width changes, so a lost place can be explained, not just reported.
      await retry(() => f.evaluate(() => { const orig = window.scrollTo.bind(window); window.__corrections = []; window.scrollTo = (...a) => { window.__corrections.push(`t=${Math.round(performance.now())} to=${JSON.stringify(a[0])} docH=${document.documentElement.scrollHeight} innerW=${innerWidth} innerH=${innerHeight}`); return orig(...a); }; }));
      await page.locator('dialog button[aria-label="Phone 390px"]').click();
      let after = await metrics(f);
      const trace = [{ top: after.topSection, y: after.scrollY, docH: after.docH, innerH: after.innerH }];
      for (let i = 0; i < 30 && before.topSection && after.topSection !== before.topSection; i++) { await page.waitForTimeout(200); after = await metrics(f); trace.push({ top: after.topSection, y: after.scrollY, docH: after.docH, innerH: after.innerH }); }
      row.anchor = { before: before.topSection, beforeY: before.scrollY, after: after.topSection, ...(before.topSection !== after.topSection ? { trace: trace.slice(-6), corrections: await retry(() => f.evaluate(() => window.__corrections ?? [])) } : {}) };
      if (before.topSection && before.topSection !== after.topSection) row.notes.push(`width change lost your place: ${before.topSection} -> ${after.topSection}`);
      await page.locator('dialog button[aria-label="Desktop 1440px"]').click();
      await page.waitForTimeout(450);
    }

    // All pages
    const tabs = await page.locator('dialog nav[aria-label="Pages in this template"] button').allTextContents();
    row.tabCount = tabs.length;
    if (tabs.length !== 6) row.notes.push(`${tabs.length} page tabs, expected 6`);
    for (let i = 0; i < tabs.length; i++) {
      await page.locator('dialog nav[aria-label="Pages in this template"] button').nth(i).click();
      await page.waitForTimeout(600);
      ({ h, f } = await frameOf());
      await f.waitForSelector("footer", { timeout: 60000 });
      await settle(f);
      const m0 = await metrics(f);
      const box = await h.boundingBox();
      const { reached, last } = await wheelUntilFooter(f, box.x + box.width / 2, box.y + 300);
      row.pages[tabs[i]] = { docH: m0.docH, reached, scrollY: last.scrollY };
      if (!reached) row.notes.push(`page ${tabs[i]} not reachable`);
    }

    // Escape from inside the website, focus return, scroll lock released
    await h.focus();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    row.closed = (await page.locator("dialog[open]").count()) === 0;
    row.bodyOverflowAfter = await page.evaluate(() => document.body.style.overflow);
    row.focusReturned = await page.evaluate((k) => document.activeElement?.closest("article")?.querySelector(`[data-thumbnail-key="${k}"]`) != null, key);
    row.pageScrollsAfterClose = await page.evaluate(async () => { const y = scrollY; const room = document.documentElement.scrollHeight - innerHeight - y; scrollBy(0, room > 150 ? 120 : -120); await new Promise((r) => setTimeout(r, 60)); return scrollY !== y; });
    if (!row.closed || row.bodyOverflowAfter === "hidden" || !row.focusReturned || !row.pageScrollsAfterClose) row.notes.push(`close: closed=${row.closed} bodyOverflow=${row.bodyOverflowAfter} focusReturned=${row.focusReturned} pageScrolls=${row.pageScrollsAfterClose}`);
    // Close and reopen
    await trigger.click();
    await page.locator("dialog[open]").waitFor({ timeout: 15000 });
    ({ h, f } = await frameOf());
    await f.waitForSelector("footer", { timeout: 60000 });
    row.reopened = true;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await context.close();

    // Touch: a real swipe gesture inside the website
    if (TOUCH_SAMPLE.has(key)) {
      const touchCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
      const tp = await touchCtx.newPage();
      await tp.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
      await tp.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await tp.waitForFunction(() => { const b = document.querySelector('article button[aria-label^="Preview "]'); return b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 90000 });
      await tp.locator(`article:has([data-thumbnail-key="${key}"]) button[aria-label^="Preview "]`).first().click();
      await tp.locator("dialog[open]").waitFor({ timeout: 15000 });
      const th = await tp.locator("dialog iframe").elementHandle();
      const tf = await th.contentFrame();
      await tf.waitForSelector("footer", { timeout: 60000 });
      await tf.waitForLoadState("load", { timeout: 60000 });
      await tp.waitForTimeout(500);
      const cdp = await touchCtx.newCDPSession(tp);
      const tbox = await th.boundingBox();
      const px = Math.round(tbox.x + tbox.width / 2), py = Math.round(tbox.y + tbox.height * 0.7);
      const before = await tf.evaluate(() => Math.round(scrollY));
      // A real finger drag: start, a run of moves, end. (Input.synthesizeScrollGesture is not honoured by headless Chromium.)
      const point = (y) => [{ x: px, y, id: 1 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(py) });
      for (let i = 1; i <= 12; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(py - i * 25) }); await tp.waitForTimeout(16); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await tp.waitForTimeout(700);
      const after = await tf.evaluate(() => Math.round(scrollY));
      row.touch = { before, after, viewport: await tf.evaluate(() => innerWidth) };
      if (after <= before + 150) row.notes.push(`touch swipe did not scroll (scrollY ${before} -> ${after})`);
      await touchCtx.close();
    }
  } catch (e) {
    row.error = String(e.message ?? e).split("\n")[0];
    row.notes.push(`ERROR ${row.error}`);
  } finally { await browser.close().catch(() => {}); }
  console.log(row.notes.length ? "FAIL" : "ok  ", key, row.notes.join(" | "), row.events.length ? `[${row.events.join("; ")}]` : "");
  return row;
}

const keys = ONLY ?? await keysOnPage();
console.log(`Preview scroll QA: ${keys.length} templates x widths ${WIDTHS.join("/")} (${WORKERS} workers) against ${BASE}`);
const queue = [...keys];
const rows = [];
await Promise.all(Array.from({ length: WORKERS }, async () => { let k; while ((k = queue.shift())) rows.push(await runTemplate(k)); }));
rows.sort((a, b) => a.key.localeCompare(b.key));
const failing = rows.filter((r) => r.notes.length);
await fs.writeFile(`${OUT}/preview-scroll-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, widths: WIDTHS, templates: rows.length, failing: failing.length, rows }, null, 2));
console.log(JSON.stringify({ templates: rows.length, failing: failing.length, evidence: `${OUT}/preview-scroll-results.json` }));
if (failing.length) process.exitCode = 1;
