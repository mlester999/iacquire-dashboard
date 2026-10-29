#!/usr/bin/env node
// A1 preflight, Cloudflare half. STRICTLY READ-ONLY: every request is a GET to api.cloudflare.com.
// It reads the tunnel's published routes (order matters), the connector versions, and the Access
// applications, policies and service tokens that cover the Hermes hostname. It changes nothing and
// never prints the API token.
//
//   CF_API_TOKEN=...   a read-only API token (Cloudflare Tunnel: Read, Access: Apps and Policies: Read,
//                      Access: Service Tokens: Read). Create it for this check and delete it afterwards.
//   CF_ACCOUNT_ID=...  the account id (dashboard sidebar, or the URL after dash.cloudflare.com/)
//   HERMES_HOST=...    the hostname of the existing Hermes route, for example hermes.example.com
//   CF_TUNNEL_ID=...   optional; the tunnel that carries that route (listed if omitted)
//
//   node scripts/hermes-a1-cloudflare-readonly.mjs
//   node scripts/hermes-a1-cloudflare-readonly.mjs --self-test     (offline; fixtures only)

import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";

// The six planned worker routes: exactly the rules in services/hermes-inference-worker/DEPLOYMENT.md.
export const PLANNED_ROUTES = [
  ["operations_manager", "^/internal/inference/v1/operations_manager/infer$", "http://iacquire-hermes-inference-worker-operations-manager:8786"],
  ["lead_hunter", "^/internal/inference/v1/lead_hunter/infer$", "http://iacquire-hermes-inference-worker-lead-hunter:8786"],
  ["appointment_setter", "^/internal/inference/v1/appointment_setter/infer$", "http://iacquire-hermes-inference-worker-appointment-setter:8786"],
  ["sales_assistant", "^/internal/inference/v1/sales_assistant/infer$", "http://iacquire-hermes-inference-worker-sales-assistant:8786"],
  ["crm_manager", "^/internal/inference/v1/crm_manager/infer$", "http://iacquire-hermes-inference-worker-crm-manager:8786"],
  ["performance_analyst", "^/internal/inference/v1/performance_analyst/infer$", "http://iacquire-hermes-inference-worker-performance-analyst:8786"],
].map(([role, path, service]) => ({ role, path, service }));

export const inferPath = (role) => `/internal/inference/v1/${role}/infer`;

// ---------------------------------------------------------------- pure analysis (tested offline)

/** Does a tunnel ingress rule match this host and path? Rules are tried in order; first match wins. */
export function ruleMatches(rule, host, path) {
  const hostOk = !rule.hostname || rule.hostname === host
    || (rule.hostname.startsWith("*.") && host.endsWith(rule.hostname.slice(1)));
  if (!hostOk) return false;
  if (!rule.path) return true;
  try { return new RegExp(rule.path).test(path); } catch { return false; }
}

export function firstMatch(ingress, host, path) {
  const index = ingress.findIndex((rule) => ruleMatches(rule, host, path));
  return index === -1 ? null : { index, rule: ingress[index] };
}

const isCatchAllFor = (rule, host) => rule.hostname === host && (!rule.path || rule.path === ".*");

/** Report on the published routes for the Hermes host: where the catch-all sits, what already exists. */
export function analyzeIngress(ingress, host) {
  const findings = [];
  const forHost = ingress.map((rule, index) => ({ rule, index })).filter(({ rule }) => !rule.hostname || ruleMatches({ hostname: rule.hostname }, host, "/"));
  const catchAll = ingress.findIndex((rule) => isCatchAllFor(rule, host));
  if (catchAll === -1) findings.push({ level: "warn", text: `No catch-all rule for ${host} found; confirm which rule serves the Hermes gateway today` });
  else findings.push({ level: "ok", text: `Hermes catch-all for ${host} is rule #${catchAll + 1} (${ingress[catchAll].service}); the six worker rules must be placed ABOVE it` });
  const existing = ingress.filter((rule) => /internal\/inference/.test(rule.path ?? ""));
  if (existing.length === 0) findings.push({ level: "ok", text: "No internal/inference route exists yet" });
  else findings.push({ level: "fail", text: `${existing.length} internal/inference route(s) already exist: ${existing.map((r) => r.path).join(", ")}` });
  const last = ingress[ingress.length - 1];
  if (!last || last.hostname || last.path || !/^http_status:/.test(last.service ?? "")) findings.push({ level: "warn", text: "The last rule is not a hostname-less http_status fallback (Cloudflare normally requires one)" });
  else findings.push({ level: "ok", text: `Final fallback rule is ${last.service}` });
  return { forHost, catchAll, findings };
}

