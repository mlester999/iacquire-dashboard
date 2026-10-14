# Foundation delivery checkpoint

The Supabase/setup/secure-integration brief in `58fc3517` was audited in the existing repository. The original complete UI brief in `506792fc` remains active. This is an implementation checkpoint, not a claim that all hosted services or the wider redesign are finished.

## Implemented architecture

Supabase Auth uses SSR cookie sessions with verified identity and application profile/membership checks. Supabase PostgreSQL owns portal data; server user transactions apply `iaq_app_user` RLS, and application tables are closed to direct browser Data API access. Private Storage uses authorized signed downloads. Private setup Realtime topics carry revision numbers only and trigger authorized refetch, with SSE/polling recovery and permission renewal within 60 seconds.

New provider secrets use managed Supabase Vault references. Global application secrets belong in secure server environment settings. New plaintext credentials are neither stored in portal tables nor returned by APIs. Rotation/revocation invalidates connection health; resolving secrets rechecks the provider and exact tenant and audits the actual outcome. Test-memory secrets exist only in tests.

Production refuses custom auth, embedded portal data, legacy credential resolution, mismatched Supabase projects and unverified remote database TLS. Empty/missing CA files fail closed. Hostinger appointment-event PostgreSQL and n8n's internal database remain separate and untouched.

The installed SSR/key conventions were checked against the [official Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client) and [API key documentation](https://supabase.com/docs/guides/getting-started/api-keys). `.env.example` contains placeholders and trusted database CA settings.

## Migration and account status

The audit checkpoint verified migrations `0001`–`0015` in disposable PostgreSQL: 89 public tables, all with RLS, preserving the original 51. The current repository has since expanded through `0021`; the complete schema inventory will be refreshed after the current work settles. No hosted migration or existing customer-data transfer was performed by this audit.

Migrations remain versioned/additive. Stable UUID account migration is idempotent and has an audited dry run. Existing scrypt passwords require a reset migration; email matching alone never links identity. Data/files require explicit export/import, checksum/row-count reconciliation and tested restoration before cutover. Legacy data stays recoverable rather than being silently discarded.

The pre-foundation private snapshot is `../iAcquire-backups/iacquire-before-supabase-20261014-102923.tar.gz`; the pre-redesign snapshot is `../iAcquire-backups/iacquire-before-redesign-20261014-155318.tar.gz`. Keep these outside public artifacts: they contain private local settings. A filesystem snapshot alone is not a transaction-consistent database restore. See `migration-plan.md` and `supabase-setup.md`.

## Functional routes

| Area | Routes |
| --- | --- |
| Client onboarding and progress | `/welcome`, `/onboarding`, `/setup`; `/dashboard/setup` redirects to `/setup` |
| Agency clients and tasks | `/admin/clients`, `/admin/clients/[id]`, `/admin/clients/[id]/setup`, `/admin/setup-templates` |
| Preparation and final review | `/admin/clients/[id]/provisioning`, `/admin/clients/[id]/activation` |
| Secure service management | `/admin/integrations`, `/admin/clients/[id]/integrations` |
| Client service summary | `/settings/integrations` |

Task status, notes, dependencies, assignments, ordering, evidence/documents, known estimates, audit/history and notifications persist transactionally. Package-optional website and funnel work remain separate. A manual human completion cannot certify a technical connection. Cached/demoted roles, revoked assignments and stale verification results are rejected. Required technical failures, client approvals and failed/running preparation jobs block final approval.

Jobs have tenant idempotency, attempts/leases/backoff and retry history. Exhausted/interrupted work stays visible. Explicit retirement needs an audited reason, preserves attempts and cannot complete a technical task. Portal review never authorizes external workflow/outreach activation.

## Provider status

| Provider | Local implementation | Remaining gate |
| --- | --- | --- |
| Supabase | Auth, PostgreSQL, RLS, private Storage, scoped Realtime and Vault code; fail-closed configuration | Authorized development-project acceptance for hosted sessions/mail, persistence, Storage, Vault and Realtime |
| Hermes | Upstream runs/SSE routing preserved; dedicated profile identity, host and advertised tool checks | Complete installed runtime plugin/MCP inventory proof; live clients remain Permission limited / setup_required and runs are blocked |
| GoHighLevel | Manual location mapping, scoped GET probes, metadata and foreign-location/calendar/pipeline rejection | Separate read-only test location, exact Master Snapshot/asset verification; protected locations untouched |
| n8n | `X-N8N-API-KEY`, approved inventory/status/filtered execution summaries, scoped mappings | Installed edition/version/scopes and full workflow readiness; appointment-event delivery remains separate |
| Calendar/email/domains | Clear client actions and honest unverified states | Real supported consent/provider/DNS/publication verification; an address or URL is insufficient |

LLM verification now distinguishes model listing from a disclosed minimal model response. Only HTTP 404/405/501 from an unsupported model-list operation permits the one-token fallback; network/auth/rate-limit/server/malformed errors stop. No live inference was performed here.

## Evidence and operator next actions

The audit checkpoint passed **373 tests / 27 files**, typecheck, lint and production build. Auth/provider requests were mocked; real local PostgreSQL exercised schema/RLS/services. Authenticated browser QA used explicitly synthetic records: a task completion reached the client without reload, changed progress 11% → 17%, preserved history and created an in-app notification. This is local synchronization, not hosted Supabase Realtime proof. Later repository/UI changes need refreshed final gates.

Authorize the dedicated Supabase development target before hosted testing. Configure secrets directly in local/hosting settings, never in chat; prove backup restoration; apply/reconcile schema/data/accounts/files; then follow the ordered live checklist in `verification-status.md`. Test real invitations/reset mail, two-tenant JWT/Storage isolation, Vault rotation/revocation, restart persistence and cross-device updates before provider acceptance. Provider testing uses dedicated development identities and approved permissions.

Beginner instructions: `supabase-setup.md`, `integrations-setup.md`, `client-provisioning.md`, `credential-security.md`. Production deployment, customer messaging, remote pushes and external live activation remain outside this authorization.
