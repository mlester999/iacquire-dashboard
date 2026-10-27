#!/usr/bin/env node
/**
 * Error-handling matrix for the external demo registration, STAGING ONLY.
 *
 * Backend cases are signed directly (wrong signature, stale timestamp, tampered body, wrong content type, oversize body, replay with the same and with a different body,
 * invalid fields, consent false, honeypot, malformed JSON, GET, a foreign Origin, the per-mailbox limit). Landing cases go through the landing page's own route, and, when
 * E2E_LANDING_LIB points at its lib/demo-registration.mjs, through that handler in-process with a WRONG secret and an UNREACHABLE backend, to show that the visitor never
 * sees a misleading success.
 *
 * Same safety rails as scripts/staging-demo-e2e.mjs: the target host must be listed in E2E_ALLOWED_HOSTS, production hosts are always refused, E2E_CONFIRM must be "staging",
 * the secret is read from IACQUIREOS_E2E_SIGNING_SECRET and never printed, every address is @example.test, and database access is read-only (SELECT counts).
 *
 *   E2E_CONFIRM=staging E2E_ALLOWED_HOSTS=localhost E2E_BASE_URL=http://localhost:3290 IACQUIREOS_E2E_SIGNING_SECRET=... \
 *   E2E_DATABASE_URL=postgresql://... E2E_LANDING_REGISTER_URL=http://localhost:3291/api/demo/register \
 *   E2E_LANDING_LIB=/path/to/landing/lib/demo-registration.mjs node scripts/staging-demo-error-matrix.mjs
 */
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