/** Where do the six planned paths land today, and do the planned rules (placed above the catch-all) isolate them? */
export function simulateRouting(ingress, host) {
  const catchAll = ingress.findIndex((rule) => isCatchAllFor(rule, host));
  const insertAt = catchAll === -1 ? 0 : catchAll;
  const proposed = [
    ...ingress.slice(0, insertAt),
    ...PLANNED_ROUTES.map((route) => ({ hostname: host, path: route.path, service: route.service })),
    ...ingress.slice(insertAt),
  ];
  const rows = PLANNED_ROUTES.map((route) => {
    const path = inferPath(route.role);
    const today = firstMatch(ingress, host, path);
    const after = firstMatch(proposed, host, path);
    return {
      role: route.role,
      today: today ? today.rule.service : "no match",
      after: after ? after.rule.service : "no match",
      ok: after?.rule.service === route.service,
    };
  });
  // Near misses must keep going to the existing gateway rule, not to a worker.
  const nearMisses = [];
  for (const route of PLANNED_ROUTES) {
    const base = inferPath(route.role);
    for (const path of [`${base}/`, `${base}2`, `/x${base}`, `${base}/extra`, base.replace("/infer", "/Infer")]) {
      const hit = firstMatch(proposed, host, path);
      nearMisses.push({ path, service: hit ? hit.rule.service : "no match", leaked: PLANNED_ROUTES.some((r) => r.service === hit?.rule.service) });
    }
  }
  // Other roles' paths must not cross to the wrong worker.
  const crossed = PLANNED_ROUTES.flatMap((route) => PLANNED_ROUTES.filter((other) => other.role !== route.role).map((other) => {
    const hit = firstMatch(proposed, host, inferPath(route.role));
    return hit?.rule.service === other.service ? `${route.role} would reach ${other.role}` : null;
  })).filter(Boolean);
  return { rows, nearMisses, crossed };
}

const includeKinds = (rules) => (rules ?? []).map((rule) => Object.keys(rule)[0]);

/** Summarise an Access policy without printing any secret. */
export function summarizePolicy(policy, tokensById = new Map()) {
  const include = policy.include ?? null;
  const kinds = include ? includeKinds(include) : null;
  const tokenNames = (include ?? [])
    .filter((rule) => rule.service_token)
    .map((rule) => tokensById.get(rule.service_token.token_id)?.name ?? "(unknown service token)");
  const concerns = [];
  if (policy.decision === "bypass") concerns.push("decision is BYPASS: no authentication at all");
  if (kinds?.includes("everyone")) concerns.push("includes EVERYONE");
  if (kinds?.includes("email_domain")) concerns.push("includes an email domain (interactive users)");
  if (kinds?.includes("email")) concerns.push("includes individual emails (interactive users)");
  if (kinds?.includes("any_valid_service_token")) concerns.push("accepts ANY valid service token in the account");
  const requires = includeKinds(policy.require);
  return { name: policy.name ?? "(unnamed)", decision: policy.decision ?? "?", kinds, tokenNames, requires, concerns, readable: kinds !== null };
}

function appHosts(app) {
  const hosts = [];
  const push = (uri) => { if (typeof uri === "string" && uri) hosts.push(uri); };
  push(app.domain);
  for (const destination of app.destinations ?? []) push(destination.uri);
  for (const uri of app.self_hosted_domains ?? []) push(uri);
  return hosts;
}

