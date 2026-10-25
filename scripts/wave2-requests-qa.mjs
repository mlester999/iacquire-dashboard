// Browser QA of the Requests journey across a client and the iAcquire team, in the isolated QA app (node scripts/inbox-qa.mjs, port 3270): a client opens a support request, staff
// reply, keep a private note, assign and resolve it, the client reads only what was meant for them and answers the one-question satisfaction survey, the Super Admin sees it in the
// analytics, and nobody from another workspace or another role can read or answer it. Then the Request a Change path (switched on by the Super Admin on the rollout page).
//
//   node scripts/wave2-requests-qa.mjs [--stage 1,2,3...]
// Nothing leaves the QA server: email is captured, no AI provider is connected.
import fs from "node:fs";
import path from "node:path";
import { BASE, OUT, axe, check, finish, launch, metrics, newReport, open, shot, signedIn, watch } from "./qa-harness.mjs";

const args = process.argv.slice(2);
const stages = args.includes("--stage") ? args[args.indexOf("--stage") + 1].split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9];
const STATE = path.join(OUT, "requests-state.json");
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const stamp = Date.now().toString(36);

const report = newReport();
const browser = await launch();
const who = {};
const as = async (key) => { if (!who[key]) { who[key] = await signedIn(browser, key); watch(who[key].page, report, key); } return who[key].page; };
const main = (page) => page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText);
const squash = (s) => s.replace(/\s+/g, " ");

