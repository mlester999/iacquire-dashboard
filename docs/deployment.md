# Deployment

Nothing in this repository creates infrastructure, sends customer messages, or changes Hermes,
GoHighLevel, n8n or Hostinger. Each step below is a deliberate action by iAcquire. No production
deployment has been performed.

## Requirements

- Node.js 20.9+ (developed and tested on Node 24).
- An authorized Supabase project with Auth, PostgreSQL, Storage, Realtime and Vault. Use a separate
  project (and separate keys) for development and production. See [supabase-setup.md](supabase-setup.md).
- HTTPS in front of the app (Supabase session cookies are `Secure` and `HttpOnly` in production).
- A hosting provider with secure environment settings for server secrets.

## Environment

See `.env.example` for every variable. In production the app refuses to start unless all of these hold
(`src/server/env.ts`):

| Variable | Requirement |
| --- | --- |
| `NODE_ENV` | `production` |
| `AUTH_PROVIDER` | `supabase` (or unset). `local` is rejected in production |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The approved project's URL and publishable key (browser-safe) |
| `SUPABASE_SECRET_KEY` | Server-only secret key. Never prefix with `NEXT_PUBLIC_` |
| `DATABASE_DRIVER` / `DATABASE_URL` | `postgres` and that **same** Supabase project's connection string, with `sslmode=require`. A mismatched project, or the Hostinger appointment database, is rejected |
| `DATABASE_SSL_CA_FILE` | Relative to the project root, for example `certs/prod-ca-2021.crt`. Vercel's server-function file trace includes this public root CA; do not set a path from a developer workstation |
| `APP_ENCRYPTION_KEY` | 32+ random characters. Used for audit IP hashing and for decrypting earlier-release credentials during migration only; new integration secrets use Supabase Vault. Keep it in secure settings, separate from the database, and back it up |
| `ALLOW_LEGACY_CREDENTIAL_READS` | must be unset/false |
| `ALLOW_INSECURE_HERMES_URLS` | must be unset/false |
| `INTEGRATION_ALLOWED_HOSTS` | exact Hermes/n8n HTTPS hosts (and ports) the server may call |
| `SECRET_STORE` | `vault` (default). `test-memory` is refused outside tests |

Also set `APP_URL`, `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` (verified domain) once you
authorize an email provider, and optionally `SLACK_SUPPORT_WEBHOOK_URL` and the help-assistant LLM
variables. Keep `GHL_WRITES_ENABLED=false`.

## First deployment (after you authorize each step)

```bash
npm ci
npm run build
npm run db:migrate                              # explicit; hosted PostgreSQL is never auto-migrated
npm run db:seed                                 # agency organization only — never --demo against real data
npm run admin:invite -- --email you@iacquire.ai # prints a one-time link for the first super admin
npm start
```

