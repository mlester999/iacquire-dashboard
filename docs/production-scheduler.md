# Production scheduler

## Current state (2026-10-20)

The scheduler is **prepared but not activated**.

- `POST /api/internal/tick` exists and runs every job in `src/server/ops/tick.ts` (or only those named in `SCHEDULER_JOBS_ONLY`, see below).
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

### Starting with some jobs only: `SCHEDULER_JOBS_ONLY`

Switching the scheduler on starts **every** registered job (53 on 2026-10-23; it was 45 on 2026-10-22, before the missed-call, lead-scoring, website-chat and social media jobs). To start in stages, set `SCHEDULER_JOBS_ONLY` to a comma-separated list of exact job names from `src/server/ops/tick.ts`
(for example `aiWorkRecovery,crmWorkflowRecovery,inboxAttention`). A tick then runs only those, in the registry's order, and the others do not run and leave no heartbeat. The job inventory, what each can do, and a suggested order of steps are in
[unified-inbox/scheduler-impact.md](unified-inbox/scheduler-impact.md).

**The rules, exactly** (`activeJobs()` in `src/server/ops/tick.ts`; each line is covered by `tests/scheduler-job-allowlist.test.ts`):

| Value | What a tick does |
| --- | --- |
| Unset, or empty (`SCHEDULER_JOBS_ONLY=` as shipped in `.env.example`) | Runs **every** registered job. This is the only way to run all of them, and it still needs `CRON_SECRET` and `SCHEDULER_ENABLED=true` (below). |
| A list of exact names | Runs exactly those, once each, in the registry's order whatever order they were written in. Names are case-sensitive; spaces, tabs and new lines around a name, and empty entries (`a,,b`), are ignored. |
| Any list with a name that is not a job | Runs **nothing**: one unknown name refuses the whole list, so a valid name beside it does not run either. This covers a typo, another case (`AIWORKRECOVERY`), a wildcard or keyword (`*`, `all`, `none`), another separator (`a;b`, `a b`, `a|b`), a negation (`-a`), a heartbeat-only name (`tick`, `missedCallSweep`) and inherited object keys (`__proto__`, `constructor`, `toString`). |
| Only spaces, tabs, new lines or commas (`" "`, `","`) | Runs **nothing**: it is a value that names no job, not "unset". (Earlier, a value of spaces was trimmed to "unset" and started every job; that is fixed and tested.) |
| More than 2000 characters | Runs **nothing**. Naming every job takes about 950 characters. |

"Runs nothing" means the endpoint answers `500 Scheduled work failed. See the worker heartbeat for details.`, no job starts and no job heartbeat is written, and the reason (for example `Error: SCHEDULER_JOBS_ONLY names a job that does not exist: typo.`) is recorded in the
`last_error` of the `scheduler_tick` row of `worker_job_runs`, whose failure count rises with every refused tick. The next tick after the list is corrected runs normally and the count starts again from zero. The list is checked by the tick, not when the server starts, so a bad list stops the scheduler only: it cannot make the
application's configuration invalid or take the web application down. A request cannot change the list: the endpoint reads only the `Authorization` header, and a query string, body or other header is ignored (`GET` and `POST` alike).

**What "unset" means in production.** With the variable unset or empty, a tick runs all 53 jobs, but only behind two other switches: `CRON_SECRET` must exist and the request must carry it (otherwise `503` / `401`), and `SCHEDULER_ENABLED` must be `true` (or `1`; `false`, `0`, empty or absent answer
`503`, with the list not even read). So the staged start is not a safety switch that has to be remembered: the scheduler as a whole is off until a person sets `SCHEDULER_ENABLED=true`. But once it is on and the list is unset or empty, everything
starts. Set the list **before** setting `SCHEDULER_ENABLED=true`, and after the first tick check that `worker_job_runs` shows a recent `last_started_at` for the named jobs only. The Phase 2 to 4 jobs (`leadScoreReassessment`, `missedCallRecovery`, `phase2Retention`, `webChatRetention`, `socialPublisher`,
`socialAccountHealth`, `socialMetrics`, `socialCleanup`) run only when named, or when the list is unset.

