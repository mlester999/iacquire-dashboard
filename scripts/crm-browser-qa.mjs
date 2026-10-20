// Signed-in browser QA of the Native CRM against the isolated local app (scripts/crm-qa.mjs on CRM_QA_URL, default http://127.0.0.1:3230, seeded by
// scripts/run-crm-qa-seed.mjs). Real Chromium, real local sign-in per user (one browser context each), every page at two widths in light
// and dark: HTTP status, console and page errors, failed requests, rendered checks, horizontal overflow at phone width, axe-core, and a
// full-page screenshot. Then the key interactions. The browser talks to the QA server only: any request or socket to another origin,
// including another port on localhost (the portal dev server on :3100 runs on the hosted .env, mock Hermes on :8787), is blocked
// before the network and counted as a failure. (The QA server's own build-time fetches are covered in scripts/crm-qa-env.mjs.)
//
//   node scripts/crm-browser-qa.mjs [--only <pattern>]... [--viewports 1280,375] [--themes light,dark] [--roles owner,public,...]
//                                   [--no-axe] [--no-interactions] [--no-tick] [--live-hmr] [--headed] [--list]
//   --list prints every "<role>:<path>" and interaction this run would cover, then exits without opening a browser.
//   --only matches "<role>:<path>" (for example "owner:/crm/contacts") or "interaction:<name>"; a /regex/ is accepted. Repeatable.
//
// Playwright is not a project dependency: set PLAYWRIGHT_MODULE to an installed playwright/index.mjs when it isn't in node_modules.
// Output: .data/crm-qa/report.json, .data/crm-qa/report.md and .data/crm-qa/screens/<role>-<route>-<width>-<theme>.png.
// Exit code (first that applies): 1 when any request left the QA server or anything answered 5xx; 2 when the run stopped part way; 3 when
// an interaction failed; 4 when a page, screenshot, accessibility, request, or layout check failed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CRM_QA_DATA_DIR, CRM_QA_ENV, CRM_QA_URL } from "./crm-qa-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, CRM_QA_DATA_DIR);
const SCREENS = path.join(DATA, "screens");
const AUTH_DIR = path.join(DATA, "auth");
const AXE_PATH = path.join(ROOT, "node_modules/axe-core/axe.min.js");
const NO_MOTION = "*,*::before,*::after{transition:none!important;animation:none!important}";
const HIDE_DEV = "nextjs-portal{display:none!important}";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EXPECTED_REDIRECTS = {
  // These server redirects are streamed through the App Router and may complete after the first HTML document loads.
  "/appointments": { path: "/crm/calendar", title: "Calendar · CRM" },
  "/crm/settings": { path: "/crm/settings/provider", title: "CRM Provider · CRM" },
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Command-line flags. Unknown flags are an error, so a typo never silently runs everything. */
export function parseArgs(argv) {
  const o = { only: [], viewports: [{ width: 1280, height: 800 }, { width: 375, height: 812 }], themes: ["light", "dark"], roles: null, axe: true, interactions: true, tick: true, liveHmr: false, headed: false, list: false, base: null };
  const next = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${flag} needs a value.`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") o.only.push(next(i++, a));
    else if (a === "--viewports") o.viewports = parseViewports(next(i++, a));
    else if (a === "--themes") {
      o.themes = next(i++, a).split(",").map((s) => s.trim()).filter(Boolean);
      if (!o.themes.length || o.themes.some((t) => t !== "light" && t !== "dark")) throw new Error("--themes takes light, dark or light,dark.");
    } else if (a === "--roles") o.roles = next(i++, a).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--base") o.base = next(i++, a);
    else if (a === "--no-axe") o.axe = false;
    else if (a === "--no-interactions") o.interactions = false;
    else if (a === "--no-tick") o.tick = false;
    else if (a === "--live-hmr") o.liveHmr = true;
    else if (a === "--headed") o.headed = true;
    else if (a === "--list") o.list = true;
    else throw new Error(`Unknown option ${a}.`);
  }
  return o;
}

/** "1280,375" or "1280x800,375x812". A width alone takes the standard height for it (800 on desktop, 812 on a phone). */
export function parseViewports(s) {
  const out = String(s).split(",").map((v) => v.trim()).filter(Boolean).map((v) => {
    const m = /^(\d{3,4})(?:x(\d{3,4}))?$/.exec(v);
    if (!m) throw new Error(`Viewport "${v}" should look like 1280 or 1280x800.`);
    const width = Number(m[1]);
    return { width, height: m[2] ? Number(m[2]) : width < 768 ? 812 : 800 };
  });
  if (!out.length) throw new Error("--viewports needs at least one width.");
  return out;
}

/** Only this exact origin is accepted: the isolated QA server. */
export function assertBaseUrl(raw) {
  const base = String(raw ?? CRM_QA_URL).replace(/\/+$/, "");
  if (base !== CRM_QA_URL) throw new Error(`Browser QA runs only against ${CRM_QA_URL} (the isolated CRM QA server), not ${base}.`);
  return base;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connectionFailure = /ERR_CONNECTION_(?:RESET|REFUSED)|ERR_NETWORK/i;
const chunkFailure = /Loading (?:CSS )?chunk .* failed|ChunkLoadError/i;

/** A dev-worker restart can return 200 HTML while resetting its JavaScript chunks. Retry only when the browser saw that failure. */
export function isDevRestartInterruption(bucket, navigationError = "") {
  const failedConnections = (bucket?.failedRequests ?? []).filter((request) => connectionFailure.test(request.error ?? ""));
  const chunkRuntimeError = (bucket?.pageErrors ?? []).some((error) => chunkFailure.test(error));
  // Loading chunk errors are explicit even when the browser never emits requestfailed (for example, a stale 404 response).
  // Every failedRequests entry has already been restricted to the QA server's exact loopback origin. A reset on
  // an API, asset, streamed redirect, or document request is therefore a local server interruption too.
  return chunkRuntimeError || chunkFailure.test(navigationError) || failedConnections.length > 0;
}

/** Read the destination embedded in Next's streamed redirect meta tag. */
export function parseNextRedirectMeta(content, currentUrl) {
  const match = /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/i.exec(String(content ?? ""));
  if (!match) return null;
  const destination = match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  try {
    return new URL(destination, currentUrl);
  } catch {
    return null;
  }
}

/** A streamed redirect may already have replaced the URL before the browser check starts waiting. */
export function isRedirectTargetCurrent(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl);
    const target = targetUrl instanceof URL ? targetUrl : new URL(targetUrl, current);
    return current.origin === target.origin && current.pathname === target.pathname && current.search === target.search;
  } catch {
    return false;
  }
}

/** Remove only noise caused by the confirmed restart, preserving unrelated app and browser errors. */
export function clearDevRestartNoise(bucket, { clearConnections = false } = {}) {
  if (!bucket) return;
  const hadChunkFailure = (bucket.pageErrors ?? []).some((error) => chunkFailure.test(error));
  const confirmedRestart = hadChunkFailure || clearConnections;
  bucket.pageErrors = (bucket.pageErrors ?? []).filter((error) =>
    !chunkFailure.test(error) && !(confirmedRestart && /(?:invalid or unexpected token|unexpected token)/i.test(error)),
  );
  bucket.consoleErrors = (bucket.consoleErrors ?? []).filter((error) =>
    !connectionFailure.test(error) &&
    !/Refused to execute script from .*\/_next\/static\/chunks\//i.test(error) &&
    !(confirmedRestart && /Encountered a script tag while rendering React component/i.test(error)) &&
    !(confirmedRestart && /Failed to load resource:.*(?:404|Not Found)/i.test(error)),
  );
  bucket.failedRequests = (bucket.failedRequests ?? []).filter((request) => {
    if (!connectionFailure.test(request.error ?? "")) return true;
    return !clearConnections && !request.url?.includes("/_next/static/chunks/");
  });
  bucket.aborted = 0;
}

/** Waits for the isolated server after Next's dev worker restarts above its configured memory threshold. */
async function waitForQaServer(base, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/login", base);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500), redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return true;
    } catch {
      // The worker is still restarting or has not rebound the QA port yet.
    }
    await pause(500);
  }
  return false;
}

/** Wait for the final document after a Next streamed redirect, including role-denied redirects. */
async function waitForNextRedirect(page, routePath, base, bucket) {
  const expected = EXPECTED_REDIRECTS[routePath];
  const currentUrl = page.url();
  // Most routes never stream a redirect meta tag. Locator.getAttribute() waits for the element,
  // so checking count() first avoids a 30-second wait on every normal page.
  let content = null;
  if (!expected) {
    const meta = page.locator("meta#__next-page-redirect");
    if ((await meta.count()) === 0) return null;
    content = await meta.getAttribute("content", { timeout: 2_000 }).catch(() => null);
  }
  const target = expected ? new URL(expected.path, currentUrl) : parseNextRedirectMeta(content, currentUrl);
  if (!target) return null;
  if (!isLocalUrl(target.href, base)) return `Streamed redirect from ${routePath} left the isolated QA origin: ${target.origin}`;
  try {
    const destination = { origin: target.origin, pathname: target.pathname, search: target.search };
    // Poll the current document instead of waiting for a URL event. The streamed redirect can
    // land between a URL snapshot and Playwright registering its event listener.
    await page.waitForFunction(({ destination: targetUrl }) => {
      const current = new URL(window.location.href);
      return current.origin === targetUrl.origin && current.pathname === targetUrl.pathname && current.search === targetUrl.search;
    }, { destination }, { timeout: 20_000 });
    await page.waitForFunction(({ destination: targetUrl, title }) => {
      const current = new URL(window.location.href);
      if (current.origin !== targetUrl.origin || current.pathname !== targetUrl.pathname || current.search !== targetUrl.search) return false;
      const main = document.querySelector("main, [role=main]");
      const heading = main?.querySelector("h1, [role=heading][aria-level='1']");
      return !document.querySelector("meta#__next-page-redirect") && Boolean(heading) && (title ? document.title === title : Boolean(document.title));
    }, { destination, title: expected?.title ?? null }, { timeout: 30_000 });
    return null;
  } catch (error) {
    const reset = bucket?.failedRequests.find((request) => connectionFailure.test(request.error ?? ""));
    const network = reset ? `; ${reset.error} ${reset.url}` : "";
    return `Expected ${routePath} to finish at ${target.pathname}${target.search}: ${errText(error)}${network}`;
  }
}

/** One retry handles a local navigation interrupted by the isolated Next dev worker restarting. */
async function gotoQa(page, route, base, onRetry = () => {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return { response, retries: attempt };
    } catch (error) {
      const message = errText(error);
      if (attempt > 0 || !/timeout|net::ERR_CONNECTION|ERR_CONNECTION|ERR_ABORTED|ERR_NETWORK/i.test(message)) {
        return { error, retries: attempt };
      }
      if (!(await waitForQaServer(base))) return { error, retries: attempt };
      // Stop the old document and its in-flight chunk requests before starting the retry. This keeps stale
      // asset errors from a worker restart out of the successful retry's browser measurements.
      await page.goto("about:blank", { waitUntil: "load", timeout: 5_000 }).catch(() => {});
      onRetry();
    }
  }
  return { error: new Error(`Navigation failed for ${route}.`), retries: 1 };
}

const IN_PAGE_SCHEMES = new Set(["data:", "blob:", "about:"]);
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SOCKET_SCHEME = { "ws:": "http:", "wss:": "https:" };

/**
 * Requests the browser may make: the QA server itself (its scheme and port, on localhost, 127.0.0.1 or [::1], plus its WebSocket
 * scheme) and in-page data:, blob: and about: URLs. Every other origin, including another port on this machine, is blocked and reported.
 */
export function isLocalUrl(raw, base = CRM_QA_URL) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (IN_PAGE_SCHEMES.has(u.protocol)) return true;
  const b = new URL(base);
  const scheme = SOCKET_SCHEME[u.protocol] ?? u.protocol;
  return scheme === b.protocol && u.port === b.port && LOOPBACK_NAMES.has(u.hostname.toLowerCase());
}

/** The process exit code for a finished (or stopped) run. See the header for what each code means. */
export function exitCodeFor(totals, fatal) {
  if (totals.external || totals.serverErrors) return 1;
  if (fatal) return 2;
  if (totals.interactionsFailed) return 3;
  if (["httpErrors", "notRendered", "pageErrors", "consoleErrors", "failedRequests", "overflow", "axeViolations", "axeErrors", "screenshotFailures"]
    .some((key) => Number(totals[key] ?? 0) > 0)) return 4;
  return 0;
}

/** --only: a case-insensitive substring, or a /regex/. No patterns: everything matches. */
export function matchesOnly(patterns, key) {
  if (!patterns || !patterns.length) return true;
  return patterns.some((p) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (m) return new RegExp(m[1], m[2].includes("i") ? m[2] : `${m[2]}i`).test(key);
    return key.toLowerCase().includes(p.toLowerCase());
  });
}

/** A file-name-safe slug for a route; record ids become their labels ("contact", "c1") so names stay stable across seeds. */
export function routeSlug(routePath, labels = {}) {
  let p = String(routePath);
  for (const [id, label] of Object.entries(labels)) if (id) p = p.split(id).join(label);
  p = p.replace(UUID_RE, "id");
  const slug = p.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return slug || "home";
}

/** The CRM paths a navigation section lists, for one base ("/crm" or an agency mirror base). External items are client-only. */
export function navPaths(nav, base, opts = { external: true }) {
  const out = [];
  for (const section of nav) {
    for (const item of section.items) {
      if (item.external) {
        if (opts.external) out.push(item.path);
      } else out.push(`${base}${item.path}`);
    }
  }
  return [...new Set(out)];
}

/** Reads CRM_NAV from src/lib/crm/nav.ts without TypeScript tooling: path, external flag, in order. */
export function parseNavSource(src) {
  const sections = [];
  const re = /\{\s*path:\s*"([^"]*)"[^}]*?\}/g;
  const items = [];
  let m;
  while ((m = re.exec(src))) items.push({ path: m[1], external: /external:\s*true/.test(m[0]) });
  sections.push({ key: "all", items });
  return sections;
}

const impactOrder = ["critical", "serious", "moderate", "minor"];

/** Every interaction, by role, in the order they run (names are what --only "interaction:<name>" matches). */
export const INTERACTIONS = {
  owner: ["create a contact", "add a tag", "move a deal with the keyboard on the board", "open an inbox thread", "open the setup guide and move one step", "open the GoHighLevel migration panel (not connected)", "open the provider-switch wizard preview", "the submitted form contact appears for the owner"],
  sales_rep: ["sales rep: owner-only settings and import/export actions are protected"],
  public: ["book on the public booking page", "submit the public form"],
  agency_admin: ["start a support session (reason form)", "run the apply-wizard dry run (never confirmed)"],
  agency_staff: ["agency staff: assigned client allowed, other client refused"],
};

/** One row per role and route, across every width and theme that ran. */
export function summarize(visits) {
  const rows = new Map();
  for (const v of visits) {
    const k = `${v.role} ${v.slug ?? v.route}`;
    const r = rows.get(k) ?? { role: v.role, route: v.note ? `${v.route} (${v.note})` : v.route, slug: v.slug, statuses: new Set(), rendered: true, consoleErrors: 0, pageErrors: 0, failedRequests: 0, external: 0, serverErrors: 0, overflow: 0, axe: { critical: 0, serious: 0, moderate: 0, minor: 0 }, axeRules: new Set(), finalUrls: new Set(), passes: 0 };
    r.passes++;
    r.statuses.add(v.status ?? "error");
    if (v.finalPath && v.finalPath !== v.route) r.finalUrls.add(v.finalPath);
    if (!v.rendered?.ok) r.rendered = false;
    r.consoleErrors = Math.max(r.consoleErrors, v.consoleErrors?.length ?? 0);
    r.pageErrors = Math.max(r.pageErrors, v.pageErrors?.length ?? 0);
    r.failedRequests = Math.max(r.failedRequests, v.failedRequests?.length ?? 0);
    r.external += v.externalRequests?.length ?? 0;
    r.serverErrors += (v.serverErrors?.length ?? 0) + (typeof v.status === "number" && v.status >= 500 ? 1 : 0);
    if (v.overflow?.overflowing) r.overflow = Math.max(r.overflow, v.overflow.by);
    for (const a of v.axe?.violations ?? []) r.axeRules.add(`${a.id}${a.impact ? ` (${a.impact})` : ""}`);
    rows.set(k, r);
  }
  // axe columns count distinct rules per impact across the passes, not every node or pass.
  for (const r of rows.values()) {
    const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const rule of r.axeRules) {
      const imp = /\((\w+)\)$/.exec(rule)?.[1];
      if (imp && byImpact[imp] !== undefined) byImpact[imp]++;
    }
    r.axe = byImpact;
  }
  return [...rows.values()].map((r) => ({ ...r, statuses: [...r.statuses], axeRules: [...r.axeRules].sort(), finalUrls: [...r.finalUrls] }));
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The Markdown report: what ran, what failed, a table per route, the interactions and the most common axe rules. */
export function buildMarkdown(report) {
  const rows = summarize(report.visits);
  const lines = [];
  lines.push("# Native CRM browser QA", "");
  lines.push(`Run ${report.startedAt} to ${report.finishedAt ?? "(stopped)"} against ${report.base}. Widths: ${report.options.viewports.map((v) => `${v.width}x${v.height}`).join(", ")}. Themes: ${report.options.themes.join(", ")}. axe: ${report.options.axe ? "on" : "off"}.`, "");
  const t = report.totals;
  lines.push(`**${t.visits} page loads, ${rows.length} routes.** Non-localhost requests: **${t.external}**. 5xx: **${t.serverErrors}**. Not rendered: ${t.notRendered}. Page errors: ${t.pageErrors}. Console errors: ${t.consoleErrors}. Failed requests: ${t.failedRequests}. Overflow at phone width: ${t.overflow}. Interactions: ${t.interactionsPassed} passed, ${t.interactionsFailed} failed, ${t.interactionsSkipped} skipped.`, "");
  if (report.fatal) lines.push(`> The run stopped early: ${report.fatal}`, "");
  lines.push("## Routes", "", "| Role | Route | Status | Rendered | Console err | Page err | Failed req | External | 5xx | Overflow @phone | axe crit/ser/mod/min | Ended at |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| ${cell(r.role)} | ${cell(r.route)} | ${cell(r.statuses.join(", "))} | ${r.rendered ? "yes" : "**no**"} | ${r.consoleErrors} | ${r.pageErrors} | ${r.failedRequests} | ${r.external ? `**${r.external}**` : 0} | ${r.serverErrors ? `**${r.serverErrors}**` : 0} | ${r.overflow ? `${r.overflow}px` : "-"} | ${r.axe.critical}/${r.axe.serious}/${r.axe.moderate}/${r.axe.minor} | ${cell(r.finalUrls.join(", "))} |`);
  }
  lines.push("", "## Interactions", "", "| Role | Interaction | Result | Detail | Screenshot |", "|---|---|---|---|---|");
  for (const i of report.interactions) lines.push(`| ${cell(i.role)} | ${cell(i.name)} | ${i.result === "pass" ? "pass" : i.result === "skip" ? "skipped" : "**fail**"} | ${cell(i.detail)} | ${cell(i.screenshot ? path.basename(i.screenshot) : "")} |`);
  const rules = new Map();
  for (const v of report.visits) for (const a of v.axe?.violations ?? []) {
    const r = rules.get(a.id) ?? { id: a.id, impact: a.impact, help: a.help, pages: new Set() };
    r.pages.add(`${v.role} ${v.route}`);
    rules.set(a.id, r);
  }
  if (rules.size) {
    lines.push("", "## axe rules", "", "| Rule | Impact | Routes | Help |", "|---|---|---|---|");
    for (const r of [...rules.values()].sort((a, b) => impactOrder.indexOf(a.impact) - impactOrder.indexOf(b.impact) || b.pages.size - a.pages.size)) lines.push(`| ${cell(r.id)} | ${cell(r.impact)} | ${r.pages.size} | ${cell(r.help)} |`);
  }
  const problems = report.visits.filter((v) =>
    !v.rendered?.ok || v.pageErrors?.length || v.consoleErrors?.length || v.failedRequests?.length || v.externalRequests?.length ||
    v.serverErrors?.length || (v.status ?? 0) >= 400 || v.error || v.screenshotError || v.overflow?.overflowing || v.axe?.error || v.axe?.violations?.length
  );
  if (problems.length) {
    lines.push("", "## Problem details", "");
    for (const v of problems.slice(0, 150)) {
      const bits = [];
      if (v.status >= 400 && v.status < 500) bits.push("HTTP " + v.status);
      if (v.consoleErrors?.length) bits.push("console errors: " + v.consoleErrors.slice(0, 3).join(" / "));
      if (v.failedRequests?.length) bits.push("failed requests: " + v.failedRequests.slice(0, 3).map((e) => e.url + " (" + e.error + ")").join(" / "));
      if (v.overflow?.overflowing) bits.push("horizontal overflow: " + v.overflow.by + "px");
      if (v.axe?.error) bits.push("axe failed: " + v.axe.error);
      if (v.axe?.violations?.length) bits.push("axe violations: " + v.axe.violations.map((a) => a.id).join(", "));
      if (v.screenshotError) bits.push("screenshot failed: " + v.screenshotError);
      if (v.error) bits.push(`load error: ${v.error}`);
      if (!v.rendered?.ok) bits.push(`not rendered (${v.rendered?.reasons?.join(", ") ?? "unknown"})`);
      if (v.pageErrors?.length) bits.push(`page errors: ${v.pageErrors.slice(0, 3).join(" / ")}`);
      if (v.serverErrors?.length) bits.push(`5xx: ${v.serverErrors.slice(0, 3).map((e) => `${e.status} ${e.url}`).join(", ")}`);
      if (v.externalRequests?.length) bits.push(`external: ${v.externalRequests.slice(0, 5).join(", ")}`);
      lines.push(`- ${v.role} ${v.route} @${v.width} ${v.theme}: ${cell(bits.join("; "))}`);
    }
  }
  if (report.notes.length) lines.push("", "## Notes", "", ...report.notes.map((n) => `- ${n}`));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function expandEnvRefs(p) {
  return String(p).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, k) => process.env[k] ?? `%${k}%`).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => process.env[k] ?? m);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const entry = process.env.PLAYWRIGHT_MODULE;
    if (!entry) throw new Error("Playwright isn't installed here. Set PLAYWRIGHT_MODULE to an installed playwright/index.mjs.");
    return import(pathToFileURL(expandEnvRefs(entry)).href);
  }
}

