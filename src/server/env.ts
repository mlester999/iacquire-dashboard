import "server-only";
import { z } from "zod";
import { isLocalDatabaseHost } from "@/server/db/tls";
import { checkSupabaseConfig, databaseMatchesSupabase, resolveAuthProvider, type AuthProviderName } from "@/lib/supabase-config";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

// Blank values (`VAR=` in .env.local) count as unset.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_DRIVER: z.enum(["pglite", "pglite-memory", "postgres"]).optional(),
  DATABASE_URL: z.string().optional(),
  // Development refuses a remote Postgres database unless this is explicitly true. It is a guard against
  // `npm run dev` / scripts silently writing to the hosted Supabase project; it has no effect in production.
  ALLOW_REMOTE_DB_IN_DEV: bool,
  // Supabase's root CA (PEM text, or a file path) so database TLS can be verified. Required in production.
  DATABASE_SSL_CA: z.string().optional(),
  DATABASE_SSL_CA_FILE: z.string().optional(),
  PGLITE_DATA_DIR: z.string().default(".data/pglite"),
  APP_ENCRYPTION_KEY: z.string().optional(),
  // Comma-separated retired keys, decrypt-only, kept while stored secrets are re-encrypted after a rotation.
  APP_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  SECRET_STORE: z.preprocess(blankToUndefined, z.enum(["vault", "test-memory"]).default("vault")),
  ALLOW_LEGACY_CREDENTIAL_READS: bool,
  INTEGRATION_ALLOWED_HOSTS: z.string().optional(),
  UPLOAD_DIR: z.string().default(".data/uploads"),

  // Supabase is the default. Local identity is explicit and development/test only.
  AUTH_PROVIDER: z.preprocess(blankToUndefined, z.enum(["local", "supabase"]).optional()),
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  SUPABASE_SECRET_KEY: z.preprocess(blankToUndefined, z.string().optional()),

  EMAIL_PROVIDER: z.enum(["capture", "resend"]).default("capture"),
  EMAIL_FROM: z.string().default("iAcquire <no-reply@iacquire.local>"),
  RESEND_API_KEY: z.string().optional(),

  HELP_LLM_PROVIDER: z.enum(["none", "openai_compatible"]).default("none"),
  LLM_BASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("deepseek-chat"),

  SLACK_SUPPORT_WEBHOOK_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  N8N_BASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  N8N_API_KEY: z.string().optional(),
  // Workflow steps that start an agency-approved n8n workflow through its production webhook. Off unless set to true (docs/crm-api.md).
  N8N_ACTIONS_ENABLED: bool,

  GHL_API_BASE: z.string().url().default("https://services.leadconnectorhq.com"),
  GHL_WRITES_ENABLED: bool,
  // Permanent deletion of a departed client's data. Off everywhere until it is switched on deliberately, per environment, after a backup has been restored once.
  OFFBOARDING_PURGE_ENABLED: bool,
  // GoHighLevel's webhook verification key is published and built in; set this only when GoHighLevel rotates it.
  GHL_WEBHOOK_PUBLIC_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  ALLOW_INSECURE_HERMES_URLS: bool,

  // PayMongo: server-only secrets. Key prefixes decide test or live mode; live checkout also needs the review flag in the portal.
  PAYMONGO_SECRET_KEY: z.preprocess(blankToUndefined, z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/, "must be a PayMongo secret key").optional()),
  PAYMONGO_WEBHOOK_SECRET: z.preprocess(blankToUndefined, z.string().min(8).optional()),
  // Comma-separated payment_method_types enabled on the merchant account. Cards only until the approved list is confirmed.
  PAYMONGO_PAYMENT_METHODS: z.string().default("card"),
  // QA ONLY: the address of a simulated PayMongo on THIS machine (scripts/paymongo-sim.mjs), so a browser run can take a purchase from the buyer's Pay button to a signed confirmation
  // without any real provider. It is refused everywhere that is not development or test, for any address that is not this machine's, and for a key that is not a test key.
  PAYMONGO_API_BASE: z.preprocess(blankToUndefined, z.string().url().optional()),
  // PayPal for iAcquire's OWN purchases and plan payments (server-only). The client ID and secret open a PayPal REST app; the webhook id is the id of the webhook registered for
  // /api/webhooks/paypal (a delivery is verified by asking PayPal, with that id). The environment decides test or live: PayPal events do not say, so the app's environment is the only
  // thing that ties a delivery to a mode, and a live app also needs the review flag in the portal. Nothing here touches the customer-payments connections below.
  PAYPAL_CLIENT_ID: z.preprocess(blankToUndefined, z.string().min(8).max(200).optional()),
  PAYPAL_CLIENT_SECRET: z.preprocess(blankToUndefined, z.string().min(8).max(300).optional()),
  PAYPAL_WEBHOOK_ID: z.preprocess(blankToUndefined, z.string().min(8).max(120).optional()),
  PAYPAL_ENVIRONMENT: z.preprocess(blankToUndefined, z.enum(["sandbox", "live"]).default("sandbox")),
  PAYPAL_MAINTENANCE_PLAN_ID: z.preprocess(blankToUndefined, z.string().regex(/^P-[A-Za-z0-9]{6,80}$/, "A PayPal billing plan id looks like P-1AB23456CD789012E").optional()),
  // QA ONLY: the address of a simulated PayPal on THIS machine (scripts/paypal-sim.mjs), so a browser run can take a purchase or a monthly agreement from the buyer's button to a
  // confirmed notice without any real provider. It is refused everywhere that is not development or test, for any address that is not this machine's, for the live environment, and
  // for credentials that are not the simulator's made-up ones (their client id starts with "qa-sim-").
  PAYPAL_API_BASE: z.preprocess(blankToUndefined, z.string().url().optional()),
  // Customer payments: the business's OWN PayMongo (or PayPal) account, used to collect on invoices it sends to its customers. Nothing here touches iAcquire's own billing above.
  // CUSTOMER_PAYMENTS_WRITES_ENABLED is the master switch for any call to a real payment provider (checking a pasted key, starting a checkout, reading a payment back); off,
  // only the simulated provider works, and a received PayMongo webhook is still recorded because money that arrived is recorded whatever a switch says. A PayPal delivery can
  // only be checked by calling PayPal, so while this is off it is answered 503 with Retry-After and nothing is stored: PayPal sends it again, and the scheduled check of open
  // checkouts records the payment once this is on. CUSTOMER_PAYMENTS_LIVE_ENABLED is the global kill switch for real money: off, no live-mode checkout is started anywhere and no
  // workspace can confirm live. Both are founder-approved switches.
  CUSTOMER_PAYMENTS_WRITES_ENABLED: bool,
  CUSTOMER_PAYMENTS_LIVE_ENABLED: bool,
  // Shared secret for scheduled worker endpoints (reservation expiry, escalation timers, follow-ups).
  CRON_SECRET: z.preprocess(blankToUndefined, z.string().min(24).optional()),
  // Restricted Hermes provisioner worker. Disabled by default and pinned to one reviewed client-only gateway.
  HERMES_PROVISIONER_ENABLED: bool,
  HERMES_PROVISIONER_TOKEN: z.preprocess(blankToUndefined, z.string().min(32).max(512).optional()),
  HERMES_PROVISIONER_GATEWAY_ID: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  // Second, deliberate switch for the scheduled worker. Both this and CRON_SECRET must be set before any job can run, so deploying
  // the scheduler configuration cannot start outbound work by itself. Off unless explicitly enabled.
  SCHEDULER_ENABLED: bool,
  // Staged activation: when set, a scheduler tick runs only the jobs named here (comma separated, exact names from src/server/ops/tick.ts) and no others.
  // Unset or empty runs every job, behind CRON_SECRET and SCHEDULER_ENABLED. A non-empty list must name known jobs; whitespace-only, comma-only, unknown, or overlong values
  // fail the tick closed and can never expand to every job. This is checked by activeJobs in the tick, not env(), so a bad list stops the scheduler without taking down the app.
  // See docs/production-scheduler.md and docs/unified-inbox/scheduler-impact.md.
  SCHEDULER_JOBS_ONLY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // The scheduler is reported as stopped when its last completed run is older than this. Set it to a few times the schedule interval.
  SCHEDULER_STALE_MINUTES: z.coerce.number().int().min(2).max(1440).default(20),
  // Automation Studio: days a workspace keeps the plan's features after a payment is recorded as failed, before the plan expires. An agency member
  // can choose a different number (1 to 30) for one case when recording the failure.
  STUDIO_PAYMENT_GRACE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // Website Studio. Included sites live at <label>.<SITES_BASE_DOMAIN>; custom domains point (CNAME) at SITES_CNAME_TARGET.
  SITES_BASE_DOMAIN: z.preprocess(blankToUndefined, z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$|^[a-z0-9-]+\.localhost$/i).default("sites.iacquire.com")),
  SITES_CNAME_TARGET: z.preprocess(blankToUndefined, z.string().optional()),
  // portal: the authenticated application. sites: the public website runtime only. both: local development.
  DEPLOYMENT_ROLE: z.preprocess(blankToUndefined, z.enum(["portal", "sites", "both"]).default("portal")),
  // Signs the spam-control token on site forms. Falls back to APP_ENCRYPTION_KEY, which the sites role should not hold, so set it separately there.
  SITES_FORM_SECRET: z.preprocess(blankToUndefined, z.string().min(24).optional()),
  // Where the post-publish health check should connect (for example a private load-balancer address); defaults to https://<host>.
  SITES_PROBE_ORIGIN: z.preprocess(blankToUndefined, z.string().url().optional()),
  HERMES_RUN_TIMEOUT_MS: z.coerce.number().int().min(5000).max(900000).default(180000),

  // Connected calendars (Native CRM). Each OAuth provider is offered only when both its client ID and secret are set; see docs/calendar-integrations.md.
  GOOGLE_CALENDAR_CLIENT_ID: z.preprocess(blankToUndefined, z.string().max(300).optional()),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.preprocess(blankToUndefined, z.string().max(300).optional()),
  MICROSOFT_CALENDAR_CLIENT_ID: z.preprocess(blankToUndefined, z.string().max(300).optional()),
  MICROSOFT_CALENDAR_CLIENT_SECRET: z.preprocess(blankToUndefined, z.string().max(300).optional()),
  // "common" (work, school and personal accounts), "organizations", "consumers", or one Entra tenant ID or domain.
  MICROSOFT_CALENDAR_TENANT: z.preprocess(blankToUndefined, z.string().regex(/^[A-Za-z0-9.-]{1,100}$/).default("common")),
  // Stops all background calendar sync and write-back (and "Sync now") without disconnecting anyone.
  CALENDAR_SYNC_DISABLED: bool,

  // Social media manager (Facebook Pages and Instagram professional accounts through Meta's Graph API). This is a different Meta app from the WhatsApp one
  // above. Connecting is offered only when both the app ID and secret are set; nothing is ever posted unless META_SOCIAL_WRITES_ENABLED is true (a founder-approved
  // switch, like the other provider write switches). GRAPH_VERSION is read from Meta's SDK at build time of this feature (v26.0) and can be changed without code.
  META_SOCIAL_APP_ID: z.preprocess(blankToUndefined, z.string().max(100).optional()),
  META_SOCIAL_APP_SECRET: z.preprocess(blankToUndefined, z.string().min(16).max(200).optional()),
  META_GRAPH_VERSION: z.preprocess(blankToUndefined, z.string().regex(/^v\d{1,2}\.\d$/, "must look like v26.0").default("v26.0")),
  META_SOCIAL_WRITES_ENABLED: bool,
  // Public reviews read from review sites (CRM -> Reviews -> Public reviews). Every switch is off by default and a founder-approved step: nothing reads or posts to a real
  // site until the matching approval exists. GOOGLE_BUSINESS_API_APPROVED says Google approved iAcquire's Cloud project for the Business Profile APIs (and verified the
  // consent screen for business.manage); the client ID and secret belong to that project. Replies are a separate switch from reading. Facebook reads through the Page
  // connected for Social media and needs Meta's review permissions; META_REVIEWS_REPLIES_ENABLED is the separate switch for replying there.
  GOOGLE_BUSINESS_API_APPROVED: bool,
  GOOGLE_BUSINESS_CLIENT_ID: z.preprocess(blankToUndefined, z.string().max(300).optional()),
  GOOGLE_BUSINESS_CLIENT_SECRET: z.preprocess(blankToUndefined, z.string().max(300).optional()),
  GOOGLE_BUSINESS_REPLIES_ENABLED: bool,
  META_REVIEWS_ENABLED: bool,
  META_REVIEWS_REPLIES_ENABLED: bool,
  // How much managed media storage one workspace may use for social media posts, in megabytes. A proposed default (2 GB), pending the founder's confirmation.
  SOCIAL_MEDIA_STORAGE_MB: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(1_048_576).default(2048)),
  // Switches the Unified Inbox off: the /inbox page, /api/inbox/* and the inbox's actions answer "temporarily unavailable", and the inbox's own
  // notices stop. Receiving, storing and sending messages, the AI employees and workflows are not touched. Unset or false (the default) = on.
  INBOX_DISABLED: bool,
  // Switches the public website chat off for every workspace at once: the widget's API answers "unavailable" and the widget leaves the page alone. Chats already
  // stored, the Inbox and the AI employees are not touched. Unset or false (the default) = each workspace follows its own widget settings.
  WEBCHAT_PUBLIC_DISABLED: bool,
  // Switches the customer-facing side of proposals off for every workspace at once: /proposal/<token>, its PDF and its API answer "temporarily unavailable" before any database
  // read, and no emailed code is sent. Proposals the team is writing are not touched. Unset or false (the default) = each workspace follows its own switch.
  PROPOSALS_PUBLIC_DISABLED: bool,
  // The same for the customer's invoice page: /pay/<token>, the page a payment provider sends the customer back to (/pay/return/<reference>) and the three /api/public/invoices
  // routes answer "temporarily unavailable" for every workspace at once, before any database read. Invoices the team is writing, payments a provider reports to its webhook and
  // the reminders already queued are not touched. Unset or false (the default) = each workspace follows its own switch.
  INVOICES_PUBLIC_DISABLED: bool,
  // The same for the customer's review page: /r/<token> and the two forms on it (private feedback, and the click on a public review link) answer "temporarily unavailable" for every
  // workspace at once, before any database read, and nothing is recorded. Requests already sent, the team's Reviews screens and public reviews read from a review site are not
  // touched. Unset or false (the default) = the page works as usual.
  REVIEWS_PUBLIC_DISABLED: bool,
  // The prospect demo (/demo, /api/public/demo/*) has two switches that must both agree. DEMO_ENABLED is the deployment's own permission to run it at all: unset or false (the
  // default) the public pages answer "not available" and no email is sent. The Super Admin's own switch (demo_settings.enabled, also off by default) is the second. Nothing
  // already stored is touched by either.
  DEMO_ENABLED: bool,
  // The emergency stop: true makes every public demo page and route answer "temporarily unavailable" before any database read, whatever the two switches above say. A prospect
  // who already has a conversation keeps it; the agency's own Prospects screens are not touched. Unset or false (the default) = the two switches above decide.
  DEMO_PUBLIC_DISABLED: bool,
  // Server-to-server registration from the separate marketing website (docs/demo-external-registration.md). Off unless this is true AND a signing secret is set, so the
  // endpoint cannot be reached by accident. The secret is the marketing backend's IACQUIREOS_BACKEND_SIGNING_SECRET: server-only, never a NEXT_PUBLIC_ value.
  DEMO_REGISTRATION_ENABLED: bool,
  DEMO_REGISTRATION_SIGNING_SECRET: z.preprocess(blankToUndefined, z.string().min(32).max(200).optional()),
  // The marketing site's own origins, comma-separated. Checked only when a request carries an Origin header (a browser); a server-to-server call normally carries none.
  // An empty list refuses every request that names an origin. Never a wildcard.
  DEMO_REGISTRATION_ALLOWED_ORIGINS: z.preprocess(blankToUndefined, z.string().max(1000).optional()),
  // How far a signed request's timestamp may be from this server's clock, either way. Short: a captured request is useless a few minutes later.
  DEMO_REGISTRATION_MAX_SKEW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  // How long an emailed demo link works (and it works once). Independent of the 24-hour demo window: a link that is never opened expires on its own. 48 hours by default.
  DEMO_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(48),
  // The master switch for anything that creates or sends a signing request at a REAL signing service (PandaDoc): off (the default), a request for a real connection waits
  // untouched and nothing leaves the machine. Reading what a service reports (checking a pasted key, a request's status, fetching a signed copy) is not a write and is not
  // held by it. The simulated service reaches nothing and is not affected; it is refused in production. A founder-approved switch, like the other provider write switches.
  ESIGN_WRITES_ENABLED: bool,
  // How many AI replies the website chat may write for one workspace per UTC day. Past it, visitors are told a team member will follow up and a person is asked to
  // reply. 500 is a PROPOSED default, pending the founder's confirmation; 0 stops the assistant's replies altogether without closing the chat.
  WEBCHAT_DAILY_AI_REPLIES: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(100_000).default(500)),
  CALENDAR_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(2).max(1440).default(10),
  CALENDAR_ICS_POLL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  // Native messaging transports (see docs/messaging-providers.md). Each has its own kill switch, off unless set to true, exactly like
  // GHL_WRITES_ENABLED: while it is off nothing is sent through that provider and the message is held with the reason.
  RESEND_WRITES_ENABLED: bool,
  TWILIO_WRITES_ENABLED: bool,
  META_WHATSAPP_WRITES_ENABLED: bool,
  // Resend signs webhooks through Svix; this is the endpoint's signing secret from the Resend dashboard (whsec_…).
  RESEND_WEBHOOK_SECRET: z.preprocess(blankToUndefined, z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,}$/, "must be the Resend webhook signing secret (whsec_…)").optional()),
  // Twilio signs the exact public URL it called. Set this when the public origin differs from APP_URL (for example behind a proxy).
  TWILIO_WEBHOOK_BASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  // The Meta app's secret signs WhatsApp webhooks (X-Hub-Signature-256); the verify token answers Meta's subscription handshake.
  META_APP_SECRET: z.preprocess(blankToUndefined, z.string().min(16).max(200).optional()),
  META_WEBHOOK_VERIFY_TOKEN: z.preprocess(blankToUndefined, z.string().min(16).max(200).optional()),
});

