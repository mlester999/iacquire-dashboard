// Browser QA of "Send it to the customer" on a customer invoice, against the isolated QA app (node scripts/inbox-qa.mjs, port 3270) seeded with
// INVOICES_QA_DELIVERY=1 (scripts/run-invoices-qa-seed.mjs). Real Chromium, real local sign-in. Nothing can leave: the workspace's email channel is a native Resend one with a made-up
// credential and every write switch is off. The two ends of a send that the QA server cannot produce itself were made by the seed through the real service with a controlled
// in-process provider (scripts/invoices-qa-world.ts, seedInvoiceSentWorld): Annual boiler service was accepted, Water heater inspection was refused.
//
//   node scripts/wave2-invoice-delivery-qa.mjs
import { axe, check, finish, launch, metrics, newReport, open, shot, signedIn, watch } from "./qa-harness.mjs";

const report = newReport();
const browser = await launch();
const { page } = await signedIn(browser, "harbor:owner");
watch(page, report, "owner");

/** Opens every invoice in the list until one has this line, and returns its page path. */
async function invoicePathWith(title) {
  await open(page, "/invoices?filter=all");
  const hrefs = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll("main a[href^='/invoices/']")).map((a) => a.getAttribute("href")).filter((h) => /^\/invoices\/[0-9a-f-]{36}$/.test(h)))]);
  for (const href of hrefs) {
    await open(page, href);
    const text = await page.evaluate(() => document.querySelector("main").innerText);
    if (text.includes(title)) return href;
  }
  throw new Error(`No invoice with a line "${title}"`);
}
const mainText = () => page.evaluate(() => document.querySelector("main").innerText);

