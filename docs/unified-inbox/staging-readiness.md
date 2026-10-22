# Staging readiness for the Unified Inbox release

Written 2026-10-22. Builds on [../staging-environment.md](../staging-environment.md) (the resource, cost and acceptance matrix, written before this release) and
[migration-audit.md](./migration-audit.md). **Nothing here was run against a hosted system except one read-only project listing; no resource was created and no hosted environment was changed.**

## 1. Does an isolated staging environment exist?

**Hosted: no.** On 2026-10-22 the Supabase CLI (logged in as the project owner) listed exactly one project visible to the account: production `iAcquire` (`lkkiavjwxaeoqgsbjyso`, `ap-northeast-1`, healthy). The repository's
runbook says the same ("Staging: none. The organization has one project"). The plan (Free or Pro) is not visible from the CLI and must be read in the dashboard.

**Local isolated: yes, and it is what all verification so far ran on.** It meets every requirement for a safe test environment:

| Requirement | How the local environment meets it |
| --- | --- |
| Separate database | Embedded PGlite (`.data/crm-qa`, or in memory for tests); the launcher refuses a hosted `DATABASE_URL` and refuses production mode |
| Separate application environment | Its own dev server and build folder (`.next-crm-qa`); every variable pinned by `scripts/crm-qa-env.mjs`; the clean build (`scripts/build-clean.mjs`) pins the hosted values to blank |
| Synthetic data | `scripts/ui-qa-inbox-seed.qa.ts`: fictional customers, three workspaces (one with the new inbox on, one off, a Super Admin) |
| Test credentials only | Random local passwords written to a git-ignored file; never printed |
| No customer-facing messaging | Every provider write switch off, `EMAIL_PROVIDER=capture`, a simulated AI model; a test with a network spy proves nothing leaves |
| No production scheduler | Off; ticks run only inside tests against the embedded database |
| No effect on live clients | Nothing in it can reach a hosted resource |

What it **cannot** prove: hosted Postgres behaviour (locks, the connection pooler, RLS under the real role, hosted Auth), real providers or Hermes, a real scheduler host, production-sized data, real concurrency.

## 2. What hosted staging needs (all approval-dependent)

| Item | Detail |
| --- | --- |
| **Resource (A3)** | A second Supabase project `iacquire-staging` in organization `juxhdecqdbjyqyvjlbgm`, region `ap-northeast-1`, size `nano`, no HA, no PITR, no custom domain |
| **Cost** | **Free plan: $0** (uses the second and last free slot; 500 MB database; **no automatic backups**; pauses after a week idle). **Pro: about +$10 a month** marginal ($35 a month in total with two Micro projects after the $10 compute credit). Creating the project is the only cost step. Unchanged from the runbook; the plan must be confirmed in the dashboard |
| **Application environment** | Local `next dev` against staging is enough for database acceptance. A separate Vercel project or preview is optional (cost not estimated here) |
| **Credentials to create, staging-only** | Database password and `DATABASE_URL` (session pooler), `NEXT_PUBLIC_SUPABASE_URL`, publishable and secret API keys, `APP_ENCRYPTION_KEY`, `SITES_FORM_SECRET`, and (only for the supervised scheduler test) a staging `CRON_SECRET`. **Nothing is copied from production** |
| **Test identities** | Client owner, manager, staff, agency administrator, agency staff, and a second client tenant, created through the Admin API in staging only |
| **Optional, one at a time, each its own approval** | Provider sandbox accounts (Resend, Twilio, Meta WhatsApp, GoHighLevel), a test AI model key, a Hermes test profile |
| **Backup tool for the production step (D3)** | `pg_dump`, `pg_restore` and `psql` are not on this machine's PATH (Docker is not installed either), although `.data/backups/*.dump` files exist. **Which machine and tool takes the verified production backup must be decided before A8**; staging itself holds synthetic data and can be rebuilt instead of restored |

### The staging environment file (`.env.staging.example`, updated in this pass)

Pins: every `*_WRITES_ENABLED=false`, `N8N_ACTIONS_ENABLED=false`, `EMAIL_PROVIDER=capture`, `CALENDAR_SYNC_DISABLED=true`, `SCHEDULER_ENABLED=false`, `SCHEDULER_JOBS_ONLY=` (empty), the three
`WORKFORCE_*_ENABLED=false`, `INBOX_DISABLED=false` (the new inbox is then switched on per workspace from `/admin/inbox-rollout`). **Use only this file, in a checkout that has no production `.env`**: the old example loaded `.env` first, which in
the main checkout holds production values.

## 3. Data