export type Env = z.infer<typeof schema> & {
  DATABASE_DRIVER: "pglite" | "pglite-memory" | "postgres";
  AUTH_PROVIDER: AuthProviderName;
};

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server environment configuration: ${fields}`);
  }
  const value = parsed.data;
  if (value.HERMES_PROVISIONER_ENABLED && (!value.HERMES_PROVISIONER_TOKEN || !value.HERMES_PROVISIONER_GATEWAY_ID)) {
    throw new Error("HERMES_PROVISIONER_ENABLED requires its server-only token and pinned gateway id.");
  }
  const authProvider = resolveAuthProvider(process.env);
  const driver = value.DATABASE_DRIVER ?? (authProvider === "local" ? "pglite" : "postgres");
  // A secret in a NEXT_PUBLIC_ variable is a leak in every environment, not just production.
  const leaks = checkSupabaseConfig(process.env, false).filter((p) => p.code === "secret_in_public_var");
  if (leaks.length) throw new Error(leaks.map((p) => p.message).join(" "));
  if (value.SECRET_STORE === "test-memory" && value.NODE_ENV !== "test") throw new Error("SECRET_STORE=test-memory is allowed only in tests.");
  // The external demo registration endpoint is open to another server, so a half-configured deployment is refused at boot rather than failing (or trusting) per request.
  if (value.DEMO_REGISTRATION_ENABLED) {
    if (!value.DEMO_REGISTRATION_SIGNING_SECRET) {
      throw new Error("DEMO_REGISTRATION_ENABLED requires DEMO_REGISTRATION_SIGNING_SECRET (at least 32 characters, server-only; never a NEXT_PUBLIC_ value).");
    }
    for (const origin of (value.DEMO_REGISTRATION_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error(`DEMO_REGISTRATION_ALLOWED_ORIGINS contains an invalid origin (${origin}).`);
      }
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(value.NODE_ENV !== "production" && local)) {
        throw new Error(`DEMO_REGISTRATION_ALLOWED_ORIGINS must be https origins (http is allowed only for localhost outside production): ${origin}`);
      }
    }
  }
  if (value.PAYMONGO_API_BASE) {
    let host = "";
    try { host = new URL(value.PAYMONGO_API_BASE).hostname; } catch { host = ""; }
    if (value.NODE_ENV === "production") throw new Error("PAYMONGO_API_BASE (a simulated PayMongo) is refused in production.");
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error("PAYMONGO_API_BASE may only name this machine (127.0.0.1, localhost or ::1).");
    if (value.PAYMONGO_SECRET_KEY && !value.PAYMONGO_SECRET_KEY.startsWith("sk_test_")) throw new Error("A simulated PayMongo (PAYMONGO_API_BASE) is only used with a test key.");
  }
  if (value.PAYPAL_API_BASE) {
    let host = "";
    try { host = new URL(value.PAYPAL_API_BASE).hostname; } catch { host = ""; }
    if (value.NODE_ENV === "production") throw new Error("PAYPAL_API_BASE (a simulated PayPal) is refused in production.");
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error("PAYPAL_API_BASE may only name this machine (127.0.0.1, localhost or ::1).");
    if (value.PAYPAL_ENVIRONMENT === "live") throw new Error("A simulated PayPal (PAYPAL_API_BASE) is never used with the live environment.");
    if (value.PAYPAL_CLIENT_ID && !value.PAYPAL_CLIENT_ID.startsWith("qa-sim-")) throw new Error("A simulated PayPal (PAYPAL_API_BASE) is only used with the simulator's made-up client id.");
  }
  // Development must never reach a hosted database by accident. The sample `.env` historically pointed `npm run dev` and the
  // maintenance scripts at the production Supabase project; one manual test could then change real client data. Local PGlite is
  // the safe default (see .env.development). Remote development is still possible, but only as an explicit, visible opt-in.
  if (value.NODE_ENV === "development" && driver === "postgres" && value.DATABASE_URL?.trim() && !isLocalDatabaseHost(value.DATABASE_URL)) {
    let host = "the configured remote host";
    try { host = new URL(value.DATABASE_URL).hostname; } catch { /* fall back to the generic description */ }
    if (!value.ALLOW_REMOTE_DB_IN_DEV) {
      throw new Error(
        `Refusing to run development against a remote database (${host}). ` +
          "Local development defaults to the embedded database in .env.development. " +
          "If this remote database is intentional (for example a dedicated staging project), set ALLOW_REMOTE_DB_IN_DEV=true explicitly. " +
          "Production ignores this guard.",
      );
    }
    console.warn(`[iacquire] DEVELOPMENT is connected to a remote Postgres database (${host}); writes affect that environment.`);
  }
  if (value.NODE_ENV === "production") {
    if (authProvider === "local") {
      throw new Error(
        "Production requires Supabase Auth: set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY. " +
          "AUTH_PROVIDER=local is for synthetic local development and tests only.",
      );
    }
    if (authProvider === "supabase") {
      const problems = checkSupabaseConfig(process.env, true);
      if (problems.length) throw new Error(`Supabase is not fully configured: ${problems.map((p) => p.message).join(" ")}`);
    }
    if (driver !== "postgres" || !value.DATABASE_URL) {
      throw new Error("Production requires DATABASE_DRIVER=postgres and DATABASE_URL.");
    }
    if (!databaseMatchesSupabase(process.env)) throw new Error("DATABASE_URL must connect to the configured Supabase portal project. The Hostinger appointment database is separate.");
    if (!isLocalDatabaseHost(value.DATABASE_URL) && !value.DATABASE_SSL_CA?.trim() && !value.DATABASE_SSL_CA_FILE?.trim()) {
      throw new Error("Production requires verified database TLS: download Supabase's root certificate (Project Settings → Database → SSL configuration) and set DATABASE_SSL_CA_FILE.");
    }
    if (value.ALLOW_LEGACY_CREDENTIAL_READS) throw new Error("Legacy credential reads cannot be enabled in production.");
    if (!value.APP_ENCRYPTION_KEY || value.APP_ENCRYPTION_KEY.length < 32) {
      throw new Error("Production requires APP_ENCRYPTION_KEY with at least 32 characters.");
    }
    if (value.ALLOW_INSECURE_HERMES_URLS) {
      throw new Error("ALLOW_INSECURE_HERMES_URLS cannot be enabled in production.");
    }
  }
  cached = { ...value, DATABASE_DRIVER: driver, AUTH_PROVIDER: authProvider };
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";

/**
 * Called once when the Node server starts. It exists separately from `env()` because startup work catches and logs its own
 * failures; a misconfigured development database must stop the process instead of being swallowed and failing per request.
 */
export function assertSafeDevelopmentDatabase(): void {
  // env() performs the check (and warns once when a remote development database was explicitly allowed).
  env();
}

/** Clears the cached configuration. Tests only. */
export function resetEnvCache() {
  cached = null;
}
