# Database connection reliability

Status: **local verification complete; no production write, pool-size change, scheduler activation or deployment was
performed.** 2026-10-20.

This note records the evidence behind the P0 connection-timeout work, the one application change it produced, and the
scheduler configuration the next release needs. It follows [performance-ux-pass-20261020.md](performance-ux-pass-20261020.md),
which removed most of the cold-start cost.

## 1. What the evidence establishes

| Observation | What it means |
| --- | --- |
| `ECHECKOUTTIMEOUT` returned to the app | Only Supavisor (the Supabase pooler) produces this error, so production connects through the pooler, not Postgres directly. |
| Supavisor `postgres` role seen at **15** connections | Supavisor's *pool size* is a ceiling **per user + database + mode** ([Supavisor FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)). A flat 15 means the pool was at its ceiling, i.e. the app was asking for more concurrent server connections than the pooler was allowed to open. |
| PostgreSQL limit ≈ **60**, **24** in use | Postgres itself was **not** saturated. The bottleneck was the pooler's 15-connection pool, not `max_connections`, CPU or disk. |
| Timeouts "sometimes after 60 seconds" | Matches the pooler's own queue: session mode queues a client for up to a minute, and transaction mode queues pending queries until the client gives up (same FAQ). The application's `pg` pool sets no `connectionTimeoutMillis`, so a request waits indefinitely instead of failing at a known bound. |
| 25 transactions per cold instance | The Setup Center walk (`backfillSetupInstances` + `reconcileAllSetupInstances`) measured in the earlier pass. |
| Every Vercel function runs the instrumentation hook | Next runs `register()` per function bundle, so a deployment does not run the walk once — it runs it **once per cold function**, multiplied by however many functions the first users touch. |

### Established cause

The application asked the pooler for more concurrent transactions than its 15-connection pool could serve, and the
largest avoidable contributor was the server-boot Setup Center walk: idempotent background maintenance that ran once per
cold serverless function, at ~25 transactions each, exactly while the first real requests were queueing for the same
pool.

### Contributors that remain unverified

- **The exact production URL mode.** Vercel stores `DATABASE_URL` as a sensitive variable (`[SENSITIVE]` in a pulled
  environment file), so its port could not be read without exposing credentials. The reported error and the reported
  mode (transaction mode, port 6543) are consistent, but the dashboard is the only place to confirm it. Note that
  `.env.example` still recommends "direct connection or session pooler" — the wrong default for serverless, and worth
  correcting in the deployment checklist.
- **Whether the database was busy inside a transaction** (lock waits holding a pooled connection). No snapshot evidence
  was provided.
- **The AI Employees page fan-out.** It issues up to seven independent transactions for one render. The in-process
  pool caps that at `DATABASE_POOL_MAX` (4), so it is bounded per instance, but it still raises concurrent demand per
  request. It was **not** changed: the lease below removes the fleet-wide multiplier, and batching the page would add
  serial latency to the screen the release is about.
- **Connection churn.** `idleTimeoutMillis` is 10 s, so a warm instance re-opens TLS connections to Tokyo after a short
  idle gap. Lowering churn would trade idle pooler clients for fewer handshakes; no measurement justified it here.

## 2. The change

**One fleet-wide lease for the Setup Center walk.**

- `claimSetupEvidenceReconcile()` / `finishSetupEvidenceReconcile()` in `src/server/ops/jobs.ts` claim a
  `setup_evidence_reconcile` row in the existing `worker_job_runs` table. The claim is a single atomic
  `insert … on conflict do update … where … returning`, copied from the scheduler-tick lease: one winner, a 30-second
  finished window, and a five-minute reclaim for a crashed runner.
- `runSetupMaintenance()` in `src/server/setup/startup.ts` is the one implementation. Both the server boot
  (`src/instrumentation-node.ts`, after the response) and the scheduled `setupEvidence` job call it.
