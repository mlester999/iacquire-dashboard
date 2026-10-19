// AQi UX polish QA: timings, tutorial-card placement, onboarding popup and chat Markdown in a real
// Chromium against the isolated QA server (scripts/crm-qa.mjs on http://127.0.0.1:3230). Fictional
// QA data only; nothing here touches a hosted service.
//
//   AQI_UX_LABEL=before|after  [AQI_UX_THROTTLE=1]  [AQI_UX_SCENARIOS=perf,card,onboarding,markdown,widths]
//   node scripts/aqi-ux-qa.mjs
//
// Output: .data/aqi-ux-qa/<label>/metrics.json, report.md and screenshots. Timings come from the
// isolated *development* server, so absolute numbers are inflated; compare before/after only.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LABEL = process.env.AQI_UX_LABEL ?? "run";
const THROTTLE = process.env.AQI_UX_THROTTLE === "1";
const OUT = path.join(ROOT, ".data/aqi-ux-qa", LABEL + (THROTTLE ? "-throttled" : ""));
const SHOTS = path.join(OUT, "screens");
const AUTH = path.join(ROOT, ".data/aqi-ux-qa/auth");
const BASE = process.env.AQI_QA_URL ?? "http://127.0.0.1:3230";
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(AUTH, { recursive: true });

const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, ".data/crm-qa/credentials.local.json"), "utf8"));
const defaultModule = path.join(ROOT, ".data/crm-qa/browser-runner/node_modules/playwright/index.mjs");
const modulePath = process.env.PLAYWRIGHT_MODULE ?? defaultModule;
const { chromium } = await import(modulePath.startsWith("file:") ? modulePath : `file:///${modulePath.replace(/\\/g, "/")}`);
const axeSource = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");

