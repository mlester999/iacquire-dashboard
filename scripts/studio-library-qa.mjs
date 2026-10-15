// Real-browser QA of the agency Template Library and the client gallery against the isolated authenticated fixtures. Local only.
//
//   npm run studio:qa:seed        (server stopped)       npm run studio:qa     (server running)
//   PLAYWRIGHT_MODULE=file:///path/to/playwright/index.mjs node scripts/studio-library-qa.mjs
//
// Covers: counts, Featured (mark, persist across reload, only featured shown, sorted first, removed), filters composing, URL state kept across a
// reload, the staff permission boundary, the admin-only details panel, and what a client's gallery shows. Evidence: .data/studio-qa/library/
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const credentials = JSON.parse(await fs.readFile(".data/studio-premium-qa/credentials.json", "utf8"));
assert.equal(credentials.baseUrl, "http://localhost:3210", "This QA script only runs on the isolated local server.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const out = path.resolve(".data/studio-qa/library");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const passed = (check) => { results.push({ check, passed: true }); console.log(`PASS ${check}`); };
const skipped = (check, why) => { results.push({ check, passed: null, skipped: why }); console.log(`SKIPPED ${check}: ${why}`); };
let bistroFeatured = false;

async function session(who, extra = [], token = credentials.accounts[who]?.sessionToken) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
  await context.addCookies([{ name: "iaq_session", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }, ...extra]);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}
const libraryReady = async (page, query = "") => {
  await page.goto(`${credentials.baseUrl}/admin/website-studio/templates${query}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("heading", { name: "Template Library" }).first().waitFor({ timeout: 90000 });
  await page.waitForFunction(() => { const b = document.querySelector('ul[aria-label="Templates"] button'); return b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 90000 });
};
const tabCount = async (page, name) => Number((await page.getByRole("group", { name: "Template collection" }).getByRole("button", { name: new RegExp(`^${name}`) }).innerText()).replace(/\D+/g, ""));
const card = (page, name) => page.locator('ul[aria-label="Templates"] > li').filter({ has: page.getByRole("heading", { name, exact: true }) });
const names = (page) => page.locator('ul[aria-label="Templates"] > li h2').allInnerTexts();
/** The page updates after a click, so wait for the list to settle on what is expected before comparing. */
async function settled(read, expected, what, timeout = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) { last = await read(); if (JSON.stringify(last) === JSON.stringify(expected)) return; await new Promise((r) => setTimeout(r, 150)); }
  assert.deepEqual(last, expected, what);
}
async function clearFeatured(page) {
  // Start from a known state, whatever an interrupted earlier run left behind: un-feature whichever cards carry the Featured badge.
  for (let guard = 0; guard < 10; guard++) {
    const featured = await tabCount(page, "Featured");
    if (featured === 0) return;
    const badged = page.locator('ul[aria-label="Templates"] > li').filter({ has: page.locator("span", { hasText: /^\s*Featured\s*$/ }) }).first();
    const title = await badged.locator("h2").innerText();
    await badged.getByRole("button", { name: `More for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Remove from featured", exact: true }).click();
    await settled(() => tabCount(page, "Featured"), featured - 1, `un-featuring ${title} lowers the Featured count`);
  }
}

