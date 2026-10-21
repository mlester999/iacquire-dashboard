// Signed-in browser QA of Automation Studio against the isolated local app (scripts/automation-qa.mjs on AUTOMATION_QA_URL, seeded by
// scripts/run-automation-qa-seed.mjs) in real Chromium. The model is the labelled scripted stand-in (scripts/mock-automation-llm.mjs): what is exercised is
// the real product path around it (validation, saving, streaming, the canvas replay, undo, publishing), not model quality.
//
//   node scripts/automation-browser-qa.mjs [--headed]
//
// Playwright is not a project dependency: it defaults to the copy the Native CRM QA installed (.data/crm-qa/browser-runner), or set PLAYWRIGHT_MODULE.
// People sign in through the real local sign-in page with the fictional QA accounts in .data/automation-qa/credentials.local.json; passwords are read by
// this script only and never printed. The browser talks to the QA server only: any other origin is blocked and counted.
// Output: .data/automation-qa/report.json and .data/automation-qa/screens/*.png. Exit code 1 when any check failed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AUTOMATION_QA_DATA_DIR, AUTOMATION_QA_URL } from "./automation-qa-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, AUTOMATION_QA_DATA_DIR);
const SCREENS = path.join(DATA, "screens");
const AXE = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const BASE = AUTOMATION_QA_URL;
const headed = process.argv.includes("--headed");
fs.mkdirSync(SCREENS, { recursive: true });

const pwEntry = process.env.PLAYWRIGHT_MODULE ?? path.join(ROOT, ".data/crm-qa/browser-runner/node_modules/playwright/index.mjs");
const pw = await import(pathToFileURL(pwEntry).href);
const creds = JSON.parse(fs.readFileSync(path.join(DATA, "credentials.local.json"), "utf8"));

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [], axe: [], timeline: {}, errors: { console: [], page: [], failedRequests: [], serverErrors: [], blockedExternal: [] } };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${String(detail).slice(0, 300)}` : ""}`);
};
const isLocal = (u) => { try { return new URL(u).host === new URL(BASE).host; } catch { return false; } };

const browser = await pw.chromium.launch({ headless: !headed });
const lastPages = [];

