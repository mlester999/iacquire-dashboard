// Signed-in browser QA of AQi Operations against the isolated local app (scripts/ops-qa.mjs on http://127.0.0.1:3230, seeded by
// scripts/run-ops-qa-seed.mjs, AI provider = the loopback mock scripts/ops-mock-llm.mjs). Real Chromium, real local sign-in per user
// (credentials are read from the gitignored .data/crm-qa/ops-credentials.local.json and never printed). The browser talks to the QA server
// only: any other origin is blocked before the network and counted as a failure.
//
//   node scripts/ops-browser-qa.mjs [--headed]
//   PLAYWRIGHT_MODULE=<path to an installed playwright/index.mjs> (Playwright is not a project dependency)
// Output: .data/crm-qa/ops-report.json and .data/crm-qa/screens/ops-*.png. Exit code 0 only when every check passed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CRM_QA_DATA_DIR, CRM_QA_URL } from "./crm-qa-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, CRM_QA_DATA_DIR);
const SCREENS = path.join(DATA, "screens");
const AXE = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const NO_MOTION = "*,*::before,*::after{transition:none!important;animation:none!important}nextjs-portal{display:none!important}";
const headed = process.argv.includes("--headed");

const playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) { console.error("Set PLAYWRIGHT_MODULE to an installed playwright/index.mjs."); process.exit(2); }
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)).href);
const credentials = JSON.parse(fs.readFileSync(path.join(DATA, "ops-credentials.local.json"), "utf8")).users;
fs.mkdirSync(SCREENS, { recursive: true });

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${detail}` : ""}`); };
const external = new Set();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await chromium.launch({ headless: !headed });

async function newUser(key, viewport = { width: 1280, height: 860 }, theme = "light") {
  const context = await browser.newContext({ baseURL: CRM_QA_URL, viewport, bypassCSP: true, reducedMotion: "reduce" });
  await context.addInitScript((t) => { try { localStorage.setItem("iaq-theme", t); localStorage.setItem("iaq-tour-v1", "done"); } catch { /* storage blocked */ } }, theme);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== CRM_QA_URL && !["data:", "blob:", "about:"].includes(url.protocol)) { external.add(url.origin); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  // The sign-in page's animated showcase reports a hydration warning under reduced motion; that page is not part of this work.
  // The negative probes below deliberately call endpoints that must answer 401/403; the browser logs those as "Failed to load resource".
  page.on("console", (m) => {
    if (m.type() !== "error" || new URL(page.url()).pathname.startsWith("/login")) return;
    if (key !== "superAdmin" && /status of 40[13]/.test(m.text())) return;
    consoleErrors.push({ user: key, text: m.text().slice(0, 300) });
  });
  page.on("pageerror", (e) => pageErrors.push({ user: key, text: String(e).slice(0, 300) }));
  page.on("requestfailed", (r) => { if (!/_next\/webpack-hmr|net::ERR_ABORTED/.test(`${r.url()} ${r.failure()?.errorText}`)) failedRequests.push({ user: key, url: r.url().slice(0, 160), error: r.failure()?.errorText }); });
  const user = credentials[key];
  await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => { const el = document.querySelector("#email"); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: 120_000 }).catch(() => {});
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.locator("form button[type=submit]").first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }).catch(() => {});
  if (new URL(page.url()).pathname.startsWith("/login")) throw new Error(`Sign-in failed for ${key}`);
  // Signing in is a soft navigation (a server action redirects). The launcher chosen for this person must already be right,
  // without a full reload, or a Super Admin would briefly be offered the Client assistant and a client the Operations launcher.
  await page.waitForFunction(() => Boolean(document.querySelector("[data-aqi-launcher]")) || [...document.querySelectorAll("button")].some((b) => /^\s*AQi Operations\s*$/.test(b.textContent ?? "")), null, { timeout: 120_000 }).catch(() => {});
  const opsLauncher = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /^\s*AQi Operations\s*$/.test(b.textContent ?? "")));
  const clientLauncher = (await page.locator("[data-aqi-launcher]").count()) > 0;
  // /welcome (a new client's first page) is not a route where AQi is offered at all, so there the only requirement is that no Operations launcher appears.
  const landed = new URL(page.url()).pathname;
  check(`after signing in without a reload, ${key} is offered the right AQi launcher`, key === "superAdmin" ? opsLauncher && !clientLauncher : !opsLauncher && (clientLauncher || landed.startsWith("/welcome")), `ops=${opsLauncher} client=${clientLauncher} at ${landed}`);
  return { context, page };
}