const WANT = new Set((process.env.AQI_UX_SCENARIOS ?? "perf,card,onboarding,markdown,widths").split(",").map((v) => v.trim()));
const want = (name) => WANT.has(name);
const report = { label: LABEL, throttled: THROTTLE, base: BASE, startedAt: new Date().toISOString(), scenarios: {}, checks: [], failures: [] };
function check(name, ok, detail = null) {
  report.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) report.failures.push({ name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const round = (value) => (typeof value === "number" ? Math.round(value) : value);

// One browser per context: a page crash in the dev server must not take the rest of the run down.
const browsers = new Set();

const INIT_SCRIPT = () => {
  // Layout shift, long tasks and a per-frame trace of the tutorial card, recorded inside the page.
  window.__aqi = { cls: 0, shifts: 0, longTasks: 0, trace: [], recording: false };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__aqi.cls += entry.value; window.__aqi.shifts += 1;
          if (entry.value > 0.005) (window.__aqi.shiftList ||= []).push({ value: Number(entry.value.toFixed(4)), at: Math.round(entry.startTime), nodes: (entry.sources ?? []).slice(0, 3).map((source) => `${source.node?.nodeName ?? "?"}.${String(source.node?.className ?? "").slice(0, 70)}`) });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => { window.__aqi.longTasks += list.getEntries().length; }).observe({ type: "longtask", buffered: true });
  } catch { /* unsupported */ }
  const sample = () => {
    if (window.__aqi.recording) {
      const card = document.querySelector('[role="dialog"][aria-labelledby="aqi-tutorial-title"]');
      if (card) {
        const rect = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        window.__aqi.trace.push({ t: performance.now(), left: rect.left, top: rect.top, width: rect.width, height: rect.height, opacity: style.visibility === "hidden" ? 0 : Number(style.opacity) });
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

async function newContext(role, viewport, { theme = "light" } = {}) {
  const user = credentials.users[role];
  if (!user) throw new Error(`No QA credential for ${role}`);
  const statePath = path.join(AUTH, `${role}.json`);
  const browser = await chromium.launch({ headless: true });
  browsers.add(browser);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(fs.existsSync(statePath) ? { storageState: statePath } : {}) });
  const closeContext = context.close.bind(context);
  context.close = async () => {
    await closeContext().catch(() => {});
    await browser.close().catch(() => {});
    browsers.delete(browser);
  };
  await context.addInitScript((value) => { try { localStorage.setItem("iaq-theme", value); } catch { /* storage unavailable */ } }, theme);
  await context.addInitScript(INIT_SCRIPT);
  await context.routeWebSocket(/\/_next\/webpack-hmr/, () => {});
  const page = await context.newPage();
  const bucket = { consoleErrors: [], pageErrors: [], failedRequests: [], serverErrors: [], api: [] };
  page.on("console", (message) => { if (message.type() === "error") bucket.consoleErrors.push(message.text().slice(0, 400)); });
  page.on("pageerror", (error) => bucket.pageErrors.push(String(error.message ?? error).slice(0, 400)));
  page.on("requestfailed", (request) => {
    if (!request.url().startsWith(BASE)) return;
    const failure = request.failure()?.errorText ?? "failed";
    if (!/ERR_ABORTED/.test(failure)) bucket.failedRequests.push({ url: request.url().replace(BASE, ""), failure });
  });
  page.on("response", (response) => { if (response.status() >= 500) bucket.serverErrors.push({ url: response.url().replace(BASE, ""), status: response.status() }); });
  page.on("requestfinished", async (request) => {
    const url = request.url();
    if (!url.startsWith(BASE) || !url.includes("/api/aqi")) return;
    const timing = request.timing();
    const response = await request.response().catch(() => null);
    bucket.api.push({
      method: request.method(),
      url: url.replace(BASE, "").split("?")[0],
      status: response?.status() ?? 0,
      ms: timing && timing.responseEnd >= 0 && timing.startTime >= 0 ? round(timing.responseEnd) : null,
    });
  });
  // Throttling is applied after the page has loaded (see perfScenario): a development server ships
  // several megabytes of unminified JavaScript, so throttling the page load itself would measure the
  // dev bundle, not AQi. Interactions (API calls, lazy chunks) are what is compared.
  const throttle = async () => {
    if (!THROTTLE) return;
    const cdp = await context.newCDPSession(page);
    // "Slow 4G": 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up, plus a 4x CPU slowdown.
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  };
  await signIn(page, user);
  await context.storageState({ path: statePath }).catch(() => {});
  return { context, page, bucket, user, throttle };
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
  if (new URL(page.url()).pathname.startsWith("/login")) throw new Error(`Sign-in failed for ${user.email}`);
}

async function waitForHydration(page, selector, timeout = 45_000) {
  try {
    await page.waitForFunction((value) => {
      const element = document.querySelector(value);
      return Boolean(element) && Object.keys(element).some((key) => key.startsWith("__reactProps$"));
    }, selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function goto(page, route) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      break;
    } catch (error) {
      if (attempt === 2 || !/interrupted|ERR_ABORTED|frame was detached/i.test(String(error))) throw error;
      await page.waitForTimeout(800);
    }
  }
  await waitForHydration(page, "[data-aqi-launcher]");
}

async function resetGuidance(page, { onboarding = false } = {}) {
  await page.evaluate(async ({ onboarding }) => {
    const path = window.location.pathname;
    const state = await fetch(`/api/aqi/tutorials?path=${encodeURIComponent(path)}`).then((r) => r.json()).catch(() => ({}));
    for (const active of state.state?.active ?? []) {
      await fetch(`/api/aqi/tutorials/${active.slug}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "exit", pathname: path, reason: "qa_reset" }) }).catch(() => {});
    }
    await fetch("/api/aqi/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: onboarding ? "reset" : "dismiss" }) }).catch(() => {});
  }, { onboarding }).catch(() => {});
}

async function warm(page, routes) {
  for (const route of routes) {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 120_000 }).catch(() => {});
    await waitForHydration(page, "[data-aqi-launcher]", 60_000);
  }
  // The dev server compiles each API route on its first request. Call every AQi route once so the
  // measured requests below are not dominated by compile time.
  await page.evaluate(async () => {
    const json = { "Content-Type": "application/json" };
    await Promise.all(["/api/aqi/bootstrap?path=%2Foverview", "/api/aqi/health", "/api/aqi/conversations?limit=20", "/api/aqi/tutorials?path=%2Foverview", "/api/aqi/onboarding?path=%2Foverview", "/api/aqi/tips?path=%2Foverview"].map((url) => fetch(url).catch(() => null)));
    await fetch("/api/aqi/tutorials", { method: "POST", headers: json, body: JSON.stringify({ slug: "getting-started", source: "library" }) }).catch(() => null);
    for (const action of ["viewed", "next", "pause", "resume", "exit"]) {
      await fetch("/api/aqi/tutorials/getting-started", { method: "POST", headers: json, body: JSON.stringify({ action, step: 0, pathname: "/overview" }) }).catch(() => null);
    }
    await fetch("/api/aqi/onboarding", { method: "POST", headers: json, body: JSON.stringify({ action: "dismiss" }) }).catch(() => null);
  }).catch(() => {});
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function takeApi(bucket) {
  const calls = bucket.api.splice(0);
  const counts = new Map();
  for (const call of calls) counts.set(`${call.method} ${call.url}`, (counts.get(`${call.method} ${call.url}`) ?? 0) + 1);
  return {
    calls: calls.map((call) => `${call.method} ${call.url} ${call.status} ${call.ms ?? "?"}ms`),
    duplicates: [...counts.entries()].filter(([, count]) => count > 1).map(([key, count]) => `${key} x${count}`),
  };
}

async function readCls(page) {
  return page.evaluate(() => ({ cls: Number(window.__aqi?.cls.toFixed(4)), shifts: window.__aqi?.shifts, longTasks: window.__aqi?.longTasks, big: window.__aqi?.shiftList ?? [] })).catch(() => null);
}

async function startTrace(page) {
  await page.evaluate(() => { window.__aqi.trace = []; window.__aqi.recording = true; });
}
async function stopTrace(page) {
  return page.evaluate(() => { window.__aqi.recording = false; return window.__aqi.trace; });
}

/** Summarises the per-frame card trace: where it first became visible and whether it jumped. */
function analyseTrace(trace, viewport) {
  const visible = trace.filter((frame) => frame.opacity > 0.08 && frame.width > 50);
  if (!visible.length) return { frames: trace.length, visibleFrames: 0 };
  const first = visible[0];
  const nearOrigin = visible.filter((frame) => frame.left < 40 && frame.top < 40);
  let maxJump = 0;
  for (let index = 1; index < visible.length; index += 1) {
    const jump = Math.hypot(visible[index].left - visible[index - 1].left, visible[index].top - visible[index - 1].top);
    if (jump > maxJump) maxJump = jump;
  }
  const last = visible.at(-1);
  return {
    frames: trace.length,
    visibleFrames: visible.length,
    firstVisible: { left: round(first.left), top: round(first.top), width: round(first.width), height: round(first.height), opacity: Number(first.opacity.toFixed(2)) },
    framesNearTopLeft: nearOrigin.length,
    maxJumpPx: round(maxJump),
    settled: { left: round(last.left), top: round(last.top), width: round(last.width), height: round(last.height) },
    viewport,
  };
}

async function axe(page, label) {
  await page.addScriptTag({ content: axeSource }).catch(() => {});
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).catch(() => null);
  if (!result) return check(`${label}: axe ran`, false);
  const serious = result.violations.filter((item) => ["serious", "critical"].includes(item.impact));
  check(`${label}: no serious axe violations`, serious.length === 0, serious.map((item) => `${item.id} [${item.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}]`).join(", "));
}

async function openPanel(page) {
  const launcher = page.locator("[data-aqi-launcher]");
  await launcher.waitFor({ state: "visible", timeout: 30_000 });
  await launcher.click();
  await page.locator("[data-aqi-panel]").waitFor({ state: "visible", timeout: 30_000 });
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: round(performance.now() - start), value };
}

// ---------------------------------------------------------------------------
// perf: cold/warm open, onboarding popup, tutorial start, first spotlight, next, cross-page, pause/resume
// ---------------------------------------------------------------------------
const CARD_SELECTOR = '[data-aqi-card], [role="dialog"][aria-labelledby="aqi-tutorial-title"]';

/** Runs inside the page: programmatic click on the launcher, then per-frame probes of what appears. */
const OPEN_PROBE = () => new Promise((resolve) => {
  const t0 = performance.now();
  const r = {};
  document.querySelector("[data-aqi-launcher]").click();
  const tick = () => {
    const now = performance.now() - t0;
    const panel = document.querySelector("[data-aqi-panel]");
    if (panel) {
      if (r.mountedMs === undefined) r.mountedMs = Math.round(now);
      if (r.visibleMs === undefined && Number(getComputedStyle(panel).opacity) > 0.05) r.visibleMs = Math.round(now);
      const field = panel.querySelector("textarea");
      if (r.inputUsableMs === undefined && field && !field.disabled) r.inputUsableMs = Math.round(now);
      if (r.welcomeMs === undefined && panel.querySelectorAll(".skeleton").length === 0 && /Try asking|guided tour|Ask about/i.test(panel.textContent ?? "")) r.welcomeMs = Math.round(now);
    }
    if ((r.visibleMs !== undefined && r.inputUsableMs !== undefined && r.welcomeMs !== undefined) || now > 12_000) return resolve(r);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

/** Runs inside the page: click "Take a quick guided tour" and time feedback, the card and the spotlight. */
const START_PROBE = (selector) => new Promise((resolve) => {
  const button = [...document.querySelectorAll("button")].find((candidate) => /Take a quick guided tour/.test(candidate.textContent ?? ""));
  if (!button) return resolve({ error: "tour button not found" });
  const t0 = performance.now();
  const r = {};
  button.click();
  const tick = () => {
    const now = performance.now() - t0;
    if (r.feedbackMs === undefined && (button.disabled || button.getAttribute("aria-busy") === "true" || document.querySelector("[data-aqi-starting]"))) r.feedbackMs = Math.round(now);
    const card = document.querySelector(selector);
    if (card) {
      const style = getComputedStyle(card);
      const rect = card.getBoundingClientRect();
      if (r.cardVisibleMs === undefined && style.visibility !== "hidden" && Number(style.opacity) > 0.05 && rect.width > 50) {
        r.cardVisibleMs = Math.round(now);
        r.cardRect = { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
        if (r.feedbackMs === undefined) r.feedbackMs = Math.round(now);
      }
    }
    const highlight = document.querySelector("[data-aqi-highlight]");
    if (highlight && r.spotlightMs === undefined && highlight.getBoundingClientRect().width > 10) r.spotlightMs = Math.round(now);
    if ((r.cardVisibleMs !== undefined && r.spotlightMs !== undefined) || now > 15_000) return resolve(r);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

/** Runs inside the page: click Next and time how long until the step title changes. */
const NEXT_PROBE = () => new Promise((resolve) => {
  const title = () => document.querySelector("#aqi-tutorial-title")?.textContent ?? "";
  const before = title();
  const button = document.querySelector('[data-aqi-control="next"]');
  if (!button) return resolve({ error: "next button not found" });
  const t0 = performance.now();
  button.click();
  const r = {};
  const tick = () => {
    const now = performance.now() - t0;
    const current = title();
    if (current && current !== before && r.titleMs === undefined) r.titleMs = Math.round(now);
    const highlight = document.querySelector("[data-aqi-highlight]");
    if (r.titleMs !== undefined && highlight && highlight.getBoundingClientRect().width > 10 && r.spotlightMs === undefined) r.spotlightMs = Math.round(now);
    if ((r.titleMs !== undefined && r.spotlightMs !== undefined) || now > 12_000) return resolve(r);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function perfScenario(viewport, tag) {
  const result = { viewport };
  const { context, page, bucket, throttle } = await newContext("sales_rep", viewport);
  try {
    await warm(page, ["/overview", "/settings", "/crm/contacts"]);
    await goto(page, "/overview");
    await resetGuidance(page);
    // Cold = a fresh document with nothing from AQi preloaded or cached by this page.
    await goto(page, "/overview");
    await page.waitForTimeout(3_000); // let idle prefetches finish so the open itself is measured
    await throttle();
    takeApi(bucket);

    // A. Cold open.
    result.coldOpen = { ...(await page.evaluate(OPEN_PROBE)), ...takeApi(bucket) };

    // B. Warm reopen.
    await page.keyboard.press("Escape");
    await page.locator("[data-aqi-panel]").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(400);
    takeApi(bucket);
    result.warmReopen = { ...(await page.evaluate(OPEN_PROBE)), ...takeApi(bucket) };

    // D/E. Start the quick tour from the panel; time feedback, the card and the first spotlight.
    await page.getByRole("button", { name: /Take a quick guided tour/ }).waitFor({ state: "visible", timeout: 20_000 });
    takeApi(bucket);
    await startTrace(page);
    const started = await page.evaluate(START_PROBE, CARD_SELECTOR);
    await page.waitForTimeout(900);
    // Start-up breakdown from the product's own User Timing marks (ms after the click).
    const marks = await page.evaluate(() => {
      const entries = performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith("aqi:"));
      const click = entries.filter((entry) => entry.name === "aqi:start:click").at(-1)?.startTime;
      if (click === undefined) return null;
      const out = {};
      for (const entry of entries) {
        // Marks before the click show what was already done in the background (for example the preloaded chunk).
        if (entry.startTime >= click) out[entry.name.replace("aqi:", "")] = Math.round(entry.startTime - click);
        else if (entry.name.startsWith("aqi:chunk")) out[`before:${entry.name.replace("aqi:", "")}`] = Math.round(entry.startTime - click);
      }
      return out;
    });
    result.startTutorial = { ...started, marks, trace: analyseTrace(await stopTrace(page), viewport), ...takeApi(bucket) };
    await shot(page, `${tag}-tour-step1`);
    // On a phone the open AQi sheet must not sit on top of the walkthrough.
    result.startTutorial.panelStillOpen = await page.locator("[data-aqi-panel]").isVisible().catch(() => false);
    result.startTutorial.cardCovered = await page.evaluate((selector) => {
      const card = document.querySelector(selector);
      if (!card) return null;
      const rect = card.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(24, rect.height / 2));
      return !card.contains(top);
    }, CARD_SELECTOR);
    check(`${tag}: the walkthrough card is not covered by another surface`, result.startTutorial.cardCovered === false, result.startTutorial);

    // F. Next step.
    if (result.startTutorial.panelStillOpen && viewport.width < 640) await page.keyboard.press("Escape").catch(() => {});
    takeApi(bucket);
    result.nextStep = { ...(await page.evaluate(NEXT_PROBE)), ...takeApi(bucket) };

    // H. Pause then resume.
    await page.getByRole("button", { name: "Pause walkthrough" }).click({ timeout: 8_000 });
    await page.getByText(/Paused at step/).waitFor({ state: "visible", timeout: 10_000 });
    takeApi(bucket);
    const resume = await timed(async () => {
      await page.getByRole("button", { name: "Resume" }).click();
      await page.locator("#aqi-tutorial-title").waitFor({ state: "visible", timeout: 20_000 });
    });
    result.pauseResume = { resumeMs: resume.ms, ...takeApi(bucket) };
    await page.locator('[data-aqi-control="exit"]').click({ timeout: 5_000 }).catch(() => {});

    result.layoutShift = await readCls(page);
    result.errors = { console: bucket.consoleErrors.slice(0, 5), page: bucket.pageErrors.slice(0, 5), failed: bucket.failedRequests.slice(0, 5), server: bucket.serverErrors.slice(0, 5) };
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 400);
    check(`${tag}: perf scenario completed`, false, result.error);
    await shot(page, `${tag}-perf-error`).catch(() => {});
  } finally {
    await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------
// card: a step on another page (the reported top-left card) and one with a real target
// ---------------------------------------------------------------------------
async function cardScenario(viewport, tag) {
  const result = { viewport };
  const { context, page, bucket } = await newContext("sales_rep", viewport);
  try {
    await warm(page, ["/overview", "/crm/contacts"]);
    await goto(page, "/crm/contacts");
    await resetGuidance(page);
    await goto(page, "/crm/contacts");
    // getting-started step 1 lives on /overview: starting it from Contacts shows the cross-page card.
    await page.evaluate(async () => {
      await fetch("/api/aqi/tutorials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "getting-started", source: "library" }) });
    });
    await goto(page, "/crm/contacts");
    await page.getByRole("button", { name: "Resume" }).waitFor({ state: "visible", timeout: 30_000 });
    await startTrace(page);
    await page.getByRole("button", { name: "Resume" }).click();
    const card = page.locator(CARD_SELECTOR).first();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(900);
    const trace = analyseTrace(await stopTrace(page), viewport);
    const box = await card.boundingBox();
    result.crossPageCard = { box, trace, text: (await card.innerText()).slice(0, 300) };
    await shot(page, `${tag}-card-cross-page`);
    const nearTopLeft = box && box.x < 40 && box.y < 40;
    check(`${tag}: cross-page card is not stuck at the top-left`, !nearTopLeft, box);
    check(`${tag}: cross-page card is compact`, Boolean(box) && box.width <= (viewport.width < 640 ? viewport.width : 420), box);
    check(`${tag}: cross-page card stays inside the viewport`, Boolean(box) && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, box);
    check(`${tag}: cross-page card never flashed at the top-left`, (trace.framesNearTopLeft ?? 0) === 0, trace);
    await axe(page, `${tag} cross-page card`);

    // Follow the card's action to the real destination and check the continued step.
    await card.getByRole("button", { name: /^Open / }).click();
    await page.locator("#aqi-tutorial-title").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator("[data-aqi-highlight]").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(600);
    await shot(page, `${tag}-card-after-navigation`);
    const step = await page.locator(CARD_SELECTOR).first().boundingBox();
    const target = await page.locator('[data-aqi-target="overview.hero"]').first().boundingBox();
    result.afterNavigation = { step, target };
    if (step && target) {
      const overlaps = step.x < target.x + target.width && step.x + step.width > target.x && step.y < target.y + target.height && step.y + step.height > target.y;
      check(`${tag}: card does not cover its own target`, !overlaps, { step, target });
    }
    await page.locator('[data-aqi-control="exit"]').click().catch(() => {});
    result.errors = { console: bucket.consoleErrors.slice(0, 5), page: bucket.pageErrors.slice(0, 5) };
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 400);
    check(`${tag}: card scenario completed`, false, result.error);
    await shot(page, `${tag}-card-error`).catch(() => {});
  } finally {
    await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------
// onboarding: the first-run welcome popup next to the launcher
// ---------------------------------------------------------------------------
async function onboardingScenario(viewport, tag) {
  const result = { viewport };
  const { context, page } = await newContext("sales_rep", viewport);
  try {
    await warm(page, ["/overview"]);
    await goto(page, "/overview");
    await resetGuidance(page, { onboarding: true });
    const start = performance.now();
    await page.goto(`${BASE}/overview`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const popup = page.locator('[role="dialog"][aria-labelledby="aqi-welcome-title"]');
    await popup.waitFor({ state: "visible", timeout: 30_000 });
    result.popupVisibleAfterNavMs = round(performance.now() - start);
    await page.waitForTimeout(500);
    const box = await popup.boundingBox();
    const launcher = await page.locator("[data-aqi-launcher]").boundingBox();
    result.box = box;
    result.launcher = launcher;
    result.text = (await popup.innerText()).replace(/\s+/g, " ").slice(0, 300);
    await shot(page, `${tag}-onboarding`);
    if (box && launcher) {
      const overlaps = box.x < launcher.x + launcher.width && box.x + box.width > launcher.x && box.y < launcher.y + launcher.height && box.y + box.height > launcher.y;
      const gap = launcher.y - (box.y + box.height);
      check(`${tag}: onboarding popup does not overlap the launcher`, !overlaps, { box, launcher });
      check(`${tag}: onboarding popup sits at least 8px above the launcher`, gap >= 8 || box.y > launcher.y + launcher.height, { gap });
      check(`${tag}: onboarding popup stays on screen`, box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, box);
    }
    await axe(page, `${tag} onboarding popup`);
    // Leave a clean state for the next run.
    await resetGuidance(page);
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 400);
    check(`${tag}: onboarding scenario completed`, false, result.error);
    await shot(page, `${tag}-onboarding-error`).catch(() => {});
  } finally {
    await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------
// markdown: stream awkward chunks through the real widget and inspect the rendered DOM
// ---------------------------------------------------------------------------
const MALFORMED = [
  "AQi helps in one place. As the owner, you can also manage the workspace itself: add teammates and their roles under [Team] (Settings → Team), and connect outside services such as Hermes under [Integrations](Settings → Integrations). AI employees live in [AI Workforce](AI Workforce), where you can chat with each one.",
  "",
  "A good starting point is checking Integrations, then [Team], then [AI Workforce].",
].join("\n");

const RICH = [
  "Here is a **short plan**:",
  "",
  "1. Open [Integrations](/settings/integrations) to review services.",
  "2. Open [Team](/settings/team) to manage people.",
  "3. Check [the admin page](/admin/aqi) (not for you).",
  "",
  "- Use `inline code` for names",
  "- A literal [bracket] stays",
  "",
  "```",
  "const sample = [1, 2, 3]; // [Team] is literal here",
  "```",
  "",
  "> A quote about [Integrations](Settings → Integrations)",
  "",
  "| Page | Purpose |",
  "| --- | --- |",
  "| Team | People |",
  "| Integrations | Services |",
  "",
  "Unsafe: [x](javascript:alert(1)) and [site](https://example.com).",
].join("\n");

async function installChatMock(page, text, { chunkSize = 7, delayMs = 18 } = {}) {
  await page.evaluate(({ text, chunkSize, delayMs }) => {
    const realFetch = window.__realFetch ?? window.fetch.bind(window);
    window.__realFetch = realFetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("/api/aqi/chat")) return realFetch(input, init);
      const encoder = new TextEncoder();
      const send = (event) => `data: ${JSON.stringify(event)}\n\n`;
      const messageId = `mock-${Math.random().toString(16).slice(2)}`;
      const pieces = [];
      for (let index = 0; index < text.length; index += chunkSize) pieces.push(text.slice(index, index + chunkSize));
      const frames = [send({ type: "meta", conversationId: "mock-conversation", messageId }), ...pieces.map((piece) => send({ type: "delta", text: piece })),
        send({ type: "done", message: { id: messageId, role: "assistant", content: text, status: "complete", feedbackRating: null, feedbackComment: null, createdAt: new Date().toISOString() }, sources: [], guide: null, usage: { latencyMs: 1 } })];
      // Split frames at arbitrary byte boundaries so a JSON payload can span two network reads.
      const joined = frames.join("");
      const reads = [];
      for (let index = 0; index < joined.length; index += 23) reads.push(joined.slice(index, index + 23));
      const stream = new ReadableStream({
        async start(controller) {
          for (const read of reads) {
            await new Promise((resolve) => setTimeout(resolve, delayMs / 6));
            controller.enqueue(encoder.encode(read));
          }
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    };
  }, { text, chunkSize, delayMs });
}

async function ask(page, question) {
  const field = page.locator("[data-aqi-panel] textarea");
  await field.fill(question);
  await field.press("Enter");
  // The answer is finished when the writing cursor is gone and the text has stopped changing.
  let previous = "";
  let stableFor = 0;
  for (let attempt = 0; attempt < 120 && stableFor < 4; attempt += 1) {
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll("[data-aqi-panel] .prose-chat")];
      return { text: bubbles.at(-1)?.textContent ?? "", writing: Boolean(document.querySelector("[data-aqi-panel] [data-aqi-writing]")) };
    });
    if (!state.writing && state.text && state.text === previous) stableFor += 1;
    else stableFor = 0;
    previous = state.text;
  }
}

async function markdownScenario(viewport, tag, role = "owner") {
  const result = { viewport, role };
  const { context, page, bucket } = await newContext(role, viewport);
  try {
    await warm(page, ["/overview"]);
    await goto(page, "/overview");
    await resetGuidance(page);
    await goto(page, "/overview");
    await openPanel(page);
    await installChatMock(page, MALFORMED);
    await ask(page, "What can I do as the owner?");
    const malformed = await page.evaluate(() => {
      const bubble = [...document.querySelectorAll("[data-aqi-panel] .prose-chat")].at(-1);
      return { text: bubble?.textContent ?? "", links: [...(bubble?.querySelectorAll("a") ?? [])].map((a) => ({ text: a.textContent, href: a.getAttribute("href") })) };
    });
    result.malformed = malformed;
    await shot(page, `${tag}-markdown-malformed`);
    check(`${tag}: no raw [Label] syntax is displayed for page references`, !/\[(Team|Integrations|AI Workforce)\]/.test(malformed.text), malformed.text.slice(0, 400));
    check(`${tag}: no raw (Settings → Team) destinations are displayed`, !/\]\(|\(Settings →|\(AI Workforce\)/.test(malformed.text), malformed.text.slice(0, 400));
    check(`${tag}: only real routes become links`, malformed.links.every((l) => l.href?.startsWith("/") && !/\s|→/.test(l.href)), malformed.links);

    await page.locator("[data-aqi-panel]").getByRole("button", { name: /New chat|new conversation/i }).first().click({ timeout: 3_000 }).catch(() => {});
    await installChatMock(page, RICH);
    await ask(page, "Show me a rich answer");
    const rich = await page.evaluate(() => {
      const bubble = [...document.querySelectorAll("[data-aqi-panel] .prose-chat")].at(-1);
      return {
        text: bubble?.textContent ?? "",
        html: bubble?.innerHTML ?? "",
        links: [...(bubble?.querySelectorAll("a") ?? [])].map((a) => ({ text: a.textContent, href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") })),
        hasOl: Boolean(bubble?.querySelector("ol")), hasUl: Boolean(bubble?.querySelector("ul")), hasPre: Boolean(bubble?.querySelector("pre")),
        hasBlockquote: Boolean(bubble?.querySelector("blockquote")), hasTable: Boolean(bubble?.querySelector("table")), hasStrong: Boolean(bubble?.querySelector("strong")),
        preText: bubble?.querySelector("pre")?.textContent ?? "",
        overflowX: (() => { const scroller = bubble?.closest("[class*=overflow]"); return scroller ? scroller.scrollWidth - scroller.clientWidth : 0; })(),
      };
    });
    result.rich = rich;
    await shot(page, `${tag}-markdown-rich`);
    check(`${tag}: renders list, bold, inline code, code block, quote and table`, rich.hasOl && rich.hasUl && rich.hasPre && rich.hasBlockquote && rich.hasTable && rich.hasStrong, rich);
    check(`${tag}: authorized route is a real link`, rich.links.some((l) => l.href === "/settings/integrations" && l.text === "Integrations"), rich.links);
    check(`${tag}: unauthorized admin route is not a link`, !rich.links.some((l) => l.href?.startsWith("/admin")), rich.links);
    check(`${tag}: javascript: URL never becomes a link`, !rich.links.some((l) => /^javascript:/i.test(l.href ?? "")), rich.links);
    check(`${tag}: brackets inside code stay literal`, rich.preText.includes("[Team]") && rich.preText.includes("[1, 2, 3]"), rich.preText);
    check(`${tag}: a legitimate [bracket] is preserved`, rich.text.includes("[bracket]"), rich.text.slice(0, 300));
    check(`${tag}: external links open safely`, rich.links.filter((l) => l.href?.startsWith("http")).every((l) => l.target === "_blank" && /noopener/.test(l.rel ?? "")), rich.links);
    await axe(page, `${tag} chat markdown`);
    result.errors = { console: bucket.consoleErrors.slice(0, 5), page: bucket.pageErrors.slice(0, 5) };
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 400);
    check(`${tag}: markdown scenario completed`, false, result.error);
    await shot(page, `${tag}-markdown-error`).catch(() => {});
  } finally {
    await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------
const WIDTHS = [{ name: "mobile-390", width: 390, height: 844 }, { name: "tablet-768", width: 768, height: 1024 }, { name: "mid-1024", width: 1024, height: 768 }, { name: "desktop-1440", width: 1440, height: 900 }];

function flush() {
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(report, null, 2));
}
async function run(name, fn) {
  try {
    report.scenarios[name] = await fn();
  } catch (error) {
    report.scenarios[name] = { error: String(error?.message ?? error).slice(0, 400) };
    check(`${name}: scenario ran`, false, report.scenarios[name].error);
  }
  flush();
}

if (want("perf")) {
  const repeats = Math.max(1, Number(process.env.AQI_UX_REPEAT ?? 1));
  for (let index = 0; index < repeats; index += 1) {
    const suffix = repeats > 1 ? `-${index + 1}` : "";
    await run(`perfDesktop${suffix}`, () => perfScenario({ width: 1440, height: 900 }, `desktop${suffix}`));
    await run(`perfMobile${suffix}`, () => perfScenario({ width: 390, height: 844 }, `mobile${suffix}`));
  }
}
if (want("card")) {
  for (const size of WIDTHS) await run(`card-${size.name}`, () => cardScenario({ width: size.width, height: size.height }, size.name));
}
if (want("onboarding")) {
  for (const size of WIDTHS) await run(`onboarding-${size.name}`, () => onboardingScenario({ width: size.width, height: size.height }, size.name));
}
if (want("markdown")) {
  await run("markdown-desktop-1440", () => markdownScenario({ width: 1440, height: 900 }, "desktop-1440"));
  await run("markdown-mobile-390", () => markdownScenario({ width: 390, height: 844 }, "mobile-390"));
}

for (const browser of browsers) await browser.close().catch(() => {});
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(report, null, 2));
const lines = [`# AQi UX QA (${LABEL}${THROTTLE ? ", throttled" : ""})`, "", `Run ${report.startedAt} against ${BASE}. ${report.checks.filter((c) => c.ok).length} passed, ${report.failures.length} failed.`, ""];
for (const failure of report.failures) lines.push(`- FAIL ${failure.name}: ${typeof failure.detail === "string" ? failure.detail : JSON.stringify(failure.detail)}`);
fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n"));
console.log(`\n${report.checks.filter((c) => c.ok).length} passed, ${report.failures.length} failed. Metrics: ${path.join(OUT, "metrics.json")}`);
process.exit(report.failures.length ? 1 : 0);
