// Mobile QA of the two screens a prospect actually lands on from the marketing site: /demo (the request form) and the emailed /demo/verify page, plus the room it opens.
// The desktop pass is scripts/wave2-demo-qa.mjs; this one runs the same entry journey at 375 x 812. The QA server must already be running with CRM_QA_DEMO=1 and the Super Admin's
// demo settings on (that script does both). It talks to the QA app only; the email is the capturing outbox at /dev/mailbox, and no provider is contacted.
import { BASE, axe, check, finish, launch, metrics, newReport, publicPage, shot, watch } from "./qa-harness.mjs";

const MOBILE = { width: 375, height: 812 };
const report = newReport();
const browser = await launch();

const squash = (s) => s.replace(/\s+/g, " ").trim();
const body = (page) => page.textContent("body").then((t) => t ?? "");

async function mailboxLink(to) {
  const { context, page } = await publicPage(browser);
  try {
    await page.goto(`${BASE}/dev/mailbox`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((t) => document.body.textContent.includes(t), to, { timeout: 60_000 }).catch(() => {});
    return await page.evaluate((email) => {
      const li = Array.from(document.querySelectorAll("li")).find((x) => x.textContent.includes(email) && x.textContent.includes("demo"));
      const doc = new DOMParser().parseFromString(li?.querySelector("iframe")?.getAttribute("srcdoc") ?? "", "text/html");
      return Array.from(doc.querySelectorAll("a[href]")).map((e) => e.getAttribute("href")).find((h) => /\/demo\/verify/.test(h)) ?? null;
    }, to);
  } finally {
    await context.close();
  }
}

try {
  const stamp = Date.now().toString(36);
  const email = `qa.mobile.${stamp}@work.example.test`;

  // 1. The request form at phone width.
  const { context: formContext, page: form } = await publicPage(browser, MOBILE);
  watch(form, report, "mobile-form");
  await form.goto(`${BASE}/demo`, { waitUntil: "domcontentloaded" });
  await form.waitForFunction(() => Boolean(document.querySelector("form input")), null, { timeout: 90_000 });
  const formMetrics = await metrics(form);
  check(report, "1: the request page has no horizontal overflow at 375", !formMetrics.overflow, JSON.stringify(formMetrics));
  check(report, "1: the request form and its button are visible at 375", await form.getByLabel("Your name").isVisible() && await form.getByRole("button", { name: /Email me my demo link/ }).isVisible());
  const formViolations = (await axe(form)).filter((v) => v.impact === "serious" || v.impact === "critical");
  check(report, "1: the request page has no serious/critical axe violations at 375", formViolations.length === 0, JSON.stringify(formViolations));
  await shot(form, report, "demo-mobile-form");
  await formContext.close();

  // 2. A registration through the same public API the form uses (the signed marketing door calls the same service).
  const res = await fetch(`${BASE}/api/public/demo/start`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: "Mobile Prospect", email, business: "Mobile Plumbing (QA)", industry: "home_services", consent: true }),
  });
  check(report, "2: the demo API accepts the registration", res.status === 200, `${res.status} ${(await res.text()).slice(0, 200)}`);

  // 3. The emailed link's page at phone width: it must not activate anything on GET, and its button must be usable.
  const link = await mailboxLink(email);
  check(report, "3: the captured email holds the verification link", Boolean(link), String(link));
  const url = link.startsWith("http") ? link : `${BASE}${link}`;
  const { context: verifyContext, page: verify } = await publicPage(browser, MOBILE);
  watch(verify, report, "mobile-verify");
  await verify.goto(url, { waitUntil: "domcontentloaded" });
  await verify.waitForFunction(() => /Open your demo|This link cannot be used/i.test(document.body.innerText), null, { timeout: 90_000 });
  const first = squash(await body(verify));
  check(report, "3: the confirmation page shows the entry button at 375", /Open your demo/i.test(first) && /Press the button/i.test(first), first.slice(0, 300));
  const verifyMetrics = await metrics(verify);
  check(report, "3: the confirmation page has no horizontal overflow at 375", !verifyMetrics.overflow, JSON.stringify(verifyMetrics));
  const verifyViolations = (await axe(verify)).filter((v) => v.impact === "serious" || v.impact === "critical");
  check(report, "3: the confirmation page has no serious/critical axe violations at 375", verifyViolations.length === 0, JSON.stringify(verifyViolations));
  await shot(verify, report, "demo-mobile-verify");

  // A GET leaves the link alone: opening it twice still shows the button, never a used-link message.
  await verify.reload({ waitUntil: "domcontentloaded" });
  check(report, "3: a second GET has not used the link", /Open your demo/i.test(squash(await body(verify))));

  // 4. Pressing it opens the room at phone width.
  await verify.getByRole("button", { name: /Open my demo/i }).click();
  await verify.waitForURL(/\/demo\/room/, { timeout: 90_000 }).catch(() => {});
  await verify.waitForTimeout(1500);
  const roomText = squash(await body(verify));
  check(report, "4: pressing the button opens the demo room at 375", /Welcome, Mobile/i.test(roomText) && /Your demo is open until/i.test(roomText), roomText.slice(0, 400));
  const roomMetrics = await metrics(verify);
  check(report, "4: the demo room has no horizontal overflow at 375", !roomMetrics.overflow, JSON.stringify(roomMetrics));
  const roomViolations = (await axe(verify)).filter((v) => v.impact === "serious" || v.impact === "critical");
  check(report, "4: the demo room has no serious/critical axe violations at 375", roomViolations.length === 0, JSON.stringify(roomViolations));
  await shot(verify, report, "demo-mobile-room");
  await verifyContext.close();
} catch (error) {
  check(report, "the mobile entry journey ran to the end", false, String(error).slice(0, 500));
} finally {
  await browser.close();
  finish(report, "demo-mobile");
}
