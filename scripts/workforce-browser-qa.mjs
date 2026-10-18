// Signed-in browser QA for the AI workforce screens against the isolated local QA app on http://localhost:3230.
// It uses fictional records seeded by scripts/run-workforce-qa-seed.mjs, a real Chromium, local sign-in, screenshots,
// console/request capture, horizontal-overflow checks and axe-core. It never contacts a provider or a hosted service.
//
//   node scripts/workforce-browser-qa.mjs
//
// Playwright is not a project dependency: set PLAYWRIGHT_MODULE to an installed playwright-core index.mjs.
// Output: .data/workforce-qa/report.json, report.md and screens/.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = "http://localhost:3230";
const OUT = path.join(ROOT, ".data/workforce-qa");
const SCREENS = path.join(OUT, "screens");
fs.mkdirSync(SCREENS, { recursive: true });

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) {
  console.error("Set PLAYWRIGHT_MODULE to an installed playwright-core/index.mjs.");
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(modulePath).href);
const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, ".data/crm-qa/credentials.local.json"), "utf8"));
const users = credentials.users;

const report = {
  baseUrl: BASE,
  startedAt: new Date().toISOString(),
  pages: [],
  interactions: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  blocked: [],
  screens: [],
  errors: [],
};

const browser = await chromium.launch({ headless: true });

function attach(page) {
  page.on("console", (msg) => {
    if (msg.type() === "error") report.consoleErrors.push({ page: page.url(), text: msg.text().slice(0, 500) });
  });
  page.on("pageerror", (err) => report.pageErrors.push({ page: page.url(), text: String(err).slice(0, 500) }));
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "";
    if (!failure.includes("ERR_ABORTED")) report.failedRequests.push({ page: page.url(), url: req.url(), failure });
  });
}

async function signIn(context, user) {
  const page = await context.newPage();
  attach(page);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#email");
    return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  }, null, { timeout: 120_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const email = page.locator("#email");
  const password = page.locator("#password");
  const submit = page.locator("form button[type=submit]").first();
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt === 0) {
      await email.fill(user.email);
      await password.fill(user.password);
    } else {
      await email.fill("");
      await password.fill("");
      await email.pressSequentially(user.email, { delay: 10 });
      await password.pressSequentially(user.password, { delay: 10 });
    }
    try {
      await submit.waitFor({ state: "visible", timeout: 10_000 });
      const enabled = await submit.isEnabled().catch(() => false);
      if (!enabled) {
        await page.waitForTimeout(800);
        if (await submit.isEnabled().catch(() => false)) break;
        continue;
      }
      break;
    } catch {
      // retry
    }
  }
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }).catch(() => {});
  if (new URL(page.url()).pathname.startsWith("/login")) {
    const message = (await page.locator("[role=alert]").first().textContent().catch(() => "")) || "still on sign-in";
    throw new Error(`Sign-in failed for ${user.email}: ${message.trim().slice(0, 200)}`);
  }
  return page;
}

