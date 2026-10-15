// Real local browser QA against isolated authenticated PGLite fixtures. No hosted services.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "file:///C:/Users/ZEPHY/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const { chromium } = await import(playwrightModule);
const credentials = JSON.parse(await fs.readFile(".data/studio-premium-qa/credentials.json", "utf8"));
assert.equal(credentials.baseUrl, "http://localhost:3210", "This QA script only runs on the isolated local server.");
const output = path.resolve(".data/studio-qa/editor");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
await context.routeWebSocket("**/_next/webpack-hmr", (socket) => socket.close());
const account = credentials.accounts.owner;
await context.addCookies([{ name: "iaq_session", value: account.sessionToken, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }, { name: "iaq_org", value: credentials.fixtures[0].organization.id, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const results = [];
const screenshot = (name) => page.screenshot({ path: path.join(output, `${name}.jpg`), type: "jpeg", quality: 86 });
const passed = (check, evidence = {}) => { results.push({ check, passed: true, ...evidence }); console.log(`PASS ${check}`); };
const properties = () => page.getByRole("complementary", { name: "Settings for the selected item" });
const save = async () => {
  await page.getByRole("button", { name: "Save draft (Ctrl+S)", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^(Saved|All changes saved)$/ }).first().waitFor({ timeout: 60000 });
};
const styleOf = (id) => page.locator(`[data-canvas-frame] [data-nid="${id}"]`).evaluate((element) => {
  const style = getComputedStyle(element);
  return { font: style.fontFamily, size: style.fontSize, weight: style.fontWeight, color: style.color, align: style.textAlign, background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderRadius };
});
let mutated = false;
async function restoreOriginal() {
  if (!mutated) return;
  const currentDialog = page.getByRole("dialog");
  if (await currentDialog.count()) await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Version history", exact: true });
  const original = history.getByRole("listitem").filter({ hasText: "Version 1" }).last();
  await original.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("dialog", { name: "Restore version 1?", exact: true }).getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByText("Version 1 is back in your draft. What was there before is saved too.", { exact: true }).waitFor({ timeout: 60000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-studio]").waitFor({ timeout: 60000 });
  mutated = false;
  passed("original client draft restored through real version history");
}
try {
  console.log("Opening authenticated local editor…");
  await page.goto(`${credentials.baseUrl}${credentials.routes.clientEditor}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator("[data-studio]").waitFor({ timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  // Every run starts from the original isolated fixture, even after a test was
  // interrupted. Restoring uses the real product flow and is verified on refresh.
  mutated = true;
  await restoreOriginal();
  if (await page.getByRole("button", { name: "Skip", exact: true }).isVisible()) await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.locator("[data-canvas-frame] [data-ntype=heading]").first().click();
  await screenshot("initial-desktop");
  const bounds = await page.locator("[data-studio]").boundingBox();
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y, 0);
  assert.equal(Math.round(bounds.width), 1440);
  passed("authenticated editor occupies full viewport outside transformed portal shell", { bounds });
  const heading = page.locator("[data-canvas-frame] [data-ntype=heading]").first();
  const headingId = await heading.getAttribute("data-nid");
  const originalHeading = (await heading.textContent()).trim();
  const headingBefore = await styleOf(headingId);
  await properties().getByLabel("Text", { exact: true }).fill("A considered home, made for everyday life.");
  mutated = true;
  assert.equal(await heading.innerText(), "A considered home, made for everyday life.");
  await properties().getByRole("radio", { name: "Style", exact: true }).click();
  await properties().getByLabel("Size", { exact: true }).selectOption("5xl");
  await properties().getByLabel("Weight", { exact: true }).selectOption("600");
  await properties().getByLabel("Font family", { exact: true }).selectOption("bricolage");
  await properties().getByLabel("Text colour: hex code", { exact: true }).fill("#334455");
  await properties().getByRole("radiogroup", { name: "Alignment", exact: true }).getByRole("radio", { name: "Centre", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const headingAfter = await styleOf(headingId);
  assert.equal(headingAfter.weight, "600");
  assert.equal(headingAfter.color, "rgb(51, 68, 85)");
  assert.equal(headingAfter.align, "center");
  assert.notEqual(headingAfter.font, headingBefore.font);
  assert.notEqual(headingAfter.size, headingBefore.size);
  await save();
  await screenshot("heading-properties-desktop");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`[data-nid="${headingId}"]`).first().waitFor();
  assert.equal(await page.locator(`[data-canvas-frame] [data-nid="${headingId}"]`).innerText(), "A considered home, made for everyday life.");
  assert.deepEqual(await styleOf(headingId), headingAfter);
  passed("heading text, named font family, size, numeric weight, colour and alignment render and survive real save/refresh", { before: headingBefore, after: headingAfter });

  const button = page.locator("[data-canvas-frame] [data-site-main] [data-ntype=button]").first();
  await button.click();
  const buttonId = await button.getAttribute("data-nid");
  await properties().getByLabel("Label and destination: text", { exact: true }).fill("Plan your consultation");
  await properties().getByLabel("Label and destination: destination", { exact: true }).selectOption("page:about");
  await properties().getByRole("radio", { name: "Style", exact: true }).click();
  await properties().getByLabel("Weight", { exact: true }).selectOption("700");
  await properties().getByLabel("Size", { exact: true }).selectOption("lg");
  await properties().getByLabel("Text colour: hex code", { exact: true }).fill("#ffffff");
  await properties().getByRole("button", { name: "Box", exact: true }).click();
  await properties().getByLabel("Background: hex code", { exact: true }).fill("#243346");
  await properties().getByRole("radiogroup", { name: "Border", exact: true }).getByRole("radio", { name: "None", exact: true }).click();
  assert.equal((await button.textContent()).trim(), "Plan your consultation");
  assert.equal(await button.getAttribute("href"), "/about");
  const buttonStyle = await styleOf(buttonId);
  assert.equal(buttonStyle.weight, "700");
  assert.equal(buttonStyle.color, "rgb(255, 255, 255)");
  assert.equal(buttonStyle.background, "rgb(36, 51, 70)");
  assert.equal(buttonStyle.border, "0px");
  await save();
  await screenshot("button-properties-desktop");
  passed("button label, link, type, custom fill and border render and save", { computed: buttonStyle });

  const sections = page.locator("[data-canvas-frame] [data-site-main] > [data-nid]");
  const originalOrder = await sections.evaluateAll((elements) => elements.map((element) => element.dataset.nid));
  const section = sections.first();
  const sectionId = await section.getAttribute("data-nid");
  await section.click({ position: { x: 8, y: 8 } });
  await properties().getByRole("radiogroup", { name: "Background type", exact: true }).getByRole("radio", { name: "Colour", exact: true }).click();
  await properties().getByLabel("Background colour: hex code", { exact: true }).fill("#e1dbd1");
  assert.equal(await section.locator(":scope > .iq-bg").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(225, 219, 209)");
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page.getByRole("treeitem", { name: "Hero", exact: true }).press("Alt+ArrowDown");
  const reordered = await sections.evaluateAll((elements) => elements.map((element) => element.dataset.nid));
  assert.equal(reordered[1], sectionId);
  await page.getByRole("button", { name: "Undo (Ctrl+Z)", exact: true }).click();
  assert.deepEqual(await sections.evaluateAll((elements) => elements.map((element) => element.dataset.nid)), originalOrder);
  await page.getByRole("button", { name: "Redo (Ctrl+Shift+Z)", exact: true }).click();
  assert.equal((await sections.evaluateAll((elements) => elements.map((element) => element.dataset.nid)))[1], sectionId);
  await save();
  await screenshot("section-background-layers");
  passed("section custom background, keyboard reorder, undo and redo act on the real document");

  const about = credentials.fixtures[0].pages.find((candidate) => candidate.slug === "about");
  await page.getByLabel("Page", { exact: true }).selectOption(about.id);
  const image = page.locator("[data-canvas-frame] [data-ntype=image]").first();
  await image.waitFor();
  const imageId = await image.getAttribute("data-nid");
  const defaultImage = await image.locator("img").getAttribute("src");
  await image.click();
  await properties().getByRole("button", { name: /replace image$/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Use image: QA library replacement image/ }).click();
  const replacement = await image.locator("img").getAttribute("src");
  assert.notEqual(replacement, defaultImage);
  assert.match(replacement, /\/api\/assets\//);
  await properties().getByLabel("Shape", { exact: true }).selectOption("1/1");
  await properties().getByLabel("Focus: left to right value", { exact: true }).fill("30");
  await properties().getByLabel("Focus: top to bottom value", { exact: true }).fill("40");
  const cropped = await image.locator("img").evaluate((element) => ({ position: getComputedStyle(element).objectPosition, fit: getComputedStyle(element).objectFit }));
  assert.equal(cropped.position, "30% 40%");
  await save();
  await screenshot("image-replace-crop-desktop");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Page", { exact: true }).selectOption(about.id);
  const reopenedImage = page.locator(`[data-canvas-frame] [data-nid="${imageId}"]`);
  assert.equal(await reopenedImage.locator("img").getAttribute("src"), replacement);
  await reopenedImage.click();
  await properties().getByRole("button", { name: "Restore default", exact: true }).click();
  assert.equal(await reopenedImage.locator("img").getAttribute("src"), defaultImage);
  await save();
  passed("Media Library image replacement, crop/focal position, refresh persistence and version-specific default restore", { crop: cropped });

  const { default: sharp } = await import("sharp");
  const uploadPath = path.join(output, "local-qa-upload.jpg");
  await sharp({ create: { width: 640, height: 480, channels: 3, background: "#416a71" } }).jpeg().toFile(uploadPath);
  await properties().getByRole("button", { name: /replace image$/i }).click();
  const mediaDialog = page.getByRole("dialog");
  await mediaDialog.locator("input[type=file]").setInputFiles(uploadPath);
  await mediaDialog.getByRole("button", { name: "Use image: untitled", exact: true }).first().waitFor();
  await mediaDialog.getByRole("button", { name: "Use image: untitled", exact: true }).first().click();
  const uploadSource = await reopenedImage.locator("img").getAttribute("src");
  assert.match(uploadSource, /\/api\/assets\//);
  assert.notEqual(uploadSource, replacement);
  await save();
  await screenshot("actual-local-upload");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Page", { exact: true }).selectOption(about.id);
  assert.equal(await page.locator(`[data-canvas-frame] [data-nid="${imageId}"] img`).getAttribute("src"), uploadSource);
  await page.locator(`[data-canvas-frame] [data-nid="${imageId}"]`).click();
  await properties().getByRole("button", { name: "Restore default", exact: true }).click();
  await save();
  passed("actual image upload through authorized local storage endpoint survives refresh and restores default");

  for (const [width, height] of [[768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: "Open properties panel", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Properties", exact: true });
    await drawer.waitFor();
    assert.ok(await drawer.isVisible());
    await screenshot(`properties-drawer-${width}`);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    const canvasBounds = await page.getByRole("region", { name: "Website canvas", exact: true }).boundingBox();
    assert.ok(canvasBounds.width >= width - 70);
    await page.getByRole("radio", { name: "Phone (390px)", exact: true }).click();
    await screenshot(`canvas-${width}`);
    passed(`responsive editor ${width}px: accessible drawer closes and canvas retains usable width`, { canvas: canvasBounds });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await restoreOriginal();

  const foreignAsset = credentials.fixtures[1].assets[0].id;
  const unauthorizedAsset = await context.request.get(`${credentials.baseUrl}/api/assets/${foreignAsset}`);
  assert.equal(unauthorizedAsset.status(), 404);
  passed("owner cannot read another tenant's private image through real asset route");

  for (const [key, route, expected] of [["editor", credentials.routes.clientEditor, "approval"], ["staff", credentials.routes.agencyEditor, "approval"], ["unassignedStaff", credentials.routes.agencyEditor, "denied"], ["admin", credentials.routes.templateEditor, "template"]]) {
    const scoped = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await scoped.routeWebSocket("**/_next/webpack-hmr", (socket) => socket.close());
    await scoped.addCookies([{ name: "iaq_session", value: credentials.accounts[key].sessionToken, domain: "localhost", path: "/", httpOnly: true }, { name: "iaq_org", value: credentials.fixtures[0].organization.id, domain: "localhost", path: "/", httpOnly: true }]);
    const scopedPage = await scoped.newPage();
    try {
      const response = await scopedPage.goto(`${credentials.baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      if (expected === "denied") {
        assert.ok([403, 404].includes(response.status()));
        assert.equal(await scopedPage.locator("[data-studio]").count(), 0);
      } else {
        await scopedPage.locator("[data-studio]").waitFor({ timeout: 120000 });
        if (expected === "approval") {
          assert.equal(await scopedPage.getByRole("button", { name: "Publish", exact: true }).count(), 0);
          assert.equal(await scopedPage.getByRole("button", { name: "Send for approval", exact: true }).count(), 1);
        } else {
          assert.equal(await scopedPage.getByRole("button", { name: "Publish template", exact: true }).count(), 1);
          const masterHeading = scopedPage.locator("[data-canvas-frame] [data-ntype=heading]").first();
          const previousText = (await masterHeading.textContent()).trim();
          await masterHeading.click();
          await scopedPage.getByRole("complementary", { name: "Settings for the selected item" }).getByLabel("Text", { exact: true }).fill("Master-only local QA headline");
          await scopedPage.getByRole("button", { name: "Save draft (Ctrl+S)", exact: true }).click();
          await scopedPage.getByRole("status").filter({ hasText: /^(Saved|All changes saved)$/ }).first().waitFor({ timeout: 60000 });
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.locator(`[data-canvas-frame] [data-nid="${headingId}"]`).waitFor();
          assert.equal((await page.locator(`[data-canvas-frame] [data-nid="${headingId}"]`).textContent()).trim(), originalHeading);
          await scopedPage.screenshot({ path: path.join(output, "master-draft-isolation.jpg"), type: "jpeg", quality: 85 });
          await scopedPage.getByRole("button", { name: "Undo (Ctrl+Z)", exact: true }).click();
          await scopedPage.getByRole("button", { name: "Save draft (Ctrl+S)", exact: true }).click();
          await scopedPage.getByRole("status").filter({ hasText: /^(Saved|All changes saved)$/ }).first().waitFor({ timeout: 60000 });
          assert.equal((await masterHeading.textContent()).trim(), previousText);
          passed("saved master-template draft edits do not modify the client's approved template copy; master change undone and saved");
        }
      }
      await scopedPage.screenshot({ path: path.join(output, `access-${key}.jpg`), type: "jpeg", quality: 85 });
      passed(`real ${key} authorization boundary`, { status: response.status(), expected });
    } finally {
      await scoped.close();
    }
  }
} catch (error) {
  results.push({ check: "editor QA", passed: false, error: error.message });
  await screenshot("failure").catch(() => undefined);
  throw error;
} finally {
  if (process.argv.includes("--restore")) await restoreOriginal().catch((error) => results.push({ check: "restore original draft", passed: false, error: error.message }));
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ results, pageErrors: errors }, null, 2));
  await context.close();
  await browser.close();
}
