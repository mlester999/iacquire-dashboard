// Signed-in browser QA for the AI Employees management <-> chat navigation, against the isolated local QA app
// (scripts/crm-qa.mjs; fictional records, embedded database, no provider or hosted service is contacted).
//
//   CRM_QA_PORT=3240 node scripts/crm-qa.mjs                       # in another terminal
//   PLAYWRIGHT_MODULE=<playwright/index.mjs> CHAT_QA_BASE=http://127.0.0.1:3240 CHAT_QA_LABEL=after CHAT_QA_MODE=all node scripts/chat-navigation-qa.mjs
//   CHAT_QA_MODE = screens (default: screenshots only) | behavior (assertions, measurements, axe) | all
//
// It never sends a chat message, never starts a model run and never changes an employee. Screenshots and a JSON report
// are written to docs/design-qa/chat-nav-polish/<label>/ (CHAT_QA_OUT overrides the folder).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = process.env.CHAT_QA_BASE ?? "http://127.0.0.1:3240";
const LABEL = process.env.CHAT_QA_LABEL ?? "after";
const OUT = process.env.CHAT_QA_OUT ?? path.join(ROOT, "docs/design-qa/chat-nav-polish", LABEL);
fs.mkdirSync(OUT, { recursive: true });

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) {
  console.error("Set PLAYWRIGHT_MODULE to an installed playwright index.mjs.");
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(modulePath).href);
const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, ".data/crm-qa/credentials.local.json"), "utf8"));
const summary = JSON.parse(fs.readFileSync(path.join(ROOT, ".data/crm-qa/employees-qa-summary.json"), "utf8"));

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 720 },
  tablet: { width: 820, height: 1100 },
  mobile: { width: 390, height: 844 },
};
const report = { base: BASE, label: LABEL, startedAt: new Date().toISOString(), checks: [], measurements: [], consoleErrors: [], pageErrors: [], screens: [] };
const only = (process.env.CHAT_QA_ONLY ?? "").split(",").filter(Boolean);
const wants = (name) => only.length === 0 || only.includes(name);

function check(name, ok, detail = "") {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// The sign-in form is rate limited (8 per account per 15 minutes), so each user signs in once per run and the
// session is reused for every viewport and theme.
const sessions = new Map();
async function newContext(browser, viewport, theme, storageState) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 600, storageState });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem("iaq-theme", t);
    } catch {}
  }, theme);
  context.__viewport = viewport;
  context.__theme = theme;
  return context;
}

async function signIn(context, user) {
  const saved = sessions.get(user.email);
  if (saved) {
    const reused = await newContext(await context.browser(), context.__viewport ?? { width: 1440, height: 900 }, context.__theme ?? "light", saved);
    await context.close();
    const page = await reused.newPage();
    page.on("console", (m) => m.type() === "error" && report.consoleErrors.push({ url: page.url(), text: m.text().slice(0, 1800) }));
    page.on("pageerror", (e) => report.pageErrors.push({ url: page.url(), text: String(e).slice(0, 300) }));
    return page;
  }
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && report.consoleErrors.push({ url: page.url(), text: m.text().slice(0, 1800) }));
  page.on("pageerror", (e) => report.pageErrors.push({ url: page.url(), text: String(e).slice(0, 300) }));
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#email");
    return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  }, null, { timeout: 120_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.locator("#email").fill("");
    await page.locator("#password").fill("");
    await page.locator("#email").pressSequentially(user.email, { delay: 8 });
    await page.locator("#password").pressSequentially(user.password, { delay: 8 });
    if (await page.locator("form button[type=submit]").first().isEnabled().catch(() => false)) break;
    await page.waitForTimeout(600);
  }
  await page.locator("form button[type=submit]").first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }).catch(() => {});
  if (new URL(page.url()).pathname.startsWith("/login")) {
    const message = (await page.locator("[role=alert]").first().textContent().catch(() => "")) || "still on the sign-in page";
    throw new Error(`Sign-in failed for ${user.email}: ${message.trim().slice(0, 200)}`);
  }
  sessions.set(user.email, await context.storageState());
  return page;
}