async function loadNav() {
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, "src/lib/crm/nav.ts")).href);
    if (Array.isArray(mod.CRM_NAV)) return mod.CRM_NAV;
  } catch {
    /* No TypeScript loader for this file: read the source instead. */
  }
  return parseNavSource(fs.readFileSync(path.join(ROOT, "src/lib/crm/nav.ts"), "utf8"));
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${what} not found at ${path.relative(ROOT, file)}. Seed first: node scripts/run-crm-qa-seed.mjs (with the QA server stopped).`);
  }
}

const errText = (e) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/** Every route each role visits, built from the seed's ids and the CRM navigation. */
function buildPlan(seed, nav) {
  const b = seed.clients.brightside;
  const ids = b.ids;
  const c1 = b.id;
  const c2 = seed.clients.haven.id;
  const g = seed.clients.ghl.id;
  const bp = seed.blueprints.capturedId ?? seed.blueprints.starterId;
  const labels = {
    [c1]: "c1", [c2]: "c2", [g]: "ghl", [ids.contact]: "contact", [ids.company]: "company", [ids.deal]: "deal", [ids.calendar]: "calendar", [ids.form]: "form",
    [ids.workflow]: "workflow", [ids.campaign]: "campaign", [ids.pipeline]: "jobs", [seed.blueprints.starterId]: "starter", [seed.blueprints.capturedId]: "captured", [b.slug]: "brightside",
  };
  const r = (p) => ({ path: p, slug: routeSlug(p, labels) });
  const has = (v) => typeof v === "string" && v.length > 0;
  const owner = [
    ...navPaths(nav, "/crm"),
    "/overview", "/inbox", "/appointments", "/crm/settings",
    ...(has(ids.contact) ? [`/crm/contacts/${ids.contact}`] : []),
    ...(has(ids.company) ? [`/crm/companies/${ids.company}`] : []),
    ...(has(ids.deal) ? [`/crm/opportunities/${ids.deal}`] : []),
    ...(has(ids.pipeline) ? [`/crm/pipelines?p=${ids.pipeline}&closed=90`] : []),
    ...(has(ids.calendar) ? [`/crm/calendars/${ids.calendar}`] : []),
    ...(has(ids.form) ? [`/crm/forms/${ids.form}`] : []),
    ...(has(ids.workflow) ? [`/crm/workflows/${ids.workflow}`] : []),
    ...(has(ids.campaign) ? [`/crm/campaigns/${ids.campaign}`] : []),
  ];
  const rep = ["/overview", "/crm", "/crm/contacts", "/crm/pipelines", "/crm/tasks", "/crm/workflows", "/crm/campaigns", "/crm/settings/permissions", "/crm/settings/api", "/crm/settings/data", "/crm/settings/provider"];
  const ghl = ["/overview", "/crm", "/crm/contacts", "/crm/pipelines", "/crm/calendar", "/crm/workflows", "/crm/settings/provider", "/crm/settings/data", "/crm/setup"];
  const pub = [
    ...(has(ids.calendarSlug) ? [`/book/${b.slug}/${ids.calendarSlug}`] : []),
    ...(has(ids.calendarSlug) && has(ids.appointmentTypeSlug) ? [`/book/${b.slug}/${ids.calendarSlug}/${ids.appointmentTypeSlug}`] : []),
    ...(has(ids.formKey) ? [`/f/${b.slug}/${ids.formKey}`] : []),
  ];
  const admin = [
    "/admin", "/admin/clients", `/admin/clients/${c1}`, `/admin/clients/${c1}/setup`, `/admin/clients/${g}`, "/admin/crm",
    "/admin/crm-blueprints", `/admin/crm-blueprints?client=${c2}`,
    ...(seed.blueprints.starterId ? ["overview", "assets", "versions", "applications", "details"].map((tab) => `/admin/crm-blueprints/${seed.blueprints.starterId}?tab=${tab}`) : []),
    ...(seed.blueprints.capturedId ? [`/admin/crm-blueprints/${seed.blueprints.capturedId}`] : []),
    ...(bp ? [`/admin/crm-blueprints/${bp}/apply?client=${c2}`] : []),
    "/admin/crm-blueprints/import", "/admin/crm-blueprints/imports", "/admin/crm-blueprints/applications",
  ];
  const mirrorBase = `/admin/clients/${c1}/crm`;
  const mirror = [
    ...["", "/setup", "/contacts", "/companies", "/pipelines", "/opportunities", "/tasks", "/calendar", "/appointments", "/forms", "/templates", "/workflows", "/reports", "/settings/provider", "/settings/data", "/settings/blueprints", "/settings/access"].map((p) => `${mirrorBase}${p}`),
    ...(has(ids.contact) ? [`${mirrorBase}/contacts/${ids.contact}`] : []),
  ];
  const staff = ["/admin", "/admin/clients", `/admin/clients/${c1}`, `/admin/clients/${c1}/crm`, `/admin/clients/${c2}`, `/admin/clients/${c2}/crm`];
  return {
    labels,
    sweeps: [
      { role: "owner", routes: [...new Set(owner)].map(r) },
      { role: "sales_rep", routes: rep.map(r) },
      { role: "ghl_owner", routes: ghl.map(r) },
      { role: "public", routes: pub.map(r) },
      // The agency CRM mirror opens on the support-session form first; the same address shows the CRM once a session is open.
      { role: "agency_admin", routes: [...admin.map(r), { ...r(`/admin/clients/${c1}/crm`), slug: `${routeSlug(`/admin/clients/${c1}/crm`, labels)}-gate`, note: "before the support session" }], afterSession: mirror.map(r) },
      { role: "agency_staff", routes: staff.map(r) },
    ],
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = assertBaseUrl(opts.base ?? process.env.CRM_QA_URL ?? CRM_QA_URL);
  const seed = readJson(path.join(DATA, "seed-summary.json"), "The seed summary");
  const creds = readJson(path.join(DATA, "credentials.local.json"), "The QA credentials");
  if (!seed.complete) throw new Error("The seed did not finish. Stop the server, delete .data/crm-qa and seed again.");
  const nav = await loadNav();
  const plan = buildPlan(seed, nav);
  if (opts.list) {
    for (const s of plan.sweeps) {
      if (opts.roles && !opts.roles.includes(s.role)) continue;
      for (const r of [...s.routes, ...(s.afterSession ?? [])]) if (matchesOnly(opts.only, `${s.role}:${r.path}`)) console.log(`${s.role}:${r.path}  -> ${s.role}-${r.slug}-<width>-<theme>.png`);
      for (const name of INTERACTIONS[s.role] ?? []) if (opts.interactions && matchesOnly(opts.only, `interaction:${name}`)) console.log(`interaction:${name}  (${s.role})`);
    }
    return;
  }
  const pw = await loadPlaywright();
  fs.mkdirSync(SCREENS, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const axeSource = opts.axe ? fs.readFileSync(AXE_PATH, "utf8") : "";

  const report = {
    base, startedAt: new Date().toISOString(), finishedAt: null, options: opts, playwright: null, visits: [], interactions: [], blockedExternal: [], notes: [], fatal: null,
    totals: {},
  };
  const persist = () => {
    const v = report.visits;
    const it = report.interactions;
    report.totals = {
      visits: v.length,
      external: report.blockedExternal.length,
      serverErrors: v.reduce((n, x) => n + (x.serverErrors?.length ?? 0) + (typeof x.status === "number" && x.status >= 500 ? 1 : 0), 0) + it.filter((i) => i.serverError).length,
      notRendered: v.filter((x) => !x.rendered?.ok).length,
      pageErrors: v.reduce((n, x) => n + (x.pageErrors?.length ?? 0), 0),
      consoleErrors: v.reduce((n, x) => n + (x.consoleErrors?.length ?? 0), 0),
      failedRequests: v.reduce((n, x) => n + (x.failedRequests?.length ?? 0), 0),
      overflow: v.filter((x) => x.overflow?.overflowing).length,
      httpErrors: v.filter((x) => typeof x.status === "number" && x.status >= 400).length,
      axeViolations: v.reduce((n, x) => n + (x.axe?.violations?.length ?? 0), 0),
      axeErrors: v.filter((x) => Boolean(x.axe?.error)).length,
      screenshotFailures: v.filter((x) => Boolean(x.screenshotError)).length + it.filter((x) => x.result !== "skip" && !x.screenshot).length,
      interactionsPassed: it.filter((i) => i.result === "pass").length,
      interactionsFailed: it.filter((i) => i.result === "fail").length,
      interactionsSkipped: it.filter((i) => i.result === "skip").length,
    };
    fs.writeFileSync(path.join(DATA, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(DATA, "report.md"), buildMarkdown(report));
  };
  process.on("SIGINT", () => {
    report.fatal = "Interrupted.";
    persist();
    process.exit(130);
  });

  const browser = await pw.chromium.launch({ headless: !opts.headed });
  report.playwright = browser.version();
  const contexts = new Map();

  /** One browser context per person, signed in through the real local sign-in page (the session is reused between runs). */
  async function contextFor(role) {
    if (contexts.has(role)) return contexts.get(role);
    const statePath = path.join(AUTH_DIR, `${role}.json`);
    const user = role === "public" ? null : creds.users?.[role];
    if (role !== "public" && !user) throw new Error(`No QA account for ${role} in the credentials file.`);
    const context = await browser.newContext({
      // Pin this to avoid Motion's dev-only reduced-motion warning being mistaken for a rendered-page failure. settle() injects
      // NO_MOTION before captures, so screenshots remain still; reduced-motion behavior is not claimed by this browser pass.
      baseURL: base, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: "no-preference", locale: "en-US", timezoneId: "America/Chicago",
      ...(user && fs.existsSync(statePath) ? { storageState: statePath } : {}),
    });
    const rec = { role, context, page: null, bucket: null };
    // The browser talks to the QA server only: requests and sockets to any other origin (another localhost port too) are blocked
    // here, before the network, and recorded.
    await context.route((url) => !isLocalUrl(url.href, base), async (route) => {
      const u = route.request().url();
      report.blockedExternal.push({ role, url: u, from: rec.page?.url() ?? null });
      rec.bucket?.externalRequests.push(u);
      await route.abort("blockedbyclient").catch(() => {});
    });
    await context.routeWebSocket((url) => !isLocalUrl(url.href, base), (ws) => {
      report.blockedExternal.push({ role, url: ws.url(), from: rec.page?.url() ?? null, websocket: true });
      rec.bucket?.externalRequests.push(ws.url());
      ws.close();
    });
    // The dev server's hot-reload socket is answered by a silent stand-in, so another agent's edit can't reload a page mid-measurement.
    if (!opts.liveHmr) await context.routeWebSocket(/\/_next\/webpack-hmr/, () => {});
    const page = await context.newPage();
    rec.page = page;
    page.on("console", (m) => { if (m.type() === "error") rec.bucket?.consoleErrors.push(m.text().slice(0, 4_000)); });
    page.on("pageerror", (e) => rec.bucket?.pageErrors.push((e.message || String(e)).slice(0, 4_000)));
    page.on("requestfailed", (req) => {
      if (!isLocalUrl(req.url(), base)) return; // blocked above and already counted as external
      const f = req.failure()?.errorText ?? "failed";
      if (/ERR_ABORTED/.test(f)) { if (rec.bucket) rec.bucket.aborted++; } else rec.bucket?.failedRequests.push({ url: req.url().replace(base, ""), error: f });
    });
    page.on("response", (res) => {
      if (res.status() >= 500) rec.bucket?.serverErrors.push({ url: res.url().replace(base, ""), status: res.status() });
    });
    if (user) await signIn(rec, user, statePath);
    contexts.set(role, rec);
    return rec;
  }

  /** Polls until the element is enabled; false when it is still disabled after `ms`. */
  async function enabledWithin(locator, ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (await locator.isEnabled().catch(() => false)) return true;
      if (Date.now() >= end) return false;
      await locator.page().waitForTimeout(150);
    }
  }

  async function signIn(rec, user, statePath) {
    const { page, context } = rec;
    // Keep the global first-run tour from covering every CRM screenshot and axe scan. This is browser-local
    // state only; the isolated QA database and product code stay untouched.
    await context.addInitScript(() => {
      try { localStorage.setItem("iaq-tour-v1", "done"); } catch { /* storage unavailable */ }
    });
    const initialNavigation = await gotoQa(page, "/login", base, () => console.log(`navigation retry  ${rec.role} /login after QA server restart`));
    if (initialNavigation.error) throw new Error(`Could not open local sign-in page: ${errText(initialNavigation.error)}`);
    if (!new URL(page.url()).pathname.startsWith("/login")) return; // the saved session is still good
    // The Sign in button enables only from React's onChange, and React does not replay input typed before hydration (in dev the
    // app-router chunks load after DOMContentLoaded). So wait until React has hydrated the email field (it then carries React's
    // __reactProps$ key), type, and make sure the button enabled; if it didn't, clear both fields and type again, key by key.
    await page.waitForFunction(() => {
      const el = document.querySelector("#email");
      return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    }, null, { timeout: 120_000 }).catch(() => {});
    const email = page.locator("#email");
    const password = page.locator("#password");
    const submit = page.locator("form button[type=submit]").first();
    let ready = false;
    for (let attempt = 0; attempt < 4 && !ready; attempt++) {
      if (attempt === 0) {
        await email.fill(user.email);
        await password.fill(user.password);
      } else {
        await email.fill("");
        await password.fill("");
        await email.pressSequentially(user.email, { delay: 15 });
        await password.pressSequentially(user.password, { delay: 15 });
      }
      ready = await enabledWithin(submit, attempt === 0 ? 3_000 : 10_000);
    }
    if (!ready) throw new Error(`Sign-in failed for ${rec.role}: the Sign in button stayed disabled after typing (the page may not have hydrated)`);
    await submit.click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }).catch(() => {});
    if (new URL(page.url()).pathname.startsWith("/login")) {
      const msg = (await page.locator("[role=alert]").first().textContent().catch(() => "")) || "still on the sign-in page";
      throw new Error(`Sign-in failed for ${rec.role}: ${msg.trim().slice(0, 200)}`);
    }
    await context.storageState({ path: statePath });
  }

  const newBucket = () => ({ consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [], serverErrors: [], aborted: 0 });

  async function setMode(rec, vp, theme) {
    await rec.page.setViewportSize({ width: vp.width, height: vp.height });
    // The theme the app reads before its first paint (localStorage 'iaq-theme'), set before every load from now on.
    await rec.context.addInitScript((t) => { try { localStorage.setItem("iaq-theme", t); } catch { /* storage blocked */ } }, theme);
  }

  async function settle(page) {
    // This app keeps local polling and the dev HMR connection open, so networkidle is not a
    // useful readiness signal and can add 15 seconds to every route. Wait for React to attach
    // props, for the route heading to replace any streamed loading fallback, and for that state
    // to stay stable briefly. The App Router can insert its loading.tsx fallback after the first
    // document has hydrated, so a one-time readiness check can otherwise capture a skeleton.
    const hydrated = await page.waitForFunction(() => {
      const root = document.querySelector("main, [role=main]");
      if (!root) return false;
      // Nested controls may use aria-busy while the route itself is already usable. Only the
      // explicit route loading fallbacks should hold page readiness open.
      const loadingFallback = '[role="status"][aria-busy="true"][aria-label^="Loading"]';
      const hasReactProps = (el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"));
      const fallbackVisible = root.matches(loadingFallback) || root.querySelector(loadingFallback);
      const hydratedRoot = hasReactProps(root) || [...root.querySelectorAll("*")].some(hasReactProps);
      const hasHeading = Boolean(root.querySelector("h1, [role=heading][aria-level='1']"));
      if (fallbackVisible || !hydratedRoot || !hasHeading) {
        window.__crmQaReadySince = null;
        return false;
      }
      const now = performance.now();
      if (typeof window.__crmQaReadySince !== "number") {
        window.__crmQaReadySince = now;
        return false;
      }
      return now - window.__crmQaReadySince >= 500;
    }, null, { timeout: 15_000 }).then(() => true).catch(() => false);
    await page.addStyleTag({ content: NO_MOTION }).catch(() => {});
    const fontsReady = await page.evaluate(() => document.fonts ? Promise.race([
      document.fonts.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]) : true).catch(() => false);
    await page.waitForTimeout(250);
    return { hydrated, fontsReady };
  }

  async function measure(page, phone) {
    return page.evaluate((phoneWidth) => {
      const portal = document.querySelector("nextjs-portal");
      const shadow = portal && portal.shadowRoot;
      const overlay = Boolean(shadow && [...shadow.querySelectorAll("[data-nextjs-dialog], [data-nextjs-dialog-overlay]")].some((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      }));
      const issues = shadow && shadow.querySelector("[data-issues-count]");
      const text = document.body ? document.body.innerText : "";
      const appError = /Application error: a (client|server)-side exception/i.test(text);
      const landmark = Boolean(document.querySelector("main, [role=main]"));
      const h1 = document.querySelector("h1");
      const stillLoading = Boolean(document.querySelector('main [role="status"][aria-busy="true"][aria-label^="Loading"], [role=main] [role="status"][aria-busy="true"][aria-label^="Loading"]'));
      const notFound = /could not be found|page not found/i.test(text.slice(0, 2000)) || /404/.test(document.title);
      const reasons = [];
      if (overlay) reasons.push("Next error overlay");
      if (appError) reasons.push("Application error");
      if (stillLoading) reasons.push("page still loading");
      if (notFound) reasons.push("page not found");
      if (!landmark && !h1) reasons.push("no main landmark or h1");
      let overflow = null;
      if (phoneWidth) {
        const vw = window.innerWidth;
        const documentScrollWidth = document.documentElement.scrollWidth;
        const sw = document.body?.scrollWidth ?? documentScrollWidth;
        const describe = (el) => {
          const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c.replace(/[^\w-]/g, "\\$&")}`).join("") : "";
          return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
        };
        const clipped = (el) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.overflowX !== "visible" && p.getBoundingClientRect().right <= vw + 1) return true;
          }
          return false;
        };
        const offenders = [];
        if (sw > vw + 1 || documentScrollWidth > vw + 1) {
          const all = document.body ? document.body.querySelectorAll("*") : [];
          const hits = new Set();
          for (const el of all) {
            if (el.closest("nextjs-portal")) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.right > vw + 1 && !clipped(el)) hits.add(el);
          }
          for (const el of hits) {
            if (el.parentElement && hits.has(el.parentElement)) continue; // report the outermost element only
            const r = el.getBoundingClientRect();
            offenders.push({ element: describe(el), right: Math.round(r.right), width: Math.round(r.width), text: (el.textContent || "").trim().slice(0, 60) });
            if (offenders.length >= 12) break;
          }
        }
        overflow = {
          overflowing: sw > vw + 1 || offenders.length > 0,
          by: Math.max(0, sw - vw),
          scrollWidth: sw,
          documentScrollWidth,
          innerWidth: vw,
          bodyScrollWidth: document.body?.scrollWidth ?? null,
          mainScrollWidth: document.querySelector("main, [role=main]")?.scrollWidth ?? null,
          mainClientWidth: document.querySelector("main, [role=main]")?.clientWidth ?? null,
          offenders,
        };
      }
      return {
        ok: reasons.length === 0, reasons, overlay, devIssues: issues ? (issues.textContent || "").trim() : null, appError, landmark, h1: h1 ? (h1.textContent || "").trim().slice(0, 120) : null,
        notFound, title: document.title.slice(0, 120), theme: document.documentElement.dataset.theme ?? null, overflow,
      };
    }, phone);
  }

  async function runAxe(page) {
    let method = "addScriptTag";
    try {
      await page.addScriptTag({ path: AXE_PATH });
    } catch {
      /* the page's script policy may refuse an injected tag */
    }
    if (!(await page.evaluate(() => typeof window.axe !== "undefined").catch(() => false))) {
      method = "evaluate";
      await page.evaluate(`(() => { ${axeSource}\n; return typeof window.axe; })()`);
    }
    const violations = await page.evaluate(async () => {
      const res = await window.axe.run(document, { resultTypes: ["violations"] });
      return res.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 5).map((n) => ({
          target: n.target.join(" "),
          html: n.html.slice(0, 500),
          failureSummary: n.failureSummary?.slice(0, 1000) ?? null,
        })),
      }));
    });
    return { method, violations };
  }

  async function visit(rec, route, vp, theme) {
    const { page } = rec;
    const v = { role: rec.role, route: route.path, slug: route.slug, ...(route.note ? { note: route.note } : {}), width: vp.width, theme, status: null, finalPath: null, ms: 0 };
    rec.bucket = newBucket();
    const t0 = Date.now();
    try {
      const navigation = await gotoQa(page, route.path, base, () => {
        const bucket = rec.bucket;
        // Discard only network/chunk noise from a confirmed connection reset.
        if (bucket?.failedRequests.some((request) => connectionFailure.test(request.error))) clearDevRestartNoise(bucket, { clearConnections: true });
        console.log(`navigation retry  ${rec.role} ${route.path} after QA server restart`);
      });
      v.navigationRetries = navigation.retries;
      if (navigation.error) throw navigation.error;
      v.status = navigation.response ? navigation.response.status() : null;
    } catch (e) {
      v.error = errText(e);
    }
    const redirectError = await waitForNextRedirect(page, route.path, base, rec.bucket);
    if (redirectError) v.error = redirectError;
    let readiness = await settle(page);
    if (!v.error) {
      // Streamed App Router redirects can arrive after DOMContentLoaded. Recheck once the
      // destination has had time to render, then capture the final page instead of the meta tag.
      const settledRedirectError = await waitForNextRedirect(page, route.path, base, rec.bucket);
      if (settledRedirectError) v.error = settledRedirectError;
    }
    if (isDevRestartInterruption(rec.bucket, v.error ?? "") && await waitForQaServer(base)) {
      // Only a confirmed dev-server connection/chunk failure is discarded. The retried document
      // gets a fresh measurement, while any unrelated errors from the first attempt stay visible.
      await page.goto("about:blank", { waitUntil: "load", timeout: 5_000 }).catch(() => {});
      clearDevRestartNoise(rec.bucket, { clearConnections: true });
      const retry = await gotoQa(page, route.path, base, () => {
        clearDevRestartNoise(rec.bucket, { clearConnections: true });
        console.log(`chunk retry  ${rec.role} ${route.path} after QA server restart`);
      });
      v.chunkRetries = 1;
      if (retry.error) v.error = errText(retry.error);
      else {
        v.status = retry.response ? retry.response.status() : null;
        v.error = undefined;
      }
      const retryRedirectError = await waitForNextRedirect(page, route.path, base, rec.bucket);
      if (retryRedirectError) v.error = retryRedirectError;
      readiness = await settle(page);
      if (!v.error) {
        const settledRetryRedirectError = await waitForNextRedirect(page, route.path, base, rec.bucket);
        if (settledRetryRedirectError) v.error = settledRetryRedirectError;
      }
    }
    v.readiness = readiness;
    v.ms = Date.now() - t0;
    try {
      const u = new URL(page.url());
      v.finalPath = `${u.pathname}${u.search}`;
    } catch {
      v.finalPath = null;
    }
    try {
      let m;
      try {
        m = await measure(page, vp.width < 768);
      } catch (e) {
        if (!/Execution context was destroyed|Cannot find context with specified id|frame was detached/i.test(errText(e))) throw e;
        // A Next client navigation can replace the document between settle() and this read. Wait for the new document, then
        // measure that stable page once; a second failure remains visible as a real inspection failure.
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(250);
        v.measureRetries = 1;
        m = await measure(page, vp.width < 768);
      }
      v.rendered = { ok: m.ok && !v.error, reasons: [...m.reasons, ...(v.error ? ["load error"] : [])], h1: m.h1, title: m.title, notFound: m.notFound, devIssues: m.devIssues, landmark: m.landmark };
      v.appliedTheme = m.theme;
      v.overflow = m.overflow;
    } catch (e) {
      v.rendered = { ok: false, reasons: [`could not inspect the page: ${errText(e)}`] };
    }
    v.screenshot = path.join(SCREENS, `${rec.role}-${route.slug}-${vp.width}-${theme}.png`);
    await page.screenshot({ path: v.screenshot, fullPage: true, caret: "initial", style: HIDE_DEV, timeout: 90_000 }).catch((e) => { v.screenshotError = errText(e); });
    // Stop collecting before axe is injected: the page's own script policy may report the injection, which isn't the page's fault.
    Object.assign(v, rec.bucket);
    rec.bucket = null;
    if (opts.axe) v.axe = await runAxe(page).catch((e) => ({ error: errText(e), violations: [] }));
    report.visits.push(v);
    const flag = [v.status ?? "ERR", v.rendered?.ok ? "" : "NOT-RENDERED", v.pageErrors.length ? `pageErr:${v.pageErrors.length}` : "", v.externalRequests.length ? `EXTERNAL:${v.externalRequests.length}` : "", v.serverErrors.length ? `5xx:${v.serverErrors.length}` : "", v.overflow?.overflowing ? `overflow:${v.overflow.by}px` : "", v.axe?.violations?.length ? `axe:${v.axe.violations.length}` : ""].filter(Boolean).join(" ");
    console.log(`${rec.role.padEnd(13)} ${String(vp.width).padStart(4)} ${theme.padEnd(5)} ${route.path}  ${flag}  ${v.ms}ms`);
    persist();
  }

  async function sweep(rec, routes) {
    const selected = routes.filter((r) => matchesOnly(opts.only, `${rec.role}:${r.path}`));
    if (!selected.length) return;
    for (const vp of opts.viewports) {
      for (const theme of opts.themes) {
        await setMode(rec, vp, theme);
        for (const route of selected) await visit(rec, route, vp, theme);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Interactions: each records pass, fail or skip, with a screenshot
  // ---------------------------------------------------------------------------

  const wantInteraction = (name) => opts.interactions && matchesOnly(opts.only, `interaction:${name}`);
  async function interaction(rec, name, fn) {
    if (!wantInteraction(name)) return null;
    await setMode(rec, { width: 1280, height: 800 }, "light");
    const r = { role: rec.role, name, result: "fail", detail: "", screenshot: null };
    rec.bucket = newBucket();
    try {
      const out = await fn(rec.page);
      r.result = out?.result ?? "pass";
      r.detail = out?.detail ?? "";
    } catch (e) {
      r.result = "fail";
      r.detail = errText(e);
    }
    const b = rec.bucket;
    rec.bucket = null;
    if (b.serverErrors.length) { r.serverError = true; r.detail += ` (5xx: ${b.serverErrors.map((s) => `${s.status} ${s.url}`).join(", ")})`; }
    if (b.externalRequests.length) r.detail += ` (blocked external: ${b.externalRequests.join(", ")})`;
    if (b.pageErrors.length) r.detail += ` (page errors: ${b.pageErrors.slice(0, 2).join(" / ")})`;
    r.screenshot = path.join(SCREENS, `interaction-${rec.role}-${routeSlug(name)}.png`);
    await rec.page.screenshot({ path: r.screenshot, fullPage: true, style: HIDE_DEV, timeout: 90_000 }).catch(() => { r.screenshot = null; });
    report.interactions.push(r);
    console.log(`interaction  ${rec.role.padEnd(13)} ${name}: ${r.result}${r.detail ? ` (${r.detail.slice(0, 160)})` : ""}`);
    persist();
    return r;
  }

  const go = async (page, p) => {
    const navigation = await gotoQa(page, p, base, () => {
      const bucket = [...contexts.values()].find((rec) => rec.page === page)?.bucket;
      if (bucket?.failedRequests.some((request) => connectionFailure.test(request.error))) clearDevRestartNoise(bucket, { clearConnections: true });
      console.log(`navigation retry  interaction ${p} after QA server restart`);
    });
    if (navigation.error) throw navigation.error;
    let res = navigation.response;
    const rec = [...contexts.values()].find((candidate) => candidate.page === page);
    let redirectError = rec ? await waitForNextRedirect(page, p, base, rec.bucket) : null;
    await settle(page);
    if (!redirectError && rec) redirectError = await waitForNextRedirect(page, p, base, rec.bucket);
    if (rec && isDevRestartInterruption(rec.bucket, redirectError ?? "")) {
      if (!(await waitForQaServer(base))) throw new Error("The isolated QA server did not recover from a connection reset.");
      await page.goto("about:blank", { waitUntil: "load", timeout: 5_000 }).catch(() => {});
      clearDevRestartNoise(rec.bucket, { clearConnections: true });
      const retry = await gotoQa(page, p, base, () => clearDevRestartNoise(rec.bucket, { clearConnections: true }));
      if (retry.error) throw retry.error;
      res = retry.response;
      redirectError = await waitForNextRedirect(page, p, base, rec.bucket);
      await settle(page);
      if (!redirectError) redirectError = await waitForNextRedirect(page, p, base, rec.bucket);
    }
    if (redirectError) throw new Error(redirectError);
    return res;
  };
  const runTag = Date.now().toString(36);
  const b = seed.clients.brightside;

  async function ownerInteractions(rec) {
    let created = null;
    await interaction(rec, "create a contact", async (page) => {
      await go(page, "/crm/contacts");
      await page.getByRole("button", { name: "New contact" }).click();
      await page.locator("#c-first").fill("Quinn");
      await page.locator("#c-last").fill(`Browser${runTag}`);
      await page.locator("#c-email").fill(`quinn.browser.${runTag}@example.test`);
      await page.getByRole("button", { name: "Add contact" }).click();
      await page.waitForURL(/\/crm\/contacts\/[0-9a-f-]{36}/, { timeout: 60_000 });
      created = new URL(page.url()).pathname;
      await settle(page);
      return { detail: `created ${created.replace(UUID_RE, "<id>")}` };
    });
    await interaction(rec, "add a tag", async (page) => {
      await go(page, created ?? `/crm/contacts/${b.ids.contact}`);
      const before = await page.locator("main").first().innerText();
      await page.getByRole("button", { name: "Tag", exact: true }).click();
      const item = page.getByRole("menuitem").first();
      const tagName = ((await item.textContent()) ?? "").trim();
      await item.click();
      await page.getByText(`Tagged ${tagName}.`).first().waitFor({ timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(800);
      const after = await page.locator("main").first().innerText();
      if (!tagName || (after.split(tagName).length <= before.split(tagName).length)) throw new Error(`the tag "${tagName}" did not appear on the contact`);
      return { detail: `tagged ${tagName}` };
    });
    await interaction(rec, "move a deal with the keyboard on the board", async (page) => {
      await go(page, "/crm/pipelines");
      const card = page.locator('ol[aria-label$="stages"] li[draggable="true"] a').first();
      await card.waitFor({ timeout: 30_000 });
      const name = ((await card.textContent()) ?? "").trim();
      await card.focus();
      await page.keyboard.press("Alt+ArrowRight");
      // The board announces the outcome in its live region.
      const announced = () => [...document.querySelectorAll("[aria-live]")].map((el) => (el.textContent || "").trim()).find((t) => /moved to|was not moved/.test(t)) || "";
      await page.waitForFunction(announced, null, { timeout: 30_000 });
      const said = await page.evaluate(announced);
      if (!/moved to/.test(said) || /was not moved/.test(said)) throw new Error(`board said: ${said || "nothing"}`);
      return { detail: `${name}: ${said}` };
    });
    await interaction(rec, "open an inbox thread", async (page) => {
      await go(page, "/inbox");
      const first = page.locator('ul[aria-label="Conversation list"] li').first().locator("a, button").first();
      await first.waitFor({ timeout: 30_000 });
      await first.click();
      const log = page.locator('[role="log"][aria-label="Messages"]').first();
      await log.waitFor({ timeout: 30_000 });
      await page.waitForFunction((el) => (el.textContent || "").trim().length > 10, await log.elementHandle(), { timeout: 30_000 });
      return { detail: `thread shows ${((await log.textContent()) ?? "").trim().slice(0, 60)}…` };
    });
    await interaction(rec, "open the setup guide and move one step", async (page) => {
      await go(page, "/crm/setup");
      const stepLine = page.locator("#crm-setup-step p").first();
      await stepLine.waitFor({ timeout: 30_000 });
      const before = ((await stepLine.textContent()) ?? "").trim();
      const nextBtn = page.getByRole("button", { name: /^Next:/ }).first();
      if (!(await nextBtn.count())) return { result: "skip", detail: `no Next button (${before})` };
      await nextBtn.click();
      await page.waitForFunction((args) => (document.querySelector("#crm-setup-step p")?.textContent || "").trim() !== args, before, { timeout: 20_000 });
      const after = ((await stepLine.textContent()) ?? "").trim();
      return { detail: `${before} -> ${after}` };
    });
    await interaction(rec, "open the GoHighLevel migration panel (not connected)", async (page) => {
      await go(page, "/crm/settings/data");
      const heading = page.getByRole("heading", { name: "Migrate from GoHighLevel" });
      await heading.waitFor({ timeout: 30_000 });
      await heading.scrollIntoViewIfNeeded();
      const notConnected = await page.getByText("Not connected", { exact: true }).count();
      if (!notConnected) throw new Error("the panel did not show its not-connected state");
      return { detail: "panel shown, not connected" };
    });
    await interaction(rec, "open the provider-switch wizard preview", async (page) => {
      const res = await go(page, "/crm/settings/provider");
      if (!res || res.status() === 404) return { result: "skip", detail: "Settings > CRM Provider answered 404 (the wizard may still be in development)" };
      const preview = page.getByRole("button", { name: /preview/i }).first();
      if (!(await preview.count())) return { result: "skip", detail: `no preview control on the provider page yet (status ${res.status()}); the wizard may still be in development` };
      if (await preview.isDisabled()) {
        const box = page.locator('main input[type="checkbox"]:not(:checked), main [role="checkbox"][aria-checked="false"]').first();
        if (await box.count()) await box.click();
      }
      if (await preview.isDisabled()) return { result: "skip", detail: "the preview button stays disabled (nothing chosen to preview)" };
      await preview.click();
      await page.waitForTimeout(3000);
      await settle(page);
      const bad = await measure(page, false);
      if (!bad.ok) throw new Error(`after preview: ${bad.reasons.join(", ")}`);
      return { detail: "preview opened (read-only)" };
    });
  }

  async function publicInteractions(rec, getOwner) {
    const ids = b.ids;
    if (ids.calendarSlug && ids.appointmentTypeSlug) {
      await interaction(rec, "book on the public booking page", async (page) => {
        await go(page, `/book/${b.slug}/${ids.calendarSlug}/${ids.appointmentTypeSlug}`);
        // Open days appear once the page has loaded its times; a month without any moves on to the next one.
        const open = page.locator('td[role="gridcell"] button[aria-disabled="false"]').first();
        for (let i = 0; i < 3; i++) {
          if (await open.waitFor({ timeout: 20_000 }).then(() => true, () => false)) break;
          const nextMonth = page.getByRole("button", { name: "Next month" });
          if (!(await nextMonth.count()) || (await nextMonth.isDisabled())) break;
          await nextMonth.click();
        }
        await open.waitFor({ timeout: 5_000 });
        await open.click();
        const time = page.locator('ul[aria-label^="Open times on"] button:not([disabled])').first();
        await time.waitFor({ timeout: 30_000 });
        const when = ((await time.textContent()) ?? "").trim();
        await time.click();
        await page.getByRole("button", { name: "Continue" }).click();
        await page.locator("#bf-name").fill("Quinn Booker (QA)");
        await page.locator("#bf-email").fill(`quinn.booker.${runTag}@example.test`);
        await page.locator("#bf-phone").fill("+15125550188");
        for (const sel of await page.locator('select[id^="bf-answers-"]').all()) await sel.selectOption({ index: 1 }).catch(() => {});
        for (const el of await page.locator('textarea[id^="bf-answers-"], input[id^="bf-answers-"]').all()) await el.fill("Park on the street, please.").catch(() => {});
        await page.getByRole("button", { name: "Review booking" }).click();
        await page.getByRole("button", { name: /^(Confirm booking|Request booking)$/ }).click();
        await page.waitForURL(/\/confirmed/, { timeout: 60_000 });
        await settle(page);
        return { detail: `booked ${when}` };
      });
    }
    if (ids.formKey) {
      const last = `Visitor${runTag}`;
      const email = `nora.${runTag}@example.test`;
      const sent = await interaction(rec, "submit the public form", async (page) => {
        await go(page, `/f/${b.slug}/${ids.formKey}`);
        const form = page.locator('form[action="/api/public/forms/submit"]');
        await form.waitFor({ timeout: 30_000 });
        for (const q of await form.locator("[data-q]").all()) {
          const key = (await q.getAttribute("data-q")) ?? "";
          if (await q.locator("select").count()) { await q.locator("select").first().selectOption({ index: 1 }); continue; }
          if (await q.locator('input[type="radio"]').count()) { await q.locator('input[type="radio"]').first().check(); continue; }
          if (await q.locator('input[type="checkbox"]').count()) { await q.locator('input[type="checkbox"]').first().check(); continue; }
          if (await q.locator("textarea").count()) { await q.locator("textarea").first().fill("Water stain on the ceiling after the storm."); continue; }
          const input = q.locator('input:not([type="hidden"])').first();
          if (!(await input.count())) continue;
          const type = (await input.getAttribute("type")) ?? "text";
          const value = key === "first_name" ? "Nora" : key === "last_name" ? last : type === "email" ? email : type === "tel" ? "+15125550189" : type === "number" ? "2" : type === "date" ? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) : key === "postal_code" ? "78701" : "QA answer";
          await input.fill(value);
        }
        const consent = form.locator('input[name="consent"]');
        if (await consent.count()) await consent.check();
        await page.waitForTimeout(4000); // the form's anti-spam token refuses answers sent within a couple of seconds of loading
        const answered = page.waitForResponse((r) => r.url().includes("/api/public/forms/submit") && r.request().method() === "POST", { timeout: 60_000 });
        await form.locator('button[type="submit"]').first().click();
        const res = await answered;
        if (res.status() >= 400) throw new Error(`the form answered ${res.status()}: ${(await res.text()).slice(0, 200)}`);
        await page.waitForTimeout(1500);
        return { detail: `sent (HTTP ${res.status()})` };
      });
      const ownerRec = sent?.result === "pass" && wantInteraction("the submitted form contact appears for the owner") ? await getOwner() : null;
      if (ownerRec) {
        await interaction(ownerRec, "the submitted form contact appears for the owner", async (page) => {
          const look = async () => {
            await go(page, `/crm/contacts?q=${encodeURIComponent(email)}`);
            return (await page.locator("main").first().innerText()).includes(last);
          };
          if (await look()) return { detail: "listed straight away" };
          await page.waitForTimeout(6000);
          if (await look()) return { detail: "listed after a few seconds" };
          if (!opts.tick) return { result: "skip", detail: "not listed yet: submissions are processed by the scheduler, which this harness doesn't run (--no-tick)" };
          // Form submissions are processed by the scheduled worker. Ask this local server to run it once (local-only secret, localhost only).
          const tick = await fetch(`${base}/api/internal/tick`, { method: "POST", headers: { authorization: `Bearer ${CRM_QA_ENV.CRON_SECRET}` } });
          if (!tick.ok) throw new Error(`the local worker endpoint answered ${tick.status}`);
          report.notes.push("The form-submission check asked the local QA server to run its scheduled jobs once (POST /api/internal/tick on localhost with the local-only CRON_SECRET).");
          if (await look()) return { detail: "listed after the local worker processed the submission" };
          throw new Error("the new contact is not listed for the owner");
        });
      }
    }
  }

  async function startSupportSession(rec) {
    let started = false;
    await interaction(rec, "start a support session (reason form)", async (page) => {
      await go(page, `/admin/clients/${b.id}/crm`);
      const reason = page.locator("#sup-reason");
      if (!(await reason.count())) {
        started = true;
        return { detail: "a session was already open (from an earlier run)" };
      }
      await reason.fill("Local browser QA of the CRM screens (isolated QA harness).");
      await page.getByRole("button", { name: "Open CRM" }).click();
      await page.waitForFunction(() => !document.querySelector("#sup-reason"), null, { timeout: 60_000 });
      await settle(page);
      started = true;
      return { detail: "view-only session opened" };
    });
    // A session is needed for the mirror routes even when only those were asked for.
    if (!started && !wantInteraction("start a support session (reason form)")) {
      const page = rec.page;
      await go(page, `/admin/clients/${b.id}/crm`);
      if (await page.locator("#sup-reason").count()) {
        await page.locator("#sup-reason").fill("Local browser QA of the CRM screens (isolated QA harness).");
        await page.getByRole("button", { name: "Open CRM" }).click();
        await page.waitForFunction(() => !document.querySelector("#sup-reason"), null, { timeout: 60_000 }).catch(() => {});
      }
    }
  }

  async function agencyInteractions(rec) {
    const bp = seed.blueprints.capturedId ?? seed.blueprints.starterId;
    if (!bp) return;
    await interaction(rec, "run the apply-wizard dry run (never confirmed)", async (page) => {
      await go(page, `/admin/crm-blueprints/${bp}/apply?client=${seed.clients.haven.id}`);
      const choose = page.getByRole("button", { name: "Choose options" });
      if ((await choose.count()) && (await choose.isEnabled())) await choose.click();
      await page.getByRole("button", { name: "Preview changes" }).click();
      const heading = page.getByRole("heading", { name: /^Dry run for/ });
      await heading.waitFor({ timeout: 90_000 });
      await settle(page);
      return { detail: `${((await heading.textContent()) ?? "").trim()} (stopped before Continue to confirm)` };
    });
  }

  async function staffInteractions(rec) {
    await interaction(rec, "agency staff: assigned client allowed, other client refused", async (page) => {
      const allowed = await go(page, `/admin/clients/${b.id}/crm`);
      const allowedText = await page.locator("body").innerText();
      const okAllowed = allowed && allowed.status() < 400 && allowedText.includes(b.name);
      const refused = await go(page, `/admin/clients/${seed.clients.haven.id}/crm`);
      const refusedText = await page.locator("body").innerText();
      const okRefused = refused && (refused.status() === 404 || refused.status() === 403 || !refusedText.includes(seed.clients.haven.name));
      if (!okAllowed || !okRefused) throw new Error(`assigned: ${allowed?.status()} ${okAllowed ? "ok" : "not shown"}; other: ${refused?.status()} ${okRefused ? "refused" : "SHOWN"}`);
      return { detail: `assigned client ${allowed.status()}, other client ${refused.status()} with nothing of it shown` };
    });
  }

  async function repInteractions(rec) {
    await interaction(rec, "sales rep: owner-only settings and import/export actions are protected", async (page) => {
      const results = [];
      // API keys and workflows are owner/manager only. The data page is visible for the GHL migration preview,
      // while its CSV import and export controls require their own owner/manager permissions.
      for (const p of ["/crm/settings/api", "/crm/settings/data", "/crm/workflows"]) {
        const res = await go(page, p);
        const u = new URL(page.url());
        if (p === "/crm/settings/data") {
          const upload = await page.locator('input[type="file"]').count();
          const exportLink = await page.locator('a[href^="/api/crm/export"]').count();
          const previewOnly = u.pathname === p && Boolean(res && res.status() < 400) && upload === 0 && exportLink === 0;
          results.push(`${p}: ${previewOnly ? "GHL preview allowed; import/export controls hidden" : "import/export controls SHOWN"}`);
          continue;
        }
        const refused = u.pathname !== p || u.searchParams.get("denied") === "1" || (res ? res.status() === 403 || res.status() === 404 : false);
        results.push(`${p}: ${refused ? `refused (${u.pathname}${u.search})` : "SHOWN"}`);
      }
      if (results.some((r) => r.includes("SHOWN"))) return { result: "fail", detail: results.join("; ") };
      return { detail: results.join("; ") };
    });
  }

  // ---------------------------------------------------------------------------
  // Order: each role's pages first (the seeded state), then that role's interactions.
  // ---------------------------------------------------------------------------

  const wantRole = (role) => !opts.roles || opts.roles.includes(role);
  try {
    let ownerRec = null;
    for (const s of plan.sweeps) {
      if (!wantRole(s.role)) continue;
      const anyRoute = [...s.routes, ...(s.afterSession ?? [])].some((r) => matchesOnly(opts.only, `${s.role}:${r.path}`));
      const anyInteraction = opts.interactions && opts.only.length ? opts.only.some((p) => /interaction/i.test(p)) : opts.interactions;
      if (!anyRoute && !anyInteraction) continue;
      const rec = await contextFor(s.role);
      if (s.role === "owner") ownerRec = rec;
      await sweep(rec, s.routes);
      if (s.role === "owner") await ownerInteractions(rec);
      if (s.role === "sales_rep") await repInteractions(rec);
      if (s.role === "public") await publicInteractions(rec, async () => (wantRole("owner") ? ownerRec ?? (await contextFor("owner")) : null));
      if (s.role === "agency_admin") {
        if (s.afterSession.some((r) => matchesOnly(opts.only, `${s.role}:${r.path}`)) || wantInteraction("start a support session (reason form)")) await startSupportSession(rec);
        await sweep(rec, s.afterSession);
        await agencyInteractions(rec);
      }
      if (s.role === "agency_staff") await staffInteractions(rec);
    }
  } catch (e) {
    report.fatal = errText(e);
    console.error(`Stopped: ${report.fatal}`);
  } finally {
    report.finishedAt = new Date().toISOString();
    persist();
    for (const rec of contexts.values()) await rec.context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  const t = report.totals;
  console.log(`\n${t.visits} page loads. External requests: ${t.external}. 5xx: ${t.serverErrors}. Not rendered: ${t.notRendered}. Page errors: ${t.pageErrors}. Interactions: ${t.interactionsPassed} passed, ${t.interactionsFailed} failed, ${t.interactionsSkipped} skipped.`);
  console.log(`Report: ${path.relative(ROOT, path.join(DATA, "report.md"))} (and report.json); screenshots in ${path.relative(ROOT, SCREENS)}.`);
  process.exitCode = exitCodeFor(t, report.fatal);
  if (process.exitCode) console.log("Exit code " + process.exitCode + ": " + ["", "a request left the QA server or something answered 5xx", "the run stopped part way; the rest did not run", "an interaction failed", "a browser QA check failed"][process.exitCode] + ".");
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error(errText(e));
    process.exit(2);
  });
}
