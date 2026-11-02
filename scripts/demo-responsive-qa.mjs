// Responsive QA for the prospect demo showroom (and any other public page): drives a real headless Chromium over the DevTools protocol, at every width the release is checked at, in
// portrait and landscape, light and dark, and measures what a person would see: horizontal overflow, text that overlaps text, clipped text, touch targets, what the floating AQi
// launcher or the bottom bar covers at each scroll position, and whether the last thing on a page can be reached. It reads only; it clicks nothing but the AQi launcher on request.
//
//   node scripts/demo-responsive-qa.mjs --base http://localhost:3101 --path /dev/showroom-preview --views overview,workforce --themes light,dark --out .data/qa-demo
//   options: --only-landscape  --eval "<page expression>" (printed per scenario, for debugging)  --widths 320,360,...  --landscape  --shots  --full (whole-page screenshots)  --state ended|ai_off|exhausted  --business "A very long business name"  --extra "aqi=open&confirm=buy"  --chrome <path>
//
// Chromium comes from Playwright's cache when it is installed there (no npm package is needed): set CHROME_PATH to use another build. The page must be one that does not need a
// sign-in, such as /dev/showroom-preview (development only). Exit code 1 when any scenario has a failure (warnings do not fail the run).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const BASE = String(opt("base", "http://localhost:3101")).replace(/\/$/, "");
// (Git Bash rewrites an argument that starts with "/" into a Windows path: write it as dev/showroom-preview, or set MSYS_NO_PATHCONV=1. Either way it is read as a path on the site.)
const PAGE_PATH = "/" + String(opt("path", "dev/showroom-preview")).replace(/^[A-Za-z]:[\/]Program Files[\/]Git[\/]/, "").replace(/^\/+/, "");
const VIEWS = String(opt("views", "overview")).split(",").filter(Boolean);
const THEMES = String(opt("themes", "light")).split(",").filter(Boolean);
const OUT = String(opt("out", path.join(os.tmpdir(), "demo-qa")));
const SHOTS = Boolean(opt("shots", false));
const FULL = Boolean(opt("full", false));
const EVAL = typeof opt("eval", false) === "string" ? String(opt("eval")) : "";
const ONLY_LANDSCAPE = Boolean(opt("only-landscape", false));
const LANDSCAPE = Boolean(opt("landscape", false)) || ONLY_LANDSCAPE;
const EXTRA = String(opt("extra", ""));
// --axe runs axe-core (WCAG 2.2 A and AA rules) on every page too: serious and critical findings fail the scenario, moderate ones are warnings. axe-core is read from node_modules.
const AXE = Boolean(opt("axe", false));
const AXE_SOURCE = AXE ? fs.readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8") : "";
const STATE = opt("state", "");
const BUSINESS = opt("business", "");
const WIDTHS = String(opt("widths", "320,360,375,390,414,430,768,820,1024,1280,1440")).split(",").map(Number).filter(Boolean);

// Portrait heights per width (a typical device of that width), and the landscape pair for the phones and tablets.
const HEIGHT = { 320: 568, 360: 740, 375: 812, 390: 844, 414: 896, 430: 932, 768: 1024, 820: 1180, 1024: 768, 1280: 800, 1440: 900 };
const LANDSCAPE_SIZES = [[568, 320], [667, 375], [740, 360], [844, 390], [932, 430], [1024, 768], [1180, 820]];

const CHROME = process.env.CHROME_PATH
  || (typeof opt("chrome", undefined) === "string" ? opt("chrome") : null)
  || path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium_headless_shell-1243", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