async function settle(page) {
  // The Next.js dev indicator is not part of the product UI; keep it out of design screenshots.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  // The onboarding tour and the AQi launcher both start on a timer; dismiss the tour so it cannot cover a screenshot.
  const skip = page.getByRole("button", { name: /^Skip$/ });
  await skip.waitFor({ state: "visible", timeout: 1_500 }).catch(() => {});
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  await page.waitForTimeout(500);
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 80, fullPage: false }).catch(() => {});
  report.screens.push(path.basename(file));
}

async function visit(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await settle(page);
}

const luminance = ([r, g, b]) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const MODE = process.env.CHAT_QA_MODE ?? "screens"; // screens | behavior | all
const browser = await chromium.launch({ headless: true });
const owner = credentials.users.owner;
const conversationId = summary.brightside.conversationId;
const salesAssistantConversation = `/chat/sales-assistant?c=${conversationId}`;

async function runScreens() {
  for (const theme of ["light", "dark"]) {
    for (const vp of ["desktop", "laptop"]) {
      if (!wants(vp)) continue;
      const context = await newContext(browser, VIEWPORTS[vp], theme);
      const page = await signIn(context, owner);
      await visit(page, "/employees");
      await shot(page, `management-gallery-${vp}-${theme}`);
      await visit(page, "/employees/lead-hunter");
      await shot(page, `management-profile-${vp}-${theme}`);
      await visit(page, "/chat/lead-hunter");
      await shot(page, `chat-empty-${vp}-${theme}`);
      await visit(page, salesAssistantConversation);
      await shot(page, `chat-conversation-${vp}-${theme}`);
      if (vp === "desktop") {
        await page.getByRole("button", { name: "Collapse sidebar" }).click();
        await page.waitForTimeout(400);
        await shot(page, `chat-collapsed-${vp}-${theme}`);
      }
      await context.close();
    }
    for (const vp of ["mobile", "tablet"]) {
      if (!wants(vp)) continue;
      const context = await newContext(browser, VIEWPORTS[vp], theme);
      const page = await signIn(context, owner);
      await visit(page, salesAssistantConversation);
      await shot(page, `chat-conversation-${vp}-${theme}`);
      await page.getByRole("button", { name: "Open chat navigation" }).click().catch(() => {});
      await page.mouse.move(200, 400);
      await page.waitForTimeout(700);
      await shot(page, `chat-drawer-${vp}-${theme}`);
      await context.close();
    }
  }
}

