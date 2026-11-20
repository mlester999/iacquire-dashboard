// Set CRM_QA_PORT to the port used by scripts/crm-qa.mjs. Seed with scripts/run-crm-qa-seed.mjs first.
// PLAYWRIGHT_MODULE and AXE_SOURCE can point to local QA tool installations.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertIsolated, CRM_QA_DATA_DIR, CRM_QA_URL } from "./crm-qa-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
assertIsolated({ root });
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  : await import("playwright");
const axeSource = process.env.AXE_SOURCE ?? path.join(root, "node_modules/axe-core/axe.min.js");
const credentials = JSON.parse(await readFile(path.join(root, CRM_QA_DATA_DIR, "credentials.local.json"), "utf8"));
assert.ok(["127.0.0.1", "localhost"].includes(new URL(credentials.baseUrl).hostname));
const { email, password } = credentials.users.owner;
const output = path.join(root, ".data/login-qa/redesign");
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const matrix = [];
const blockedOrigins = new Set();
const requiredScreenshots = new Set([320, 375, 430, 768, 1280, 1440, 1920]);

async function localContext(options) {
  const context = await browser.newContext(options);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === CRM_QA_URL) return route.continue();
    blockedOrigins.add(url.origin);
    return route.abort();
  });
  return context;
}

async function open(page, pathname) {
  const result = await page.goto(new URL(pathname, CRM_QA_URL).href, { timeout: 180_000 });
  assert.ok(result?.ok(), pathname + " returned HTTP " + result?.status());
}

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 360, 375, 390, 430, 768, 1024, 1280, 1440, 1920]) {
      const height = width < 600 ? 680 : width < 1024 ? 1024 : width < 1440 ? 800 : width < 1920 ? 900 : 1080;
      const context = await localContext({ viewport: { width, height }, reducedMotion: "reduce", hasTouch: width < 600 });
      try {
        await context.addInitScript((value) => localStorage.setItem("iaq-theme", value), theme);
        const page = await context.newPage();
        await open(page, "/login");
        await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        assert.ok(await page.getByText("Open your workspace and AI Growth Partner.").isVisible());
        const capabilities = page.getByRole("list", { name: "Growth Partner capabilities" });
        assert.equal(await capabilities.isVisible(), width >= 1024);
        if (width >= 1024) assert.equal(await capabilities.getByRole("listitem").count(), 6);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Horizontal overflow at " + width);
        const button = await page.getByRole("button", { name: "Sign in", exact: true }).boundingBox();
        assert.ok(button && button.height >= 44 && button.x >= 0 && button.x + button.width <= width && button.y + button.height <= height, "Sign-in control must fit the first viewport");
        const toggle = await page.getByRole("button", { name: "Show password" }).boundingBox();
        assert.ok(toggle && toggle.width >= 44 && toggle.height >= 44, "Password toggle should have a 44px touch target");
        assert.equal(await page.locator('[data-partner-artwork] circle').evaluateAll((signals) =>
          signals.every((signal) => getComputedStyle(signal).animationName === "none")), true, "Reduced motion should disable diagram motion");
        if (requiredScreenshots.has(width)) {
          await page.screenshot({ path: path.join(output, "login-" + theme + "-" + width + ".png"), fullPage: true, animations: "disabled", style: "nextjs-portal { display: none }" });
        }
        if ([320, 1440].includes(width)) {
          await page.addScriptTag({ path: axeSource });
          const violations = await page.evaluate(async () => (await window.axe.run({
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          })).violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) })));
          assert.deepEqual(violations, [], "Accessibility violations at " + theme + "/" + width);
        }
        matrix.push({ width, height, theme });
      } finally {
        await context.close();
      }
    }
  }

  const context = await localContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await open(page, "/login?next=%2Fgrowth-partner");
    const submit = page.getByRole("button", { name: "Sign in", exact: true });
    const emailInput = page.getByLabel("Work email");
    const passwordInput = page.getByLabel("Password", { exact: true });
    assert.equal((await page.content()).includes(password), false, "Sign-in HTML must not expose seeded credentials");
    await emailInput.focus();
    await page.keyboard.press("Tab");
    assert.equal(await passwordInput.evaluate((input) => document.activeElement === input), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Show password" }).evaluate((button) => document.activeElement === button), true);
    await submit.click();
    assert.equal(await emailInput.evaluate((input) => input.validity.valueMissing && document.activeElement === input), true);
    await emailInput.fill("malformed-address");
    await passwordInput.fill("incorrect-password");
    await submit.click();
    assert.equal(await emailInput.evaluate((input) => input.validity.typeMismatch), true);
    await page.getByRole("button", { name: "Show password" }).click();
    assert.equal(await passwordInput.getAttribute("type"), "text");
    await page.keyboard.press("Space");
    assert.equal(await passwordInput.getAttribute("type"), "password");
    await emailInput.fill(email);
    let releaseSignIn;
    const heldSignIn = new Promise((resolve) => { releaseSignIn = resolve; });
    const holdAction = async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await heldSignIn;
      await route.continue();
    };
    await page.route("**/login?next=%2Fgrowth-partner", holdAction);
    try {
      await submit.click();
      const pending = page.getByRole("button", { name: "Signing in…" });
      await pending.waitFor();
      assert.equal(await pending.isDisabled(), true);
    } finally {
      releaseSignIn();
    }
    await page.getByRole("alert").getByText("Email or password is incorrect.").waitFor();
    await page.unroute("**/login?next=%2Fgrowth-partner", holdAction);
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await page.waitForURL("**/forgot-password");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await open(page, "/login?reset=1&next=%2Fgrowth-partner");
    await page.getByRole("status").getByText("Your password was updated. Sign in with your new password.").waitFor();
    await page.getByRole("link", { name: "Get started" }).click();
    await page.waitForURL("**/get-started");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await open(page, "/login?next=%2Fgrowth-partner");
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await page.locator('html[data-theme="dark"]').waitFor();
    await open(page, "/login?next=%2Fgrowth-partner");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await emailInput.fill(email);
    await passwordInput.fill(password);
    await Promise.all([page.waitForURL("**/growth-partner", { timeout: 180_000 }), submit.click()]);
    await open(page, "/login?next=%2Fgrowth-partner");
    assert.equal(new URL(page.url()).pathname, "/growth-partner");
    await open(page, "/login?next=https%3A%2F%2Fwww.example.com%2F");
    assert.equal(new URL(page.url()).origin, CRM_QA_URL);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: /^Account menu/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Log out", exact: true }).click();
    await page.waitForURL("**/login?signed_out=1");
    await page.getByRole("status").getByText("You've been signed out.").waitFor();
    await open(page, "/growth-partner");
    assert.equal(new URL(page.url()).pathname, "/login");
    await open(page, "/invite/qa-unknown-invitation");
    await page.getByRole("heading", { name: "Invitation unavailable" }).waitFor();
    await page.getByRole("link", { name: "Go to sign in" }).click();
    await page.waitForURL("**/login");
  } finally {
    await context.close();
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify({
    matrix,
    accessibility: "WCAG 2.1 A/AA via axe at 320px and 1440px in light and dark",
    functional: "Native validation, password visibility, keyboard navigation and activation, pending state, invalid credentials, reset and access routes, theme persistence, local sign-in, session, logout, protected-route redirect, external-redirect rejection and invalid invitation recovery",
    blockedOrigins: [...blockedOrigins],
  }, null, 2));
  console.log("Login QA passed: " + matrix.length + " viewports/themes plus local sign-in and session checks.");
} finally {
  await browser.close();
}
