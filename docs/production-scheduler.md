# Production scheduler

## Current state (2026-10-20)

The scheduler is **prepared but not activated**.

- `POST /api/internal/tick` exists and runs every job in `src/server/ops/tick.ts`.
- Production has **no `CRON_SECRET`**, so the endpoint returns `503 Worker endpoint is not configured`.
- `SCHEDULER_ENABLED` is not set in production. Even with a secret, the endpoint returns `503` until it is explicitly `true`.
  Both absences were confirmed in the Vercel-pulled production environment file (variable names read; values never printed).
- `worker_job_runs` had no `tick` row: no scheduler tick has ever run.
- No Vercel cron, `vercel.json`, Supabase `pg_cron`/`pg_net`, or n8n schedule is configured. `vercel.json` does not exist in the repository.
- Production pending work is currently zero: 0 queued messages, 0 queued email, 0 appointment reminders, 0 workflow runs, 0 running
  campaigns, 0 imports, 0 provider switches, 0 pending webhooks. Every provider write switch is `false`.

Enabling the scheduler is therefore a deliberate two-part change, and it requires approval because it starts processing outbound work
(email, SMS, WhatsApp, campaign messages, workflow actions, imports, webhooks) as soon as rows exist.

Because the scheduler is off, two maintenance passes currently run from the server boot instead (see
[Database connection reliability](database-connection-reliability.md)): marking runs a dead server left behind as interrupted, and the
Setup Center backfill/evidence reconciliation. Both are idempotent and both are retried by the scheduler once it is enabled.

## Two switches

| Variable | Purpose |
| --- | --- |
| `CRON_SECRET` | At least 24 random characters. Authorizes the endpoint with `Authorization: Bearer <secret>`. |
| `SCHEDULER_ENABLED` | Must be exactly `true`. Off/absent means 503 even with a valid secret. |

Both are required. Deploying a cron definition cannot start work by itself; a person must also set `SCHEDULER_ENABLED=true`.

## Authentication

- The secret is compared with `crypto.timingSafeEqual`; length differences are rejected.
- No session or cookie is accepted. The endpoint is in the proxy's public list only so the scheduler can reach it; the bearer secret is
  the authentication.
- `GET` and `POST` are both accepted for host schedulers (Vercel Cron uses GET); both require the bearer secret. No session or cookie is
  accepted. The endpoint is in the proxy's public list only so the scheduler can reach it; the bearer secret is the authentication.
- Responses are `Cache-Control: no-store` and never include job payloads, client data or error details.

## Invocation frequency

Every **1–2 minutes**. The deployment guide recommends this; `SCHEDULER_STALE_MINUTES` defaults to 20, so a stopped scheduler opens a
critical incident after 20 minutes without a completed `tick`.

## Architecture options

### 1. Vercel Cron

Vercel Cron issues `GET` with `Authorization: Bearer <CRON_SECRET>` when the project has a `CRON_SECRET` environment variable. The route
now accepts both `POST` and `GET`; the secret is still mandatory and is never read from a cookie or query string. A minimal `vercel.json`
(do not commit/deploy until approved) would be:

```json
{
  "crons": [{ "path": "/api/internal/tick", "schedule": "* * * * *" }]
}
```

Confirm the plan supports a minute-level schedule before adding it: Hobby cannot run cron jobs more than once a day, so a per-minute
cadence needs Pro (or one of the two alternatives below). The plan is not recorded in the repository — check it in the Vercel dashboard.
The `CRON_SECRET` variable is what Vercel uses to sign its request, so it must exist in the project before the cron is added.
`SCHEDULER_ENABLED` stays `false` until the supervised activation in the checklist below, so deploying the cron definition alone cannot
run jobs.

### 2. Supabase `pg_cron` + `pg_net` (recommended if staying inside Supabase)

Neither extension is installed in the current project. After enabling both, schedule a POST with the secret stored in Vault rather than
hard-coded in the cron command:

```sql
-- Illustrative. Apply only after pg_cron/pg_net are enabled and the secret is in Vault.
select cron.schedule(
  'iacquire-tick',
  '* * * * *',
  $$select net.http_post(
      url := 'https://www.iacquire.online/api/internal/tick',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb
  )$$
);
```

`pg_cron` runs in the database; review who can read `cron.job` and `vault.decrypted_secrets` before using this.