**Naming a job does not skip that job's own gates.** The list chooses which jobs may run; each job still obeys its feature flags, workspace settings and provider write switches. For example `missedCallRecovery` acts only under a workspace's missed-call policy and only queues a text through the ordinary
send rules; `socialPublisher` does not pick up a real account's post while `META_SOCIAL_WRITES_ENABLED` is not `true`; `leadScoreReassessment` asks a model only for a workspace that switched extraction on; `aiWorkSchedules`, `aiWorkTriggers` and `aiProactiveBriefings` need `WORKFORCE_SCHEDULES_ENABLED`,
`WORKFORCE_TRIGGERS_ENABLED` and `WORKFORCE_BRIEFINGS_ENABLED`. `tests/scheduler-job-allowlist-phases.test.ts` shows it on real pending work in synthetic workspaces: the same data is untouched while other jobs are named, then handled by each of the eight under its own gate once they are named.

**What the list does not govern.** It limits the tick and nothing else. Three things run without it: the two maintenance passes that run when the server starts (see Current state above; the Setup Center one only reads recorded evidence), the AI workforce worker process (`WORKFORCE_WORKER_ENABLED`), and request-time paths. In particular a provider webhook
for an inbound message (Twilio, WhatsApp, Resend, GoHighLevel) asks the AI employee for a reply where the workspace has automatic replies on, and then calls the dispatcher for up to five messages straight away, whether or not `repliesChecked` and `messagesDispatched` are in the list; what stops those is the provider write switch, not `SCHEDULER_JOBS_ONLY`.

**Order matters for messaging:** the dispatcher (`messagesDispatched`) turns a queued message into a final `blocked / provider_not_enabled` while a provider write switch is off, so keep it, `repliesChecked` and
`followUpsPrepared` out of the list until the provider is switched on.

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
- **Slow rhythms:** jobs such as fair-use checks, inactivity review, WhatsApp template sync and AQi tutorial retention declare
  `everyMinutes`; `runJob` claims the slot atomically and skips the job (writing nothing) until that much time has passed since its previous
  run started. A failed run is retried sooner, and a run that never finished is presumed dead after 15 minutes. Intervals are elapsed time,
  not calendar slots, so they do not depend on a time zone or daylight saving. Setup evidence uses its lease instead, so the boot path and
  the scheduler share exactly one window.

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

## Proactive AI employee jobs

Four jobs relate to proactive AI employees and are all inert until separately authorized:

- `aiWorkSchedules` creates jobs for enabled tenant schedules only when `WORKFORCE_SCHEDULES_ENABLED=true`.
  Business-hour windows are evaluated in the schedule's time zone; an enabled row outside its window is
  postponed and records the reason.
- `aiWorkTriggers` creates jobs for enabled event triggers only when `WORKFORCE_TRIGGERS_ENABLED=true`.
- `aiProactiveHeldReports` releases existing non-critical reports after quiet hours. It never creates work.
- `aiProactiveBriefings` generates opted-in daily/weekly briefings only when
  `WORKFORCE_BRIEFINGS_ENABLED=true`. It never contacts a provider.

The tick still never runs provider work. It creates durable `ai_work_jobs` rows and wakes the worker; a Lead Hunter
research schedule also creates the linked `lead_research_requests` row. See
[Proactive AI employees](proactive-ai-employees.md) for the delivery policy, safety boundaries and activation
checkpoint.

## Social media jobs

Four jobs belong to the social media manager. None runs until the scheduler does, and in a staged start each runs only when it is named in `SCHEDULER_JOBS_ONLY`.

- `socialPublisher` (every tick) takes over jobs a dead worker left, publishes approved posts that are due, and checks every post whose outcome was unknown. A job for a real Facebook or Instagram account is not even
  picked up while `META_SOCIAL_WRITES_ENABLED` is not `true` (it waits in the queue); simulated accounts reach nothing. A workspace that is suspended, archived or paused (iAcquire's pause, the agency-wide pause or the workspace's
  outbound pause) has its jobs held and not failed, and they resume when it is active again. **A post is not sent late:** when a job is first picked up more than 6 hours after the post's scheduled time (`MISSED_WINDOW_MS` in
  `src/server/social/publisher.ts`), the post fails with the code `missed_window`, the owner is told, and a person schedules it again. So switching publishing on, or ending an outage, does not send a burst of old posts. A job that
  is already retrying keeps retrying within its attempts. One pass is budgeted 20 seconds (`PUBLISH_BUDGET_MS`): it takes no new post after 15 seconds, so that checking unknown outcomes always has at least 5
  seconds, and what it did not reach stays queued for the next tick. A request to the platform already under way is not cut off (each has its own timeout).
