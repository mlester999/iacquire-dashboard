# Production-readiness closeout (2026-10-19)

This pass completed the safe engineering work left after the Phase 6 audit. It does not add CRM features.

## 1. Development database safety — done

**Original finding:** the local `.env` pointed `npm run dev` and maintenance scripts at the hosted production Supabase project.

**Fix:**

- `.env.development` (committed) makes `next dev` use embedded PGlite, local sign-in, captured email and all provider writes off.
- `src/server/env.ts` refuses a development process using a remote Postgres database unless `ALLOW_REMOTE_DB_IN_DEV=true`; the error names
  the host only.
- `src/instrumentation-node.ts` calls `assertSafeDevelopmentDatabase()` before startup work, so the process stops instead of failing per
  request.
- `npm run db:migrate:local` and `npm run db:seed:local` load `.env.development` with `.env.local` as the final override.
- Production is unaffected (the guard is inside the development branch).

**Evidence:**

- `tests/environment-safety.test.ts` (4): remote refused, PGlite allowed, local Postgres allowed, explicit opt-in allowed.
- `npm run db:migrate:local` created and migrated a fresh `.data/pglite-development`.
- `npm run db:seed:local -- --demo --crm` created fictional demo accounts and CRM records.
- `npm run dev -- -p 3100` reported `Environments: .env.development, .env`, served `/login` 200 and `/api/health`
  `{"status":"ok","database":"ok","scheduler":"never_ran"}`.
- Running `env()` with only `.env` (production URL, no opt-in) threw the refusal message.

## 2. Production scheduler — prepared, deliberately not activated

**Original finding:** `/api/internal/tick` returned 503, `worker_job_runs` was empty and no scheduler existed.

**Implemented:**

- `SCHEDULER_ENABLED` is a second switch: even with a valid `CRON_SECRET`, the endpoint returns 503 until it is `true`.
- The route accepts `POST` and host-scheduler `GET` (Vercel Cron uses GET); both require the bearer secret and never read a cookie or
  query parameter.
- `claimSchedulerTick()` adds a `scheduler_tick` lease. An overlapping invocation returns `200 { skipped: "another scheduler tick is active" }`;
  a normal run releases it; a crashed run is reclaimable after five minutes.
- `finishSchedulerTick()` records success/failure, duration and a sanitized error in the heartbeat.
- The route records failures, returns a generic 500 and never exposes internal details.
- `GET /api/health` now includes `scheduler: "fresh" | "stale" | "never_ran" | "unknown"`.
- Documentation: [production-scheduler.md](production-scheduler.md), [deployment.md](deployment.md).

**Production side-effect audit (read-only, 2026-10-19):**

| Pending work | Count |
| --- | --- |
| Queued/sending conversation messages | 0 |
| Queued/sending email outbox | 0 |
| Appointment reminders | 0 |
| Workflow runs | 0 |
| Running/scheduled campaigns | 0 |
| Import jobs | 0 |
| Provider switches | 0 |
| Pending webhook deliveries | 0 |

Every provider write switch is `false` (`GHL`, Resend, Twilio, Meta WhatsApp, n8n). Enabling the scheduler today would therefore have no
external effect, but it remains an approval decision because future rows would be processed immediately.

**Isolated execution evidence (QA harness):**

- `POST /api/internal/tick` with the local-only secret returned 200 and ran every job.
- An immediate second call returned `200 {"ok":true,"skipped":"another scheduler tick is active"}`.
- `worker_job_runs`: `tick` runs_total 1, `scheduler_tick` finished, 0 consecutive failures.
- `email_outbox`: 3 rows, all `status=captured`, `provider=capture` (created by the seed, not by the tick); 0 queued messages.

**Tests:** `tests/billing-routes.test.ts` (8) and `tests/operations.test.ts` (36) pass, including the disabled switch, invalid secret,
no secret, lease serialization/crash reclaim and health shape.

**Not done (requires approval):** setting `CRON_SECRET`/`SCHEDULER_ENABLED=true`, adding a cron definition, or pointing an external
scheduler at production. The current production endpoint remains 503.