/** In dev, React attaches handlers after the server HTML is visible; a click before then is lost. Wait for a hydrated control. */
const hydrated = (page, selector) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, selector, { timeout: 120_000 });
const settle = async (page) => { await page.addStyleTag({ content: NO_MOTION }).catch(() => {}); await page.waitForTimeout(250); };
const shot = async (page, name) => { await settle(page); await page.screenshot({ path: path.join(SCREENS, `ops-${name}.png`), fullPage: false }); };
const axe = async (page, label) => {
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(async () => {
    // The notification bell's unread badge (src/components/notifications/notification-center.tsx, not part of this work) is
    // animated and reports a contrast and label-mismatch finding whenever the account has unread notifications; it is left out
    // so this suite measures the Operations surfaces. It is listed as a follow-up in docs/aqi-operations.md.
    const r = await window.axe.run({ exclude: [['button[aria-label^="Notifications"]']] }, { resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(" ").slice(0, 120) }));
  });
  const bad = result.filter((v) => v.impact === "serious" || v.impact === "critical");
  check(`axe: no serious or critical violations (${label})`, bad.length === 0, JSON.stringify(bad));
  return result;
};
const noOverflow = async (page, label) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`no horizontal overflow (${label})`, overflow <= 1, `${overflow}px`);
};

async function waitAnswer(page, count) {
  await page.waitForFunction((n) => {
    const articles = [...document.querySelectorAll('article[aria-label="AQi Operations answer"]')];
    return articles.length >= n && articles[articles.length - 1].getAttribute("aria-busy") !== "true";
  }, count, { timeout: 90_000 });
}
const lastAnswer = (page) => page.locator('article[aria-label="AQi Operations answer"]').last();

