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
export function watch(page, report, label) {
  const here = (u) => { try { return new URL(u).origin === new URL(BASE).origin; } catch { return false; } };
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (401|403|404)/.test(m.text())) report.consoleErrors.push(`${label}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => report.pageErrors.push(`${label}: ${e.message.slice(0, 300)}`));
  page.on("response", (r) => { if (r.status() >= 500 && here(r.url())) report.serverErrors.push(`${label}: ${r.status()} ${r.url().slice(0, 160)}`); });
  page.on("request", (r) => { const u = r.url(); if (!here(u) && !/^(data|blob|about):/.test(u)) report.external.push(`${label}: ${u.slice(0, 160)}`); });
}

export const newReport = () => ({ checks: [], consoleErrors: [], pageErrors: [], serverErrors: [], external: [], notes: [], screenshots: [] });

export function check(report, label, ok, detail = "") {
  report.checks.push({ label, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  return Boolean(ok);
}

/** Opens a context for one QA person, signs in, and returns { context, page }. Saves nothing to disk. */
export async function signedIn(browser, key, { viewport = { width: 1280, height: 900 }, theme = "light", reducedMotion = "reduce" } = {}) {
  const user = credentials(key);
  const context = await browser.newContext({ viewport, reducedMotion, colorScheme: theme });
  await context.addInitScript((t) => { try { localStorage.setItem("iaq-theme", t); localStorage.setItem("iaq-tour-v1", "done"); } catch { /* blocked */ } }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const el = document.querySelector("#email"); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: 120_000 });
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  const submit = page.locator("form button[type=submit]").first();
  for (let i = 0; i < 20 && (await submit.isDisabled()); i++) await page.waitForTimeout(250);
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 });
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
  return page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1, title: document.title }));
}

/** axe-core serious/critical violations on the current page (WCAG 2 A/AA). */
export async function axe(page) {
  await page.addScriptTag({ path: AXE_PATH }).catch(() => {});
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
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