const env = process.env;
const BASE = (env.E2E_BASE_URL ?? "").replace(/\/+$/, "");
const LANDING = (env.E2E_LANDING_REGISTER_URL ?? "").replace(/\/+$/, "");
const ALLOWED = (env.E2E_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SECRET = env.IACQUIREOS_E2E_SIGNING_SECRET ?? "";
const DB_URL = env.E2E_DATABASE_URL ?? "";
const PRODUCTION_HOSTS = new Set(["iacquire.online", "www.iacquire.online", "app.iacquire.online"]);
const die = (m) => { console.error(`REFUSED: ${m}`); process.exit(2); };
let host = ""; try { host = new URL(BASE).hostname.toLowerCase(); } catch { /* handled below */ }
if (!host) die("E2E_BASE_URL is required.");
if (PRODUCTION_HOSTS.has(host)) die(`refusing the production host ${host}`);
if (!ALLOWED.includes(host)) die(`${host} is not in E2E_ALLOWED_HOSTS.`);
if (env.E2E_CONFIRM !== "staging") die("set E2E_CONFIRM=staging.");
if (!/^https:\/\//.test(BASE) && !["localhost", "127.0.0.1"].includes(host)) die("staging must be HTTPS.");
if (SECRET.length < 32) die("IACQUIREOS_E2E_SIGNING_SECRET must be the staging secret (32+ characters).");
if (!DB_URL) die("E2E_DATABASE_URL is required (read-only counts).");
if (LANDING) { try { if (PRODUCTION_HOSTS.has(new URL(LANDING).hostname)) die("refusing a production landing host"); } catch { die("E2E_LANDING_REGISTER_URL is not a URL."); } }

const BACKEND = `${BASE}/api/public/demo/register`;
const db = new pg.Client({ connectionString: DB_URL, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? undefined : { rejectUnauthorized: false } });
await db.connect();
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`); };
const sign = (t, id, raw, secret = SECRET) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${id}.${raw}`).digest("hex")}`;
const WRONG = "a-completely-different-secret-value-0123456789";
const email = (tag) => `em.${tag}.${crypto.randomBytes(3).toString("hex")}@example.test`;
const body = (e, extra = {}) => ({ name: "Matrix Test", email: e, business: "Matrix Co", industry: "consulting", consent: true, marketingOptIn: false, company_website: "", ...extra });
const count = async (e) => ({
  prospects: Number((await db.query("select count(*)::int n from demo_prospects where email_normalized = $1", [e])).rows[0].n),
  mails: Number((await db.query("select count(*)::int n from email_outbox where to_email = $1", [e])).rows[0].n),
});
async function backend({ raw, id = `m_${crypto.randomUUID().replace(/-/g, "")}`, t = Math.floor(Date.now() / 1000), sig, headers = {}, method = "POST" }) {
  const res = await fetch(BACKEND, { method, redirect: "manual", headers: { "content-type": "application/json", "iacquireos-request-id": id, "iacquireos-timestamp": String(t), "iacquireos-signature": sig ?? sign(t, id, raw), ...headers }, body: method === "POST" ? raw : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}
const settle = () => new Promise((r) => setTimeout(r, 1500));

{ const e = email("ok"); const r = await backend({ raw: JSON.stringify(body(e)) }); await settle(); const c = await count(e);
  check("B1 valid signed request -> 202 {ok:true}, one prospect, one captured email", r.status === 202 && r.json?.ok === true && c.prospects === 1 && c.mails === 1, `${r.status} ${JSON.stringify(c)}`); }
{ const e = email("badsig"); const raw = JSON.stringify(body(e)); const r = await backend({ raw, sig: sign(Math.floor(Date.now() / 1000), "x", raw, WRONG) });
  check("B2 wrong signature -> 401 one generic answer, nothing stored", r.status === 401 && r.json?.error?.code === "unauthorized" && (await count(e)).prospects === 0, `${r.status}`); }
{ const e = email("stale"); const raw = JSON.stringify(body(e)); const t = Math.floor(Date.now() / 1000) - 1000; const id = `m_${crypto.randomUUID().replace(/-/g, "")}`;
  const r = await backend({ raw, t, id, sig: sign(t, id, raw) }); check("B3 correctly signed but 1000 s old -> 401, nothing stored", r.status === 401 && (await count(e)).prospects === 0, `${r.status}`); }
{ const e = email("tamper"); const raw = JSON.stringify(body(e)); const t = Math.floor(Date.now() / 1000); const id = `m_${crypto.randomUUID().replace(/-/g, "")}`;
  const r = await backend({ raw: raw.replace("Matrix Co", "Other Co"), t, id, sig: sign(t, id, raw) }); check("B4 body changed after signing -> 401", r.status === 401 && (await count(e)).prospects === 0, `${r.status}`); }
{ const raw = JSON.stringify(body(email("ctype"))); const t = Math.floor(Date.now() / 1000); const id = `m_${crypto.randomUUID().replace(/-/g, "")}`;
  const res = await fetch(BACKEND, { method: "POST", headers: { "content-type": "text/plain", "iacquireos-request-id": id, "iacquireos-timestamp": String(t), "iacquireos-signature": sign(t, id, raw) }, body: raw });
  check("B5 wrong content type -> 415", res.status === 415, `${res.status}`); }
{ const r = await backend({ raw: JSON.stringify(body(email("big"), { business: "x".repeat(9000) })) }); check("B6 body over 8192 bytes -> 413", r.status === 413, `${r.status}`); }
{ const e = email("replay"); const id = `m_${crypto.randomUUID().replace(/-/g, "")}`; const raw1 = JSON.stringify(body(e)); const raw2 = JSON.stringify(body(e, { business: "Different Co" }));
  const a = await backend({ raw: raw1, id }); await settle(); const mails = (await count(e)).mails; const same = await backend({ raw: raw1, id }); await settle(); const diff = await backend({ raw: raw2, id });
  check("B7 same request id + same body -> 202 and no second email", a.status === 202 && same.status === 202 && (await count(e)).mails === mails, `${a.status}/${same.status}`);
  check("B8 same request id + different body -> 409 replayed_request", diff.status === 409 && diff.json?.error?.code === "replayed_request", `${diff.status}`); }
{ const e = email("inv"); const r = await backend({ raw: JSON.stringify(body(e, { name: "", industry: "nonsense" })) });
  check("B9 invalid fields -> 422 with a fields map, nothing stored", r.status === 422 && r.json?.fields && (await count(e)).prospects === 0, `${r.status} ${Object.keys(r.json?.fields ?? {})}`); }
{ const e = email("noconsent"); const r = await backend({ raw: JSON.stringify(body(e, { consent: false })) });
  check("B10 consent:false -> 422 fields.consent", r.status === 422 && !!r.json?.fields?.consent && (await count(e)).prospects === 0, `${r.status}`); }
{ const e = email("honey"); const r = await backend({ raw: JSON.stringify(body(e, { company_website: "http://spam.example" })) }); await settle(); const c = await count(e);
  check("B11 honeypot filled -> answered 202 but nothing stored or sent", r.status === 202 && c.prospects === 0 && c.mails === 0, `${r.status} ${JSON.stringify(c)}`); }
{ const r = await backend({ raw: "{not json" }); check("B12 malformed JSON (validly signed) -> 400", r.status === 400, `${r.status}`); }
{ const r = await backend({ raw: "{}", method: "GET" }); check("B13 GET -> 405 with Allow: POST", r.status === 405 && /POST/.test(r.headers.get("allow") ?? ""), `${r.status}`); }
{ const e = email("origin"); const r = await backend({ raw: JSON.stringify(body(e)), headers: { origin: "https://evil.example" } });
  check("B14 an Origin that is not allow-listed -> 403", r.status === 403 && (await count(e)).prospects === 0, `${r.status}`);
  check("B15 no CORS header on any answer", ![...r.headers.keys()].some((k) => k.startsWith("access-control-"))); }
{ const e = email("limit"); const out = [];
  for (let i = 0; i < 4; i += 1) { out.push((await backend({ raw: JSON.stringify(body(e)) })).status); await settle(); }
  const c = await count(e);
  check("B16 per-mailbox limit: three accepted (202), the fourth in the hour is 429 rate_limited, and no more than three emails", out.slice(0, 3).every((s) => s === 202) && out[3] === 429 && c.mails <= 3, `${out} mails=${c.mails}`); }

async function landingRoute(e, extra = {}, origin) {
  const o = origin ?? new URL(LANDING).origin;
  const res = await fetch(LANDING, { method: "POST", headers: { "content-type": "application/json", origin: o }, body: JSON.stringify({ fullName: "Matrix Test", email: e, businessName: "Matrix Co", industry: "consulting", consent: true, marketingOptIn: false, company_website: "", ...extra }) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
if (LANDING) {
  { const e = email("l-ok"); const r = await landingRoute(e); await settle(); check("L1 landing -> 202 ok:true and one prospect", r.status === 202 && r.json?.ok === true && (await count(e)).prospects === 1, `${r.status}`); }
  { const r = await landingRoute("not-an-email"); check("L4 invalid email -> 400 with a field error, no backend call", r.status === 400 && !!r.json?.fieldErrors?.email, `${r.status}`); }
  { const r = await landingRoute(email("l-consent"), { consent: false }); check("L5 consent missing -> 400 with a consent message", r.status === 400 && !!r.json?.fieldErrors?.consent, `${r.status}`); }
  { const res = await fetch(LANDING, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }); check("L6 cross-origin browser post to the landing route -> 403", res.status === 403, `${res.status}`); }
  { const e = email("l-rate"); const out = []; for (let i = 0; i < 7; i += 1) out.push((await landingRoute(e)).status);
    check("L7 the landing's own per-visitor limit answers 429 after five in a minute", out.includes(429), out.join(",")); }
} else console.log("SKIP  L1, L4-L7 (E2E_LANDING_REGISTER_URL not set)");
if (env.E2E_LANDING_LIB) {
  const { handleDemoRegistrationRequest } = await import(pathToFileURL(env.E2E_LANDING_LIB).href);
  const inProc = async (overrides, e) => {
    const environment = { NODE_ENV: "development", DEMO_REGISTRATION_MODE: "backend", IACQUIREOS_DEMO_REGISTER_URL: BACKEND, IACQUIREOS_BACKEND_SIGNING_SECRET: SECRET, DEMO_REGISTRATION_TIMEOUT_MS: "4000", ...overrides };
    const request = new Request("http://localhost:3291/api/demo/register", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3291", "x-real-ip": String(Math.random()) }, body: JSON.stringify({ fullName: "Matrix Test", email: e, businessName: "Matrix Co", industry: "consulting", consent: true, marketingOptIn: false, company_website: "" }) });
    const res = await handleDemoRegistrationRequest(request, { env: environment });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  { const e = email("l-wrong"); const r = await inProc({ IACQUIREOS_BACKEND_SIGNING_SECRET: WRONG }, e);
    check("L2 landing with the WRONG secret -> 503 ok:false 'temporarily unavailable', never a success", r.status === 503 && r.json?.ok === false && /temporarily unavailable/i.test(r.json?.message ?? "") && (await count(e)).prospects === 0, `${r.status}`); }
  { const e = email("l-dead"); const r = await inProc({ IACQUIREOS_DEMO_REGISTER_URL: "http://localhost:3999/api/public/demo/register" }, e);
    check("L3 landing whose backend is unreachable -> 503 ok:false, no success message", r.status === 503 && r.json?.ok === false && (await count(e)).prospects === 0, `${r.status}`); }
} else console.log("SKIP  L2, L3 (E2E_LANDING_LIB not set)");
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nall error-handling checks passed");
process.exit(failed ? 1 : 0);