- `socialAccountHealth` (every 6 hours) asks the platform whether each connected account of an active workspace still works (read only), the one checked longest ago first, and starts no new check after 20 seconds. A platform that
  cannot be reached does not change an account's status. Owners and admins are warned once, per account and date, when a sign-in or the platform's access to the account's data ends within 7 days.
- `socialMetrics` (every 6 hours) reads the likes, comments and shares the platform returns for posts published in the last 30 days (read only), the post read longest ago first and one workspace's turn after another's, and starts no
  new read after 40 seconds. Numbers the platform does not return are left absent, never filled with zero.
- `socialCleanup` (every 15 minutes) clears the sealed Pages and tokens of a sign-in nobody finished once its ten minutes are up (the sign-in record itself is deleted a day later) and finishes deleting stored copies of media
  files a person removed when the storage delete failed at the time.

The three budgets (20, 20 and 40 seconds) add up to 80 of the tick's 120 seconds before any request already under way finishes, and these jobs run before the message dispatcher in `src/server/ops/tick.ts`. With no
real account connected they find nothing to do; keep that in mind before connecting many accounts. Go-live steps for live publishing are in [roadmap/phases-3-to-7/blockers.md](roadmap/phases-3-to-7/blockers.md).

## Reputation jobs

Two jobs belong to reputation and follow-up. Both are internal: they tell the team something and never write to a customer, call a provider or mark anything attended. Like every job they run only when the scheduler does and, in a staged start, only when named in `SCHEDULER_JOBS_ONLY`; naming one does not skip its workspace setting (CRM → Reviews → Settings). `tests/reputation-jobs.test.ts` shows both through the real tick endpoint.

- `feedbackSla` (every 15 minutes) finds low private feedback (`customer_feedback.low_score`) that nobody has acknowledged within the workspace's time (24 hours unless it chose otherwise) and tells the owner, the managers and the person the follow-up task is assigned to, **once** per item (the item's `sla_notified_at` is set in the same transaction as the notices, with a row lock, so overlapping ticks cannot both announce it). It leaves alone items that someone acknowledged or resolved, whose task was finished, whose inbox escalation a person took, that are older than 14 days (so the first run in a workspace does not announce months of old items), and workspaces that are not active or switched the reminder off. At most 100 items a run. The notice names the customer and the wait, never what they wrote.
- `appointmentOutcomeNudge` (daily) tells the owner and managers of each workspace that **switched it on** (off by default) how many appointments ended more than two hours ago, within the last 14 days, and are still neither marked attended nor a no-show. Only a person can mark an appointment, and every follow-up that starts from "attended" depends on it. The job counts and announces; it never changes an appointment. The notice is keyed per workspace and day, so a second run the same day tells nobody twice.

One more reputation job **does write to customers**, so it is held to the strictest gates and belongs to a later step of the staged start than the two above:

- `reviewRequestBatches` (every tick, before `messagesDispatched` so what it queues goes out in the same run) works only on review request batches an **owner approved**, in workspaces a Super Admin switched batches on for (`org_features`, feature `reputation_batches`; absent means off) and that are active. Per batch it re-checks the owner's approval and a hash of everything they approved (any change stops the batch), then asks at most the batch's own pace in any minute (1 to 60, default 10), each customer in their own transaction through the ordinary review request, so consent, opt-outs, the 30-day cool-down, a person's hold, quiet hours, frequency limits and credits all apply. A paused workspace holds the batch and what it queued. At most 5 batches and 200 customers per batch a tick. Safe to run twice at once: the pace is spent inside the batch's row lock and a second message to the same customer is impossible (`batch:<batch>:<customer>`). **Do not name it in `SCHEDULER_JOBS_ONLY` until a founder-approved stage**; named with no approved batch it does nothing. `tests/reputation-batch-job.test.ts` shows pacing, drift stops and pauses with a recorder as the provider.