const splitUri = (uri) => {
  const clean = uri.replace(/^https?:\/\//, "");
  const slash = clean.indexOf("/");
  return slash === -1 ? { host: clean, path: "" } : { host: clean.slice(0, slash), path: clean.slice(slash) };
};

/** Which Access applications cover this host and path? */
export function accessCoverage(apps, host, path) {
  const covering = [];
  for (const app of apps) {
    for (const uri of appHosts(app)) {
      const { host: h, path: p } = splitUri(uri);
      const hostOk = h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)));
      if (!hostOk) continue;
      const prefix = p.replace(/\*+$/, "");
      if (prefix === "" || prefix === "/" || path.startsWith(prefix)) { covering.push({ app, uri, scope: p || "(whole hostname)" }); break; }
    }
  }
  return covering;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  let failures = 0;
  const check = (name, condition) => { console.log(`${condition ? "  ok  " : " FAIL "} ${name}`); if (!condition) failures += 1; };
  const host = "hermes.example.com";
  const ingress = [
    { hostname: "other.example.com", service: "http://other:80" },
    { hostname: host, service: "http://hermes-gateway:8642" },
    { service: "http_status:404" },
  ];
  const analysis = analyzeIngress(ingress, host);
  check("finds the catch-all for the Hermes host", analysis.catchAll === 1);
  check("reports no pre-existing inference route", analysis.findings.some((f) => f.level === "ok" && /No internal\/inference/.test(f.text)));
  const sim = simulateRouting(ingress, host);
  check("today all six paths land on the gateway", sim.rows.every((r) => r.today === "http://hermes-gateway:8642"));
  check("with the planned rules each path reaches only its own worker", sim.rows.every((r) => r.ok) && sim.crossed.length === 0);
  check("near-miss paths never reach a worker", sim.nearMisses.every((n) => !n.leaked));
  check("near-miss paths still reach the gateway", sim.nearMisses.every((n) => n.service === "http://hermes-gateway:8642"));
  const badOrder = [...ingress.slice(0, 1), ingress[1], ...PLANNED_ROUTES.map((r) => ({ hostname: host, path: r.path, service: r.service })), ingress[2]];
  check("a worker rule placed below the catch-all is shadowed", !simulateRouting(badOrder, host).rows.some((r) => r.today === PLANNED_ROUTES[0].service));
  check("a planned-rule typo is caught", (() => {
    const original = PLANNED_ROUTES[0].path;
    return !new RegExp(original).test("/internal/inference/v1/operations_manager/infer/") && new RegExp(original).test("/internal/inference/v1/operations_manager/infer");
  })());
  const apps = [
    { name: "hermes", domain: host, policies: [{ name: "svc", decision: "non_identity", include: [{ service_token: { token_id: "t1" } }] }] },
    { name: "scoped", domain: `${host}/other/*` },
    { name: "wild", domain: "*.example.com/internal/*" },
  ];
  const cover = accessCoverage(apps, host, inferPath("lead_hunter"));
  check("host-wide app covers the worker path", cover.some((c) => c.app.name === "hermes"));
  check("an app scoped to another path does not", !cover.some((c) => c.app.name === "scoped"));
  check("a wildcard host app scoped to /internal/ covers it", cover.some((c) => c.app.name === "wild"));
  const tokens = new Map([["t1", { name: "app-to-hermes" }]]);
  const clean = summarizePolicy(apps[0].policies[0], tokens);
  check("service-token-only policy has no concerns", clean.concerns.length === 0 && clean.tokenNames[0] === "app-to-hermes");
  const loose = summarizePolicy({ name: "x", decision: "bypass", include: [{ everyone: {} }, { email_domain: { domain: "x.com" } }, { any_valid_service_token: {} }] });
  check("bypass, everyone, email domain and any-token are all flagged", loose.concerns.length === 4);
  check("an unreadable policy is marked unreadable", summarizePolicy({ name: "ref" }).readable === false);
  console.log(failures === 0 ? "\nself-test passed" : `\nself-test FAILED (${failures})`);
  return failures === 0;
}