if (!fs.existsSync(CHROME)) {
  console.error(`Chromium not found at ${CHROME}. Set CHROME_PATH.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The measurement that runs inside the page. It returns plain data.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const AUDIT = String.raw`
(async () => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const de = document.documentElement;
  const hit = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 0 && h > 0 ? w * h : 0; };
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cs = (el) => getComputedStyle(el);
  const clippedAway = (el) => {
    const r = el.getBoundingClientRect();
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = cs(p);
      if (Number(s.opacity) < 0.05 || s.contentVisibility === 'hidden') return true;
      // Content a box hides (overflow hidden or clipped) or has scrolled out of its window is not on the screen now.
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY)) { const b = p.getBoundingClientRect(); if (hit(r, b) < 1) return true; }
    }
    return false;
  };
  // The part of a rectangle a person can see: what the boxes that hide or scroll their content leave of it (null when nothing).
  const clipTo = (el, r) => {
    let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const s = cs(p);
      if (s.display === 'inline' || !/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY)) continue;
      const b = p.getBoundingClientRect();
      box = { left: Math.max(box.left, b.left), right: Math.min(box.right, b.right), top: Math.max(box.top, b.top), bottom: Math.min(box.bottom, b.bottom) };
      if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
    }
    return { ...box, width: box.right - box.left, height: box.bottom - box.top };
  };
  const visible = (el) => { const s = cs(el); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !clippedAway(el); };
  // Answers inside a question that is not open are not on the screen, whatever their boxes say.
  const hidden = (el) => !!el.closest('[inert],[aria-hidden="true"],.sr-only,[hidden],script,style,noscript') || (!!el.closest('details:not([open])') && !el.closest('summary'));
  const fixedAncestor = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (cs(p).position === 'fixed') return p; return null; };
  const label = (el) => { const id = el.id ? '#' + el.id : ''; const c = typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''; return el.tagName.toLowerCase() + id + (id ? '' : c); };
  const words = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36);
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = cs(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };

  const out = { vw, vh, failures: [], warnings: [] };
  const fail = (kind, detail) => out.failures.push({ kind, ...detail });
  const warn = (kind, detail) => out.warnings.push({ kind, ...detail });

  window.scrollTo(0, 0);
  await frame();

  // 1. Horizontal overflow of the page.
  out.scrollWidth = Math.max(de.scrollWidth, document.body.scrollWidth);
  if (out.scrollWidth > vw + 1) fail('page-overflow-x', { scrollWidth: out.scrollWidth, vw });
  const all = [...document.querySelectorAll('body *')].filter((el) => visible(el) && !hidden(el));
  const past = all.filter((el) => { const r = el.getBoundingClientRect(); return (r.right > vw + 1 || r.left < -1) && !fixedAncestor(el) && !inScroller(el); });
  // Report only the outermost offenders.
  const outer = past.filter((el) => !past.some((o) => o !== el && o.contains(el))).slice(0, 8);
  for (const el of outer) fail('past-viewport', { el: label(el), text: words(el), right: Math.round(el.getBoundingClientRect().right), left: Math.round(el.getBoundingClientRect().left) });

  // 2. Text drawn over other text (flow content only; fixed layers are checked on their own below).
  const leaves = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || hidden(el) || !visible(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const lh = parseFloat(cs(el).lineHeight);
    for (const raw of range.getClientRects()) {
      if (raw.width <= 1 || raw.height <= 1) continue;
      let r = raw;
      if (Number.isFinite(lh) && lh > 0 && lh < raw.height - 1) { const top = raw.top + (raw.height - lh) / 2; r = { left: raw.left, right: raw.right, top, bottom: top + lh, width: raw.width, height: lh }; }
      const seen = clipTo(el, r);
      if (seen) leaves.push({ el, r: seen, text: n.nodeValue.trim().slice(0, 28), fixed: !!fixedAncestor(el) });
    }
  }
  const flow = leaves.filter((l) => !l.fixed);
  const seen = new Set();
  for (let i = 0; i < flow.length; i++) {
    for (let j = i + 1; j < flow.length; j++) {
      const a = flow[i], b = flow[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const area = hit(a.r, b.r);
      if (area < 6) continue;
      const small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (area / small < 0.2) continue;
      const key = a.text + '|' + b.text;
      if (seen.has(key)) continue;
      seen.add(key);
      fail('text-overlap', { a: a.text, b: b.text, areaPx: Math.round(area) });
      if (seen.size >= 12) break;
    }
    if (seen.size >= 12) break;
  }

  // 3. Clipped text: a box that hides its own overflow while its words are wider than it (a deliberate one-line truncation is a warning, not a failure). Words that are faded out or not
  //    displayed (the labels of a folded navigation rail) are not on the screen, so what they spill is not judged.
  const spillsVisibly = (el) => {
    const box = el.getBoundingClientRect();
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode;
      if (!n.nodeValue.trim() || !n.parentElement) continue;
      let gone = false;
      for (let q = n.parentElement; q; q = q.parentElement) {
        const qs = cs(q);
        if (qs.display === 'none' || qs.visibility === 'hidden' || Number(qs.opacity) === 0) { gone = true; break; }
        if (q === el) break;
      }
      if (gone) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1 && (r.right > box.right + 1 || r.left < box.left - 1)) return true;
    }
    return false;
  };
  for (const el of all) {
    if (el.closest('svg')) continue;
    const s = cs(el);
    if (!(/(hidden|clip)/.test(s.overflowX)) || el.scrollWidth <= el.clientWidth + 1 || !el.textContent.trim() || !spillsVisibly(el)) continue;
    const truncated = s.textOverflow === 'ellipsis' || el.className.toString().includes('truncate') || el.className.toString().includes('line-clamp');
    (truncated ? warn : fail)(truncated ? 'truncated-text' : 'clipped-text', { el: label(el), text: words(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }

  // 4. Touch targets. Below 24px is a failure (WCAG 2.2 AA); below 44px is a warning on touch-sized screens. Links inside a sentence are exempt.
  const interactive = all.filter((el) => el.matches('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab]'));
  for (const el of interactive) {
    const r = (el.matches('input[type=checkbox],input[type=radio]') && el.closest('label') ? el.closest('label') : el).getBoundingClientRect();
    if (r.bottom < 0 || r.top > document.documentElement.scrollHeight) continue;
    if (el.matches('a,button') && el.parentElement && /^(P|LI|SPAN|STRONG|EM|DD|DT)$/.test(el.parentElement.tagName) && /^inline/.test(cs(el).display)) continue;
    const min = Math.min(r.width, r.height);
    if (min < 24) fail('tiny-target', { el: label(el), text: words(el), w: Math.round(r.width), h: Math.round(r.height) });
    else if (vw < 1024 && min < 44) warn('small-target', { el: label(el), text: words(el), w: Math.round(r.width), h: Math.round(r.height) });
  }

  // 5. The business hub: every employee a real, visible, non-overlapping button with a visible name.
  // A modal that is open (the AQi sheet, a confirmation) makes the page behind it inert: its hub is not on offer to anyone until the modal closes, so it is not judged then.
  const hub = document.querySelector('[data-business-hub]');
  if (hub && visible(hub) && !hub.closest('[inert],[aria-hidden="true"]')) {
    const hr = hub.getBoundingClientRect();
    const buttons = [...hub.querySelectorAll('button,a')].filter((b) => visible(b) && !hidden(b));
    out.hub = { buttons: buttons.length, w: Math.round(hr.width), h: Math.round(hr.height), layout: hub.getAttribute('data-business-hub') };
    if (buttons.length !== 6) fail('hub-missing-role', { found: buttons.length });
    for (let i = 0; i < buttons.length; i++) {
      const a = buttons[i].getBoundingClientRect();
      if (a.left < hr.left - 1 || a.right > hr.right + 1 || a.right > vw + 1 || a.left < -1) fail('hub-outside', { el: words(buttons[i]) });
      const name = buttons[i].querySelector('[data-role-name]') || buttons[i];
      if (!visible(name) || !words(name)) fail('hub-no-name', { el: buttons[i].getAttribute('aria-label') });
      for (let j = i + 1; j < buttons.length; j++) if (hit(a, buttons[j].getBoundingClientRect()) > 4) fail('hub-overlap', { a: words(buttons[i]), b: words(buttons[j]) });
    }
    const centre = hub.querySelector('[data-hub-centre]');
    if (centre && visible(centre)) {
      const c = centre.getBoundingClientRect();
      for (const b of buttons) if (hit(c, b.getBoundingClientRect()) > 4) fail('hub-centre-overlap', { with: words(b) });
      if (centre.scrollHeight > centre.clientHeight + 1 && cs(centre).overflowY !== 'visible') fail('hub-centre-clipped', { text: words(centre) });
    }
  }

  // 6. What floats over the page. At rest (top) and at the very end, nothing essential may sit under a fixed layer, and the end of the page must clear it.
  // The open AQi panel on a tablet or laptop floats over the corner by design (the visitor opened it, and the page still scrolls beneath it); what it must never do is cover a fixed consultation action.
  const panel = document.querySelector('#showroom-chat[data-open="true"]');
  const panelFloats = !!panel && visible(panel) && panel.getAttribute('aria-modal') !== 'true';
  const fixedEls = [...document.querySelectorAll('body *')].filter((el) => cs(el).position === 'fixed' && visible(el) && !hidden(el) && !el.matches('[data-overlay-backdrop]') && !(panelFloats && el === panel) && el.getBoundingClientRect().height < vh * 0.9);
  out.fixed = fixedEls.map((el) => { const r = el.getBoundingClientRect(); return { el: label(el), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
  const launcher = document.querySelector('#aqi-launcher');
  if (launcher && visible(launcher)) {
    const r = launcher.getBoundingClientRect();
    out.launcher = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), floating: cs(launcher).position === 'fixed' && !launcher.parentElement.closest('[data-dock-bar]'), inBar: !!launcher.closest('[data-dock-bar]') };
    if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1) fail('launcher-offscreen', { x: r.left, y: r.top });
  }
  const max = Math.max(0, de.scrollHeight - vh);
  const stops = [0, max];
  const covered = [];
  for (const y of stops) {
    window.scrollTo(0, y);
    await frame();
    const layers = fixedEls.filter((el) => visible(el)).map((el) => ({ el, r: el.getBoundingClientRect() }));
    const items = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,h1,h2,h3,p,li,dd,dt,label')].filter((el) => visible(el) && !hidden(el) && !fixedAncestor(el));
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      for (const layer of layers) {
        if (it.contains(layer.el) || layer.el.contains(it)) continue;
        // A bar along the bottom edge: what is under it at rest is simply below the fold. It matters at the very end of the page, where the last thing must clear it.
        if (layer.r.width >= vw * 0.9 && layer.r.bottom >= vh - 2 && y === 0) continue;
        const a = hit(r, layer.r);
        // Covered when most of the thing's visible part is under the layer. Rows that merely scroll beneath the bar at a middle position are not checked.
        const shown = Math.max(1, (Math.min(r.bottom, vh) - Math.max(r.top, 0)) * (Math.min(r.right, vw) - Math.max(r.left, 0)));
        if (a / shown > 0.35 && (it.matches('a,button,input,select,textarea,summary') || y === max)) covered.push({ at: y === 0 ? 'top' : 'end', under: layer.el.id ? '#' + layer.el.id : label(layer.el), item: label(it), text: words(it), share: Number((a / shown).toFixed(2)) });
      }
    }
  }
  for (const c of covered.slice(0, 10)) fail('covered-by-fixed', c);
  if (panelFloats) {
    const pr = panel.getBoundingClientRect();
    for (const el of document.querySelectorAll('a[href],button')) {
      if (panel.contains(el) || !visible(el) || hidden(el) || !fixedAncestor(el) || !/consult/i.test(el.textContent || '')) continue;
      if (hit(el.getBoundingClientRect(), pr) > 4) fail('panel-covers-consult', { text: words(el) });
    }
  }
  window.scrollTo(0, 0);
  await frame();

  // 7. A dialog or sheet that is open must sit inside the screen and keep focus.
  const dlg = document.querySelector('[role="dialog"][data-state="open"],[role="dialog"]:not([aria-hidden="true"])');
  if (dlg && visible(dlg) && !hidden(dlg)) {
    const r = dlg.getBoundingClientRect();
    out.dialog = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    if (r.right > vw + 1 || r.left < -1) fail('dialog-past-viewport', { left: r.left, right: r.right });
    if (r.height > vh + 1 && !/(auto|scroll)/.test(cs(dlg).overflowY) && ![...dlg.querySelectorAll('*')].some((n) => /(auto|scroll)/.test(cs(n).overflowY))) fail('dialog-cannot-scroll', { h: r.height, vh });
    if (!dlg.contains(document.activeElement)) warn('dialog-focus', { active: label(document.activeElement || document.body) });
  }
  const sheet = document.querySelector('#showroom-chat');
  if (sheet && visible(sheet) && !hidden(sheet)) {
    const r = sheet.getBoundingClientRect();
    out.sheet = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), modal: sheet.getAttribute('aria-modal') === 'true' };
    if (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1) fail('sheet-outside', { x: r.left, y: r.top, right: r.right, bottom: r.bottom, vw, vh });
    const composer = sheet.querySelector('textarea');
    if (composer) { const c = composer.getBoundingClientRect(); const shown = clipTo(composer, c); if (c.bottom > vh + 1 || c.top < 0 || !shown || shown.height < c.height - 2) fail('composer-offscreen', { top: c.top, bottom: c.bottom, shown: shown ? Math.round(shown.height) : 0, of: Math.round(c.height) }); }
  }
  return out;
})()
`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A tiny DevTools-protocol client (Node 24's WebSocket).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const PORT = 9300 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "demo-qa-chrome-"));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--no-sandbox", "--disable-gpu", "--force-prefers-reduced-motion", "--hide-scrollbars", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const shutdown = () => {
  try { chrome.kill(); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("exit", shutdown);

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

await until(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 20000, "Chromium");
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("DevTools socket failed")); });
let nextId = 1;
const pending = new Map();
const waiters = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) rej(new Error(msg.error.message)); else res(msg.result); }
  else if (msg.method) for (const w of waiters.splice(0)) w(msg);
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const event = (name, ms = 30000) => new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error(`no ${name}`)), ms);
  const on = (msg) => { if (msg.method === name) { clearTimeout(timer); res(msg); } else waiters.push(on); };
  waiters.push(on);
});

await send("Page.enable");
await send("Runtime.enable");

let themeScript = null;
async function visit(url, width, height, theme) {
  // The product's own theme choice is a stored preference (iaq-theme): set it before the page's scripts run, so a dark run is really dark whatever the page.
  if (themeScript) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: themeScript });
  themeScript = (await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem('iaq-theme','${theme}')}catch(e){}` })).identifier;
  // Not "mobile" emulation on purpose: a mobile viewport silently widens itself to fit wide content, which would hide the very overflow this run is looking for.
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
  await send("Emulation.setTouchEmulationEnabled", { enabled: width < 900 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  const loaded = event("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  // Hydration, the rail's first paint and the countdown's first tick.
  await new Promise((r) => setTimeout(r, 1400));
}
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "page script failed");
  return r.result.value;
};
async function shot(file) {
  let params = { format: "png" };
  if (FULL) {
    const { contentSize } = await send("Page.getLayoutMetrics");
    params = { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.min(Math.ceil(contentSize.height), 6000), scale: 1 } };
  }
  const { data } = await send("Page.captureScreenshot", params);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}

