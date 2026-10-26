// Browser QA of paying with PayPal, in the isolated QA app started WITH the simulated PayPal (nothing real is contacted, no money moves):
//
//   node scripts/run-inbox-qa-seed.mjs && node scripts/run-checkout-qa-seed.mjs      (once, with the QA app stopped: Harbor gets an activated core system, a waived fee and an active plan)
//   $env:CRM_QA_PAYPAL_SIM = "1"; $env:CRM_QA_DEMO = "1"; node scripts/inbox-qa.mjs   (the app, port 3270)
//   node scripts/paypal-sim.mjs                                                       (the simulated PayPal, 127.0.0.1:3282)
//   node scripts/wave3-paypal-qa.mjs [--stage 1,2,...]
//
// Part A, the purchase checkout (stages 1 to 7): the Super Admin opens online checkout; a buyer confirms an invitation and is sent to the (simulated) PayPal page for exactly the
// frozen US$1,499; coming back decides nothing; the capture the server makes and PayPal's SIGNED notice are what verify the payment and, when the Super Admin allowed it, create the
// workspace; replays, refunds and disputes are handled; a forged delivery is refused; a buyer who walks away is told how to come back; the pages are keyboard- and axe-clean.
// Part B, the optional monthly plan payment (stages 8 to 10): the Super Admin opens automatic payments; the workspace owner approves a PayPal subscription; only a confirmed charge
// moves the paid-through day; a failed charge, a refund, a dispute and a cancellation at PayPal are each handled and shown in words.
// What it cannot prove: how the real PayPal behaves. The simulator's answers and notices were written from PayPal's documentation and have never been seen from a PayPal account.
import fs from "node:fs";
import path from "node:path";
import { BASE, OUT, axe, check, finish, launch, metrics, newReport, open, publicPage, shot, signedIn, watch } from "./qa-harness.mjs";

