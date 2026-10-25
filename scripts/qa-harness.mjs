// Shared helpers for the signed-in browser QA scripts that drive the isolated QA app (scripts/inbox-qa.mjs, http://127.0.0.1:3270).
// Real Chromium through an installed Playwright (set PLAYWRIGHT_MODULE to its index.mjs when it is not found at the default path below).
// Credentials come from .data/crm-qa/inbox-credentials.local.json (local, gitignored). A password is read by this process and typed into the
// sign-in form; it is never logged. Nothing here talks to a real provider: the QA environment pins every write switch off.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3270";
export const OUT = path.join(ROOT, ".data/wave2-qa");
const DEFAULT_PLAYWRIGHT = "C:/Users/ZEPHY/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const AXE_PATH = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const NO_MOTION = "*,*::before,*::after{transition:none!important;animation:none!important}nextjs-portal{display:none!important}";

fs.mkdirSync(OUT, { recursive: true });

export async function launch({ headed = false } = {}) {
  const mod = process.env.PLAYWRIGHT_MODULE ?? DEFAULT_PLAYWRIGHT;
  const { chromium } = await import(pathToFileURL(mod).href);
  return chromium.launch({ headless: !headed });
}

function credentials(key) {
  const file = path.join(ROOT, ".data/crm-qa/inbox-credentials.local.json");
  const list = JSON.parse(fs.readFileSync(file, "utf8")).users;
  const user = (Array.isArray(list) ? list : Object.entries(list).map(([k, v]) => ({ key: k, ...v }))).find((u) => u.key === key);
  if (!user) throw new Error(`No QA credential for ${key}`);
  return user;
}

