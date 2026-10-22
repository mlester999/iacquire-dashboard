// Browser QA of the AI Automation Builder with a REAL model: the isolated Automation Studio app (the same one scripts/automation-qa.mjs starts, with the same
// isolated database, sign-in and every other pinned variable), but the AI model connection is the real, configured one instead of the scripted stand-in.
// What this shows that the stand-in cannot: that what a real model writes goes through the whole product path (server validation, the transaction, the stream,
// the animated canvas, undo history, reload) and that nothing about the connection (the key) reaches the browser.
//
//   node scripts/automation-real-model-qa.mjs --env-file "<path to the .env that holds LLM_BASE_URL, LLM_API_KEY and LLM_MODEL>" [--headed] [--production]
//
// ONLY those three lines of the file are read; a database address in the same file is never read or passed on. The server it starts is the isolated one on
// AUTOMATION_QA_URL (stop any other QA server first: both use that port and database). The prompts are fixed and synthetic and the workspace is fictional; the
// only outside call is the model's. Nothing is switched on, tested or published. The key is never printed or written. Exit code 1 when a check failed.
// Output: .data/automation-qa/report-real-model.json and .data/automation-qa/screens-real/*.png.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AUTOMATION_QA_DATA_DIR, AUTOMATION_QA_ENV, AUTOMATION_QA_URL, AUTOMATION_QA_PORT, assertAutomationQaIsolated } from "./automation-qa-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, AUTOMATION_QA_DATA_DIR);
const SCREENS = path.join(DATA, "screens-real");
const BASE = AUTOMATION_QA_URL;
const args = process.argv.slice(2);
const headed = args.includes("--headed");
/** --production: serve the production bundle (npm run build:clean first) instead of the dev server, with the same real model. */
const production = args.includes("--production");
const envFile = args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : undefined;
fs.mkdirSync(SCREENS, { recursive: true });

assertAutomationQaIsolated({ root: ROOT });
if (!envFile) { console.error("--env-file is required."); process.exit(1); }
const llm = {};
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^(LLM_BASE_URL|LLM_API_KEY|LLM_MODEL)=(.*)$/.exec(line);
  if (m) llm[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) if (!llm[k]) { console.error(`${k} is missing from the file.`); process.exit(1); }
const modelHost = new URL(llm.LLM_BASE_URL).host;
if (modelHost === "127.0.0.1" || modelHost === "localhost") { console.error("This run is for a real model, not a local double."); process.exit(1); }

const pwEntry = process.env.PLAYWRIGHT_MODULE ?? path.join(ROOT, ".data/crm-qa/browser-runner/node_modules/playwright/index.mjs");
const pw = await import(pathToFileURL(pwEntry).href);
const creds = JSON.parse(fs.readFileSync(path.join(DATA, "credentials.local.json"), "utf8"));

const report = { startedAt: new Date().toISOString(), base: BASE, model: llm.LLM_MODEL, modelHost, checks: [], timeline: {}, turns: [], errors: { console: [], page: [], failedRequests: [], serverErrors: [], blockedExternal: [] } };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -> ${String(detail).slice(0, 300)}` : ""}`);
};
const isLocal = (u) => { try { return new URL(u).host === new URL(BASE).host; } catch { return false; } };

// The isolated app, with the model connection replaced by the real one for this process only.
const nodeOptions = String(process.env.NODE_OPTIONS ?? "").trim();
const env = { ...process.env, ...AUTOMATION_QA_ENV, LLM_BASE_URL: llm.LLM_BASE_URL, LLM_API_KEY: llm.LLM_API_KEY, LLM_MODEL: llm.LLM_MODEL, ...(production ? { NODE_ENV: "test", IAQ_DIST_DIR: ".next-clean-build", SECRET_STORE: "test-memory" } : {}), NODE_OPTIONS: [nodeOptions, "--max-old-space-size=8192"].filter(Boolean).join(" ") };
const server = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), ...(production ? ["start"] : ["dev", "--webpack"]), "--hostname", "127.0.0.1", "-p", String(AUTOMATION_QA_PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
let serverLog = "";
const keep = (b) => { serverLog = (serverLog + b.toString()).slice(-20_000); };
server.stdout.on("data", keep);
server.stderr.on("data", keep);
const stopServer = () => { try { server.kill(); } catch { /* already gone */ } };
process.on("exit", stopServer);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopServer(); process.exit(1); });

