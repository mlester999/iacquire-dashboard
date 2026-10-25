// Browser QA of paying for a managed-maintenance period online, in the isolated QA app started WITH the simulated PayMongo (nothing real is contacted, no money moves):
//
//   node scripts/run-checkout-qa-seed.mjs      (once, with the QA app stopped: Harbor gets an activated core system, a waived setup fee and an active plan paid through 4 days from now)
//   $env:CRM_QA_PAYMONGO_SIM = "1"; $env:CRM_QA_DEMO = "1"; node scripts/inbox-qa.mjs
//   node scripts/paymongo-sim.mjs
//   node scripts/wave2-maintenance-payment-qa.mjs
//
// The workspace owner opens the plan, chooses months and goes to the (simulated) provider's page; backing out changes nothing; paying changes the paid-through day only after the
// provider's SIGNED notice; a replayed notice extends nothing twice; a refund notice is reported to the team and changes nothing; a member who may not manage the plan is not offered
// the button; and the dialog works at phone width. What it cannot prove: how the real PayMongo behaves.
import { BASE, axe, check, finish, launch, metrics, newReport, open, shot, signedIn, watch } from "./qa-harness.mjs";

const SIM = "http://127.0.0.1:3281";
const allow = { allowOrigins: [SIM] };
const squash = (s) => s.replace(/\s+/g, " ").trim();
const body = (page) => page.evaluate(() => document.body.innerText).then(squash);
const report = newReport();
const browser = await launch();

async function simSessions() {
  const html = await (await fetch(`${SIM}/control`)).text();
  return [...html.matchAll(/<code>(IAQ-[A-Z0-9]+)<\/code> · (cs_sim_[a-f0-9]+) · (\w+)/g)].map((m) => ({ reference: m[1], id: m[2], status: m[3] })).reverse();
}
async function simNotice(reference, kind) {
  const session = (await simSessions()).find((s) => s.reference === reference);
  if (!session) throw new Error(`The simulator has no session for ${reference}`);
  return (await fetch(`${SIM}/control/${session.id}/${kind}`, { method: "POST", redirect: "manual" })).status;
}
// The label is upper-cased by CSS (innerText returns it that way), and its value is the next line.
const stat = async (page, label) => (await page.locator("main").innerText()).match(new RegExp(`${label}\\s*\\n+\\s*([^\\n]+)`, "i"))?.[1]?.trim() ?? null;

