// Browser QA of "Invoice this proposal": a customer accepts a proposal that mixes one-time and recurring lines on the public page (emailed code from the QA dev mailbox), then the owner
// reads what would be invoiced, makes the draft, asks again (idempotent), and the draft is checked line by line against the proposal. Also: a proposal that needs a signature and has
// none, a proposal that is not accepted, a role that cannot make invoices, and the phone width. Isolated QA app on port 3270 (node scripts/inbox-qa.mjs); nothing leaves it.
//
//   node scripts/wave2-invoice-from-proposal-qa.mjs
import fs from "node:fs";
import path from "node:path";
import { BASE, ROOT, axe, check, finish, launch, metrics, newReport, open, publicPage, shot, signedIn, watch } from "./qa-harness.mjs";

const report = newReport();
const browser = await launch();
const summary = JSON.parse(fs.readFileSync(path.join(ROOT, ".data/crm-qa/proposals-seed-summary.json"), "utf8").replace(/^﻿/, ""));
const customerUrl = (number) => summary.proposals.find((p) => p.number === number).url.replace(/^http:\/\/127\.0\.0\.1:\d+/, BASE);
const text = (page) => page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText);

async function proposalPath(page, number) {
  await open(page, "/proposals?filter=all");
  const row = page.locator("main a[href^='/proposals/']", { hasText: number }).first();
  return row.getAttribute("href");
}

const { page: owner } = await signedIn(browser, "harbor:owner");
watch(owner, report, "owner");