// ---------------------------------------------------------------- live read-only run

async function get(path, token) {
  // The only network call in this file, and it only ever issues GET to api.cloudflare.com.
  const response = await fetch(`${API}${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error page */ }
  if (!response.ok || body?.success === false) {
    const reason = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${response.status}`;
    return { ok: false, reason, status: response.status };
  }
  return { ok: true, result: body?.result ?? null, info: body?.result_info ?? null };
}

async function getAll(path, token, pageSize = 50, maxPages = 6) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const joiner = path.includes("?") ? "&" : "?";
    const res = await get(`${path}${joiner}per_page=${pageSize}&page=${page}`, token);
    if (!res.ok) return page === 1 ? res : { ok: true, result: items };
    items.push(...(res.result ?? []));
    if (!res.info || items.length >= (res.info.total_count ?? 0)) break;
  }
  return { ok: true, result: items };
}

const mark = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]" };

async function live() {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const host = (process.env.HERMES_HOST ?? "").trim().toLowerCase();
  if (!token || !account || !host) {
    console.error("Set CF_API_TOKEN, CF_ACCOUNT_ID and HERMES_HOST (optionally CF_TUNNEL_ID). See the header of this file.");
    return false;
  }
  if (!/^[a-z0-9.-]+$/.test(host) || !/^[a-f0-9]{32}$/i.test(account)) {
    console.error("HERMES_HOST must be a bare hostname and CF_ACCOUNT_ID the 32-character account id.");
    return false;
  }
  let fails = 0;
  const say = (level, text) => { console.log(`  ${mark[level]} ${text}`); if (level === "fail") fails += 1; };

  console.log("\n== 1. Token ==");
  let verified = await get("/user/tokens/verify", token);
  if (!verified.ok) verified = await get(`/accounts/${account}/tokens/verify`, token);
  if (!verified.ok) { say("fail", `token did not verify: ${verified.reason}`); return false; }
  say("ok", `token status ${verified.result?.status ?? "?"}${verified.result?.expires_on ? `, expires ${verified.result.expires_on}` : ", no expiry set (delete it after this check)"}`);

  console.log("\n== 2. Tunnels ==");
  const tunnels = await get(`/accounts/${account}/cfd_tunnel?is_deleted=false&per_page=50`, token);
  if (!tunnels.ok) { say("fail", `cannot list tunnels: ${tunnels.reason}`); return false; }
  for (const t of tunnels.result) {
    const versions = [...new Set((t.connections ?? []).map((c) => c.client_version).filter(Boolean))].join(", ") || "none";
    console.log(`         ${t.name}  id=${t.id}  status=${t.status}  managed-by=${t.config_src ?? "?"}  connections=${(t.connections ?? []).length}  cloudflared=${versions}`);
  }
  let tunnelId = process.env.CF_TUNNEL_ID?.trim();
  if (!tunnelId) {
    const active = tunnels.result.filter((t) => t.status !== "inactive");
    if (active.length === 1) { tunnelId = active[0].id; say("ok", `using the only active tunnel: ${active[0].name}`); }
    else { say("fail", "several tunnels; rerun with CF_TUNNEL_ID set to the one that serves the Hermes host"); return false; }
  }
  const tunnel = tunnels.result.find((t) => t.id === tunnelId);
  if (tunnel?.config_src === "local") say("warn", "this tunnel is configured by a local file, not the dashboard; routes would be edited on the VPS instead");
  else say("ok", "tunnel routes are managed remotely (dashboard or API)");
  if (tunnel && tunnel.status !== "healthy") say("warn", `tunnel status is ${tunnel.status}`);

  console.log("\n== 3. Published routes (first match wins) ==");
  const config = await get(`/accounts/${account}/cfd_tunnel/${tunnelId}/configurations`, token);
  if (!config.ok) { say("fail", `cannot read the tunnel configuration: ${config.reason}`); return false; }
  const ingress = config.result?.config?.ingress ?? [];
  ingress.forEach((rule, i) => console.log(`         #${i + 1}  host=${rule.hostname ?? "(any)"}  path=${rule.path ?? "(any)"}  ->  ${rule.service}`));
  if (ingress.length === 0) { say("fail", "no ingress rules came back (token lacks Tunnel: Read, or the tunnel is locally managed)"); return false; }
  const analysis = analyzeIngress(ingress, host);
  for (const f of analysis.findings) say(f.level, f.text);

  console.log("\n== 4. Planned rules simulated above the catch-all ==");
  const sim = simulateRouting(ingress, host);
  for (const row of sim.rows) say(row.ok ? "ok" : "fail", `${inferPath(row.role)}  today -> ${row.today};  after -> ${row.after}`);
  say(sim.nearMisses.every((n) => !n.leaked) ? "ok" : "fail", `${sim.nearMisses.length} near-miss paths (trailing slash, suffix, prefix, case) stay on the gateway`);
  say(sim.crossed.length === 0 ? "ok" : "fail", sim.crossed.length === 0 ? "no role path can reach another role's worker" : sim.crossed.join("; "));

  console.log("\n== 5. Access applications covering the worker paths ==");
  const [apps, tokens] = await Promise.all([getAll(`/accounts/${account}/access/apps`, token, 100), getAll(`/accounts/${account}/access/service_tokens`, token, 100)]);
  if (!apps.ok) { say("fail", `cannot list Access applications: ${apps.reason}`); return false; }
  const tokensById = new Map((tokens.ok ? tokens.result : []).map((t) => [t.id, t]));
  if (!tokens.ok) say("warn", `service tokens not readable (${tokens.reason}); names will show as unknown`);
  const probe = inferPath("lead_hunter");
  const covering = accessCoverage(apps.result, host, probe);
  if (covering.length === 0) say("fail", `no Access application covers https://${host}${probe}; the worker routes would be public`);
  for (const { app, scope } of covering) {
    say("ok", `app "${app.name}" (${app.type ?? "?"}) covers ${scope}${app.session_duration ? `, session ${app.session_duration}` : ""}`);
    let policies = app.policies ?? [];
    if (policies.length === 0 || policies.every((p) => !p.include)) {
      const listed = await get(`/accounts/${account}/access/apps/${app.id}/policies`, token);
      if (listed.ok) policies = listed.result;
    }
    if (policies.length === 0) say("warn", "no policies readable for this application; check it in the dashboard");
    for (const policy of policies) {
      const s = summarizePolicy(policy, tokensById);
      if (!s.readable) { say("warn", `policy "${s.name}" (${s.decision}) rules not readable; check it in the dashboard`); continue; }
      say(s.concerns.length === 0 && s.decision !== "deny" ? "ok" : "warn", `policy "${s.name}": decision=${s.decision}; include=${s.kinds.join(", ") || "(none)"}${s.tokenNames.length ? `; service tokens: ${s.tokenNames.join(", ")}` : ""}${s.requires.length ? `; require=${s.requires.join(", ")}` : ""}${s.concerns.length ? `; CONCERN: ${s.concerns.join("; ")}` : ""}`);
    }
  }
  const expiring = [...tokensById.values()].filter((t) => t.expires_at).map((t) => `${t.name} (expires ${String(t.expires_at).slice(0, 10)})`);
  if (expiring.length) console.log(`         service token expiry: ${expiring.join("; ")}`);
  console.log("         Note: this checks the Access layout only. Whether an unauthenticated request is refused is proven later with a real request, at A1.");

  console.log(`\nSummary: ${fails === 0 ? "no failures" : `${fails} failure(s)`}. Nothing was created, changed or deleted: every request was a GET.`);
  return fails === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const passed = process.argv.includes("--self-test") ? selfTest() : await live();
  process.exitCode = passed ? 0 : 1;
}