/** The measured colours of the wordmark and rail text against the rail's own background, in the live page. */
async function measureBrand(page, label) {
  const m = await page.evaluate(() => {
    const parse = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const nav = [...document.querySelectorAll("nav.workspace-nav")].find((n) => n.getBoundingClientRect().width > 0);
    if (!nav) return null;
    const word = nav.querySelector(".logo-word");
    const accent = nav.querySelector(".logo-accent");
    const muted = nav.querySelector(".workspace-nav-section");
    const bg = parse(getComputedStyle(nav).backgroundColor);
    const stops = (getComputedStyle(accent).backgroundImage.match(/rgb\([^)]*\)/g) ?? []).map(parse);
    return {
      bg,
      word: parse(getComputedStyle(word).color),
      accentStops: stops,
      accentFill: getComputedStyle(accent).webkitTextFillColor,
      section: muted ? parse(getComputedStyle(muted).color) : null,
      wordBox: (() => { const r = word.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };
  });
  if (!m) return check(`${label}: rail present`, false);
  const wordRatio = ratio(m.word, m.bg);
  const stopRatios = m.accentStops.map((s) => ratio(s, m.bg));
  report.measurements.push({ label, ...m, wordRatio: +wordRatio.toFixed(2), accentRatios: stopRatios.map((r) => +r.toFixed(2)) });
  check(`${label}: "i" wordmark contrast >= 7:1`, wordRatio >= 7, `${wordRatio.toFixed(1)}:1`);
  check(`${label}: "Acquire" wordmark gradient contrast >= 7:1`, stopRatios.length >= 2 && stopRatios.every((r) => r >= 7), stopRatios.map((r) => r.toFixed(1)).join(", "));
  if (m.section) check(`${label}: section label contrast >= 7:1`, ratio(m.section, m.bg) >= 7, `${ratio(m.section, m.bg).toFixed(1)}:1`);
}

async function runAxe(page, label, scope = "nav.workspace-nav") {
  try {
    await page.addScriptTag({ path: path.join(ROOT, "node_modules/axe-core/axe.min.js") });
    const result = await page.evaluate(async (selector) => {
      const nodes = [...document.querySelectorAll(selector)].filter((n) => n.getBoundingClientRect().width > 0);
      const out = [];
      for (const node of nodes) {
        const r = await window.axe.run(node, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
        out.push(...r.violations.map((v) => ({ id: v.id, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })));
      }
      return out;
    }, scope);
    check(`${label}: axe (WCAG 2.1 AA) finds no violations in the sidebar`, result.length === 0, JSON.stringify(result).slice(0, 400));
  } catch (err) {
    check(`${label}: axe ran`, false, String(err).slice(0, 200));
  }
}

async function runBehavior() {
  // ---------------- owner, desktop, dark ----------------
  if (wants("desktop-dark")) {
    const context = await newContext(browser, VIEWPORTS.desktop, "dark");
    const page = await signIn(context, owner);
    const sends = [];
    page.on("request", (req) => {
      const url = req.url();
      if (req.method() === "POST" && /\/api\/chat\/(send|runs)/.test(url)) sends.push(url);
    });

    // 1. Management click opens management.
    await visit(page, "/employees/lead-hunter");
    await measureBrand(page, "management/dark");
    await page.locator('nav[aria-label="Main"] a[href="/employees/operations-manager"]').click();
    await page.waitForURL(/\/employees\/operations-manager/, { timeout: 60_000 });
    check("management: selecting an employee opens the profile, not chat", /\/employees\/operations-manager$/.test(page.url()), page.url());
    check("management: profile heading is the selected employee", (await page.locator("h1").first().textContent())?.includes("Operations Manager"));
    check("management: no chat shortcut for an employee that cannot chat yet", (await page.locator('nav[aria-label="Main"] a[aria-label^="Chat with"]').count()) === 0);
    check("AQi: workforce navigation anchors are intact", (await page.locator('[data-tour="workforce"]').count()) === 1 && (await page.locator('a[data-aqi-target="nav.workforce"]').count()) === 1);

    // 2. Chat: structure, brand, selection.
    await visit(page, salesAssistantConversation);
    await measureBrand(page, "chat/dark");
    await runAxe(page, "chat/desktop/dark");
    const rail = page.locator('nav[aria-label="Chat navigation"]:visible');
    check("chat: rail has the brand and a way back to AI Employees", (await rail.getByRole("link", { name: /Back to AI Employees/ }).getAttribute("href")) === "/employees");
    check("chat: current specialist is marked", (await rail.locator('a[href="/chat/sales-assistant"]').getAttribute("aria-current")) === "page");
    check("chat: the open conversation is marked", (await rail.locator("[data-conv-row][aria-current=true]").count()) === 1);
    check("chat: header names the open conversation", ((await page.locator("header").first().textContent()) ?? "").includes("Follow up with the HOA lead"));
    check("chat: Manage and Profile are offered to the owner", (await rail.getByRole("link", { name: /^Manage / }).count()) === 1 && (await rail.getByRole("link", { name: / profile$/ }).count()) === 1);

    // 3. Choosing the current employee again does nothing; choosing another switches histories.
    await rail.locator('a[href="/chat/sales-assistant"]').click();
    await page.waitForTimeout(400);
    check("chat: re-selecting the current employee keeps the open conversation URL", page.url().includes(`c=${conversationId}`), page.url());
    await rail.locator('a[href="/chat/lead-hunter"]').click();
    await page.waitForURL(/\/chat\/lead-hunter/, { timeout: 60_000 });
    await page.waitForTimeout(600);
    check("chat: choosing another specialist loads that employee", (await page.locator("h1").first().textContent())?.includes("Lead Hunter"));
    check("chat: histories are not mixed (the other employee's chat is not listed)", (await page.locator('nav[aria-label="Chat navigation"]:visible [data-conv-row]').count()) === 0);
    check("chat: an unconfigured employee shows the readiness state and no composer", (await page.locator("#chat-input").count()) === 0 && /connection check|finish setting up|awaiting review/i.test((await page.locator("main").textContent()) ?? ""));
    check("chat: selecting an employee made no model run or send request", sends.length === 0, sends.join(", "));

    // 4. Back / forward / deep links.
    await page.getByRole("link", { name: /Back to AI Employees/ }).first().click();
    await page.waitForURL(/\/employees$/, { timeout: 60_000 });
    check("chat: Back to AI Employees reaches the directory", /\/employees$/.test(page.url()));
    await page.goBack();
    await page.waitForURL(/\/chat\/lead-hunter/, { timeout: 60_000 });
    check("browser back returns to the previous chat", /\/chat\/lead-hunter/.test(page.url()));
    await page.goForward();
    await page.waitForURL(/\/employees$/, { timeout: 60_000 });
    check("browser forward returns to the directory", /\/employees$/.test(page.url()));
    await visit(page, `/chat/lead-hunter?c=${conversationId}`);
    check("deep link: another employee's conversation id is not shown under this employee", !((await page.locator("main").textContent()) ?? "").includes("Draft a friendly follow-up"));
    await visit(page, salesAssistantConversation);
    check("deep link: the owning employee shows the conversation", ((await page.locator("main").textContent()) ?? "").includes("Draft a friendly follow-up"));

    // 5. Search.
    const search = page.locator("#conv-search");
    await search.fill("zzzz-no-such-chat");
    await page.getByText("No matching conversations").waitFor({ timeout: 15_000 }).then(() => check("search: a query with no match explains itself", true)).catch(() => check("search: a query with no match explains itself", false));
    await search.fill("HOA");
    await page.locator("nav:visible [data-conv-row]").first().waitFor({ timeout: 15_000 });
    check("search: finds the persisted conversation by its title", (await page.locator("nav:visible [data-conv-row]").count()) === 1);
    await search.press("Escape");
    check("search: Escape clears the query", (await search.inputValue()) === "");
    await search.press("ArrowDown");
    check("keyboard: ArrowDown from search focuses the first conversation", await page.evaluate(() => document.activeElement?.hasAttribute("data-conv-row")));

    // 6. Collapse / expand, remembered across navigation and reloads.
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.waitForTimeout(300);
    const compactWidth = await page.locator("aside").first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
    check("rail: collapses to an icon rail", compactWidth <= 84, `${compactWidth}px`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page);
    check("rail: collapsed state is remembered after reload", (await page.locator("aside").first().evaluate((el) => Math.round(el.getBoundingClientRect().width))) <= 84);
    await page.locator('nav[aria-label="Chat navigation"]:visible a[aria-label^="Lead Hunter"]').click();
    await page.waitForURL(/\/chat\/lead-hunter/, { timeout: 60_000 });
    await page.waitForTimeout(500);
    check("rail: collapsed state survives switching employee", (await page.locator("aside").first().evaluate((el) => Math.round(el.getBoundingClientRect().width))) <= 84);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.waitForTimeout(300);
    check("rail: expands again", (await page.locator("aside").first().evaluate((el) => Math.round(el.getBoundingClientRect().width))) >= 270);
    await page.evaluate(() => localStorage.removeItem("iaq-chat-rail"));
    check("no real conversation was started during navigation checks", sends.length === 0, sends.join(", "));
    await context.close();
  }

  // ---------------- owner, desktop, light: brand contrast in the other theme ----------------
  if (wants("desktop-light")) {
    const context = await newContext(browser, VIEWPORTS.desktop, "light");
    const page = await signIn(context, owner);
    await visit(page, "/employees");
    await measureBrand(page, "management/light");
    await visit(page, salesAssistantConversation);
    await measureBrand(page, "chat/light");
    await runAxe(page, "chat/desktop/light");
    await context.close();
  }

  // ---------------- owner, mobile ----------------
  for (const theme of wants("mobile") ? ["light", "dark"] : []) {
    const context = await newContext(browser, VIEWPORTS.mobile, theme);
    const page = await signIn(context, owner);
    await visit(page, salesAssistantConversation);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`mobile/${theme}: no horizontal scroll in chat`, overflow <= 0, `${overflow}px`);
    check(`mobile/${theme}: rail is not permanently on screen`, (await page.locator('nav[aria-label="Chat navigation"]:visible').count()) === 0);
    check(`mobile/${theme}: header shows the specialist and the open conversation`, ((await page.locator("header").first().textContent()) ?? "").includes("Follow up with the HOA lead"));
    const opener = page.getByRole("button", { name: "Open chat navigation" });
    await opener.click();
    await page.getByRole("dialog").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    check(`mobile/${theme}: drawer opens as a dialog with the rail inside`, (await page.getByRole("dialog").locator("nav[aria-label='Chat navigation']").count()) === 1);
    await measureBrand(page, `mobile-drawer/${theme}`);
    const drawerOverflow = await page.getByRole("dialog").evaluate((el) => el.scrollWidth - el.clientWidth);
    check(`mobile/${theme}: drawer has no horizontal scroll`, drawerOverflow <= 0, `${drawerOverflow}px`);
    await runAxe(page, `mobile-drawer/${theme}`, "[role=dialog] nav.workspace-nav");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    check(`mobile/${theme}: Escape closes the drawer and returns focus to the opener`, await opener.evaluate((el) => document.activeElement === el));
    await opener.click();
    await page.getByRole("dialog").getByRole("link", { name: /Back to AI Employees/ }).click();
    await page.waitForURL(/\/employees$/, { timeout: 60_000 });
    check(`mobile/${theme}: Back to AI Employees works from the drawer`, /\/employees$/.test(page.url()));
    await context.close();
  }

  // ---------------- Team member without configure permission ----------------
  if (wants("rep")) {
    const context = await newContext(browser, VIEWPORTS.desktop, "dark");
    const page = await signIn(context, credentials.users.sales_rep);
    await visit(page, salesAssistantConversation);
    const rail = page.locator('nav[aria-label="Chat navigation"]:visible');
    check("authorization: a team member sees Profile but not Manage in the rail", (await rail.getByRole("link", { name: / profile$/ }).count()) === 1 && (await rail.getByRole("link", { name: /^Manage / }).count()) === 0);
    check("authorization: the header has no Manage control for a team member", (await page.getByRole("link", { name: "Manage employee" }).count()) === 0);
    await visit(page, "/employees/lead-hunter?tab=configure");
    check("authorization: ?tab=configure does not expose the configuration tab to a team member", (await page.getByRole("tab", { name: /Configure/ }).count()) === 0);
    await context.close();
  }

  // ---------------- Super Admin (agency workspace) ----------------
  if (wants("admin")) {
    const context = await newContext(browser, VIEWPORTS.desktop, "dark");
    const page = await signIn(context, credentials.users.agency_admin);
    await page.goto(`${BASE}/admin/employees/open?role=lead-hunter`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await settle(page);
    check("super admin: the existing open route lands in chat", /\/chat\/lead-hunter/.test(page.url()), page.url());
    const rail = page.locator('nav[aria-label="Chat navigation"]:visible');
    check("super admin: Back goes to the agency workforce area", (await rail.getByRole("link", { name: /Back to AI Employees/ }).getAttribute("href")) === "/admin/employees");
    check("super admin: Manage opens the existing configure screen", (await rail.getByRole("link", { name: /^Manage / }).getAttribute("href")) === "/employees/lead-hunter?tab=configure");
    await shot(page, "chat-superadmin-desktop-dark");
    await context.close();
  }
}

try {
  if (MODE === "screens" || MODE === "all") await runScreens();
  if (MODE === "behavior" || MODE === "all") await runBehavior();
} finally {
  await browser.close();
}
const failed = report.checks.filter((c) => !c.ok);
fs.writeFileSync(path.join(OUT, MODE === "screens" ? "report.json" : `report-${MODE}.json`), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2));
console.log(`Checks: ${report.checks.length - failed.length}/${report.checks.length} passed; screens: ${report.screens.length}; console errors: ${report.consoleErrors.length}; page errors: ${report.pageErrors.length}`);
if (failed.length) process.exitCode = 1;
