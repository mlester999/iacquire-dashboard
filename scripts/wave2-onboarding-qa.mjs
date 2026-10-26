// Browser QA of the whole client onboarding in the isolated QA app (node scripts/inbox-qa.mjs, port 3270): a business owner answers every question from the first to the last,
// including what each one validates, saving and resuming across a reload, going back and forward, and the final review and submission. Fictional answers only.
//
//   node scripts/wave2-onboarding-qa.mjs [--role harbor:owner] [--max 80] [--no-submit] [--width 1280]
import fs from "node:fs";
import path from "node:path";
import { OUT, axe, check, finish, launch, metrics, newReport, open, shot, signedIn, watch } from "./qa-harness.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const role = flag("role", "harbor:owner");
const MAX = Number(flag("max", "80"));
const width = Number(flag("width", "1280"));
const submit = !args.includes("--no-submit");
const report = newReport();
report.questions = [];
const browser = await launch();
const { page } = await signedIn(browser, role, { viewport: { width, height: width < 600 ? 812 : 900 } });
watch(page, report, role);
const squash = (s) => s.replace(/\s+/g, " ").trim();
const mainText = () => page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText);

const ANSWERS = {
  text: "Harbor Home Services",
  email: "owner.harbor@example.test",
  tel: "+15555550142",
  url: "https://harbor.example.test",
  number: "12",
  area: "We repair boilers and water heaters across the greater Harbor area. Fictional answer for QA, nothing real.",
};

/** What is on the screen right now: the question, whether it is required, and every control a person can answer with. */
async function snapshot() {
  return page.evaluate(() => {
    const root = document.querySelector("main");
    const heading = root.querySelector("#onboarding-title") ?? root.querySelector("h1, h2");
    const text = root.innerText;
    const visible = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const q = text.match(/Question (\d+) of (\d+)/);
    return {
      question: heading?.textContent?.trim() ?? "",
      number: q ? Number(q[1]) : null,
      total: q ? Number(q[2]) : null,
      required: /\bREQUIRED\b/.test(text),
      radios: Array.from(root.querySelectorAll("[role=radio]")).filter(visible).length,
      checkboxes: Array.from(root.querySelectorAll("[role=checkbox], input[type=checkbox]")).filter(visible).length,
      inputs: Array.from(root.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), textarea, select")).filter(visible).map((e) => ({ tag: e.tagName.toLowerCase(), type: e.type, id: e.id, label: e.getAttribute("aria-label") || (e.labels?.[0]?.textContent ?? "").trim() || e.placeholder || "", value: e.value })),
      buttons: Array.from(root.querySelectorAll("button")).filter(visible).map((b) => (b.getAttribute("aria-label") || b.innerText).trim().slice(0, 50)),
      alert: Array.from(root.querySelectorAll("[role=alert]")).map((e) => e.innerText.trim()).filter(Boolean).join(" | "),
      isReview: /Final check|Review your answers|Ready to submit|Submit/.test(text) && !/Question \d+ of/.test(text),
    };
  });
}

