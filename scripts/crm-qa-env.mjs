// Environment for isolated local browser QA of the Native CRM (default http://127.0.0.1:3230; CRM_QA_PORT can set another loopback port). It forces the embedded database, local sign-in
// and a separate build directory, and pins EVERY variable the application reads.
//
// Why every one: Next.js reads .env only for keys that are not already set, so a key left out here would be filled from the hosted
// project's .env. A key set to "" here is taken as set (Next.js then drops it rather than reading .env), and the server treats it as
// unset. Secrets, keys and provider URLs are therefore "", switches that send anything are off, and the few values the schema needs to
// be non-empty are local-only constants. assertIsolated() refuses to start when .env names a variable this file does not pin.
//
// What the QA server itself still fetches from the internet (server side, so the browser run's request block cannot see or count it):
//   * Google Fonts: the root layout uses next/font/google, so compiling into the fresh .next-crm-qa downloads the font CSS and files
//     (fonts.googleapis.com, fonts.gstatic.com). Accepted, so screenshots and overflow checks use the real fonts. The request names
//     only the font families and weights; no application data.
//   * The npm registry: next dev (webpack) asks registry.npmjs.org for next's dist-tags once at start for its version notice. Next has
//     no switch for it; it carries no application data, and a failure is ignored.
// Next's anonymous usage telemetry is off (NEXT_TELEMETRY_DISABLED). Nothing goes to Supabase, a messaging, CRM, calendar, payment or
// AI provider, or production data: those keys and URLs are blank and every send switch is off.
//
// Used by scripts/crm-qa.mjs (the server), scripts/run-crm-qa-seed.mjs (the seed) and scripts/crm-browser-qa.mjs (the browser run).
import fs from "node:fs";
import path from "node:path";

const requestedPort = process.env.CRM_QA_PORT;
const parsedPort = requestedPort === undefined ? 3230 : Number(requestedPort);
if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65_535) {
  throw new Error("CRM_QA_PORT must be an integer between 1024 and 65535.");
}
export const CRM_QA_PORT = parsedPort;
export const CRM_QA_URL = `http://127.0.0.1:${CRM_QA_PORT}`;
/** Everything the harness writes: the embedded database, uploads, credentials, screenshots and reports. Inside .data, which git ignores. */
export const CRM_QA_DATA_DIR = ".data/crm-qa";

