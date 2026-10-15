// Reproducible local measurements, server warmed; each sample uses a fresh browser context.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
let pw;
try { pw = await import("playwright"); } catch { pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href); }
const label = process.argv[2] ?? "after";
const browser = await pw.chromium.launch();
const results = [];
await fs.mkdir(".data/studio-qa/performance", { recursive: true });
try {
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__studioCLS = 0;
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__studioCLS += entry.value; }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto("http://localhost:3210/dev/gallery-preview", { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => Object.keys(document.querySelector("input") ?? {}).some((key) => key.startsWith("__reactProps")));
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll("[data-thumbnail-key]")].filter((card) => card.getBoundingClientRect().top < innerHeight);
      return cards.length > 0 && cards.every((card) => {
        const image = card.querySelector("img");
        if (image) return image.complete && image.naturalWidth > 0;
        const frame = card.querySelector("iframe");
        return frame?.contentDocument?.querySelector(".iq-site h1");
      });
    }, null, { timeout: 90000 });
    const metrics = await page.evaluate(() => ({
      readyMs: performance.now(), domContentLoadedMs: performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd,
      firstContentfulPaintMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
      thumbnailFrames: document.querySelectorAll("[data-thumbnail-key] iframe").length,
      thumbnailImages: document.querySelectorAll("[data-thumbnail-key] img").length,
      cumulativeLayoutShift: window.__studioCLS,
      thumbnailTransfers: performance.getEntriesByType("resource").filter((resource) => resource.name.includes("/website-thumbnails/")).map((resource) => ({ url: resource.name.split("/").pop(), encodedBytes: resource.encodedBodySize, transferredBytes: resource.transferSize })),
    }));
    const cdp = await context.newCDPSession(page);
    metrics.heap = await cdp.send("Runtime.getHeapUsage");
    results.push(metrics);
    await page.screenshot({ path: `.data/studio-qa/performance/${label}-${run + 1}.png`, style: "nextjs-portal{display:none!important}" });
    await context.close();
  }
  await fs.writeFile(`.data/studio-qa/performance/${label}.json`, JSON.stringify({ environment: "Next.js development, warmed isolated local server, fresh Chromium context per sample; not production benchmarks", results }, null, 2));
  console.log(JSON.stringify(results.map((row) => ({ readyMs: Math.round(row.readyMs), frames: row.thumbnailFrames, images: row.thumbnailImages, cls: row.cumulativeLayoutShift, thumbnailBytes: row.thumbnailTransfers.reduce((sum, resource) => sum + resource.encodedBytes, 0) }))));
} finally { await browser.close(); }