try {
  // -------------------------------------------------------------------------
  // Super Admin: the console
  // -------------------------------------------------------------------------
  const sam = await newUser("superAdmin");
  const page = sam.page;
  await page.goto("/admin/operations", { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.getByRole("heading", { level: 1, name: "AQi Operations" }).waitFor({ timeout: 180_000 });
  await page.locator('ul[aria-label="Operational indicators"] > li').first().waitFor({ timeout: 120_000 });
  await hydrated(page, "#ops-composer-page");
  const tiles = await page.locator('ul[aria-label="Operational indicators"] > li').count();
  check("overview shows eight real indicators", tiles === 8, String(tiles));
  const overviewText = (await page.locator("#ops-overview-heading").locator("xpath=ancestor::section").innerText());
  check("overview shows no percentage", !/\d+\s?%/.test(overviewText));
  check("overview states what is not measured", /Not measured in this deployment/.test(overviewText));
  const healthTile = (await page.locator('ul[aria-label="Operational indicators"] > li').first().innerText()).replace(/\s+/g, " ");
  check("platform health is not reported as Healthy", /Platform health/.test(healthTile) && /(Unknown|Degraded|Unavailable)/.test(healthTile) && !/Healthy/.test(healthTile), healthTile);
  check("nav has the AQi Operations entry", (await page.getByRole("link", { name: "AQi Operations" }).count()) > 0);
  check("no Client AQi launcher for a Super Admin", (await page.locator("[data-aqi-launcher]").count()) === 0);
  await shot(page, "console-desktop");
  await axe(page, "console desktop");

  // Quick action -> a real answer with a health card and the mock narrative
  await page.getByRole("button", { name: /Investigate System Health/ }).click();
  await waitAnswer(page, 1);
  const first = lastAnswer(page);
  check("health card is rendered", (await first.getByRole("heading", { name: "Platform health" }).count()) === 1);
  const healthText = await first.innerText();
  check("health card lists unmeasured telemetry", /Not measurable here/.test(healthText));
  check("narrative cites real evidence and drops the invented id", /What the evidence shows/.test(healthText) && /\[E1\]/.test(healthText) && !/\[E9\]/.test(healthText), healthText.slice(0, 300));
  check("evidence list names its sources", (await first.locator("details summary", { hasText: "Evidence and sources" }).count()) === 1);
  await shot(page, "health-answer");

  // Refresh re-reads the system
  const before = await first.locator("section footer time").first().getAttribute("datetime");
  await page.waitForTimeout(1100);
  await first.getByRole("button", { name: "Refresh Platform health" }).click();
  await page.waitForFunction(([sel, old]) => { const t = document.querySelector(sel); return t && t.getAttribute("datetime") !== old; }, ['article[aria-label="AQi Operations answer"] section footer time', before], { timeout: 60_000 }).catch(() => {});
  const after = await first.locator("section footer time").first().getAttribute("datetime");
  check("Refresh re-reads the data (the as-of time moves)", after !== before, `${before} -> ${after}`);

  // Scope: choose a client, ask, and see operational blockers (and only that client's data)
  await page.getByRole("button", { name: /Change investigation context/ }).click();
  await page.getByRole("textbox", { name: "Search for an investigation context" }).fill("Aster");
  await page.getByRole("button", { name: /Aster Homes/ }).first().click();
  await page.waitForFunction(() => document.querySelector('button[aria-label$="Change investigation context"]')?.textContent?.includes("Aster Homes"));
  check("scope chip shows the verified client", /Aster Homes/.test(await page.locator('button[aria-label$="Change investigation context"]').innerText()));
  await page.locator("#ops-composer-page").fill("What is blocking this client's onboarding?");
  await page.locator('button[aria-label="Send"]').click();
  await waitAnswer(page, 2);
  const second = lastAnswer(page);
  const secondText = await second.innerText();
  check("workspace card shows the blocked setup task and its reason", /Verify the sending domain/.test(secondText) && /DNS records/.test(secondText));
  check("workspace card shows the failing connection", /ghl|GoHighLevel/i.test(secondText));
  check("another client's data does not appear in this client's context", !/Birchwood|Cedar Roofing/.test(secondText));
  await shot(page, "tenant-answer");

  // Hermes status for the client: honest vocabulary, no scheduled work
  await page.locator("#ops-composer-page").fill("What are this client's AI Employees doing?");
  await page.locator('button[aria-label="Send"]').click();
  await waitAnswer(page, 3);
  const employees = await lastAnswer(page).innerText();
  check("employee states use evidence (Failed / Offline / Waiting for approval)", /Failed/.test(employees) && /Offline/.test(employees) && /Waiting for approval/.test(employees), employees.slice(0, 400));
  check("no employee is reported as Scheduled", !/\bScheduled\b/.test(employees.replace(/Scheduled work is not reported/, "")));

  // Action: internal issue -> preview -> confirm -> verified result
  await page.getByRole("button", { name: /Inspect Client Workspace|Create Internal Issue/ }).first().waitFor();
  await page.locator('button[aria-label^="Clear context"]').click();
  // AQi Operations reports on itself from recorded runs, not from estimates.
  await page.locator("#ops-composer-page").fill("How is AQi performing? Any tool failures or slow checks?");
  await page.locator('button[aria-label="Send"]').click();
  await waitAnswer(page, 4);
  const selfText = await lastAnswer(page).innerText();
  check("AQi reports its own tool runs and model usage", /Tool runs, last 7 days/.test(selfText) && /Model usage and actions/.test(selfText), selfText.slice(0, 300));
  check("AQi's own latency is shown from measured runs only", /Median ms/i.test(selfText) && !/NaN|undefined/.test(selfText));

  // A marker unique to this run, so a request left behind by an earlier run of the suite cannot be mistaken for one created now.
  const marker = `QA check ${Date.now().toString(36)}`;
  await page.locator("#ops-composer-page").fill(`Create an internal issue: ${marker} scheduler heartbeat is visible on System health`);
  await page.locator('button[aria-label="Send"]').click();
  await waitAnswer(page, 5);
  const preview =page.locator('[data-testid="ops-action-preview"]').last();
  await preview.waitFor({ timeout: 60_000 });
  check("an action is only a preview until confirmed", /Waiting for your confirmation/.test(await preview.innerText()));
  const supportBefore = await page.evaluate(async (text) => (await (await fetch("/admin/support")).text()).includes(text), marker);
  check("nothing was created before confirmation", !supportBefore);
  await preview.getByRole("button", { name: "Confirm and run" }).click();
  await page.locator('[data-testid="ops-action-result"]').last().waitFor({ timeout: 60_000 });
  const resultCard = page.locator('[data-testid="ops-action-result"]').last();
  const result = await resultCard.innerText();
  check("result is reported only after verification", /Done and verified/.test(result) && /what the system shows now/i.test(result), result.slice(0, 200));
  await shot(page, "action-result");
  const requestHref = await resultCard.getByRole("link", { name: "Open the request" }).getAttribute("href");
  const createdVisible = await page.evaluate(async ([href, text]) => { const r = await fetch(href); return r.ok && (await r.text()).includes(text); }, [requestHref, marker]);
  check("the new request exists in Support & Requests", createdVisible, String(requestHref));

  // Typed confirmation for a high-impact action
  await page.getByRole("button", { name: /Change investigation context/ }).click();
  await page.getByRole("textbox", { name: "Search for an investigation context" }).fill("Cedar");
  await page.getByRole("button", { name: /Cedar Roofing/ }).first().click();
  await page.waitForFunction(() => document.querySelector('button[aria-label$="Change investigation context"]')?.textContent?.includes("Cedar Roofing"));
  await page.locator("#ops-composer-page").fill("Pause automation for this client: QA pause test");
  await page.locator('button[aria-label="Send"]').click();
  await waitAnswer(page, 6);
  const pausePreview = page.locator('[data-testid="ops-action-preview"]').last();
  await pausePreview.waitFor({ timeout: 60_000 });
  check("high-impact preview asks for typed confirmation", /Typed confirmation/.test(await pausePreview.innerText()) && /High impact/.test(await pausePreview.innerText()));
  await pausePreview.getByRole("button", { name: "Review and confirm" }).click();
  const dialog = page.getByRole("dialog");
  const confirmButton = dialog.getByRole("button", { name: "Confirm and run" });
  check("confirm is disabled until reason and phrase are given", await confirmButton.isDisabled());
  await dialog.getByLabel("Why are you doing this?").fill("QA: verifying the confirmation control");
  check("confirm stays disabled with only a reason", await confirmButton.isDisabled());
  await dialog.getByRole("textbox").nth(1).fill("Cedar Roofing");
  check("confirm enables once both are valid", await confirmButton.isEnabled());
  await shot(page, "typed-confirmation");
  await axe(page, "confirmation dialog");
  await confirmButton.click();
  await page.locator('[data-testid="ops-action-result"]').last().waitFor({ timeout: 60_000 });
  check("pause is verified from the system", /Done and verified/.test(await page.locator('[data-testid="ops-action-result"]').last().innerText()));

  // Resume it through the same confirmed path, so the QA data is left as it was found and the run can be repeated.
  await page.locator("#ops-composer-page").fill("Resume automation for this client: QA cleanup");
  await page.locator('button[aria-label="Send"]').click();
  await waitAnswer(page, 7);
  const resumePreview = page.locator('[data-testid="ops-action-preview"]').last();
  await resumePreview.waitFor({ timeout: 60_000 });
  await resumePreview.getByRole("button", { name: "Review and confirm" }).click();
  await page.getByRole("dialog").getByLabel("Why are you doing this?").fill("QA: restoring the data after the pause test");
  await page.getByRole("dialog").getByRole("textbox").nth(1).fill("Cedar Roofing");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm and run" }).click();
  await page.locator('[data-testid="ops-action-result"]').last().waitFor({ timeout: 60_000 });
  check("resume is verified from the system", /Done and verified/.test(await page.locator('[data-testid="ops-action-result"]').last().innerText()));

  // History restores cards and the current action state after a reload
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "AQi Operations" }).waitFor({ timeout: 120_000 });
  await hydrated(page, "#ops-composer-page");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Investigate system health/ }).first().click();
  await page.locator('article[aria-label="AQi Operations answer"]').first().waitFor({ timeout: 60_000 });
  const restored = await page.locator('[data-testid="ops-action-result"]').count();
  check("a reopened investigation shows the verified result, not the stale proposal", restored >= 1 && (await page.locator('[data-testid="ops-action-preview"]').first().innerText()).includes("Done and verified"));

  // Briefings
  await page.getByRole("button", { name: "Briefings" }).click();
  await page.getByRole("heading", { name: "Operations briefings" }).waitFor();
  check("briefings are opt-in", /Nothing is sent unless you turn it on here/.test(await page.getByRole("dialog").innerText()));
  await page.getByRole("button", { name: "Generate one now" }).click();
  await page.getByRole("heading", { name: /^Operations briefing: / }).first().waitFor({ timeout: 60_000 });
  const briefingText = await page.locator('[role="dialog"]').innerText();
  check("briefing states its period and data sources", /Reporting period/.test(briefingText) && /Data sources/.test(briefingText));
  await shot(page, "briefing");
  await page.keyboard.press("Escape");

  // Mobile layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/operations", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "AQi Operations" }).waitFor({ timeout: 120_000 });
  await page.locator('ul[aria-label="Operational indicators"] > li').first().waitFor({ timeout: 120_000 });
  await hydrated(page, "#ops-composer-page");
  await noOverflow(page, "console at 390px");
  await shot(page, "console-mobile");
  await axe(page, "console mobile");

  // Dark theme
  const dark = await newUser("superAdmin", { width: 1280, height: 860 }, "dark");
  await dark.page.goto("/admin/operations", { waitUntil: "domcontentloaded", timeout: 180_000 });
  await dark.page.locator('ul[aria-label="Operational indicators"] > li').first().waitFor({ timeout: 120_000 });
  await dark.page.addStyleTag({ content: NO_MOTION });
  await shot(dark.page, "console-dark");
  await axe(dark.page, "console dark");

  // The floating entry on another admin page is the Operations copilot, and it opens the same conversation workspace
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/admin/clients", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator('button[aria-controls="ops-launcher-panel"]').waitFor({ timeout: 120_000 });
  await hydrated(page, 'button[aria-controls="ops-launcher-panel"]');
  check("launcher on other admin pages is AQi Operations, not the Client assistant", (await page.locator("[data-aqi-launcher]").count()) === 0);
  await page.locator('button[aria-controls="ops-launcher-panel"]').click();
  await page.getByRole("dialog", { name: "AQi Operations" }).waitFor();
  await shot(page, "launcher-panel");
  await page.keyboard.press("Escape");
  check("Escape closes the panel and returns focus to the launcher", (await page.getByRole("dialog", { name: "AQi Operations" }).count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute("aria-controls"))) === "ops-launcher-panel");

  // -------------------------------------------------------------------------
  // Everyone else
  // -------------------------------------------------------------------------
  const maya = await newUser("manager");
  const redirected = await maya.page.goto("/admin/operations", { waitUntil: "domcontentloaded", timeout: 120_000 });
  // The server redirect is streamed through the App Router, so it can finish after the first document.
  await maya.page.waitForURL((u) => !u.pathname.startsWith("/admin/operations"), { timeout: 30_000 }).catch(() => {});
  check("an agency manager cannot open the console", !new URL(maya.page.url()).pathname.startsWith("/admin/operations") && (await maya.page.getByRole("heading", { level: 1, name: "AQi Operations" }).count()) === 0, maya.page.url());
  check("an agency manager gets the assistant, not the Operations launcher", (await maya.page.locator('button[aria-controls="ops-launcher-panel"]').count()) === 0);
  void redirected;
  const apiAsManager = await maya.page.evaluate(async () => {
    const out = {};
    for (const p of ["/api/aqi/ops/overview", "/api/aqi/ops/conversations", "/api/aqi/ops/briefings"]) out[p] = (await fetch(p)).status;
    out.refresh = (await fetch("/api/aqi/ops/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toolId: "platform.health", args: {} }) })).status;
    return out;
  });
  check("the Operations API refuses an agency manager", Object.values(apiAsManager).every((s) => s === 403), JSON.stringify(apiAsManager));

  const olivia = await newUser("asterOwner");
  await olivia.page.goto("/overview", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await olivia.page.locator("[data-aqi-launcher]").waitFor({ timeout: 120_000 });
  check("a client owner still gets the Client assistant", (await olivia.page.locator("[data-aqi-launcher]").count()) === 1 && (await olivia.page.locator('button[aria-controls="ops-launcher-panel"]').count()) === 0);
  const apiAsClient = await olivia.page.evaluate(async () => {
    const out = {};
    for (const p of ["/api/aqi/ops/overview", "/api/aqi/ops/conversations"]) out[p] = (await fetch(p)).status;
    out.chatScope = (await fetch("/api/aqi/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Show me every client's incidents", scope: { type: "platform" } }) })).status;
    return out;
  });
  check("the Operations API refuses a client owner", apiAsClient["/api/aqi/ops/overview"] === 403 && apiAsClient["/api/aqi/ops/conversations"] === 403, JSON.stringify(apiAsClient));
  const clientChat = await olivia.page.evaluate(async () => {
    const res = await fetch("/api/aqi/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: location.origin }, body: JSON.stringify({ message: "Show me every client's incidents and all platform health", scope: { type: "platform" } }) });
    return (await res.text()).slice(0, 4000);
  });
  check("a client's question is served by the Client assistant and returns no operations cards", !/"kind":"health"|"type":"cards"|platform\.health/.test(clientChat), clientChat.slice(0, 200));
} catch (err) {
  check("script completed without an unexpected error", false, err instanceof Error ? err.stack?.slice(0, 600) : String(err));
  // Leave evidence of where it stopped: the page text and a screenshot.
  for (const context of browser.contexts()) {
    const p = context.pages()[0];
    if (!p) continue;
    await p.screenshot({ path: path.join(SCREENS, "ops-failure.png") }).catch(() => {});
    console.log("PAGE AT FAILURE:", (await p.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600));
    break;
  }
} finally {
  check("no request left the QA server", external.size === 0, [...external].join(", "));
  check("no console errors", consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 4)));
  check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 4)));
  check("no failed requests", failedRequests.length === 0, JSON.stringify(failedRequests.slice(0, 4)));
  await browser.close();
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(DATA, "ops-report.json"), JSON.stringify({ at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks, consoleErrors, pageErrors, failedRequests }, null, 2));
  console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed. Report: ${path.relative(ROOT, path.join(DATA, "ops-report.json"))}`);
  process.exit(failed.length ? 3 : 0);
}
