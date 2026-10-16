# iAcquire Native CRM: repository audit and implementation map

Audit date: 2026-10-16. Branch `claude/sweet-mccarthy-xtxtxv`, starting from `0fa9a47` (identical to `origin/master`).
This document was written **before** any Native CRM code changed existing behaviour. The live status of each capability is
tracked in [native-crm-parity.md](native-crm-parity.md); the architecture that was built is in [native-crm.md](native-crm.md).

## Baseline

| Check | Result at `0fa9a47` |
| --- | --- |
| `npm ci` | **Fails**: `package-lock.json` is missing `@emnapi/runtime@1.11.3` and `@emnapi/core@1.11.3`. `npm install` works. The lockfile was left untouched in this work (it is an unrelated change); fix it with `npm install` and commit the lockfile separately. |
| Typecheck | Clean |
| Tests | 69 files, 1,030 tests, all passing (embedded PGlite, ~100 s) |
| Migrations | `0001`–`0026` (154 public tables). All 26 applied to the hosted Supabase project per `docs/schema-inventory.md` |

### Database safety

Nothing in this work connects to a hosted database. Tests use `DATABASE_DRIVER=pglite-memory` (set in `vitest.config.ts`),
which runs every migration into a throwaway in-memory PostgreSQL per test file. The container has no `.env`, so there is no
`DATABASE_URL` that could point at the shared Supabase project. New migrations are written and verified only against that
embedded database. **Applying them to the hosted project remains a separate step that needs your explicit approval**
(`npm run db:migrate`, see the rollout plan in [native-crm.md](native-crm.md#production-rollout)).

## 1. What already works (reused, not rebuilt)

| Area | Where | Notes for Native CRM |
| --- | --- | --- |
| Tenancy and roles | `organizations`, `organization_memberships`, `staff_assignments`, `role_permissions`, `src/lib/permissions.ts`, `src/server/tenancy/context.ts` | Permission matrix mirrored in SQL (`app.has_permission`). A test fails if they drift. Native CRM adds granular `crm.*` permissions to the same matrix. |
| Two-layer isolation | `withUser` (RLS as `iaq_app_user`) and `withSystem` (trusted, authorize first); composite `(id, org_id)` foreign keys; `tests/tenant-isolation-generic.test.ts` inspects every table with `org_id` | Every new CRM table gets RLS, scoped select policies, same-tenant composite keys, and is automatically covered by the generic test. |
| Contacts (messaging working copy) | `contacts`, `contact_identities` (exact normalized phone/email, unique per tenant), `contact_merges`, `contact_memories`, `contact_consent_events` (append-only), `suppressions` | Extended in place to become the Native CRM contact record. Matching by exact identifier, never by name, is kept. |
| Unified Inbox | `conversations`, `conversation_messages`, `message_delivery_events`, `webhook_receipts`, ownership events, escalations; `src/server/messaging/*` | Delivery states only advance on provider events. Human takeover and single-winner claims exist. Reused as the Native CRM inbox. |
| Follow-ups | `follow_up_plans/steps`, presets Off/Gentle/Balanced/Persistent/Custom, one active plan per contact across channels | Reused; Native CRM transports plug in underneath. |
| Approvals | `approval_requests` with atomic decide and claim-once execution | Reused for AI CRM actions and high-impact operations. |
| Operating controls | `automation_pauses`, employee modes Autonomous / Approval required / Paused, emergency stops | Reused for workflow and AI gating. |
| Billing and metering | credits ledger, reservations, `metered_usage_events`, unit rates with the approved 30% markup | Native transports publish rates under their own provider name; internal CRM operations are not metered. |
| Scheduler | `POST /api/internal/tick` (Bearer `CRON_SECRET`), `runJob` heartbeats in `worker_job_runs` | Durable CRM jobs (event dispatch, workflows, imports, calendar sync, webhooks) run as jobs here. No in-memory timers. |
| Credentials | `credential_references` → Supabase Vault (`test_memory` store only in tests) | Reused for SMS/WhatsApp/Resend/calendar credentials. OAuth tokens need a system-save path (added). |
| Website Studio leads | `website_form_submissions` → `processOne` already creates/updates a **native** contact and records consent from the form's exact wording | Native CRM adds tags, opportunity creation, workflow events and booking on top. No GHL involved today. |
| Audit | `audit_logs` (append-only), `recordAudit` with secret-key redaction | Every CRM write and every agency support access is audited. |
| Hermes | Per-tenant employee profiles, structured config, restricted toolsets, runs over SSE | Hermes stays the orchestration layer. CRM tools are exposed by the portal, scoped by a server-issued token, never by an AI-supplied organization ID. |

## 2. Exists but incomplete

| Area | Gap |
| --- | --- |
| Contacts | No first/last name, address, company, lead status, owner rules, tags, custom fields, notes, tasks timeline, directory UI, import/export. |
| Tasks | `tasks` has no priority, contact/opportunity foreign keys, comments, or reminders. |
| Notes | `record_notes` only allows opportunity/lead/retention/appointment records. |
| Pipelines | `crm_pipelines` / `crm_opportunities` are a **read-through cache of GoHighLevel** (`ghl_*_id NOT NULL`); stages are JSON; no writes. |
| Appointments | `appointment_refs` is a **GoHighLevel cache**; availability comes from the GHL calendar; portal bookings are written to GHL and are blocked while `GHL_WRITES_ENABLED=false`. |
| Email | `src/server/email.ts` only sends when `EMAIL_PROVIDER=resend`. With the default `capture`, mail is stored in `email_outbox` and never reaches Resend, even if `RESEND_API_KEY` is set and the domain is verified. This explains an invitation that stays pending with nothing in Resend's log. Commit `1eef5d0` already reports the real delivery state; production needs `EMAIL_PROVIDER=resend` and `EMAIL_FROM` on the verified domain. No idempotency key is sent. |
| Workflows | Only agency-level n8n template mappings (`automation_template_mappings`); no native trigger/action engine. |
| Reporting | Analytics read GHL caches and messaging tables; no CRM reporting on native data. |
| Onboarding | Readiness counts `ghl_location_mappings` for the CRM step. |

## 3. What currently requires GoHighLevel

1. **Outbound messaging transport**: `messaging_channels.provider` is constrained to `'ghl'`; `evaluateSend` refuses a contact without `ghl_contact_id`; unit rates are looked up for provider `'ghl'` only; `dispatchMessage` defaults to `ghlProvider`.
2. **Sales pipeline**: `/sales` shows "Your CRM isn't connected yet" without a GHL location.
3. **Calendar and booking**: availability and booking go through `ghlAppointmentProvider`.
4. **Inbound messages**: only `/api/webhooks/ghl` ingests messages.
5. **Setup Center / provisioning**: "CRM & pipelines" is described as a GoHighLevel workspace; `ghl_subaccount_mapping` and `crm_snapshot` steps.
6. **Integrations page**: lists only "GoHighLevel CRM" and a GHL-backed "Calendar".
7. **Agency health and fleet snapshots**: count a client as healthy only when `ghl_status = 'connected'`.

## 4. What can run on iAcquire Native CRM

Contacts, companies, tags, custom fields, Smart Lists, notes, tasks, pipelines and opportunities, native calendars and
bookings with database-enforced conflict prevention, booking pages, website lead capture, workflows, follow-ups,
templates, campaigns (consent-gated), reviews requests, call activity, reporting, blueprints, imports and exports need
**no external provider at all**. External services are only needed to *deliver* something outside the platform:

| Capability | Provider (no GHL) | Needs real credentials to verify |
| --- | --- | --- |
| Email | Resend (existing account) | `RESEND_API_KEY`, verified domain, webhook signing secret |
| SMS | Twilio (adapter) | Account SID, auth token, a sender number, A2P/10DLC or local registration |
| WhatsApp | Meta WhatsApp Business Cloud API (official) | WABA, phone number ID, permanent token, app secret, approved templates |
| Google Calendar / Meet | Google Calendar API v3 | OAuth client (and Google verification for sensitive scopes) |
| Outlook / Microsoft 365 / Teams | Microsoft Graph | Entra app registration (delegated permissions) |
| iCloud / CalDAV | CalDAV (RFC 4791) | Apple ID + app-specific password per user |
| ICS feeds | HTTPS polling (read-only) | A feed URL |
| Zoom | Zoom Server-to-Server OAuth app | Account ID, client ID/secret |
| Google Business Profile reviews | Business Profile APIs (access is granted by Google on application) | Approved project + OAuth |
| Voice activity | Existing Vapi/Retell webhooks | Provider webhook secret |
| Advanced automations | n8n (existing) | Existing agency n8n connection |
| AI | Hermes (existing) | Existing per-tenant profiles |

## 5. Provider adapters that change

| Adapter | Change |
| --- | --- |
| `src/server/messaging/provider.ts` | `ChannelProvider` becomes one of several: `ghl`, `resend`, `twilio`, `meta_whatsapp`. Selected per tenant and channel from `messaging_channels.provider`. |
| `src/server/messaging/send.ts` | Address resolution from contact identities for native providers (no `ghl_contact_id` needed); unit-rate lookup by the channel's provider. |
| `src/server/appointments/*` | Unchanged for GHL tenants. Native tenants use the new native scheduling services; the GHL path stays for GHL-owned calendars. |
| `src/server/integrations/ghl.ts` | Read-only adapter reused by the migration/import tool. Still never writes, never touches `u69CVh0ZlAofUmRoj1zF`. |
| New | `src/server/crm/providers/*` capability interfaces with native and GHL implementations; calendar adapters (Google, Microsoft, CalDAV, ICS); meeting adapters (Meet via Google, Teams via Graph, Zoom, manual link). |

## 6. Required migrations

`0027_native_crm.sql` (Phase 1 foundation) and later numbered migrations per phase. Each ships with a rollback script in
`supabase/rollbacks/`. Rules followed:

- Extend existing tables where they already model the concept (`contacts`, `tasks`, `record_notes`, `crm_pipelines`,
  `crm_opportunities`, `appointment_refs`, `messaging_channels`) instead of creating parallel copies. GHL cache rows keep
  working unchanged: new columns default so existing sync code still inserts `provider = 'ghl'` rows.
- Every tenant table: `org_id`, RLS, select policies through `app.has_permission`, no grants to `anon`/`authenticated`,
  composite same-tenant foreign keys, indexes on tenant-scoped lookups.
- Writes go through server services (`withSystem` after authorization), matching the messaging and appointment modules.
  Reads for client users run through `withUser` so RLS applies as a second layer.
- Backfill is non-destructive: tenants with a GoHighLevel location are set to **GoHighLevel** mode so nothing changes for
  them (including Aster Homes and the agency); every other tenant and every new tenant defaults to **Native**.

## 7. Implementation map

| Phase | Builds on | Delivers |
| --- | --- | --- |
| 1 Foundation | tenancy, permissions, contacts, audit | CRM workspace + provider mode per capability, granular permissions (+ Appointment Setter role), contact record extension, companies, tags, typed custom fields, Smart Lists (safe filter compiler), notes, activity timeline, transactional event outbox, agency support access, imports/exports, CRM navigation (client + agency). |
| 2 Sales & scheduling | Phase 1 | Native pipelines/stages/opportunities (transactional, idempotent stage events), tasks, native calendars, appointment types, availability rules, conflict-proof booking (exclusion constraint), round robin/collective/group, booking pages, Google/Microsoft/CalDAV/ICS adapters and sync. |
| 3 Communications | Phase 1, inbox | Provider-agnostic transports (Resend, Twilio, Meta WhatsApp) with signed webhooks and real delivery receipts, templates, consent, human handoff preserved. |
| 4 Automation & AI | outbox, approvals, pauses | Workflow definitions/versions/runs with durable claiming, retries, dead letters, loop limits; n8n and webhook actions; follow-up sequences; Hermes CRM tools with scoped tokens and approval modes; lead assignment. |
| 5 Growth & operations | Phases 1–4 | Native forms and Website Studio integration, campaigns, review requests, call activity, client and agency reports, CRM Blueprints. |
| 6 Migration & verification | everything | CSV and GHL API import with ID mapping, provider switching with preview/backup/cutover/rollback, end-to-end acceptance test, isolation and race tests, rollout runbook. |

## 8. Things this work must not do

No hosted migration, deploy, DNS change, real customer message, GHL write, n8n or GHL workflow activation, Hermes restart,
change to the billing model, or change to the protected Aster Homes location (`u69CVh0ZlAofUmRoj1zF`) or the agency
location (`SQvVnld5MBHdMQ1qnSfw`). Integrations are shown as **Connected** only after an authenticated capability test.
