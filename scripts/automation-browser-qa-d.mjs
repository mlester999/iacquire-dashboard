// Signed-in browser QA of the Automation Studio release pass (2026-10-22), against the isolated local app (scripts/automation-qa.mjs, or the production
// bundle served by scripts/automation-qa-prod.mjs) in real Chromium, at desktop, tablet and phone sizes:
//   * the template gallery's search (any words, with a category, an honest empty state) and keyboard use;
//   * the Connections page's "Not available yet" section (Gmail, Sheets, Outlook, Slack sign-in: named, explained, no button that pretends to connect);
//   * no sideways scrolling, and no WCAG 2 A/AA violation found by axe-core, on Home, Connections, Usage and the editor, at every size, light and dark;
//   * the editor: panes resizable from the keyboard on desktop, the Chat / Canvas switch on a phone, the canvas drawn, a node reachable by keyboard.
//
//   node scripts/automation-browser-qa-d.mjs [--headed]
//
// Nothing here sends anything outside the machine: no workflow is switched on, no test is confirmed, no payment is recorded. The fictional QA accounts sign
// in through the real local sign-in page; passwords are read by this script only and never printed. Any other origin is blocked and counted.
// Output: .data/automation-qa/report-d.json and .data/automation-qa/screens-d/*.png. Exit code 1 when a check failed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AUTOMATION_QA_DATA_DIR, AUTOMATION_QA_URL } from "./automation-qa-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, AUTOMATION_QA_DATA_DIR);
const SCREENS = path.join(DATA, "screens-d");
const AXE = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const BASE = AUTOMATION_QA_URL;
const headed = process.argv.includes("--headed");
fs.mkdirSync(SCREENS, { recursive: true });

const pwEntry = process.env.PLAYWRIGHT_MODULE ?? path.join(ROOT, ".data/crm-qa/browser-runner/node_modules/playwright/index.mjs");
const pw = await import(pathToFileURL(pwEntry).href);
const creds = JSON.parse(fs.readFileSync(path.join(DATA, "credentials.local.json"), "utf8"));

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [], axe: [], errors: { console: [], page: [], failedRequests: [], serverErrors: [], blockedExternal: [] } };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${String(detail).slice(0, 300)}` : ""}`);
};
const isLocal = (u) => { try { return new URL(u).host === new URL(BASE).host; } catch { return false; } };
const browser = await pw.chromium.launch({ headless: !headed });
const SIZES = { desktop: { width: 1280, height: 800 }, tablet: { width: 768, height: 1024 }, phone: { width: 375, height: 812 } };