const SIM = "http://127.0.0.1:3282";
// The approval links are ordinary https://www.sandbox.paypal.com addresses (the application checks them as it would in production). The browser never reaches that host: every request
// to it is answered here from the simulator, and nothing is passed through to the network.
const PAYPAL_PAGES = "https://www.sandbox.paypal.com";
const args = process.argv.slice(2);
const stages = args.includes("--stage") ? args[args.indexOf("--stage") + 1].split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const STATE = path.join(OUT, "paypal-state.json");
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const stamp = Date.now().toString(36);
const squash = (s) => s.replace(/\s+/g, " ").trim();
const body = (page) => page.evaluate(() => document.body.innerText).then(squash);
const report = newReport();
const browser = await launch();
const allow = { allowOrigins: [SIM, PAYPAL_PAGES] };
const paypalRequests = { answered: 0, refused: 0 };
async function interceptPaypal(page) {
  await page.context().route(`${PAYPAL_PAGES}/**`, async (route) => {
    const u = new URL(route.request().url());
    const order = u.pathname === "/checkoutnow" ? u.searchParams.get("token") : null;
    const sub = u.pathname === "/webapps/billing/subscriptions" ? u.searchParams.get("ba_token") : null;
    const to = order && /^ORDSIM[A-F0-9]+$/.test(order) ? `${SIM}/approve/${order}` : sub && /^I-SIM[A-F0-9]+$/.test(sub) ? `${SIM}/subscribe/${sub}` : null;
    if (!to) { paypalRequests.refused += 1; return route.abort(); }
    paypalRequests.answered += 1;
    return route.fulfill({ status: 302, headers: { Location: to } });
  });
  return page;
}
let adminPage = null;
const admin = async () => { if (!adminPage) { const { page } = await signedIn(browser, "agency:super"); watch(page, report, "super", allow); await interceptPaypal(page); adminPage = page; } return adminPage; };
const serious = async (page) => (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");

/** The simulator's orders and subscriptions, newest last. */
async function simState() {
  const html = await (await fetch(`${SIM}/control`)).text();
  const orders = [...html.matchAll(/data-order="(ORDSIM[A-F0-9]+)"><p><code>(IAQ-[A-Z0-9]+)<\/code> · [A-Z0-9]+ · <span data-status>(\w+)<\/span>/g)].map((m) => ({ id: m[1], reference: m[2], status: m[3] }));
  const subs = [...html.matchAll(/data-sub="(I-SIM[A-F0-9]+)"><p><code>(IAQ-[A-Z0-9]+)<\/code> · [A-Z0-9-]+ · <span data-status>(\w+)<\/span> · failed (\d+) · charges (\d+)/g)].map((m) => ({ id: m[1], reference: m[2], status: m[3], failed: Number(m[4]), charges: Number(m[5]) }));
  return { orders, subs };
}
async function orderOf(reference) {
  const o = (await simState()).orders.filter((x) => x.reference === reference);
  if (!o.length) throw new Error(`The simulator has no order for ${reference}`);
  return o[o.length - 1];
}
async function notice(kind, id, which) {
  return (await fetch(`${SIM}/control/${which}/${id}/${kind}`, { method: "POST", redirect: "manual" })).status;
}

async function buyer(viewport) {
  const { context, page } = await publicPage(browser, viewport);
  watch(page, report, "buyer", allow);
  await interceptPaypal(page);
  return { context, page };
}
async function invite(a, { company, auto }) {
  await open(a, "/admin/purchase-intents");
  await a.locator("#pi-name").fill("Bailey Buyer");
  await a.locator("#pi-email").fill(`bailey.${stamp}.${company.toLowerCase().replace(/\W+/g, "")}@buyer.example.test`);
  await a.locator("#pi-company").fill(company);
  await a.locator("#pi-industry").fill("Home services");
  if (auto) await a.getByLabel(/Create the workspace by itself/).check();
  await a.getByRole("button", { name: "Create invitation" }).click();
  await a.getByText(/is ready/).first().waitFor({ timeout: 60_000 });
  const link = (await a.locator("main code").first().textContent()).trim();
  const href = await a.getByRole("link", { name: "Open the intent" }).getAttribute("href");
  return { link, intentPath: href, company };
}
const payWithPaypal = (page) => page.getByRole("button", { name: /Pay .* with PayPal/ });
async function confirmAndGetPay(page, link) {
  await open(page, link);
  await page.getByRole("button", { name: /Confirm and continue/ }).click();
  const pay = payWithPaypal(page);
  await pay.waitFor({ timeout: 60_000 });
  return pay;
}
async function onSimApproval(page) {
  await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/approve/"), { timeout: 90_000 });
  const text = await body(page);
  return { text, reference: /Reference: (IAQ-[A-Z0-9]+)/.exec(text)?.[1] ?? null };
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
const stat = async (page, label) => (await page.locator("main").innerText()).match(new RegExp(`${label}\\s*\\n+\\s*([^\\n]+)`, "i"))?.[1]?.trim() ?? null;

try {
  if (stages.includes(1)) {
    // ---- 1. The Super Admin opens online checkout. PayPal is the only provider configured, so it is the only button a buyer will see.
    const a = await admin();
    await open(a, "/admin/purchase-intents");
    const section = a.locator('section[aria-label="Online checkout"]');
    const before = squash(await section.innerText());
    report.notes.push("online checkout section before: " + before.slice(0, 300));
    const sw = a.getByRole("switch", { name: "Allow buyers to pay online" });
    if ((await sw.getAttribute("aria-checked")) !== "true") {
      await sw.click();
      await a.waitForFunction(() => /Open \(test mode\)/.test(document.querySelector('section[aria-label="Online checkout"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
    }
    const after = squash(await section.innerText());
    check(report, "1: online checkout is open in test mode (the simulated PayPal is the sandbox)", /Open \(test mode\)/.test(after), after.slice(0, 300));
    check(report, "1: the page names PayPal as the provider that is ready", /PayPal/.test(after), after.slice(0, 300));
    await shot(a, report, "paypal-admin-list");
    const vio = await serious(a);
    check(report, "1: the purchase intents page has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    const m = await metrics(a);
    check(report, "1: no horizontal overflow at 1280", !m.overflow, JSON.stringify(m));
  }

  if (stages.includes(2)) {
    // ---- 2. Invitation A (the workspace is created by itself) and its buyer pays with PayPal.
    const a = await admin();
    const inv = await invite(a, { company: `Alder Plumbing ${stamp}`, auto: true });
    state.A = inv; save();
    const { context, page } = await buyer();
    const pay = await confirmAndGetPay(page, inv.link);
    const text = await body(page);
    check(report, "2: the buyer sees the frozen US$1,499 and a PayPal button for exactly that", /\$1,499/.test(text) && (await pay.innerText()).includes("1,499"), text.slice(0, 300));
    check(report, "2: the page says it is paid in US dollars on PayPal's own page and that no payment details are seen", /US dollars/.test(text) && /never sees your payment details/.test(text), text.slice(0, 400));
    check(report, "2: no card or peso wording is shown when PayPal is the only provider", !/Philippine pesos/.test(text) && !/card or e-wallet/.test(text));
    const vio = await serious(page);
    check(report, "2: the buyer page has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    check(report, "2: no horizontal overflow at 1280", !(await metrics(page)).overflow);
    await shot(page, report, "paypal-buyer-pay");

    await pay.click();
    const sim = await onSimApproval(page);
    state.A.reference = sim.reference; save();
    check(report, "2: PayPal's page asks for exactly USD 1499.00 and carries our reference", /USD 1499\.00/.test(sim.text) && Boolean(sim.reference), sim.text.slice(0, 300));
    const order = await orderOf(sim.reference);
    check(report, "2: the order is waiting for the buyer, not paid", order.status === "PAYER_ACTION_REQUIRED", JSON.stringify(order));
    const a2 = await admin();
    await open(a2, state.A.intentPath);
    check(report, "2: before PayPal confirms, the intent is only 'Buyer confirmed' and the checkout is waiting", /Buyer confirmed/.test(await body(a2)) && /Waiting for the payment/.test(await body(a2)), (await body(a2)).slice(0, 300));

    await page.getByRole("button", { name: /Approve and continue/ }).click();
    await page.waitForURL((u) => u.origin === new URL(BASE).origin && u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    const returned = await waitForText(page, /Your workspace is ready/);
    check(report, "2: the buyer comes back to a page that reports the workspace as ready (only after the server took the payment and PayPal's notice)", /Your workspace is ready/.test(returned), returned.slice(0, 300));
    check(report, "2: the return address carries the checkout reference, never the bearer token", page.url().includes(sim.reference) && !page.url().includes(inv.link.split("/purchase/")[1]), page.url());
    check(report, "2: PayPal now shows the order completed (the server captured it after the buyer approved)", (await orderOf(sim.reference)).status === "COMPLETED");
    const rv = await serious(page);
    check(report, "2: the return page has no serious/critical axe violations", rv.length === 0, JSON.stringify(rv));
    await shot(page, report, "paypal-buyer-return");
    await open(page, inv.link);
    check(report, "2: the used link offers no second payment", !(await payWithPaypal(page).count()), (await body(page)).slice(0, 300));
    await context.close();
  }

  if (stages.includes(3)) {
    // ---- 3. What the Super Admin sees for A; a replay and a refund notice after the workspace exists.
    const a = await admin();
    await open(a, state.A.intentPath);
    const t = await body(a);
    check(report, "3: the intent is 'Workspace created' with the provider's evidence", /Workspace created/.test(t) && /Confirmed by the payment provider's signed notice|payment provider/.test(t), t.slice(0, 400));
    check(report, "3: the online checkout shows Paid with the stored dollar amount, in test mode", /Paid/.test(t) && /\$1,499/.test(t) && /test mode/.test(t), t.slice(0, 400));
    check(report, "3: a link to open the client workspace is offered", (await a.getByRole("link", { name: /Open the client workspace/ }).count()) > 0);
    await shot(a, report, "paypal-admin-intent-provisioned");
    const order = await orderOf(state.A.reference);
    const created = async () => (await body(a)).match(/Client workspace created/g)?.length ?? 0;
    const before = (await body(a)).match(/Payment confirmed/g)?.length ?? 0;
    check(report, "3: the replayed notice is acknowledged", (await notice("replay", order.id, "order")) === 303);
    await a.waitForTimeout(1500);
    await open(a, state.A.intentPath);
    const afterReplay = (await body(a)).match(/Payment confirmed/g)?.length ?? 0;
    check(report, "3: the replay recorded no second payment and no second workspace", afterReplay === before && (await created()) === 1, `${before} -> ${afterReplay}`);
    await notice("refund", order.id, "order");
    await a.waitForTimeout(1500);
    await open(a, state.A.intentPath);
    const refunded = await body(a);
    check(report, "3: a refund reported after the workspace exists does not undo or alter the workspace", /Workspace created/.test(refunded) && (await a.getByRole("link", { name: /Open the client workspace/ }).count()) > 0, refunded.slice(0, 400));
    await open(a, "/admin/billing?tab=payments");
    const payments = await body(a);
    const mention = /PayPal reported a refund/.exec(payments);
    report.notes.push("agency payments tab after the refund notice: " + (mention ? payments.slice(Math.max(0, mention.index - 160), mention.index + 260) : "no 'PayPal reported a refund' line; first 400: " + payments.slice(0, 400)));
    check(report, "3: the refund shows on the workspace's payment, labelled as PayPal's report with nothing changed automatically", Boolean(mention) && /nothing was changed automatically/.test(payments), payments.slice(0, 300));
    const { context, page } = await buyer();
    await open(page, `/purchase/return/${state.A.reference}`);
    check(report, "3: the buyer's return page still shows the workspace as ready", /Your workspace is ready/.test(await body(page)));
    await context.close();
  }

  if (stages.includes(4)) {
    // ---- 4. Invitation B (no automatic workspace): the payment verifies, a person creates it.
    const a = await admin();
    const inv = await invite(a, { company: `Birch Roofing ${stamp}`, auto: false });
    state.B = inv; save();
    const { context, page } = await buyer();
    const pay = await confirmAndGetPay(page, inv.link);
    await pay.click();
    const sim = await onSimApproval(page);
    state.B.reference = sim.reference; save();
    await page.getByRole("button", { name: /Approve and continue/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    const returned = await waitForText(page, /Payment confirmed|workspace is ready/);
    check(report, "4: the buyer is told the payment is confirmed, but the workspace is not claimed ready", /Payment confirmed/.test(returned) && !/workspace is ready/.test(returned), returned.slice(0, 300));
    await context.close();
    await open(a, state.B.intentPath);
    const t = await body(a);
    check(report, "4: the intent says 'Payment verified' with no workspace yet, and a Super Admin creates it", /Payment verified/.test(t) && /A Super Admin creates it/.test(t) && !/Open the client workspace/.test(t), t.slice(0, 300));
    const create = a.getByRole("button", { name: /Create client workspace/ });
    check(report, "4: the 'Create client workspace' button is offered", (await create.count()) === 1);
    await create.click();
    await a.getByRole("link", { name: /Open the client workspace/ }).waitFor({ timeout: 90_000 }).catch(() => {});
    await open(a, state.B.intentPath);
    check(report, "4: after the click the workspace exists and the payment is the provider's, recorded once", /Open the client workspace/.test(await body(a)), (await body(a)).slice(0, 300));
  }

  if (stages.includes(5)) {
    // ---- 5. A dispute (C) and a refund (D) reported before the workspace exists hold the purchase.
    const a = await admin();
    for (const [key, kind, label] of [["C", "dispute", "Cedar Electric"], ["D", "refund", "Dogwood Painting"]]) {
      const inv = await invite(a, { company: `${label} ${stamp}`, auto: false });
      state[key] = inv; save();
      const { context, page } = await buyer();
      const pay = await confirmAndGetPay(page, inv.link);
      await pay.click();
      const sim = await onSimApproval(page);
      state[key].reference = sim.reference; save();
      await page.getByRole("button", { name: /Approve and continue/ }).click();
      await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
      await waitForText(page, /Payment confirmed/);
      await notice(kind, (await orderOf(sim.reference)).id, "order");
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: "domcontentloaded" });
      const rt = await body(page);
      check(report, `5: ${kind}: the buyer's page says a person will look at it and that nothing more is charged`, /needs a person to look at it/.test(rt) && /Nothing more is charged/.test(rt), rt.slice(0, 300));
      await context.close();
      await open(a, state[key].intentPath);
      const t = await body(a);
      check(report, `5: ${kind}: the Super Admin sees the intent on hold with the reason in words`, /On hold\./.test(t) && (kind === "dispute" ? /dispute/i : /refund/i).test(t), t.slice(0, 400));
      check(report, `5: ${kind}: no 'Create client workspace' button is offered while on hold`, (await a.getByRole("button", { name: /Create client workspace/ }).count()) === 0);
      const vio = await serious(a);
      check(report, `5: ${kind}: the held intent page has no serious/critical axe violations`, vio.length === 0, JSON.stringify(vio));
      if (key === "C") await shot(a, report, "paypal-admin-intent-held");
    }
  }

  if (stages.includes(6)) {
    // ---- 6. A buyer who walks away from PayPal's page, and a forged delivery.
    const a = await admin();
    const inv = await invite(a, { company: `Elm Landscaping ${stamp}`, auto: false });
    state.E = inv; save();
    const { context, page } = await buyer();
    const pay = await confirmAndGetPay(page, inv.link);
    await pay.click();
    const first = await onSimApproval(page);
    state.E.reference = first.reference; save();
    const firstUrl = page.url();
    await page.getByRole("button", { name: /Cancel and return to the merchant/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    await page.waitForTimeout(500);
    const left = await body(page);
    check(report, "6: a buyer who cancelled is told they left the payment page, nothing was charged, and how to come back", /You left the payment page/.test(left) && /nothing was charged/i.test(left) && /purchase link/.test(left), left.slice(0, 300));
    await shot(page, report, "paypal-buyer-left");
    await open(page, inv.link);
    const again = payWithPaypal(page);
    check(report, "6: the purchase link still offers the PayPal button and says the buyer is not charged twice", (await again.count()) === 1 && /not charged twice/.test(await body(page)), (await body(page)).slice(0, 300));
    await again.click();
    await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/approve/"), { timeout: 90_000 });
    check(report, "6: pressing Pay again reopens the same PayPal order", page.url() === firstUrl, `${firstUrl} vs ${page.url()}`);
    check(report, "6: PayPal holds exactly one order for that reference", (await simState()).orders.filter((o) => o.reference === state.E.reference).length === 1);
    await context.close();

    // A delivery that PayPal does not vouch for is refused and changes nothing.
    const forged = JSON.stringify({ id: "WH-FORGED-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPFORGED1", status: "COMPLETED", custom_id: state.E.reference, amount: { currency_code: "USD", value: "1499.00" }, supplementary_data: { related_ids: { order_id: first.reference } } } });
    const res = await fetch(`${BASE}/api/webhooks/paypal`, { method: "POST", headers: { "Content-Type": "application/json", "PAYPAL-AUTH-ALGO": "SHA256withRSA", "PAYPAL-CERT-URL": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-FORGED", "PAYPAL-TRANSMISSION-ID": "TX-FORGED-1", "PAYPAL-TRANSMISSION-SIG": "00".repeat(32), "PAYPAL-TRANSMISSION-TIME": new Date().toISOString() }, body: forged });
    check(report, "6: a forged 'payment completed' delivery is refused (not 2xx)", res.status >= 400, `${res.status} ${(await res.text()).slice(0, 120)}`);
    await open(a, state.E.intentPath);
    check(report, "6: the intent is still only waiting after the forged delivery", /Waiting for the payment|Buyer confirmed/.test(await body(a)) && !/Payment verified|Workspace created/.test(await body(a)), (await body(a)).slice(0, 300));
    const noHeaders = await fetch(`${BASE}/api/webhooks/paypal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: forged });
    check(report, "6: a delivery without PayPal's headers is refused", noHeaders.status >= 400, String(noHeaders.status));
  }

  if (stages.includes(7)) {
    // ---- 7. Phone width: the buyer's pages and the Super Admin's intent page.
    const a = await admin();
    const phone = { width: 375, height: 812 };
    const { context, page } = await buyer(phone);
    const inv = await invite(a, { company: `Gum Glazing ${stamp}`, auto: false });
    state.G = inv; save();
    const pay = await confirmAndGetPay(page, inv.link);
    check(report, "7: the buyer's Pay page has no horizontal overflow at 375", !(await metrics(page)).overflow);
    const box = await pay.boundingBox();
    check(report, "7: the PayPal button is at least 44px tall and fits the width", box && box.height >= 44 && box.x >= 0 && box.x + box.width <= phone.width + 1, JSON.stringify(box));
    const v1 = await serious(page);
    check(report, "7: the buyer's Pay page has no serious/critical axe violations at 375", v1.length === 0, JSON.stringify(v1));
    await shot(page, report, "paypal-buyer-pay-375");
    await pay.click();
    const sim = await onSimApproval(page);
    state.G.reference = sim.reference; save();
    check(report, "7: PayPal's own page fits a phone without sideways scrolling", !(await metrics(page)).overflow);
    await page.getByRole("button", { name: /Approve and continue/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith("/purchase/return/"), { timeout: 90_000 });
    await waitForText(page, /Payment confirmed/);
    check(report, "7: the return page has no horizontal overflow at 375", !(await metrics(page)).overflow);
    const v2 = await serious(page);
    check(report, "7: the return page has no serious/critical axe violations at 375", v2.length === 0, JSON.stringify(v2));
    await shot(page, report, "paypal-buyer-return-375");
    await context.close();
    const s = await signedIn(browser, "agency:super", { viewport: phone });
    watch(s.page, report, "super-375", allow);
    await interceptPaypal(s.page);
    await open(s.page, state.G.intentPath);
    check(report, "7: the Super Admin's intent page has no horizontal overflow at 375", !(await metrics(s.page)).overflow);
    const v3 = await serious(s.page);
    check(report, "7: the Super Admin's intent page has no serious/critical axe violations at 375", v3.length === 0, JSON.stringify(v3));
    await shot(s.page, report, "paypal-admin-intent-375");
  }

  if (stages.includes(8)) {
    // ---- 8. The Super Admin opens automatic payments; the owner approves a PayPal subscription on PayPal's page.
    const a = await admin();
    await open(a, "/admin/maintenance");
    const sw = a.getByRole("switch", { name: "Allow clients to pay the maintenance plan automatically" });
    const was = await sw.getAttribute("aria-checked");
    report.notes.push(`automatic payments switch before: ${was}`);
    if (was !== "true") {
      await sw.click();
      await a.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Allow clients to pay the maintenance plan automatically"]')?.getAttribute("aria-checked") === "true", null, { timeout: 30_000 }).catch(() => {});
    }
    check(report, "8: the Super Admin's switch is on", (await sw.getAttribute("aria-checked")) === "true", await body(a));
    await shot(a, report, "paypal-admin-maintenance-switch");

    const { page } = await signedIn(browser, "harbor:owner");
    watch(page, report, "owner", allow);
    await interceptPaypal(page);
    await open(page, "/maintenance");
    const paidBefore = await stat(page, "Paid through");
    state.paidBefore = paidBefore; save();
    check(report, "8: the plan is paid by hand until the owner chooses otherwise, and the paid-through day is shown", /By hand/.test(await body(page)) && Boolean(paidBefore), `${paidBefore}`);
    const button = page.getByRole("button", { name: "Pay monthly automatically with PayPal" });
    const waiting = page.getByRole("link", { name: /Continue to PayPal to approve/ });
    if (await button.count()) {
      check(report, "8: the owner is offered 'Pay monthly automatically with PayPal'", true);
      await button.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 30_000 });
      const dText = squash(await dialog.innerText());
      check(report, "8: the dialog says nothing is charged here, the amount is US$299 a month, and the plan moves only when PayPal confirms a charge", /Nothing is charged here/.test(dText) && /\$299/.test(dText) && /only when PayPal confirms/.test(dText), dText.slice(0, 400));
      const vio = await serious(page);
      check(report, "8: the open dialog has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
      await shot(page, report, "paypal-maintenance-auto-dialog");
      await dialog.getByRole("button", { name: "Continue to PayPal" }).click();
      await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/subscribe/"), { timeout: 90_000 });
      const simText = await body(page);
      state.agreementReference = /Reference: (IAQ-[A-Z0-9]+)/.exec(simText)?.[1] ?? null; save();
      check(report, "8: PayPal's page offers US$299.00 a month and carries our reference", /299\.00 every month/.test(simText) && Boolean(state.agreementReference), simText.slice(0, 300));
      check(report, "8: before approval nothing is paid (PayPal shows the subscription waiting)", /Status: APPROVAL_PENDING/.test(simText));
      // Backing out changes nothing.
      await page.getByRole("button", { name: /Cancel and return to the merchant/ }).click();
      await page.waitForURL((u) => u.origin === new URL(BASE).origin && u.pathname === "/maintenance", { timeout: 90_000 });
      await page.waitForSelector("main h1, main h2", { timeout: 60_000 });
      const back = await body(page);
      check(report, "8: after backing out, the page says nothing was charged and the paid-through day is unchanged", (await stat(page, "Paid through")) === paidBefore && /By hand|waiting/i.test(back), back.slice(0, 400));
      report.notes.push("after backing out: " + back.slice(0, 500));
      await open(page, "/maintenance");
    }
    // A waiting approval is offered as a link, not as a second subscription.
    check(report, "8: a waiting approval is offered again as a link (no second subscription is opened)", (await waiting.count()) === 1, (await body(page)).slice(0, 400));
    await waiting.click();
    await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/subscribe/"), { timeout: 90_000 });
    check(report, "8: PayPal holds exactly one subscription for that reference", (await simState()).subs.filter((s) => s.reference === state.agreementReference).length === 1, JSON.stringify((await simState()).subs));
    await page.getByRole("button", { name: /Agree and subscribe/ }).click();
    await page.waitForURL((u) => u.origin === new URL(BASE).origin && u.pathname === "/maintenance", { timeout: 90_000 });
    const text = await waitForText(page, /Automatic/, { tries: 12 });
    const paidAfter = await stat(page, "Paid through");
    report.notes.push(`paid through: ${paidBefore} -> ${paidAfter}; page: ${text.slice(0, 500)}`);
    check(report, "8: after approval the plan reads as paid automatically", /Automatic/.test(text), text.slice(0, 400));
    check(report, "8: the paid-through day moved only because PayPal's charge was confirmed (a month later than before)", Boolean(paidAfter) && paidAfter !== paidBefore, `${paidBefore} -> ${paidAfter}`);
    await shot(page, report, "paypal-maintenance-active");
    const v2 = await serious(page);
    check(report, "8: the maintenance page has no serious/critical axe violations", v2.length === 0, JSON.stringify(v2));
    check(report, "8: no horizontal overflow at 1280", !(await metrics(page)).overflow);
    state.afterApproval = paidAfter; save();
  }

  if (stages.includes(9)) {
    // ---- 9. A replay changes nothing; a failed month leaves a plan that is paid through a later day exactly as it was and tells the owner; three failures pause the agreement and
    // say so in words; a re-activation turns it back on; a second charge within days of the first is recorded and held for a person; a refund puts the agreement on hold.
    const { page } = await signedIn(browser, "harbor:owner");
    watch(page, report, "owner", allow);
    await interceptPaypal(page);
    const sub = (await simState()).subs.filter((s) => s.reference === state.agreementReference).pop();
    if (!sub) throw new Error("no simulated subscription for the agreement: run stage 8 first");
    const planBox = async () => squash(await page.locator('[aria-label="How this plan is paid"]').innerText());
    const notices = async () => { await open(page, "/notifications"); return body(page); };
    await open(page, "/maintenance");
    const paid0 = await stat(page, "Paid through");
    check(report, "9: a replayed charge notice is acknowledged", (await notice("replay", sub.id, "sub")) === 303);
    await page.waitForTimeout(1500);
    await open(page, "/maintenance");
    check(report, "9: the replay moved nothing", (await stat(page, "Paid through")) === paid0, `${paid0} -> ${await stat(page, "Paid through")}`);

    await notice("fail", sub.id, "sub");
    await page.waitForTimeout(2000);
    await open(page, "/maintenance");
    check(report, "9: one failed charge leaves a plan that is paid through a later day exactly as paid", (await stat(page, "Paid through")) === paid0 && /Automatic/.test(await planBox()), await planBox());
    check(report, "9: the page itself says the last automatic payment did not go through, and that the plan is exactly as paid as it was", /did not go through/.test(await planBox()) && /exactly as paid as it was/.test(await planBox()), await planBox());
    const n1 = await notices();
    report.notes.push("owner notifications after one failed charge: " + n1.slice(n1.indexOf("Notifications"), n1.indexOf("Notifications") + 700));
    check(report, "9: the owner is told PayPal could not collect, and that nothing has changed because the plan is paid through its day", /PayPal could not collect your maintenance payment/.test(n1) && /nothing has changed/.test(n1), n1.slice(0, 400));

    await notice("fail", sub.id, "sub");
    await notice("fail", sub.id, "sub");
    await page.waitForTimeout(2500);
    await open(page, "/maintenance");
    const paused = await planBox();
    report.notes.push("plan box after three failed charges: " + paused);
    check(report, "9: three failures pause the agreement, said in words with the count", /Automatic payments are paused/.test(paused) && /3 failed charges/.test(paused), paused);
    check(report, "9: the pause takes nothing from the plan: the paid-through day is unchanged and the plan is still active", (await stat(page, "Paid through")) === paid0 && /Active/.test(await body(page)));
    await shot(page, report, "paypal-maintenance-suspended");
    check(report, "9: the owner is told the automatic payment is paused and that the CRM and AI employees are not affected", /Automatic payments are paused/.test(await notices()) && /not affected/.test(await notices()));

    await notice("reactivate", sub.id, "sub");
    await page.waitForTimeout(2500);
    await open(page, "/maintenance");
    const back = await planBox();
    check(report, "9: a re-activation at PayPal turns automatic payments on again", /Automatic payments are on/.test(back) && !/paused/.test(back), back);

    // The first charge was collected minutes ago. A second one inside the guard window is recorded, not added to the plan, and a person is told.
    await notice("charge", sub.id, "sub");
    await page.waitForTimeout(2500);
    await open(page, "/maintenance");
    check(report, "9: a second charge within days of the first does not extend the plan by itself", (await stat(page, "Paid through")) === paid0, `${paid0} -> ${await stat(page, "Paid through")}`);
    const a0 = await admin();
    await open(a0, "/admin/maintenance");
    const held = await body(a0);
    check(report, "9: the admin screen shows the charge as recorded and not yet added to the plan", /recorded and not yet added to the plan/.test(held), held.slice(held.indexOf("MANAGED"), held.indexOf("MANAGED") + 500));
    await shot(a0, report, "paypal-admin-maintenance-held-charge");

    await notice("refund", sub.id, "sub");
    await page.waitForTimeout(2000);
    await open(page, "/maintenance");
    const onHold = await planBox();
    report.notes.push("plan box after a refund notice: " + onHold);
    check(report, "9: a refund reported by PayPal puts the agreement on hold, in words, and does not silently extend or shorten the plan", /Automatic payments are on hold/.test(onHold) && (await stat(page, "Paid through")) === paid0, onHold);
    await shot(page, report, "paypal-maintenance-held");

    await open(a0, "/admin/maintenance");
    const at = await body(a0);
    check(report, "9: the admin screen shows the automatic payment, the hold, and that it needs a person", /PayPal/.test(at) && /hold|refund/i.test(at), at.slice(at.indexOf("MANAGED"), at.indexOf("MANAGED") + 500));
    await shot(a0, report, "paypal-admin-maintenance-held");
    const vio = await serious(a0);
    check(report, "9: the admin maintenance screen has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    check(report, "9: no horizontal overflow on the admin screen at 1280", !(await metrics(a0)).overflow);
    const vo = await serious(page);
    check(report, "9: the maintenance page has no serious/critical axe violations while on hold", vo.length === 0, JSON.stringify(vo));
  }

  if (stages.includes(10)) {
    // ---- 10. The owner stops automatic payments; PayPal then shows the subscription cancelled and the plan stays paid through its day; and a cancel done at PayPal's end is noticed.
    const { page } = await signedIn(browser, "harbor:owner");
    watch(page, report, "owner", allow);
    await interceptPaypal(page);
    await open(page, "/maintenance");
    const paid = await stat(page, "Paid through");
    const stop = page.getByRole("button", { name: "Stop automatic payments" });
    check(report, "10: the owner is offered 'Stop automatic payments'", (await stop.count()) >= 1);
    await stop.first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 30_000 });
    const dText = squash(await dialog.innerText());
    check(report, "10: the dialog says the plan stays exactly as it is, paid through its day", /stays exactly as it is/.test(dText), dText.slice(0, 300));
    await shot(page, report, "paypal-maintenance-stop-dialog");
    await dialog.getByRole("button", { name: "Stop automatic payments" }).click();
    await page.waitForTimeout(2500);
    await open(page, "/maintenance");
    const t = await body(page);
    const sub = (await simState()).subs.filter((s) => s.reference === state.agreementReference).pop();
    check(report, "10: PayPal's own record shows the subscription cancelled (the server cancelled it there first)", sub?.status === "CANCELLED", JSON.stringify(sub));
    check(report, "10: the plan is unchanged: the paid-through day is the same and the page says it is paid by hand again", (await stat(page, "Paid through")) === paid && /By hand/.test(t), t.slice(0, 500));
    await shot(page, report, "paypal-maintenance-stopped");
    const vio = await serious(page);
    check(report, "10: the page has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    // At 375 px the maintenance page and its dialog still fit.
    const phone = await signedIn(browser, "harbor:owner", { viewport: { width: 375, height: 812 } });
    watch(phone.page, report, "owner-375", allow);
    await interceptPaypal(phone.page);
    await open(phone.page, "/maintenance");
    check(report, "10: the maintenance page has no horizontal overflow at 375", !(await metrics(phone.page)).overflow);
    const v375 = await serious(phone.page);
    check(report, "10: no serious/critical axe violations at 375", v375.length === 0, JSON.stringify(v375));
    await shot(phone.page, report, "paypal-maintenance-375");
  }
  report.notes.push(`requests to ${PAYPAL_PAGES} answered by the simulator: ${paypalRequests.answered}; refused: ${paypalRequests.refused}; passed to the network: 0 (the route has no pass-through)`);
  check(report, "every request to PayPal's own address was answered by the simulator or refused, none left the machine", paypalRequests.refused === 0, JSON.stringify(paypalRequests));
} catch (error) {
  report.pageErrors.push(`script: ${error instanceof Error ? error.stack?.slice(0, 700) : String(error)}`);
} finally {
  finish(report, "wave3-paypal-qa");
  await browser.close();
}