`npm run db:migrate` applies `supabase/migrations/` and honors Supabase CLI migration history, so the
same files work with `supabase db push`. Never run `supabase/local-compat.sql` against a real project:
it emulates managed schemas for disposable local tests only. Migrating existing data and accounts is a
separate, reviewed procedure: [supabase-setup.md](supabase-setup.md#transfer-existing-persistent-data-safely)
and [migration-plan.md](migration-plan.md).

Then, from `/admin`: invite agency staff, create client workspaces (each client owner receives an
invitation), open **Integrations** to connect Hermes/n8n, and open each client's **Integrations** to add
their GoHighLevel location and employee profiles, following [integrations-setup.md](integrations-setup.md).

## Scheduled work (required)

Messaging, follow-ups, appointment reminders, retention programs, website enquiries, health checks, incident detection, fair-use checks, inactivity
review and offboarding reminders all run from **one** endpoint, `POST /api/internal/tick`, authorized by `Authorization: Bearer $CRON_SECRET`
(24+ random characters). Call it every one to two minutes from your host's scheduler. Each job is idempotent, so overlapping or repeated calls
are safe, and a failing job never stops the others. See [operations-and-incidents.md](operations-and-incidents.md).

| Variable | Purpose |
| --- | --- |
| `CRON_SECRET` | Authorizes `/api/internal/*`. Without it the scheduler cannot run and **no queued message is ever sent** |
| `SCHEDULER_STALE_MINUTES` (default 20) | Minutes without a heartbeat before a "scheduled jobs stopped" incident opens |
| `OFFBOARDING_PURGE_ENABLED` (default false) | Permanent deletion of a departed client's data. Leave off until a backup restore has been proven (see [offboarding-and-export.md](offboarding-and-export.md)) |
| `SITES_BASE_DOMAIN`, `SITES_CNAME_TARGET`, `SITES_FORM_SECRET`, `SITES_PROBE_ORIGIN`, `DEPLOYMENT_ROLE` | Website Studio. Serve published sites from their own deployment (`DEPLOYMENT_ROLE=sites`) with wildcard DNS and certificate, see [website-studio.md](website-studio.md) |
| `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `PAYMONGO_PAYMENT_METHODS` | Credit top-ups. Start with **test** keys; live checkout needs the live-payments review recorded in `/admin/billing` |

Also point an external uptime monitor at `GET /api/health`: it is where the scheduler-freshness check runs from, because a stopped scheduler cannot report itself.

## Operations

- **Health:** `GET /api/health` (database connectivity, no secrets) for uptime checks; the agency
  **System health** page shows Hermes, GHL, n8n, email, migrations and recent errors.
- **Scaling:** run a single app instance until live chat streaming is moved to a shared channel. The
  in-process stream hub means a second instance can't re-attach a browser to a run started on another
  (the final answer is still saved). Use sticky sessions or add pub/sub before scaling out.
- **Setup Center live updates** combine scoped Supabase Realtime revision signals (private
  `setup:<organization>` topics, authorized by Row Level Security), server-sent events with a 5-second
  database revision check, and client polling. They converge across several instances without extra
  infrastructure, and any single channel failing never leaves a screen stale for long. On start the app
  creates a checklist for any client workspace that lacks one and re-evaluates unfinished checklists
  from recorded evidence (it never contacts external systems).
- **`/dev/*` pages** (setup and integrations previews, mailbox) exist for development only and return 404
  in production.
- **Rate limits** are stored in Postgres (`rate_limit_buckets`), so they hold across instances. Old
  buckets can be pruned periodically.
- **Backups:** the Supabase database (use Supabase's backup features plus a tested restore), the private
  Storage buckets, and `APP_ENCRYPTION_KEY` (stored separately).
- **Proxy headers:** behind a reverse proxy, make sure `X-Forwarded-For` is set by your proxy only;
  login rate limiting keys on the first forwarded address.

## What remains before calling this production-ready

1. **Connect and verify Supabase** — authorize a development project, run the live acceptance checklist
   in [verification-status.md](verification-status.md), then repeat for production with separate keys.
2. **Hermes provisioning** — create a blank dedicated profile per client employee, restrict toolsets,
   expose the gateway over private networking or a protected HTTPS gateway, connect and pass health
   checks. Capacity-plan the VPS (up to six profiles per client).
3. **GoHighLevel** — per-location tokens with read scopes; verify and sync each tenant. Design and
   review a write path (lead import, CRM updates, bookings) before enabling `GHL_WRITES_ENABLED`. Marketplace
   appointment webhooks are a separate, not-yet-built connection.
4. **Appointment booking** — the portal keeps its own appointment event ledger and reads real calendar availability; creating bookings
   through GHL needs the reviewed write path (`GHL_WRITES_ENABLED`) enabled deliberately for a *test* location first. The n8n Appointment Event
   Processor is not used and must stay inactive. See [appointments.md](appointments.md).
5. **Email** — Resend (or another provider) with a verified sending domain. Setup-update emails also need
   each person to opt in under Settings → Notifications.
6. **Setup Center connectors** — the checks for CRM snapshot, CRM assets, workflows, website/domain, email
   domain and Google Calendar have no connector yet, so those steps need an agency attestation with
   evidence, and a super admin must acknowledge them at activation. See
   [setup-center.md](setup-center.md#connectors-and-provisioning-typed-seams).
7. **Payments** — PayMongo checkout, the credit ledger and the webhook are built and tested with mocks only. Add **test** keys, run a test
   top-up end to end, reconcile it, then complete the live-payments review before any live key. See [finance-and-billing.md](finance-and-billing.md).
8. **Document text extraction** — PDF/DOCX uploads are stored securely but only TXT/MD/CSV text is given
   to AI employees today.
9. **External review** — a penetration test of auth, tenant isolation, uploads and credential handling
   before onboarding real clients.
10. **Apply migrations 0016–0025** to the development Supabase project first (after a backup), then production, with `npm run db:migrate`.
11. **Business and legal review** — retention and marketing wording, prepaid-credit treatment, the reserve and tax guidance, fair-use thresholds,
    the retention period and the licensing text in the data export.
12. **Backups** — prove one restore of the database and private storage before enabling permanent deletion.
