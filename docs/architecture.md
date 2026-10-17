# Architecture and security model

## Request path

```
Browser ──► src/proxy.ts ──► page / server action / route handler ──► src/server/* service ──► Postgres (RLS)
             │ session-cookie redirect (UX only)        │ requireUser / requireOrgContext            │
             │ per-request CSP nonce                     │ permission check in code                   └─► typed adapters ──► Hermes / GHL / n8n
```

Every page, server action and route handler re-validates the session and tenant membership on the
server. The proxy redirect is a convenience, not a security boundary. Route handlers that accept
JSON also check `Origin` against `Host` (server actions get the equivalent check from Next.js).

## Tenancy

- One `organizations` row per business (`kind = 'client'`); exactly one `kind = 'agency'` row for iAcquire.
- Users belong to tenants through `organization_memberships` (`owner`, `admin`, `member`).
  Agency users have `users.platform_role` (`agency_staff`, `agency_super_admin`); staff only see
  tenants they are assigned to in `staff_assignments`; super admins see all.
- The active tenant is chosen by a cookie, but only honoured when the user holds an active
  membership in it (`src/server/tenancy/context.ts`). Changing a cookie, URL or request body
  cannot widen access.

### Two layers of enforcement

1. **Application checks** — `requireOrgContext(permission)` / `ctx.can(permission)` using the role
   matrix in `src/lib/permissions.ts` (mirrored in SQL by `role_permissions`; a test fails if they drift).
2. **PostgreSQL row-level security** — user-scoped queries run inside `withUser(userId, …)`, which
   opens a transaction, sets `app.user_id` and switches to the `iaq_app_user` role. Every tenant
   table has policies based on `app.can_access_org()` / `app.has_permission()` (security-definer
   helpers with pinned `search_path`). `iaq_app_user` has no grants at all on credentials,
   sessions, tokens, invitations or the email outbox.

`withSystem(…)` runs under the trusted database login for server work (auth, audit writes,
background execution, agency operations authorized in code). `withServiceRole(…)` switches to
Supabase's `service_role` for narrowly scoped operations that need its explicit grants, such as
credential metadata reads. Both bypass RLS, so callers authorize first. Two rules keep this safe:

- Callers authorize first; RLS does not apply inside either trusted wrapper.
- **Never open a transaction inside another.** Pass the `db` handle you were given. On the
  single-connection embedded database a nested transaction deadlocks the whole server; on a pool it
  holds two connections. `src/server/db/index.ts` throws `NestedTransactionError` in development and
  tests (and logs it in production) so this cannot hang silently again.

### Integrity guards in the schema

- Same-tenant composite foreign keys (`(id, org_id)`) stop a row in tenant A from referencing a
  parent in tenant B — foreign-key checks bypass RLS, so plain FKs would not.
- `ghl_location_mappings`: the protected Aster Homes location (`u69CVh0ZlAofUmRoj1zF`) can never be
  mapped; the agency location (`SQvVnld5MBHdMQ1qnSfw`) can only belong to the agency organization;
  one location per tenant and one tenant per location.
- `agent_instances`: a trigger refuses the internal `iacquire-*` and `default` Hermes profiles for
  client tenants, and a unique index means a Hermes profile can back only one tenant employee.
- `audit_logs` is append-only (update/delete raise an error).
- `leads.consent_status` / `outreach_status` are constrained to `unknown` / `blocked`: research is
  never treated as consent.

## Authentication

Production identity is **Supabase Auth** (`src/server/auth/supabase.ts`, routed by
`src/server/auth/provider.ts`). The earlier in-app implementation (`src/server/auth/service.ts`) remains
only for the explicit local synthetic demo and tests; production configuration rejects it
(`src/server/env.ts`).