async function dismissTour(page) {
  const skip = page.getByRole("button", { name: /^Skip$/ });
  // The existing onboarding tour starts 900 ms after the portal loads. Wait for it before taking a screenshot or
  // running axe, otherwise a mid-animation card produces false contrast failures and can block clicks.
  await skip.waitFor({ state: "visible", timeout: 2_500 }).catch(() => {});
  if (await skip.isVisible().catch(() => false)) {
    await skip.click().catch(() => {});
    await page.locator("#tour-title").waitFor({ state: "detached", timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function accessible(page) {
  try {
    await page.addScriptTag({ path: path.join(ROOT, "node_modules/axe-core/axe.min.js") });
    return await page.evaluate(async () => {
      const result = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
      });
      return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
    });
  } catch (err) {
    return [{ id: "axe-error", impact: "unknown", help: String(err).slice(0, 200), nodes: 0, targets: [] }];
  }
}

async function visit(page, name, route, { fullPage = true, axe = true } = {}) {
  const url = route.startsWith("http") ? route : `${BASE}${route}`;
  const started = Date.now();
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 180_000 }).catch((err) => {
    report.errors.push({ name, route, error: String(err).slice(0, 400) });
    return null;
  });
  await page.waitForTimeout(400);
  await dismissTour(page);
  const screenshot = path.join(SCREENS, `${name}.png`);
  await page.screenshot({ path: screenshot, fullPage }).catch(() => {});
  report.screens.push(path.relative(OUT, screenshot).replaceAll("\\", "/"));
  const metrics = await page.evaluate(() => ({
    path: location.pathname + location.search,
    title: document.title,
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    h1: document.querySelector("h1")?.textContent?.trim() ?? null,
  })).catch(() => null);
  const violations = axe ? await accessible(page) : [];
  report.pages.push({
    name,
    route,
    finalPath: metrics?.path ?? null,
    status: response?.status() ?? null,
    title: metrics?.title ?? null,
    h1: metrics?.h1 ?? null,
    horizontalOverflow: metrics ? metrics.scrollWidth > metrics.width + 1 : null,
    ms: Date.now() - started,
    axe: violations,
  });
  return metrics;
}

function interaction(name, fn) {
  const started = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(() => report.interactions.push({ name, ok: true, ms: Date.now() - started }))
    .catch((err) => {
      report.interactions.push({ name, ok: false, ms: Date.now() - started, error: String(err).slice(0, 500) });
      throw err;
    });
}

