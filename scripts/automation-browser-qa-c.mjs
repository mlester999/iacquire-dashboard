// Signed-in browser QA of the Phase C additions to Automation Studio, against the isolated local app (scripts/automation-qa.mjs, seeded by
// scripts/run-automation-qa-seed.mjs) in real Chromium: the ready-made automations, graph editing by drag (palette to canvas, line between steps,
// delete, undo), Slack and HTTP step settings, the Connections page, the Usage page and the agency's plan controls.
//
//   node scripts/automation-browser-qa-c.mjs [--headed]
//
// Nothing here sends anything outside the machine: no workflow is switched on, no test is confirmed, no payment is recorded. The fictional QA accounts sign in
// through the real local sign-in page; passwords are read by this script only and never printed. Any other origin is blocked and counted.
// Output: .data/automation-qa/report-c.json and .data/automation-qa/screens-c/*.png. Exit code 1 when a check failed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AUTOMATION_QA_DATA_DIR, AUTOMATION_QA_URL } from "./automation-qa-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, AUTOMATION_QA_DATA_DIR);
const SCREENS = path.join(DATA, "screens-c");
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
const lastPages = [];
/** Everything the browser asked a server to do (not page loads), to prove nothing outside the sandbox was contacted. */
const posts = [];

async function person(role, { width = 1280, height = 800, theme = "light" } = {}) {
  const user = creds.users[role];
  const context = await browser.newContext({ baseURL: BASE, viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "no-preference", locale: "en-US", timezoneId: "America/Chicago" });
  context.setDefaultNavigationTimeout(300_000);
  context.setDefaultTimeout(120_000);
  await context.route((url) => !isLocal(url.href), (route) => { report.errors.blockedExternal.push(route.request().url()); return route.abort("blockedbyclient").catch(() => {}); });
  await context.routeWebSocket((url) => !isLocal(url.href), (ws) => { report.errors.blockedExternal.push(ws.url()); ws.close(); });
  await context.addInitScript((t) => { try { localStorage.setItem("iaq-tour-v1", "done"); localStorage.setItem("iaq-theme", t); } catch { /* storage blocked */ } }, theme);
  const page = await context.newPage();
  lastPages.length = 0;
  lastPages.push(page);
  page.on("console", (m) => { if (m.type() === "error") report.errors.console.push(`${role}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => report.errors.page.push(`${role}: ${page.url().replace(BASE, "")} ${(e.message || String(e)).slice(0, 2500)}`));
  page.on("requestfailed", (r) => { const f = r.failure()?.errorText ?? ""; if (isLocal(r.url()) && !/ERR_ABORTED/.test(f)) report.errors.failedRequests.push(`${role}: ${r.url().replace(BASE, "")} ${f}`); });
  page.on("response", (r) => { if (r.status() >= 500) report.errors.serverErrors.push(`${role}: ${r.status()} ${r.url().replace(BASE, "")}`); });
  page.on("request", (r) => { if (r.method() === "POST") posts.push({ role, url: r.url().replace(BASE, ""), action: r.headers()["next-action"] ?? null }); });
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
const hydrated = (page, selector) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, selector, { timeout: 300_000 });
const nodes = (page) => page.locator(".react-flow__node").count();
const edges = (page) => page.locator(".react-flow__edge").count();
const body = (page) => page.textContent("body").then((t) => t ?? "");
const SECRETS = ["QaPlaceholderNotARealWebhook", "qa-placeholder-token-0001", "hooks.slack.com/services"];

async function setUp(page, templateKey, choices = {}) {
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 180_000 });
  await hydrated(page, "#studio-prompt");
  const card = page.locator(`[data-template="${templateKey}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "Set up" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  for (const [label, value] of Object.entries(choices)) await dialog.getByLabel(label).selectOption({ label: value });
  await dialog.getByRole("button", { name: "Create automation" }).click();
  await page.waitForURL(/\/automation-studio\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  await page.locator("[data-studio-workspace]").waitFor({ timeout: 180_000 });
  await hydrated(page, "[data-studio-workspace]");
  await page.locator(".react-flow__node").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
}

async function main() {
  const owner = await person("owner");
  const page = owner.page;

  // ------------------------------------------------------------------ Home: the template gallery
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 180_000 });
  await hydrated(page, "#studio-prompt");
  const gallery = page.locator("#studio-templates").locator("xpath=ancestor::section");
  check("templates: the gallery heading is there", await page.getByRole("heading", { name: "Ready-made automations" }).count());
  check("templates: twenty ready-made automations", (await gallery.locator("[data-template]").count()) === 20, `n=${await gallery.locator("[data-template]").count()}`);
  check("templates: the home links to Connections and Usage", (await page.locator("a[href='/automation-studio/connections']").count()) > 0 && (await page.locator("a[href='/automation-studio/usage']").count()) > 0);
  // The links sit above the main card with room to spare (a negative bottom margin once pulled the card up over them: Tailwind 4's space-y sets the margin the other way round).
  const linksGap = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll("main a")).find((a) => /Usage and plan/.test(a.textContent ?? ""));
    const card = document.querySelector("section[aria-labelledby='studio-headline']");
    return link && card ? Math.round(card.getBoundingClientRect().top - link.getBoundingClientRect().bottom) : null;
  });
  check("layout: the Usage and Connections links sit above the main card, not under it", linksGap !== null && linksGap >= 8, `gap=${linksGap}px`);
  await gallery.getByRole("button", { name: "Other systems", exact: true }).click();
  check("templates: a category filters the cards", (await gallery.locator("[data-template]").count()) === 3);
  const sync = gallery.locator('[data-template="lead-sync-http"]');
  check("templates: an HTTP template says its connection isn't verified, and is still available to set up", /hasn't been verified/.test((await sync.textContent()) ?? "") && (await sync.getByRole("button", { name: "Set up" }).isEnabled()));
  check("templates: what it reaches is stated on the card", /Calls another system/.test((await sync.textContent()) ?? ""));
  await gallery.getByRole("button", { name: /^All \(/ }).click();
  const slackCard = gallery.locator('[data-template="new-lead-slack-alert"]');
  check("templates: the Slack template is ready (the workspace has a Slack connection)", /Your workspace has what this needs/.test((await slackCard.textContent()) ?? ""));
  await slackCard.scrollIntoViewIfNeeded();
  await shot(page, "01-home-templates");
  await runAxe(page, "home with the template gallery (desktop, light)");

  // ------------------------------------------------------------------ A template needing nothing: edit its graph by hand
  await setUp(page, "speed-to-lead");
  check("template: it opens with the trigger and four steps on the canvas", (await nodes(page)) === 5, `nodes=${await nodes(page)}`);
  const startEdges = await edges(page);
  check("template: its steps are linked", startEdges >= 4, `edges=${startEdges}`);
  await shot(page, "02-template-speed-to-lead");
  await page.getByRole("radiogroup", { name: "Editing mode" }).getByText("Manual", { exact: true }).click();
  await page.getByPlaceholder("Search steps").waitFor({ timeout: 10_000 });
  check("manual: the palette offers the HTTP request and Slack steps", (await page.getByRole("button", { name: /HTTP request/ }).count()) > 0 && (await page.getByRole("button", { name: /Post to Slack/ }).count()) > 0);

  // Drag a step from the palette onto empty canvas.
  const before = await nodes(page);
  const canvas = page.locator(".react-flow");
  const box = await canvas.boundingBox();
  await page.getByRole("button", { name: /Add internal note|Internal note/ }).first().dragTo(canvas, { targetPosition: { x: Math.max(60, box.width - 260), y: Math.max(60, box.height - 140) } });
  await page.waitForTimeout(900);
  // The settings panel narrows the canvas: fit everything into view so every handle can be reached, as a person would with the fit-view button.
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(900);
  check("graph: dragging a step from the palette onto the canvas adds it", (await nodes(page)) === before + 1, `before=${before} after=${await nodes(page)}`);
  check("graph: the dropped step is not joined to anything yet", (await edges(page)) === startEdges, `edges=${await edges(page)}`);

  // Draw a line from the new step's in-handle: from the branch's "No" handle to the new step.
  const note = page.locator(".react-flow__node").filter({ hasText: /note/i }).last();
  const noteId = await note.getAttribute("data-id");
  const branch = page.locator(".react-flow__node").filter({ hasText: /Still new/ }).first();
  const noHandle = branch.locator(".react-flow__handle.source").nth(1);
  const target = note.locator(".react-flow__handle.target").first();
  const hb = await noHandle.boundingBox();
  const tb = await target.boundingBox();
  const area = await canvas.boundingBox();
  const inside = (r) => r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;
  check("graph: both handles are inside the visible canvas before drawing", inside(hb) && inside(tb), `from=${JSON.stringify(hb)} to=${JSON.stringify(tb)} canvas=${JSON.stringify(area)}`);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2 - 30, { steps: 12 });
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  check("graph: drawing a line between two steps connects them", (await edges(page)) === startEdges + 1, `edges=${await edges(page)} (was ${startEdges}) node=${noteId}`);
  await shot(page, "03-graph-edited");
  await page.locator('button[aria-label="Undo"]').click();
  await page.waitForTimeout(500);
  check("graph: undo removes the line", (await edges(page)) === startEdges, `edges=${await edges(page)}`);
  await page.locator('button[aria-label="Undo"]').click();
  await page.waitForTimeout(500);
  check("graph: undo removes the dropped step", (await nodes(page)) === before, `nodes=${await nodes(page)}`);

  // Delete a step from the keyboard and bring it back.
  await page.locator(".react-flow__node").filter({ hasText: /Urgent task/ }).first().click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(700);
  check("graph: deleting a selected step removes it", (await nodes(page)) === before - 1, `nodes=${await nodes(page)}`);
  await page.locator('button[aria-label="Undo"]').click();
  await page.waitForTimeout(500);
  check("graph: undo brings the deleted step back", (await nodes(page)) === before, `nodes=${await nodes(page)}`);

  // ------------------------------------------------------------------ A Slack template: settings show names, never the address
  await setUp(page, "new-lead-slack-alert", { "Slack connection": "Sales channel (verified)" });
  check("slack: it opens with the trigger and two steps", (await nodes(page)) === 3, `nodes=${await nodes(page)}`);
  await page.locator(".react-flow__node").filter({ hasText: /Slack/i }).first().click();
  const panel = page.getByRole("complementary", { name: "Step settings" });
  await panel.waitFor({ timeout: 15_000 });
  const panelText = (await panel.textContent()) ?? "";
  check("slack: the step settings name the connection and the message", /Sales channel/.test(panelText) && (await panel.locator("textarea").inputValue()).includes("{{contact.full_name}}"), panelText.slice(0, 200));
  check("slack: no webhook address or secret appears in the step settings", SECRETS.every((s) => !panelText.includes(s)));
  const pageText = await body(page);
  check("slack: nor in the rest of the page", SECRETS.every((s) => !pageText.includes(s)));
  await shot(page, "04-slack-step-settings");
  await runAxe(page, "workspace with a Slack step selected (desktop, light)");
  await page.getByRole("button", { name: /^Publish$/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor({ timeout: 15_000 });
  const dlgText = (await dlg.textContent()) ?? "";
  check("publish: it says the automation reaches outside the CRM and names Slack", /reaches outside your CRM/.test(dlgText) && /Slack/.test(dlgText), dlgText.slice(0, 300));
  check("publish: it says the owner must approve this exact version", /owner has to approve this exact version/.test(dlgText));
  await shot(page, "05-slack-publish-dialog");
  await page.keyboard.press("Escape");

  // ------------------------------------------------------------------ An HTTP template with a connection that isn't verified: it can't be published
  await setUp(page, "booking-sync-http", { "HTTP connection": "Operations API, api.example.com (not verified yet)" });
  await page.locator(".react-flow__node").filter({ hasText: /Send the booking|HTTP/i }).first().click();
  await panel.waitFor({ timeout: 15_000 });
  const http = (await panel.textContent()) ?? "";
  check("http: the step shows the connection, its host and the method", /Operations API/.test(http) && /api\.example\.com/.test(http) && (await panel.locator("select").first().inputValue()).length > 0, http.slice(0, 240));
  check("http: nothing secret is on the page", SECRETS.every((s) => !http.includes(s)));
  // With a problem in the draft the toolbar offers "N to fix" instead of Publish: the person is told what, in words, and can't publish past it.
  const fix = page.getByRole("button", { name: /to fix/ });
  check("http: publishing is replaced by a count of what needs fixing", (await fix.count()) === 1 && (await page.getByRole("button", { name: /^Publish$/ }).count()) === 0);
  check("http: that button is disabled, so a version can't be published past the problem", await fix.isDisabled());
  const pubText = ((await panel.textContent()) ?? "").replace(/\s+/g, " ");
  check("http: the step's own settings say in words that the connection hasn't been verified yet", /hasn't been verified yet/.test(pubText), pubText.slice(0, 240));
  await shot(page, "06-http-unverified");
  await page.keyboard.press("Escape");

  // ------------------------------------------------------------------ Connections page
  await page.goto("/automation-studio/connections", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Connections" }).waitFor({ timeout: 240_000 });
  await hydrated(page, "h1");
  const list = page.getByRole("list", { name: "Connections" });
  check("connections: both seeded connections are listed", (await list.locator("> li").count()) === 2, `n=${await list.locator("> li").count()}`);
  const connText = await body(page);
  check("connections: no secret or webhook address is shown", SECRETS.every((s) => !connText.includes(s)));
  check("connections: the status of each is stated (verified and not verified)", /Verified/.test(connText) && /Not verified yet/.test(connText));
  check("connections: says Slack sign-in isn't available yet (no OAuth claim)", /Signing in with Slack to pick channels isn’t available yet/.test(connText));
  await shot(page, "07-connections");
  await runAxe(page, "connections (desktop, light)");

  // Refusals shown to the person, in words, from the server.
  await page.getByRole("button", { name: /Add connection/ }).click();
  const add = page.getByRole("dialog");
  await add.waitFor();
  await add.getByRole("radio", { name: /HTTP API/ }).click();
  await add.getByLabel("Name").fill("Metadata probe");
  for (const [address, expect] of [["http://api.example.com", /https/i], ["https://169.254.169.254/latest", /./], ["https://localhost/x", /./]]) {
    await add.getByLabel("Address").fill(address);
    await add.getByLabel("Token").fill("a-placeholder-token-123");
    await add.getByRole("button", { name: "Save connection" }).click();
    const toast = page.locator("[data-sonner-toast]").last();
    await toast.waitFor({ timeout: 30_000 });
    const msg = (await toast.textContent()) ?? "";
    check(`connections: ${address} is refused with a reason`, expect.test(msg) && !/saved/i.test(msg), msg);
    await page.waitForTimeout(400);
  }
  await shot(page, "08-connection-refused");
  await add.getByRole("button", { name: "Cancel" }).click();
  check("connections: nothing was created by the refused attempts", (await list.locator("> li").count()) === 2);

  // Verify asks first and says what it will send; cancel sends nothing.
  const sentBefore = posts.length;
  await list.locator("> li").filter({ hasText: "Operations API" }).getByRole("button", { name: /Verify with a test/ }).click();
  const verify = page.getByRole("dialog");
  await verify.waitFor();
  const vtext = (await verify.textContent()) ?? "";
  check("verify: it says one GET request and where it goes", /one GET request/.test(vtext) && /api\.example\.com\/v1\/ping/.test(vtext), vtext.slice(0, 240));
  await shot(page, "09-verify-dialog");
  await verify.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(500);
  check("verify: cancelling sends no request to the server", posts.length === sentBefore, `posts=${posts.length - sentBefore}`);
  await list.locator("> li").filter({ hasText: "Sales channel" }).getByRole("button", { name: /Recent calls/ }).click();
  const calls = page.getByRole("dialog");
  await calls.waitFor();
  await page.waitForTimeout(1500);
  check("calls: a connection nothing was sent through says so", /Nothing has been sent through this connection yet/.test((await calls.textContent()) ?? ""));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More actions for Sales channel" }).click();
  await page.getByRole("menuitem", { name: /Revoke/ }).click();
  const revoke = page.getByRole("dialog");
  await revoke.waitFor();
  check("revoke: asks first and says the secret is erased for good", /erased for good/.test((await revoke.textContent()) ?? ""));
  await revoke.getByRole("button", { name: "Cancel" }).click();
  check("revoke: cancelling leaves both connections", (await list.locator("> li").count()) === 2);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/automation-studio/connections", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Connections" }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(600);
  check("connections (phone): no sideways scroll", (await overflow(page)) <= 1, `overflow=${await overflow(page)}`);
  await shot(page, "10-connections-phone", { fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });

  // ------------------------------------------------------------------ Usage page
  await page.goto("/automation-studio/usage", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Usage and plan" }).waitFor({ timeout: 240_000 });
  await hydrated(page, "h1");
  const bars = await page.getByRole("progressbar").count();
  check("usage: a progress bar for each limit", bars === 7, `bars=${bars}`);
  const ut = await body(page);
  check("usage: the plan is shown as active, with a real link to manage it", /Active/.test(ut) && (await page.locator("a[href='/maintenance']").count()) > 0);
  check("usage: no cost or token-price figures are shown to the client", !/\$[0-9]+\.[0-9]{2,}|micro|cost/i.test(ut.replace(/\$299/g, "")));
  check("usage: the automations built in this run are listed", (await page.locator("section[aria-labelledby=usage-workflows] li").count()) >= 3, `n=${await page.locator("section[aria-labelledby=usage-workflows] li").count()}`);
  await shot(page, "11-usage");
  await runAxe(page, "usage (desktop, light)");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/automation-studio/usage", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Usage and plan" }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(600);
  check("usage (phone): no sideways scroll", (await overflow(page)) <= 1, `overflow=${await overflow(page)}`);
  await page.setViewportSize({ width: 1280, height: 800 });

  // ------------------------------------------------------------------ Dark theme
  await owner.context.addInitScript(() => { try { localStorage.setItem("iaq-theme", "dark"); } catch { /* */ } });
  await page.goto("/automation-studio/connections", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Connections" }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  await shot(page, "12-connections-dark");
  await runAxe(page, "connections (desktop, dark)");
  await page.goto("/automation-studio/usage", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "Usage and plan" }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  await runAxe(page, "usage (desktop, dark)");
  await owner.context.close();

  // ------------------------------------------------------------------ Agency: the plan's lifecycle controls (looked at, never submitted)
  const admin = await person("agency_admin");
  const ap = admin.page;
  await ap.goto("/admin/maintenance", { waitUntil: "domcontentloaded" });
  await ap.getByText("Client maintenance plans").first().waitFor({ timeout: 240_000 });
  await ap.getByRole("button", { name: "Active", exact: true }).click().catch(() => {});
  const block = ap.locator("[aria-label='Automation Studio plan']").first();
  await block.waitFor({ timeout: 60_000 });
  // The page is server-rendered first: a click before React has attached to it is lost, as for any person quicker than the page.
  await hydrated(ap, "[aria-label='Automation Studio plan'] button");
  const bt = (await block.textContent()) ?? "";
  check("agency: the plan card shows where the money side stands and what a lapse would touch", /Paid through/.test(bt) && /Last verified/.test(bt) && /Studio workflows/.test(bt), bt.slice(0, 200));
  check("agency: the controls are labelled as recording, never charging", (await block.getByRole("button", { name: /Record failed payment/ }).count()) === 1 && (await block.getByRole("button", { name: /Record verified payment/ }).count()) === 1);
  await block.getByRole("button", { name: /Record verified payment/ }).click();
  const pay = ap.getByRole("dialog");
  await pay.waitFor();
  const record = pay.getByRole("button", { name: "Record payment" });
  check("agency: a payment can't be recorded until the person confirms they verified it", await record.isDisabled());
  check("agency: the dialog says iAcquire does not charge or detect payments", /does not charge cards or detect payments/.test((await pay.textContent()) ?? ""));
  await shot(ap, "13-agency-record-payment");
  await runAxe(ap, "agency record-payment dialog (desktop, light)");
  const postsBefore = posts.length;
  await pay.getByRole("button", { name: "Cancel" }).click();
  await block.getByRole("button", { name: /Record failed payment/ }).click();
  const fail = ap.getByRole("dialog");
  await fail.waitFor();
  check("agency: the failed-payment dialog shows the default grace period of 7 days", (await fail.getByLabel("Grace period (days)").inputValue()) === "7");
  await fail.getByRole("button", { name: "Cancel" }).click();
  check("agency: cancelling both dialogs changed nothing", posts.length === postsBefore, `posts=${posts.length - postsBefore}`);
  await admin.context.close();
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
fs.writeFileSync(path.join(DATA, "report-c.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.checks.length - bad.length}/${report.checks.length} checks passed; page errors ${report.errors.page.length}, console errors ${report.errors.console.length}, failed requests ${report.errors.failedRequests.length}, 5xx ${report.errors.serverErrors.length}, blocked external ${report.errors.blockedExternal.length}`);
for (const k of ["page", "serverErrors", "blockedExternal", "failedRequests", "console"]) for (const m of [...new Set(report.errors[k])].slice(0, 8)) console.log(`  ${k}: ${m}`);
process.exit(failed || bad.length || unclean ? 1 : 0);