try {
  // 1. A message the provider took.
  const accepted = await invoicePathWith("Annual boiler service");
  await open(page, accepted);
  let text = await mainText();
  check(report, "accepted: the history lists the message with the provider having taken it", /Sent|accepted/i.test(text) && !/No message has been sent from here/.test(text), text.slice(text.indexOf("Send it to the customer"), text.indexOf("Send it to the customer") + 700));
  check(report, "accepted: never claims delivery or reading", !/\b(delivered|was read|opened it)\b/i.test(text.slice(text.indexOf("Send it to the customer"))), "");
  await shot(page, report, "invoice-delivery-accepted");
  const acceptedButton = await page.getByRole("button", { name: /Write the message/i }).count();
  report.notes.push(`accepted: "Write the message" buttons offered: ${acceptedButton}`);

  // 2. A message the provider refused.
  const refused = await invoicePathWith("Water heater inspection");
  await open(page, refused);
  text = await mainText();
  check(report, "refused: the history says it did not reach the customer", /not sent|failed|did not|refused|could not/i.test(text.slice(text.indexOf("Messages sent from here"))), text.slice(text.indexOf("Messages sent from here"), text.indexOf("Messages sent from here") + 500));
  await shot(page, report, "invoice-delivery-refused");
  check(report, "refused: the same channel can be tried again", (await page.getByRole("button", { name: /Write the message/i }).count()) > 0);

  // 3. A customer with no consent on record.
  const noConsent = await invoicePathWith("Remote monitoring set-up");
  await open(page, noConsent);
  await page.getByRole("button", { name: /Write the message/i }).first().click();
  await page.getByText("The message the customer will read").waitFor();
  const consentText = await mainText();
  check(report, "no consent: the panel says there is no consent on record and the message can't be sent", /no consent on record[^.]*can't be sent/i.test(consentText), consentText.slice(consentText.indexOf("Send by"), consentText.indexOf("Send by") + 600));
  check(report, "no consent: the send button is disabled", await page.getByRole("button", { name: /Send this message/i }).isDisabled());
  await shot(page, report, "invoice-delivery-no-consent");

  // 4. A test invoice is never offered.
  await open(page, "/invoices?filter=test");
  const testHref = await page.locator("main a[href^='/invoices/']", { hasText: "TEST-" }).first().getAttribute("href");
  await open(page, testHref);
  text = await mainText();
  check(report, "test invoice: the page says a test invoice is never sent", /test invoice is never sent|never sent to a customer|nothing is owed/i.test(text), text.slice(0, 400));
  check(report, "test invoice: no Write the message button", (await page.getByRole("button", { name: /Write the message/i }).count()) === 0);

  // 5. A real send from the page: read, confirm, double click.
  const repipe = await invoicePathWith("Kitchen repipe");
  await open(page, repipe);
  await page.getByRole("button", { name: /Write the message/i }).first().click();
  await page.getByText("The message the customer will read").waitFor();
  const panel = await mainText();
  const preview = panel.slice(panel.indexOf("Send by"), panel.indexOf("Messages sent from here"));
  report.notes.push(`repipe panel: ${preview.replace(/\s+/g, " ").slice(0, 900)}`);
  check(report, "send: the panel shows the masked address", /Goes to\s+\w\*\*\*@/.test(preview), preview.slice(0, 200));
  check(report, "send: the customer's link is shown as words, never as a token", /\[the customer's own link to the invoice\]/.test(preview) && !/\/pay\/[A-Za-z0-9_-]{43}/.test(panel));
  check(report, "send: the wording is labelled as a draft nobody has approved", /draft that nobody has approved/i.test(preview));
  check(report, "send: the send button is enabled for a customer with consent", await page.getByRole("button", { name: /Send this message/i }).isEnabled());
  await shot(page, report, "invoice-delivery-panel");
  const m = await metrics(page);
  check(report, "send: no horizontal overflow at 1280", !m.overflow, JSON.stringify(m));
  const violations = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
  check(report, "send: no serious or critical axe violations with the panel open", violations.length === 0, JSON.stringify(violations));
  await page.getByRole("button", { name: /Send this message/i }).click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).first();
  await dialog.waitFor();
  const dialogText = (await dialog.innerText()).replace(/\s+/g, " ");
  report.notes.push("confirm dialog: " + dialogText.slice(0, 500));
  check(report, "send: the confirmation says what is handed over, to whom, and that it is checked again before it leaves", /hands the message you read/i.test(dialogText) && /i\*\*\*@/.test(dialogText) && /checked again just before it leaves/i.test(dialogText), dialogText.slice(0, 300));
  await shot(page, report, "invoice-delivery-confirm");
  // A double click on the confirmation must send once.
  await dialog.getByRole("button", { name: /Send this message/i }).dblclick();
  await page.waitForTimeout(3500);
  await open(page, repipe);
  text = await mainText();
  const section = text.slice(text.indexOf("Messages sent from here"), text.indexOf("Lines"));
  report.notes.push("after send: " + section.replace(/\s+/g, " ").slice(0, 700));
  check(report, "send: the history shows one message from here", !/No message has been sent from here/.test(section), section.slice(0, 300));
  const rowsCount = await page.locator("section[aria-label='Messages to the customer'] li").count();
  check(report, "send: a double click made exactly one message", rowsCount === 1, `message rows: ${rowsCount}`);
  const state = await page.locator("section[aria-label='Messages to the customer'] li").first().innerText().catch(() => "");
  report.notes.push("message row: " + state.replace(/\s+/g, " ").slice(0, 400));
  check(report, "send: the row says the message waits, was blocked by the provider switch, or is queued, in plain words", /waiting|queued|on its way|not switched on|next sending run|blocked|did not go/i.test(state), state);
  check(report, "send: a second message on the same link is not offered while the first is queued", (await page.getByRole("button", { name: /Write the message/i }).count()) === 0 || /already|on its way|waiting|queued/i.test(text), "");
  await shot(page, report, "invoice-delivery-after-send");

  // 6. Phone width.
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, repipe);
  const mm = await metrics(page);
  check(report, "phone: no horizontal overflow at 375", !mm.overflow, JSON.stringify(mm));
  await shot(page, report, "invoice-delivery-375");
} catch (e) {
  check(report, "scenario ran to the end", false, String(e).slice(0, 400));
  await shot(page, report, "invoice-delivery-error");
} finally {
  await browser.close();
  finish(report, "invoice-delivery");
}
