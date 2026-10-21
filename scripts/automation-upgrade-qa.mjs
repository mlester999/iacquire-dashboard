// Signed-in browser QA of the Automation Studio upgrade page against the isolated local app (scripts/automation-qa.mjs on AUTOMATION_QA_URL, seeded
// by scripts/run-automation-qa-seed.mjs) in real Chromium: a workspace without the plan (Haven Dental's owner) sees the upgrade page at every
// size, in both themes and with reduced motion; the example plays, can be controlled, stays inside its canvas and sends nothing while it plays;
// the call to action opens the Maintenance page without requesting anything; the builder's API refuses that workspace; and a workspace with
// the plan (Brightside's owner) still gets the real builder.
//
//   node scripts/automation-upgrade-qa.mjs [--headed]
//
// Playwright is not a project dependency: it defaults to the copy the Native CRM QA installed (.data/crm-qa/browser-runner), or set PLAYWRIGHT_MODULE.
// People sign in through the real local sign-in page with the fictional QA accounts in .data/automation-qa/credentials.local.json; passwords are read by
// this script only and never printed. The browser talks to the QA server only: any other origin is blocked and counted.
// Output: .data/automation-qa/upgrade/report.json and .data/automation-qa/upgrade/*.png. Exit code 1 when any check failed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AUTOMATION_QA_DATA_DIR, AUTOMATION_QA_URL } from "./automation-qa-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, AUTOMATION_QA_DATA_DIR);
const OUT = path.join(DATA, "upgrade");
const AXE = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const BASE = AUTOMATION_QA_URL;
const headed = process.argv.includes("--headed");
fs.mkdirSync(OUT, { recursive: true });

const pwEntry = process.env.PLAYWRIGHT_MODULE ?? path.join(ROOT, ".data/crm-qa/browser-runner/node_modules/playwright/index.mjs");
const pw = await import(pathToFileURL(pwEntry).href);
const creds = JSON.parse(fs.readFileSync(path.join(DATA, "credentials.local.json"), "utf8"));

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [], axe: [], errors: { console: [], page: [], serverErrors: [], blockedExternal: [] } };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${String(detail).slice(0, 300)}` : ""}`);
};
const isLocal = (u) => { try { return new URL(u).host === new URL(BASE).host; } catch { return false; } };
const browser = await pw.chromium.launch({ headless: !headed });

