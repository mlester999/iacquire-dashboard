// Sweeps pages in the isolated QA app (node scripts/inbox-qa.mjs, port 3270) and reports, per page x width x theme: HTTP-level errors, console and page errors, requests that left
// the QA origin, horizontal overflow, axe-core WCAG 2 A/AA violations, and the smallest text found. Optionally saves a screenshot of each page.
//
//   node scripts/wave2-page-sweep.mjs --role harbor:owner --routes /invoices,/crm/contacts --widths 1280,375 --themes light,dark [--shots] [--small-text 12]
//   node scripts/wave2-page-sweep.mjs --role agency:super --routes-file .data/wave2-qa/routes-agency.txt
// Role keys are the ones in .data/crm-qa/inbox-credentials.local.json (harbor:owner, harbor:manager, harbor:sales, harbor:support, harbor:viewer, agency:super, other:owner).
import fs from "node:fs";
import path from "node:path";
import { OUT, axe, launch, metrics, newReport, open, signedIn, watch } from "./qa-harness.mjs";

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
const BASE_URL = process.env.QA_BASE_URL ?? "http://127.0.0.1:3270";
// A page of its own per route: the dev server restarts itself when it nears its memory limit, and a page that was mid-navigation then keeps reloading and makes every later goto on it fail
// ("interrupted by another navigation"). A fresh page cannot inherit that. A route that fails is tried once more on another fresh page after the server answers again.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withDeadline = (promise, ms, what) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${what} took longer than ${ms / 1000}s`); })]);
async function serverAnswers() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ok = await Promise.race([
      fetch(`${BASE_URL}/login`, { signal: AbortSignal.timeout(8000) }).then((r) => { r.body?.cancel().catch(() => {}); return r.status < 500; }).catch(() => false),
      sleep(10_000).then(() => false),
    ]);
    if (ok) return true;
    await sleep(2000);
  }
  return false;
}
async function sweepRoute(context, width, theme, route) {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(150_000);
  watch(page, report, `${role} ${width} ${theme}`);
  const before = { c: report.consoleErrors.length, p: report.pageErrors.length, s: report.serverErrors.length, e: report.external.length };
  let status = 0;
  page.once("response", (r) => { status = r.status(); });
  try {
    await open(page, route);
    // A page that redirects after it has rendered (the server sends the redirect in the stream) must have landed before it is measured, or the measurement hits a destroyed context.
    for (let i = 0, last = ""; i < 8; i++) {
      const now = await page.evaluate(() => location.pathname).catch(() => "");
      if (now && now === last) break;
      last = now;
      await page.waitForTimeout(600);
    }
    await page.waitForFunction(() => { const m = document.querySelector("main, [role=main]"); return Boolean(m) && Boolean(m.querySelector("h1, h2")); }, null, { timeout: 30_000 }).catch(() => {});
    const m = await page.evaluate((min) => {
      const out = { path: location.pathname, title: document.title, scrollWidth: document.documentElement.scrollWidth, small: [] };
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
    // The harness's overflow also catches content clipped by the shell (a card running off a phone's edge), which a document-width check cannot see.
    const mm = await metrics(page);
    m.overflow = mm.overflow;
    m.clipped = mm.clipped;
    m.cut = mm.cut;
    m.hiddenCut = mm.hiddenCut;
    const violations = await axe(page);
    const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const row = { role, route, width, theme, status, path: m.path, overflow: m.overflow, clipped: m.clipped, cut: m.cut, hiddenCut: m.hiddenCut, scrollWidth: m.scrollWidth, axeSeriousOrCritical: bad, axeOther: violations.filter((v) => !bad.includes(v)).map((v) => v.id), smallText: m.smallCounts, smallSamples: m.small,
      consoleErrors: report.consoleErrors.length - before.c, pageErrors: report.pageErrors.length - before.p, serverErrors: report.serverErrors.length - before.s, external: report.external.length - before.e };
    if (has("shots")) await page.screenshot({ path: path.join(OUT, `${label}-${route.replace(/[^\w]+/g, "_")}-${width}-${theme}.png`), fullPage: true }).catch(() => {});
    const flags = [m.overflow && `OVERFLOW${m.clipped?.length ? `[${m.clipped[0]}]` : ""}`, m.cut?.length && `CUT[${m.cut[0]}]`, m.hiddenCut?.length && `TEXTCUT[${m.hiddenCut[0]}]`, bad.length && `AXE(${bad.map((v) => v.id).join(",")})`, row.pageErrors && "PAGEERR", row.serverErrors && "5XX", row.consoleErrors && "CONSOLE", Object.keys(m.smallCounts).length && `SMALL(${Object.entries(m.smallCounts).map(([k, v]) => `${k}px×${v}`).join(" ")})`].filter(Boolean);
    return { row, line: `${flags.length ? "!!" : "ok"}  ${role} ${width}px ${theme}  ${route}${m.path !== route.split("?")[0] ? ` -> ${m.path}` : ""}  ${flags.join(" ")}` };
  } finally {
    await page.close().catch(() => {});
  }
}

for (const theme of themes) {
  for (const width of widths) {
    // `--role none` sweeps pages a visitor sees without signing in (sign-in, the purchase and payment links, the demo).
    const viewport = { width, height: width < 600 ? 812 : 900 };
    let context;
    if (role === "none") {
      context = await browser.newContext({ viewport, reducedMotion: "reduce", colorScheme: theme });
      await context.addInitScript((th) => { try { localStorage.setItem("iaq-theme", th); localStorage.setItem("iaq-tour-v1", "done"); } catch { /* blocked */ } }, theme);
    } else {
      const signed = await signedIn(browser, role, { viewport, theme });
      context = signed.context;
      await signed.page.close().catch(() => {});
    }
    for (const route of routes) {
      let done = null;
      let lastError = "";
      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        try { done = await withDeadline(sweepRoute(context, width, theme, route), 240_000, `Page ${route}`); } catch (e) { lastError = String(e).slice(0, 200); if (attempt === 1) await serverAnswers(); }
      }
      if (done) { rows.push(done.row); console.log(done.line); }
      else { rows.push({ role, route, width, theme, error: lastError }); console.log(`!!  ${role} ${width}px ${theme}  ${route}  ERROR ${lastError.slice(0, 120)}`); }
    }
    await context.close();
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, `sweep-${label}.json`), JSON.stringify({ rows, consoleErrors: report.consoleErrors, pageErrors: report.pageErrors, serverErrors: report.serverErrors, external: report.external }, null, 2));
console.log(`\n${rows.length} page views. console errors ${report.consoleErrors.length}, page errors ${report.pageErrors.length}, 5xx ${report.serverErrors.length}, external requests ${report.external.length}`);
for (const e of [...report.pageErrors, ...report.serverErrors, ...report.consoleErrors, ...report.external].slice(0, 10)) console.log("  ! " + e);