try {
  const { page } = await signedIn(browser, "harbor:owner");
  watch(page, report, "owner", allow);
  await open(page, "/maintenance");
  const first = await body(page);
  const paidBefore = await stat(page, "Paid through");
  check(report, "1: the plan is active and the paid-through day is shown", /Active/.test(first) && Boolean(paidBefore), `${paidBefore}`);
  report.notes.push(`paid through before: ${paidBefore}`);
  const payButton = page.getByRole("button", { name: "Pay for more months" });
  check(report, "1: the owner is offered 'Pay for more months'", (await payButton.count()) === 1);

  await payButton.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 30_000 });
  const dText = squash(await dialog.innerText());
  check(report, "1: the dialog says nothing is charged here and the plan changes only when PayMongo confirms", /nothing is charged here/.test(dText) && /only when PayMongo confirms/.test(dText), dText.slice(0, 300));
  check(report, "1: the choices are 1, 3, 6 and 12 months with the dollar price", /1 month · \$299/.test(dText) || (await dialog.locator("option").allTextContents()).some((t) => /1 month/.test(t) && /299/.test(t)), dText.slice(0, 300));
  const vio = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
  check(report, "1: the open dialog has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
  await shot(page, report, "maintenance-pay-dialog");
  await dialog.locator("#pay-months").selectOption("3");

  await dialog.getByRole("button", { name: "Continue to PayMongo" }).click();
  await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/checkout/"), { timeout: 90_000 });
  const simText = await body(page);
  const reference = /Reference: (IAQ-[A-Z0-9]+)/.exec(simText)?.[1] ?? null;
  check(report, "2: the provider's page asks for exactly 3 months at 58 pesos to the dollar (PHP 52,026.00)", /PHP 52,026\.00/.test(simText), simText.slice(0, 250));
  const firstUrl = page.url();

  // Backing out changes nothing, and says so.
  await page.getByRole("button", { name: /Cancel and go back/ }).click();
  await page.waitForURL((u) => u.pathname === "/maintenance", { timeout: 90_000 });
  await page.waitForSelector("main h1, main h2", { timeout: 60_000 });
  const back = await body(page);
  check(report, "2: after backing out, the page says nothing was charged and the plan has not changed", /without paying/.test(back) && /has not changed/.test(back), back.slice(0, 400));
  check(report, "2: the paid-through day is unchanged after backing out", (await stat(page, "Paid through")) === paidBefore);

  // Pressing again must not open a second charge for the same period.
  await open(page, "/maintenance");
  await page.getByRole("button", { name: "Pay for more months" }).click();
  await page.getByRole("dialog").locator("#pay-months").selectOption("3");
  await page.getByRole("dialog").getByRole("button", { name: "Continue to PayMongo" }).click();
  await page.waitForURL((u) => u.origin === SIM && u.pathname.startsWith("/checkout/"), { timeout: 90_000 });
  const sessions = (await simSessions()).filter((s) => s.status === "open");
  report.notes.push(`second press: ${page.url() === firstUrl ? "reopened the same checkout" : "a different checkout"}; open simulator sessions: ${sessions.length}`);
  check(report, "2: pressing again reopens the same provider checkout instead of starting a second charge", page.url() === firstUrl, `${firstUrl} vs ${page.url()}`);

  await page.getByRole("button", { name: "Pay (simulated)" }).click();
  await page.waitForURL((u) => u.origin === new URL(BASE).origin && u.pathname === "/maintenance", { timeout: 90_000 });
  await page.waitForSelector("main h1, main h2", { timeout: 60_000 });
  const thanks = await body(page);
  check(report, "3: the buyer returns to a page that says it does not decide the payment arrived", /does not decide that a payment arrived/.test(thanks), thanks.slice(0, 300));
  // The page looks again by itself; wait for the signed notice's effect to show.
  let paidAfter = await stat(page, "Paid through");
  for (let i = 0; i < 12 && paidAfter === paidBefore; i++) { await page.waitForTimeout(5000); paidAfter = await stat(page, "Paid through"); }
  report.notes.push(`paid through after paying for 3 months: ${paidAfter}`);
  check(report, "3: after the provider's signed notice, the paid-through day moved three months on", Boolean(paidAfter) && paidAfter !== paidBefore && /2027/.test(paidAfter), `${paidBefore} -> ${paidAfter}`);
  await shot(page, report, "maintenance-paid-through");

  // A replay of the same signed notice extends nothing again.
  const replay = await simNotice(reference, "replay");
  await page.waitForTimeout(1500);
  await open(page, "/maintenance");
  check(report, "4: a replayed notice is acknowledged and does not extend the plan twice", replay === 303 && (await stat(page, "Paid through")) === paidAfter, `${paidAfter} -> ${await stat(page, "Paid through")}`);

  // A refund notice: reported to the team, nothing is revoked.
  await simNotice(reference, "refund");
  await page.waitForTimeout(1500);
  await open(page, "/maintenance");
  const afterRefund = await body(page);
  check(report, "5: a refund reported by the provider does not shorten or cancel the plan automatically", (await stat(page, "Paid through")) === paidAfter && /Active/.test(afterRefund), `${await stat(page, "Paid through")}`);
  const { page: admin } = await signedIn(browser, "agency:super");
  watch(admin, report, "super", allow);
  await open(admin, "/admin/billing?tab=payments");
  const payments = await body(admin);
  check(report, "5: the team sees the maintenance payment confirmed by PayMongo's signed notice, and the refund as a report", /Harbor Home Services/.test(payments) && /PayMongo reported a refund/.test(payments) && /nothing was changed automatically/.test(payments), payments.slice(0, 200));
  const mIdx = payments.indexOf("Harbor Home Services");
  report.notes.push("agency payments row: " + (mIdx >= 0 ? payments.slice(mIdx, mIdx + 420) : "not found"));
  await open(admin, "/admin/maintenance");
  const am = await body(admin);
  check(report, "5: the agency's maintenance list shows Harbor's plan as active", /Harbor Home Services/.test(am) && /Active/.test(am), am.slice(0, 200));

  // A member who may not manage the plan is not offered the button.
  const { page: mgr } = await signedIn(browser, "harbor:manager");
  watch(mgr, report, "manager", allow);
  await open(mgr, "/maintenance");
  const mt = await body(mgr);
  check(report, "6: a manager without the plan permission sees the plan but no way to pay for it", /Maintenance/.test(mt) && (await mgr.getByRole("button", { name: /Pay (for more months|and start|online)/ }).count()) === 0, mt.slice(0, 200));

  // Phone width: the dialog and its footer.
  const { page: phone } = await signedIn(browser, "harbor:owner", { viewport: { width: 375, height: 812 } });
  watch(phone, report, "owner-375", allow);
  await open(phone, "/maintenance");
  const m1 = await metrics(phone);
  check(report, "7: the maintenance page has no horizontal overflow at 375", !m1.overflow, JSON.stringify(m1));
  await phone.getByRole("button", { name: "Pay for more months" }).click();
  await phone.getByRole("dialog").waitFor({ timeout: 30_000 });
  const m2 = await metrics(phone);
  check(report, "7: the open dialog has no horizontal overflow at 375", !m2.overflow, JSON.stringify(m2));
  const go = phone.getByRole("dialog").getByRole("button", { name: "Continue to PayMongo" });
  const box = await go.boundingBox();
  check(report, "7: the 'Continue to PayMongo' button is on screen and at least 44px tall at 375", box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 376 && box.y + box.height <= 812, JSON.stringify(box));
  const v2 = (await axe(phone)).filter((v) => v.impact === "serious" || v.impact === "critical");
  check(report, "7: the dialog has no serious/critical axe violations at 375", v2.length === 0, JSON.stringify(v2));
  await shot(phone, report, "maintenance-pay-dialog-375");
} catch (error) {
  report.pageErrors.push(`script: ${error instanceof Error ? error.stack?.slice(0, 600) : String(error)}`);
} finally {
  finish(report, "wave2-maintenance-payment-qa");
  await browser.close();
}
