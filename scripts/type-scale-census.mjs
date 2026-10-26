// Counts, across a list of pages in the isolated QA app (port 3270), how much visible text is set at each font size, weighted by characters, so "body text is 14 to 16px, metadata 12 to 14px,
// nothing below 12px" is a number and not an impression. Each text node is attributed to its computed font size (rounded to the nearest 0.5px); hidden, zero-size and screen-reader-only
// text is skipped.
//
//   node scripts/type-scale-census.mjs --role harbor:owner --routes-file .data/wave2-qa/routes-portal.txt --widths 1280,375 --themes light --label census-after
// Output: .data/wave2-qa/census-<label>.json and a printed summary (share of characters per size, and the pages with the most text under 12px or under 14px).
import fs from "node:fs";
import path from "node:path";
import { OUT, launch, open, signedIn } from "./qa-harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const role = flag("role", "harbor:owner");
const routes = flag("routes-file") ? fs.readFileSync(flag("routes-file"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : flag("routes", "/").split(",");
const widths = flag("widths", "1280,375").split(",").map(Number);
const themes = flag("themes", "light").split(",");
const label = flag("label", "census");

const browser = await launch();
const perPage = [];
const total = {};
for (const theme of themes) {
  for (const width of widths) {
    const { context, page } = await signedIn(browser, role, { viewport: { width, height: width < 600 ? 812 : 900 }, theme });
    for (const route of routes) {
      try {
        await open(page, route);
        const sizes = await page.evaluate(() => {
          const out = {};
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.textContent.replace(/\s+/g, " ").trim();
            if (!t) continue;
            const el = n.parentElement;
            if (!el || el.closest("script, style, nextjs-portal, [aria-hidden=true], .sr-only")) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const size = Math.round(parseFloat(cs.fontSize) * 2) / 2;
            out[size] = (out[size] ?? 0) + t.length;
          }
          return out;
        });
        perPage.push({ route, width, theme, sizes });
        for (const [s, n] of Object.entries(sizes)) total[`${width}/${theme}/${s}`] = (total[`${width}/${theme}/${s}`] ?? 0) + n;
        process.stdout.write(".");
      } catch (e) {
        perPage.push({ route, width, theme, error: String(e).slice(0, 160) });
        process.stdout.write("x");
      }
    }
    await context.close();
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, `census-${label}.json`), JSON.stringify({ role, perPage, total }, null, 2));

console.log("");
for (const theme of themes) {
  for (const width of widths) {
    const rows = Object.entries(total).filter(([k]) => k.startsWith(`${width}/${theme}/`)).map(([k, n]) => [Number(k.split("/")[2]), n]).sort((a, b) => a[0] - b[0]);
    const sum = rows.reduce((a, [, n]) => a + n, 0);
    const cum = (pred) => (rows.filter(([s]) => pred(s)).reduce((a, [, n]) => a + n, 0) / sum * 100).toFixed(1);
    console.log(`\n${role} ${width}px ${theme}: ${sum} characters`);
    console.log(rows.map(([s, n]) => `${s}px ${(n / sum * 100).toFixed(1)}%`).join("  "));
    console.log(`  under 12px ${cum((s) => s < 12)}%   12 to 13.5px ${cum((s) => s >= 12 && s < 14)}%   14px and up ${cum((s) => s >= 14)}%`);
    const worst = perPage.filter((p) => p.width === width && p.theme === theme && p.sizes).map((p) => ({ route: p.route, under12: Object.entries(p.sizes).filter(([s]) => Number(s) < 12).reduce((a, [, n]) => a + n, 0) })).filter((p) => p.under12 > 0).sort((a, b) => b.under12 - a.under12).slice(0, 8);
    if (worst.length) console.log("  most text under 12px: " + worst.map((w) => `${w.route} (${w.under12})`).join(", "));
  }
}