## Proposal jobs

Two jobs belong to proposals. Neither contacts a customer. Like every job they run only when the scheduler does and, in a staged start, only when named in `SCHEDULER_JOBS_ONLY`; naming one does not skip its gates: they look only at workspaces a Super Admin switched proposals on for (`org_features`, absent means off) that are not suspended or archived. `tests/proposals-jobs.test.ts` shows both, including that they leave a heartbeat only when named.

- `proposalExpiry` (every 60 minutes) closes sent proposals whose valid-until date has passed **in the workspace's own calendar** (the whole of the last day still counts, so a workspace east of Greenwich closes earlier and one west of it later): the status becomes expired, the customer's link stops opening (the page then says the proposal expired), the owner is told once and the `proposal.expired` trigger fires once. It warns the owner once, two days ahead, of proposals about to expire (`EXPIRY_WARNING_DAYS`, a proposed default). Each proposal is its own transaction, so one that fails is counted and tried again on the next run and never holds back the rest.
- `proposalHousekeeping` (daily) deletes emailed-code challenges and customer sessions a day after they ended, and the outbox copy of each `proposal_code` email an hour after it was made (the six digits are in the text of that row).

The customer-facing side has its own emergency switch, `PROPOSALS_PUBLIC_DISABLED` (`true` makes `/proposal/<token>`, its PDF and its API answer "temporarily unavailable" for every workspace before any database read, and stops the emailed codes). It is independent of the scheduler.

## Electronic signature job

One job belongs to electronic signing of proposals (migration 0092, `docs/esignature.md`). Like every job it runs only when the scheduler does and, in a staged start, only when named in `SCHEDULER_JOBS_ONLY`; naming it does not skip its gates. `tests/esign-jobs.test.ts` shows it through the real tick endpoint on real pending work.

- `esignSync` (every tick) works only for workspaces a Super Admin switched **both** proposals and signing (`org_features`, features `proposals` and `esign`; absent means off) on for, that are not suspended, archived or paused by iAcquire (a shut-down client is), and whose signing connection works. In one pass, in this order and inside a 25-second budget: it takes over requests a dead worker left (resumed from the state saved after every step, or checked with the service when something may already have been made); hands queued signing requests to the client's own signing service (one request at a time under a lease, the intent to create something written before the call); checks requests whose answer was lost (they are looked up by the reference in the document's name and never sent again on a guess; "not found" is believed only after ten minutes, and after a day without a way to ask the request is ended with a note to look in the signing account); reads requests that are out when no notice came (about every fifteen minutes each, a safety net, applied exactly as a notice would be); fetches the signed copy and certificate of completed requests (eight tries on a growing wait, then a notice to download it from the service); tells the service to withdraw what a person withdrew where the service allows it (five tries, then the business is asked to do it there); and checks each connection's key about every six hours.
- **It never writes to a real signing service unless `ESIGN_WRITES_ENABLED=true`.** A request through a real connection simply waits, untouched, while the switch is off. The simulated stand-in service reaches nothing and does not exist in production (`NODE_ENV=production` refuses it everywhere: connecting, handing over, believing a notice for it).
- It runs every tick rather than hourly because a request waits for a pass, and the service takes a few seconds to make a document: an hourly rhythm would stretch one signing request over hours. The audit proposed five minutes; the work per pass is a handful of indexed queries when nothing is due, and the polling and key checks keep their own, slower pace inside the job. If a slower rhythm is wanted, give the job `everyMinutes` in `src/server/ops/tick.ts` and add it to `EXPECTED_SLOW` in `tests/scheduler-intervals.test.ts`.
- The webhook route `/api/webhooks/esign/<secret>` is not part of the scheduler and answers whenever the platform is up; it is switched off for every workspace at once by `PROPOSALS_PUBLIC_DISABLED=true` (answering 503 so a service delivers again later).

## Public review jobs

Three jobs belong to public reviews and renewals (migrations 0094 and 0095, `docs/voice-and-reviews.md`). None contacts a customer, and none posts, approves or sends a reply: a reply is only ever sent by a person pressing Post in the portal. Like every job they run only when the scheduler does and, in a staged start, only when named in `SCHEDULER_JOBS_ONLY`; naming one does not skip its gates. **The three names are new: a staged start that was written before them does not run them, and nothing here changes a stage that is already approved. Adding them to a stage is the founder's decision.** `tests/reputation-external-jobs.test.ts` shows all three through the job table.