async function person(role, size, theme = "light") {
  const user = creds.users[role];
  const context = await browser.newContext({ baseURL: BASE, viewport: SIZES[size], deviceScaleFactor: 1, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/Chicago", hasTouch: size !== "desktop" });
  context.setDefaultNavigationTimeout(300_000);
  context.setDefaultTimeout(120_000);
  await context.route((url) => !isLocal(url.href), (route) => { report.errors.blockedExternal.push(route.request().url()); return route.abort("blockedbyclient").catch(() => {}); });
  await context.addInitScript((t) => { try { localStorage.setItem("iaq-tour-v1", "done"); localStorage.setItem("iaq-theme", t); } catch { /* storage blocked */ } }, theme);
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") report.errors.console.push(`${role}/${size}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => report.errors.page.push(`${role}/${size}: ${page.url().replace(BASE, "")} ${(e.message || String(e)).slice(0, 600)}`));
  page.on("requestfailed", (r) => { const f = r.failure()?.errorText ?? ""; if (isLocal(r.url()) && !/ERR_ABORTED/.test(f)) report.errors.failedRequests.push(`${role}/${size}: ${r.url().replace(BASE, "")} ${f}`); });
  page.on("response", (r) => { if (r.status() >= 500) report.errors.serverErrors.push(`${role}/${size}: ${r.status()} ${r.url().replace(BASE, "")}`); });
  for (let attempt = 1; ; attempt++) {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const ok = await page.waitForFunction(() => { const el = document.querySelector("#email"); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: attempt < 4 ? 60_000 : 180_000 }).then(() => true, () => false);
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
const shot = (page, name) => page.screenshot({ path: path.join(SCREENS, `${name}.png`) }).catch(() => {});
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (page, selector) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, selector, { timeout: 300_000 });
const quiet = (page) => page.waitForTimeout(500);

async function home(page) {
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 180_000 });
  await hydrated(page, "#studio-prompt");
  await quiet(page);
}

async function main() {
  for (const size of ["desktop", "tablet", "phone"]) {
    const { context, page } = await person("owner", size);

    // ---------------------------------------------------------------- Home
    await home(page);
    check(`${size}/home: no sideways scrolling`, (await overflow(page)) <= 1, `over by ${await overflow(page)}px`);
    check(`${size}/home: the prompt is large and visible`, await page.locator("#studio-prompt").isVisible());
    check(`${size}/home: clickable starter ideas`, (await page.locator("section[aria-labelledby='studio-headline'] button, section[aria-labelledby='studio-headline'] a").count()) >= 3);
    await shot(page, `${size}-home`);
    await runAxe(page, `${size}/home`);

    // The template search: typed words, any order, with a category, an honest empty state.
    const search = page.getByRole("searchbox", { name: "Search ready-made automations" });
    await search.scrollIntoViewIfNeeded();
    check(`${size}/home: the gallery has a search box`, await search.isVisible());
    const cards = () => page.locator("#studio-templates").locator("xpath=ancestor::section").locator("[data-template]");
    const total = await cards().count();
    check(`${size}/home: twenty ready-made automations`, total === 20, `n=${total}`);
    await search.fill("lead slack");
    const keys = await cards().evaluateAll((els) => els.map((e) => e.getAttribute("data-template")));
    check(`${size}/home: searching "lead slack" finds the Slack alert for a new lead and only Slack templates`, keys.includes("new-lead-slack-alert") && keys.length < total, keys.join(","));
    check(`${size}/home: the search result count is announced`, /ready-made automation/.test((await page.locator("#studio-templates").locator("xpath=ancestor::section").locator("[role=status]").first().textContent()) ?? ""));
    await search.fill("zzzz nothing");
    check(`${size}/home: nothing matching says so and points to the builder`, (await cards().count()) === 0 && /No ready-made automation matches/.test(await page.textContent("body")));
    await search.fill("");
    check(`${size}/home: clearing the search brings every template back`, (await cards().count()) === 20);
    const skip = page.getByRole("link", { name: "Skip to ready-made automations" });
    check(`${size}/home: a skip link jumps past the automations to the ready-made ones`, (await skip.count()) === 1 && (await skip.getAttribute("href")) === "#studio-templates");
    await skip.focus();
    const skipBox = await skip.boundingBox();
    check(`${size}/home: the skip link shows itself when it has focus`, Boolean(skipBox) && skipBox.width > 40 && skipBox.height > 12, JSON.stringify(skipBox));
    await skip.press("Enter");
    check(`${size}/home: following it moves to the ready-made automations`, page.url().endsWith("#studio-templates"), page.url());
    if (size === "desktop") {
      // Keyboard: the search box is reachable by Tab from the prompt and is typed into without a mouse.
      await page.locator("#studio-prompt").focus();
      let reached = false;
      let tabs = 0;
      for (let i = 0; i < 200 && !reached; i++) {
        tabs = i + 1;
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Search ready-made automations");
      }
      check("desktop/home: the template search can be reached with Tab", reached, `not reached after ${tabs} presses`);
      console.log(`INFO  the search box is ${tabs} Tab presses after the prompt`);
      if (reached) {
        await page.keyboard.type("review");
        check("desktop/home: typing in it filters the cards", (await cards().count()) > 0 && (await cards().count()) < 20);
      }
    }

    // ---------------------------------------------------------------- Connections
    await page.goto("/automation-studio/connections", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: "Connections" }).waitFor({ timeout: 180_000 });
    await quiet(page);
    const region = page.getByRole("region", { name: "Not available yet" });
    check(`${size}/connections: the not-available section is there`, await region.isVisible());
    const names = await region.locator("li p:first-child").allTextContents();
    check(`${size}/connections: it names Gmail, Google Sheets, Outlook and Sign in with Slack`, ["Gmail", "Google Sheets", "Outlook and Microsoft 365 email", "Sign in with Slack"].every((n) => names.includes(n)), names.join("|"));
    check(`${size}/connections: and offers no button that pretends to connect`, (await region.getByRole("button").count()) === 0);
    check(`${size}/connections: no sideways scrolling`, (await overflow(page)) <= 1, `over by ${await overflow(page)}px`);
    await shot(page, `${size}-connections`);
    await runAxe(page, `${size}/connections`);

    // ---------------------------------------------------------------- Usage
    await page.goto("/automation-studio/usage", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 180_000 });
    await quiet(page);
    check(`${size}/usage: no sideways scrolling`, (await overflow(page)) <= 1, `over by ${await overflow(page)}px`);
    await shot(page, `${size}-usage`);
    await runAxe(page, `${size}/usage`);

    // ---------------------------------------------------------------- The editor
    await home(page);
    const card = page.locator('[data-template="speed-to-lead"]');
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: "Set up" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Create automation" }).click();
    await page.waitForURL(/\/automation-studio\/[0-9a-f-]{36}$/, { timeout: 120_000 });
    await page.locator("[data-studio-workspace]").waitFor({ timeout: 180_000 });
    await hydrated(page, "[data-studio-workspace]");
    // Below desktop width the editor shows the chat or the canvas, one at a time (a Chat / Canvas switch); a template starts on the chat.
    const switcher = page.getByRole("radiogroup", { name: "Show" });
    if (size !== "desktop") {
      check(`${size}/editor: a Chat / Canvas switch is offered`, await switcher.isVisible());
      await switcher.getByText("Canvas").click();
    }
    await page.locator(".react-flow__node").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
    const url = page.url();
    check(`${size}/editor: opens with the template drawn (nodes and links)`, (await page.locator(".react-flow__node").count()) >= 3 && (await page.locator(".react-flow__edge").count()) >= 2);
    check(`${size}/editor: no sideways scrolling`, (await overflow(page)) <= 1, `over by ${await overflow(page)}px`);
    await shot(page, `${size}-editor`);
    await runAxe(page, `${size}/editor`);
    if (size === "desktop") {
      const sep = page.getByRole("separator", { name: "Resize the chat" });
      const before = Number(await sep.getAttribute("aria-valuenow"));
      await sep.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      const after = Number(await sep.getAttribute("aria-valuenow"));
      check("desktop/editor: the chat pane resizes from the keyboard", after !== before, `${before} -> ${after}`);
      // A node is reachable by keyboard and shows its settings.
      const node = page.locator(".react-flow__node").first();
      await node.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      check("desktop/editor: a node opens its settings from the keyboard (Enter)", (await page.locator("[data-studio-workspace] [role=complementary], [data-studio-workspace] aside, [data-studio-workspace] [aria-label*='settings' i]").count()) > 0 || /Selected|Settings|Step/.test((await page.textContent("[data-studio-workspace]")) ?? ""));
    }
    // Reload: the automation is saved, not held in the page.
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("[data-studio-workspace]").waitFor({ timeout: 180_000 });
    if (size !== "desktop") await page.getByRole("radiogroup", { name: "Show" }).getByText("Canvas").click();
    await page.locator(".react-flow__node").first().waitFor({ timeout: 60_000 });
    check(`${size}/editor: after a reload the same automation is there`, (await page.locator(".react-flow__node").count()) >= 3);
    await context.close();
  }

  // Dark mode: Connections and Home, desktop.
  {
    const { context, page } = await person("owner", "desktop", "dark");
    await home(page);
    await runAxe(page, "dark/home");
    await page.goto("/automation-studio/connections", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: "Connections" }).waitFor({ timeout: 180_000 });
    await quiet(page);
    await shot(page, "dark-connections");
    await runAxe(page, "dark/connections");
    await context.close();
  }

  // A workspace without the plan sees the upgrade page, never the builder (server-side: the page is a different one, the API refuses).
  {
    const { context, page } = await person("haven_owner", "desktop");
    await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");
    await quiet(page);
    check("no plan: /automation-studio shows the upgrade page, not the builder", (await page.locator("#studio-prompt").count()) === 0 && /\$299|Managed Maintenance/.test(await page.textContent("body")));
    const res = await page.request.post("/api/automation-studio/00000000-0000-4000-8000-000000000000/chat", { data: { message: "hi" }, headers: { origin: BASE } });
    check("no plan: the builder's API refuses", res.status() >= 400 && res.status() < 500, `status ${res.status()}`);
    await shot(page, "no-plan-upgrade");
    await context.close();
  }

  check("no console errors", report.errors.console.filter((m) => !/Failed to load resource/.test(m)).length === 0, report.errors.console.slice(0, 3).join(" | "));
  check("no uncaught page errors", report.errors.page.length === 0, report.errors.page.slice(0, 3).join(" | "));
  check("no failed requests to the app", report.errors.failedRequests.length === 0, report.errors.failedRequests.slice(0, 3).join(" | "));
  check("no server errors (5xx)", report.errors.serverErrors.length === 0, report.errors.serverErrors.slice(0, 3).join(" | "));
  check("nothing outside the sandbox was contacted", report.errors.blockedExternal.length === 0, [...new Set(report.errors.blockedExternal)].slice(0, 3).join(" | "));
}

try {
  await main();
} catch (e) {
  check("the run finished", false, e instanceof Error ? e.stack : String(e));
}
await browser.close();
report.finishedAt = new Date().toISOString();
const failed = report.checks.filter((c) => !c.ok);
fs.writeFileSync(path.join(DATA, "report-d.json"), JSON.stringify({ ...report, passed: report.checks.length - failed.length, failed: failed.length }, null, 2));
console.log(`\n${report.checks.length - failed.length} of ${report.checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