/** Collects everything a person would call broken: console errors, page errors, 5xx answers, requests that left the QA origin. */
export function watch(page, report, label, { allowOrigins = [] } = {}) {
  // allowOrigins: other loopback origins a scenario is meant to visit (the simulated PayMongo's page, http://127.0.0.1:3281). Anything else that is not the QA origin is still reported.
  const here = (u) => { try { const o = new URL(u).origin; return o === new URL(BASE).origin || allowOrigins.includes(o); } catch { return false; } };
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (401|403|404)/.test(m.text())) report.consoleErrors.push(`${label}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => report.pageErrors.push(`${label}: ${e.message.slice(0, 300)}`));
  page.on("response", (r) => { if (r.status() >= 500 && here(r.url())) report.serverErrors.push(`${label}: ${r.status()} ${r.url().slice(0, 160)}`); });
  page.on("request", (r) => { const u = r.url(); if (!here(u) && !/^(data|blob|about):/.test(u)) report.external.push(`${label}: ${u.slice(0, 160)}`); });
}

/** A context for someone who is not signed in (a customer on a public page), with the same patient timeouts. */
export async function publicPage(browser, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(150_000);
  return { context, page };
}

export const newReport = () => ({ checks: [], consoleErrors: [], pageErrors: [], serverErrors: [], external: [], notes: [], screenshots: [] });

export function check(report, label, ok, detail = "") {
  report.checks.push({ label, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  return Boolean(ok);
}

/**
 * Opens a context for one QA person and returns { context, page }. A session saved earlier (in the git-ignored .data/wave2-qa/auth, cookies of the throwaway QA app only) is reused so a
 * run does not sign in again: the app rate-limits sign-ins, and many runs in a row would be refused. It signs in through the form only when there is no usable saved session.
 */
export async function signedIn(browser, key, { viewport = { width: 1280, height: 900 }, theme = "light", reducedMotion = "reduce" } = {}) {
  const user = credentials(key);
  const authDir = path.join(OUT, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const stateFile = path.join(authDir, `${key.replace(/\W+/g, "-")}.json`);
  const make = async (storageState) => {
    const context = await browser.newContext({ viewport, reducedMotion, colorScheme: theme, ...(storageState ? { storageState } : {}) });
    await context.addInitScript((t) => { try { localStorage.setItem("iaq-theme", t); localStorage.setItem("iaq-tour-v1", "done"); } catch { /* blocked */ } }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    // The first visit to a route compiles it in the dev server, which can take well over thirty seconds after a restart.
    page.setDefaultNavigationTimeout(150_000);
    return { context, page };
  };
  if (fs.existsSync(stateFile)) {
    const saved = await make(stateFile);
    await saved.page.goto(`${BASE}/overview`, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (!new URL(saved.page.url()).pathname.startsWith("/login")) return { ...saved, user: { email: user.email, name: user.name } };
    await saved.context.close();
  }
  const { context, page } = await make(null);
  // The dev server sometimes serves a login page whose scripts never attach (a chunk rebuilt under it): reload and look again before giving up.
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    const hydrated = await page.waitForFunction(() => { const el = document.querySelector("#email"); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: attempt < 3 ? 25_000 : 120_000 }).then(() => true, () => false);
    if (hydrated) break;
    if (attempt >= 3) throw new Error("The sign-in page never hydrated after three loads.");
  }
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  const submit = page.locator("form button[type=submit]").first();
  for (let i = 0; i < 20 && (await submit.isDisabled()); i++) await page.waitForTimeout(250);
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }).catch(async () => {
    const msg = (await page.locator("[role=alert]").first().textContent().catch(() => "")) || "still on the sign-in page";
    throw new Error(`Sign-in failed for ${key}: ${msg.trim().slice(0, 160)}`);
  });
  await context.storageState({ path: stateFile });
  return { context, page, user: { email: user.email, name: user.name } };
}

/** Navigates and waits for the main landmark to hold a heading, so a streamed loading fallback is not what gets read. */
export async function open(page, route) {
  await page.goto(route.startsWith("http") ? route : `${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const m = document.querySelector("main, [role=main]"); return Boolean(m) && Boolean(m.querySelector("h1, h2")); }, null, { timeout: 90_000 }).catch(() => {});
  // A click made before React has attached its handlers is lost (the dev server hydrates late), so wait until a control in the page carries React's props.
  await page.waitForFunction(() => { const el = document.querySelector("main button, main a, main input, main textarea, main select"); return !el || Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: 60_000 }).catch(() => {});
  await page.addStyleTag({ content: NO_MOTION }).catch(() => {});
  await page.waitForTimeout(250);
}