- `reviewSync` (every 60 minutes) reads the public reviews of connected review sites, for workspaces a Super Admin switched public reviews on for (`org_features`, feature `reputation_reviews`; absent means off) that are active, and only for sites that are connected and whose environment is ready. A real Google or Facebook site is not even asked while its switch is off (`GOOGLE_BUSINESS_API_APPROVED`, `META_REVIEWS_ENABLED`); the simulated site reaches nothing and does not exist in production. At most 20 connections a run, 6 pages of 50 reviews each per connection per run, each connection under a lease (`sync_lease_until`) so overlapping runs cannot read it twice. Reviews are written by an upsert on the site's own review id, so reading twice never makes a second copy. A review the site stops returning is marked removed **only after a complete pass** that read at least as many reviews as the site reports; a pass cut short, or a site that reports more than it returned, removes nothing. The first pass in a connection announces only reviews less than 48 hours old, so connecting a site with years of reviews does not notify the team of each one. The same job checks replies whose result was lost (`needs_reconciliation`): it reads the site, and never sends the reply again (see "Replies" in `docs/voice-and-reviews.md`).
- `renewalReminders` (daily) creates one internal task and one notice for the owner and managers when a retention account's renewal is 30, 14 or 7 days away, in workspaces that switched renewal reminders on (CRM → Reviews → Settings; off by default). A task and a notice for the team and nothing else: nothing is written to the customer. Each window is created once per account and renewal date (`retention_account` + the date and window).
- `reputationRetention` (daily) clears sealed sign-in choices of an unfinished Google sign-in once its ten minutes are up (deletes the row a day later), and deletes, at most 500 rows of each kind a run: reviews of a connection disconnected more than 90 days ago, reviews the site stopped returning more than 90 days ago (never one with a reply still in progress), and the history of finished replies (posted, rejected, cancelled) older than 730 days. **The three periods are proposals for the product owner to confirm** (`src/server/reputation/housekeeping.ts`). It never touches a connection's own row or the audit log.

Neither the reviews nor the replies leave through any webhook, and the reviewer's name and words never appear in a notice.

## Automation Studio and the scheduler (checked 2026-10-22)

State in production (read-only checks: Vercel project settings and variable names, `worker_job_runs`, public `GET /api/health`, `GET /api/internal/tick`): there is **no `CRON_SECRET`**,
no `SCHEDULER_ENABLED`, no `vercel.json`, the tick answers 503, `/api/health` reports `scheduler: "never_ran"`, and the hosted database holds no Automation Studio
workflow, run, conversation, connection or usage row (so nothing is waiting for the scheduler yet).

**What does and does not work while the scheduler is off**

