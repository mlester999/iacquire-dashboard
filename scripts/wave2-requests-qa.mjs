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
const stages = args.includes("--stage") ? args[args.indexOf("--stage") + 1].split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
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

  if (stages.includes(8)) {
    // ---- 8. Request a Change: the client asks, the team triages it.
    const owner = await as("harbor:owner");
    await open(owner, "/support/change");
    check(report, "8: Request a Change is available once the Super Admin has switched it on", !/isn't switched on/.test(await main(owner)));
    state.changeSubject = `QA ${stamp}: greet callers by first name`;
    await owner.getByPlaceholder("For example: Make the voice agent greet callers by name").fill(state.changeSubject);
    await owner.getByPlaceholder("Describe the change you have in mind…").fill("Please make the voice agent greet returning callers by their first name. QA data.");
    await shot(owner, report, "req-change-form");
    await owner.getByRole("button", { name: "Send change request" }).click();
    await owner.getByText(/Your request has been sent|has been sent|received/i).first().waitFor({ timeout: 60_000 });
    const sent = squash(await main(owner));
    report.notes.push("change sent: " + sent.slice(0, 600));
    check(report, "8: the change request is sent and given a reference", /[A-Z]{2,4}-\d{3,}/.test(sent), sent.slice(0, 300));
    await owner.getByRole("link", { name: "View your request" }).first().click();
    await owner.waitForURL(/\/support\/[0-9a-f-]{36}/, { timeout: 60_000 });
    state.changeId = /\/support\/([0-9a-f-]{36})/.exec(owner.url())[1];
    report.notes.push("client change page: " + squash(await main(owner)).slice(0, 900));
    await shot(owner, report, "req-change-client");
    save();
  }

  if (stages.includes(9)) {
    // ---- 9. The team triages the change request.
    const admin = await as("agency:super");
    await open(admin, `/admin/support/${state.changeId}`);
    const t = await main(admin);
    report.notes.push("staff change detail: " + squash(t).slice(0, 1500));
    const controls = await admin.evaluate(() => Array.from(document.querySelectorAll("main button, main textarea, main select, main input, main [role=tab]")).map((e) => `${e.tagName.toLowerCase()}:${e.getAttribute("role") ?? e.type ?? ""} "${(e.getAttribute("aria-label") || e.innerText || e.placeholder || e.name || "").trim().slice(0, 50)}"`));
    report.notes.push("staff change controls: " + controls.join(" | "));
    await shot(admin, report, "req-change-staff");
    state.classNote = `Needs voice-agent rework ${stamp}; check quote with Sam`;
    await admin.locator("#d-class").selectOption({ label: "Needs a quote" });
    await admin.getByPlaceholder("Why you classified it this way.").fill(state.classNote);
    await admin.getByRole("button", { name: "Save classification" }).click();
    await admin.waitForTimeout(2500);
    await open(admin, `/admin/support/${state.changeId}`);
    const savedClass = await admin.locator("#d-class").inputValue();
    const savedNote = await admin.getByPlaceholder("Why you classified it this way.").inputValue();
    const after = squash(await main(admin));
    report.notes.push("staff after classify: " + after.slice(after.indexOf("About this request"), after.indexOf("About this request") + 900));
    check(report, "9: the classification and its reason are saved and read back after a reload", /quote/i.test(savedClass) && savedNote === state.classNote, `${savedClass} | ${savedNote}`);
    await admin.getByRole("radio", { name: "Reply to client" }).click();
    state.changeReply = `Thanks, we will send you a price for this, ${stamp}.`;
    await admin.getByPlaceholder("Write a reply to the client…").fill(state.changeReply);
    await admin.locator("select").first().selectOption({ label: "Then: waiting on client" });
    await admin.getByRole("button", { name: "Send reply" }).click();
    await admin.waitForTimeout(2500);
    check(report, "9: the team replies and waits on the client", /Waiting on client/.test(squash(await main(admin))));
    save();
  }

  if (stages.includes(10)) {
    // ---- 10. The client sees the reply and the status, never the team's working label or the note about it.
    const owner = await as("harbor:owner");
    await open(owner, `/support/${state.changeId}`);
    await owner.waitForFunction(() => /Change request/.test(document.querySelector("main")?.innerText ?? ""), null, { timeout: 60_000 }).catch(() => {});
    const t = squash(await main(owner));
    report.notes.push("client sees change: " + t.slice(0, 900));
    check(report, "10: the client reads the reply", t.includes(state.changeReply), t.slice(0, 300));
    check(report, "10: the client sees it is waiting on them", /Waiting on you|Waiting on client|waiting/i.test(t));
    check(report, "10: the client never reads the team's classification or the note about it", !t.includes(state.classNote) && !/Needs a quote/.test(t.replace(/needs a quote first/gi, "")), t.slice(0, 200));
    const html = await (await owner.request.get(`${BASE}/support/${state.changeId}`)).text();
    check(report, "10: nor is the note in the page's data", !html.includes(state.classNote) && !html.includes("Needs voice-agent rework"));
    const list = await (await owner.request.get(`${BASE}/support/requests`)).text();
    check(report, "10: nor in the list of requests", !list.includes(state.classNote));
    await shot(owner, report, "req-change-client-final");
    // The client answers the team in the same thread.
    const box = owner.getByRole("textbox").last();
    state.clientReply = `Yes please send the price ${stamp}`;
    await box.fill(state.clientReply);
    await owner.getByRole("button", { name: /Send/ }).last().click();
    await owner.waitForTimeout(2500);
    check(report, "10: the client's answer is added to the thread", (await main(owner)).includes(state.clientReply));
    const m = await metrics(owner);
    check(report, "10: no horizontal overflow at 1280", !m.overflow, JSON.stringify(m));
    await owner.setViewportSize({ width: 375, height: 812 });
    await open(owner, `/support/${state.changeId}`);
    const pm = await metrics(owner);
    check(report, "10: no horizontal overflow at 375", !pm.overflow, JSON.stringify(pm));
    await shot(owner, report, "req-change-client-375");
  }

  if (stages.includes(11)) {
    // ---- 11. Issue reports, feedback, attachments, reopening and notifications.
    const owner = await as("harbor:owner");
    const admin = await as("agency:super");
    const note = "Staff-only: customer account looks risky " + stamp;
    // An issue report with an urgency, steps and a file.
    await open(owner, "/support/report-issue");
    state.issueSubject = `QA ${stamp}: contacts page never finishes loading`;
    await owner.getByPlaceholder("For example: The contacts page never finishes loading").fill(state.issueSubject);
    await owner.getByPlaceholder("Tell us what happened…").fill("The contacts page spins forever since this morning. QA data.");
    await owner.getByPlaceholder("For example: I expected to see my list of contacts.").fill("A list of contacts.");
    await owner.getByPlaceholder(/Open Contacts/).fill("1. Open Contacts\n2. Wait");
    await owner.getByRole("radio", { name: /Needs attention soon/ }).click();
    const file = path.join(OUT, "qa-attachment.txt");
    fs.writeFileSync(file, `Attachment for the issue report ${stamp}\n`);
    await owner.locator("input[type=file]").setInputFiles(file);
    await owner.waitForTimeout(2500);
    await shot(owner, report, "req-issue-form");
    await owner.getByRole("button", { name: /^Send (report|issue)|Send report/i }).first().click().catch(async () => { await owner.locator("form button[type=submit]").last().click(); });
    await owner.getByText(/has been sent|Your report|received/i).first().waitFor({ timeout: 60_000 });
    const sent = squash(await main(owner));
    check(report, "11: the issue report is sent with a reference", /[A-Z]{2,4}-\d{3,}/.test(sent), sent.slice(0, 300));
    await owner.getByRole("link", { name: /View your (request|report)/i }).first().click();
    await owner.waitForURL(/\/support\/[0-9a-f-]{36}/, { timeout: 60_000 });
    state.issueId = /\/support\/([0-9a-f-]{36})/.exec(owner.url())[1];
    await owner.waitForFunction(() => /qa-attachment/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
    const issueText = squash(await main(owner));
    check(report, "11: the client sees the report as an issue report with its file attached", /Issue report/.test(issueText) && /qa-attachment\.txt/.test(issueText), issueText.slice(0, 400));
    save();
    // Feedback.
    await open(owner, "/support/feedback");
    state.feedbackSubject = `QA ${stamp}: tag messages in the inbox`;
    await owner.getByPlaceholder("For example: Let me tag messages in the inbox").fill(state.feedbackSubject);
    await owner.getByPlaceholder("Share your idea or thoughts…").fill("It would help to tag messages. QA data.");
    await owner.getByRole("button", { name: "Send feedback" }).click();
    await owner.getByText(/Thank you|has been sent|received/i).first().waitFor({ timeout: 60_000 });
    check(report, "11: feedback is sent and thanked", true);
    // The list tells the three kinds apart and filters by type.
    await open(owner, "/support/requests");
    const list = squash(await main(owner));
    check(report, "11: the list shows the issue report and the feedback among the requests", list.includes(state.issueSubject) && list.includes(state.feedbackSubject), list.slice(0, 300));
    await owner.locator("select").filter({ hasText: "All types" }).first().selectOption({ label: "Issue reports" });
    await owner.waitForTimeout(1200);
    const filtered = squash(await main(owner));
    check(report, "11: filtering by Issue reports leaves the report and hides the feedback", filtered.includes(state.issueSubject) && !filtered.includes(state.feedbackSubject), filtered.slice(0, 300));
    // The team sees the file and can open it; another workspace cannot.
    await open(admin, `/admin/support/${state.issueId}`);
    const staffIssue = squash(await main(admin));
    check(report, "11: the team sees the report with the file and the urgency", /qa-attachment\.txt/.test(staffIssue) && /soon|urgent|High/i.test(staffIssue), staffIssue.slice(0, 400));
    const href = await admin.locator("main a[href*='/api/files/'], main a[href*='/api/support/']").first().getAttribute("href").catch(() => null);
    report.notes.push("attachment link: " + href);
    if (href) {
      // The download answers with a redirect to the file; in the dev server that address names "localhost" rather than 127.0.0.1, so a cookie jar would not follow it. Follow it by path.
      const hop = await admin.request.get(href.startsWith("http") ? href : `${BASE}${href}`, { maxRedirects: 0 });
      const filePath = new URL(hop.headers()["location"] ?? "/", BASE).pathname;
      check(report, "11: the download hands over a file address in the same app, not a link to somewhere else", hop.status() === 307 && filePath.startsWith("/api/files/"), `${hop.status()} ${hop.headers()["location"]}`);
      const got = await admin.request.get(`${BASE}${filePath}`);
      check(report, "11: the team can open the attached file, and it is the file that was sent", got.status() === 200 && (await got.text()).includes(`Attachment for the issue report ${stamp}`), `status ${got.status()}`);
      const other = await as("other:owner");
      const denied = await other.request.get(href.startsWith("http") ? href : `${BASE}${href}`);
      check(report, "11: another workspace cannot open that file", denied.status() === 401 || denied.status() === 403 || denied.status() === 404, `status ${denied.status()}`);
      const viewer = await as("harbor:viewer");
      const viewerGot = await viewer.request.get(href.startsWith("http") ? href : `${BASE}${href}`);
      report.notes.push(`viewer opening the file: ${viewerGot.status()}`);
    }
    // Reopening: the client writes again on a resolved request; it is open again and the team sees it was reopened.
    await open(owner, `/support/${state.ticketId}`);
    const reply = owner.locator("#request-reply");
    state.reopenText = `Actually it broke again ${stamp}`;
    await reply.fill(state.reopenText);
    await owner.getByRole("button", { name: /Reopen and send/ }).click();
    await owner.waitForTimeout(3000);
    await open(admin, `/admin/support/${state.ticketId}`);
    const reopened = squash(await main(admin));
    check(report, "11: replying to a resolved request reopens it and the team sees what was said", reopened.includes(state.reopenText) && !/Priority\s+Resolved/.test(reopened.slice(0, 120)) && !/^Requests IAQ-\d+ \w+ priority Resolved/.test(reopened), reopened.slice(0, 200));
    // Notifications: the bell tells the client about the team's replies and never carries private words.
    await open(owner, "/overview");
    await owner.getByRole("button", { name: /Notifications/i }).first().click().catch(() => {});
    await owner.waitForTimeout(1500);
    const bell = squash(await owner.evaluate(() => document.body.innerText));
    check(report, "11: the client's notifications never carry the team's private note", !bell.includes(state.note ?? "RUBYFLINT") && !/Customer sounded confused/.test(bell));
    await shot(owner, report, "req-notifications");
    save();
  }
} catch (e) {
  check(report, "scenario ran to the end", false, String(e).slice(0, 500));
} finally {
  save();
  await browser.close();
  finish(report, "requests");
}
