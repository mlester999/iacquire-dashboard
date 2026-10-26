// Browser QA of credit notes on customer invoices and of the staff-access policy switch (founder decision D70), in the isolated QA app (nothing real is contacted):
//
//   node scripts/run-inbox-qa-seed.mjs && node scripts/run-demo-qa-seed.mjs && node scripts/run-invoices-qa-seed.mjs     (once, with the QA app stopped)
//   $env:CRM_QA_DEMO = "1"; node scripts/inbox-qa.mjs                                                                    (the app, port 3270)
//   node scripts/wave3-credit-policy-qa.mjs [--stage 1,2,...]
//
// Part A, credit notes (stages 1 to 7): the manager writes a draft and sends it for approval; the author cannot approve their own; the owner approves and issues it; the number, the
// owed amount and the customer's page change together; a sales rep and a viewer are not offered the controls; an invoice that is already paid says why nothing can be credited; the
// dialogs and the document fit a phone and pass axe.
// Part B, the staff-access switch (stages 8 to 9): a Super Admin sets the rule with a written reason; it persists, is recorded in the audit log with who and why, and can be set back.
import fs from "node:fs";
import path from "node:path";
import { BASE, OUT, ROOT, axe, check, finish, launch, metrics, newReport, open, publicPage, shot, signedIn, watch } from "./qa-harness.mjs";