export const CRM_QA_ENV = {
  // Runtime and build
  NODE_ENV: "development",
  CRM_QA_PORT: String(CRM_QA_PORT),
  // No anonymous usage events to Vercel from next dev (this machine's Next config does not opt out on its own).
  NEXT_TELEMETRY_DISABLED: "1",
  IAQ_DIST_DIR: ".next-crm-qa",
  IAQ_UI_QA: "",
  APP_URL: CRM_QA_URL,
  // portal = the authenticated app only; "both" (local development) also serves customer sites on any non-localhost host name.
  DEPLOYMENT_ROLE: "both",

  // Identity and data: local sign-in and the embedded file database, never a hosted one.
  AUTH_PROVIDER: "local",
  DATABASE_DRIVER: "pglite",
  DATABASE_URL: "",
  DATABASE_SSL_CA: "",
  DATABASE_SSL_CA_FILE: "",
  DATABASE_POOL_MAX: "",
  PGLITE_DATA_DIR: `${CRM_QA_DATA_DIR}/database`,
  UPLOAD_DIR: `${CRM_QA_DATA_DIR}/uploads`,

  // Supabase: nothing. Local sign-in needs none of it.
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
  SUPABASE_SECRET_KEY: "",

  // Secrets. The vault is Supabase's, so on the embedded database saving a credential fails closed (nothing is ever stored).
  // test-memory is refused outside tests; the seed runner switches to it under NODE_ENV=test, as the sites QA seed does.
  SECRET_STORE: "vault",
  ALLOW_LEGACY_CREDENTIAL_READS: "false",
  APP_ENCRYPTION_KEY: "local-crm-qa-only-encryption-key-0123456789abcdef",
  APP_ENCRYPTION_KEY_PREVIOUS: "",
  SITES_FORM_SECRET: "local-crm-qa-only-form-secret-0123456789",
  // Lets the browser run ask this local server to process queued work (form submissions) once, on its configured loopback port only.
  CRON_SECRET: "local-crm-qa-only-cron-secret-0123456789abcdef",
  // The isolated QA harness is allowed to run scheduled jobs so the worker path is exercised; production keeps this false.
  SCHEDULER_ENABLED: "true",
  INTEGRATION_ALLOWED_HOSTS: "",

  // Email is captured in the local database, never sent.
  EMAIL_PROVIDER: "capture",
  EMAIL_FROM: "iAcquire QA <no-reply@iacquire.local>",
  RESEND_API_KEY: "",
  RESEND_WEBHOOK_SECRET: "",
  RESEND_WRITES_ENABLED: "false",

  // Messaging providers: every kill switch off, every secret and URL blank.
  TWILIO_WRITES_ENABLED: "false",
  TWILIO_WEBHOOK_BASE_URL: "",
  META_WHATSAPP_WRITES_ENABLED: "false",
  META_APP_SECRET: "",
  META_WEBHOOK_VERIFY_TOKEN: "",

  // GoHighLevel. The schema needs a URL here (blank is invalid), so it points at a closed local port. That stops the paths that read
  // GHL_API_BASE (src/server/integrations/ghl.ts, inspection.ts, appointments/provider.ts, messaging/provider.ts): they refuse any
  // host but the official one before sending. It does NOT cover the Blueprint GoHighLevel reader (src/server/crm/blueprints/ghl-read.ts),
  // which always uses the official origin as a constant. What stops that one in QA is that no GoHighLevel credential can exist: the
  // embedded database has no vault (SECRET_STORE=vault fails closed), legacy credential reads are off, and the seed stores none.
  GHL_API_BASE: "http://127.0.0.1:9",
  GHL_WRITES_ENABLED: "false",
  GHL_WEBHOOK_PUBLIC_KEY: "",

  // AI, automation and support integrations: off.
  HELP_LLM_PROVIDER: "none",
  LLM_BASE_URL: "",
  LLM_API_KEY: "",
  LLM_MODEL: "qa-disabled",
  N8N_BASE_URL: "",
  N8N_API_KEY: "",
  N8N_ACTIONS_ENABLED: "false",
  SLACK_SUPPORT_WEBHOOK_URL: "",
  ALLOW_INSECURE_HERMES_URLS: "false",
  HERMES_RUN_TIMEOUT_MS: "180000",

  // Payments: none.
  PAYMONGO_SECRET_KEY: "",
  PAYMONGO_WEBHOOK_SECRET: "",
  PAYMONGO_PAYMENT_METHODS: "card",

  // Connected calendars: no OAuth apps, and background sync and write-back stopped.
  GOOGLE_CALENDAR_CLIENT_ID: "",
  GOOGLE_CALENDAR_CLIENT_SECRET: "",
  MICROSOFT_CALENDAR_CLIENT_ID: "",
  MICROSOFT_CALENDAR_CLIENT_SECRET: "",
  MICROSOFT_CALENDAR_TENANT: "",
  CALENDAR_SYNC_DISABLED: "true",

  // Social media: no Meta app, publishing switched off. The simulated provider is what QA uses.
  META_SOCIAL_APP_ID: "",
  META_SOCIAL_APP_SECRET: "",
  META_GRAPH_VERSION: "",
  META_SOCIAL_WRITES_ENABLED: "false",
  CALENDAR_SYNC_INTERVAL_MINUTES: "10",
  CALENDAR_ICS_POLL_MINUTES: "30",

  // Websites: local host names only, no DNS, no live probes.
  SITES_BASE_DOMAIN: "sites.localhost",
  SITES_CNAME_TARGET: "",
  SITES_PROBE_ORIGIN: "",

  // Operations
  OFFBOARDING_PURGE_ENABLED: "false",
  SCHEDULER_STALE_MINUTES: "20",
  // The Unified Inbox's global emergency switch is pinned off, so the new inbox here follows each QA workspace's own rollout row and nothing else. A shell that
  // exported INBOX_DISABLED=true for a rollout rehearsal, or an env file that names it, cannot change what a browser run is looking at (it would otherwise show
  // the previous inbox everywhere and answer 503 on /api/inbox/*, and the run could be recorded as having verified the new inbox).
  INBOX_DISABLED: "false",
};

/** Variables that must stay empty: hosted database, Supabase, and every provider secret, key and URL. */
export const MUST_BE_BLANK = [
  "DATABASE_URL", "DATABASE_SSL_CA", "DATABASE_SSL_CA_FILE",
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY",
  "APP_ENCRYPTION_KEY_PREVIOUS", "INTEGRATION_ALLOWED_HOSTS",
  "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "TWILIO_WEBHOOK_BASE_URL", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "GHL_WEBHOOK_PUBLIC_KEY",
  "LLM_BASE_URL", "LLM_API_KEY", "N8N_BASE_URL", "N8N_API_KEY", "SLACK_SUPPORT_WEBHOOK_URL",
  "PAYMONGO_SECRET_KEY", "PAYMONGO_WEBHOOK_SECRET",
  "GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "MICROSOFT_CALENDAR_CLIENT_ID", "MICROSOFT_CALENDAR_CLIENT_SECRET",
  "META_SOCIAL_APP_ID", "META_SOCIAL_APP_SECRET",
  "SITES_CNAME_TARGET", "SITES_PROBE_ORIGIN",
];