async function person(role, { width = 1280, height = 800, theme = "light" } = {}) {
  const user = creds.users[role];
  const context = await browser.newContext({ baseURL: BASE, viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "no-preference", locale: "en-US", timezoneId: "America/Chicago" });
  // A dev server compiles each route the first time it is visited, which can take minutes on a cold build.
  context.setDefaultNavigationTimeout(300_000);
  context.setDefaultTimeout(120_000);
  await context.route((url) => !isLocal(url.href), (route) => { report.errors.blockedExternal.push(route.request().url()); return route.abort("blockedbyclient").catch(() => {}); });
  await context.routeWebSocket((url) => !isLocal(url.href), (ws) => { report.errors.blockedExternal.push(ws.url()); ws.close(); });
  // The dev server's own hot-reload socket (same host) is left alone: the page does not finish hydrating without it. Do not edit source while this runs.
  await context.addInitScript((t) => {
    try { localStorage.setItem("iaq-tour-v1", "done"); localStorage.setItem("iaq-theme", t); } catch { /* storage blocked */ }
    // A timeline of what the canvas shows, so "it grew step by step" is a measurement and not a screenshot.
    window.__canvasTimeline = [];
    let last = "";
    setInterval(() => {
      const nodes = document.querySelectorAll(".react-flow__node").length;
      const edges = document.querySelectorAll(".react-flow__edge").length;
      const key = `${nodes}/${edges}`;
      if (key !== last) { last = key; window.__canvasTimeline.push({ t: Math.round(performance.now()), nodes, edges }); }
    }, 40);
  }, theme);
  const page = await context.newPage();
  lastPages.length = 0;
  lastPages.push(page);
  page.on("console", (m) => { if (m.type() === "error") report.errors.console.push(`${role}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => report.errors.page.push(`${role}: ${page.url().replace(BASE, "")} ${(e.message || String(e)).slice(0, 2500)}`));
  page.on("requestfailed", (r) => { const f = r.failure()?.errorText ?? ""; if (isLocal(r.url()) && !/ERR_ABORTED/.test(f)) report.errors.failedRequests.push(`${role}: ${r.url().replace(BASE, "")} ${f}`); });
  page.on("response", (r) => { if (r.status() >= 500) report.errors.serverErrors.push(`${role}: ${r.status()} ${r.url().replace(BASE, "")}`); });

  // A development server that is still compiling can leave a page without its scripts: load it again rather than wait on it.
  for (let attempt = 1; ; attempt++) {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const ok = await page.waitForFunction(() => { const el = document.querySelector("#email"); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: attempt < 4 ? 60_000 : 240_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 4) throw new Error("The sign-in page never became interactive.");
  }
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  const submit = page.locator("form button[type=submit]").first();
  await submit.waitFor({ state: "visible" });
  for (let i = 0; i < 20 && !(await submit.isEnabled()); i++) await page.waitForTimeout(150);
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 });
  return { context, page };
}

async function runAxe(page, label) {
  try {
    await page.addScriptTag({ path: AXE });
    const res = await page.evaluate(async () => {
      const r = await axe.run(document, { runOnly: ["wcag2a", "wcag2aa"], resultTypes: ["violations"] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(" ").slice(0, 160) }));
    });
    report.axe.push({ label, violations: res });
    check(`axe: ${label}`, res.length === 0, res.map((v) => `${v.id}(${v.nodes}) ${v.target}`).join("; "));
  } catch (e) {
    check(`axe: ${label}`, false, e.message);
  }
}
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(SCREENS, `${name}.png`), ...opts });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nodes = (page) => page.locator(".react-flow__node").count();
/** The page is server-rendered first; a click before React has attached to it is lost, as for any person who is quicker than the page. */
const hydrated = (page, selector) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, selector, { timeout: 300_000 });

async function main() {
  // ------------------------------------------------------------------ Brightside owner: the plan is active
  const owner = await person("owner");
  const page = owner.page;
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 180_000 });
  const nav = page.getByRole("link", { name: /Automation Studio/ }).first();
  check("nav: Automation Studio entry is present for the owner", await nav.count());
  check("nav: no lock when the plan is active", !/Needs the Automation Studio plan/.test((await nav.textContent()) ?? ""));
  const box = page.locator("#studio-prompt");
  // The heading is server-rendered; typing before React has attached would be lost, as for any person who types instantly.
  await page.waitForFunction(() => { const el = document.querySelector("#studio-prompt"); return el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: 300_000 });
  check("home: prompt box is enabled (the model connection resolved)", await box.isEnabled());
  check("home: four suggestion chips", (await page.getByRole("group", { name: "Ideas to start from" }).locator("button").count()) === 4);
  check("home: all 17 ideas, each with readiness text", (await page.locator("#studio-ideas").locator("xpath=ancestor::section").locator("ul > li").count()) === 17);
  await page.locator("#studio-search").fill("review");
  check("home: searching narrows the ideas", (await page.locator("#studio-ideas").locator("xpath=ancestor::section").locator("ul > li").count()) < 16);
  await page.locator("#studio-search").fill("");
  await page.getByRole("button", { name: "Leads", exact: true }).click();
  check("home: a category filters the ideas", (await page.locator("#studio-ideas").locator("xpath=ancestor::section").locator("ul > li").count()) === 5);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "01-home-desktop-light");
  await runAxe(page, "home (desktop, light)");

  // A chip fills the box with its words; the person can edit them before building.
  await page.getByRole("group", { name: "Ideas to start from" }).locator("button").first().click();
  check("home: a suggestion fills the box", ((await box.inputValue()) ?? "").length > 20);
  await box.fill("When a new lead comes in, welcome them, and if they haven't replied after two days remind my team to call them.");

  // ------------------------------------------------------------------ Build: chat on the left, canvas on the right, growing step by step
  await page.getByRole("button", { name: /Build it/ }).click();
  await page.waitForURL(/\/automation-studio\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  const workflowUrl = page.url();
  check("build: opens the workflow's own page", true, workflowUrl.replace(BASE, ""));
  await page.locator("[data-studio-workspace]").waitFor({ timeout: 180_000 });
  await hydrated(page, "[data-studio-workspace]");
  await page.locator(".react-flow").waitFor({ timeout: 60_000 });
  let sawMid = false;
  const t0 = Date.now();
  for (;;) {
    const n = await nodes(page);
    if (!sawMid && n >= 3 && n < 6) { sawMid = true; await shot(page, "02-build-midway"); }
    if (n >= 6 || Date.now() - t0 > 90_000) break;
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1500);
  check("build: the canvas shows the trigger and five steps", (await nodes(page)) === 6, `nodes=${await nodes(page)}`);
  const timeline = await page.evaluate(() => window.__canvasTimeline);
  report.timeline.build = timeline;
  const counts = [...new Set(timeline.map((x) => x.nodes))];
  check("build: nodes appeared one after another, not all at once", counts.filter((c) => c > 0).length >= 4, `distinct counts: ${counts.join(",")}`);
  check("build: connections were drawn", timeline.at(-1)?.edges >= 5, `edges=${timeline.at(-1)?.edges}`);
  const chatText = await page.locator("[data-role=assistant]").allTextContents();
  check("build: the builder's reply is in the chat", chatText.some((t) => /new lead gets a welcome task/i.test(t)), chatText.join(" | "));
  check("build: the person's own words are in the chat", (await page.locator("[data-role=user]").allTextContents()).some((t) => /welcome them/.test(t)));
  await page.waitForFunction(() => document.querySelector("[data-save-state]")?.getAttribute("data-save-state") === "saved", null, { timeout: 30_000 }).catch(() => {});
  const fit = await page.evaluate(() => {
    const s = document.querySelector("section[aria-label='AI Automation Builder']");
    const p = s?.parentElement;
    return s && p ? { section: Math.round(s.getBoundingClientRect().width), column: Math.round(p.getBoundingClientRect().width), scrollY: window.scrollY } : null;
  });
  check("layout: the chat fits its column (nothing is cut off)", fit && fit.section <= fit.column + 1, JSON.stringify(fit));
  check("layout: opening the workspace does not scroll the page", fit && fit.scrollY === 0, JSON.stringify(fit));
  await shot(page, "03-build-done-desktop-light");
  await runAxe(page, "workspace, auto mode (desktop, light)");

  // ------------------------------------------------------------------ It was really saved: reload and the same automation, chat and canvas come back
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".react-flow__node").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  check("saved: reload shows the same six nodes", (await nodes(page)) === 6, `nodes=${await nodes(page)}`);
  check("saved: reload keeps the conversation", (await page.locator("[data-role]").count()) >= 2);

  // ------------------------------------------------------------------ Ask for a change in the chat: the same automation is edited, not rebuilt
  const input = page.locator("#studio-chat-input");
  await input.fill("Make that wait three days instead.");
  await input.press("Enter");
  await page.getByText(/Wait 3 days/).first().waitFor({ timeout: 90_000 }).catch(() => {});
  check("edit: the wait step now says 3 days", (await page.getByText(/Wait 3 days/).count()) > 0);
  check("edit: still six nodes (edited, not rebuilt)", (await nodes(page)) === 6, `nodes=${await nodes(page)}`);

  // ------------------------------------------------------------------ Select a step: its settings open, and the chat knows which one
  await page.locator(".react-flow__node").filter({ hasText: /Welcome the lead/ }).first().click();
  await page.getByRole("complementary", { name: "Step settings" }).waitFor({ timeout: 10_000 }).catch(() => {});
  check("select: the step's settings open beside the canvas", await page.getByRole("complementary", { name: "Step settings" }).count());
  await shot(page, "04-step-selected");
  await page.getByRole("complementary", { name: "Step settings" }).getByRole("button", { name: "Close" }).click().catch(() => {});

  // ------------------------------------------------------------------ Manual mode: the same canvas, edited by hand
  await page.getByRole("radiogroup", { name: "Editing mode" }).getByText("Manual", { exact: true }).click();
  await page.getByPlaceholder("Search steps").waitFor({ timeout: 10_000 });
  const before = await nodes(page);
  await page.getByRole("button", { name: /Add internal note/ }).first().click();
  await page.waitForTimeout(700);
  check("manual: clicking a step in the palette adds it", (await nodes(page)) === before + 1, `before=${before} after=${await nodes(page)}`);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(500);
  check("manual: undo removes it again", (await nodes(page)) === before, `nodes=${await nodes(page)}`);
  await page.getByRole("button", { name: "Redo" }).click();
  await page.waitForTimeout(500);
  check("manual: redo brings it back", (await nodes(page)) === before + 1);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(500);
  await shot(page, "05-manual-mode-desktop-light");
  await runAxe(page, "workspace, manual mode (desktop, light)");

  // ------------------------------------------------------------------ History and publishing (the automation only creates tasks and notifications)
  await page.getByRole("button", { name: "Version history" }).click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  check("history: lists the draft's changes, including the builder's", /Builder/.test((await page.getByRole("dialog").textContent()) ?? ""));
  await shot(page, "06-version-history");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Publish$/ }).click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  check("publish: says it stays inside the CRM", /only works inside your CRM/.test((await page.getByRole("dialog").textContent()) ?? ""));
  await shot(page, "07-publish-dialog");
  await page.getByRole("button", { name: "Publish only" }).click();
  await page.getByText(/is published\. It is not switched on yet/).waitFor({ timeout: 30_000 }).catch(() => {});
  check("publish: a version is published and the automation stays off", (await page.getByText(/Version 1 is published/).count()) > 0 || (await page.getByText("Off", { exact: true }).count()) > 0);

  // ------------------------------------------------------------------ Phone width
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-studio-workspace]").waitFor({ timeout: 120_000 });
  await hydrated(page, "[data-studio-workspace]");
  await page.waitForTimeout(600);
  check("phone: workspace has no sideways scroll", (await overflow(page)) <= 1, `overflow=${await overflow(page)}`);
  await shot(page, "08-workspace-phone-manual");
  await page.evaluate(() => {
    window.__modeLog = [];
    let last = "";
    setInterval(() => { const m = document.querySelector("[data-studio-workspace]")?.getAttribute("data-mode") ?? "none"; const v = `${m}/${localStorage.getItem("iaq-studio-mode")}/${performance.getEntriesByType("navigation").length}`; if (v !== last) { last = v; window.__modeLog.push({ t: Math.round(performance.now()), v }); } }, 50);
  });
  // The mode switch is a visually hidden radio inside a label: it is operated by its visible text.
  await page.getByRole("radiogroup", { name: "Editing mode" }).getByText("Auto", { exact: true }).click();
  await page.getByRole("radiogroup", { name: "Show" }).waitFor();
  await page.waitForTimeout(600);
  check("phone: auto mode starts on the chat", await page.locator("#studio-chat-input").isVisible());
  await shot(page, "09-workspace-phone-auto-chat");
  const canvasTab = page.getByRole("radiogroup", { name: "Show" }).getByText("Canvas", { exact: true });
  await canvasTab.click({ timeout: 20_000 }).catch(async (e) => {
    const state = await page.evaluate(() => ({ mode: document.querySelector("[data-studio-workspace]")?.getAttribute("data-mode"), groups: [...document.querySelectorAll("[role=radiogroup]")].map((g) => g.getAttribute("aria-label")), ariaHidden: [...document.querySelectorAll("[aria-hidden=true], [inert]")].filter((el) => el.contains(document.querySelector("[data-studio-workspace]"))).map((el) => el.tagName + "." + String(el.className).slice(0, 40)), bodyStyle: document.body.getAttribute("style") }));
    const log = await page.evaluate(() => window.__modeLog).catch(() => null);
    throw new Error(`The Canvas tab could not be clicked: ${String(e).slice(0, 120)} ${JSON.stringify(state)} ${JSON.stringify(log)}`);
  });
  await page.waitForTimeout(1200);
  check("phone: the canvas tab shows the nodes", (await nodes(page)) >= 6, `nodes=${await nodes(page)}`);
  await shot(page, "10-workspace-phone-auto-canvas");
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 120_000 });
  check("phone: home has no sideways scroll", (await overflow(page)) <= 1, `overflow=${await overflow(page)}`);
  await shot(page, "11-home-phone", { fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });

  // ------------------------------------------------------------------ Dark theme
  await owner.context.addInitScript(() => { try { localStorage.setItem("iaq-theme", "dark"); } catch { /* */ } });
  await page.goto(workflowUrl.replace(BASE, ""), { waitUntil: "domcontentloaded" });
  await page.locator(".react-flow__node").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  await shot(page, "12-workspace-desktop-dark");
  await runAxe(page, "workspace (desktop, dark)");
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 120_000 });
  await shot(page, "13-home-desktop-dark");
  check("home: lists the automation just built", (await page.getByRole("link", { name: /welcome them/i }).count()) > 0 || (await page.locator("a[href^='/automation-studio/']").count()) > 0);
  await owner.context.close();

  // ------------------------------------------------------------------ Haven Dental owner: no plan -> the upgrade page, and nothing of Brightside's
  const haven = await person("haven_owner");
  const hp = haven.page;
  await hp.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await hp.getByRole("heading", { level: 1, name: /Describe an automation/ }).waitFor({ timeout: 180_000 });
  check("upgrade: shows $299/month and the one-time setup separately", /\$299/.test((await hp.textContent("body")) ?? "") && /\$1,499/.test((await hp.textContent("body")) ?? ""));
  check("upgrade: says what keeps working without the plan", /AI employees/i.test((await hp.textContent("body")) ?? "") && /n8n, Zapier and Make/.test((await hp.textContent("body")) ?? ""));
  check("upgrade: discloses the usage allowances as provisional", /provisional/i.test((await hp.textContent("body")) ?? ""));
  check("upgrade: the call to action goes to the Maintenance page", (await hp.locator("a[href='/maintenance']").count()) > 0);
  check("upgrade: the sidebar entry carries a lock", /Needs the Automation Studio plan/.test((await hp.getByRole("link", { name: /Automation Studio/ }).first().textContent()) ?? ""));
  check("upgrade: the example canvas is labelled as an example", (await hp.getByText("Example", { exact: true }).count()) > 0);
  await hp.locator(".react-flow__node").first().scrollIntoViewIfNeeded();
  await hp.waitForTimeout(2500);
  check("upgrade: the example canvas shows its steps", (await hp.locator(".react-flow__node").evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 10 && getComputedStyle(e).visibility === "visible"; }).length)) >= 5);
  await shot(hp, "14-upgrade-desktop-light", { fullPage: true });
  await runAxe(hp, "upgrade page (desktop, light)");
  // Another workspace's automation is not reachable: it lands on the upgrade page.
  await hp.goto(workflowUrl.replace(BASE, ""), { waitUntil: "domcontentloaded" });
  await hp.getByRole("heading", { level: 1, name: /Describe an automation/ }).waitFor({ timeout: 120_000 });
  check("isolation: another workspace's automation URL leads to the upgrade page, not to the automation", !/automation-studio\/[0-9a-f-]{36}/.test(hp.url()), hp.url().replace(BASE, ""));
  await hp.setViewportSize({ width: 375, height: 812 });
  await hp.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await hp.getByRole("heading", { level: 1, name: /Describe an automation/ }).waitFor({ timeout: 120_000 });
  await hp.waitForTimeout(600);
  check("upgrade (phone): no sideways scroll", (await overflow(hp)) <= 1, `overflow=${await overflow(hp)}`);
  await shot(hp, "15-upgrade-phone", { fullPage: true });
  await haven.context.close();
}

let failed = false;
try {
  await main();
} catch (e) {
  for (const p of lastPages) await p.screenshot({ path: path.join(SCREENS, "fatal.png") }).catch(() => {});
  failed = true;
  check("run completed", false, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e));
}
await browser.close();
const bad = report.checks.filter((c) => !c.ok);
const unclean = report.errors.page.length + report.errors.serverErrors.length + report.errors.blockedExternal.length;
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(DATA, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.checks.length - bad.length}/${report.checks.length} checks passed; page errors ${report.errors.page.length}, console errors ${report.errors.console.length}, failed requests ${report.errors.failedRequests.length}, 5xx ${report.errors.serverErrors.length}, blocked external ${report.errors.blockedExternal.length}.`);
for (const k of ["page", "serverErrors", "blockedExternal", "failedRequests", "console"]) for (const m of [...new Set(report.errors[k])].slice(0, 8)) console.log(`  ${k}: ${m}`);
process.exit(failed || bad.length || unclean ? 1 : 0);