try {
  // Agency admin: the internal workforce
  const agencyContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "light" });
  const agency = await signIn(agencyContext, users.agency_admin);
  await visit(agency, "admin-workforce-desktop", "/admin/workforce");
  const workforceText = await agency.locator("body").innerText();
  if (!/Agency AI workforce/i.test(workforceText)) throw new Error("The agency workforce page did not render its heading.");
  if (!/Sales Assistant/i.test(workforceText)) throw new Error("The six internal employees were not listed.");

  await visit(agency, "admin-employee-sales", "/admin/workforce/sales-assistant");
  const profileText = await agency.locator("body").innerText();
  if (!/SOUL\.md \(managed by iAcquire\)/i.test(profileText)) throw new Error("The internal employee SOUL.md card is missing.");
  if (!/Profile and runtime/i.test(profileText)) throw new Error("The internal employee profile fields are missing.");

  await interaction("open internal chat from the admin employee page", async () => {
    await agency.locator('a[href="/admin/workforce/open?role=sales-assistant"]').first().click();
    await agency.waitForURL((u) => u.pathname === "/chat/sales-assistant", { timeout: 120_000 });
    await agency.waitForLoadState("networkidle");
    await dismissTour(agency);
    const text = await agency.locator("body").innerText();
    if (!/Today's internal priorities/i.test(text)) throw new Error("The seeded internal conversation was not listed.");
    if (!/Sales Assistant/i.test(text)) throw new Error("The internal chat header did not show the employee.");
    await agency.screenshot({ path: path.join(SCREENS, "admin-internal-chat.png"), fullPage: false });
    report.screens.push("screens/admin-internal-chat.png");
  });

  await interaction("search, rename and delete an internal conversation", async () => {
    await agency.getByRole("button", { name: "Today's internal priorities", exact: true }).click();
    await agency.waitForFunction(() => document.body.innerText.includes("Three things need you today"), null, { timeout: 15_000 });
    const body = await agency.locator("body").innerText();
    if (!/Three things need you today/i.test(body)) throw new Error("The seeded conversation messages did not render.");
    const search = agency.locator("#conv-search");
    await search.fill("priorities");
    await agency.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes("Today's internal priorities") && !text.includes("QA scratch conversation");
    }, null, { timeout: 10_000 });
    await search.fill("");
    await agency.waitForFunction(() => document.body.innerText.includes("QA scratch conversation"), null, { timeout: 10_000 });
    await agency.getByRole("button", { name: /Options for QA scratch conversation/i }).click();
    await agency.getByRole("menuitem", { name: /Rename/i }).click();
    await agency.locator("#rename-input").fill("QA renamed conversation");
    await agency.getByRole("button", { name: /^Save$/ }).click();
    await agency.waitForFunction(() => document.body.innerText.includes("QA renamed conversation"), null, { timeout: 10_000 });
    await agency.getByRole("button", { name: /Options for QA renamed conversation/i }).click();
    await agency.getByRole("menuitem", { name: /Delete/i }).click();
    await agency.getByRole("button", { name: /^Delete$/ }).click();
    await agency.waitForFunction(() => !document.body.innerText.includes("QA renamed conversation"), null, { timeout: 10_000 });
  });

  await interaction("load older messages without losing the reader's place", async () => {
    await agency.getByRole("button", { name: "Long internal history (QA)", exact: true }).click();
    const load = agency.getByRole("button", { name: /Load earlier messages/i });
    await load.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    if (!(await load.isVisible().catch(() => false))) throw new Error("The long conversation did not offer older messages.");
    const before = await agency.locator("ol > li").count();
    await load.click();
    await agency.waitForTimeout(900);
    const after = await agency.locator("ol > li").count();
    if (after <= before) throw new Error(`Loading older messages did not add messages (${before} -> ${after}).`);
    await agency.screenshot({ path: path.join(SCREENS, "admin-chat-older-messages.png"), fullPage: false });
    report.screens.push("screens/admin-chat-older-messages.png");
  });

  // Client owner: the isolated client workforce, knowledge and instruction test screen
  const clientContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "light" });
  const client = await signIn(clientContext, users.owner);
  await visit(client, "client-workforce-desktop", "/workforce");
  const clientText = await client.locator("body").innerText();
  if (!/Your AI team|Meet the employees|AI team/i.test(clientText)) throw new Error("The client workforce gallery did not render.");
  if (/Agency AI workforce|iAcquire internal operations/i.test(clientText)) throw new Error("A client page exposed the internal workforce heading.");

  await visit(client, "client-employee-sales", "/workforce/sales-assistant");
  await interaction("client employee knowledge tab", async () => {
    await client.getByRole("tab", { name: /Knowledge/i }).click();
    await client.waitForTimeout(500);
    const text = await client.locator("body").innerText();
    if (!/Employee notes/i.test(text) || !/Reference documents/i.test(text)) throw new Error("The knowledge tab did not render.");
    if (!/Spring inspection offer/i.test(text)) throw new Error("The seeded employee note was not shown.");
    if (!/Warranty and service area|warranty-and-service-area/i.test(text)) throw new Error("The seeded employee document was not shown.");
    if (!/qa-warranty\.pdf/i.test(text) || !/PDF text/i.test(text)) throw new Error("The extracted PDF document and its provenance badge were not shown.");
    if (!/qa-service-checklist\.docx/i.test(text) || !/Word text/i.test(text)) throw new Error("The extracted Word document and its provenance badge were not shown.");
    await client.screenshot({ path: path.join(SCREENS, "client-employee-knowledge.png"), fullPage: true });
    report.screens.push("screens/client-employee-knowledge.png");
  });
  await interaction("client employee instructions and SOUL tab", async () => {
    await client.getByRole("tab", { name: /Instructions & SOUL/i }).click();
    await client.waitForTimeout(500);
    const text = await client.locator("body").innerText();
    if (!/Instruction hierarchy/i.test(text)) throw new Error("The instruction hierarchy did not render.");
    if (!/SOUL\.md and employee identity/i.test(text)) throw new Error("The SOUL.md card did not render.");
    if (!/Inspection and editing: unavailable/i.test(text)) throw new Error("The memory limitation is not stated.");
    await client.screenshot({ path: path.join(SCREENS, "client-employee-instructions.png"), fullPage: true });
    report.screens.push("screens/client-employee-instructions.png");
  });
  await interaction("client draft test dialog is honest without a provider", async () => {
    await client.getByRole("button", { name: /Test active configuration/i }).click();
    await client.waitForTimeout(1200);
    const text = await client.locator("[role=dialog]").innerText();
    if (!/Isolated test session/i.test(text)) throw new Error("The isolated test explanation is missing.");
    if (!/This employee isn't connected to an AI provider yet|Not connected|Review only/i.test(text)) throw new Error("The dialog did not explain the unavailable provider.");
    await client.screenshot({ path: path.join(SCREENS, "client-config-test-dialog.png"), fullPage: false });
    report.screens.push("screens/client-config-test-dialog.png");
    await client.keyboard.press("Escape");
    await client.waitForTimeout(300);
  });

  // Phone layout and overflow for both scopes
  for (const [user, prefix] of [[users.agency_admin, "admin"], [users.owner, "client"]]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    const page = await signIn(context, user);
    const routes = prefix === "admin"
      ? [["mobile-admin-workforce", "/admin/workforce"], ["mobile-admin-employee", "/admin/workforce/sales-assistant"], ["mobile-admin-chat", "/chat/sales-assistant"]]
      : [["mobile-client-workforce", "/workforce"], ["mobile-client-employee", "/workforce/sales-assistant"], ["mobile-client-chat", "/chat/sales-assistant"]];
    for (const [name, route] of routes) await visit(page, name, route, { fullPage: false });
    await context.close();
  }
} catch (err) {
  report.errors.push({ fatal: String(err).slice(0, 1000) });
} finally {
  await browser.close();
}

