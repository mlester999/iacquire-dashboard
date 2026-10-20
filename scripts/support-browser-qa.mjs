// Browser QA for Support & Requests against the isolated local QA server (embedded database, fictional accounts, email captured).
//   1. node scripts/run-support-qa-seed.mjs        (server stopped)
//   2. CRM_QA_PORT=3262 node scripts/crm-qa.mjs     (separate terminal)
//   3. CRM_QA_PORT=3262 node scripts/support-browser-qa.mjs [--only <name-fragment>] [--headed]
// Playwright is not a project dependency: set PLAYWRIGHT_MODULE to an installed playwright/index.mjs if it isn't in node_modules.
// The run drives the real screens as each persona (client team member, owner, viewer, other client, agency Super Admin, staff, out-of-scope
// staff, signed-out visitor), checks what each may and may not see, takes screenshots at 390/768/1024/1440 px, and runs axe-core.
// It only talks to the QA server's loopback origin; any other request is blocked and counted. Output: .data/crm-qa/support/
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.CRM_QA_PORT ?? 3230);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(root, ".data/crm-qa/support");
const SHOTS = path.join(OUT, "screens");
const creds = JSON.parse(fs.readFileSync(path.join(root, ".data/crm-qa/support-credentials.local.json"), "utf8")).users;
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const headed = args.includes("--headed");
const VIEWPORTS = [[390, 844], [768, 1024], [1024, 768], [1440, 900]];
fs.mkdirSync(SHOTS, { recursive: true });

const entry = process.env.PLAYWRIGHT_MODULE ?? "C:/Users/ZEPHY/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(entry).href);
const axeSource = fs.readFileSync(path.join(root, "node_modules/axe-core/axe.min.js"), "utf8");

const results = [];
const blocked = new Set();
const pageProblems = [];
let current = "";

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}
async function check(name, fn) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  current = name;
  try {
    await fn();
    if (!results.find((r) => r.name === name)) record(name, true);
  } catch (err) {
    record(name, false, (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 300));
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch({ headless: !headed });

async function newContext(viewport = [1440, 900]) {
  const context = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] }, baseURL: BASE, reducedMotion: "reduce" });
  // Keep the first-run tour from covering the screens. Browser-local state only.
  await context.addInitScript(() => {
    try { localStorage.setItem("iaq-tour-v1", "done"); } catch { /* storage unavailable */ }
  });
  context.setDefaultTimeout(180_000);
  context.setDefaultNavigationTimeout(300_000);
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return route.continue();
    blocked.add(url.slice(0, 120));
    return route.abort();
  });
  return context;
}

function watch(page, label) {
  page.on("pageerror", (e) => pageProblems.push(`${label} [${current}] pageerror: ${String(e.message).replace(/\s+/g, " ").slice(0, 160)} ... ${String(e.message).match(/[+-]\s+\d+ \w+ ago|\bat \w+ \(src[^)]*\)/)?.[0] ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon|hydrat/i.test(m.text())) pageProblems.push(`${label} [${current}] console: ${m.text().slice(0, 200)}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500 && r.url().startsWith(BASE)) pageProblems.push(`${label} [${current}] ${r.status()} ${r.url().replace(BASE, "")}`);
  });
}

async function login(context, key) {
  const page = await context.newPage();
  watch(page, key);
  // The development server occasionally answers its first request after a quiet spell with a 500 ("Manifest file is empty") while it
  // rewrites its build manifests; the next request is fine. Reload until the sign-in form is really there.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    if (await page.waitForSelector("#email", { timeout: 45_000 }).then(() => true, () => false)) break;
    await page.waitForTimeout(2_000);
  }
  // The Sign in button enables from React's onChange, and React does not replay input typed before hydration (in development the
  // app-router chunks arrive after DOMContentLoaded). Wait for the email field to be hydrated, then type, retrying key by key.
  await page.waitForFunction(() => {
    const el = document.querySelector("#email");
    return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  }, null, { timeout: 120_000 }).catch(() => {});
  const submit = page.locator("form button[type=submit]").first();
  let enabled = false;
  for (let attempt = 0; attempt < 4 && !enabled; attempt += 1) {
    if (attempt === 0) {
      await page.fill("#email", creds[key].email);
      await page.fill("#password", creds[key].password);
    } else {
      await page.fill("#email", "");
      await page.fill("#password", "");
      await page.locator("#email").pressSequentially(creds[key].email, { delay: 15 });
      await page.locator("#password").pressSequentially(creds[key].password, { delay: 15 });
    }
    enabled = await submit.isEnabled({ timeout: 3_000 }).catch(() => false);
    if (!enabled) await page.waitForTimeout(1_500);
    enabled = await submit.isEnabled().catch(() => false);
  }
  if (!enabled) throw new Error(`sign-in button stayed disabled for ${key}`);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }), submit.click()]);
  return page;
}

