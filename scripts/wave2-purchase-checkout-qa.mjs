// Browser QA of the online purchase checkout, in the isolated QA app started WITH the simulated PayMongo (nothing real is contacted, no money moves):
//
//   $env:CRM_QA_PAYMONGO_SIM = "1"; $env:CRM_QA_DEMO = "1"; node scripts/inbox-qa.mjs     (the app, port 3270)
//   node scripts/paymongo-sim.mjs                                                          (the simulated PayMongo, 127.0.0.1:3281)
//   node scripts/wave2-purchase-checkout-qa.mjs [--stage 1,2,...]
//
// What it proves, in a real browser: the Super Admin switches online checkout on and sets the exchange rate; a buyer confirms an invitation and is sent to the (simulated) provider's
// page for exactly the frozen fee in pesos; the buyer's return to the site decides nothing; the provider's SIGNED notice is what verifies the payment and, when the Super Admin allowed it,
// creates the workspace; replays, refunds and disputes are handled; a buyer who walks away is told how to come back; and the pages are keyboard- and axe-clean at desktop and phone widths.
// What it cannot prove: how the real PayMongo behaves. The simulator's notices were written from PayMongo's documentation and have never been seen from a real account.
import fs from "node:fs";
import path from "node:path";
import { BASE, OUT, axe, check, finish, launch, metrics, newReport, open, publicPage, shot, signedIn, watch } from "./qa-harness.mjs";

const SIM = "http://127.0.0.1:3281";
const args = process.argv.slice(2);
const stages = args.includes("--stage") ? args[args.indexOf("--stage") + 1].split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9];
const STATE = path.join(OUT, "checkout-state.json");
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const stamp = Date.now().toString(36);
const squash = (s) => s.replace(/\s+/g, " ").trim();
const body = (page) => page.evaluate(() => document.body.innerText).then(squash);
const report = newReport();
const browser = await launch();
const allow = { allowOrigins: [SIM] };
let adminPage = null;
const admin = async () => { if (!adminPage) { const { page } = await signedIn(browser, "agency:super"); watch(page, report, "super", allow); adminPage = page; } return adminPage; };

/** The simulator's sessions, newest last: [{ reference, id, status }]. */
async function simSessions() {
  const html = await (await fetch(`${SIM}/control`)).text();
  return [...html.matchAll(/<code>(IAQ-[A-Z0-9]+)<\/code> · (cs_sim_[a-f0-9]+) · (\w+)/g)].map((m) => ({ reference: m[1], id: m[2], status: m[3] })).reverse();
}
/** Sends the provider's notice (refund, dispute or a replay of "paid") for a reference, the way the simulator's control page does. */
async function simNotice(reference, kind) {
  const session = (await simSessions()).find((s) => s.reference === reference);
  if (!session) throw new Error(`The simulator has no session for ${reference}`);
  const res = await fetch(`${SIM}/control/${session.id}/${kind}`, { method: "POST", redirect: "manual" });
  return res.status;
}

/** A buyer in a clean browser context. */
async function buyer(viewport) {
  const { context, page } = await publicPage(browser, viewport);
  watch(page, report, "buyer", allow);
  return { context, page };
}

async function invite(a, { company, auto, maintenance = false }) {
  await open(a, "/admin/purchase-intents");
  await a.locator("#pi-name").fill("Bailey Buyer");
  await a.locator("#pi-email").fill(`bailey.${stamp}.${company.toLowerCase().replace(/\W+/g, "")}@buyer.example.test`);
  await a.locator("#pi-company").fill(company);
  await a.locator("#pi-industry").fill("Home services");
  if (maintenance) await a.getByLabel(/Include the optional Managed Maintenance/).check();
  if (auto) await a.getByLabel(/Create the workspace by itself/).check();
  await a.getByRole("button", { name: "Create invitation" }).click();
  await a.getByText(/is ready/).first().waitFor({ timeout: 60_000 });
  const link = (await a.locator("main code").first().textContent()).trim();
  const href = await a.getByRole("link", { name: "Open the intent" }).getAttribute("href");
  return { link, intentPath: href, company };
}

