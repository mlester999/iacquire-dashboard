# Operations, health and incidents

Migration `0022_operations.sql`. Code: `src/server/ops/*`, `src/lib/ops.ts`, `src/app/api/internal/tick/route.ts`, `src/app/api/health/route.ts`.
Status: **Implemented locally, tested with mocks** (`tests/operations.test.ts`, 35 tests). Nothing has run against a hosted project.

## The scheduler

All background work runs from one authenticated endpoint, `POST /api/internal/tick` (bearer `CRON_SECRET`). A host cron or scheduler calls it
every minute or two. Each job in `JOBS` (`src/server/ops/tick.ts`) is idempotent and isolated: one that throws is recorded as failed and the
rest still run. Slow jobs declare `everyMinutes` on their `JOBS` entry (fair-use checks and support auto-close hourly; inactivity review and deletion
reminders every six hours; see the table in [aqi-operations.md](aqi-operations.md#13-scheduler-how-slow-rhythm-jobs-run)) and `runJob` runs them only
when that long has passed since their previous run **started**, claiming the slot in the same statement that checks it. A tick that finds a job not due
writes nothing, so `worker_job_runs` keeps describing the last time the job really ran, and the tick response reports it as `"skipped"`.
A failed run is retried after `min(interval, 15)` minutes; a run that started and never finished is treated as still running for 15 minutes and then as
dead. (Before this, each job tested `withinInterval()` itself and returned 0, which was recorded as a success and moved `last_success_at` forward on every
tick, so a gated job ran once and never again.)

Two jobs belong to AQi Operations and are deliberately **not** interval-gated: `aqiOperationsBriefings` (generates a briefing only for an
administrator who opted in, keyed per person and local day or incident, so running every tick cannot duplicate) and `aqiOperationsRetention`
(removes Super Admin investigation history and stored briefings older than 180 days, 100 of each per run). Scheduled briefings therefore need the
scheduler to be configured (`CRON_SECRET`, `SCHEDULER_ENABLED`); until then briefings can only be generated on demand, and the console says so.

Every run writes a heartbeat row in `worker_job_runs` (`tick` plus one row per job). If no heartbeat arrives for `SCHEDULER_STALE_MINUTES`
(default 20) the platform opens a **Scheduled jobs stopped** incident. The scheduler cannot report its own death, so the check runs from `/api/health` (at most once a minute per server instance, and
never affecting the health response). An external uptime check on `/api/health` is therefore part of the setup.

## Incidents

An incident is opened from **evidence**, closed only by a **later passing check**, and never by someone saying so:

| Rule | Behaviour |
| --- | --- |
| Open | A collector observes an unhealthy condition. Repeats increase `occurrences` and `last_seen_at`; they do not open a second incident (one open incident per source + subject) |
| Close | A later collector run that observes the condition healthy records the evidence and closes it |
| Manual close | Allowed for staff, recorded separately as a manual resolution with a note. It is not shown as "recovered" |
| Escalate | A critical incident still unacknowledged after 30 minutes re-notifies agency staff once (`escalateUnacknowledged`) |
| Client-visible | Only incidents flagged client-visible appear on a client's Overview, in plain words ("Texting is paused while we fix a problem"). Internal detail is never shown |

Collectors (`src/server/ops/collectors.ts`) read tenant and platform state by source prefix: `scheduler:`, `queue:` (stuck outbound messages),
`messaging:`, `credits:`, `payments:` (webhook errors, unmatched events), `website:`, `domain:`, `integration:`, `ghl:`, `hermes:`, `automation:`.
They read recorded state. **No active provider probe runs from here**, so a provider outage is only seen once a real call has failed or a
connection check the agency ran has recorded it.

Error text stored on an incident passes through `sanitizeErrorText`, which strips keys, tokens, bearer values and long opaque strings.

## Notifications

Email delivery of important notifications is queued by `notificationEmails` and sent through the existing email adapter. It is **off until an
email sender is configured** (`EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`). People choose in Settings → Notifications by group
(`src/lib/notification-groups.ts`) and by email level (all / important / off; the default is important). Customer message content is never put in an email: it carries a
title and a link, the detail stays behind sign-in.

## Where to look

- `/admin/health`: provider health, scheduler heartbeat, recent job runs, incidents with acknowledge / note / resolve.
- Client Overview: service notices for client-visible incidents.
- `/dev/operations-preview?view=incidents|notices|notifications`: sample-data views (development only; 404 in production).