async function waitForServer() {
  const until = Date.now() + 300_000;
  while (Date.now() < until) {
    try { const r = await fetch(`${BASE}/login`, { redirect: "manual" }); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("The isolated app did not start.");
}

const nodes = (page) => page.locator(".react-flow__node").count();
/** A turn is over when a new assistant message has text, the typing dots are gone and the canvas is no longer locked by the builder. */
const turnDone = (page, assistantCountBefore) => page.waitForFunction((n) => {
  const bubbles = document.querySelectorAll("[data-role=assistant]");
  if (bubbles.length <= n) return false;
  if (document.querySelector("[aria-label='The builder is writing']")) return false;
  if ([...document.querySelectorAll("[role=status]")].some((e) => /builder is working/i.test(e.textContent ?? ""))) return false;
  return (bubbles[bubbles.length - 1].textContent ?? "").trim().length > 0;
}, assistantCountBefore, { timeout: 240_000 });
/** The canvas has stopped changing (the replay of a confirmed change takes a moment after the turn ends). */
async function settle(page) {
  let last = -1;
  let since = Date.now();
  for (let i = 0; i < 100; i++) {
    const n = (await page.locator(".react-flow__node").count()) * 1000 + (await page.locator(".react-flow__edge").count());
    if (n !== last) { last = n; since = Date.now(); }
    if (Date.now() - since > 2500) return;
    await page.waitForTimeout(250);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(SCREENS, `${name}.png`) });
const hydrated = (page, selector) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, selector, { timeout: 300_000 });

async function main() {
  await waitForServer();
  const browser = await pw.chromium.launch({ headless: !headed });
  const user = creds.users.owner;
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 }, locale: "en-US", timezoneId: "America/Chicago", reducedMotion: "no-preference" });
  context.setDefaultNavigationTimeout(300_000);
  context.setDefaultTimeout(120_000);
  await context.route((url) => !isLocal(url.href), (route) => { report.errors.blockedExternal.push(new URL(route.request().url()).host); return route.abort("blockedbyclient").catch(() => {}); });
  // Every response body the browser receives is searched for the model key afterwards.
  const bodies = [];
  context.on("response", async (r) => {
    try { if (isLocal(r.url()) && /text|json|javascript|html/.test(r.headers()["content-type"] ?? "")) bodies.push(await r.text()); } catch { /* body not available */ }
  });
  await context.addInitScript(() => {
    try { localStorage.setItem("iaq-tour-v1", "done"); localStorage.setItem("iaq-theme", "light"); } catch { /* */ }
    window.__canvasTimeline = [];
    let last = "";
    setInterval(() => {
      const n = document.querySelectorAll(".react-flow__node").length;
      const e = document.querySelectorAll(".react-flow__edge").length;
      const key = `${n}/${e}`;
      if (key !== last) { last = key; window.__canvasTimeline.push({ t: Math.round(performance.now()), nodes: n, edges: e }); }
    }, 40);
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") report.errors.console.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => report.errors.page.push(`${page.url().replace(BASE, "")} ${(e.message || String(e)).slice(0, 600)}`));
  page.on("requestfailed", (r) => { const f = r.failure()?.errorText ?? ""; if (isLocal(r.url()) && !/ERR_ABORTED/.test(f)) report.errors.failedRequests.push(`${r.url().replace(BASE, "")} ${f}`); });
  page.on("response", (r) => { if (r.status() >= 500) report.errors.serverErrors.push(`${r.status()} ${r.url().replace(BASE, "")}`); });

  for (let attempt = 1; ; attempt++) {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const ok = await page.waitForFunction(() => { const el = document.querySelector("#email"); return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: attempt < 4 ? 60_000 : 240_000 }).then(() => true, () => false);
    if (ok) break;
    if (attempt >= 4) throw new Error("The sign-in page never became interactive.");
  }
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  const submit = page.locator("form button[type=submit]").first();
  for (let i = 0; i < 20 && !(await submit.isEnabled()); i++) await page.waitForTimeout(150);
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 });

  // ---------------------------------------------------------------- the model is the real one, and the product says it is available
  await page.goto("/automation-studio", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: "What would you like to automate?" }).waitFor({ timeout: 180_000 });
  await hydrated(page, "#studio-prompt");
  check("home: the builder is available with the real model connection", await page.locator("#studio-prompt").isEnabled());

  // ---------------------------------------------------------------- 1. build from a sentence
  await page.locator("#studio-prompt").fill("When a new lead comes in, create a high-priority task for the owner to welcome them. Then wait two days, and if they haven't replied, notify the owners and admins.");
  const t0 = Date.now();
  await page.getByRole("button", { name: /Build it/ }).click();
  await page.waitForURL(/\/automation-studio\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  const workflowPath = page.url().replace(BASE, "");
  await page.locator("[data-studio-workspace]").waitFor({ timeout: 180_000 });
  await hydrated(page, "[data-studio-workspace]");
  await page.locator(".react-flow").waitFor({ timeout: 60_000 });
  await turnDone(page, 0);
  await settle(page);
  const buildMs = Date.now() - t0;
  const builtNodes = await nodes(page);
  const timeline = await page.evaluate(() => window.__canvasTimeline);
  report.timeline.build = timeline;
  report.turns.push({ say: "build", ms: buildMs, nodes: builtNodes });
  check("build: the real model's answer produced a canvas with a trigger and at least three steps", builtNodes >= 4, `nodes=${builtNodes}`);
  const distinct = [...new Set(timeline.map((x) => x.nodes))].filter((c) => c > 0);
  check("build: the nodes appeared one after another (a replay of the confirmed changes, not one jump)", distinct.length >= 3, `distinct counts: ${distinct.join(",")}`);
  check("build: connections were drawn", (timeline.at(-1)?.edges ?? 0) >= builtNodes - 2, `edges=${timeline.at(-1)?.edges}`);
  const reply = (await page.locator("[data-role=assistant]").last().textContent()) ?? "";
  check("build: the reply is in the chat and is not an error", reply.length > 20 && !/couldn't make that change/i.test(reply), reply.slice(0, 200));
  await page.waitForFunction(() => document.querySelector("[data-save-state]")?.getAttribute("data-save-state") === "saved", null, { timeout: 30_000 }).catch(() => {});
  await shot(page, "01-built-by-real-model");

  // The workflow is really saved: the same canvas after a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".react-flow__node").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  check("saved: a reload shows the same number of nodes", (await nodes(page)) === builtNodes, `before=${builtNodes} after=${await nodes(page)}`);
  check("saved: a reload keeps the conversation", (await page.locator("[data-role]").count()) >= 2);

  // ---------------------------------------------------------------- 2. an edit of the same workflow, about the selected step
  await page.locator(".react-flow__node").filter({ hasText: /^(?=.*[Ww]ait)/ }).first().click();
  await page.getByRole("complementary", { name: "Step settings" }).waitFor({ timeout: 15_000 }).catch(() => {});
  const input = page.locator("#studio-chat-input");
  const t1 = Date.now();
  const beforeEdit = await page.locator("[data-role=assistant]").count();
  await input.fill("Make this one 3 days instead.");
  await input.press("Enter");
  await turnDone(page, beforeEdit);
  await settle(page);
  const afterEdit = await nodes(page);
  report.turns.push({ say: "edit selected wait", ms: Date.now() - t1, nodes: afterEdit });
  check("edit: the same workflow was edited, not rebuilt (same number of nodes)", afterEdit === builtNodes, `before=${builtNodes} after=${afterEdit}`);
  const canvasText = (await page.locator(".react-flow").textContent()) ?? "";
  check("edit: the canvas now shows a 3 day wait", /3 days?/i.test(canvasText), canvasText.slice(0, 300));
  await shot(page, "02-edited-by-real-model");

  // ---------------------------------------------------------------- 3. something the builder can't do: nothing may change, and it must say so plainly
  const t2 = Date.now();
  const assistantBefore = await page.locator("[data-role=assistant]").count();
  await input.fill("Also post a congratulations on our Instagram page whenever a lead replies.");
  await input.press("Enter");
  await turnDone(page, assistantBefore);
  await settle(page);
  const refusalReply = (await page.locator("[data-role=assistant]").last().textContent()) ?? "";
  report.turns.push({ say: "unsupported request", ms: Date.now() - t2, nodes: await nodes(page) });
  check("unsupported: nothing was added to the canvas", (await nodes(page)) === builtNodes, `nodes=${await nodes(page)}`);
  check("unsupported: the reply says plainly that it isn't possible", /can'?t|cannot|isn'?t (possible|something)|not (possible|supported|able)|unable|no (way|step)|don'?t (have|support)|doesn'?t (support|have)/i.test(refusalReply), refusalReply.slice(0, 250));
  check("unsupported: the reply does not claim a change", !/^\s*(done|i('ve| have)? (added|posted|created))/i.test(refusalReply), refusalReply.slice(0, 120));
  await shot(page, "03-unsupported-request");

  // ---------------------------------------------------------------- 4. undo in Manual mode reverts the builder's edit (the history is the same one)
  await page.getByRole("radiogroup", { name: "Editing mode" }).getByText("Manual", { exact: true }).click();
  await page.getByPlaceholder("Search steps").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(800);
  const afterUndo = (await page.locator(".react-flow").textContent()) ?? "";
  check("undo: Manual mode's undo reverts the builder's last change (the wait is back to its first length)", /2 days?/i.test(afterUndo) && !/3 days?/i.test(afterUndo), afterUndo.slice(0, 300));

  // ---------------------------------------------------------------- the connection never reaches the browser
  const html = await page.content();
  const leak = bodies.concat([html]).some((b) => b.includes(llm.LLM_API_KEY));
  check("secrets: the model key appears in no page and no response the browser received", !leak);
  check("secrets: the browser never contacted the model or any other outside host", report.errors.blockedExternal.length === 0, [...new Set(report.errors.blockedExternal)].join(", "));
  check("secrets: the server log does not contain the key", !serverLog.includes(llm.LLM_API_KEY));
  check("errors: no page errors, no failed requests, no server errors", report.errors.page.length === 0 && report.errors.failedRequests.length === 0 && report.errors.serverErrors.length === 0,
    JSON.stringify({ page: report.errors.page.slice(0, 2), failed: report.errors.failedRequests.slice(0, 2), server: report.errors.serverErrors.slice(0, 2) }));
  report.workflowPath = workflowPath;
  await browser.close();
}

try {
  await main();
} catch (err) {
  check("run: finished without a crash", false, err instanceof Error ? err.message : String(err));
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter((c) => c.ok).length;
  report.failed = report.checks.filter((c) => !c.ok).length;
  fs.writeFileSync(path.join(DATA, "report-real-model.json"), JSON.stringify(report, null, 2));
  stopServer();
  console.log(`\n${report.passed} of ${report.checks.length} checks passed. Report: ${path.relative(ROOT, path.join(DATA, "report-real-model.json"))}`);
  process.exit(report.failed ? 1 : 0);
}