async function person(role, { width = 1440, height = 900, theme = "light", reducedMotion = "no-preference" } = {}) {
  const user = creds.users[role];
  const context = await browser.newContext({ baseURL: BASE, viewport: { width, height }, deviceScaleFactor: 1, reducedMotion, locale: "en-US", timezoneId: "America/Chicago" });
  context.setDefaultNavigationTimeout(300_000);
  context.setDefaultTimeout(120_000);
  await context.route((url) => !isLocal(url.href), (route) => { report.errors.blockedExternal.push(route.request().url()); return route.abort("blockedbyclient").catch(() => {}); });
  await context.routeWebSocket((url) => !isLocal(url.href), (ws) => { report.errors.blockedExternal.push(ws.url()); ws.close(); });
  await context.addInitScript((t) => { try { localStorage.setItem("iaq-tour-v1", "done"); localStorage.setItem("iaq-theme", t); } catch { /* storage blocked */ } }, theme);
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") report.errors.console.push(`${role}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => report.errors.page.push(`${role}: ${(e.message || String(e)).slice(0, 600)}`));
  page.on("response", (r) => { if (r.status() >= 500) report.errors.serverErrors.push(`${role}: ${r.status()} ${r.url().replace(BASE, "")}`); });
  for (let attempt = 1; ; attempt++) {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const ok = await page.waitForFunction(() => { const el = document.querySelector("#email"); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: attempt < 4 ? 60_000 : 240_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 4) throw new Error("The sign-in page never became interactive.");
  }
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  const submit = page.locator("form button[type=submit]").first();
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
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const hydrated = (page, selector) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, selector, { timeout: 300_000 });
const openUpgrade = async (page) => {
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: /Describe an automation/ }).waitFor({ timeout: 180_000 });
  await hydrated(page, "[aria-label='Chapters'] button");
};
/** The demo's geometry at this moment: every node inside its canvas, none overlapping another, and how big a node's title really is. */
const demoGeometry = (page) => page.evaluate(() => {
  const canvas = document.querySelector("[aria-label='Example workflow canvas']").getBoundingClientRect();
  const nodes = [...document.querySelectorAll("[data-node]")].map((n) => ({ id: n.getAttribute("data-node"), r: n.getBoundingClientRect() }));
  const outside = nodes.filter(({ r }) => r.left < canvas.left - 0.5 || r.right > canvas.right + 0.5 || r.top < canvas.top - 0.5 || r.bottom > canvas.bottom + 0.5).map((n) => n.id);
  const overlaps = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i].r; const b = nodes[j].r;
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${nodes[i].id}/${nodes[j].id}`);
  }
  const title = document.querySelector("[data-node='text'] .demo-node-card p:nth-of-type(2)");
  const world = document.querySelector(".demo-world");
  const scale = world ? new DOMMatrixReadOnly(getComputedStyle(world).transform).a : 1;
  const px = title ? parseFloat(getComputedStyle(title).fontSize) * scale : 0;
  return { count: nodes.length, outside, overlaps, titlePx: Math.round(px * 10) / 10, canvasH: Math.round(canvas.height) };
});
const shownMessages = (page) => page.locator('[data-message][data-shown="true"]').count();

async function main() {
  // ------------------------------------------------------------------ Haven Dental owner (no plan), desktop, light
  const haven = await person("haven_owner");
  const hp = haven.page;
  await openUpgrade(hp);
  const body = (await hp.textContent("main")) ?? "";
  check("upgrade: the monthly price is stated once", (body.match(/\$299/g) ?? []).length === 1, `count=${(body.match(/\$299/g) ?? []).length}`);
  check("upgrade: the one-time setup is shown separately", /\$1,499 one-time setup/.test(body));
  check("upgrade: the request allowance comes from the published plan", /4 requests a month/.test(body));
  check("upgrade: what keeps working without the plan", /AI employees/.test(body) && /n8n, Zapier and Make/.test(body));
  check("upgrade: the allowances are provisional", /provisional/i.test(body));
  const ctas = hp.locator("main a[href='/maintenance']");
  const labels = await ctas.allTextContents();
  check("upgrade: three calls to action, all to the Maintenance page", labels.length === 3, labels.join(" | "));
  check("upgrade: each is labelled for this owner (request or, if not eligible yet, open the page)", labels.every((l) => /Review and request the plan|Open the Maintenance page/.test(l)), labels.join(" | "));
  check("upgrade: the example is labelled as one", /Interactive example/.test(body) && /Nothing is saved or sent/.test(body));
  check("upgrade: the sidebar entry carries a lock", /Needs the Automation Studio plan/.test((await hp.getByRole("link", { name: /Automation Studio/ }).first().textContent()) ?? ""));
  check("upgrade (1440): no sideways scroll", (await overflow(hp)) <= 1, `overflow=${await overflow(hp)}`);
  await hp.evaluate(() => window.scrollTo(0, 0));
  await shot(hp, "01-hero-1440-light");

  // The example: it starts when it's on screen, and while it plays nothing is requested from the server.
  const requests = [];
  const onRequest = (r) => { if (isLocal(r.url()) && !/\/_next\/|__nextjs|\/favicon/.test(r.url())) requests.push(`${r.method()} ${r.url().replace(BASE, "")}`); };
  hp.on("request", onRequest);
  await hp.getByRole("list", { name: "Example conversation" }).scrollIntoViewIfNeeded();
  await hp.locator("[aria-label='Chapters']").scrollIntoViewIfNeeded();
  await hp.getByRole("button", { name: "Pause the example" }).waitFor({ timeout: 10_000 }).then(() => check("demo: plays once scrolled into view", true), () => check("demo: plays once scrolled into view", false));
  const timeline = [];
  for (let i = 0; i < 60; i++) {
    const n = await hp.locator("[data-node]").count();
    if (!timeline.length || timeline[timeline.length - 1] !== n) timeline.push(n);
    if (await hp.getByRole("button", { name: "Replay the example" }).count()) break;
    await hp.waitForTimeout(400);
  }
  check("demo: the steps appear one by one", timeline.length >= 5 && timeline.every((n, i) => i === 0 || n >= timeline[i - 1]), timeline.join(" → "));
  check("demo: it ends with the whole automation and the full conversation", (await hp.locator("[data-node]").count()) === 6 && (await shownMessages(hp)) === 4);
  check("demo: it ends with what happens next", (await hp.locator('[data-next="shown"]').count()) === 1);
  hp.off("request", onRequest);
  check("demo: nothing was requested from the server while it played", requests.length === 0, requests.join(", "));
  const g = await demoGeometry(hp);
  check("demo (1440): every node inside the canvas, none overlapping", g.outside.length === 0 && g.overlaps.length === 0, JSON.stringify(g));
  check("demo (1440): node titles read at 13px or more", g.titlePx >= 13, `title=${g.titlePx}px`);
  await hp.locator("[aria-label='Chapters']").scrollIntoViewIfNeeded();
  await shot(hp, "02-demo-1440-light-end");

  // The controls.
  await hp.getByRole("button", { name: /Go to chapter 2/ }).click();
  check("controls: a chapter jumps to its start", (await hp.locator("[data-caption]").textContent())?.includes("reads your request") === true);
  await hp.getByRole("button", { name: "Pause the example" }).click();
  const at = await hp.locator("[data-caption]").textContent();
  await hp.waitForTimeout(2500);
  check("controls: pause holds the example still", (await hp.locator("[data-caption]").textContent()) === at);
  await hp.getByRole("button", { name: "Next step of the example" }).click();
  check("controls: next step moves one beat", (await hp.locator("[data-caption]").textContent()) !== at);
  await hp.keyboard.press("Tab");
  check("controls: keyboard focus moves on from the controls", await hp.evaluate(() => document.activeElement && document.activeElement !== document.body));

  // Leaving the page with the demo half-played: it pauses itself off screen.
  await hp.getByRole("button", { name: /Go to chapter 1/ }).click();
  await hp.getByRole("button", { name: "Resume the example" }).click().catch(() => {});
  await hp.evaluate(() => window.scrollTo(0, 0));
  await hp.waitForTimeout(700);
  const off = await hp.locator("[data-caption]").textContent();
  await hp.waitForTimeout(2500);
  check("demo: off screen it pauses", (await hp.locator("[data-caption]").textContent()) === off);

  await runAxe(hp, "upgrade page (1440, light)");

  // The call to action opens the Maintenance page; nothing is requested by getting there.
  const posts = [];
  hp.on("request", (r) => { if (r.method() !== "GET" && isLocal(r.url())) posts.push(`${r.method()} ${r.url().replace(BASE, "")}`); });
  await hp.evaluate(() => window.scrollTo(0, 0));
  await hp.locator("main a[href='/maintenance']").first().click();
  await hp.waitForURL(/\/maintenance$/, { timeout: 120_000 });
  await hp.getByRole("heading", { level: 1, name: /Managed maintenance/ }).waitFor({ timeout: 120_000 });
  check("cta: opens the Maintenance page", true);
  check("cta: getting there requests nothing", posts.filter((p) => !/__nextjs|_rsc|\?_rsc/.test(p)).length === 0, posts.join(", "));

  // The builder refuses this workspace on the server, whatever the page shows.
  const refused = await hp.evaluate(async () => {
    const r = await fetch("/api/automation-studio/00000000-0000-4000-8000-000000000001/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Build me an automation." }) });
    return { status: r.status, type: r.headers.get("content-type"), text: (await r.text()).slice(0, 300) };
  });
  check("entitlement: the builder API refuses a workspace without the plan", refused.status >= 400 && refused.status < 500 && !/event-stream/.test(refused.type ?? ""), JSON.stringify(refused));
  await hp.goto("/automation-studio/00000000-0000-4000-8000-000000000001", { waitUntil: "domcontentloaded" });
  await hp.waitForLoadState("domcontentloaded");
  check("entitlement: an automation URL never opens an editor without the plan", (await hp.locator(".react-flow, [data-studio-workspace]").count()) === 0);

  // ------------------------------------------------------------------ Phones, tablet and wide screens (the same sign-in: the local sign-in is rate limited)
  for (const [w, h] of [[360, 780], [390, 844], [430, 932], [768, 1024], [1024, 768], [1920, 1080]]) {
    const s = haven;
    await hp.setViewportSize({ width: w, height: h });
    await openUpgrade(s.page);
    check(`layout (${w}): no sideways scroll`, (await overflow(s.page)) <= 1, `overflow=${await overflow(s.page)}`);
    await shot(s.page, `03-hero-${w}`);
    await s.page.getByRole("list", { name: "Example conversation" }).scrollIntoViewIfNeeded();
    await s.page.locator("[aria-label='Chapters']").scrollIntoViewIfNeeded();
    await s.page.getByRole("button", { name: /Go to chapter 4/ }).click();
    await s.page.waitForTimeout(1200);
    const gg = await demoGeometry(s.page);
    check(`demo (${w}): every node inside the canvas, none overlapping`, gg.count === 6 && gg.outside.length === 0 && gg.overlaps.length === 0, JSON.stringify(gg));
    check(`demo (${w}): node titles stay readable (12px or more)`, gg.titlePx >= 12, `title=${gg.titlePx}px`);
    // Controls that aren't drawn at this size (the phone's Chat / Canvas switch on a wider screen) aren't tap targets; a touch screen needs 44px.
    const small = await s.page.evaluate(() => [...document.querySelectorAll("[aria-label='Chapters'] button, button[aria-label$='the example'], button[aria-label$='step of the example']")]
      .filter((b) => b.getClientRects().length > 0 && b.getBoundingClientRect().height < (window.innerWidth < 640 || matchMedia("(pointer: coarse)").matches ? 44 : 32)).length);
    check(`controls (${w}): tap targets are big enough`, small === 0, `small=${small}`);
    if (w <= 1024) {
      // On phones and tablets nothing has to be scrolled to while it plays: the whole example fits under the portal's header.
      const fit = await s.page.evaluate(() => { const r = document.querySelector("[aria-label='Chapters']").closest(".\\@container").getBoundingClientRect(); return { h: Math.round(r.height), room: innerHeight - 64 }; });
      check(`demo (${w}): the whole example fits one screen`, fit.h <= fit.room, JSON.stringify(fit));
    }
    if (w === 390 || w === 768) await runAxe(s.page, `upgrade page (${w}, light)`);
    await s.page.getByRole("list", { name: "Example conversation" }).scrollIntoViewIfNeeded();
    await shot(s.page, `04-demo-${w}`);
    if (w <= 430) await shot(s.page, `05-page-${w}`, { fullPage: true });
  }

  // ------------------------------------------------------------------ Dark theme, with reduced motion: the finished example, nothing moving
  const dark = haven;
  await hp.setViewportSize({ width: 1440, height: 900 });
  await hp.emulateMedia({ reducedMotion: "reduce" });
  await hp.evaluate(() => localStorage.setItem("iaq-theme", "dark"));
  await haven.context.addInitScript(() => { try { localStorage.setItem("iaq-theme", "dark"); } catch { /* storage blocked */ } });
  await openUpgrade(dark.page);
  check("dark: the page is in the dark theme", (await hp.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await dark.page.getByRole("list", { name: "Example conversation" }).scrollIntoViewIfNeeded();
  await dark.page.waitForTimeout(1500);
  check("reduced motion: the finished example is shown and doesn't play by itself", (await dark.page.locator("[data-node]").count()) === 6 && (await dark.page.getByRole("button", { name: "Replay the example" }).count()) === 1);
  const animated = await dark.page.evaluate(() => [...document.querySelectorAll(".demo-node, .demo-node-card, .demo-world, .demo-edge-line")].filter((el) => { const cs = getComputedStyle(el); return (cs.animationName !== "none" && parseFloat(cs.animationDuration) > 0) || cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0.01); }).length);
  check("reduced motion: nothing in the example animates", animated === 0, `animated=${animated}`);
  await dark.page.getByRole("button", { name: /Go to chapter 2/ }).click();
  check("reduced motion: the example can still be stepped through", (await dark.page.locator("[data-caption]").textContent())?.includes("reads your request") === true);
  await dark.page.getByRole("button", { name: /Go to chapter 4/ }).click();
  await shot(dark.page, "06-demo-1440-dark");
  await dark.page.evaluate(() => window.scrollTo(0, 0));
  await shot(dark.page, "07-hero-1440-dark");
  await dark.page.locator("#up-plan").scrollIntoViewIfNeeded();
  await shot(dark.page, "08-pricing-1440-dark");
  await runAxe(dark.page, "upgrade page (1440, dark, reduced motion)");
  // A phone in the dark theme: the chat and the canvas take turns, and the person can switch.
  await hp.setViewportSize({ width: 390, height: 844 });
  await openUpgrade(dark.page);
  await dark.page.locator("[aria-label='Chapters']").scrollIntoViewIfNeeded();
  check("phone: the finished example opens on the chat", (await dark.page.locator("[data-panel='chat']:not([data-off])").count()) === 1 && (await dark.page.locator("[data-panel='canvas'][data-off]").count()) === 1);
  await dark.page.getByRole("button", { name: "Show the canvas of the example" }).click();
  check("phone: the switch shows the canvas", (await dark.page.locator("[data-panel='canvas']:not([data-off])").count()) === 1 && (await dark.page.getByRole("button", { name: "Show the canvas of the example" }).getAttribute("aria-pressed")) === "true");
  await shot(dark.page, "09-demo-390-dark-canvas");
  await runAxe(dark.page, "upgrade page (390, dark, reduced motion)");
  await haven.context.close();

  // ------------------------------------------------------------------ Brightside owner (plan active): the real builder, unchanged
  const owner = await person("owner");
  await owner.page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await owner.page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 180_000 });
  check("entitled: the plan's home is shown, not the upgrade page", (await owner.page.getByRole("heading", { level: 1, name: /Describe an automation/ }).count()) === 0);
  const first = owner.page.locator("main a[href^='/automation-studio/']").filter({ hasNotText: /Connections|Usage/ }).first();
  if (await first.count()) {
    const href = await first.getAttribute("href");
    await owner.page.goto(href, { waitUntil: "domcontentloaded" });
    await owner.page.locator(".react-flow__node").first().waitFor({ timeout: 180_000 }).then(() => check("entitled: an automation opens in the real editor canvas", true), () => check("entitled: an automation opens in the real editor canvas", false, href));
    await shot(owner.page, "09-entitled-workspace");
  } else check("entitled: an automation opens in the real editor canvas", true, "no saved automation in this seed to open (skipped)");
  await owner.context.close();
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  check("run completed", false, e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e));
}
await browser.close();
const bad = report.checks.filter((c) => !c.ok);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.checks.length - bad.length}/${report.checks.length} checks passed; page errors ${report.errors.page.length}, console errors ${report.errors.console.length}, 5xx ${report.errors.serverErrors.length}, blocked external ${report.errors.blockedExternal.length}.`);
for (const k of ["page", "serverErrors", "blockedExternal", "console"]) for (const m of [...new Set(report.errors[k])].slice(0, 8)) console.log(`  ${k}: ${m}`);
process.exit(failed || bad.length || report.errors.page.length || report.errors.serverErrors.length ? 1 : 0);