/** Kill switches that must stay off. */
export const MUST_BE_FALSE = [
  "GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED",
  "OFFBOARDING_PURGE_ENABLED", "ALLOW_INSECURE_HERMES_URLS", "ALLOW_LEGACY_CREDENTIAL_READS",
];

/** The env files Next.js (development) or Vitest could read, in the project root. Only their variable NAMES are ever read. */
export const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local"];

/**
 * The variable names an env file defines (`NAME=…`, `export NAME=…` or `NAME: …`, as dotenv reads them). Values are never returned,
 * kept or printed. A line inside a multi-line quoted value that happens to look like an assignment adds a name, which only makes the
 * guard stricter.
 */
export function envNames(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:\s)/.exec(line);
    if (m && !line.trimStart().startsWith("#")) names.add(m[1]);
  }
  return [...names];
}

/**
 * Refuses to go on unless the QA environment is isolated: every variable named in the project's env files is pinned by `env`, the
 * database is the embedded one with no connection string, sign-in is local, the app answers on its configured loopback port only, and every secret,
 * key and provider URL is blank. Reads only the NAMES in the env files. Throws an Error that lists offending NAMES (never values).
 */
export function assertIsolated({ root = path.resolve(import.meta.dirname, ".."), files = ENV_FILES, env = CRM_QA_ENV } = {}) {
  const problems = [];
  const checked = [];
  const unpinned = new Set();
  for (const f of files) {
    const p = path.isAbsolute(f) ? f : path.join(root, f);
    let text;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw new Error(`Could not read ${path.basename(p)} to check its variable names (${err && err.code ? err.code : "error"}).`);
    }
    checked.push(path.basename(p));
    for (const name of envNames(text)) if (!Object.prototype.hasOwnProperty.call(env, name)) unpinned.add(name);
  }
  if (unpinned.size) problems.push(`not pinned by CRM_QA_ENV (Next.js would read them from the env file): ${[...unpinned].sort().join(", ")}`);
  if (env.DATABASE_DRIVER !== "pglite") problems.push("DATABASE_DRIVER must be pglite");
  if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL !== "") problems.push("DATABASE_URL must be empty");
  if (env.AUTH_PROVIDER !== "local") problems.push("AUTH_PROVIDER must be local");
  if (env.APP_URL !== CRM_QA_URL) problems.push(`APP_URL must be ${CRM_QA_URL}`);
  const dataRoot = path.resolve(root, CRM_QA_DATA_DIR);
  const insideData = (value) => {
    if (typeof value !== "string" || !value) return false;
    return path.resolve(root, value).startsWith(dataRoot + path.sep);
  };
  if (!insideData(env.PGLITE_DATA_DIR)) problems.push("PGLITE_DATA_DIR must be inside " + CRM_QA_DATA_DIR);
  if (!insideData(env.UPLOAD_DIR)) problems.push("UPLOAD_DIR must be inside " + CRM_QA_DATA_DIR);
  if (env.IAQ_DIST_DIR !== ".next-crm-qa") problems.push('IAQ_DIST_DIR must be the isolated ".next-crm-qa" directory');
  if (env.GHL_API_BASE !== "http://127.0.0.1:9") problems.push("GHL_API_BASE must point at the closed local port used by CRM QA");
  const notBlank = MUST_BE_BLANK.filter((k) => env[k] !== "");
  if (notBlank.length) problems.push(`must be empty: ${notBlank.join(", ")}`);
  const notOff = MUST_BE_FALSE.filter((k) => env[k] !== "false");
  if (notOff.length) problems.push(`must be "false": ${notOff.join(", ")}`);
  if (env.CALENDAR_SYNC_DISABLED !== "true") problems.push('CALENDAR_SYNC_DISABLED must be "true"');
  if (env.EMAIL_PROVIDER !== "capture") problems.push("EMAIL_PROVIDER must be capture");
  if (env.HELP_LLM_PROVIDER !== "none") problems.push("HELP_LLM_PROVIDER must be none");
  if (env.NEXT_TELEMETRY_DISABLED !== "1") problems.push('NEXT_TELEMETRY_DISABLED must be "1"');
  if (env.SCHEDULER_ENABLED !== "true") problems.push("SCHEDULER_ENABLED must be \"true\" in the isolated QA harness");
  if (env.SECRET_STORE !== "vault") problems.push("SECRET_STORE must be vault (fails closed on the embedded database, so no credential is ever stored)");  if (problems.length) throw new Error(`The CRM QA environment is not isolated: ${problems.join("; ")}.`);
  return { checkedFiles: checked, pinned: Object.keys(env).length };
}