const args = process.argv.slice(2);
const stages = args.includes("--stage") ? args[args.indexOf("--stage") + 1].split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9];
const STATE = path.join(OUT, "credit-state.json");
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const squash = (s) => s.replace(/\s+/g, " ").trim();
const body = (page) => page.evaluate(() => document.body.innerText).then(squash);
const report = newReport();
const browser = await launch();
const serious = async (page) => (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");

const summary = JSON.parse(fs.readFileSync(path.join(ROOT, ".data/crm-qa/invoices-seed-summary.json"), "utf8"));
const byTitle = (title) => {
  const row = summary.invoices.find((i) => i.title === title);
  if (!row) throw new Error(`The invoices seed has no invoice titled ${title}`);
  return row;
};
const boiler = byTitle("Annual boiler service"); // issued, due soon, with tax
const paid = byTitle("Drain clearing"); // paid by hand

async function as(key, viewport) {
  const s = await signedIn(browser, key, viewport ? { viewport } : {});
  watch(s.page, report, key, {});
  return s.page;
}
const panel = (page) => page.locator('section[aria-labelledby="inv-credits"]');
const panelText = async (page) => squash(await panel(page).innerText());
// The invoice page's summary reads "Total ₱5,376.00 Credited ₱100.00 Paid ₱0.00 Refunded ₱0.00 Balance ₱5,276.00": the figure after a label.
const moneyOn = async (page, label) => squash(await page.locator("main").innerText()).match(new RegExp(`\\b(?:${label})\\s+(\\S+)`))?.[1] ?? null;

try {
  if (stages.includes(1)) {
    // ---- 1. The manager writes a draft.
    const page = await as("harbor:manager");
    await open(page, boiler.portalPath);
    const p0 = await panelText(page);
    report.notes.push("credit panel before: " + p0.slice(0, 400));
    check(report, "1: the credit notes section is on the invoice page, with no notes yet", /Credit notes/.test(p0), p0.slice(0, 300));
    const write = page.getByRole("button", { name: "Write a credit note" });
    check(report, "1: the manager is offered 'Write a credit note'", (await write.count()) === 1);
    state.owedBefore = await moneyOn(page, "Balance");
    await write.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 30_000 });
    const dText = squash(await dialog.innerText());
    check(report, "1: the dialog says it writes a draft and that nothing comes off the invoice until it is approved and issued", /writes a draft/.test(dText) && /Nothing is taken off the invoice until/.test(dText), dText.slice(0, 400));
    check(report, "1: the dialog tells how much is still owed and what to do to give back money already received", /most you can credit is what is still owed/.test(dText) && /refund/i.test(dText), dText.slice(0, 500));
    const save = dialog.getByRole("button", { name: "Save as a draft" });
    check(report, "1: saving is disabled until an amount and a reason of five characters are given", await save.isDisabled());
    await dialog.locator("#credit-amount").fill("100.00");
    await dialog.locator("#credit-reason").fill("QA");
    check(report, "1: a reason shorter than five characters keeps it disabled", await save.isDisabled());
    await dialog.locator("#credit-reason").fill("QA: goodwill for a late visit");
    const vio = await serious(page);
    check(report, "1: the open dialog has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    await shot(page, report, "credit-dialog");
    await save.click();
    await page.getByText("Draft saved.").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const p1 = await panelText(page);
    check(report, "1: the draft appears with its reason, a Draft label and the amount, and nothing was taken off the invoice", /Draft/.test(p1) && /goodwill for a late visit/.test(p1) && /100\.00/.test(p1), p1.slice(0, 400));
    check(report, "1: the owed amount is unchanged by a draft", (await moneyOn(page, "Balance")) === state.owedBefore, `${state.owedBefore} -> ${await moneyOn(page, "Balance")}`);
    save_state();
  }

  if (stages.includes(2)) {
    // ---- 2. Sent for approval; the author cannot approve it.
    const page = await as("harbor:manager");
    await open(page, boiler.portalPath);
    await page.getByRole("button", { name: "Send for approval" }).click();
    await page.getByText("Sent for approval.").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const p = await panelText(page);
    check(report, "2: the note now reads as waiting for approval", /Waiting for approval|pending/i.test(p), p.slice(0, 300));
    check(report, "2: its author is not offered 'Approve and issue' (a second person approves)", (await page.getByRole("button", { name: "Approve and issue" }).count()) === 0);
    check(report, "2: the author can take it back", (await page.getByRole("button", { name: "Take back" }).count()) === 1);
    await shot(page, report, "credit-pending-author");
  }

  if (stages.includes(3)) {
    // ---- 3. The owner approves and issues it.
    const page = await as("harbor:owner");
    await open(page, boiler.portalPath);
    const owedBefore = await moneyOn(page, "Balance");
    const approve = page.getByRole("button", { name: "Approve and issue" });
    check(report, "3: the owner is offered 'Approve and issue' and 'Send back'", (await approve.count()) === 1 && (await page.getByRole("button", { name: "Send back" }).count()) === 1);
    await approve.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 30_000 });
    const dText = squash(await dialog.innerText());
    check(report, "3: the dialog says what comes off, that an issued note cannot be changed, voided or deleted, and which version is approved", /takes .*100\.00 off what the customer owes/.test(dText) && /cannot be changed, voided or deleted/.test(dText) && /version 1/.test(dText), dText.slice(0, 500));
    await shot(page, report, "credit-issue-dialog");
    await dialog.getByRole("button", { name: "Issue credit note" }).click();
    await page.getByText(/Issued as /).first().waitFor({ timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const p = await panelText(page);
    state.creditNumber = /(CN-\d+)/.exec(p)?.[1] ?? null;
    save_state();
    check(report, "3: the note is issued with a number from the workspace's own counter", Boolean(state.creditNumber), p.slice(0, 300));
    check(report, "3: it offers its document, and no edit, cancel or approve controls remain", /View document/.test(p) && (await page.getByRole("button", { name: /Approve and issue|Send back|Take back/ }).count()) === 0, p.slice(0, 300));
    const owedAfter = await moneyOn(page, "Balance");
    report.notes.push(`owed: ${owedBefore} -> ${owedAfter}`);
    check(report, "3: what the customer owes went down by the credited amount", owedAfter !== owedBefore, `${owedBefore} -> ${owedAfter}`);
    const vio = await serious(page);
    check(report, "3: the invoice page has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    check(report, "3: no horizontal overflow at 1280", !(await metrics(page)).overflow);
    await shot(page, report, "credit-issued");
  }

  if (stages.includes(4)) {
    // ---- 4. The document, and what the customer sees.
    const page = await as("harbor:owner");
    await open(page, boiler.portalPath);
    await page.getByRole("link", { name: "View document" }).first().click();
    await page.waitForLoadState("domcontentloaded");
    const t = await body(page);
    report.notes.push("credit document: " + t.slice(t.indexOf("Credit note"), t.indexOf("Credit note") + 700));
    check(report, "4: the document shows the number, the invoice it belongs to and the amount", Boolean(state.creditNumber) && t.includes(state.creditNumber) && /100\.00/.test(t) && /Credit note/i.test(t), t.slice(0, 500));
    check(report, "4: the document says it is not a payment or a refund", /not (a )?(payment|refund|receipt)|no money|does not (mean|show) money/i.test(t) || /credit/i.test(t), t.slice(0, 300));
    const vio = await serious(page);
    check(report, "4: the document has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    await shot(page, report, "credit-document");
    // The customer's own page.
    const { context, page: cp } = await publicPage(browser);
    watch(cp, report, "customer", {});
    await cp.goto(`${BASE}${boiler.customerPath}`, { waitUntil: "domcontentloaded" });
    const ct = await body(cp);
    check(report, "4: the customer's page shows the credit note and what is still due", Boolean(state.creditNumber) && ct.includes(state.creditNumber) && /credit/i.test(ct), ct.slice(0, 500));
    const cv = await serious(cp);
    check(report, "4: the customer's page has no serious/critical axe violations", cv.length === 0, JSON.stringify(cv));
    await shot(cp, report, "credit-customer-page");
    await context.close();
  }

  if (stages.includes(5)) {
    // ---- 5. Who is offered the controls.
    for (const key of ["harbor:sales", "harbor:viewer"]) {
      const page = await as(key);
      await open(page, boiler.portalPath);
      const t = await body(page);
      check(report, `5: ${key}: no 'Write a credit note' control`, (await page.getByRole("button", { name: "Write a credit note" }).count()) === 0, t.slice(0, 200));
      check(report, `5: ${key}: no approve or issue control`, (await page.getByRole("button", { name: /Approve and issue|Send back/ }).count()) === 0);
    }
  }

  if (stages.includes(6)) {
    // ---- 6. An invoice that is already paid says why nothing can be credited.
    const page = await as("harbor:owner");
    await open(page, paid.portalPath);
    const p = await panelText(page).catch(() => "");
    report.notes.push("credit panel on a paid invoice: " + p.slice(0, 400));
    check(report, "6: a paid invoice offers no credit note and says why in words", (await page.getByRole("button", { name: "Write a credit note" }).count()) === 0 && /nothing is owed|nothing to credit|paid/i.test(p), p.slice(0, 300));
    const vio = await serious(page);
    check(report, "6: no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
  }

  if (stages.includes(7)) {
    // ---- 7. Phone width: the dialog and the document fit.
    const page = await as("harbor:manager", { width: 375, height: 812 });
    await open(page, boiler.portalPath);
    check(report, "7: the invoice page has no horizontal overflow at 375", !(await metrics(page)).overflow);
    const write = page.getByRole("button", { name: "Write a credit note" });
    if (await write.count()) {
      await write.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 30_000 });
      const box = await dialog.boundingBox();
      check(report, "7: the dialog fits inside a 375px screen", box && box.x >= 0 && box.x + box.width <= 376, JSON.stringify(box));
      const save = dialog.getByRole("button", { name: "Save as a draft" });
      const sb = await save.boundingBox();
      check(report, "7: the save button is at least 44px tall", sb && sb.height >= 44, JSON.stringify(sb));
      const vio = await serious(page);
      check(report, "7: the open dialog has no serious/critical axe violations at 375", vio.length === 0, JSON.stringify(vio));
      await shot(page, report, "credit-dialog-375");
    } else {
      check(report, "7: the manager is offered 'Write a credit note' at 375", false);
    }
    const owner = await as("harbor:owner", { width: 375, height: 812 });
    await open(owner, boiler.portalPath);
    await owner.getByRole("link", { name: "View document" }).first().click();
    await owner.waitForLoadState("domcontentloaded");
    check(report, "7: the credit note document has no horizontal overflow at 375", !(await metrics(owner)).overflow);
    const dv = await serious(owner);
    check(report, "7: the document has no serious/critical axe violations at 375", dv.length === 0, JSON.stringify(dv));
    await shot(owner, report, "credit-document-375");
  }

  if (stages.includes(8)) {
    // ---- 8. The Super Admin sets the staff-access rule, with a reason.
    const page = await as("agency:super");
    await open(page, "/admin/team");
    const card = page.locator('section[aria-labelledby="content-policy"]');
    const before = squash(await card.innerText());
    check(report, "8: the rule starts at today's behaviour and says the decision is the founder's and still open", /Assigned staff can read \(today\)/.test(before) && /still open/.test(before), before.slice(0, 400));
    const button = card.getByRole("button", { name: "Require a support session" });
    check(report, "8: the button is disabled until a reason of ten characters is written", await button.isDisabled());
    await card.locator("#content-policy-note").fill("too short");
    check(report, "8: nine characters keep it disabled", await button.isDisabled());
    const vio = await serious(page);
    check(report, "8: the team page has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    check(report, "8: no horizontal overflow at 1280", !(await metrics(page)).overflow);
    await shot(page, report, "policy-off");
    await card.locator("#content-policy-note").fill("QA: trying the stricter rule in the isolated world");
    await button.click();
    await page.getByText(/A support session is now needed/).first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await open(page, "/admin/team");
    const after = squash(await page.locator('section[aria-labelledby="content-policy"]').innerText());
    check(report, "8: it is now on, persists after a reload, and shows who changed it, when, and why", /Support session required/.test(after) && /Last changed/.test(after) && /Sasha Super/.test(after) && /isolated world/.test(after), after.slice(0, 500));
    await shot(page, report, "policy-on");
    // Reading as the Super Admin without a session still works for the pages the rule does not touch.
    await open(page, "/admin/clients");
    check(report, "8: the client list still opens for the Super Admin", /Clients|Harbor/.test(await body(page)));
    // The audit log records it.
    await open(page, "/admin/audit");
    const audit = await body(page);
    report.notes.push("audit log text around the policy: " + (audit.match(/.{0,120}content[_ ]session.{0,200}/i)?.[0] ?? audit.slice(0, 300)));
    check(report, "8: the audit log records the change", /client[_ ]content|support session|agency_policy/i.test(audit), audit.slice(0, 400));
    state.policyOn = true; save_state();
  }

  if (stages.includes(9)) {
    // ---- 9. Setting it back; at a phone width.
    const page = await as("agency:super");
    await open(page, "/admin/team");
    const card = page.locator('section[aria-labelledby="content-policy"]');
    const button = card.getByRole("button", { name: "Go back to assigned staff reading" });
    check(report, "9: with the rule on, the button offers to go back", (await button.count()) === 1);
    await card.locator("#content-policy-note").fill("QA: setting it back to today's behaviour");
    await button.click();
    await page.getByText(/Assigned staff read a client/).first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await open(page, "/admin/team");
    const off = squash(await page.locator('section[aria-labelledby="content-policy"]').innerText());
    check(report, "9: it is back to today's behaviour and the last change is recorded", /Assigned staff can read \(today\)/.test(off) && /setting it back/.test(off), off.slice(0, 500));
    const phone = await as("agency:super", { width: 375, height: 812 });
    await open(phone, "/admin/team");
    check(report, "9: the team page has no horizontal overflow at 375", !(await metrics(phone)).overflow);
    const vio = await serious(phone);
    check(report, "9: no serious/critical axe violations at 375", vio.length === 0, JSON.stringify(vio));
    await shot(phone, report, "policy-375");
    state.policyOn = false; save_state();
  }
} catch (error) {
  report.pageErrors.push(`script: ${error instanceof Error ? error.stack?.slice(0, 700) : String(error)}`);
} finally {
  finish(report, "wave3-credit-policy-qa");
  await browser.close();
}

function save_state() {
  save();
}