## 3. Staging — blocked on approval

There is one Supabase organization and one project (production). The CLI is authenticated and can create a project, but creation can
consume quota or incur billing, so it was not run. Docker is not installed, so a local Supabase stack is unavailable; embedded PGlite is the
local substitute.

Prepared: [staging-environment.md](staging-environment.md) with the exact `supabase projects create` command, environment shape, migration
command, test-identity plan and acceptance matrix, plus [`.env.staging.example`](../.env.staging.example). The 2026-10-19 update adds the exact
project/region/size, the Free vs Pro quota and monthly cost (Free $0 within the two-project limit; Pro about +$10/month for a second Micro
project), the credentials list and the explicit approval checklist. **Required action:** approve a separate staging project (and its cost) or
provide an existing staging project/credentials. No production organizations, users or records were created.

## 4. Workflow verification

Local browser evidence from the audit stands (contacts 6/6, deal creation/stage counts, cross-tenant denial, responsive/a11y). This pass
did not repeat the full matrix. The new scheduler path was exercised in isolation as above. Production write workflows remain unverified
because no staging/test tenant exists.

## 5. Observability

- Vercel runtime logs remain **inaccessible**: the CLI is installed but unauthenticated (`vercel whoami` fails) and no `VERCEL_TOKEN` is
  available. Required: a Vercel token with project access or a team-member login.
- Application-level observability was extended: `/api/health` exposes scheduler state without client data; `/admin/health` already shows
  scheduler state, every job's last result, incidents and seven days of sanitized diagnostics.
- No public endpoint exposes credentials, private client data or internal error details.

## 7. Verification gates

- **Tests:** 2,971 tests in 174 files passed with 0 failures. The run was split because an unrelated AQi import was found in the shared
  `src/server/ops/tick.ts` during closeout and removed from this commit: 163 files / 2,607 tests passed on the closeout tree, and the 11
  scheduler-import suites (appointments, billing routes, campaigns, forms, provider switch, workflow engine, fair-use, WhatsApp,
  offboarding, operations, retention) were re-run on the clean final commit: 364 tests passed. The AQi import and its migration are not
  referenced by this commit.
- **Typecheck:** `tsc --noEmit` exit 0.
- **Production build:** `next build --webpack` succeeded on the clean final commit; TypeScript finished in 95 s and all routes were emitted.
- **Lint:** `eslint src tests scripts --max-warnings=0` exit 0. (`eslint .` stalls on the linked `node_modules` junction in this workspace,
  so the scoped command was used; it covers every source, test and script file.)
- **Scheduler evidence:** the isolated QA endpoint ran every job and the immediate second call was skipped by the lease.

## 8. Performance

Measured from Singapore on 2026-10-19 after the deployment was warm:

- `/login`: 0.73 s (first sample), then 0.49–0.53 s TTFB; DNS/TLS ≈ 0.13 s.
- `/api/health`: 2.04 s first sample, then 0.59–0.61 s.
- Direct DB connect from this machine: 545 ms; first query 84 ms.
- `X-Vercel-Id: sin1::iad1` and `X-Vercel-Cache: MISS` show the edge in Singapore and the function in **iad1 (US East)** while Supabase is
  in Tokyo.
- The earlier 11.38 s first-login sample was not reproducible; it is consistent with a cold start immediately after a deployment, not a
  steady-state database or middleware cost.

No performance code change was made. The demonstrated region mismatch suggests evaluating a function region (`hnd1` near the database or
`sin1` near users) as a separate, measured deployment change requiring approval.

## 9. Release and migration safety

- Production before this closeout: `ddd1804`, deployed successfully (2026-10-19T03:45:36Z).
- Hosted ledger has 61 migrations through `0062_agency_manager_blueprint_permissions`; `0061_aqi_phase3_guidance` was applied before its deploy.
- A concurrent local AQi Phase 3 hardening change adds `0063`; it is **uncommitted** and was not touched or pushed by this pass. An
  uncommitted AQi import had also leaked into the shared tick file; it was removed from this commit before the build.
- This closeout commits only development-safety, scheduler-safety, health, tests and documentation files.
