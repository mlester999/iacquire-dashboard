// Focused browser QA for AQi Phase 3: real Chromium against the isolated CRM QA server
// (scripts/crm-qa.mjs on http://127.0.0.1:3230). Fictional QA data only.
//
//   PLAYWRIGHT_MODULE=<file URL to playwright/index.mjs> node scripts/aqi-guidance-browser-qa.mjs
//
// Requires a running QA server and .data/crm-qa/credentials.local.json. Output: .data/aqi-qa/report.json,
// report.md and screenshots. Exit code 1 on any failure.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, ".data/aqi-qa");
const SHOTS = path.join(DATA, "screens");
const AUTH = path.join(DATA, "auth");
const BASE = process.env.AQI_QA_URL ?? "http://127.0.0.1:3230";
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(AUTH, { recursive: true });

const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, ".data/crm-qa/credentials.local.json"), "utf8"));
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an installed playwright/index.mjs");
const { chromium } = await import(modulePath.startsWith("file:") ? modulePath : `file:///${modulePath.replace(/\\/g, "/")}`);
const axeSource = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");

const report = { base: BASE, startedAt: new Date().toISOString(), checks: [], failures: [], pages: [] };
function check(name, condition, detail = null) {
  report.checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) report.failures.push({ name, detail });
}
function recordPage(label, state) {
  report.pages.push({ label, ...state });
}

const browser = await chromium.launch({ headless: true });
const AXE_OPTIONS = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } };

async function newContext(role, viewport, theme = "light") {
  const user = credentials.users[role];
  if (!user) throw new Error(`No QA credential for ${role}`);
  const statePath = path.join(AUTH, `${role}.json`);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
    ...(fs.existsSync(statePath) ? { storageState: statePath } : {}),
  });
  await context.addInitScript((value) => {
    try { localStorage.setItem("iaq-theme", value); } catch { /* storage unavailable */ }
  }, theme);
  await context.routeWebSocket(/\/_next\/webpack-hmr/, () => {});
  const page = await context.newPage();
  const bucket = { consoleErrors: [], pageErrors: [], failedRequests: [], serverErrors: [] };
  page.on("console", (message) => { if (message.type() === "error") bucket.consoleErrors.push(message.text().slice(0, 1000)); });
  page.on("pageerror", (error) => bucket.pageErrors.push(String(error.message ?? error).slice(0, 1000)));
  page.on("requestfailed", (request) => { if (!request.url().includes(BASE)) return; const failure = request.failure()?.errorText ?? "failed"; if (!/ERR_ABORTED/.test(failure)) bucket.failedRequests.push({ url: request.url(), failure }); });
  page.on("response", (response) => { if (response.status() >= 500) bucket.serverErrors.push({ url: response.url(), status: response.status() }); });
  await signIn(page, user);
  await context.storageState({ path: statePath }).catch(() => {});
  return { context, page, bucket, user };
}

async function signIn(page, user) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (!new URL(page.url()).pathname.startsWith("/login")) return;
  await page.waitForFunction(() => {
    const element = document.querySelector("#email");
    return Boolean(element) && Object.keys(element).some((key) => key.startsWith("__reactProps$"));
  }, null, { timeout: 120_000 }).catch(() => {});
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  const submit = page.locator("form button[type=submit]").first();
  await submit.waitFor({ state: "visible", timeout: 30_000 });
  for (let attempt = 0; attempt < 5 && !(await submit.isEnabled()); attempt += 1) {
    await page.locator("#email").fill("");
    await page.locator("#password").fill("");
    await page.locator("#email").pressSequentially(user.email, { delay: 15 });
    await page.locator("#password").pressSequentially(user.password, { delay: 15 });
    await page.waitForTimeout(500);
  }
  await submit.click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 120_000 }).catch(() => {});
  if (new URL(page.url()).pathname.startsWith("/login")) {
    const message = await page.locator("[role=alert]").first().textContent().catch(() => "still on sign-in");
    throw new Error(`Sign-in failed for ${user.email}: ${message}`);
  }
}

async function axe(page, label) {
  await page.addScriptTag({ content: axeSource }).catch(() => {});
  const result = await page.evaluate(async (options) => window.axe.run(document, options), AXE_OPTIONS).catch(() => null);
  if (!result) {
    check(`${label}: axe completed`, false, "axe did not run");
    return;
  }
  const violations = result.violations.filter((item) => ["serious", "critical"].includes(item.impact));
  check(
    `${label}: no serious axe violations`,
    violations.length === 0,
    violations.map((item) => `${item.id} [${item.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}]`).join(", "),
  );
}

