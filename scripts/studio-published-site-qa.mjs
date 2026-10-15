// Drives the PUBLISHED sites, as a visitor's browser does, in the isolated local runtime. Preview, editor and published site share one renderer, but a
// visitor gets the published runtime, so it is checked on its own.
//
//   npm run studio:qa:publish-seed          (once, with the QA server stopped: publishes three fixture sites into the isolated database)
//   npm run studio:qa                       (the isolated app on :3210; sites answer on http://{subdomain}.sites.localhost:3210)
//   node scripts/studio-published-site-qa.mjs
//
// For every published site, page and width (390, 768, 1024, 1440): the page is served (200, one h1, a skip link, security headers), nothing overflows
// sideways, no picture is broken, no script errors, a real mouse wheel and the End key both reach the footer, links to a section on the page land below a
// pinned header, the header's links never crowd the logo or squeeze the button, and - on a phone - the menu opens, lists the pages and takes a visitor to one.
// Evidence: .data/studio-qa/published-site-results.json
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.STUDIO_QA_URL ?? "http://localhost:3210";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Run browser QA only against the isolated local app.");
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs").href); }
const OUT = ".data/studio-qa";
const WIDTHS = (process.env.WIDTHS ?? "390,768,1024,1440").split(",").map(Number);
const port = new URL(BASE).port;
const published = JSON.parse(await fs.readFile(".data/studio-premium-qa/published.json", "utf8")).sites;