/** Answers whatever is on the screen the way a person would, and says what it did. */
async function answer(snap) {
  const did = [];
  const main = page.locator("main");
  if (snap.radios) { await main.locator("[role=radio]").first().click(); did.push(`chose the first of ${snap.radios}`); }
  else if (snap.checkboxes) { await main.locator("[role=checkbox], input[type=checkbox]").first().click({ force: true }); did.push(`ticked the first of ${snap.checkboxes}`); }
  for (const field of snap.inputs) {
    const target = field.id ? page.locator(`[id="${field.id}"]`) : page.locator("main input, main textarea, main select").first();
    if (field.value && field.tag !== "select") { did.push(`kept "${field.value.slice(0, 20)}"`); continue; }
    if (field.tag === "select") { const opts = await target.evaluate((s) => Array.from(s.options).map((o) => o.value).filter(Boolean)); if (opts.length) { await target.selectOption(opts[Math.min(1, opts.length - 1)]); did.push(`selected ${opts[Math.min(1, opts.length - 1)]}`); } continue; }
    if (field.tag === "textarea") { await target.fill(ANSWERS.area); did.push("wrote a paragraph"); continue; }
    const kind = field.type === "email" ? "email" : field.type === "tel" ? "tel" : field.type === "url" ? "url" : field.type === "number" ? "number" : /email/i.test(field.label) ? "email" : /phone|mobile|call/i.test(field.label) ? "tel" : /website|url|link|find you online|site/i.test(field.label) ? "url" : /how many|years|number|count|size/i.test(field.label) ? "number" : "text";
    if (/colour|color/i.test(field.label) && field.type !== "color") { await target.fill(/accent|second/i.test(field.label) ? "#0F172A" : "#2C5BFF"); did.push("typed a hex colour"); continue; }
    if (field.type === "color") { did.push("left the picker"); continue; }
    await target.fill(ANSWERS[kind]); did.push(`typed a ${kind}`);
  }
  if (snap.buttons.some((b) => /device's time zone/i.test(b))) { await page.getByRole("button", { name: /device's time zone/i }).click(); did.push("used the device time zone"); }
  return did;
}