try {
  if (stages.includes(1)) {
    // ---- 1. The Super Admin switches on Request a Change for the Harbor workspace and the support satisfaction survey (no delay, so the browser can answer it now).
    const admin = await as("agency:super");
    await open(admin, "/admin/module-rollout");
    const sw = admin.getByRole("switch", { name: "Request a Change for Harbor Home Services (Inbox QA)" });
    if ((await sw.getAttribute("aria-checked")) !== "true") {
      await sw.click();
      const dlg = admin.getByRole("alertdialog").or(admin.getByRole("dialog")).first();
      await dlg.waitFor();
      report.notes.push("rollout confirm: " + squash(await dlg.innerText()).slice(0, 400));
      await dlg.getByRole("button", { name: /Switch on|Confirm|Yes|Turn on/i }).first().click();
      await admin.waitForTimeout(2500);
    }
    await open(admin, "/admin/module-rollout");
    check(report, "1: Request a Change is on for Harbor (switched on by the Super Admin on the rollout page)", (await admin.getByRole("switch", { name: "Request a Change for Harbor Home Services (Inbox QA)" }).getAttribute("aria-checked")) === "true");

    await open(admin, "/admin/support/settings");
    const survey = admin.getByRole("switch", { name: "Ask how it went after a request is resolved" });
    if ((await survey.getAttribute("aria-checked")) !== "true") await survey.click();
    await admin.locator("#s-sdelay").fill("0");
    await admin.getByRole("button", { name: "Save changes" }).last().click();
    await admin.waitForTimeout(2500);
    await open(admin, "/admin/support/settings");
    check(report, "1: the satisfaction survey is on with no delay after saving and reloading", (await admin.getByRole("switch", { name: "Ask how it went after a request is resolved" }).getAttribute("aria-checked")) === "true" && (await admin.locator("#s-sdelay").inputValue()) === "0");
  }

  if (stages.includes(2)) {
    // ---- 2. The client opens a support request.
    const owner = await as("harbor:owner");
    await open(owner, "/support");
    state.subject = `QA ${stamp}: my calendar is not syncing`;
    await owner.getByPlaceholder("For example: My calendar isn't syncing").fill(state.subject);
    await owner.getByPlaceholder("Tell us a bit about what you need…").fill("Since Monday my connected calendar shows old appointments. QA data: please ignore. Internal secret word: PLUMLEAF.");
    await shot(owner, report, "req-form");
    await owner.getByRole("button", { name: "Send request" }).click();
    await owner.getByText("Your request has been sent").waitFor({ timeout: 60_000 });
    const sentText = squash(await main(owner));
    state.reference = /\b([A-Z]{2,4}-\d{3,})\b/.exec(sentText)?.[1];
    check(report, "2: sending the request says it was sent and gives a reference number", Boolean(state.reference), sentText.slice(0, 300));
    await shot(owner, report, "req-client-sent");
    await owner.getByRole("link", { name: "View your request" }).first().click();
    await owner.waitForURL(/\/support\/[0-9a-f-]{36}/, { timeout: 60_000 });
    state.ticketId = /\/support\/([0-9a-f-]{36})/.exec(owner.url())[1];
    report.notes.push("client request page: " + squash(await main(owner)).slice(0, 700));
    await shot(owner, report, "req-client-open");
    save();
  }

  if (stages.includes(3)) {
    // ---- 3. Staff see it in the queue, keep a private note, reply, assign and resolve.
    const admin = await as("agency:super");
    await open(admin, "/admin/support");
    const queue = squash(await main(admin));
    check(report, "3: the request is in the agency queue", queue.includes(state.subject), queue.slice(0, 300));
    await shot(admin, report, "req-queue");
    await open(admin, `/admin/support/${state.ticketId}`);
    const detail = await main(admin);
    report.notes.push("staff detail: " + squash(detail).slice(0, 1200));
    const controls = await admin.evaluate(() => Array.from(document.querySelectorAll("main button, main textarea, main select, main input, main [role=tab]")).map((e) => `${e.tagName.toLowerCase()}:${e.getAttribute("role") ?? e.type ?? ""} "${(e.getAttribute("aria-label") || e.innerText || e.placeholder || e.name || "").trim().slice(0, 50)}"`));
    report.notes.push("staff controls: " + controls.join(" | "));
    await shot(admin, report, "req-staff-detail");

    state.note = `RUBYFLINT-${stamp}`;
    state.reply = `We reconnected your calendar, ${stamp}. Please check it now.`;
    // A private note: only the team reads it.
    await admin.getByRole("radio", { name: "Internal note" }).click();
    await admin.getByPlaceholder(/Write an? (internal )?note|Write a note|note/i).first().fill(`Customer sounded confused. ${state.note}`);
    const noteButton = admin.getByRole("button", { name: /^(Add|Send|Save|Post)[^]*note$/i }).or(admin.getByRole("button", { name: /Send reply|Add note|Save note/i })).first();
    report.notes.push("note button: " + (await noteButton.innerText()));
    await noteButton.click();
    await admin.waitForTimeout(2500);
    check(report, "3: the private note is kept in the team's thread", (await main(admin)).includes(state.note));
    // A reply the client reads, moving the request to In progress.
    await admin.getByRole("radio", { name: "Reply to client" }).click();
    await admin.getByPlaceholder("Write a reply to the client…").fill(state.reply);
    await admin.locator("select").first().selectOption({ label: "Then: in progress" });
    await admin.getByRole("button", { name: "Send reply" }).click();
    await admin.waitForTimeout(2500);
    check(report, "3: the reply is in the thread", (await main(admin)).includes(state.reply));
    // Replying takes the request when nobody else has it; if it is still unassigned, the button does it.
    if (await admin.getByRole("button", { name: "Assign to me" }).count()) { await admin.getByRole("button", { name: "Assign to me" }).click(); await admin.waitForTimeout(2000); }
    report.notes.push("after reply: " + squash(await main(admin)).slice(0, 900));
    check(report, "3: the request is assigned to the person who took it", /Assigned to[^]*Sasha Super/.test(await main(admin)) || /Sasha Super/.test(squash(await main(admin))));
    await admin.getByRole("button", { name: "Resolve" }).click();
    await admin.waitForTimeout(2500);
    const resolved = squash(await main(admin));
    report.notes.push("staff after resolve: " + resolved.slice(0, 600));
    check(report, "3: the request shows as resolved to the team", /Resolved/.test(resolved));
    await shot(admin, report, "req-staff-resolved");
    save();
  }

  if (stages.includes(4)) {
    // ---- 4. The client reads the reply, never the private note, and is asked the one question.
    const owner = await as("harbor:owner");
    await open(owner, `/support/${state.ticketId}`);
    const t = squash(await main(owner));
    check(report, "4: the client reads the team's reply", t.includes(state.reply), t.slice(0, 300));
    check(report, "4: the client never reads the private note", !t.includes(state.note) && !/Customer sounded confused/.test(t));
    check(report, "4: the client sees the request as resolved", /Resolved/.test(t));
    check(report, "4: the survey is asked inside the request", /How did we do\?/.test(t), t.slice(0, 300));
    const html = await (await owner.request.get(`${BASE}/support/${state.ticketId}`)).text();
    check(report, "4: the private note is in none of the page's data either (HTML and streamed payload)", !html.includes(state.note) && !html.includes("Customer sounded confused"));
    await shot(owner, report, "req-client-survey");
    const vio = (await axe(owner)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "4: the request page and survey card have no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    const m = await metrics(owner);
    check(report, "4: no horizontal overflow at 1280", !m.overflow, JSON.stringify(m));
  }

  if (stages.includes(5)) {
    // ---- 5. Other people cannot read or answer it.
    const viewer = await as("harbor:viewer");
    await open(viewer, `/support/${state.ticketId}`);
    const vt = squash(await main(viewer));
    report.notes.push("viewer sees: " + vt.slice(0, 400));
    check(report, "5: a viewer in the same workspace is not asked the question (only the person who opened the request is)", !/How did we do\?/.test(vt) && !/Send my answer/.test(vt), vt.slice(0, 200));
    check(report, "5: a viewer never reads the private note", !vt.includes(state.note));
    const other = await as("other:owner");
    await open(other, `/support/${state.ticketId}`);
    const ot = squash(await main(other));
    check(report, "5: another workspace's owner cannot open the request", /couldn't find that page|not found|don't have access/i.test(ot) && !ot.includes(state.subject), ot.slice(0, 200));
    const otherHtml = await (await other.request.get(`${BASE}/support/${state.ticketId}`)).text();
    check(report, "5: and nothing of the request is in what that page sends", !otherHtml.includes(state.subject) && !otherHtml.includes(state.reply) && !otherHtml.includes(state.note));
  }

  if (stages.includes(6)) {
    // ---- 6. The client answers once.
    const owner = await as("harbor:owner");
    await open(owner, `/support/${state.ticketId}`);
    await owner.getByRole("radio", { name: "5 out of 5" }).click();
    check(report, "6: the answer cannot be sent before both questions are answered", await owner.getByRole("button", { name: "Send my answer" }).isDisabled());
    await owner.getByRole("radio", { name: "Yes, it helped" }).click();
    state.comment = `Quick and kind ${stamp}`;
    await owner.getByPlaceholder("A sentence for the team…").fill(state.comment);
    await owner.getByRole("button", { name: "Send my answer" }).click();
    await owner.getByText(/Thank you — your answer was recorded/).waitFor({ timeout: 30_000 });
    check(report, "6: the answer is recorded and thanked", true);
    await shot(owner, report, "req-client-thanks");
    await open(owner, `/support/${state.ticketId}`);
    const again = squash(await main(owner));
    check(report, "6: after answering the question is not asked again", !/Send my answer/.test(again), again.slice(0, 200));
    save();
  }

  if (stages.includes(7)) {
    // ---- 7. The team sees the numbers, not the comment.
    const admin = await as("agency:super");
    await open(admin, "/admin/support/analytics");
    const a = squash(await main(admin));
    report.notes.push("analytics: " + a.slice(0, 1200));
    check(report, "7: analytics counts the survey answered, with the rating", /Satisf|survey/i.test(a) && /5(\.0)?/.test(a), a.slice(0, 300));
    check(report, "7: analytics never shows the client's comment", !a.includes(state.comment));
    await shot(admin, report, "req-analytics");
    const vio = (await axe(admin)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "7: analytics has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
  }
} catch (e) {
  check(report, "scenario ran to the end", false, String(e).slice(0, 500));
} finally {
  save();
  await browser.close();
  finish(report, "requests");
}
