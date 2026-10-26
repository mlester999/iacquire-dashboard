// Browser sweep of the AI employee screens the workforce work changed (one shared readiness definition, the eight states, role prerequisites, the tool-policy and probe wording), in the
// isolated QA app, signed in as the people who see them: a workspace owner and manager on the client's own employee pages, and the Super Admin on the agency's employee, client-employee,
// policy and review pages and on a client's detail. Per page, at 375 and 1280 px in light and dark: console and page errors, requests that left the QA origin, a sideways-scrolling
// document or clipped content, axe-core serious and critical violations, the smallest text (the 12px floor), a heading, and the words the screen uses for readiness. It reads; it
// clicks nothing that writes. Nothing is sent and no provider is contacted.
//
//   node scripts/run-inbox-qa-seed.mjs && node scripts/run-demo-qa-seed.mjs        (once, with the QA app stopped)
//   $env:CRM_QA_DEMO = "1"; node scripts/inbox-qa.mjs                              (the app, port 3270)
//   node scripts/wave3-employee-readiness-qa.mjs [--shots]
import { axe, check, finish, launch, metrics, newReport, open, shot, signedIn, watch } from "./qa-harness.mjs";

const SHOTS = process.argv.includes("--shots");
const report = newReport();
const browser = await launch();
const WIDTHS = [375, 1280];
const THEMES = ["light", "dark"];
const squash = (s) => s.replace(/\s+/g, " ").trim();

const smallestText = (page) => page.evaluate(() => {
  let min = Infinity;
  let where = "";
  const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || el.closest("[aria-hidden=true], .sr-only, script, style")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const px = parseFloat(cs.fontSize);
    if (px < min) { min = px; where = t.slice(0, 40); }
  }
  return { min, where };
});

/** Anything inside a radio-style choice card (the operating-mode picker) that sits outside the card's own box: a pill spilling into its neighbour is invisible to axe and to the page-edge overflow check. */
const cardSpills = (page) => page.evaluate(() => {
  const out = [];
  for (const card of document.querySelectorAll('main [role="radio"]')) {
    const box = card.getBoundingClientRect();
    for (const el of card.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${(el.textContent ?? "").trim().slice(0, 24) || el.tagName} [${Math.round(r.left)}-${Math.round(r.right)}] outside card [${Math.round(box.left)}-${Math.round(box.right)}]`);
    }
  }
  return out.slice(0, 5);
});

/** Links on a page that point at a detail page of this section, to visit each of them once. */
const detailLinks = (page, base) => page.evaluate((b) => {
  const found = new Set();
  for (const a of document.querySelectorAll("main a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith(b + "/") && !href.includes("?") && !href.slice(b.length + 1).includes("/")) found.add(href);
  }
  return [...found];
}, base);

const PLAN = [
  { who: "harbor:owner", base: "/employees", list: "/employees", exclude: [] },
  { who: "harbor:manager", base: "/employees", list: "/employees", exclude: [] },
  { who: "agency:super", base: "/admin/employees", list: "/admin/employees", exclude: ["/admin/employees/clients", "/admin/employees/policies", "/admin/employees/reviews", "/admin/employees/open"], extra: ["/admin/employees/clients", "/admin/employees/policies", "/admin/employees/reviews", "/admin/clients"] },
];

try {
  // Discover the detail pages once, as the owner and as the Super Admin, at the desktop width.
  const routesFor = {};
  for (const item of PLAN) {
    const { page } = await signedIn(browser, item.who);
    watch(page, report, `discover ${item.who}`);
    await open(page, item.list);
    const links = (await detailLinks(page, item.base)).filter((l) => !item.exclude.includes(l));
    const routes = [item.list, ...links, ...(item.extra ?? [])];
    if (item.who === "agency:super") {
      await open(page, "/admin/clients");
      const client = (await detailLinks(page, "/admin/clients"))[0];
      if (client) routes.push(client);
    }
    routesFor[item.who] = [...new Set(routes)];
    report.notes.push(`${item.who}: ${routesFor[item.who].length} pages: ${routesFor[item.who].join(", ")}`);
    check(report, `${item.who}: the employee list links to detail pages`, routesFor[item.who].length > 1, routesFor[item.who].join(", "));
    await page.context().close();
  }

  for (const item of PLAN) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const viewport = { width, height: width < 600 ? 812 : 900 };
        const { page } = await signedIn(browser, item.who, { viewport, theme });
        watch(page, report, `${item.who} ${width} ${theme}`);
        for (const route of routesFor[item.who]) {
          const label = `${item.who} ${route} ${width}px ${theme}`;
          await open(page, route);
          const text = squash(await page.evaluate(() => document.querySelector("main")?.innerText ?? ""));
          const m = await metrics(page);
          const bad = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
          const small = await smallestText(page);
          const spills = await cardSpills(page);
          check(report, `${label}: has a heading and some content`, (await page.locator("main h1, main h2").count()) > 0 && text.length > 40, text.slice(0, 120));
          check(report, `${label}: no sideways scrolling or clipped content`, !m.overflow, JSON.stringify(m.clipped ?? m));
          check(report, `${label}: no serious or critical axe violation`, bad.length === 0, JSON.stringify(bad));
          check(report, `${label}: no text under 12px`, small.min >= 12, `${small.min}px "${small.where}"`);
          check(report, `${label}: choice cards contain their own contents`, spills.length === 0, JSON.stringify(spills));
          check(report, `${label}: is not an error page`, !/something went wrong|unexpected error|Application error/i.test(text), text.slice(0, 160));
          if (width === 1280 && theme === "light") report.notes.push(`${label}: ${text.slice(0, 420)}`);
          if (SHOTS && (route === routesFor[item.who][0] || route === routesFor[item.who][1])) await shot(page, report, `employees-${item.who.replace(/\W+/g, "-")}-${route.replace(/\W+/g, "-")}-${width}-${theme}`);
        }
        await page.context().close();
      }
    }
  }
} catch (error) {
  report.pageErrors.push(`script: ${error instanceof Error ? error.stack?.slice(0, 700) : String(error)}`);
} finally {
  finish(report, "wave3-employee-readiness-qa");
  await browser.close();
}
