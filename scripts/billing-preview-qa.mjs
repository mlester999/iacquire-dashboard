// Drives the development-only billing preview in a real browser (Chromium through Playwright): the optional maintenance plan and its PayPal agreement states, the admin
// subscription screen, credit notes, and the staff-access policy card. The preview renders SAMPLE data (src/app/dev/billing-preview/page.tsx) and reaches no database and
// no provider, so this pass answers one question: does the screen a person will see look and behave right at a phone and a desktop width, in both themes?
//
//   node scripts/billing-preview-qa.mjs [--widths 375,1280] [--themes light,dark] [--shots]
//
// It needs the isolated QA app on 127.0.0.1:3270 (node scripts/inbox-qa.mjs) because the preview is a route of that app. Nothing is signed in: the preview is public in
// development, and the production block plus the page's own guard are proved by tests/dev-routes-production.test.ts, not here.
import { axe, check, finish, launch, metrics, newReport, open, shot, watch } from "./qa-harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);
const widths = flag("widths", "375,1280").split(",").map(Number);
const themes = flag("themes", "light,dark").split(",");
const SHOTS = has("shots");

const VIEWS = [
  { name: "maintenance-offer", route: "/dev/billing-preview?view=maintenance&agreement=none" },
  { name: "maintenance-approval", route: "/dev/billing-preview?view=maintenance&agreement=approval" },
  { name: "maintenance-active", route: "/dev/billing-preview?view=maintenance&agreement=active" },
  { name: "maintenance-suspended", route: "/dev/billing-preview?view=maintenance&agreement=suspended" },
  { name: "maintenance-held", route: "/dev/billing-preview?view=maintenance&agreement=held" },
  { name: "maintenance-ended", route: "/dev/billing-preview?view=maintenance&agreement=ended" },
  { name: "admin-maintenance", route: "/dev/billing-preview?view=admin-maintenance&agreement=active" },
  { name: "admin-maintenance-held", route: "/dev/billing-preview?view=admin-maintenance&agreement=held" },
  { name: "credit-notes-owner", route: "/dev/billing-preview?view=credit-notes&as=owner" },
  { name: "credit-notes-manager", route: "/dev/billing-preview?view=credit-notes&as=manager" },
  { name: "credit-notes-blocked", route: "/dev/billing-preview?view=credit-notes&as=manager&blocked=1" },
  { name: "policy-off", route: "/dev/billing-preview?view=policy&policy=off" },
  { name: "policy-on", route: "/dev/billing-preview?view=policy&policy=on" },
  { name: "reviews-withheld", route: "/dev/billing-preview?view=reviews" },
  { name: "reviews-withheld-many", route: "/dev/billing-preview?view=reviews&blocked=1" },
];

const browser = await launch();
const report = newReport();
const rows = [];

for (const theme of themes) {
  for (const width of widths) {
    const viewport = { width, height: width < 600 ? 812 : 900 };
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", colorScheme: theme });
    await context.addInitScript((th) => { try { localStorage.setItem("iaq-theme", th); localStorage.setItem("iaq-tour-v1", "done"); } catch { /* blocked */ } }, theme);
    const page = await context.newPage();
    watch(page, report, `preview ${width} ${theme}`);

    for (const view of VIEWS) {
      const label = `${view.name} ${width}px ${theme}`;
      await open(page, view.route);
      const m = await metrics(page);
      const violations = await axe(page);
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      const smallest = await page.evaluate(() => {
        let min = Infinity;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n.textContent.trim();
          if (!t) continue;
          const el = n.parentElement;
          if (!el || el.closest("script, style, nextjs-portal, [aria-hidden=true], .sr-only")) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          min = Math.min(min, parseFloat(cs.fontSize));
        }
        return Number.isFinite(min) ? min : null;
      });
      const row = { ...view, width, theme, path: m.path, overflow: m.overflow, clipped: m.clipped, cut: m.cut, smallText: smallest, axe: bad };
      rows.push(row);
      check(report, `${label}: no sideways overflow`, !m.overflow, JSON.stringify(m.clipped).slice(0, 200));
      check(report, `${label}: no serious or critical axe violation`, bad.length === 0, bad.map((v) => `${v.id} (${v.target})`).join("; "));
      check(report, `${label}: no text under 12px`, smallest === null || smallest >= 12, `smallest ${smallest}px`);
      check(report, `${label}: says it is a development preview with sample data`, await page.locator("text=Sample data only").count() > 0);
      if (SHOTS) await shot(page, report, `billing-preview-${view.name}-${width}-${theme}`);
    }

    // The screens' own behaviour, driven once per width and theme rather than per state.
    await open(page, "/dev/billing-preview?view=credit-notes&as=manager");
    const create = page.getByRole("button", { name: /new credit note|credit note/i }).first();
    if (await create.count()) {
      await create.click();
      const dialog = page.getByRole("dialog");
      const opened = await dialog.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
      check(report, `credit note dialog opens ${width}px ${theme}`, opened);
      if (opened) {
        check(report, `credit note dialog asks for an amount and a reason ${width}px ${theme}`, (await dialog.locator("input, textarea").count()) >= 2);
        check(report, `credit note dialog has an accessible name ${width}px ${theme}`, Boolean(await dialog.getAttribute("aria-label") || await dialog.getAttribute("aria-labelledby")));
        await page.keyboard.press("Escape");
        check(report, `credit note dialog closes on Escape ${width}px ${theme}`, await dialog.waitFor({ state: "hidden", timeout: 10_000 }).then(() => true, () => false));
      }
    }

    await open(page, "/dev/billing-preview?view=policy&policy=off");
    const changeButton = page.getByRole("button", { name: /require a support session/i }).first();
    if (await changeButton.count()) {
      check(report, `policy: the change is refused without a reason ${width}px ${theme}`, await changeButton.isDisabled());
      const field = page.locator("#content-policy-note");
      await field.fill("Counsel asked for the stricter rule.");
      check(report, `policy: a written reason enables the change ${width}px ${theme}`, await changeButton.isEnabled());
      check(report, `policy: the card says the decision is the founder's ${width}px ${theme}`, await page.locator("text=founder").count() > 0);
    }

    await context.close();
  }
}

await browser.close();
report.rows = rows;
finish(report, "billing-preview-qa");