fs.mkdirSync(OUT, { recursive: true });
const sizes = [...(ONLY_LANDSCAPE ? [] : WIDTHS.map((w) => [w, HEIGHT[w] ?? Math.round(w * 1.8), "portrait"])), ...(LANDSCAPE ? LANDSCAPE_SIZES.map(([w, h]) => [w, h, "landscape"]) : [])];
const report = [];
let failed = 0;
for (const view of VIEWS) {
  for (const theme of THEMES) {
    for (const [w, h, orient] of sizes) {
      const q = new URLSearchParams({ view, theme });
      if (STATE) q.set("state", String(STATE));
      if (BUSINESS) q.set("business", String(BUSINESS));
      const url = `${BASE}${PAGE_PATH}?${q.toString()}${EXTRA ? `&${EXTRA}` : ""}`;
      let result;
      try {
        await visit(url, w, h, theme);
        result = await evaluate(AUDIT);
        if (AXE) {
          await evaluate(AXE_SOURCE);
          const found = await evaluate("axe.run({ exclude: [['nextjs-portal']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] }).then((r) => r.violations.map((v) => ({ rule: v.id, impact: v.impact, nodes: v.nodes.length, target: String(v.nodes[0].target).slice(0, 140), html: String(v.nodes[0].html).slice(0, 240), summary: String(v.nodes[0].failureSummary || '').slice(0, 300), help: v.help })))");
          for (const v of found) (v.impact === 'critical' || v.impact === 'serious' ? result.failures : result.warnings).push({ kind: 'axe-' + v.rule, ...v });
        }
        if (EVAL) console.log(`   eval ${w}x${h}:`, JSON.stringify(await evaluate(EVAL)));
        if (SHOTS) await shot(path.join(OUT, `${view}-${theme}-${w}x${h}-${orient}.png`));
      } catch (e) {
        result = { vw: w, vh: h, failures: [{ kind: "script-error", message: String(e.message || e) }], warnings: [] };
      }
      const row = { view, theme, width: w, height: h, orient, ...result };
      report.push(row);
      if (result.failures.length) failed++;
      const kinds = [...new Set(result.failures.map((f) => f.kind))];
      console.log(`${result.failures.length ? "FAIL" : "ok  "} ${view.padEnd(9)} ${theme.padEnd(5)} ${String(w).padStart(4)}x${String(h).padEnd(4)} ${orient.padEnd(9)} ${kinds.length ? kinds.join(", ") : ""}${result.warnings.length ? `  (${result.warnings.length} warnings)` : ""}`);
    }
  }
}
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
console.log(`\n${report.length} scenarios, ${failed} with failures. Report: ${path.join(OUT, "report.json")}`);
ws.close();
shutdown();
process.exit(failed ? 1 : 0);