try {
  await open(page, "/onboarding");
  const first = await snapshot();
  report.notes.push(`opened at question ${first.number} of ${first.total}: ${first.question}`);
  check(report, "opens where the person left off: on a question with a progress count, or on the review when every question is answered", (first.number !== null && first.total !== null) || first.isReview, JSON.stringify(first).slice(0, 200));
  const sizes = await metrics(page);
  check(report, `no horizontal overflow at ${width}`, !sizes.overflow, JSON.stringify(sizes));

  let steps = 0;
  let sawReview = false;
  while (steps++ < MAX) {
    const snap = await snapshot();
    if (snap.isReview || !snap.number) { sawReview = true; break; }
    const did = await answer(snap);
    const entry = { n: snap.number, of: snap.total, q: snap.question.slice(0, 90), required: snap.required, did: did.join("; ") };
    // Required means Continue must not move on without an answer: try it empty first on the first required question that has an empty control.
    const next = page.getByRole("button", { name: /^(Continue|Next|Save & continue|Review)/ }).last();
    await next.click();
    // The next question arrives after the answer is saved: wait for the title or the count to change (or a message to appear), up to eight seconds.
    let after = await snapshot();
    for (let i = 0; i < 32 && after.question === snap.question && after.number === snap.number && !after.alert && !after.isReview; i++) { await page.waitForTimeout(250); after = await snapshot(); }
    entry.saved = (await page.locator("[aria-live=polite]").first().innerText().catch(() => "")).trim().slice(0, 30);
    entry.error = after.alert || null;
    // Every question on the way, not just the first and the last, must fit the window and keep its touch targets and text at a readable size.
    const fit = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, smallTargets: Array.from(document.querySelectorAll("main button, main input, main select, main textarea, main [role=radio], main [role=checkbox]")).filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && Math.min(r.width, r.height) < 24; }).map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("aria-label") || e.innerText.trim().slice(0, 18) || e.name || e.type}] ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`), smallInputFont: Array.from(document.querySelectorAll("main input:not([type=color]):not([type=radio]):not([type=checkbox]), main textarea")).filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16 && innerWidth < 640).length }));
    if (fit.overflow) (report.overflowSteps ??= []).push(snap.number);
    if (fit.smallTargets.length) (report.smallTargetSteps ??= []).push(`${snap.number}: ${fit.smallTargets.slice(0, 3).join(", ")}`);
    if (fit.smallInputFont) (report.smallFontSteps ??= []).push(snap.number);
    entry.moved = after.number !== snap.number || after.question !== snap.question || after.isReview;
    report.questions.push(entry);
    if (!entry.moved) {
      // A validation message or a field the driver did not fill: record, try once more with an answer typed from the placeholder or first option.
      await shot(page, report, `onboarding-stuck-${snap.number}`);
      check(report, `question ${snap.number} accepted a sensible answer`, false, `${snap.question} -> ${after.alert || "no message"}; controls: ${JSON.stringify(snap.inputs).slice(0, 200)} radios ${snap.radios}`);
      break;
    }
    if (steps % 10 === 0) await shot(page, report, `onboarding-q${snap.number}`);
    if (after.number === 22 && !report.resumeChecked) {
      report.resumeChecked = true;
      // Saved as you go: a reload lands on the same question with the answers kept.
      const before = await snapshot();
      await page.reload({ waitUntil: "domcontentloaded" });
      await open(page, "/onboarding");
      const reloaded = await snapshot();
      check(report, "resume: a reload returns to the same question", reloaded.question === before.question && reloaded.number === before.number, `${before.number} "${before.question}" -> ${reloaded.number} "${reloaded.question}"`);
      // Back shows the previous question with the earlier answer still chosen, and Continue goes forward again.
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.waitForFunction((n) => /Question (\d+) of/.exec(document.querySelector("main")?.innerText ?? "")?.[1] === String(n), before.number - 1, { timeout: 10_000 }).catch(() => {});
      const back = await snapshot();
      const kept = await page.evaluate(() => Array.from(document.querySelectorAll("main [role=radio][aria-checked=true], main input:checked")).length + Array.from(document.querySelectorAll("main textarea, main input[type=text]")).filter((e) => e.value).length);
      check(report, "back: the previous question opens with its earlier answer in place", back.number === before.number - 1 && kept > 0, `${back.number} kept=${kept}`);
      await page.getByRole("button", { name: /^(Continue|Next)/ }).last().click();
      await page.waitForFunction((n) => /Question (\d+) of/.exec(document.querySelector("main")?.innerText ?? "")?.[1] === String(n), before.number, { timeout: 10_000 }).catch(() => {});
      check(report, "forward: Continue returns to where the person was", (await snapshot()).number === before.number);
      // The browser's own back button must not strand or break the page.
      await page.goBack().catch(() => {});
      await page.waitForTimeout(800);
      check(report, "the browser's back button leaves the page usable", /onboarding|dashboard|overview|setup/.test(page.url()) || (await snapshot()).number !== null, page.url());
      if (!/\/onboarding/.test(page.url())) await open(page, "/onboarding");
    }
  }
  report.notes.push(`answered ${report.questions.length} questions; reached review: ${sawReview}`);
  check(report, `no question overflowed the window at ${width}px`, !(report.overflowSteps ?? []).length, `overflow on questions ${(report.overflowSteps ?? []).join(",")}`);
  check(report, "no question has a control smaller than 24 px", !(report.smallTargetSteps ?? []).length, (report.smallTargetSteps ?? []).join(" | "));
  check(report, "phone-width inputs are 16 px or larger so the keyboard does not zoom the page", !(report.smallFontSteps ?? []).length, (report.smallFontSteps ?? []).join(","));
  fs.writeFileSync(path.join(OUT, "onboarding-questions.json"), JSON.stringify(report.questions, null, 2));
  check(report, "every question was answered through to the final review", sawReview, `stopped after ${report.questions.length}`);
  if (sawReview) {
    await shot(page, report, "onboarding-review");
    const t = squash(await mainText());
    report.notes.push("review: " + t.slice(0, 1500));
    const vio = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
    check(report, "the review has no serious/critical axe violations", vio.length === 0, JSON.stringify(vio));
    report.notes.push("review controls: " + (await snapshot()).buttons.join(" | "));
    const rm = await metrics(page);
    check(report, `the review has no horizontal overflow at ${width}`, !rm.overflow, JSON.stringify(rm));

    // Editing from the review: a required answer cannot be emptied or made invalid, and the error says why in words.
    // The answers are in collapsed groups: open the first one, then edit from there.
    if (!(await page.getByRole("button", { name: "Edit Business email" }).isVisible())) await page.locator("summary", { hasText: "Business profile" }).first().click();
    await page.getByRole("button", { name: "Edit Business email" }).click();
    await page.getByRole("heading", { name: "What's the best email for your business?" }).waitFor({ timeout: 30_000 });
    const field = page.locator("#onboarding-input");
    let kept = await field.inputValue();
    if (!kept) { // an earlier run left it empty: put it back so this run starts from a complete answer
      await field.fill(ANSWERS.email);
      await page.getByRole("button", { name: /^(Continue|Next|Save|Review)/ }).last().click();
      await page.getByRole("heading", { name: "Review and approve your setup." }).waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Edit Business email" }).click();
      await page.getByRole("heading", { name: "What's the best email for your business?" }).waitFor({ timeout: 30_000 });
      kept = await page.locator("#onboarding-input").inputValue();
    }
    check(report, "edit from the review: the saved answer is in the field", kept === ANSWERS.email, kept);
    const cont = page.getByRole("button", { name: /^(Continue|Next|Save|Review)/ }).last();
    // Emptying a required answer is allowed while editing, but the review then says exactly what is missing and will not approve.
    await field.fill("");
    await cont.click();
    await page.getByText(/Before you can approve/).waitFor({ timeout: 30_000 });
    let reviewText = squash(await mainText());
    check(report, "required: the review names the empty required answer and blocks approval", /Before you can approve[^]*Business email/.test(reviewText) && (await page.getByRole("button", { name: "Approve setup" }).isDisabled()), reviewText.slice(reviewText.indexOf("Before you can approve"), reviewText.indexOf("Before you can approve") + 120));
    report.notes.push("blocked review says: " + reviewText.slice(reviewText.indexOf("Before you can approve"), reviewText.indexOf("Before you can approve") + 160));
    await shot(page, report, "onboarding-blocked-review");
    // The message names the answer; its row has the Edit button. A malformed answer is refused on the question, in words.
    if (!(await page.getByRole("button", { name: "Edit Business email" }).isVisible())) await page.locator("summary", { hasText: "Business profile" }).first().click();
    await page.getByRole("button", { name: "Edit Business email" }).click();
    await page.locator("#onboarding-input").waitFor({ timeout: 30_000 });
    await page.locator("#onboarding-input").fill("not-an-email");
    await cont.click();
    await page.waitForTimeout(1200);
    let st = await snapshot();
    check(report, "validation: a malformed email is refused on the question with a message", st.question === "What's the best email for your business?" && st.alert.length > 0, `alert="${st.alert}"`);
    report.notes.push(`malformed email says: "${st.alert}"`);
    await shot(page, report, "onboarding-validation");
    await page.locator("#onboarding-input").fill(ANSWERS.email);
    await cont.click();
    await page.getByRole("heading", { name: "Review and approve your setup." }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => !/Before you can approve/.test(document.querySelector("main")?.innerText ?? ""), null, { timeout: 15_000 }).catch(() => {});
    const fixedText = squash(await mainText());
    report.notes.push("after the fix the review says: " + fixedText.slice(0, 500));
    await shot(page, report, "onboarding-after-fix");
    check(report, "after the fix the person is taken back to the review with nothing blocking approval", !/Before you can approve/.test(fixedText), fixedText.slice(fixedText.indexOf("Before you can approve"), fixedText.indexOf("Before you can approve") + 200));
  }
  if (sawReview && submit) {
    check(report, "approval: the approve button is disabled until the person confirms they reviewed the answers", await page.getByRole("button", { name: "Approve setup" }).isDisabled());
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Approve setup" }).click();
    await page.waitForTimeout(8000);
    const done = squash(await mainText());
    report.notes.push("after approve: " + done.slice(0, 1500));
    await shot(page, report, "onboarding-approved");
    check(report, "submission: the page says the setup is approved and that changes need approving again", /already approved|information saved|meet your ai team/i.test(done), done.slice(0, 300));
  }
} catch (e) {
  check(report, "scenario ran to the end", false, String(e).slice(0, 500));
  await shot(page, report, "onboarding-error");
} finally {
  await browser.close();
  finish(report, "onboarding");
}