- Email/password sign-in, email verification, forgot/reset password and logout use Supabase Auth with
  cookie sessions through `@supabase/ssr`. The session cookie holds the refresh token, so it is
  `HttpOnly`; browser code that needs an access token (Realtime) obtains a short-lived one from
  `/api/realtime/token` after the server has re-checked the signed-in user and their permission.
- `src/proxy.ts` refreshes verified claims on each request. Pages, server actions and APIs additionally
  require a **mapped, active portal profile** (`users.auth_user_id`) and re-read memberships from
  PostgreSQL. Role claims in Auth metadata or the request body are never trusted: an unrelated public
  signup has no profile and therefore no portal access.
- Registration is invitation-only. A single-use, expiring invitation records the tenant or platform
  role on the server; accepting it creates the Auth account, profile and membership. The public "Get
  started" form creates an `access_requests` row for agency review and provisions nothing.
- Password reset needs a recent, server-recorded recovery session (`auth_recovery_sessions`); generic
  OTP or magic-link verification does not grant it. A successful reset consumes the grant and revokes
  other sessions. The confirmation link needs a POST so mail scanners cannot spend it.
- Brute force: Postgres-backed rate limits (`src/server/security/rate-limit.ts`) on sign-in, reset,
  verification, invitations, chat, help, uploads, tickets, research and integration administration.