- Before: `#cold functions × 25` transactions per deployment. After: **at most 25 per 15 minutes for the whole fleet**
  (normally far fewer, because nothing is left to reconcile). A skipped run costs nothing — both passes are idempotent
  and only read recorded evidence.
- The scheduled job also performs the backfill now, so the scheduler remains a complete replacement for the boot path
  instead of covering only half of it.

**One connection at a time for employee knowledge.**

`employeeKnowledgeContext()` (`src/server/workforce/knowledge.ts`) ran its three reads in `Promise.all` on a transaction
handle — one pooled client. node-postgres queues statements on a client, so the calls never overlapped; they only made
the statements depend on the driver's internal queue, which is the `client.query()` "already executing a query"
deprecation production logged, and which pg 9 removes. The reads now run in order on the same connection: identical
result, same tenant scoping, no warning, no driver behaviour to depend on.

## 3. What was deliberately not changed

- `reconcileOrphanedRuns()` still runs on the boot path before the first request. It is one transaction of two
  statements (~4 round trips), and it is the only thing that clears a run left "in progress" by a previous process while
  the scheduler is off. Deferring it would trade a guaranteed recovery for a few hundred milliseconds, so it stays. The
  scheduler is the deterministic home for it once it is activated.
- No pool-size change (`DATABASE_POOL_MAX` stays 4), no `connectionTimeoutMillis` addition, no Supabase setting change,
  no region change.
- No AI Employees page batching, no RLS/authorization change, no schema or migration.

## 4. Scheduler readiness

Already implemented and tested; **not activated**. See [production-scheduler.md](production-scheduler.md) for the full
contract.

| Item | Value |
| --- | --- |
| Endpoint | `POST` or `GET /api/internal/tick` (`maxDuration` 120 s) |
| Authorization | `Authorization: Bearer $CRON_SECRET`, compared with `crypto.timingSafeEqual`; no cookie or query string |
| Switches | `CRON_SECRET` (24+ random chars) **and** `SCHEDULER_ENABLED=true`; either one missing returns 503 and runs nothing |
| Frequency | Every 1–2 minutes. `SCHEDULER_STALE_MINUTES` (default 20) opens a critical incident when a tick stops completing |
| Vercel Cron | Needs a committed `vercel.json` and a plan that allows minute-level schedules (Hobby cannot; confirm the plan in the dashboard). Vercel sends the `CRON_SECRET` bearer header itself |
| Alternatives | Supabase `pg_cron` + `pg_net` (both currently disabled) or any external scheduler that can send the bearer header |
| Overlap safety | Tick lease, per-job heartbeats, per-job idempotency, and the new setup-evidence lease |
| Rollout order | Deploy config with `SCHEDULER_ENABLED=false` → confirm 503 → set `true` → invoke once by hand → inspect `worker_job_runs`, `/admin/health`, incidents and outbox counts → enable the schedule → watch three ticks |
| Rollback | Set `SCHEDULER_ENABLED=false` (or remove `CRON_SECRET`); takes effect on the next invocation, no migration |
| Monitoring | `GET /api/health` → `scheduler: fresh \| stale \| never_ran`; `/admin/health` → per-job success, duration, failures; `worker_job_runs` rows |
| Recovery | A failed job is recorded and the rest still run; a crashed tick or setup run is reclaimed after five minutes; the next successful tick closes the incident |

## 5. Verification

- `tests/setup-maintenance-lease.test.ts` — one claim, 15-minute window, 30-second retry window, five-minute crash
  reclaim, boot and scheduler share the lease, skipping creates no checklist.
- `tests/knowledge-single-connection.test.ts` — exactly one query in flight, statement order, tenant/employee scoping.
- Targeted suites: operations, setup center/experience/fleet-health/realtime, automation controls, maintenance, chat,
  billing routes, environment safety, workforce config, AI workforce experience, AQi knowledge documents, db
  transactions.
- Full suite, lint, both typecheck projects and the production build are recorded in the release report.
