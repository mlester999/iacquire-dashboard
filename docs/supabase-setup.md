# Supabase portal foundation

Supabase Auth handles accounts and cookie sessions; Supabase PostgreSQL stores portal data; private Supabase Storage stores documents. The server retains existing SQL business services and runs user queries as `iaq_app_user` under RLS. Application tables are deliberately closed to the Supabase Data API. Browsers cannot query profiles or credentials directly.

**Verification boundary:** migrations/RLS run against disposable local PostgreSQL through PGlite, and Auth SDK calls are mocked. These checks have not exercised a hosted Supabase project. Live project use requires authorization; login, reset delivery, Storage, Realtime, Vault and hosted persistence remain unverified. Local tests do not prove a live connection.

## Connect a dedicated development project

1. Authorize a dedicated Supabase development project. The portal database is separate from Hostinger's appointment-event PostgreSQL and n8n's internal database.
2. Retain the pre-change filesystem snapshot. For persistent data, also take a transaction-consistent database export and private file backup, and prove restoration in an isolated copy. A filesystem snapshot is not a verified database restore.
3. Copy `.env.example` to `.env.local`. In Supabase's **Connect** dialog, obtain the project URL and publishable key. Obtain the server secret key in **Settings → API Keys**. Enter values directly in the local file or secure hosting settings; never put secrets in chat or source control.
4. Set `DATABASE_URL` to the same project's direct connection or session pooler, using TLS. Direct hosts include `db.<project-ref>.supabase.co`; pooler usernames encode that project's reference. The database password is separate from API keys. Never prefix this variable with `NEXT_PUBLIC_`. Download that project's root CA certificate from **Settings → Database → SSL configuration**, then set `DATABASE_SSL_CA_FILE` to its readable file path, or set `DATABASE_SSL_CA` to its PEM text. Deploy the certificate file alongside the app when using a path.
5. Keep `AUTH_PROVIDER=supabase` and `DATABASE_DRIVER=postgres`. Production refuses custom auth, embedded databases, mismatched project connections, insecure Hermes URLs and legacy credential reads. There is no legacy production fallback switch.
6. Enable managed Supabase Vault in the authorized project using its supported extension configuration before saving integration credentials. Follow `credential-security.md`.
7. Configure the hosted Auth site URL to `APP_URL`, restrict redirect origins to the real portal, keep email confirmation enabled and disable ordinary public signup. Configure a verified mail sender before testing delivery.