### 3. External cron

Any scheduler that can send `POST` with a bearer header and a 120-second timeout. Keep the secret in that provider's secret store, not in
a URL query string.

## Concurrency and idempotency

- **Tick lease:** `claimSchedulerTick()` inserts/updates a `scheduler_tick` row in `worker_job_runs`. A second invocation while a tick is
  active returns `{ ok: true, skipped: "another scheduler tick is active" }` with HTTP 200. A normal run releases the lease with
  `last_finished_at`; a crashed run is reclaimable after 5 minutes. The 30-second finished window prevents back-to-back duplicate runs.
- **Per-job heartbeats:** `runJob()` records start, finish, success, failure, duration, consecutive failures and a sanitized error class in
  `worker_job_runs`. A failure in one job never stops the others.
- **Job-level idempotency:** each job claims the rows it acts on and is safe to run twice. The suite covers duplicate sends, campaign
  recipients, workflow runs, imports, provider switches and webhook deliveries.
- **Setup-evidence lease:** `setupEvidence` and the server boot both go through `runSetupMaintenance()`, which claims a
  `setup_evidence_reconcile` row in `worker_job_runs` before walking the workspaces. Only one runner in any fifteen-minute window does
  the walk (a crashed one is reclaimed after five minutes); the rest return `0` without touching the database. This is what keeps a
  deployment that cold-starts many functions from multiplying the same 25-transaction walk, and it means the scheduled job and the boot
  path can never run it twice at once.
- **Slow rhythms:** `withinInterval()` skips jobs such as fair-use checks, inactivity review, WhatsApp template sync and AQi tutorial
  retention until their interval has elapsed. Setup evidence uses its lease instead of `withinInterval`, so the boot path and the
  scheduler share exactly one window.

## Failure handling

- The route returns 500 with a generic message if the tick itself throws; the sanitized cause is recorded in the `scheduler_tick`
  heartbeat.
- A job that throws is recorded as a failure; the remaining jobs still run.
- `SCHEDULER_STALE_MINUTES` (default 20) drives a critical incident when `tick` has not completed recently. The incident is opened by the
  public health probe (or an agency page) and closed by the scheduler's own next successful run.
- `GET /api/health` now returns `scheduler: "fresh" | "stale" | "never_ran" | "unknown"` alongside database health. It never returns 503
  just because the scheduler is stopped, so a load balancer does not remove a working web tier.
- `/admin/health` shows the scheduler state, every job's last success/duration/failure count, and the last seven days of sanitized
  diagnostics. It is agency-only and does not expose customer data.

## Activation checklist (requires approval)

1. Decide the scheduler host and confirm it can POST every 1–2 minutes.
2. Generate a 24+ character `CRON_SECRET`; store it only in the hosting secret store and the scheduler.
3. Confirm the outbound kill switches remain `false` until the first supervised run:
   `GHL_WRITES_ENABLED`, `RESEND_WRITES_ENABLED`, `TWILIO_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED`, `N8N_ACTIONS_ENABLED`.
4. Confirm no unexpected pending rows (the query is in the release checklist).
5. Deploy the scheduler configuration with `SCHEDULER_ENABLED=false` first. Verify the endpoint returns 503 and that no job runs.
6. Set `SCHEDULER_ENABLED=true`. Invoke once manually with the secret. Inspect `worker_job_runs`, `/admin/health`, incidents, and outbox
   counts. Confirm no unintended external send.
7. Enable the recurring schedule. Watch the first three ticks and the health `scheduler` field.
8. Rollback: set `SCHEDULER_ENABLED=false` (or remove `CRON_SECRET`). This takes effect on the next invocation; no migration is needed.

## Verification tests

- `tests/billing-routes.test.ts` — secret required; correct secret + enabled runs; disabled returns 503; no secret returns 503.
- `tests/operations.test.ts` — heartbeat success/failure, isolated job failures, stale/fresh/never-run detection, incident open/close,
  tick lease serialization and crash reclaim, public health shape.
- `tests/setup-maintenance-lease.test.ts` — the setup-evidence lease shared by the boot path and the `setupEvidence` job: one claim,
  fifteen-minute window, retry and crash reclaim, and a skipped run creating no checklist.
- `tests/environment-safety.test.ts` — development database guard.
