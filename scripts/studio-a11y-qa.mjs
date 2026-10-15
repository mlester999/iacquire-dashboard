// Accessibility audit with axe-core in a real browser: the client gallery, its Preview dialog, every template's home page (as a visitor sees it) and, with
// the QA credentials, the agency Template Library and the visual editor. axe-core is a QA tool, not an application dependency: point AXE_SOURCE at its
// axe.min.js.
//
//   npm run studio:qa
//   AXE_SOURCE=/path/to/axe.min.js node scripts/studio-a11y-qa.mjs
//   KEYS=luxe.maison WIDTHS=390 AXE_SOURCE=... node scripts/studio-a11y-qa.mjs
//
// Rules: WCAG 2.0/2.1 A and AA plus axe's best practices (landmarks, headings, names). A passing audit is necessary, not sufficient: it cannot judge reading
// order, focus management or what a screen reader says. The keyboard behaviours (focus return from the dialog, skip link, menu) are exercised by the other
// suites. Evidence: .data/studio-qa/a11y-results.json
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
if (!process.env.AXE_SOURCE) throw new Error("Set AXE_SOURCE to the path of axe-core's axe.min.js (a QA tool, not an application dependency).");
const axeSource = await fs.readFile(process.env.AXE_SOURCE, "utf8");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }
const WIDTHS = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);
const OUT = ".data/studio-qa";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

const rows = [];
const browser = await pw.chromium.launch({ headless: true });

async function audit(page, label, context) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async ([ctx, tags]) => {
    const r = await window.axe.run(ctx ? document.querySelector(ctx) : document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, example: v.nodes[0].target.join(" ").slice(0, 120) }));
  }, [context ?? null, TAGS]);
  rows.push({ label, violations: result });
  console.log(`${result.length ? "FLAG" : "ok  "} ${label}${result.length ? `: ${result.map((v) => `${v.id}(${v.nodes})`).join(", ")}` : ""}`);
}

async function keysOnPage() {
  const p = await browser.newPage();
  try {
    await p.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.locator("article").first().waitFor({ timeout: 60000 });
    return (await p.evaluate(() => [...document.querySelectorAll("[data-thumbnail-key]")].map((e) => e.getAttribute("data-thumbnail-key")))).sort();
  } finally { await p.close(); }
}

try {
  // The gallery and its Preview dialog.
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
    await page.goto(`${BASE}/dev/gallery-preview`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => { const b = document.querySelector('article button[aria-label^="Preview "]'); return b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 90000 });
    await page.waitForTimeout(1500);
    await audit(page, `gallery @${width}`);
    await page.locator('article button[aria-label^="Preview "]').first().click();
    await page.locator("dialog[open]").waitFor();
    await page.locator('dialog [role="status"]').waitFor({ state: "detached", timeout: 60000 });
    await audit(page, `preview dialog @${width}`, "dialog");
    await context.close();
  }

  // Every template's home page, as a visitor sees it.
  const keys = process.env.KEYS ? process.env.KEYS.split(",") : await keysOnPage();
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
    for (const key of keys) {
      try {
        await page.goto(`${BASE}/dev/frame/template?key=${encodeURIComponent(key)}`, { waitUntil: "load", timeout: 120000 });
        await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        await audit(page, `${key} @${width}`);
      } catch (error) { rows.push({ label: `${key} @${width}`, violations: [{ id: "could-not-audit", impact: "serious", help: String(error.message).split("\n")[0], nodes: 1, example: "" }] }); console.log(`FLAG ${key} @${width}: could not audit`); }
    }
    await context.close();
  }
} finally { await browser.close(); }

const flagged = rows.filter((r) => r.violations.length);
const byRule = {};
for (const r of flagged) for (const v of r.violations) { byRule[v.id] = byRule[v.id] ?? { impact: v.impact, help: v.help, views: 0, example: `${r.label}: ${v.example}` }; byRule[v.id].views++; }
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(`${OUT}/a11y-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, rules: TAGS, views: rows.length, flagged: flagged.length, byRule, rows }, null, 2));
console.log(JSON.stringify({ views: rows.length, flagged: flagged.length, rules: Object.keys(byRule), evidence: `${OUT}/a11y-results.json` }));
if (flagged.length) process.exitCode = 1;