The installed packages are `@supabase/ssr` 0.12.7 and `@supabase/supabase-js` 2.117.3 with Next.js 16.3.6. `proxy.ts` refreshes verified claims, updates request/response cookies and preserves cache headers on redirects. Pages/APIs also validate mapped active profiles and server-side memberships. See the [official SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs) and [API key conventions](https://supabase.com/docs/guides/getting-started/api-keys).

`DATABASE_SSL_CA_FILE` may be absolute or relative to the application working directory. `DATABASE_SSL_CA` accepts actual newlines or literal `\n` sequences; it contains the public CA certificate, never a private key. The installed `pg` driver can replace an explicit TLS object when SSL options appear in the URL, so the app strips those options and sets certificate verification explicitly. Production refuses a missing, unreadable or empty remote CA file and never downgrades to unverified TLS. An invalid certificate fails during the TLS handshake. Remote development without a CA logs an encrypted-but-unverified warning; configure the CA there too. A local loopback Supabase stack can run without TLS. See Supabase's [SSL connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres#ssl).

## Fresh development schema

After project authorization/configuration, run `npm run db:migrate`, or apply `supabase/migrations` through the Supabase CLI migration workflow. The application runner honors CLI migration history to avoid double application. Hosted migrations are deliberate; app startup never automatically migrates hosted PostgreSQL. Never run `supabase/local-compat.sql` against a real/shared project: it emulates managed schemas exclusively in disposable local tests.

Existing UUIDs, FKs, same-tenant composite FKs, unique constraints, indexes and business logic are preserved. The repository currently has 15 versioned migrations and 89 public tables including `schema_migrations` (88 application tables). The original 51 remain. The complete names and migration breakdown are in [schema-inventory.md](schema-inventory.md). Migration 0009 adds Auth mappings and an account ledger and supports fresh CLI bootstrap. Migration 0011 adds private file metadata, explicit recovery authorization and scoped Realtime policies. Additional integrations/provisioning migrations are additive.

Start `npm run dev`. Missing Supabase configuration produces a useful sign-in configuration notice. For synthetic local demonstrations only, explicitly set `AUTH_PROVIDER=local` and `DATABASE_DRIVER=pglite`. Seed only disposable synthetic databases. Do not seed a project containing customer data. Local demo files retain their original layout; production uses private Supabase Storage.

## Transfer existing persistent data safely

1. Freeze source writes and record row counts, schema versions and file SHA-256 checksums. Retain users, organizations, memberships, company records, conversations, configurations, notifications and histories.
2. Restore the backup into an isolated source copy; do not let the new app automatically migrate the original embedded source. For PostgreSQL, use an encrypted `pg_dump` snapshot and private file backup. For PGlite, stop the original process, copy its consistent database directory, open only the copy with the original app version, and export each business table with column types into restricted staging files.
3. Create a separate empty authorized Supabase target and apply migrations. Import data separately from schema with explicit columns and original UUIDs/timestamps. Compare and upsert reference catalog keys rather than duplicate seeded catalogs. Never overwrite a populated project.
4. Import transactionally: users/organizations/catalogs; memberships/company records; workforce; conversations/messages/runs; business records; support/usage/notifications; then setup histories. Resolve circular nullable links in two passes: initially leave `active_config_version_id`, `run_id` and `assistant_message_id` null; insert referenced rows; then restore links. Do not disable tenant constraints or discard failing rows. Stop and review conflicts.
5. Preserve restricted legacy credential/session/token tables as rollback data. Production Supabase Auth never uses them. Old password hashes require reset migration; do not pretend they can be imported by this implementation.
6. Copy every private file to its correct private bucket with the original organization prefix/storage key. Insert corresponding `private_files` metadata with verified MIME, size and visibility; mark ready only after checksum verification. Verify authorized and cross-tenant denied downloads. Local upload paths will not exist automatically on a deployed server.
7. Compare all source/target table counts, stable UUIDs, conversation ordering, config versions, file checksums and histories. Verify FK/unique integrity and tenant/security tests. Keep source read-only and encrypted backups until migration is accepted.
8. Complete the account procedure below, then run live gates before cutover. A source export/import still needs an operator-controlled connection; no transfer has been performed in this session.

## Account migration

Run this command against the authorized migrated target:

```powershell
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/migrate-accounts.ts --dry-run
```

It reports aggregate counts without changing Auth users, emails or profiles. It requires the configured Supabase portal database and never opens/migrates the embedded source in place. Once the operator authorizes actual account creation, repeat with `--apply`. Active users receive Auth UUIDs equal to their original profile UUIDs and random unusable passwords; memberships/business references retain their IDs. Linked users are skipped. A different Auth account with the same email is retained and reported for manual review; email alone never links identity. Disabled users remain retained and denied.

Do not expose the portal before all intended accounts are linked. Inspect the restricted `auth_account_migrations` ledger for failures. After authorizing/configuring the mail provider, `--apply --send-notices` queues recovery notices. This sends email and requires separate authorization; verify actual `email_outbox` delivery. Without notice delivery, users can request reset once the provider is authorized. The ledger distinguishes created/linked users from completed password recovery.

Invitation signup remains agency controlled. A single-use expiring email invitation carries the server-recorded tenant/platform role. Acceptance creates the mapped Supabase account and membership. Public Auth registrations without mapped profiles receive no portal access. One-time verification/recovery links use `/auth/confirm`; a confirmation POST prevents link scanners from spending them. Password reset requires a recent server-recorded recovery session; generic OTP verification does not grant reset permission. Successful reset consumes the grant, revokes legacy sessions, requests global Supabase sign-out and updates migration status. Supabase access JWTs can remain valid until their expiry after sign-out; configure an appropriate hosted JWT lifetime and verify provider session revocation in the live gates. See the [Supabase sign-out reference](https://supabase.com/docs/reference/javascript/auth-signout).

Test hosted login, expired invitations, email verification, forgot password, one-time reset, logout and disabled accounts with dedicated development test identities. These remain live gates until observed on the authorized project.

## Authorization, storage and synchronization

RLS is enabled on every application table; credential, invitation and migration tables have no client grants. Owner/Admin/Member roles remain; Agency Staff access only assigned organizations; Agency Super Admin controls global connections. Request bodies and organization cookies are checked against persisted memberships. The SQL connection is server-only. User work switches role transaction-locally; owner operations require explicit service authorization. Security-definer functions pin their search paths and revoke public execution.

Buckets are `company-documents`, `support-attachments` and `project-files`, all private with MIME/size limits. The existing custom-project module also adds private `project-uploads` and `portfolio-assets` buckets. Upload helpers recheck database permissions and file signatures. Signed links expire within 120 seconds and require tenant/file-visibility authorization. An already issued signed URL remains a bearer capability until expiry; removing membership prevents new links and future authorized reads. Internal project evidence is agency-only; direct browser writes are denied. [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) uses verified JWT identities; a supplied organization ID or `app.user_id` cannot impersonate another JWT subject.

Setup uses authorized SSE/polling/refetch and can subscribe to private Supabase Broadcast. `/api/realtime/token` rechecks the active profile, session and `setup.view` permission before returning the normal verified user's access JWT, publishable key and exact `setup:<organization UUID>` channel. It returns neither a refresh token nor a service key. The JWT retains its normal user permissions; topic policies restrict setup subscriptions, application Data API grants stay closed and clients cannot publish updates. Only committed revision signals are broadcast; all task data comes from a fresh authorized server snapshot. Browser authorization is renewed at least every 60 seconds, with SSE/polling fallback. Hosted Realtime and the installed server's HTTP Broadcast support must be tested before presenting them as live.

Workers still reconcile interrupted chat runs and derive setup progress only from recorded evidence. SQL transactions commit status/audit/history atomically; network delivery occurs outside transactions. Nested database transactions are rejected in every environment; callers must pass their existing transaction handle.

## Validation and rollback

Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. Tests include existing conversation/tenant checks, mocked Auth, and emulated JWT/Storage/RLS security. They never connect to external infrastructure. Before deployment verify these flows against the authorized project, including process-restart persistence, file isolation, scoped updates/reconnect recovery, Vault encryption and email delivery.

Before cutover, rollback means retain diagnostics and continue the untouched source. After cutover, freeze writes and export/reconcile new target records under an operator-approved plan before restoring the prior version. Do not automatically drop new setup/security tables or lose records. Use a tested full restore or reviewed forward repair. A temporary old-version return requires its known schema/account state, not a production legacy-auth switch. Retain old hashes and files until acceptance; later deletion requires an agreed retention plan.

## Original table inventory

All 51 reported original tables exist in migrations 0001–0004:

| Area | Tables |
| --- | --- |
| Identity/tenancy (14) | users, auth_credentials, auth_sessions, auth_tokens, rate_limit_buckets, email_outbox, organizations, company_profiles, organization_memberships, staff_assignments, invitations, access_requests, role_permissions, org_features |
| Workforce/knowledge (14) | onboarding_responses, company_knowledge, knowledge_documents, agent_roles, agent_instances, agent_config_versions, agent_provisioning_jobs, chat_conversations, chat_messages, agent_runs, tool_executions, integration_credentials, integration_status, ghl_location_mappings |
| Business (13) | approval_requests, approval_events, tasks, lead_targeting_profiles, lead_research_requests, leads, crm_pipelines, crm_opportunities, appointment_refs, record_notes, retention_accounts, customer_feedback, service_history |
| Support/operations (10) | notifications, notification_preferences, support_tickets, support_messages, help_conversations, help_messages, usage_events, usage_limits, billing_accounts, audit_logs |

0005 adds same-tenant integrity, 0006 catalogs/permissions, 0007 capability copy, and 0008 eight existing setup tables. All are preserved. Migration bookkeeping/Auth/security and subsequent integration/provisioning tables are additional to the original 51.