const rows = [];
const browser = await pw.chromium.launch({ headless: true });
try {
  for (const site of published) {
    const origin = `http://${site.host}:${port}`;
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", deviceScaleFactor: width < 800 ? 2 : 1 });
      const page = await context.newPage();
      const events = [];
      page.on("pageerror", (e) => events.push(`pageerror: ${e.message.slice(0, 120)}`));
      page.on("console", (m) => { if (m.type() === "error" && !/webpack-hmr|favicon/.test(m.text())) events.push(`console: ${m.text().slice(0, 120)}`); });
      await page.routeWebSocket("**/_next/webpack-hmr", (s) => s.close());
      try {
        const first = await page.goto(`${origin}/`, { waitUntil: "load", timeout: 120000 });
        const headers = first.headers();
        await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
        const slugs = await page.evaluate(() => [...new Set([...document.querySelectorAll(".iq-header .iq-nav-list a:not(.iq-btn)")].map((a) => new URL(a.href).pathname))]);
        // The pages a visitor can reach from the header. (A page the business has not got, such as a gallery with no photographs, is neither listed nor served.)
        const paths = [...new Set(["/", ...slugs])];
        for (const path of paths) {
          const row = { site: site.template, width, path, notes: [] };
          const response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 120000 });
          await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
          await page.evaluate(() => document.fonts.ready);
          row.status = response.status();
          if (row.status !== 200) row.notes.push(`HTTP ${row.status}`);
          if (path === "/") {
            row.headers = { csp: Boolean(headers["content-security-policy"]), nosniff: headers["x-content-type-options"] === "nosniff", frameOptions: headers["x-frame-options"] ?? null };
            if (!row.headers.nosniff) row.notes.push("missing X-Content-Type-Options");
          }
          const m = await page.evaluate(() => {
            const footer = document.querySelector("footer");
            const header = document.querySelector("header.iq-header");
            const hs = header ? getComputedStyle(header) : null;
            const nav = header?.querySelector(".iq-nav");
            const visibleBtn = [...(header?.querySelectorAll(".iq-btn") ?? [])].find((b) => b.getBoundingClientRect().width > 0);
            const tops = new Set();
            if (visibleBtn) { const w = document.createTreeWalker(visibleBtn, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!n.nodeValue.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.width > 0.5) tops.add(Math.round(q.top / 6)); } }
            return {
              h1: document.querySelectorAll("h1").length, skip: Boolean(document.querySelector("a.iq-skip")), docH: document.documentElement.scrollHeight, xOverflow: document.documentElement.scrollWidth - innerWidth,
              broken: [...document.images].filter((i) => i.complete && !i.naturalWidth && i.currentSrc).length, hasFooter: Boolean(footer),
              pinned: hs ? ["sticky", "fixed"].includes(hs.position) : false, headerH: header ? Math.round(header.getBoundingClientRect().height) : 0,
              navCollapsed: nav?.hasAttribute("data-collapsed") ?? null, listShown: nav ? getComputedStyle(nav.querySelector(".iq-nav-list")).display !== "none" : null, ctaLines: tops.size,
              sized: [...document.images].filter((i) => /template-images/.test(i.currentSrc)).map((i) => i.currentSrc.replace(location.origin, "").replace(/.*template-images/, "template-images")).slice(0, 4),
              ids: [...document.querySelectorAll("main section[id]")].map((s) => s.id).slice(1, 6),
            };
          });
          Object.assign(row, { h1: m.h1, docH: m.docH, xOverflow: m.xOverflow, broken: m.broken, pinnedHeader: m.pinned, navFolded: m.navCollapsed || m.listShown === false, ctaLines: m.ctaLines, images: m.sized });
          if (m.h1 !== 1) row.notes.push(`${m.h1} h1 elements`);
          if (!m.skip) row.notes.push("no skip link");
          if (!m.hasFooter) row.notes.push("no footer");
          if (m.xOverflow > 1) row.notes.push(`${m.xOverflow}px horizontal overflow`);
          if (m.broken) row.notes.push(`${m.broken} broken image(s)`);
          if (m.ctaLines > 2) row.notes.push(`header button squeezed onto ${m.ctaLines} lines`);

          // A real mouse wheel, then the End key, must reach the footer.
          await page.mouse.move(width / 2, 450);
          let reached = false;
          for (let i = 0; i < 160 && !reached; i++) {
            await page.mouse.wheel(0, 700);
            await page.waitForTimeout(15);
            reached = await page.evaluate(() => { const f = document.querySelector("footer").getBoundingClientRect(); return f.bottom <= innerHeight + 2; });
          }
          row.wheelReachesFooter = reached;
          if (!reached) row.notes.push("a mouse wheel never reached the footer");
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.keyboard.press("End");
          await page.waitForTimeout(400);
          row.endKeyReachesFooter = await page.evaluate(() => document.querySelector("footer").getBoundingClientRect().bottom <= innerHeight + 2);
          if (!row.endKeyReachesFooter) row.notes.push("the End key did not reach the footer");

          // Anchors under a pinned header.
          if (m.pinned) {
            const covered = [];
            for (const id of m.ids) {
              await page.evaluate(() => window.scrollTo(0, 0));
              await page.evaluate((target) => { location.hash = ""; location.hash = `#${target}`; }, id);
              await page.waitForTimeout(250);
              const r = await page.evaluate((target) => ({ top: Math.round(document.getElementById(target).getBoundingClientRect().top), header: Math.round(document.querySelector("header.iq-header").getBoundingClientRect().bottom), end: Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 1 }), id);
              if (r.top < r.header - 1 && !r.end) covered.push(`#${id}`);
            }
            row.anchorsCovered = covered;
            if (covered.length) row.notes.push(`pinned header covers ${covered.join(", ")}`);
          }
          rows.push(row);
          if (row.notes.length) console.log(`${site.template} ${path} @${width}: ${row.notes.join(" | ")}`);
        }

        // The phone menu: open, list the pages, take the visitor to one, and be closed there.
        if (width <= 480) {
          const row = { site: site.template, width, path: "menu", notes: [] };
          await page.goto(`${origin}/`, { waitUntil: "load", timeout: 120000 });
          await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
          const summary = page.locator("header details.iq-menu > summary").first();
          await summary.click();
          const links = page.locator("header details.iq-menu[open] .iq-menu-panel li a");
          row.menuLinks = await links.count();
          if (row.menuLinks < 3) row.notes.push(`the menu lists ${row.menuLinks} pages`);
          const target = links.nth(1);
          const label = (await target.textContent())?.trim();
          await Promise.all([page.waitForURL((u) => u.pathname !== "/", { timeout: 30000 }), target.click()]);
          await page.locator('.iq-site[data-nav-fit="ready"]').waitFor({ state: "attached", timeout: 30000 });
          row.followed = `${label} -> ${new URL(page.url()).pathname}`;
          row.menuClosedOnArrival = (await page.locator("header details.iq-menu[open]").count()) === 0;
          if (!row.menuClosedOnArrival) row.notes.push("the menu is still open on the next page");
          // The skip link is the first stop for a keyboard visitor and takes them to the content.
          await page.keyboard.press("Tab");
          row.firstTab = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 30));
          if (!/skip/i.test(row.firstTab ?? "")) row.notes.push(`first Tab stop is "${row.firstTab}", not the skip link`);
          rows.push(row);
          if (row.notes.length) console.log(`${site.template} menu @${width}: ${row.notes.join(" | ")}`);
        }
        if (width === WIDTHS[0]) {
          const extra = { site: site.template, width, path: "robots/sitemap", notes: [] };
          for (const file of ["/robots.txt", "/sitemap.xml"]) { const status = await page.evaluate(async (u) => (await fetch(u)).status, `${origin}${file}`); extra[file] = status; if (status !== 200) extra.notes.push(`${file} answered ${status}`); }
          rows.push(extra);
          if (extra.notes.length) console.log(`${site.template}: ${extra.notes.join(" | ")}`);
        }
      } catch (error) {
        rows.push({ site: site.template, width, path: "(run)", notes: [`could not check: ${String(error.message).split("\n")[0]}`] });
        console.log(`${site.template} @${width}: could not check: ${String(error.message).split("\n")[0]}`);
      }
      if (events.length) { rows.push({ site: site.template, width, path: "(events)", notes: [...new Set(events)].slice(0, 4) }); console.log(`${site.template} @${width}: ${[...new Set(events)].slice(0, 2).join(" | ")}`); }
      await context.close();
    }
  }
} finally { await browser.close(); }
const failing = rows.filter((r) => r.notes.length);
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(`${OUT}/published-site-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, sites: published.map((s) => s.template), widths: WIDTHS, checks: rows.length, failing: failing.length, rows }, null, 2));
console.log(JSON.stringify({ sites: published.length, widths: WIDTHS.length, checks: rows.length, failing: failing.length, evidence: `${OUT}/published-site-results.json` }));
if (failing.length) process.exitCode = 1;