try {
  // ---- The customer accepts P-0007 (one-time + monthly + yearly lines) with the emailed code.
  const { context: cx, page: customer } = await publicPage(browser);
  watch(customer, report, "customer");
  await customer.goto(customerUrl("P-0007"), { waitUntil: "domcontentloaded" });
  await customer.getByRole("button", { name: "Email me a code" }).waitFor();
  await customer.waitForFunction(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => /Email me a code/.test(x.innerText)); return b && Object.keys(b).some((k) => k.startsWith("__reactProps$")); });
  await customer.getByRole("button", { name: "Email me a code" }).click();
  await customer.waitForURL(/c=sent/, { timeout: 60_000 }).catch(() => {});
  const mail = await cx.newPage();
  await mail.goto(`${BASE}/dev/mailbox`, { waitUntil: "domcontentloaded" });
  await mail.waitForFunction(() => /Your code for proposal P-0007/.test(document.body.textContent), null, { timeout: 60_000 }).catch(() => {});
  // The message is an iframe's srcdoc: read its words (not what is drawn) from the newest entry addressed to the customer.
  const mailText = await mail.evaluate(() => {
    const li = Array.from(document.querySelectorAll("li")).find((x) => /linh\.nguyen@example\.test/.test(x.textContent) && /proposal_code/.test(x.textContent));
    const doc = new DOMParser().parseFromString(li?.querySelector("iframe")?.getAttribute("srcdoc") ?? "", "text/html");
    return (doc.body.textContent ?? "").replace(/\s+/g, " ");
  });
  const match = /(?<!\d)(\d{6})(?!\d)/.exec(mailText);
  const codes = match ? [match[1]] : [];
  check(report, "customer: a six-digit code reached the (captured) mailbox, addressed to the customer", codes.length > 0, mailText.slice(0, 300));
  await mail.close();
  await customer.locator("input[name=code]").fill(codes[0]);
  await shot(customer, report, "ifp-customer-code");
  await customer.getByRole("button", { name: "Confirm" }).click();
  await customer.getByText(/Email confirmed/).waitFor({ timeout: 60_000 });
  check(report, "customer: the emailed code confirms the address, which is shown masked", /Email confirmed: \w\*\*\*@/.test(await customer.evaluate(() => document.body.innerText)));
  await customer.getByRole("checkbox").check();
  await customer.getByRole("button", { name: "Accept this proposal" }).click();
  await customer.waitForTimeout(3500);
  const afterAccept = await customer.evaluate(() => document.body.innerText);
  const answer = afterAccept.slice(afterAccept.lastIndexOf("Your answer") >= 0 ? afterAccept.lastIndexOf("Your answer") : afterAccept.length - 800);
  report.notes.push("customer after accept: " + answer.replace(/\s+/g, " ").slice(0, 500));
  check(report, "customer: acceptance is recorded and said in words (and is not called a signature)", /accepted/i.test(answer) && !/signed/i.test(answer.replace(/not an electronic signature/gi, "")), answer.slice(0, 400));
  await shot(customer, report, "ifp-customer-accepted");
  await cx.close();

  // ---- The owner makes the invoice.
  const p7 = await proposalPath(owner, "P-0007");
  await open(owner, p7);
  await owner.getByRole("tab", { name: /Invoice/ }).or(owner.getByRole("link", { name: /^Invoice$/ })).first().click();
  await owner.waitForTimeout(1500);
  let t = await text(owner);
  const panel = t.slice(t.indexOf("Invoice this proposal"));
  report.notes.push("invoice panel before: " + panel.replace(/\s+/g, " ").slice(0, 1500));
  check(report, "owner: the panel says how the proposal was accepted", /How it was accepted/i.test(panel), panel.slice(0, 300));
  await shot(owner, report, "ifp-owner-preview");
  const vio = (await axe(owner)).filter((v) => v.impact === "serious" || v.impact === "critical");
  check(report, "owner: proposal invoice tab has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
  const mm = await metrics(owner);
  check(report, "owner: no horizontal overflow at 1280", !mm.overflow, JSON.stringify(mm));

  await owner.getByRole("button", { name: /Make a draft invoice/ }).click();
  const dlg = owner.getByRole("alertdialog").or(owner.getByRole("dialog")).first();
  await dlg.waitFor();
  const dlgText = (await dlg.innerText()).replace(/\s+/g, " ");
  report.notes.push("confirm: " + dlgText.slice(0, 500));
  check(report, "owner: the confirmation counts the one-time lines copied and the monthly/yearly lines left off", /22 lines the customer pays once are copied/.test(dlgText) && /2 monthly or yearly lines are left off/.test(dlgText), dlgText);
  check(report, "owner: the confirmation says nothing is issued, sent or charged and the deal is unchanged", /nothing is issued, sent or charged, and the deal is not changed/i.test(dlgText), dlgText);
  await dlg.getByRole("button", { name: "Make the draft" }).dblclick();
  await owner.waitForTimeout(3500);
  t = await text(owner);
  report.notes.push("after make: " + t.slice(t.indexOf("Invoices made from this proposal") >= 0 ? t.indexOf("Invoices made from this proposal") : 0).replace(/\s+/g, " ").slice(0, 700));
  const madeLinks = await owner.locator("section[aria-label='Invoices made from this proposal'] a[href^='/invoices/']").count();
  check(report, "owner: a double click on the confirmation made exactly one draft", madeLinks === 1, `drafts listed: ${madeLinks}`);
  await shot(owner, report, "ifp-owner-made");

  // ---- The draft invoice itself.
  const href = await owner.locator("section[aria-label='Invoices made from this proposal'] a[href^='/invoices/']").first().getAttribute("href");
  await open(owner, href);
  t = await text(owner);
  report.notes.push("draft invoice: " + t.replace(/\s+/g, " ").slice(0, 1500));
  check(report, "invoice: it is a draft (no number, not issued)", /Draft/.test(t) && !/INV-\d+/.test(t.split("Lines")[0].slice(0, 200)), t.slice(0, 300));
  check(report, "invoice: it names the proposal it came from", /P-0007/.test(t), "");
  check(report, "invoice: the total is the proposal's one-time total, USD 22,095.67, with tax at the proposal's rate", /\$22,095\.67/.test(t) && /8\.25%/.test(t), t.slice(0, 300));
  check(report, "invoice: the monthly (53.04) and yearly (129.90) lines are named as not on the invoice, for the owner to decide", /2 lines are not on this invoice/.test(t) && /every month, USD 53\.04/.test(t) && /every year, USD 129\.90/.test(t), t.slice(t.indexOf("2 lines"), t.indexOf("2 lines") + 300));
  check(report, "invoice: it carries only the one-time lines (no monthly or yearly price)", !/per month|per year|\/mo|\/yr/i.test(t.slice(t.indexOf("Lines"))), "");
  await shot(owner, report, "ifp-draft-invoice");

  // ---- Asking again finds the same draft instead of making another.
  await open(owner, p7);
  await owner.getByRole("tab", { name: /Invoice/ }).or(owner.getByRole("link", { name: /^Invoice$/ })).first().click();
  await owner.waitForTimeout(1500);
  t = await text(owner);
  check(report, "owner: asking again does not offer a second draft for the same version as the main action", !(await owner.getByRole("button", { name: /^Make a draft invoice$/ }).count()), "");
  check(report, "owner: the first draft is still the only one listed", (await owner.locator("section[aria-label='Invoices made from this proposal'] a[href^='/invoices/']").count()) === 1);

  // ---- Not accepted, and a signature that is missing.
  const sent = await proposalPath(owner, "P-0003");
  await open(owner, sent);
  await owner.getByRole("tab", { name: /Invoice/ }).or(owner.getByRole("link", { name: /^Invoice$/ })).first().click();
  await owner.waitForTimeout(1200);
  t = await text(owner);
  check(report, "not accepted: the panel says why no invoice can be made, and offers no button", !(await owner.getByRole("button", { name: /Make a draft invoice/ }).count()) && /accepted|answer|customer has not/i.test(t.slice(t.indexOf("Invoice this proposal"))), t.slice(t.indexOf("Invoice this proposal"), t.indexOf("Invoice this proposal") + 400));
  const invoiceTab = async (number) => {
    await open(owner, await proposalPath(owner, number));
    await owner.getByRole("tab", { name: /Invoice/ }).or(owner.getByRole("link", { name: /^Invoice$/ })).first().click();
    await owner.waitForTimeout(1200);
    return (await text(owner)).slice((await text(owner)).indexOf("Invoice this proposal"));
  };
  // Needs a signature and none has been collected: nothing to invoice yet, and the panel says so.
  const unsigned = await invoiceTab("P-0017");
  report.notes.push("needs a signature, none collected (P-0017): " + unsigned.replace(/\s+/g, " ").slice(0, 400));
  check(report, "needs a signature and has none: no draft can be made", !(await owner.getByRole("button", { name: /Make a draft invoice/ }).count()), unsigned.slice(0, 300));
  // Signed through the signing service: the basis says so, and a draft can be made.
  const signed = await invoiceTab("P-0016");
  check(report, "signed through the signing service: the basis says so and a draft can be made", /signing service reported that the customer signed/i.test(signed) && (await owner.getByRole("button", { name: /Make a draft invoice/ }).count()) === 1, signed.slice(0, 300));
  // Accepted by phone and recorded by the owner: the basis is honest about who verified it.
  const phone = await invoiceTab("P-0013");
  report.notes.push("accepted by phone (P-0013): " + phone.replace(/\s+/g, " ").slice(0, 300));
  check(report, "accepted by phone: the basis says the owner recorded it", /recorded|phone|owner/i.test(phone.slice(0, 500)), phone.slice(0, 300));

  // ---- A role that cannot make invoices.
  const { page: sales, context: salesCx } = await signedIn(browser, "harbor:viewer");
  watch(sales, report, "viewer");
  await open(sales, p7);
  const tabs = await sales.getByRole("tab", { name: /Invoice/ }).or(sales.getByRole("link", { name: /^Invoice$/ })).count();
  if (tabs) {
    await sales.getByRole("tab", { name: /Invoice/ }).or(sales.getByRole("link", { name: /^Invoice$/ })).first().click();
    await sales.waitForTimeout(1200);
  }
  t = await text(sales);
  check(report, "viewer: no draft can be made", !(await sales.getByRole("button", { name: /Make a draft invoice|Make a further/ }).count()), t.slice(0, 200));
  await salesCx.close();

  // ---- Phone width.
  await owner.setViewportSize({ width: 375, height: 812 });
  await open(owner, p7);
  await owner.getByRole("tab", { name: /Invoice/ }).or(owner.getByRole("link", { name: /^Invoice$/ })).first().click().catch(() => {});
  await owner.waitForTimeout(1200);
  const pm = await metrics(owner);
  check(report, "phone: no horizontal overflow at 375", !pm.overflow, JSON.stringify(pm));
  await shot(owner, report, "ifp-owner-375");
} catch (e) {
  check(report, "scenario ran to the end", false, String(e).slice(0, 500));
  await shot(owner, report, "ifp-error");
} finally {
  await browser.close();
  finish(report, "invoice-from-proposal");
}