async function overflow(page, label) {
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  check(`${label}: no horizontal overflow`, sizes.scroll <= sizes.inner + 1, `${sizes.scroll} > ${sizes.inner}`);
}

async function dismissOnboarding(page) {
  await page.evaluate(async () => {
    await fetch("/api/aqi/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) });
  }).catch(() => {});
}

/** Clears a previous run's paused/in-progress tutorial and resets the welcome preference. Isolated QA data only. */
async function resetGuidance(page) {
  await page.evaluate(async () => {
    const state = await fetch("/api/aqi/tutorials?path=/overview").then((response) => response.json()).catch(() => ({}));
    for (const active of state.state?.active ?? []) {
      await fetch(`/api/aqi/tutorials/${active.slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "exit", pathname: "/overview", reason: "qa_reset" }),
      }).catch(() => {});
    }
    await fetch("/api/aqi/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset" }) }).catch(() => {});
  }).catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
}

async function highlightMatches(page, targetId, label) {
  const highlight = page.locator("[data-aqi-highlight]").first();
  const target = page.locator(`[data-aqi-target="${targetId}"]`).first();
  await target.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const [h, t] = await Promise.all([highlight.boundingBox().catch(() => null), target.boundingBox().catch(() => null)]);
  if (!h || !t) {
    check(`${label}: spotlight and target exist`, false, JSON.stringify({ h, t }));
    return;
  }
  const tolerance = 10;
  const aligned = Math.abs(h.x - (t.x - 6)) <= tolerance && Math.abs(h.y - (t.y - 6)) <= tolerance && Math.abs(h.width - (t.width + 12)) <= tolerance * 2 && Math.abs(h.height - (t.height + 12)) <= tolerance * 2;
  check(`${label}: spotlight aligns with the real ${targetId}`, aligned, JSON.stringify({ h, t }));
  const card = await page.locator('[role="dialog"]:has(#aqi-tutorial-title)').boundingBox().catch(() => null);
  if (card && t) {
    const overlaps = card.x < t.x + t.width && card.x + card.width > t.x && card.y < t.y + t.height && card.y + card.height > t.y;
    check(`${label}: tooltip does not cover the target`, !overlaps, JSON.stringify({ card, t }));
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: first-time guidance and a real contextual-tip walkthrough
// ---------------------------------------------------------------------------
{
  const { context, page, bucket } = await newContext("sales_rep", { width: 1440, height: 900 });
  await page.goto(`${BASE}/overview`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await resetGuidance(page);
  await page.getByText("Welcome to iAcquireOS").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
  check("first-time owner sees the optional welcome card", await page.locator("#aqi-welcome-title").isVisible().catch(() => false));
  await page.getByRole("button", { name: "Don't show again" }).click().catch(() => {});
  await page.waitForTimeout(1_200);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  check("dismissing the welcome card persists after a refresh", !(await page.locator("#aqi-welcome-title").isVisible().catch(() => false)));

  await page.goto(`${BASE}/crm/contacts`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByText("Need help managing contacts?").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  check("contacts page shows the configured contextual tip", await page.getByText("Need help managing contacts?").isVisible().catch(() => false));
  await page.getByRole("button", { name: /Show me/ }).click();
  await page.locator("#aqi-tutorial-title").filter({ hasText: "Open Contacts" }).waitFor({ state: "visible", timeout: 30_000 });
  check("tip launches the real published walkthrough", await page.getByText("Adding your first contact").first().isVisible().catch(() => false));
  await highlightMatches(page, "nav.crm.contacts", "tutorial step 1");

  await page.locator('[data-aqi-target="nav.crm.contacts"]').first().click();
  await page.locator("#aqi-tutorial-title").filter({ hasText: "Start a new contact" }).waitFor({ state: "visible", timeout: 20_000 });
  await highlightMatches(page, "crm.contacts.new", "tutorial step 2");
  await page.locator('[data-aqi-target="crm.contacts.new"]').first().click();
  await page.locator("#aqi-tutorial-title").filter({ hasText: "Enter the contact's details" }).waitFor({ state: "visible", timeout: 20_000 });
  await highlightMatches(page, "crm.contact.first-name", "tutorial step 3 (modal)");
  await page.screenshot({ path: path.join(SHOTS, "desktop-tutorial-modal.png") });
  await axe(page, "tutorial step 3");

  const stamp = Date.now().toString(36);
  await page.locator("#c-first").fill("AQi Browser");
  await page.locator("#c-last").fill(`QA ${stamp}`);
  await page.getByRole("button", { name: "Next step" }).click();
  await page.locator("#aqi-tutorial-title").filter({ hasText: "Save it yourself" }).waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.locator('[data-aqi-target="crm.contact.save"]').click();
  await page.waitForURL(/\/crm\/contacts\/[0-9a-f-]{8,}/, { timeout: 30_000 }).catch(() => {});
  // Wait for the destination page to finish compiling/rendering before asking the server to verify.
  await page.getByText(`QA ${stamp}`).first().waitFor({ state: "visible", timeout: 90_000 }).catch(() => {});
  const checkCompletion = page.getByRole("button", { name: "Check completion" });
  if (await checkCompletion.isVisible().catch(() => false)) await checkCompletion.click().catch(() => {});
  await page.getByText("Walkthrough complete").first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
  check("creating the contact verifies completion against the real detail route", await page.getByText("Walkthrough complete").first().isVisible().catch(() => false));
  const completionText = await page.locator('[role="dialog"]').filter({ hasText: "Walkthrough complete" }).first().innerText().catch(() => "");
  check("verified completion is labelled", /Verified/i.test(completionText), completionText.slice(0, 240));
  await page.screenshot({ path: path.join(SHOTS, "desktop-tutorial-verified.png") });
  await page.getByRole("button", { name: "Done" }).click().catch(() => {});
  recordPage("sales_rep/desktop", bucket);
  await context.close();
}

// ---------------------------------------------------------------------------
// Scenario 2: pause, reload and resume
// ---------------------------------------------------------------------------
{
  const { context, page, bucket } = await newContext("sales_rep", { width: 1440, height: 900 });
  await page.goto(`${BASE}/overview`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await resetGuidance(page);
  await dismissOnboarding(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: /Open AQi/ }).click();
  await page.getByRole("button", { name: /Take a quick guided tour/ }).click();
  await page.locator("#aqi-tutorial-title").waitFor({ state: "visible", timeout: 30_000 });
  check("stable welcome exposes a replayable tour", await page.getByText("Getting started with iAcquireOS").first().isVisible().catch(() => false));
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole("button", { name: "Next step" }).click();
    await page.waitForTimeout(500);
  }
  await page.locator("#aqi-tutorial-title").filter({ hasText: "Meet your AI team" }).waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.getByRole("button", { name: "Pause walkthrough" }).click();
  await page.getByText("Paused at step 3").waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  await page.getByText("Walkthrough paused").waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  check("paused progress appears as a resume card", await page.getByText("Walkthrough paused").isVisible().catch(() => false));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Walkthrough paused").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  check("persisted progress survives a full refresh", await page.getByText("Walkthrough paused").isVisible().catch(() => false));
  await page.getByRole("button", { name: "Resume" }).click();
  await page.locator("#aqi-tutorial-title").filter({ hasText: "Meet your AI team" }).waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  check("resume returns to the saved step rather than restarting", await page.getByText("Step 3 of 6").first().isVisible().catch(() => false));
  await page.getByRole("button", { name: "Exit" }).click().catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, "desktop-resume.png") });
  await overflow(page, "desktop resume");
  recordPage("sales_rep/reload", bucket);
  await context.close();
}

// ---------------------------------------------------------------------------
// Scenario 3: 390 px mobile overlay
// ---------------------------------------------------------------------------
{
  const { context, page, bucket } = await newContext("sales_rep", { width: 390, height: 844 });
  await page.goto(`${BASE}/overview`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await resetGuidance(page);
  await dismissOnboarding(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: /Open AQi/ }).click();
  await page.getByRole("button", { name: /Take a quick guided tour/ }).click();
  await page.locator("#aqi-tutorial-title").waitFor({ state: "visible", timeout: 30_000 });
  const card = await page.locator("#aqi-tutorial-title").locator("xpath=ancestor::*[@role='dialog'][1]").boundingBox().catch(() => null);
  check("mobile tutorial card fits the viewport", Boolean(card) && card.x >= 0 && card.x + card.width <= 390, JSON.stringify(card));
  const next = await page.getByRole("button", { name: "Next step" }).boundingBox().catch(() => null);
  check("mobile tutorial controls are reachable", Boolean(next) && next.y + next.height <= 844, JSON.stringify(next));
  await overflow(page, "mobile tutorial");
  await highlightMatches(page, "overview.hero", "mobile tutorial step 1");
  await axe(page, "mobile tutorial");
  await page.screenshot({ path: path.join(SHOTS, "mobile-tutorial.png"), fullPage: false });
  await page.getByRole("button", { name: "Close walkthrough" }).click().catch(() => {});
  recordPage("sales_rep/mobile", bucket);
  await context.close();
}

// ---------------------------------------------------------------------------
// Scenario 4: Super Admin tutorial management and real browser preview
// ---------------------------------------------------------------------------
{
  const { context, page, bucket } = await newContext("agency_admin", { width: 1440, height: 900 });
  await page.goto(`${BASE}/admin/aqi`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await dismissOnboarding(page);
  // The tab bar is server-rendered; a click before hydration is a no-op.
  await page.waitForFunction(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const tutorials = tabs.find((element) => element.textContent?.includes("Tutorials"));
    return Boolean(tutorials) && Object.keys(tutorials).some((key) => key.startsWith("__reactProps$"));
  }, null, { timeout: 120_000 }).catch(() => {});
  await page.getByRole("tab", { name: "Tutorials" }).click();
  await page.getByText("Tutorial library").waitFor({ state: "visible", timeout: 15_000 }).catch(async () => {
    await page.getByRole("tab", { name: "Tutorials" }).click();
  });
  await page.getByText("Tutorial library").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  check("Super Admin sees the tutorial library", await page.getByText("Tutorial library").first().isVisible().catch(() => false));
  await page.getByRole("button", { name: /Navigating AQi Management/ }).click().catch(() => {});
  await page.getByRole("button", { name: "Validate" }).click();
  await page.getByText("Structural validation").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  check("server-side structural validation is available", await page.getByText("Structural validation").isVisible().catch(() => false));
  await page.getByRole("button", { name: "Preview in browser" }).click();
  await page.locator("#aqi-tutorial-title").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  check("draft preview opens the real spotlight stage", await page.getByText("Preview").first().isVisible().catch(() => false));
  await highlightMatches(page, "nav.agency.aqi", "admin preview");
  await page.screenshot({ path: path.join(SHOTS, "admin-preview.png") });
  await axe(page, "admin preview");
  await page.getByRole("button", { name: "Close walkthrough" }).click().catch(() => {});
  await page.goto(`${BASE}/admin/aqi/insights`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByText("How AQi is actually used").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
  check("Insights dashboard renders real-data sections", await page.getByText("How AQi is actually used").isVisible().catch(() => false));
  await page.getByText("Usage", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.getByText("No reliable data for this period").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  check("empty analytics periods show an honest empty state", await page.getByText("No reliable data for this period").first().isVisible().catch(() => false));
  await page.screenshot({ path: path.join(SHOTS, "admin-insights.png"), fullPage: true });
  await axe(page, "admin insights");
  recordPage("agency_admin", bucket);
  await context.close();
}

await browser.close();
report.finishedAt = new Date().toISOString();
report.passed = report.failures.length === 0;
const failuresByPage = report.pages.reduce((sum, page) => sum + page.consoleErrors.length + page.pageErrors.length + page.failedRequests.length + page.serverErrors.length, 0);
report.passed = report.passed && failuresByPage === 0;
fs.writeFileSync(path.join(DATA, "report.json"), JSON.stringify(report, null, 2));
const lines = [
  `# AQi Phase 3 browser QA`,
  ``,
  `Base: ${BASE}`,
  `Started: ${report.startedAt}`,
  `Finished: ${report.finishedAt}`,
  `Checks: ${report.checks.filter((item) => item.ok).length}/${report.checks.length} passed`,
  ``,
  ...report.checks.map((item) => `- ${item.ok ? "PASS" : "FAIL"} — ${item.name}${item.ok || !item.detail ? "" : ` (${item.detail})`}`),
  ``,
  `## Pages`,
  ...report.pages.map((page) => `- ${page.label}: console ${page.consoleErrors.length}, page ${page.pageErrors.length}, failed requests ${page.failedRequests.length}, 5xx ${page.serverErrors.length}`),
];
fs.writeFileSync(path.join(DATA, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
process.exit(report.passed ? 0 : 1);
