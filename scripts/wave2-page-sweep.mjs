// Sweeps pages in the isolated QA app (node scripts/inbox-qa.mjs, port 3270) and reports, per page x width x theme: HTTP-level errors, console and page errors, requests that left
// the QA origin, horizontal overflow, axe-core WCAG 2 A/AA violations, and the smallest text found. Optionally saves a screenshot of each page.
//
//   node scripts/wave2-page-sweep.mjs --role harbor:owner --routes /invoices,/crm/contacts --widths 1280,375 --themes light,dark [--shots] [--small-text 12]
//   node scripts/wave2-page-sweep.mjs --role agency:super --routes-file .data/wave2-qa/routes-agency.txt
// Role keys are the ones in .data/crm-qa/inbox-credentials.local.json (harbor:owner, harbor:manager, harbor:sales, harbor:support, harbor:viewer, agency:super, other:owner).
import fs from "node:fs";
import path from "node:path";
import { OUT, axe, launch, newReport, open, signedIn, watch } from "./qa-harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);
const role = flag("role", "harbor:owner");
const routes = flag("routes-file") ? fs.readFileSync(flag("routes-file"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : flag("routes", "/").split(",");
const widths = flag("widths", "1280,375").split(",").map(Number);
const themes = flag("themes", "light").split(",");
const smallText = Number(flag("small-text", "12"));
const label = flag("label", role.replace(/\W+/g, "-"));

const browser = await launch();
const rows = [];
const report = newReport();
for (const theme of themes) {
  for (const width of widths) {
    const { context, page } = await signedIn(browser, role, { viewport: { width, height: width < 600 ? 812 : 900 }, theme });
    watch(page, report, `${role} ${width} ${theme}`);
    for (const route of routes) {
      const before = { c: report.consoleErrors.length, p: report.pageErrors.length, s: report.serverErrors.length, e: report.external.length };
      let status = 0;
      page.once("response", (r) => { status = r.status(); });
      try {
        await open(page, route);
        const m = await page.evaluate((min) => {
          const out = { path: location.pathname, title: document.title, overflow: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, small: [] };
          const seen = new Map();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.textContent.trim();
            if (!t) continue;
            const el = n.parentElement;
            if (!el || el.closest("script, style, nextjs-portal, [aria-hidden=true], .sr-only")) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const size = parseFloat(cs.fontSize);
            if (size < min) { const k = `${size}`; seen.set(k, (seen.get(k) ?? 0) + 1); if (out.small.length < 4) out.small.push(`${size}px "${t.slice(0, 28)}"`); }
          }
          out.smallCounts = Object.fromEntries(seen);
          return out;
        }, smallText);
        const violations = await axe(page);
        const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        rows.push({ role, route, width, theme, status, path: m.path, overflow: m.overflow, scrollWidth: m.scrollWidth, axeSeriousOrCritical: bad, axeOther: violations.filter((v) => !bad.includes(v)).map((v) => v.id), smallText: m.smallCounts, smallSamples: m.small,
          consoleErrors: report.consoleErrors.length - before.c, pageErrors: report.pageErrors.length - before.p, serverErrors: report.serverErrors.length - before.s, external: report.external.length - before.e });
        if (has("shots")) await page.screenshot({ path: path.join(OUT, `${label}-${route.replace(/[^\w]+/g, "_")}-${width}-${theme}.png`), fullPage: true }).catch(() => {});
        const flags = [m.overflow && "OVERFLOW", bad.length && `AXE(${bad.map((v) => v.id).join(",")})`, (report.pageErrors.length - before.p) && "PAGEERR", (report.serverErrors.length - before.s) && "5XX", (report.consoleErrors.length - before.c) && "CONSOLE", Object.keys(m.smallCounts).length && `SMALL(${Object.entries(m.smallCounts).map(([k, v]) => `${k}px×${v}`).join(" ")})`].filter(Boolean);
        console.log(`${flags.length ? "!!" : "ok"}  ${role} ${width}px ${theme}  ${route}${m.path !== route.split("?")[0] ? ` -> ${m.path}` : ""}  ${flags.join(" ")}`);
      } catch (e) {
        rows.push({ role, route, width, theme, error: String(e).slice(0, 200) });
        console.log(`!!  ${role} ${width}px ${theme}  ${route}  ERROR ${String(e).slice(0, 120)}`);
      }
    }
    await context.close();
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, `sweep-${label}.json`), JSON.stringify({ rows, consoleErrors: report.consoleErrors, pageErrors: report.pageErrors, serverErrors: report.serverErrors, external: report.external }, null, 2));
console.log(`\n${rows.length} page views. console errors ${report.consoleErrors.length}, page errors ${report.pageErrors.length}, 5xx ${report.serverErrors.length}, external requests ${report.external.length}`);
for (const e of [...report.pageErrors, ...report.serverErrors, ...report.consoleErrors, ...report.external].slice(0, 10)) console.log("  ! " + e);
