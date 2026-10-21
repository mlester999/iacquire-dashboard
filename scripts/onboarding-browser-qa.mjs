// Actual onboarding components in a loopback-only browser harness. Model and persistence are the
// existing, clearly labelled dev-preview mocks. No Next build, database or provider is contacted.
// PLAYWRIGHT_MODULE=<installed playwright/index.mjs> node scripts/onboarding-browser-qa.mjs
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".data/onboarding-qa");
await fs.mkdir(out, { recursive: true });
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs.");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const result = await build({
  absWorkingDir: root, entryPoints: ["tests/support/onboarding-browser.tsx"], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "local-preview-only", setup(builder) {
    builder.onResolve({ filter: /^next\/(navigation|link)$|^@\/app\/actions\/onboarding$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: id }) => ({ contents: id === "next/navigation" ? "export const useRouter = () => ({ push() {}, refresh() {} });" : id === "next/link" ? "import React from 'react'; export default React.forwardRef(({href,children,prefetch,...props},ref) => React.createElement('a',{href,ref,...props},children));" : "export const saveOnboardingStepAction = () => { throw Error('Preview must not call server actions'); }; export const deleteAssetAction=saveOnboardingStepAction, getOnboardingReviewAction=saveOnboardingStepAction, readOnboardingWebsiteAction=saveOnboardingStepAction, setAssetVariantAction=saveOnboardingStepAction, submitOnboardingAction=saveOnboardingStepAction;", resolveDir: root }));
  } }],
});
const cssPath = path.join(root, "src/app/globals.css");
const source = (await fs.readFile(cssPath, "utf8")).replace('@import "tailwindcss";', '@import "tailwindcss" source(none);');
const css = (await postcss([tailwind()]).process(`${source}\n@source "../components/onboarding";\n@source "../components/ui";\n@source "../components/brand.tsx";\n@source "./dev/onboarding-preview";\n@source "../../tests/support/onboarding-browser.tsx";`, { from: cssPath })).css;
const server = http.createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(result.outputFiles[0].text); }
  else if (req.url === "/app.css") { res.setHeader("Content-Type", "text/css"); res.end(css); }
  else { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const report = { checks: [], measurements: [], errors: [], screenshots: [] };
const check = (label, ok) => { report.checks.push({ label, ok: Boolean(ok) }); if (!ok) throw new Error(label); };
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 360, 390, 430, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.on("pageerror", (error) => report.errors.push(error.message));
      await page.addInitScript((theme) => { document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.theme = theme; }); }, theme);
      await page.goto(base);
      await page.getByRole("heading", { name: "Tell us what your business does." }).waitFor();
      const metrics = await page.evaluate(() => {
        const nav = document.querySelector('[aria-label="Question navigation"]');
        const buttons = Array.from(nav.querySelectorAll("button")).map((item) => item.getBoundingClientRect());
        const input = document.querySelector("#onboarding-input");
        return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, sameRow: Math.abs(buttons[0].top - buttons[1].top) < 2, overlap: buttons[0].right > buttons[1].left, targets: buttons.every((r) => r.width >= 44 && r.height >= (innerWidth < 640 ? 44 : 40)), fixed: getComputedStyle(nav).position === "fixed", inputFont: parseFloat(getComputedStyle(input).fontSize), footerTop: nav.getBoundingClientRect().top };
      });
      report.measurements.push({ theme, ...metrics });
      check(`${theme} ${width}px no overflow/same-row/non-overlap/touch targets`, !metrics.overflow && metrics.sameRow && !metrics.overlap && metrics.targets);
      if (width < 1024) check(`${theme} ${width}px fixed safe mobile footer`, metrics.fixed && metrics.footerTop < 844);
      if (width < 640) check(`${theme} ${width}px input avoids iOS focus zoom`, metrics.inputFont >= 16);
      check(`${theme} ${width}px single header exit`, await page.getByRole("button", { name: "Save & exit", exact: true }).count() === 1);
      if (width === 390 || width === 1440) { const file = `${theme}-${width}.png`; await page.screenshot({ path: path.join(out, file), fullPage: true }); report.screenshots.push(file); }
      await context.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(base);
  const original = await page.locator("#onboarding-input").inputValue();
  await page.getByRole("button", { name: "Suggest with AI" }).click();
  const preview = page.getByRole("region", { name: "AI suggestion preview" });
  await preview.waitFor();
  check("generation preserves original answer", await page.locator("#onboarding-input").inputValue() === original);
  await preview.getByRole("button", { name: "Edit suggestion" }).click();
  await page.locator("#suggestion-input").fill("Reviewed description for my business.");
  check("editing preview preserves original answer", await page.locator("#onboarding-input").inputValue() === original);
  await preview.getByRole("button", { name: "Use suggestion" }).click();
  check("acceptance inserts reviewed text", await page.locator("#onboarding-input").inputValue() === "Reviewed description for my business.");
  await page.getByRole("button", { name: "Save & exit", exact: true }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.reload();
  check("refresh resumes the persisted question and answer", await page.locator("#onboarding-input").inputValue() === "Reviewed description for my business.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Where can we find you online?" }).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("heading", { name: "Tell us what your business does." }).waitFor();
  check("back/continue preserve the saved answer", await page.locator("#onboarding-input").inputValue() === "Reviewed description for my business.");
  await page.getByLabel("Simulate save failure").check();
  await page.locator("#onboarding-input").fill("This must remain unsaved locally.");
  await page.getByRole("button", { name: "Save & exit", exact: true }).click();
  await page.getByText("Not saved", { exact: true }).waitFor();
  check("failed save preserves current text", await page.locator("#onboarding-input").inputValue() === "This must remain unsaved locally.");
  await page.getByLabel("Simulate save failure").uncheck();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 500, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await page.reload();
  await page.locator("#onboarding-input").waitFor();
  const inset = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--onboarding-keyboard-inset")));
  check("Safari-style layout/visual viewport difference offsets footer", inset === 344);
  const footerBounds = await page.getByRole("navigation", { name: "Question navigation" }).boundingBox();
  check("footer stays above the simulated keyboard", footerBounds.y + footerBounds.height <= 501);
  // Resize the real browser viewport as a second keyboard-like condition; native IMEs are not emulated.
  await page.setViewportSize({ width: 390, height: 500 });
  await page.evaluate(() => window.visualViewport.dispatchEvent(new Event("resize")));
  check("short visual viewport keeps navigation visible", await page.getByRole("navigation", { name: "Question navigation" }).isVisible());
  check("no browser errors", report.errors.length === 0);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.checks.length, screenshots: report.screenshots, report: path.join(out, "report.json") }));
