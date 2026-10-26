#!/usr/bin/env node
/**
 * Safe staging end-to-end test for the external demo registration.
 *
 * It drives the real staging deployment, in this order:
 *
 *   1. a signed registration (through the landing page's own endpoint when E2E_LANDING_REGISTER_URL is set, otherwise directly against the backend);
 *   2. the captured verification email and its one-use link;
 *   3. a GET of the link twice (nothing is consumed, no clock is started);
 *   4. the explicit POST that starts the only 24-hour window;
 *   5. the ten-message allowance (only with E2E_AI_MESSAGES=allow; this calls the real staging model and costs money);
 *   6. the exact 24-hour maths, then a staging-only clock move on this synthetic prospect to prove server-side expiry;
 *   7. optional cleanup.
 *
 * Safety rails (all checked before the first request):
 *
 *   - the target host must be listed in E2E_ALLOWED_HOSTS, and the production hosts (iacquire.online and its www/app hosts) are always refused;
 *   - E2E_CONFIRM must be "staging";
 *   - the shared secret comes from IACQUIREOS_E2E_SIGNING_SECRET and is never printed;
 *   - the prospect address is always @example.test;
 *   - live email is refused unless E2E_EMAIL_DELIVERY=live AND E2E_ALLOW_LIVE_EMAIL=true;
 *   - every database write is scoped to that one synthetic address and needs E2E_ALLOW_DB_WRITE=true;
 *   - tokens, cookies, the secret and full links are never logged.
 *
 * Usage (see docs/demo-external-registration.md for the full staging checklist):
 *
 *   E2E_CONFIRM=staging \
 *   E2E_ALLOWED_HOSTS=staging.iacquire.online \
 *   E2E_BASE_URL=https://staging.iacquire.online \
 *   IACQUIREOS_E2E_SIGNING_SECRET=... \
 *   E2E_EMAIL_DELIVERY=capture \
 *   E2E_DATABASE_URL=postgresql://... \
 *   node scripts/staging-demo-e2e.mjs --report .data/e2e/staging-demo.json
 *
 * Add --via-landing https://staging-marketing.example/api/demo-register to exercise the landing page's signer.
 * Add --allow-db-write and --cleanup for steps 6 and 7.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);
const env = process.env;

const PRODUCTION_HOSTS = new Set(["iacquire.online", "www.iacquire.online", "app.iacquire.online"]);
const BASE = (arg("--base") ?? env.E2E_BASE_URL ?? "").replace(/\/+$/, "");
const LANDING = (arg("--via-landing") ?? env.E2E_LANDING_REGISTER_URL ?? "").replace(/\/+$/, "");
const ALLOWED = (env.E2E_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const EMAIL_DELIVERY = (env.E2E_EMAIL_DELIVERY ?? "capture").toLowerCase();
const EMAIL_SOURCE = (env.E2E_EMAIL_SOURCE ?? "db").toLowerCase();
const DB_URL = env.E2E_DATABASE_URL ?? env.DATABASE_URL ?? "";
const REPORT_PATH = arg("--report") ?? env.E2E_REPORT_PATH ?? "";
const ALLOW_AI = env.E2E_AI_MESSAGES === "allow";
const ALLOW_DB_WRITE = flag("--allow-db-write") || env.E2E_ALLOW_DB_WRITE === "true";
const CLEANUP = flag("--cleanup") || env.E2E_CLEANUP === "true";
const DRY = flag("--dry-run");

const report = { startedAt: new Date().toISOString(), target: BASE || null, viaLanding: Boolean(LANDING), checks: [], skipped: [], notes: [], cleanup: null };
let failed = false;

function record(name, ok, detail = "") {
  report.checks.push({ name, ok, detail: String(detail).slice(0, 500) });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` -> ${String(detail).slice(0, 300)}`}`);
}
function skip(name, why) {
  report.skipped.push({ name, why });
  console.log(`SKIP  ${name} (${why})`);
}
function die(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}
function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function maskedEmail(email) {
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : "***";
}

// ---------------------------------------------------------------------------
// Refusals that need no request
// ---------------------------------------------------------------------------

if (!BASE) die("E2E_BASE_URL (or --base) is required.");
const baseHost = hostOf(BASE);
if (!baseHost) die("E2E_BASE_URL is not a URL.");
if (PRODUCTION_HOSTS.has(baseHost)) die(`refusing the production host ${baseHost}`);
if (!ALLOWED.length) die("E2E_ALLOWED_HOSTS must list the staging host explicitly.");
if (!ALLOWED.includes(baseHost)) die(`${baseHost} is not in E2E_ALLOWED_HOSTS.`);
if (!/^https:\/\//.test(BASE) && !["localhost", "127.0.0.1"].includes(baseHost)) die("staging must be HTTPS.");
if (env.E2E_CONFIRM !== "staging") die('set E2E_CONFIRM=staging to confirm this is the staging run.');
const SECRET = env.IACQUIREOS_E2E_SIGNING_SECRET ?? "";
if (SECRET.length < 32) die("IACQUIREOS_E2E_SIGNING_SECRET must be the staging signing secret (32+ characters).");
if (EMAIL_DELIVERY === "live" && env.E2E_ALLOW_LIVE_EMAIL !== "true") die("live email needs E2E_ALLOW_LIVE_EMAIL=true and an explicit approval.");
if (EMAIL_DELIVERY !== "capture" && EMAIL_DELIVERY !== "live") die("E2E_EMAIL_DELIVERY must be capture or live.");
if (!["db", "mailpit"].includes(EMAIL_SOURCE)) die("E2E_EMAIL_SOURCE must be db or mailpit.");
if (EMAIL_SOURCE === "db" && !DB_URL) die("E2E_DATABASE_URL (or DATABASE_URL) is required for the captured-email source.");
if (EMAIL_SOURCE === "mailpit" && !env.E2E_MAILBOX_URL) die("E2E_MAILBOX_URL is required for the mailpit source.");
if ((ALLOW_DB_WRITE || CLEANUP) && !DB_URL) die("database writes need E2E_DATABASE_URL.");

const EMAIL = `e2e.demo.${Date.now().toString(36)}.${crypto.randomBytes(3).toString("hex")}@example.test`;
const BODY = {
  name: "E2E Staging Prospect",
  email: EMAIL,
  business: "E2E Staging Co",
  industry: "home_services",
  consent: true,
  marketingOptIn: false,
  utm_source: "staging-e2e",
  company_website: "",
};

if (DRY) {
  console.log(JSON.stringify({ dryRun: true, target: BASE, landing: LANDING || null, email: maskedEmail(EMAIL), allowedHosts: ALLOWED, emailDelivery: EMAIL_DELIVERY, emailSource: EMAIL_SOURCE, steps: ["register", "read link", "GET twice", "confirm", "24h maths", ALLOW_AI ? "ten messages" : "ten messages (skipped: E2E_AI_MESSAGES!=allow)", ALLOW_DB_WRITE ? "expiry clock move" : "expiry (skipped: --allow-db-write not set)", CLEANUP ? "cleanup" : "no cleanup"] }, null, 2));
  process.exit(0);
}

const sign = (timestamp, requestId, rawBody) => crypto.createHmac("sha256", SECRET).update(`${timestamp}.${requestId}.${rawBody}`).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonRequest(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: "manual", cache: "no-store" });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { res, status: res.status, text, body, cookie: res.headers.get("set-cookie") ?? "" };
}

// ---------------------------------------------------------------------------
// 1. The signed registration
// ---------------------------------------------------------------------------

let raw;
if (LANDING) {
  // The landing page's server route signs with IACQUIREOS_BACKEND_SIGNING_SECRET itself; this proves its signer end to end.
  const landingRes = await jsonRequest(LANDING, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(BODY),
  });
  record("1a: the landing page accepted the registration form", landingRes.status === 200 && landingRes.body?.ok === true, `${landingRes.status} ${landingRes.text.slice(0, 200)}`);
  raw = JSON.stringify(BODY);
} else {
  raw = JSON.stringify(BODY);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = `e2e_${crypto.randomUUID().replace(/-/g, "")}`;
  const res = await jsonRequest(`${BASE}/api/public/demo/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "iacquireos-request-id": requestId,
      "iacquireos-timestamp": timestamp,
      "iacquireos-signature": `t=${timestamp},v1=${sign(timestamp, requestId, raw)}`,
    },
    body: raw,
  });
  record("1b: the backend accepted the signed registration", res.status === 202 && res.body?.ok === true, `${res.status} ${res.text.slice(0, 200)}`);
}
if (failed) finish();
console.log(`registered a synthetic prospect: ${maskedEmail(EMAIL)}`);

// ---------------------------------------------------------------------------
// 2-3. The email, and the GET that must not consume it
// ---------------------------------------------------------------------------

let db = null;
async function database() {
  if (db) return db;
  const ssl = /localhost|127\.0\.0\.1/.test(hostOf(DB_URL)) ? undefined : { rejectUnauthorized: false };
  db = new pg.Client({ connectionString: DB_URL, ssl });
  await db.connect();
  return db;
}
async function dbRows(sql, params = []) {
  const client = await database();
  const res = await client.query(sql, params);
  return res.rows;
}

async function linkFromDb() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await dbRows("select body_text, status, provider from email_outbox where to_email = $1 and template = 'demo_link' order by id desc limit 1", [EMAIL]);
    if (rows[0] && rows[0].provider === "resend" && rows[0].status === "sent" && EMAIL_DELIVERY === "capture") {
      throw new Error("the staging app sent a live Resend email; this run expected the capturing provider");
    }
    const match = /https?:\/\/[^\s]+\/demo\/verify\?token=([A-Za-z0-9_-]{43})/.exec(rows[0]?.body_text ?? "");
    if (match) return { token: match[1], provider: rows[0].provider, status: rows[0].status };
    await sleep(2000);
  }
  return null;
}
async function linkFromMailpit() {
  const base = env.E2E_MAILBOX_URL.replace(/\/+$/, "");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const search = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${EMAIL}`)}`).then((r) => r.json()).catch(() => null);
    const id = search?.messages?.[0]?.ID;
    if (id) {
      const message = await fetch(`${base}/api/v1/message/${id}`).then((r) => r.json()).catch(() => null);
      const text = `${message?.Text ?? ""}\n${message?.HTML ?? ""}`;
      const match = /https?:\/\/[^\s"'<>]+\/demo\/verify\?token=([A-Za-z0-9_-]{43})/.exec(text);
      if (match) return { token: match[1], provider: "mailpit", status: "captured" };
    }
    await sleep(2000);
  }
  return null;
}

const found = EMAIL_SOURCE === "db" ? await linkFromDb() : await linkFromMailpit();
record("2: the verification email arrived and carries a one-use link", Boolean(found?.token), found ? `provider=${found.provider} status=${found.status}` : "no link after 60 s");
if (!found) finish();

const token = found.token;
const verifyUrl = `${BASE}/demo/verify?token=${token}`;
const peek1 = await fetch(verifyUrl, { redirect: "manual" });
const peekBody1 = await peek1.text();
record("3a: the link's page shows the entry button", peek1.status === 200 && /Open your demo/i.test(peekBody1) && /Press the button/i.test(peekBody1), `status ${peek1.status}`);
const peek2 = await fetch(verifyUrl, { redirect: "manual" });
const peekBody2 = await peek2.text();
record("3b: a second GET still shows the button (nothing was consumed)", peek2.status === 200 && /Open your demo/i.test(peekBody2), `status ${peek2.status}`);

if (DB_URL) {
  const before = await dbRows("select status, verified_at, window_ends_at from demo_prospects where email_normalized = $1", [EMAIL.toLowerCase()]);
  record("3c: the database still shows the prospect unconfirmed after two GETs", before[0]?.status === "unverified" && before[0]?.verified_at === null && before[0]?.window_ends_at === null, JSON.stringify(before[0] ?? null));
}

// ---------------------------------------------------------------------------
// 4. The explicit confirmation starts exactly one window
// ---------------------------------------------------------------------------

const confirmed = await jsonRequest(`${BASE}/api/public/demo/verify`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams({ token }).toString(),
});
const cookie = /(?:^|,\s*)(iaq_demo=[^;]+)/.exec(confirmed.cookie)?.[1] ?? "";
record("4a: the explicit POST opens the demo and sets the prospect cookie", [200, 303].includes(confirmed.status) && Boolean(cookie), `status ${confirmed.status}`);
if (!cookie) finish();

const history = await jsonRequest(`${BASE}/api/public/demo/history`, { headers: { cookie, accept: "application/json" } });
record("4b: the room is open with ten messages", history.status === 200 && history.body?.room?.access === "open" && history.body?.room?.messagesLeft === 10 && history.body?.room?.messageAllowance === 10, `${history.status} ${JSON.stringify(history.body?.room ?? {}).slice(0, 200)}`);

if (DB_URL) {
  const row = (await dbRows("select verified_at, window_ends_at, message_limit, status from demo_prospects where email_normalized = $1", [EMAIL.toLowerCase()]))[0];
  const span = row ? new Date(row.window_ends_at).getTime() - new Date(row.verified_at).getTime() : NaN;
  record("4c: first access is written once and the window is exactly 24 hours", row?.status === "active" && span === 24 * 3_600_000 && row.message_limit === 10, row ? `span=${span} ms` : "no row");
}

// ---------------------------------------------------------------------------
// 5. The ten-message allowance
// ---------------------------------------------------------------------------

if (!ALLOW_AI) {
  skip("5: the ten-message allowance", "E2E_AI_MESSAGES is not 'allow'; sending calls the real staging model and costs money");
} else {
  let sent = 0;
  let stopped = null;
  for (let i = 1; i <= 11; i += 1) {
    const message = await jsonRequest(`${BASE}/api/public/demo/message`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", cookie },
      body: JSON.stringify({ text: `Staging E2E question ${i}: what does the Appointment Setter do?`, clientMessageId: `e2e_${crypto.randomUUID().replace(/-/g, "")}` }),
    });
    if (message.status === 429) {
      const wait = Number(message.res.headers.get("retry-after") ?? 60);
      console.log(`waiting ${wait}s for the message pace`);
      await sleep(Math.max(1, wait) * 1000);
      i -= 1;
      continue;
    }
    if (i <= 10) {
      record(`5a.${i}: message ${i} is accepted`, message.status === 200 && message.body?.ok === true, `${message.status} ${message.text.slice(0, 120)}`);
      if (message.status === 200) sent += 1;
    } else {
      stopped = message;
    }
    await sleep(500);
  }
  record("5b: exactly ten messages were accepted", sent === 10, `accepted=${sent}`);
  record("5c: the eleventh is refused with limit_reached", stopped?.status === 409 && stopped?.body?.error?.code === "limit_reached", `${stopped?.status} ${stopped?.text.slice(0, 160)}`);
  if (DB_URL) {
    const used = (await dbRows("select messages_used from demo_prospects where email_normalized = $1", [EMAIL.toLowerCase()]))[0]?.messages_used;
    record("5d: the database records ten used messages", used === 10, `messages_used=${used}`);
  }
  const after = await jsonRequest(`${BASE}/api/public/demo/history`, { headers: { cookie, accept: "application/json" } });
  record("5e: the room reports no messages left and the same allowance", after.body?.room?.messagesLeft === 0 && after.body?.room?.messageAllowance === 10, JSON.stringify(after.body?.room?.messagesLeft));
}

// ---------------------------------------------------------------------------
// 6. Server-side expiry, without waiting 24 hours
// ---------------------------------------------------------------------------

if (!ALLOW_DB_WRITE) {
  skip("6: server-side expiry", "the clock move needs --allow-db-write (or E2E_ALLOW_DB_WRITE=true)");
} else {
  const updated = await dbRows(
    "update demo_prospects set window_ends_at = now() - interval '1 minute', status = 'expired' where email_normalized = $1 and status in ('active', 'consultation_requested', 'purchase_started') returning id",
    [EMAIL.toLowerCase()],
  );
  record("6a: the synthetic staging prospect's window was moved into the past (early end)", updated.length === 1, `rows=${updated.length}`);
  const ended = await jsonRequest(`${BASE}/api/public/demo/history`, { headers: { cookie, accept: "application/json" } });
  record("6b: the room now reads ended and the chat is refused server-side", ended.body?.room?.access === "ended" && ended.body?.room?.chat?.canSend === false && ended.body?.room?.chat?.refusal === "window_ended", `${ended.status} ${JSON.stringify(ended.body?.room?.chat ?? {}).slice(0, 160)}`);
  const late = await jsonRequest(`${BASE}/api/public/demo/message`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie },
    body: JSON.stringify({ text: "After the window", clientMessageId: `e2e_${crypto.randomUUID().replace(/-/g, "")}` }),
  });
  record("6c: a message after expiry is refused with window_ended", late.status === 409 && late.body?.error?.code === "window_ended", `${late.status} ${late.text.slice(0, 160)}`);
}

// ---------------------------------------------------------------------------
// 7. Cleanup
// ---------------------------------------------------------------------------

if (CLEANUP) {
  if (!ALLOW_DB_WRITE) die("cleanup needs --allow-db-write (or E2E_ALLOW_DB_WRITE=true).");
  const client = await database();
  await client.query("begin");
  try {
    const outbox = await client.query("delete from email_outbox where to_email = $1 and template = 'demo_link'", [EMAIL]);
    const prospects = await client.query("delete from demo_prospects where email_normalized = $1", [EMAIL.toLowerCase()]);
    await client.query("commit");
    report.cleanup = { outbox: outbox.rowCount, prospects: prospects.rowCount };
    record("7: the synthetic prospect and its capture-email rows were removed", prospects.rowCount === 1, JSON.stringify(report.cleanup));
  } catch (error) {
    await client.query("rollback");
    record("7: cleanup", false, String(error).slice(0, 300));
  }
} else {
  skip("7: cleanup", "--cleanup not set; the synthetic prospect stays in staging for inspection");
}

finish();

function finish() {
  report.finishedAt = new Date().toISOString();
  report.ok = !failed;
  if (db) void db.end().catch(() => undefined);
  if (REPORT_PATH) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${REPORT_PATH}`);
  }
  console.log(`\nstaging demo e2e: ${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks passed, ${report.skipped.length} skipped`);
  process.exit(failed ? 1 : 0);
}