report.finishedAt = new Date().toISOString();
const failedPages = report.pages.filter((p) => p.status !== 200 || p.horizontalOverflow);
const failedInteractions = report.interactions.filter((i) => !i.ok);
const axeViolations = report.pages.flatMap((p) => p.axe.map((v) => ({ page: p.name, ...v })));
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
const md = [
  "# AI workforce browser QA",
  "",
  `- Base URL: ${BASE}`,
  `- Started: ${report.startedAt}`,
  `- Finished: ${report.finishedAt}`,
  `- Pages checked: ${report.pages.length}`,
  `- Interactions: ${report.interactions.length - failedInteractions.length}/${report.interactions.length} passed`,
  `- Page/overflow failures: ${failedPages.length}`,
  `- Axe violations: ${axeViolations.length}`,
  `- Console errors: ${report.consoleErrors.length}`,
  `- Page errors: ${report.pageErrors.length}`,
  `- Failed requests: ${report.failedRequests.length}`,
  "",
  "## Pages",
  "",
  "| Page | Status | H1 | Overflow | Axe |",
  "| --- | --- | --- | --- | --- |",
  ...report.pages.map((p) => `| ${p.name} | ${p.status ?? "error"} | ${String(p.h1 ?? "").replaceAll("|", "\\|").slice(0, 70)} | ${p.horizontalOverflow ? "FAIL" : "ok"} | ${p.axe.length} |`),
  "",
  "## Interactions",
  "",
  ...report.interactions.map((i) => `- ${i.ok ? "PASS" : "FAIL"} · ${i.name}${i.error ? ` — ${i.error}` : ""}`),
  "",
  "## Axe violations",
  "",
  ...(axeViolations.length ? axeViolations.map((v) => `- ${v.page}: ${v.id} (${v.impact}) ${v.help} — ${v.targets.join(", ")}`) : ["- None"]),
  "",
  "## Console errors",
  "",
  ...(report.consoleErrors.length ? report.consoleErrors.map((e) => `- ${e.page}: ${e.text}`) : ["- None"]),
  "",
  "## Failed requests",
  "",
  ...(report.failedRequests.length ? report.failedRequests.map((e) => `- ${e.page}: ${e.url} (${e.failure})`) : ["- None"]),
  "",
  "## Errors",
  "",
  ...(report.errors.length ? report.errors.map((e) => `- ${JSON.stringify(e)}`) : ["- None"]),
  "",
  "Screenshots are in `.data/workforce-qa/screens/`.",
].join("\n");
fs.writeFileSync(path.join(OUT, "report.md"), md);
console.log(md);
process.exit(failedPages.length || failedInteractions.length || report.errors.length ? 1 : 0);