- **Existing accounts:** `npm run auth:migrate` (dry run first) links each active profile to a Supabase
  Auth user whose ID equals the original profile UUID, so memberships and every business record keep
  their IDs. Old scrypt hashes cannot be imported; users reset their password. Email alone never links
  an identity. See [supabase-setup.md](supabase-setup.md#account-migration).
- Local demo mode (`AUTH_PROVIDER=local`): scrypt passwords, hashed 32-byte session tokens in a
  `__Host-` cookie, 10-failure lockout. It exists so the portal can be demonstrated without a Supabase
  project; it is never a production fallback.

## AI workforce

- Six roles are reference data (`agent_roles`); each tenant gets one `agent_instances` row per role.
- Client settings (tone, length, language, rules, role answers) are stored as structured
  `agent_config_versions`. `src/server/workforce/compiler.ts` sanitizes client text, flags policy
  override attempts (held for agency review instead of applied), and compiles it beneath the
  immutable iAcquire policy (`src/server/workforce/policy.ts`). Every change is a new version with
  rollback.
- Configuration reaches Hermes per run as the `instructions` field of `POST /v1/runs` — client text
  never rewrites a profile's SOUL.md. See [integrations.md](integrations.md#hermes-agent).
- An employee is `online` only after an authenticated health check against its own Hermes profile
  succeeds **and** that profile exposes no restricted tools. Otherwise it is `setup_required`,
  `offline` or `error`, and chat is disabled.

## Chat pipeline

1. `POST /api/chat/send` → `sendChatMessage`: rate limit, usage limit, readiness check, then the
   user message is written under RLS (idempotent per `client_message_id`).
2. An assistant placeholder and an `agent_runs` row are created; the Hermes run starts with an
   idempotency key and a tenant-scoped memory key (`iaq:<org>:<role>`).
3. `executeRun` consumes the Hermes SSE stream server-side. Deltas, real tool events (mapped to short
   safe labels such as "Checking your calendar…"), approval requests, completion, failure and
   cancellation are persisted and fanned out through an in-process hub to the browser's SSE stream.
   Reasoning is never forwarded.
4. Stop, timeout (`HERMES_RUN_TIMEOUT_MS`), reconnect after reload, and orphaned-run reconciliation
   on server start are handled. Conversations are private to the user who started them.

The in-process hub assumes a single app instance for live streaming; with several instances a
reconnecting browser still gets the persisted result, but live re-attach needs sticky sessions or a
shared pub/sub (see deployment notes).

## Approvals

`approval_requests` + `approval_events`. Decisions use an atomic compare-and-set on
`status = 'pending'` and unexpired, so double clicks, concurrent approvers and expired requests
cannot cause a second execution; execution itself is claimed once (`queued → running`). High-risk
items need the owner. Executors report honest outcomes: knowledge and configuration changes apply;
Hermes tool approvals resume the paused run; CRM writes and any customer messaging are **held**
("approved, not sent") until a verified integration is enabled. The UI shows that outcome.

## Data model

| Area | Tables |
| --- | --- |
| Identity & auth | `users`, `auth_credentials`, `auth_sessions`, `auth_tokens`, `rate_limit_buckets`, `email_outbox`, `invitations`, `access_requests` |
| Tenancy & roles | `organizations`, `company_profiles`, `organization_memberships`, `staff_assignments`, `role_permissions`, `org_features` |
| Onboarding & knowledge | `onboarding_responses`, `company_knowledge`, `knowledge_documents` |
| AI workforce | `agent_roles`, `agent_instances`, `agent_config_versions`, `agent_provisioning_jobs`, `agent_runs`, `tool_executions` |
| Chat | `chat_conversations`, `chat_messages` |
| Integrations | `integration_credentials` (reference only for new secrets; legacy ciphertext preserved for migration), `credential_references` (Supabase Vault), `integration_connections`, `integration_connection_checks`, `integration_status`, `ghl_location_mappings`, `automation_template_mappings` |
| Business | `approval_requests`, `approval_events`, `tasks`, `lead_targeting_profiles`, `lead_research_requests`, `leads`, `crm_pipelines`, `crm_opportunities`, `appointment_refs`, `record_notes`, `retention_accounts`, `customer_feedback`, `service_history` |
| Support & help | `support_tickets`, `support_messages`, `help_conversations`, `help_messages` |
| Setup Center | `client_setup_templates`, `client_setup_template_tasks`, `client_setup_instances`, `client_setup_tasks`, `client_setup_task_dependencies`, `client_setup_task_events`, `client_setup_task_attachments`, `client_setup_checks` (see [setup-center.md](setup-center.md)) |
| Provisioning & activation | `provisioning_jobs`, `provisioning_job_attempts`, `activation_reviews` |
| Supabase foundation | `auth_account_migrations`, `auth_recovery_sessions`, `private_files`, `support_attachments`, `schema_migrations` |
| Ops | `notifications`, `notification_preferences`, `usage_events`, `usage_limits`, `billing_accounts`, `audit_logs` |
| Operating controls & staff | `automation_pauses` (agency, messaging and outbound stops), `staff_profiles` (client staff availability and escalation preferences) |
| Billing & credits | `credit_accounts`, `credit_ledger_entries` (append-only, micro-dollars), `usage_reservations`, `metered_usage_events`, `usage_rate_versions`, `usage_unit_rates`, `payments`, `payment_webhook_events`, `provider_fees`, `billing_settings`, `agency_billing_settings` (see [finance-and-billing.md](finance-and-billing.md)) |
| Messaging | `contacts`, `contact_identities`, `contact_merges`, `contact_memories`, `contact_consent_events`, `suppressions`, `conversations`, `conversation_messages`, `message_delivery_events`, `webhook_receipts`, `messaging_policy`, `messaging_settings`, `messaging_channels`, `approved_test_destinations`, `whatsapp_templates`, `follow_up_plans`, `follow_up_steps`, `human_escalations`, `escalation_recipients`, `conversation_ownership_events` |
| Onboarding v2 & brand | `onboarding_answers`, `org_assets` (see [onboarding.md](onboarding.md)) |
| Website Studio | `websites`, `website_versions`, `website_publications`, `website_publication_assets`, `website_asset_blobs`, `website_domains`, `website_form_submissions`, `website_usage_daily` (see [website-studio.md](website-studio.md)) |
| Operations | `worker_job_runs`, `incidents`, `incident_events`, `notification_deliveries` (see [operations-and-incidents.md](operations-and-incidents.md)) |
| Appointments | `appointment_settings`, `appointment_events`, `appointment_bookings`, `appointment_reminders` (see [appointments.md](appointments.md)) |
| Retention programs | `retention_programs`, `retention_enrollments`, `retention_steps` (see [retention.md](retention.md)) |
| Commercial operations | `agency_finance_entries`, `fair_use_policies`, `fair_use_status`, `account_activity_reviews`, `offboarding_requests`, `offboarding_events` (see [fair-use-and-inactivity.md](fair-use-and-inactivity.md), [offboarding-and-export.md](offboarding-and-export.md)) |

Migrations: `0001_foundation` (identity, tenancy, permission helpers), `0002_workforce` (onboarding,
knowledge, agents, chat, runs, integrations), `0003_business` (approvals, tasks, leads, CRM refs,
retention), `0004_support_ops` (notifications, support, help, usage, billing, audit),
`0005_tenant_integrity` (same-tenant composite keys), `0006_reference_data` (roles and permissions),
`0007_capability_copy` (capability text that does not overclaim integrations),
`0008_setup_center` (client setup checklist, checks, permissions, notification kinds),
`0009_supabase_foundation` (Auth mapping, account ledger, closed Data API), `0010_secure_integrations`
(connections, checks, Vault references, workflow mappings), `0011_private_storage` (private buckets,
Storage and Realtime policies, recovery sessions), `0012_provisioning_activation` (resumable jobs,
attempts, immutable activation reviews), `0013_setup_experience` (extended master checklist, optional
funnel/website scope, private evidence), `0014_llm_provider`, `0015_custom_projects` (catalog, portfolio,
projects, maintenance), `0016_operating_controls` (pauses, employee modes), `0017_staff_roles`,
`0018_billing_credits` (credits ledger, metering, PayMongo), `0019_messaging` (unified inbox, consent,
follow-ups, handoff), `0020_onboarding_v2`, `0021_websites` (Website Studio and the public site runtime role),
`0022_operations` (heartbeats, incidents, email delivery), `0023_appointments`, `0024_retention`,
`0025_commercial_operations` (agency finance, fair use, inactivity, offboarding).

### Requested table names and their equivalents

The brief proposed fifteen table names. Where an equivalent already existed the portal extends it rather
than adding a duplicate:

| Requested | Implemented as |
| --- | --- |
| `setup_templates`, `setup_template_tasks` | `client_setup_templates`, `client_setup_template_tasks` |
| `organization_setup_instances`, `organization_setup_tasks` | `client_setup_instances`, `client_setup_tasks` |
| `setup_task_events`, `setup_task_dependencies` | `client_setup_task_events`, `client_setup_task_dependencies` |
| `setup_task_evidence` | `client_setup_task_attachments` (links/files) and `client_setup_checks` (verified/attested readiness) |
| `provisioning_jobs`, `provisioning_job_attempts` | same names (migration 0012) |
| `integration_connections`, `integration_connection_checks`, `credential_references` | same names (migration 0010) |
| `organization_external_mappings` | `ghl_location_mappings` (GHL location, pipeline, calendars), `agent_instances` (Hermes profile per employee), `automation_template_mappings` (n8n workflows per client) |
| `automation_template_mappings`, `activation_reviews` | same names (migrations 0010, 0012) |

A single polymorphic mapping table was deliberately not added: each external system has different
constraints (a protected-location trigger for GHL, a one-profile-per-tenant unique index for Hermes,
global-connection ownership for n8n) that are enforced in the database for its own table.

## Browser hardening

- Content-Security-Policy with a per-request nonce and `'strict-dynamic'` (`src/proxy.ts`), no
  framing (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), `nosniff`, strict referrer,
  restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`.
- Uploaded documents are validated by extension and content signature, stored outside the web root,
  served only through an authorized route as attachments with `Content-Security-Policy: sandbox`.
- AI and user content is rendered through `react-markdown` without raw HTML.
