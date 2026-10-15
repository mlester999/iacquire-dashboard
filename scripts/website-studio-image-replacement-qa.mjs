// Authenticated owner image replacement/restore check against the isolated local PGLite fixture.
// Seed it with scripts/run-studio-qa-seed.mjs; this never targets a hosted service.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const playwrightPath = process.env.PLAYWRIGHT_MODULE;
if (!playwrightPath) throw new Error("Set PLAYWRIGHT_MODULE to the installed Playwright module path.");
const { chromium } = await import(playwrightPath);
const credentials = JSON.parse(await fs.readFile(".data/studio-premium-qa/credentials.json", "utf8"));
assert.equal(credentials.baseUrl, "http://localhost:3210", "This QA script only runs on the isolated local server.");
const output = path.resolve(".data/studio-qa/image-replacement");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
await context.routeWebSocket("**/_next/webpack-hmr", (socket) => socket.close());
const owner = credentials.accounts.owner;
await context.addCookies([
  { name: "iaq_session", value: owner.sessionToken, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  { name: "iaq_org", value: credentials.fixtures[0].organization.id, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
]);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const imageById = (id) => page.locator(`[data-canvas-frame] [data-nid="${id}"]`);
const properties = () => page.getByRole("complementary", { name: "Settings for the selected item" });
const save = async () => {
  await page.getByRole("button", { name: "Save draft (Ctrl+S)", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^(Saved|All changes saved)$/ }).first().waitFor({ timeout: 60000 });
};
let mutationSaved = false;
async function restoreOriginalDraft() {
  if (!mutationSaved) return;
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Version history", exact: true });
  const versionOne = history.getByRole("listitem").filter({ hasText: "Version 1" }).last();
  await versionOne.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("dialog", { name: "Restore version 1?", exact: true }).getByRole("button", { name: "Restore", exact: true }).click();
  await history.waitFor({ state: "hidden" });
  mutationSaved = false;
}

try {
  await page.goto(`${credentials.baseUrl}${credentials.routes.clientEditor}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator("[data-studio]").waitFor({ timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  if (await page.getByRole("button", { name: "Skip", exact: true }).isVisible()) await page.getByRole("button", { name: "Skip", exact: true }).click();
  const about = credentials.fixtures[0].pages.find((candidate) => candidate.slug === "about");
  assert.ok(about, "QA fixture should include an About page with a starter image.");
  await page.getByLabel("Page", { exact: true }).selectOption(about.id);
  const image = page.locator("[data-canvas-frame] [data-ntype=image]").first();
  await image.waitFor();
  const imageId = await image.getAttribute("data-nid");
  const defaultSource = await image.locator("img").getAttribute("src");
  assert.match(defaultSource, /\/template-images\//, "About image should begin with its template starter.");

  await image.click();
  await properties().getByRole("button", { name: /replace image$/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Use image: QA library replacement image/ }).click();
  mutationSaved = true;
  const replacementSource = await imageById(imageId).locator("img").getAttribute("src");
  assert.notEqual(replacementSource, defaultSource);
  assert.match(replacementSource, /\/api\/assets\//);
  const selectedField = properties().locator(".space-y-1").filter({ has: page.getByText(/Your image ·/) }).first();
  const fieldActions = await properties().getByRole("button").evaluateAll((buttons) => buttons.map((button) => ({ text: button.textContent?.trim(), label: button.getAttribute("aria-label") })));
  console.log(JSON.stringify({ replacementSource, selectedField: await selectedField.innerText().catch(() => "not found"), fieldActions }));
  assert.equal(await properties().getByRole("button", { name: "Restore default", exact: true }).count(), 1);
  await save();
  await page.screenshot({ path: path.join(output, "client-image-replaced.jpg"), type: "jpeg", quality: 86 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Page", { exact: true }).selectOption(about.id);
  assert.equal(await imageById(imageId).locator("img").getAttribute("src"), replacementSource, "Replacement should persist after refresh.");

  await imageById(imageId).click();
  await properties().getByRole("button", { name: "Restore default", exact: true }).click();
  assert.equal(await imageById(imageId).locator("img").getAttribute("src"), defaultSource, "Restore should return to the slot's original starter.");
  await save();
  await page.screenshot({ path: path.join(output, "client-image-restored.jpg"), type: "jpeg", quality: 86 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Page", { exact: true }).selectOption(about.id);
  assert.equal(await imageById(imageId).locator("img").getAttribute("src"), defaultSource, "Restored starter should persist after refresh.");
  console.log(JSON.stringify({ passed: true, template: credentials.fixtures[0].templateKey, imageLabel: "About image", defaultSource, replacementStoredAndRestored: true, screenshots: output, pageErrors }));
} finally {
  await restoreOriginalDraft().catch((error) => console.error("Could not restore QA draft history:", error.message));
  await context.close();
  await browser.close();
}