| Works at request time (no scheduler needed) | Needs the tick (does nothing until it runs) |
| --- | --- |
| Building and editing in Auto and Manual mode, the AI builder chat, undo and redo, versions, dry-run tests, publishing, requesting and giving owner approval, switching a workflow on or off, connection setup and its confirmed test, plan checks at every entry point, the inbound webhook **accepting** a call (it starts a run) | `crmEventDispatch` (CRM events reaching workflows), `crmWorkflowRuns` (every step after the first moment of a run: waits, delays, schedule triggers, Slack and HTTP calls, retries), `crmWebhookDeliveries`, `crmWorkflowRecovery`, `studioEntitlementSweep` (a past-due plan becoming expired, the 48-hour grace reminder, pausing a lapsed workspace's workflows, the "your workflows are waiting" notice) |

A plan that is past due still stops being honoured the moment its grace period ends, because every entry point and the engine check the time themselves; what the scheduler adds is the
status change, the notices and the pause. Core features (native CRM, AI employees and their schedules, n8n / Zapier / Make, webhooks, the API) do not depend on the plan either way.

**Rehearsal evidence (local, isolated database, simulated clock; nothing hosted was touched)**

- `tests/automation-studio-scheduler-rehearsal.test.ts`: the real `POST /api/internal/tick` with the bearer secret and `SCHEDULER_ENABLED=true` and the **real job list**
  (every registered job ran, none failed). Two synthetic workspaces, one Studio workflow each (task, 2-day wait, team notice, Slack post) and a core CRM workflow in one of them.
  Verified: events become runs and run once; repeated ticks and two overlapping ticks change nothing; the Slack post happens once per contact and only after the wait; a payment
  failure with a one-day grace period expires the plan, pauses that workspace's Studio workflow, **holds** its run (never fails it) and leaves its core workflow running; a lapsed
  workspace makes no outside call; a verified payment brings the plan back and nothing switches itself on; when a person turns the workflow back on, its held run is looked at
  again immediately (found and fixed in this rehearsal: it used to wait out the one-hour hold) and finishes exactly once; no job ends with consecutive failures.
- `tests/crm-fair-claiming.test.ts`: due runs are leased fairly across workspaces (oldest first, one per workspace per round, a lone workspace still gets the whole tick), a paused
  workflow's runs are never leased, and two overlapping ticks never lease one run twice.
- `tests/automation-studio-templates-run.test.ts`: all 20 templates, started through the same runner, run to completion (a 30-day wait finishes on the simulated clock), leave a
  readable row for every step, and reach outside only as their card says.

**Not yet proven, and why**: a tick against the hosted database (it would start every enabled job for real), the production Vercel cron cadence (needs the plan tier), and a real Slack delivery
(needs a founder-provided test webhook).

**Exact steps to switch the scheduler on for Automation Studio** (each one needs the founder's approval; none is done by the code)

1. The Vercel team is on the **Hobby** plan (read from the team record on 2026-10-22), which allows a cron job to run only once a day: every wait would be up to a day late. Use Vercel Pro, or the Supabase `pg_cron` + `pg_net`
   route described above, or an external cron that can POST every one to two minutes. (Also check the route's 120-second `maxDuration` against the plan's function limit.)
2. Generate `CRON_SECRET` (at least 24 random characters) and add it to **Production** only. Add `vercel.json` with the `crons` entry above (path `/api/internal/tick`) in a reviewed commit. Leave
   `SCHEDULER_ENABLED` unset. Deploy. Check: `GET https://www.iacquire.online/api/internal/tick` without the header answers 401 and with it answers 503 ("Scheduler is disabled").
3. Confirm every provider kill switch is still `false` (`GHL_WRITES_ENABLED`, `RESEND_WRITES_ENABLED`, `TWILIO_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED`, `N8N_ACTIONS_ENABLED`) and that
   `WORKFORCE_SCHEDULES_ENABLED`, `WORKFORCE_TRIGGERS_ENABLED` and `WORKFORCE_BRIEFINGS_ENABLED` are unset: switching the tick on starts **every** registered job, not only the Studio ones.
4. Run the pending-work query from the release checklist; today it is expected to return zero rows for workflows, runs, messages and webhooks.
5. Set `SCHEDULER_ENABLED=true`, redeploy, and watch the first three ticks in `/admin/health` (`scheduler` should read `fresh`; no job should show a failure).
6. Pilot Automation Studio with **one synthetic workspace** that has the plan: build a template that stays inside iAcquire (for example *Speed to lead*), add a Slack connection with a webhook
   you control and send its confirmed test, switch on the *New lead alert* template, create one contact, and confirm the Slack message arrives once and the run ends `completed`. Only then
   invite a real client.
7. Rollback at any time: set `SCHEDULER_ENABLED=false` (and redeploy) or delete `CRON_SECRET`. Runs wait; nothing is lost.

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
- `tests/scheduler-job-allowlist.test.ts` — the `SCHEDULER_JOBS_ONLY` rules above: unset, empty, spaces-only, commas-only, unknown, differently-cased, duplicate, inherited-key and over-long values; that a name selects only itself; and, through the real endpoint, that a request cannot choose jobs, every invalid
  list answers 500 and runs nothing, and nothing starts without the secret and `SCHEDULER_ENABLED`.
- `tests/scheduler-job-allowlist-phases.test.ts` — the eight Phase 2 to 4 jobs against real pending work: untouched while other jobs are named, and each under its own gate (policy, write switches, no network) once named.