/** Confirm the invitation on the public page and press Pay; ends on the simulated provider's page. */
async function confirmAndPay(page, link) {
  await open(page, link);
  await page.getByRole("button", { name: /Confirm and continue/ }).click();
  const pay = page.getByRole("button", { name: /Pay .* securely online/ });
  await pay.waitFor({ timeout: 60_000 });
  return pay;
}

async function payOnSim(page) {
  await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/checkout/"), { timeout: 90_000 });
  const text = await body(page);
  const reference = /Reference: (IAQ-[A-Z0-9]+)/.exec(text)?.[1] ?? null;
  return { text, reference };
}

async function waitForText(page, re, { tries = 24, reload = true } = {}) {
  for (let i = 0; i < tries; i++) {
    const text = await body(page);
    if (re.test(text)) return text;
    await page.waitForTimeout(2500);
    if (reload) await page.reload({ waitUntil: "domcontentloaded" });
  }
  return body(page);
}

try {
  if (stages.includes(1)) {
    // ---- 1. The Super Admin sets the exchange rate and switches online checkout on.
    const a = await admin();
    await open(a, "/admin/billing?tab=rates");
    await a.locator("#fx-rate").fill("58");
    await a.locator("#fx-src").fill("QA fixture rate (simulated)");
    await a.getByRole("button", { name: "Save rate" }).click();
    await a.waitForTimeout(2500);
    await open(a, "/admin/billing?tab=rates");
    check(report, "1: the exchange rate is saved and shown", /Last set/.test(await body(a)), (await body(a)).slice(0, 200));

    await open(a, "/admin/purchase-intents");
    const section = a.locator('section[aria-label="Online checkout"]');
    const before = squash(await section.innerText());
    check(report, "1: online checkout starts off", /Off/.test(before) && !/Open/.test(before), before);
    await a.getByRole("switch", { name: "Allow buyers to pay online" }).click();
    await a.waitForFunction(() => /Open \(test mode\)/.test(document.querySelector('section[aria-label="Online checkout"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
    const after = squash(await section.innerText());
    check(report, "1: switching it on opens it in test mode (the simulated provider is a test key)", /Open \(test mode\)/.test(after), after);
    await shot(a, report, "checkout-admin-list");
    const vio = (await axe(a)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "1: the purchase intents page has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    const m = await metrics(a);
    check(report, "1: no horizontal overflow at 1280", !m.overflow, JSON.stringify(m));
  }

  if (stages.includes(2)) {
    // ---- 2. Invitation A (the workspace is created by itself) and its buyer pays online.
    const a = await admin();
    const inv = await invite(a, { company: `Alder Plumbing ${stamp}`, auto: true, maintenance: true });
    state.A = inv; save();
    check(report, "2: the invitation link is shown once and points at the QA app", inv.link.startsWith(`${BASE}/purchase/`), inv.link);

    const { context, page } = await buyer();
    const pay = await confirmAndPay(page, inv.link);
    const text = await body(page);
    check(report, "2: the buyer sees the frozen US$1,499 and the next step is the payment", /\$1,499/.test(text) && /The next step is the payment/.test(text), text.slice(0, 300));
    check(report, "2: the page says the card is never entered here and the peso conversion is explained", /never sees your card/.test(text) && /Philippine pesos/.test(text));
    const vio = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "2: the buyer page has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    const m = await metrics(page);
    check(report, "2: no horizontal overflow at 1280", !m.overflow, JSON.stringify(m));
    await shot(page, report, "checkout-buyer-pay");

    await pay.click();
    const sim = await payOnSim(page);
    state.A.reference = sim.reference; save();
    check(report, "2: the provider's page asks for exactly the frozen fee converted at 58 (PHP 86,942.00)", /PHP 86,942\.00/.test(sim.text), sim.text.slice(0, 300));
    check(report, "2: the provider's page carries our reference and a status of open", Boolean(sim.reference) && /Status: open/.test(sim.text));
    // Before paying, nothing is verified: the Super Admin's view says the checkout is waiting.
    const a2 = await admin();
    await open(a2, state.A.intentPath);
    check(report, "2: before the provider confirms, the intent is still only 'Buyer confirmed' and the checkout is waiting", /Buyer confirmed/.test(await body(a2)) && /Waiting for the payment/.test(await body(a2)), (await body(a2)).slice(0, 300));

    await page.getByRole("button", { name: "Pay (simulated)" }).click();
    await page.waitForURL((u) => u.origin === new URL(BASE).origin && u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    const returned = await waitForText(page, /Your workspace is ready/);
    check(report, "2: the buyer comes back to a page that reports the workspace as ready (only after the signed notice)", /Your workspace is ready/.test(returned), returned.slice(0, 300));
    check(report, "2: the return address carries the checkout reference, never the bearer token", page.url().includes(sim.reference) && !page.url().includes(inv.link.split("/purchase/")[1]), page.url());
    const rv = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "2: the return page has no serious/critical axe violations", rv.length === 0, JSON.stringify(rv));
    await shot(page, report, "checkout-buyer-return");
    // The link, used again, shows nothing payable.
    await open(page, inv.link);
    const again = await body(page);
    check(report, "2: the used link offers no second payment", !/securely online/.test(again), again.slice(0, 300));
    await context.close();
  }

  if (stages.includes(3)) {
    // ---- 3. What the Super Admin sees for A: the provider's evidence, one workspace, the timeline; then a replay and a refund notice after the workspace exists.
    const a = await admin();
    await open(a, state.A.intentPath);
    const t = await body(a);
    check(report, "3: the intent is 'Workspace created' and the evidence is the provider's signed notice", /Workspace created/.test(t) && /Confirmed by the payment provider's signed notice/.test(t), t.slice(0, 400));
    check(report, "3: the workspace was created automatically after the verified payment", /Created automatically after the verified payment/.test(t));
    check(report, "3: the timeline records the checkout, the signed payment and the workspace", /Online checkout opened/.test(t) && /Payment confirmed by the payment provider's signed notice/.test(t) && /Client workspace created/.test(t));
    check(report, "3: the online checkout shows Paid with the stored peso amount, in test mode", /Paid/.test(t) && /PHP 86,942\.00/.test(t) && /test mode/.test(t));
    check(report, "3: a link to open the client workspace is offered", (await a.getByRole("link", { name: /Open the client workspace/ }).count()) > 0);
    await shot(a, report, "checkout-admin-intent-provisioned");
    const orgCount = async () => (await body(a)).match(/Client workspace created/g)?.length ?? 0;
    const eventsBefore = (await body(a)).match(/Payment confirmed by the payment provider's signed notice/g)?.length ?? 0;
    // Replay of the same signed notice: acknowledged, and nothing happens twice.
    const replay = await simNotice(state.A.reference, "replay");
    check(report, "3: the replayed notice is acknowledged", replay === 303, replay);
    await a.waitForTimeout(1500);
    await open(a, state.A.intentPath);
    const eventsAfter = (await body(a)).match(/Payment confirmed by the payment provider's signed notice/g)?.length ?? 0;
    check(report, "3: the replay did not record a second payment or a second workspace", eventsAfter === eventsBefore && (await orgCount()) === 1, `${eventsBefore} -> ${eventsAfter}`);
    // A refund reported after the workspace exists is carried by the workspace's own payment record (reported, never applied): the intent and the workspace do not change.
    await simNotice(state.A.reference, "refund");
    await a.waitForTimeout(1500);
    await open(a, state.A.intentPath);
    const refunded = await body(a);
    check(report, "3: a refund reported after the workspace exists does not undo or alter the workspace", /Workspace created/.test(refunded) && (await a.getByRole("link", { name: /Open the client workspace/ }).count()) > 0, refunded.slice(0, 400));
    await open(a, "/admin/billing?tab=payments");
    const payments = await body(a);
    const mention = /PayMongo reported a refund/.exec(payments);
    report.notes.push("agency payments tab after the post-provisioning refund notice: " + (mention ? payments.slice(Math.max(0, mention.index - 160), mention.index + 240) : "no 'PayMongo reported a refund' line"));
    check(report, "3: the refund notice shows on the workspace's payment on the payments tab, labelled as PayMongo's report (nothing changed automatically)", Boolean(mention) && /nothing was changed automatically/.test(payments), payments.slice(0, 300));
    // The buyer's return page keeps saying the workspace is ready: it exists, and the refund is the team's to resolve with the provider.
    const { context, page } = await buyer();
    await open(page, `/purchase/return/${state.A.reference}`);
    const rt = await body(page);
    check(report, "3: the buyer's return page still shows the workspace as ready (it exists; the refund is reported on its payment)", /Your workspace is ready/.test(rt), rt.slice(0, 300));
    await context.close();
  }

  if (stages.includes(4)) {
    // ---- 4. Invitation B: the Super Admin did NOT allow automatic provisioning: the payment verifies, a person creates the workspace.
    const a = await admin();
    const inv = await invite(a, { company: `Birch Roofing ${stamp}`, auto: false });
    state.B = inv; save();
    const { context, page } = await buyer();
    const pay = await confirmAndPay(page, inv.link);
    await pay.click();
    const sim = await payOnSim(page);
    state.B.reference = sim.reference; save();
    await page.getByRole("button", { name: "Pay (simulated)" }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    const returned = await waitForText(page, /Payment confirmed|workspace is ready/);
    check(report, "4: the buyer is told the payment is confirmed but the workspace is not claimed ready", /Payment confirmed/.test(returned) && !/workspace is ready/.test(returned), returned.slice(0, 300));
    await context.close();

    await open(a, state.B.intentPath);
    const t = await body(a);
    check(report, "4: the intent says 'Payment verified' with no workspace yet", /Payment verified/.test(t) && !/Open the client workspace/.test(t), t.slice(0, 300));
    check(report, "4: it says the Super Admin creates the workspace", /Created by a Super Admin/.test(t));
    const create = a.getByRole("button", { name: /Create client workspace/ });
    check(report, "4: the 'Create client workspace' button is offered", (await create.count()) === 1);
    await create.click();
    await a.getByRole("link", { name: /Open the client workspace/ }).waitFor({ timeout: 90_000 }).catch(() => {});
    await a.waitForTimeout(1500);
    await open(a, state.B.intentPath);
    const after = await body(a);
    check(report, "4: after the click the workspace exists and the payment is the provider's, recorded once", /Open the client workspace/.test(after) && /Confirmed by the payment provider's signed notice/.test(after), after.slice(0, 300));
  }

  if (stages.includes(5)) {
    // ---- 5. Invitation C: a dispute is reported before the workspace is created -> held. Invitation D: a refund -> held.
    const a = await admin();
    for (const [key, kind, label] of [["C", "dispute", "Cedar Electric"], ["D", "refund", "Dogwood Painting"]]) {
      const inv = await invite(a, { company: `${label} ${stamp}`, auto: false });
      state[key] = inv; save();
      const { context, page } = await buyer();
      const pay = await confirmAndPay(page, inv.link);
      await pay.click();
      const sim = await payOnSim(page);
      state[key].reference = sim.reference; save();
      await page.getByRole("button", { name: "Pay (simulated)" }).click();
      await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
      await waitForText(page, /Payment confirmed/);
      await simNotice(sim.reference, kind);
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: "domcontentloaded" });
      const rt = await body(page);
      check(report, `5: ${kind}: the buyer's page says a person will look at it, and promises nothing more is charged`, /needs a person to look at it/.test(rt) && /Nothing more is charged/.test(rt), rt.slice(0, 300));
      await context.close();
      await open(a, state[key].intentPath);
      const t = await body(a);
      check(report, `5: ${kind}: the Super Admin sees the intent on hold with the reason in words`, /On hold\./.test(t) && (kind === "dispute" ? /dispute/i : /refund/i).test(t), t.slice(0, 400));
      check(report, `5: ${kind}: no 'Create client workspace' button is offered while on hold`, (await a.getByRole("button", { name: /Create client workspace/ }).count()) === 0);
      const vio = (await axe(a)).filter((v) => v.impact === "serious" || v.impact === "critical");
      check(report, `5: ${kind}: the held intent page has no serious/critical axe violations`, vio.length === 0, JSON.stringify(vio));
      if (key === "C") await shot(a, report, "checkout-admin-intent-held");
    }
  }

  if (stages.includes(6)) {
    // ---- 6. Invitation E: a buyer who walks away from the provider's page.
    const a = await admin();
    const inv = await invite(a, { company: `Elm Landscaping ${stamp}`, auto: false });
    state.E = inv; save();
    const { context, page } = await buyer();
    const pay = await confirmAndPay(page, inv.link);
    await pay.click();
    const first = await payOnSim(page);
    state.E.reference = first.reference; save();
    const firstUrl = page.url();
    await page.getByRole("button", { name: /Cancel and go back/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    await page.waitForTimeout(500);
    const left = await body(page);
    check(report, "6: a buyer who cancelled is told they left the payment page, nothing was charged, and how to come back", /You left the payment page/.test(left) && /nothing was charged/i.test(left) && /purchase link/.test(left), left.slice(0, 300));
    check(report, "6: the page does not keep refreshing for a payment nobody is making", !/Waiting for the payment provider/.test(left));
    await shot(page, report, "checkout-buyer-left");
    // The same address without the hint is the waiting page; with the hint added to a paid reference it would not change what is true (covered by tests).
    await open(page, `/purchase/return/${state.E.reference}`);
    check(report, "6: opened without the cancel hint, the same reference says it is waiting for the provider", /Waiting for the payment provider/.test(await body(page)));
    // Back to the link: the Pay button is still there and reopens the SAME checkout, so a second tab or press never charges twice.
    await open(page, inv.link);
    const again = page.getByRole("button", { name: /Pay .* securely online/ });
    check(report, "6: the purchase link still offers the Pay button", (await again.count()) === 1);
    check(report, "6: it mentions that a checkout is already open and that the buyer is not charged twice", /not charged twice/.test(await body(page)));
    await again.click();
    await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/checkout/"), { timeout: 90_000 });
    check(report, "6: pressing Pay again reopens the same provider checkout (no second one was created)", page.url() === firstUrl, `${firstUrl} vs ${page.url()}`);
    const forE = (await simSessions()).filter((s) => s.reference === state.E.reference);
    check(report, "6: the simulator holds exactly one session for that reference", forE.length === 1, JSON.stringify(forE));
    await context.close();
  }

  if (stages.includes(7)) {
    // ---- 7. The switch off: a confirmed buyer is not offered a payment; an unknown link and an unknown reference reveal nothing.
    const a = await admin();
    await open(a, "/admin/purchase-intents");
    await a.getByRole("switch", { name: "Allow buyers to pay online" }).click();
    await a.waitForFunction(() => /Off/.test(document.querySelector('section[aria-label="Online checkout"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
    check(report, "7: switching it off says so", /Off/.test(squash(await a.locator('section[aria-label="Online checkout"]').innerText())));
    const inv = await invite(a, { company: `Fir Fencing ${stamp}`, auto: false });
    state.F = inv; save();
    const { context, page } = await buyer();
    await open(page, inv.link);
    await page.getByRole("button", { name: /Confirm and continue/ }).click();
    await page.getByText("Your purchase is confirmed.").waitFor({ timeout: 60_000 });
    const t = await body(page);
    check(report, "7: with online checkout off, the buyer is not shown a Pay button and is told iAcquire will verify the payment", !/securely online/.test(t) && /iAcquire will verify the payment/.test(t), t.slice(0, 300));
    await open(page, `${BASE}/purchase/not-a-real-token-${stamp}`);
    const bad = await body(page);
    check(report, "7: an unknown link says it is not valid and looks nothing up", /This link is not valid/.test(bad) && /No details were looked up/.test(bad), bad.slice(0, 300));
    await open(page, `/purchase/return/IAQ-DOESNOTEXIST1`);
    const unk = await body(page);
    check(report, "7: an unknown payment reference looks like a waiting one and reveals nothing", /Waiting for the payment provider/.test(unk) && !/Payment reference/.test(unk), unk.slice(0, 300));
    await context.close();
    // Turn it back on for the remaining checks.
    await open(a, "/admin/purchase-intents");
    await a.getByRole("switch", { name: "Allow buyers to pay online" }).click();
    await a.waitForFunction(() => /Open \(test mode\)/.test(document.querySelector('section[aria-label="Online checkout"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
  }

  if (stages.includes(8)) {
    // ---- 8. Phone width: the buyer's pages, and the Super Admin's intent page.
    const a = await admin();
    const phone = { width: 375, height: 812 };
    const { context, page } = await buyer(phone);
    const inv = await invite(a, { company: `Gum Glazing ${stamp}`, auto: false });
    state.G = inv; save();
    const pay = await confirmAndPay(page, inv.link);
    const m1 = await metrics(page);
    check(report, "8: the buyer's Pay page has no horizontal overflow at 375", !m1.overflow, JSON.stringify(m1));
    const box = await pay.boundingBox();
    check(report, "8: the Pay button is at least 44px tall and fits the width", box && box.height >= 44 && box.x >= 0 && box.x + box.width <= phone.width + 1, JSON.stringify(box));
    const v1 = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "8: the buyer's Pay page has no serious/critical axe violations at 375", v1.length === 0, JSON.stringify(v1));
    await shot(page, report, "checkout-buyer-pay-375");
    await pay.click();
    const sim = await payOnSim(page);
    state.G.reference = sim.reference; save();
    await page.getByRole("button", { name: "Pay (simulated)" }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    await waitForText(page, /Payment confirmed/);
    const m2 = await metrics(page);
    check(report, "8: the return page has no horizontal overflow at 375", !m2.overflow, JSON.stringify(m2));
    const v2 = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "8: the return page has no serious/critical axe violations at 375", v2.length === 0, JSON.stringify(v2));
    await shot(page, report, "checkout-buyer-return-375");
    await context.close();
    const { page: ap } = await (async () => { const s = await signedIn(browser, "agency:super", { viewport: phone }); watch(s.page, report, "super-375", allow); return s; })();
    await open(ap, state.G.intentPath);
    const m3 = await metrics(ap);
    check(report, "8: the Super Admin's intent page has no horizontal overflow at 375", !m3.overflow, JSON.stringify(m3));
    const v3 = (await axe(ap)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "8: the Super Admin's intent page has no serious/critical axe violations at 375", v3.length === 0, JSON.stringify(v3));
    await shot(ap, report, "checkout-admin-intent-375");
    await open(ap, "/admin/purchase-intents");
    const m4 = await metrics(ap);
    check(report, "8: the purchase intents list has no horizontal overflow at 375", !m4.overflow, JSON.stringify(m4));
    const v4 = (await axe(ap)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "8: the purchase intents list has no serious/critical axe violations at 375", v4.length === 0, JSON.stringify(v4));
  }

  if (stages.includes(9)) {
    // ---- 9. The invited emails: the automatically created workspace sent its invitation to the buyer (to the capture mailbox; nothing real is sent).
    const { context, page } = await publicPage(browser);
    await page.goto(`${BASE}/dev/mailbox`, { waitUntil: "domcontentloaded" });
    const text = await waitForText(page, /bailey\./, { tries: 8 });
    check(report, "9: the capture mailbox holds the workspace invitation for the automatically provisioned buyer", /alderplumbing/.test(text.toLowerCase().replace(/\s+/g, "")) || /bailey\.[a-z0-9]+\.alderplumbing/.test(text), text.slice(0, 300));
    await context.close();
  }
} catch (error) {
  report.pageErrors.push(`script: ${error instanceof Error ? error.stack?.slice(0, 600) : String(error)}`);
} finally {
  finish(report, "wave2-purchase-checkout-qa");
  await browser.close();
}