try {
  // ---- Admin: Featured -----------------------------------------------------------------------------------------------------------------------
  const admin = await session("admin");
  const page = admin.page;
  await libraryReady(page);
  await clearFeatured(page);
  const total = await tabCount(page, "All templates");
  assert.ok(total >= 50, `at least the 50 built-in templates (saw ${total})`);
  assert.equal(await tabCount(page, "Featured"), 0, "nothing is featured by default");
  assert.equal(await tabCount(page, "Published"), total);
  passed(`library counts are consistent (${total} templates, none featured by default)`);

  await card(page, "Atelier").getByRole("button", { name: "More for Atelier" }).click();
  await page.getByRole("menuitem", { name: "Feature", exact: true }).click();
  await page.getByText("Featured.", { exact: true }).waitFor();
  await page.waitForFunction(() => /Featured\s*1/.test(document.querySelector('[aria-label="Template collection"]')?.textContent?.replace(/\s+/g, " ") ?? ""), null, { timeout: 30000 });
  assert.equal(await tabCount(page, "Featured"), 1);
  await page.getByRole("group", { name: "Template collection" }).getByRole("button", { name: /^Featured/ }).click();
  await settled(() => names(page), ["Atelier"], "the Featured tab lists only the featured template");
  assert.match(page.url(), /collection=featured/);
  await page.screenshot({ path: path.join(out, "featured-only.png") });
  passed("marking a template featured updates the count and the Featured tab shows only featured templates");

  await page.reload({ waitUntil: "domcontentloaded" });
  await libraryReady(page, "?collection=featured");
  await settled(() => names(page), ["Atelier"], "the featured choice is stored in the database, and the view is restored from the address");
  passed("Featured survives a reload (database) and the collection is restored from the address");

  await page.getByRole("group", { name: "Template collection" }).getByRole("button", { name: /^All templates/ }).click();
  await settled(async () => (await names(page))[0], "Atelier", "Featured first puts the featured template at the top");
  await page.getByLabel("Sort templates").selectOption("name");
  const alphabetical = await names(page);
  assert.deepEqual(alphabetical, [...alphabetical].sort((a, b) => a.localeCompare(b)), "alphabetical sort");
  await page.getByLabel("Sort templates").selectOption("featured");
  passed("Featured first and alphabetical sorting");

  // ---- Filters compose -----------------------------------------------------------------------------------------------------------------------
  await page.getByLabel("Industry").selectOption("hospitality");
  const hospitality = await names(page);
  assert.ok(hospitality.length > 0 && hospitality.length < total);
  await page.getByLabel("Search templates").fill("dark");
  const narrowed = await names(page);
  assert.ok(narrowed.length > 0 && narrowed.length < hospitality.length, "search narrows the industry filter");
  assert.ok(narrowed.every((n) => hospitality.includes(n)), "filters compose (AND)");
  assert.ok(await page.getByRole("group", { name: "Active filters" }).count() === 1 || await page.locator('[aria-label="Active filters"]').count() === 1, "active filter chips are shown");
  assert.match(page.url(), /industry=hospitality/);
  assert.match(page.url(), /q=dark/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await libraryReady(page, page.url().replace(/^[^?]*/, ""));
  assert.deepEqual(await names(page), narrowed, "the filtered view is restored after a reload");
  await page.getByLabel("Search templates").fill("zzzz-no-such-design");
  await page.getByText("A fresh perspective awaits").waitFor();
  await page.screenshot({ path: path.join(out, "empty-results.png") });
  await page.getByRole("button", { name: /Clear filters/ }).first().click();
  assert.equal((await names(page)).length, total, "Clear filters restores every template");
  assert.equal(new URL(page.url()).search, "", "and the address is clean again");
  passed("industry and search compose, chips show, the view survives a reload, the empty state is friendly and Clear filters resets everything");

  // ---- Details panel: technical information lives here, not on the card ----------------------------------------------------------------------
  const cardText = (await card(page, "Atelier").innerText()).replace(/\s+/g, " ");
  assert.doesNotMatch(cardText, /Version \d|websites? (created|started)|luxe\.atelier/i, "no internal metadata on the card");
  await card(page, "Atelier").getByRole("button", { name: "More for Atelier" }).click();
  await page.getByRole("menuitem", { name: "Edit details", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const details = (await dialog.innerText()).replace(/\s+/g, " ");
  assert.match(details, /Current version\s*3/);
  assert.match(details, /luxe\.atelier/);
  assert.match(details, /Websites started from it\s*\d+\s*across all clients/);
  await page.screenshot({ path: path.join(out, "details-panel.png") });
  await page.keyboard.press("Escape");
  passed("version, usage and the internal reference appear only in the admin details panel, never on the card");

  // ---- Remove featured -----------------------------------------------------------------------------------------------------------------------
  await card(page, "Atelier").getByRole("button", { name: "More for Atelier" }).click();
  await page.getByRole("menuitem", { name: "Remove from featured", exact: true }).click();
  await page.getByText("No longer featured.", { exact: true }).waitFor();
  await page.waitForFunction(() => /Featured\s*0/.test(document.querySelector('[aria-label="Template collection"]')?.textContent?.replace(/\s+/g, " ") ?? ""), null, { timeout: 30000 });
  passed("a featured template can be un-featured");
  await admin.context.close();

  // ---- Staff: no publication or featuring controls ---------------------------------------------------------------------------------------------
  const staff = await session("staff");
  await libraryReady(staff.page);
  await card(staff.page, "Atlas").getByRole("button", { name: "More for Atlas" }).click();
  const staffItems = await staff.page.getByRole("menuitem").allInnerTexts();
  for (const forbidden of ["Feature", "Remove from featured", "Hide from clients", "Archive", "Publish to clients"]) assert.ok(!staffItems.some((t) => t.trim() === forbidden), `staff must not be offered "${forbidden}" (offered: ${staffItems.join(", ")})`);
  await staff.page.screenshot({ path: path.join(out, "staff-menu.png") });
  await staff.page.keyboard.press("Escape");
  await card(staff.page, "Atlas").getByRole("button", { name: "More for Atlas" }).click();
  await staff.page.getByRole("menuitem", { name: "Edit details", exact: true }).click();
  const staffDetails = (await staff.page.getByRole("dialog").innerText()).replace(/\s+/g, " ");
  assert.doesNotMatch(staffDetails, /Websites started from it/, "a platform-wide usage count is not shown to staff, who see only assigned clients");
  await staff.context.close();
  passed("staff are not offered feature, hide, archive or publish, and are not shown a platform-wide usage count");

  // ---- Client gallery: a client with no website yet -------------------------------------------------------------------------------------------
  // The fresh client is single-use: once it has made a website it is sent straight to it, so look before the library is changed for this part.
  // Fresh clients: the original fixture and any added with `npm run studio:qa:fresh-seed`. The first one still without a website is used.
  const freshClients = [{ label: "freshOwner", token: credentials.accounts.freshOwner.sessionToken, org: credentials.freshOrganization.id }];
  try { for (const c of JSON.parse(await fs.readFile(".data/studio-premium-qa/fresh-clients.json", "utf8")).clients) freshClients.push({ label: c.name, token: c.sessionToken, org: c.organizationId }); } catch { /* none added */ }
  let freshClient = null;
  for (const candidate of freshClients) {
    const probe = await session("freshOwner", [{ name: "iaq_org", value: candidate.org, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }], candidate.token);
    await probe.page.goto(`${credentials.baseUrl}/website/new`, { waitUntil: "domcontentloaded", timeout: 120000 });
    // The redirect for a client that already has a website arrives as the page streams in, so give it a moment to happen.
    const available = await probe.page.waitForURL((u) => u.pathname !== "/website/new", { timeout: 10000 }).then(() => false, () => true);
    await probe.context.close();
    if (available) { freshClient = candidate; break; }
  }
  if (!freshClient) {
    skipped("a client with no website sees only the featured design, previews it and starts a website from it", `every fresh client (${freshClients.length}) has already created its website, so /website/new redirects; run npm run studio:qa:fresh-seed with the QA server stopped to add another`);
  } else {
  // The agency features one design, then a brand-new client sees it under Featured, previews it, and starts a website from it.
  const featuring = await session("admin");
  await libraryReady(featuring.page);
  await card(featuring.page, "Bistro").getByRole("button", { name: "More for Bistro" }).click();
  await featuring.page.getByRole("menuitem", { name: "Feature", exact: true }).click();
  await featuring.page.getByText("Featured.", { exact: true }).waitFor();
  bistroFeatured = true;
  await featuring.context.close();

  const fresh = await session("freshOwner", [{ name: "iaq_org", value: freshClient.org, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }], freshClient.token);
  const gallery = fresh.page;
  await gallery.goto(`${credentials.baseUrl}/website/new`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await gallery.waitForFunction(() => document.querySelectorAll("article").length >= 50, null, { timeout: 90000 });
  await gallery.waitForFunction(() => { const b = document.querySelector('article button[aria-label^="Preview "]'); return b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 90000 });
  // A first visit opens a short product tour over the page. A person would skip it, and it correctly blocks clicks until they do.
  const tour = gallery.locator('[aria-labelledby="tour-title"]');
  if (await tour.waitFor({ timeout: 4000 }).then(() => true, () => false)) { await tour.getByRole("button", { name: "Skip", exact: true }).click(); await tour.waitFor({ state: "detached" }); }
  const clientNames = await gallery.locator("article h2").allInnerTexts();
  assert.ok(clientNames.length >= 51 && clientNames.includes("Studio QA Master"), `the client gallery offers every published design, including the agency's own (saw ${clientNames.length})`);
  const featuredButton = gallery.getByRole("group", { name: "Template collection" }).getByRole("button", { name: /^Featured/ });
  assert.equal(Number((await featuredButton.innerText()).replace(/\D+/g, "")), 1, "exactly the one featured design is counted");
  await featuredButton.click();
  await settled(() => gallery.locator("article h2").allInnerTexts(), ["Bistro"], "Featured shows only genuinely featured designs");
  assert.match(gallery.url(), /collection=featured/);
  assert.ok(await gallery.locator("article").getByText("Featured", { exact: true }).count() >= 1, "the card carries a Featured indicator");
  await gallery.screenshot({ path: path.join(out, "client-featured.png") });
  passed("a client sees only the featured design under Featured, with accurate counts and an indicator");

  await gallery.getByRole("button", { name: "Preview Bistro" }).first().click();
  const preview = gallery.getByRole("dialog", { name: /Preview of Bistro/ });
  await preview.waitFor();
  const toolbar = (await preview.locator(":scope > div").first().innerText()).replace(/\s+/g, " ");
  assert.doesNotMatch(toolbar, /sample content/i, "the preview header does not say sample content");
  await gallery.frameLocator("dialog iframe").locator("footer").first().waitFor({ timeout: 60000 });
  await gallery.screenshot({ path: path.join(out, "client-preview.png") });
  await gallery.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  assert.equal(await gallery.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim()), "Preview Bistro", "focus returns to the control that opened the preview");
  passed("the preview header is clean, closes with Escape, and focus returns to its trigger");

  await gallery.getByRole("button", { name: "Use this template" }).first().click();
  await gallery.getByRole("region", { name: "Your selection" }).getByRole("button", { name: "Use this template" }).click();
  const confirmation = gallery.getByRole("dialog", { name: "Start with Bistro?" });
  await confirmation.waitFor();
  await gallery.screenshot({ path: path.join(out, "client-confirm.png") });
  await confirmation.getByRole("button", { name: "Create my website" }).click();
  await gallery.waitForURL(/\/website(\/edit)?(\?.*)?$/, { timeout: 120000 });
  passed("a client with no website can pick a design and a website is created from it");
  await fresh.context.close();

  }
} catch (error) {
  results.push({ check: "library QA", passed: false, error: error.message });
  throw error;
} finally {
  // Whatever happened above, leave the library as it was: nothing is featured unless an agency person chose it.
  if (bistroFeatured) {
    try {
      const restore = await session("admin");
      await libraryReady(restore.page);
      await card(restore.page, "Bistro").getByRole("button", { name: "More for Bistro" }).click();
      await restore.page.getByRole("menuitem", { name: "Remove from featured", exact: true }).click();
      await restore.page.getByText("No longer featured.", { exact: true }).waitFor();
      await restore.context.close();
      console.log("Library restored: nothing is featured.");
    } catch (error) { console.log(`COULD NOT RESTORE the library (Bistro may still be featured): ${error.message}`); }
  }
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  await browser.close();
}