export async function metrics(page) {
  // `overflow` is true when the document scrolls sideways OR when something inside <main> sits past the right edge of the window without being in a scroller meant for it. The second case is
  // the one a document-width check cannot see: the app shell clips sideways overflow, so a card that runs off a phone's edge still reports a document exactly as wide as the window.
  return page.evaluate(() => {
    const docOverflow = document.documentElement.scrollWidth > innerWidth + 1;
    const clipped = [];
    for (const el of document.querySelectorAll("main *")) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right <= innerWidth + 1 || r.left >= innerWidth) continue;
      let intended = false;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.position === "fixed" || /(auto|scroll)/.test(cs.overflowX) || p.getAttribute("aria-hidden") === "true" || cs.visibility === "hidden") { intended = true; break; }
      }
      if (!intended) clipped.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).split(/\s+/).slice(0, 2).join(".")} right=${Math.round(r.right)} "${(el.textContent ?? "").trim().slice(0, 24)}"`);
    }
    // A row of links or buttons (tabs, filters, chips) whose last visible item is cut in half by the edge of a scroller or a clipping box: a person sees "Eve" and nothing says there is more.
    // Tables, boards and other wide content are scrolled on purpose and are not looked at: only containers whose children are all links, buttons or tabs.
    const cut = [];
    const isTabStripScroller = innerWidth >= 1024; // On a phone or a tablet a strip that peeks past the edge is how a person knows it scrolls.
    const isItem = (c) => ["A", "BUTTON", "LABEL"].includes(c.tagName) || c.getAttribute("role") === "tab";
    for (const box of document.querySelectorAll("main nav, main [role=tablist], main ul, main div")) {
      const cs = getComputedStyle(box);
      if (cs.overflowX === "visible" || cs.display === "none") continue;
      const kids = [...box.children];
      if (!isTabStripScroller || kids.length < 3 || !kids.every(isItem)) continue;
      // A strip that draws a fade at its edges (an aria-hidden gradient beside it) is telling the person there is more; that is the design, not a cut-off.
      if (box.parentElement && [...box.parentElement.children].some((s) => s !== box && s.getAttribute("aria-hidden") === "true" && /gradient/.test(String(s.className)))) continue;
      if (box.parentElement && /gradient/.test(box.parentElement.innerHTML.slice(0, 4000)) && box.parentElement.querySelector(":scope > [aria-hidden=true][class*=gradient]")) continue;
      const b = box.getBoundingClientRect();
      if (b.width < 2) continue;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (r.width < 2) continue;
        if ((r.left < b.right - 1 && r.right > b.right + 2) || (r.right > b.left + 1 && r.left < b.left - 2)) cut.push(`${box.tagName.toLowerCase()}>"${(k.textContent ?? "").trim().slice(0, 20)}" ${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(b.left)}-${Math.round(b.right)}`);
      }
    }
    // Text clipped by a box that hides its overflow, with no ellipsis and no line clamp: it just stops mid-word.
    const hiddenCut = [];
    for (const el of document.querySelectorAll("main *")) {
      if (el.children.length > 0 || !(el.textContent ?? "").trim() || el.closest(".sr-only, [aria-hidden=true]")) continue;
      const cs = getComputedStyle(el);
      if (!/(hidden|clip)/.test(cs.overflowX) || cs.textOverflow === "ellipsis" || el.scrollWidth <= el.clientWidth + 2 || el.clientWidth < 8) continue;
      if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") continue;
      hiddenCut.push(`${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/).slice(0, 2).join(".")} "${(el.textContent ?? "").trim().slice(0, 24)}" ${el.scrollWidth}>${el.clientWidth}`);
    }
    const wide = [];
    if (docOverflow) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.right <= innerWidth + 1 || el.closest("[aria-hidden=true]")) continue;
        let inScroller = false;
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) { const o = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(o.overflowX) && a !== document.body) { inScroller = true; break; } }
        if (!inScroller) wide.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).split(/\s+/).slice(0, 2).join(".")} right=${Math.round(r.right)} "${(el.textContent ?? "").trim().slice(0, 24)}"`);
      }
    }
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: docOverflow || clipped.length > 0, docOverflow, clipped: clipped.length ? clipped.slice(0, 4) : wide.slice(0, 4), clippedCount: clipped.length, cut: cut.slice(0, 4), hiddenCut: hiddenCut.slice(0, 4), title: document.title };
  });
}

/** axe-core serious/critical violations on the current page (WCAG 2 A/AA). */
export async function axe(page) {
  await page.addScriptTag({ path: AXE_PATH }).catch(() => {});
  const result = await page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(" ").slice(0, 120) }));
  }).catch((e) => [{ id: "axe-failed", impact: "n/a", nodes: 0, target: String(e).slice(0, 100) }]);
  return result;
}

export async function shot(page, report, name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: true }).catch(() => {});
  report.screenshots.push(file);
}

export function finish(report, name) {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok);
  console.log(`\n${name}: ${report.checks.length - failed.length}/${report.checks.length} checks passed; console errors ${report.consoleErrors.length}, page errors ${report.pageErrors.length}, 5xx ${report.serverErrors.length}, external requests ${report.external.length}`);
  for (const f of failed) console.log(`  FAILED: ${f.label} ${f.detail}`);
  for (const e of [...report.pageErrors, ...report.serverErrors, ...report.consoleErrors, ...report.external].slice(0, 12)) console.log(`  ! ${e}`);
  process.exitCode = failed.length || report.pageErrors.length || report.serverErrors.length || report.external.length ? 1 : 0;
}