Default (A4 option a): apply the whole chain to the empty project, then load **synthetic** data. The local QA seed is the model, but it refuses any hosted database on purpose, and hosted users live in Supabase Auth, so the hosted seed is
**a separate script that is not written yet** and should be written and reviewed **after A3**, against the real project. Its guard rails, so it can never touch production: it requires `STAGING_PROJECT_REF`, refuses unless the `DATABASE_URL` host contains it,
refuses if the host contains the production reference, requires an explicit confirmation flag, uses only the application's services (so every rule and trigger applies), creates no provider credentials and enables no channel for sending.
Not recommended: a production schema-only restore or any copy of customer data.

## 4. The rehearsal, step by step (do not run until the approvals in section 6)

Every command prints `Target: <host>` first (never a user name or password). **Stop if it is not the staging host.**

```bash
# 0. Which database would this use, and what is pending? Read only.
node --env-file-if-exists=.env.staging.local --conditions=react-server --import tsx scripts/migrate.ts --dry-run --through 0080_proactive_ai_employees

# 1. Rebuild production's current state (its ledger runs through 0080).
node --env-file-if-exists=.env.staging.local --conditions=react-server --import tsx scripts/migrate.ts --through 0080_proactive_ai_employees

# 2. Load synthetic data (the hosted seed, section 3), including conversations in every state and a volume for the performance checks.

# 3. The release, one migration at a time, recording the time each takes and any lock wait (0083 sets lock_timeout = 5s and fails fast).
node --env-file-if-exists=.env.staging.local --conditions=react-server --import tsx scripts/migrate.ts --only 0081_ai_work_job_rls_hardening
node --env-file-if-exists=.env.staging.local --conditions=react-server --import tsx scripts/migrate.ts --only 0082_client_employee_provisioning   # only if client onboarding is part of the release
node --env-file-if-exists=.env.staging.local --conditions=react-server --import tsx scripts/migrate.ts --only 0083_unified_inbox
```

4. **Verify** with the queries in [rollout-plan.md](./rollout-plan.md) stage 3 step 5 and the checks in [migration-audit.md](./migration-audit.md) section 2, against staging: both ledgers, columns, indexes, RLS on `conversation_events` and `inbox_rollout`, no grants on `inbox_rollout`, the notification kinds, row counts before and after.
5. **Rollback rehearsal** (migration-audit section 5): `0083`, then `0082`, then `0081` down files, each in one transaction, then the ledger rows removed, then re-apply. Compare with the embedded rehearsal (`scripts/rehearse-migration-order.mjs`).
6. **Acceptance:** the matrix in `staging-environment.md` plus the inbox scenarios (readiness.md section 5) in a browser: the Super Admin page, switching a workspace on and off, the previous inbox for a workspace that is off, `INBOX_DISABLED=true`, the roles, phone and tablet, axe.
7. **Load checks only staging can answer** ([performance-risks.md](./performance-risks.md) section 6): `EXPLAIN (ANALYZE, BUFFERS)` of the list, counts, sync and search statements; several tabs polling at once and the connection pool; whether hosted Postgres uses the trigram index.
8. **Supervised scheduler test (A6):** staging-only `CRON_SECRET`, `SCHEDULER_ENABLED=true`, and `SCHEDULER_JOBS_ONLY` set to the first steps of [scheduler-impact.md](./scheduler-impact.md) section 5; one tick, a second skipped by the lease, `worker_job_runs` checked, then switched off.
9. **Tear down or pause** the project afterwards (on the Free plan, so it does not hold the second active slot).

## 5. Production rollback, in short

Application first (every migration here is additive; old code ignores the new columns), then the rollout controls (one workspace, every workspace, `INBOX_DISABLED=true`), and only for a defect in a migration itself the down files from a verified backup with your approval
([workspace-rollout.md](./workspace-rollout.md) section 6, [migration-audit.md](./migration-audit.md) section 5).

## 6. Approvals this needs from you

| ID | Approval | Needed before |
| --- | --- | --- |
| A3 | Create `iacquire-staging` (state Free or Pro, the monthly figure you accept, and who owns it) | Anything hosted in staging |
| A4 | How staging gets its data: the fresh chain with synthetic data (my recommendation); the hosted seed script is written and reviewed after A3 | Loading data |
| A5 | Apply the migrations to staging and run the acceptance matrix with writes off | The production migration |
| A6 | One supervised scheduler test on staging with `SCHEDULER_JOBS_ONLY` | Relying on the scheduled notices |
| D3 | Which machine and tool takes the verified production backup | A8 (the production migration) |
| A7 | Each provider or model sandbox check, one at a time (optional for staging, required before any live write) | Enabling anything live |