async function ready(page) {
  await page.waitForSelector("main h1, main h2", { timeout: 240_000 });
  // React does not replay events fired before hydration, so wait until the first interactive controls have been hydrated.
  await page.waitForFunction(() => {
    const targets = [...document.querySelectorAll("main form, main textarea, main select, main button")].slice(0, 3);
    return targets.every((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$")));
  }, null, { timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** A page the person may not open renders the standard "couldn't find that page" screen (the status can stream as 200). */
async function expectNotFound(page, href, secret) {
  const res = await page.goto(href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main h1", { timeout: 240_000 });
  const text = await page.locator("body").innerText();
  expect(/couldn't find that page/i.test(text) || res.status() === 404, `${href} did not read as not found`);
  if (secret) expect(!text.includes(secret), `${href} leaked "${secret}"`);
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  // AQi's first-run "New to iAcquireOS?" card floats over the page for a first-time user; dismiss it so the screenshot shows the page.
  const later = page.getByRole("button", { name: "Maybe later" });
  if (await later.isVisible().catch(() => false)) await later.click({ timeout: 3_000 }).catch(() => {});
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function axe(page, label, selector = null) {
  await page.addScriptTag({ content: axeSource });
  const res = await page.evaluate(async (sel) => {
    const r = await axe.run(sel ? document.querySelector(sel) : document, { resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(" ") }));
  }, selector);
  const serious = res.filter((v) => ["serious", "critical", "moderate", "minor"].includes(v.impact));
  if (serious.length) throw new Error(`axe ${label}: ${serious.map((v) => `${v.id}(${v.nodes}) ${v.target}`).join("; ")}`);
}

async function overflow(page) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(o <= 1, `horizontal overflow of ${o}px`);
}

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4096, 5)]);

// ---------------------------------------------------------------------------------------------------------------------------------------
// Signed-out
// ---------------------------------------------------------------------------------------------------------------------------------------
await check("signed-out: support pages send a visitor to sign in", async () => {
  const context = await newContext();
  const page = await context.newPage();
  for (const p of ["/support", "/support/requests", "/support/report-issue", "/admin/support", "/api/support/00000000-0000-0000-0000-000000000000/thread"]) {
    const res = await page.goto(p, { waitUntil: "domcontentloaded" });
    const url = new URL(page.url());
    expect(url.pathname.startsWith("/login") || (res && [401, 403].includes(res.status())), `${p} was reachable while signed out (${url.pathname}, ${res?.status()})`);
  }
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Client team member
// ---------------------------------------------------------------------------------------------------------------------------------------
const member = await newContext();
let mpage;
let myNewRef = "";
let myNewHref = "";
await check("member: signs in and sees the Requests group in the sidebar", async () => {
  mpage = await login(member, "member");
  await mpage.goto("/support", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  const toggle = mpage.locator("#nav-requests-toggle");
  expect(await toggle.count() === 1, "Requests toggle missing");
  expect((await toggle.getAttribute("aria-expanded")) === "true", "Requests group should start expanded");
  for (const name of ["Custom Projects", "Report an Issue", "Get Support", "Provide Feedback", "My Requests"]) {
    expect(await mpage.locator("#nav-requests-list").getByRole("link", { name: new RegExp(`^${name}`) }).count() >= 1, `${name} missing from Requests`);
  }
  const active = await mpage.locator('#nav-requests-list a[aria-current="page"]').allInnerTexts();
  expect(active.length === 1 && /Get Support/.test(active[0]), `active item should be only Get Support, got ${JSON.stringify(active)}`);
});

await check("member: Requests group collapses and expands with the keyboard", async () => {
  await mpage.focus("#nav-requests-toggle");
  await mpage.keyboard.press("Enter");
  await mpage.waitForFunction(() => document.querySelector("#nav-requests-toggle")?.getAttribute("aria-expanded") === "false", null, { timeout: 15_000 });
  await mpage.keyboard.press("Space");
  await mpage.waitForFunction(() => document.querySelector("#nav-requests-toggle")?.getAttribute("aria-expanded") === "true", null, { timeout: 15_000 });
});

await check("member: Get Support form shows a response expectation only because it is configured", async () => {
  await mpage.goto("/support", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.getByText("We aim to reply within").count() >= 1, "configured expectation not shown");
  expect(await mpage.getByRole("heading", { name: "How can we help?" }).count() === 1, "heading");
});

await check("member: submits a support request with a file and gets a real reference", async () => {
  await mpage.goto("/support", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  const submit = mpage.getByRole("button", { name: /Send request/ });
  await mpage.getByLabel("Request subject").fill("QA: invoices won't export to PDF");
  await mpage.getByLabel("What is this about?").selectOption("billing");
  await mpage.getByLabel("How can we help?").fill("When I press export on the billing page nothing downloads. This started after yesterday's update.");
  await mpage.locator('input[type="file"]').first().setInputFiles({ name: "billing-screen.png", mimeType: "image/png", buffer: png });
  await mpage.getByText("Ready", { exact: false }).first().waitFor({ timeout: 30_000 });
  await Promise.all([mpage.getByRole("heading", { name: /Your request has been sent/ }).waitFor({ timeout: 60_000 }), submit.click()]);
  const text = await mpage.locator("main").innerText();
  const m = /IAQ-\d+/.exec(text);
  expect(m, "no real reference shown");
  myNewRef = m[0];
  myNewHref = await mpage.getByRole("link", { name: /View your request/ }).getAttribute("href");
  expect(/^\/support\/[0-9a-f-]{36}$/.test(myNewHref), "bad link to the request");
  await shot(mpage, "member-support-sent-1440");
});

await check("member: the new request is in My Requests with the right status and filters work", async () => {
  await mpage.goto("/support/requests", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  const card = mpage.locator("li", { hasText: myNewRef });
  expect(await card.count() === 1, "new request not listed");
  expect(/Received/.test(await card.innerText()), "status should read Received");
  await mpage.goto("/support/requests?status=resolved", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.locator("li", { hasText: myNewRef }).count() === 0, "filter did not exclude it");
  await mpage.goto("/support/requests?q=invoices", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.locator("li", { hasText: myNewRef }).count() === 1, "search did not find it");
  await mpage.goto("/support/requests?q=zzzznomatch", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.getByText("Nothing matches").count() === 1, "empty search state missing");
});

await check("member: reply in the conversation sends once and shows delivery state", async () => {
  await mpage.goto(myNewHref, { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.getByText(myNewRef).count() >= 1, "reference on the detail page");
  await mpage.locator("#request-reply").fill("One more detail: it only fails for invoices from last month.");
  await mpage.getByRole("button", { name: /Send reply/ }).click();
  await mpage.getByText("One more detail: it only fails").first().waitFor({ timeout: 30_000 });
  await mpage.waitForTimeout(1200);
  const count = await mpage.getByText("One more detail: it only fails").count();
  expect(count === 1, `reply appears ${count} times`);
  expect(await mpage.getByText("Sent", { exact: true }).count() >= 1 || await mpage.getByText("Seen by iAcquire").count() >= 1, "no delivery state");
});

await check("member: cannot read a colleague's or another client's request, even by address", async () => {
  // The owner's late request is in the same workspace but belongs to the owner.
  const owner = await newContext();
  const opage = await login(owner, "owner");
  await opage.goto("/support/requests?q=invite", { waitUntil: "domcontentloaded" });
  await ready(opage);
  const href = await opage.locator('a[href^="/support/"]', { hasText: "invite a new hygienist" }).first().getAttribute("href");
  expect(href, "owner's request not found");
  await expectNotFound(mpage, href, "invite a new hygienist");
  await mpage.goto("/support/requests", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.getByText("invite a new hygienist").count() === 0, "colleague's request listed");
  const api = await mpage.request.get(`/api/support/${href.split("/").pop()}/thread`);
  expect(api.status() === 404, `thread API gave ${api.status()}`);
  await owner.close();
});

await check("member: Report an Issue shows exactly what technical details would be attached, and nothing when off", async () => {
  await mpage.goto("/support/report-issue?from=/crm/contacts", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.getByText("This is everything that will be attached").count() === 0, "diagnostics visible while off");
  await mpage.getByRole("switch", { name: "Include technical details" }).click();
  await mpage.getByText("This is everything that will be attached").waitFor();
  const preview = await mpage.getByRole("region", { name: "What will be attached" }).innerText();
  expect(/Browser/.test(preview) && /\/crm\/contacts/.test(preview), "preview should list the browser and page");
  expect(!/password|token|cookie|api key/i.test(preview.replace(/never attach passwords, access keys/i, "")), "preview mentions secrets");
  await mpage.getByLabel("Issue title").fill("QA: contacts search returns nothing");
  await mpage.getByLabel("What happened?").fill("Searching for any patient name gives an empty list.");
  await mpage.getByRole("radio", { name: /Needs attention soon/ }).click();
  await shot(mpage, "member-issue-form-1440");
  await mpage.getByRole("button", { name: /Send report/ }).click();
  await mpage.getByRole("heading", { name: /We've got your report|Thanks/ }).waitFor({ timeout: 60_000 });
  expect(/IAQ-\d+/.test(await mpage.locator("main").innerText()), "no reference");
});

await check("member: Provide Feedback creates feedback that starts as Received", async () => {
  await mpage.goto("/support/feedback", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  await mpage.getByLabel("Feedback title").fill("QA: add a dark mode toggle to the dashboard");
  await mpage.getByLabel("Tell us more").fill("Our front desk works late and the bright screen is tiring.");
  await mpage.getByRole("button", { name: /Send feedback/ }).click();
  await mpage.getByRole("heading", { name: /Thank you for your feedback/ }).waitFor({ timeout: 60_000 });
  expect(/Received/.test(await mpage.locator("main").innerText()), "status Received");
});

await check("member: double-clicking Send creates one request", async () => {
  await mpage.goto("/support", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  // A title that is unique to this run, so requests left by an earlier run cannot be mistaken for a duplicate.
  const unique = `QA double click ${Date.now().toString(36)}`;
  await mpage.getByLabel("Request subject").fill(unique);
  await mpage.getByLabel("How can we help?").fill("Testing that two quick clicks make one request only.");
  const btn = mpage.getByRole("button", { name: /Send request/ });
  await btn.dblclick();
  await mpage.getByRole("heading", { name: /Your request has been sent/ }).waitFor({ timeout: 60_000 });
  await mpage.goto(`/support/requests?q=${encodeURIComponent(unique)}`, { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.locator('a[href^="/support/"]', { hasText: unique }).count() === 1, "duplicate request created");
});

await check("member: validation shows clear messages and keeps the draft", async () => {
  await mpage.goto("/support", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  await mpage.getByRole("button", { name: /Send request/ }).click();
  expect(await mpage.getByText("Add a short title.").count() >= 1, "title message");
  expect(await mpage.getByText("Tell us a little more.").count() >= 1, "description message");
  await mpage.getByLabel("Request subject").fill("QA: draft that must survive");
  await mpage.getByLabel("How can we help?").fill("This text should still be here after a reload.");
  await mpage.waitForTimeout(900);
  await mpage.reload({ waitUntil: "domcontentloaded" });
  await ready(mpage);
  await mpage.getByText("We restored your unsent draft").waitFor({ timeout: 10_000 });
  expect((await mpage.getByLabel("Request subject").inputValue()) === "QA: draft that must survive", "draft not restored");
  await mpage.evaluate(() => window.localStorage.clear());
});

// AQi: the seed leaves a finished conversation in which AQi offered to hand the question to the team (no AI provider is needed).
// The person's message in it contains a made-up API key and a made-up password, which must never reach the draft or the shared excerpt.
await check("member: AQi prepares a support request to review, with secrets removed and explicit consent before anything is shared", async () => {
  const context = await newContext();
  const page = await login(context, "member");
  await page.goto("/support", { waitUntil: "domcontentloaded" });
  await ready(page);
  // Each step has a short timeout and leaves a screenshot of where it stopped, so a failure says what was on screen.
  const step = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      await shot(page, `aqi-stopped-at-${label}`).catch(() => {});
      throw new Error(`${label}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
  };
  page.setDefaultTimeout(45_000);
  await step("open-aqi", () => page.getByRole("button", { name: "Open AQi, the iAcquireOS assistant" }).click());
  await step("history", () => page.getByRole("button", { name: "Conversation history" }).click());
  await step("conversation", () => page.getByRole("button", { name: /^Reminder texts \(QA\)/ }).first().click());
  const secrets = /sk-qa-only|hunter2/;
  // Matched by id rather than by name: the dialog's title changes to "Your request has been sent" once the request exists.
  const dialog = () => page.locator('[role="dialog"][aria-labelledby="aqi-support-title"]');
  const prepare = () => step("prepare", async () => {
    await page.getByRole("button", { name: /Prepare support request/ }).first().click();
    await page.locator("#aqi-support-subject").waitFor({ timeout: 120_000 });
  });
  await prepare();
  expect((await page.locator("#aqi-support-subject").inputValue()).trim().length >= 3, "no drafted subject");
  const description = await page.locator("#aqi-support-description").inputValue();
  expect(description.trim().length > 5, "no drafted description");
  expect(!secrets.test(description), "a secret reached the drafted description");
  expect(await dialog().getByText("Nothing from our chat is shared.").count() === 1, "should say nothing is shared by default");
  expect(!(await dialog().getByLabel(/Share my conversation with AQi/).isChecked()), "sharing should be off by default");
  const send = dialog().getByRole("button", { name: /Send to iAcquire support/ });
  await dialog().getByLabel(/Share my conversation with AQi/).check();
  const excerpt = await dialog().getByRole("list", { name: "Messages that would be shared" }).innerText();
  expect(excerpt.length > 20, "the shared excerpt is not shown");
  expect(!secrets.test(excerpt), "a secret appears in the excerpt that would be shared");
  expect(await send.isDisabled(), "Send should wait for explicit consent");
  await dialog().getByLabel(/I agree to share these messages/).check();
  expect(await send.isEnabled(), "Send should be allowed once consent is given");
  await shot(page, "member-aqi-dialog-1440");
  // Only the dialog is scanned: with AQi's own panel open beside it, the page has two <header> banners, a finding about the AQi panel
  // that this work did not touch (recorded in docs/support-requests.md).
  await axe(page, "aqi-dialog@1440", '[role="dialog"][aria-labelledby="aqi-support-title"]');
  // On a phone the dialog must still fit (it scrolls inside itself) and keep the send button reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await overflow(page);
  await shot(page, "member-aqi-dialog-390");
  await axe(page, "aqi-dialog@390", '[role="dialog"][aria-labelledby="aqi-support-title"]');
  await send.scrollIntoViewIfNeeded();
  expect(await send.isVisible(), "send button not reachable on a phone");
  await page.setViewportSize({ width: 1440, height: 900 });
  // Escape closes it without sending anything.
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  // Send for real (to the isolated QA database), with the conversation shared.
  await prepare();
  await dialog().getByLabel(/Share my conversation with AQi/).check();
  await dialog().getByLabel(/I agree to share these messages/).check();
  await dialog().getByRole("button", { name: /Send to iAcquire support/ }).click();
  await page.getByRole("heading", { name: "Your request has been sent" }).waitFor({ timeout: 60_000 });
  expect(/IAQ-\d+/.test(await dialog().innerText()), "no reference after sending");
  await dialog().getByRole("link", { name: "View your request" }).click();
  await page.waitForURL(/\/support\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  await ready(page);
  const body = await page.locator("main").innerText();
  expect(!secrets.test(body), "a secret is visible on the created request");
  expect(/Reminder|reminder/.test(body), "the request does not carry what the person asked");
  await context.close();
});

for (const [w, h] of VIEWPORTS) {
  await check(`member: pages render cleanly at ${w}px (no overflow, no axe violations)`, async () => {
    await mpage.setViewportSize({ width: w, height: h });
    const detailHref = myNewHref;
    for (const [name, p] of [["support", "/support"], ["issue", "/support/report-issue"], ["feedback", "/support/feedback"], ["requests", "/support/requests"], ["detail", detailHref]]) {
      await mpage.goto(p, { waitUntil: "domcontentloaded" });
      await ready(mpage);
      await overflow(mpage);
      await shot(mpage, `member-${name}-${w}`);
      if (w === 1440 || w === 390) await axe(mpage, `${name}@${w}`);
    }
  });
}

await mpage?.setViewportSize({ width: 1440, height: 900 });
// Park the member's tab while other personas are tested: an idle page keeps polling the development server, which rebuilds its
// chunks as new routes compile, and that produced "chunk failed to load" noise that is not a defect in the application.
await mpage?.goto("about:blank").catch(() => {});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Viewer and owner and another client
// ---------------------------------------------------------------------------------------------------------------------------------------
await check("viewer: cannot open support pages and sees no support entries", async () => {
  const context = await newContext();
  const page = await login(context, "viewer");
  await page.goto("/support", { waitUntil: "domcontentloaded" });
  await ready(page);
  expect(!new URL(page.url()).pathname.startsWith("/support"), `viewer reached ${page.url()}`);
  expect(await page.locator("#nav-requests-list").getByRole("link", { name: /Get Support|My Requests|Report an Issue/ }).count() === 0, "viewer sees support links");
  const res = await page.request.post("/api/support/uploads", { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: png } }, headers: { origin: BASE } });
  expect(res.status() >= 400, "viewer could upload");
  await context.close();
});

await check("owner: sees every request in the workspace and can narrow to their own", async () => {
  const context = await newContext();
  const page = await login(context, "owner");
  // Repeated QA runs add requests, so the colleagues' seeded ones may be past the first page: search for them instead of paging.
  await page.goto("/support/requests?q=Google+calendar", { waitUntil: "domcontentloaded" });
  await ready(page);
  expect(/Google calendar/.test(await page.locator("main").innerText()), "owner should see a colleague's request");
  await page.goto("/support/requests?q=invite+a+new+hygienist", { waitUntil: "domcontentloaded" });
  await ready(page);
  expect(/invite a new hygienist/.test(await page.locator("main").innerText()), "owner should see another colleague's request");
  expect(await page.getByLabel("Whose requests").count() === 1, "scope selector");
  await page.goto("/support/requests?scope=mine&q=Google+calendar", { waitUntil: "domcontentloaded" });
  await ready(page);
  expect(!/Google calendar/.test(await page.locator("main").innerText()), "scope=mine still shows colleague request");
  await shot(page, "owner-requests-1440");
  await context.close();
});

await check("other client: sees only their own workspace's requests", async () => {
  const context = await newContext();
  const page = await login(context, "other_owner");
  await page.goto("/support/requests", { waitUntil: "domcontentloaded" });
  await ready(page);
  const text = await page.locator("main").innerText();
  expect(/Oven schedule/.test(text), "own request missing");
  expect(!/Google calendar|invite a new hygienist|QA:/.test(text), "another client's request visible");
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Agency
// ---------------------------------------------------------------------------------------------------------------------------------------
const adminCtx = await newContext();
let apage;
await check("agency admin: Requests queue loads with views, counts and the request list", async () => {
  apage = await login(adminCtx, "agency_super_admin");
  await apage.goto("/admin/support", { waitUntil: "domcontentloaded" });
  await ready(apage);
  expect(await apage.getByRole("link", { name: "Requests", exact: true }).count() >= 1, "nav label");
  expect(await apage.getByRole("navigation", { name: "Saved views" }).count() === 1, "saved views");
  const text = await apage.locator("main").innerText();
  expect(/Harbor Dental/.test(text), "client name in queue");
  expect(await apage.getByRole("link", { name: /Analytics/ }).count() >= 1 && await apage.getByRole("link", { name: /Settings/ }).count() >= 1, "subnav");
  await shot(apage, "admin-queue-1440");
});

await check("agency admin: opens a request, adds an internal note and a reply, and the note is marked private", async () => {
  await apage.goto("/admin/support?q=calendar", { waitUntil: "domcontentloaded" });
  await ready(apage);
  await apage.locator('a[href*="ticket="]', { hasText: "Google calendar" }).first().click();
  await apage.waitForURL(/ticket=/);
  await apage.locator("#agency-reply").waitFor({ timeout: 60_000 });
  expect(await apage.getByText("Not visible to the client").count() >= 1, "seeded internal note should be marked private");
  await apage.getByRole("radio", { name: "Internal note" }).click();
  await apage.locator("#agency-reply").fill("QA INTERNAL NOTE: checked scopes with the client's admin.");
  await apage.getByRole("button", { name: "Add internal note" }).click();
  await apage.getByText("QA INTERNAL NOTE").first().waitFor({ timeout: 30_000 });
  await apage.getByRole("radio", { name: "Reply to client" }).click();
  await apage.locator("#agency-reply").fill("QA reply: we have re-requested calendar access; please approve the prompt when it appears.");
  await apage.getByRole("button", { name: "Send reply" }).click();
  await apage.getByText("QA reply: we have re-requested").first().waitFor({ timeout: 30_000 });
  await shot(apage, "admin-thread-1440");
});

await check("agency admin: priority, assignment and status controls change the request", async () => {
  await apage.locator("#d-priority").selectOption("high");
  await apage.waitForTimeout(1500);
  await apage.locator("#d-assignee").selectOption({ label: /Stan Staff/ }).catch(async () => {
    const options = await apage.locator("#d-assignee option").allInnerTexts();
    const stan = options.find((o) => /Stan Staff/.test(o));
    expect(stan, `Stan not assignable: ${options.join(" | ")}`);
    await apage.locator("#d-assignee").selectOption({ label: stan });
  });
  await apage.waitForTimeout(1500);
  await apage.locator("#d-status").selectOption("in_progress");
  await apage.waitForTimeout(1500);
  expect((await apage.locator("#d-priority").inputValue()) === "high", "priority not saved");
  expect(/Stan/.test(await apage.locator("#d-assignee").evaluate((el) => el.options[el.selectedIndex].text)), "assignee not saved");
});

await check("member: sees the team's reply but never the internal note", async () => {
  await mpage.goto("/support/requests?q=calendar", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  await mpage.locator('a[href^="/support/"]', { hasText: "Google calendar" }).first().click();
  await mpage.locator("#request-reply").waitFor({ timeout: 60_000 });
  const text = await mpage.locator("main").innerText();
  expect(/QA reply: we have re-requested/.test(text), "team reply missing");
  expect(!/INTERNAL|QA INTERNAL NOTE|read-only scope/.test(text), "internal note leaked");
  const api = await mpage.request.get(`/api/support/${mpage.url().split("/").pop()}/thread`);
  expect(!/INTERNAL/.test(await api.text()), "internal note in the API response");
});

await check("member: received an in-app notification for the team's reply", async () => {
  await mpage.goto("/notifications", { waitUntil: "domcontentloaded" });
  await ready(mpage);
  expect(await mpage.getByText(/iAcquire replied to IAQ-/).count() >= 1, "no reply notification");
});

await check("agency admin: Analytics shows real numbers and definitions", async () => {
  await apage.goto("/admin/support/analytics", { waitUntil: "domcontentloaded" });
  await ready(apage);
  const text = await apage.locator("main").innerText();
  expect(/Requests created/.test(text) && /How these numbers are defined/.test(text), "analytics content");
  expect(await apage.getByRole("button", { name: "Apply filters" }).count() === 1, "filters");
  await shot(apage, "admin-analytics-1440");
});

await check("agency admin: Settings saves and shows email-capture honesty", async () => {
  await apage.goto("/admin/support/settings", { waitUntil: "domcontentloaded" });
  await ready(apage);
  expect(/capture mode/.test(await apage.locator("main").innerText()), "capture-mode notice");
  // Change to a value that differs from what an earlier run saved, so the form is dirty and Save is enabled on every run.
  // The field must be hydrated first: a value typed before React takes over the form is thrown away when it does.
  await apage.waitForFunction(() => {
    const el = document.querySelector("#s-reopen");
    return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  }, null, { timeout: 120_000 });
  const wanted = (await apage.locator("#s-reopen").inputValue()) === "21" ? "14" : "21";
  await apage.locator("#s-reopen").fill(wanted);
  await apage.getByRole("button", { name: "Save changes" }).first().click();
  await apage.getByText("Support settings saved").waitFor({ timeout: 30_000 });
  await apage.reload({ waitUntil: "domcontentloaded" });
  await ready(apage);
  const saw = await apage.locator("#s-reopen").inputValue();
  expect(saw === wanted, `setting not persisted (wanted ${wanted}, saw ${saw})`);
  const select = apage.getByLabel("Delivery for: Request resolved");
  await select.selectOption("in_app");
  await apage.getByText(/Request resolved: in-app only/i).waitFor({ timeout: 30_000 });
  await select.selectOption("both");
  await shot(apage, "admin-settings-1440");
});

await check("agency staff: no analytics or settings, still works assigned clients' requests", async () => {
  const context = await newContext();
  const page = await login(context, "agency_staff");
  await page.goto("/admin/support", { waitUntil: "domcontentloaded" });
  await ready(page);
  expect(await page.getByRole("link", { name: /^Analytics/ }).count() === 0, "staff sees Analytics");
  expect(await page.getByRole("link", { name: /^Settings/ }).count() === 0, "staff sees Settings");
  const analytics = await page.goto("/admin/support/analytics", { waitUntil: "domcontentloaded" });
  await ready(page);
  expect(/isn't part of your role/.test(await page.locator("main").innerText()), `staff reached analytics (${analytics.status()})`);
  await context.close();
});

await check("out-of-scope staff: cannot see or open another client's request", async () => {
  const context = await newContext();
  const page = await login(context, "agency_staff_unassigned");
  await page.goto("/admin/support?view=all", { waitUntil: "domcontentloaded" });
  await ready(page);
  const text = await page.locator("main").innerText();
  expect(!/Harbor Dental/.test(text), "out-of-scope staff sees Harbor Dental requests");
  expect(/Northwind/.test(text), "own client's request should show");
  // A real Harbor request id (a request link, not one of the sidebar links that also start with /support/).
  const memberContext = await newContext();
  const memberPage = await login(memberContext, "member");
  await memberPage.goto("/support/requests?q=calendar", { waitUntil: "domcontentloaded" });
  await ready(memberPage);
  const requestHref = await memberPage.locator("main a").evaluateAll((els) => els.map((e) => e.getAttribute("href")).find((h) => /^\/support\/[0-9a-f-]{36}$/.test(h ?? "")) ?? null);
  expect(Boolean(requestHref), "no Harbor request found to try");
  await memberContext.close();
  await expectNotFound(page, `/admin/support/${requestHref.split("/").pop()}`, "Google calendar");
  await context.close();
});

await check("client users cannot open the agency Requests area", async () => {
  const context = await newContext();
  const page = await login(context, "member");
  for (const href of ["/admin/support", "/admin/support/analytics", "/admin/support/settings"]) {
    const res = await page.goto(href, { waitUntil: "domcontentloaded" });
    const text = await page.locator("body").innerText();
    expect(!new URL(page.url()).pathname.startsWith("/admin/support") || res.status() >= 400 || /couldn't find that page/i.test(text), `member reached ${page.url()}`);
    expect(!/Requests Management|Request analytics|Request settings/.test(text), `agency content shown at ${href}`);
  }
  await context.close();
});

for (const [w, h] of VIEWPORTS) {
  await check(`agency admin: Requests Management Center renders cleanly at ${w}px`, async () => {
    await apage.setViewportSize({ width: w, height: h });
    const tickets = await apage.request.get("/admin/support");
    expect(tickets.ok(), "queue");
    await apage.goto("/admin/support", { waitUntil: "domcontentloaded" });
    await ready(apage);
    await overflow(apage);
    await shot(apage, `admin-queue-${w}`);
    await apage.locator('a[href*="ticket="]').first().click();
    await apage.waitForURL(/ticket=/);
    await apage.locator("#agency-reply").waitFor({ timeout: 60_000 });
    await overflow(apage);
    await shot(apage, `admin-thread-${w}`);
    if (w === 1440 || w === 390) await axe(apage, `admin@${w}`);
    for (const [name, p] of [["analytics", "/admin/support/analytics"], ["settings", "/admin/support/settings"]]) {
      await apage.goto(p, { waitUntil: "domcontentloaded" });
      await ready(apage);
      await overflow(apage);
      await shot(apage, `admin-${name}-${w}`);
      if (w === 1440 || w === 390) await axe(apage, `${name}@${w}`);
    }
  });
}

await browser.close();

const failed = results.filter((r) => !r.ok);
const summary = { base: BASE, finishedAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results, blockedExternalRequests: [...blocked], pageProblems };
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(
  path.join(OUT, "report.md"),
  [`# Support & Requests browser QA`, ``, `${summary.passed} passed, ${summary.failed} failed. External requests blocked: ${blocked.size}. Page problems: ${pageProblems.length}.`, ``, ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`), ``, pageProblems.length ? `## Page problems\n${pageProblems.map((p) => `- ${p}`).join("\n")}` : ""].join("\n"),
);
console.log(`\n${summary.passed} passed, ${summary.failed} failed; external requests blocked: ${blocked.size}; page problems: ${pageProblems.length}`);
process.exit(failed.length || blocked.size ? 1 : 0);
