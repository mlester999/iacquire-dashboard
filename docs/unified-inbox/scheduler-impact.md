# Scheduler: what would run if it were switched on

An impact assessment for the founder's gate ("do not enable production scheduler jobs without an impact assessment and explicit approval"). Written 2026-10-22 from the code on
`integrate/unified-inbox-workforce`, the runbook [../production-scheduler.md](../production-scheduler.md) and tests. **Nothing was run against production, and the scheduler is not enabled anywhere.**
What I could not read from here (and you or I must re-read, read-only, before any approval) is marked **verify**.

## 1. Where it stands

* `POST` or `GET /api/internal/tick` exists. It needs **two** switches: `CRON_SECRET` (24+ characters, bearer token) and `SCHEDULER_ENABLED=true`. As of 2026-10-20 production had neither, `worker_job_runs` had no `tick` row (the scheduler
  has never run), no cron is configured, and every provider write switch was `false` (**verify**: re-read before relying on any of this).
* One tick runs **all 53 registered jobs in order** (45 when this was first written on 2026-10-22; section 2g covers the eight added since), each isolated (a failure in one is recorded and the rest still run), with a heartbeat per job and a tick lease so overlapping calls do nothing. Slow jobs declare `everyMinutes` and are skipped between slots.
* **There is no per-job switch.** Today "enable the scheduler" means "start all 53 jobs". Only some jobs have their own feature switch (listed below). This pass adds one (`SCHEDULER_JOBS_ONLY`, section 5) so activation can be staged job by job; it is
  unset (all jobs) unless someone sets it.

## 2. The 53 jobs, by what they can do

Cadence is every tick (the runbook recommends 1 to 2 minutes) unless a slot is given. "Outside" means anything that leaves iAcquire: an email, a message to a customer, a call to a provider or a customer's own site.

### 2a. Can message customers or send email (the highest-impact group)

| Job | Slot | What it does | Safeguard that holds today |
| --- | --- | --- | --- |
| `messagesDispatched` | tick | Sends every queued message (SMS, WhatsApp, email replies, follow-ups, campaign messages, reminders) | The four provider write switches (`GHL`, `RESEND`, `TWILIO`, `META_WHATSAPP`) are off: a queued message becomes **`blocked` with the reason `provider_not_enabled`**, which is final, and nothing leaves (tested, with a spy on the network). See risk 2 |
| `repliesChecked` | tick | The AI employee answers AI-owned conversations whose latest customer message has no answer (a recovery sweep; each message answered at most once) | The reply is queued, and the same write switches block it when the dispatcher reaches it. **It does call the AI model** for each pending conversation (usage is charged to the workspace's credits) |
| `followUpsPrepared` | tick | Prepares due AI follow-ups | Queued, then blocked the same way |
| `appointmentReminders`, `retentionPrograms` | tick | Queue appointment reminders and retention steps for the dispatcher | Same |
| `crmCampaigns` | tick | Starts owner-approved campaigns and queues each at its approved pace | Needs an owner-approved campaign; same write switches |
| `escalationsOpened` | tick | Advances escalations: alerts the owner first, then staff after the timeout | Emails go out through `sendEmail` (see `EMAIL_PROVIDER`) |
| `notificationEmails` | tick | Emails in-app notifications to the people who should not miss them | **`EMAIL_PROVIDER` decides: `capture` (the default) only stores them; `resend` sends** (**verify** production's value). Default preference is "important", which includes every `warning` notice |
| `crmTaskReminders`, `domainRenewals`, `supportEmails`, `offboardingReminders`, `inactivityReview`, `supportResponseTargets` | tick, or 60/360 | Reminders and notices to workspace staff and clients | Email via the same provider setting; support targets, auto-close and retention do nothing until the Super Admin turns them on |
| `crmWebhookDeliveries` | tick | Sends signed webhooks to endpoints a workspace configured | Only for subscriptions people created; retries with back-off |

### 2b. Calls other systems

| Job | Slot | What it does | Safeguard |
| --- | --- | --- | --- |
| `calendarBusySync` | tick | Reads busy times from connected Google, Microsoft and CalDAV calendars | Read only; `CALENDAR_SYNC_DISABLED` stops it |
| `calendarWriteBack` | tick | **Writes** bookings to connected calendars and deletes cancelled ones | `CALENDAR_SYNC_DISABLED` stops it |
| `whatsappTemplateSync` | 180 min | Mirrors WhatsApp template status from Meta (read only towards Meta) | None needed |
| `websiteHealth`, `incidentChecks`, `incidentEscalations` | tick | Checks live websites and runs health collectors; opens and escalates incidents | Read-only checks |
| `crmProviderSwitches` | tick | Runs a CRM provider cutover or rollback a person started | Only when a switch exists |
| `crmImports`, `crmFormSubmissions`, `websiteEnquiries` | tick | Moves imports forward in chunks; turns form and enquiry submissions into contacts, consent and tags | Only for rows that exist |

### 2c. Automation engines (they decide what else happens)

| Job | What it does |
| --- | --- |
| `crmEventDispatch` | Hands the event outbox to workflows, lead assignment, follow-ups and webhooks. **This is where the inbox's events (assigned, resolved, urgent, handoff, went quiet) reach workflows.** |
| `crmWorkflowRuns` | Advances due workflow runs (CRM and Automation Studio alike; a message step queues its message, the dispatcher sends it). Studio-origin workflows also need the plan |
| `crmWorkflowRecovery` (5 min) | Re-queues runs a stopped worker left behind; cancels runs whose approval lapsed |
| `studioEntitlementSweep` | Expires a Studio plan past its grace period and **pauses Studio-origin workflows only** (core CRM workflows and AI employees are never selected; nothing is deleted) |

### 2d. AI employees (Workforce)

| Job | Slot | Gate |
| --- | --- | --- |
| `aiWorkRecovery` | 5 min | Re-queues work whose worker lease expired, or fails it honestly. Never runs provider work in the tick |
| `aiWorkSchedules` | tick | Creates durable jobs only when `WORKFORCE_SCHEDULES_ENABLED=true` **and** the schedule row is on |
| `aiWorkTriggers` | tick | Creates durable jobs only when `WORKFORCE_TRIGGERS_ENABLED=true` **and** the trigger row is on |
| `aiProactiveHeldReports` | 5 min | Releases a verified, already-held report after quiet hours; creates no work |
| `aiProactiveBriefings` | 5 min | Opt-in briefings only with `WORKFORCE_BRIEFINGS_ENABLED=true` |
| `aqiOperationsBriefings`, `aqiOperationsRetention`, `aqiTutorialEventRetention` | tick / 1440 | Briefings only for administrators who opted in; retention purges old stored briefings and tutorial events in bounded batches |

The workforce jobs never run provider (Hermes) work themselves; the separate worker does, and it is not part of the tick.

### 2e. The inbox

| Job | Slot | What it does | Safeguard |
| --- | --- | --- | --- |
| `inboxAttention` | 5 min | In-app "customer is waiting" notices (once per customer message, at most ten a workspace per scan, plus an hourly summary) and `conversation.idle` events for workflows that listen | **Only workspaces switched on for the new inbox are read** (none by default). One workspace's trouble no longer stops the rest. **In-app only by default** (this pass: previously a `warning` notice would have been emailed under the default preference). 31 ms at 30,000 conversations (embedded) |

### 2f. Housekeeping (no outside effect)

`expiredReservations` (release expired credit holds), `approvalExpiry`, `bookingHolds`, `supportAutoClose` (60 min, off until the Super Admin enables it), `supportAttachmentCleanup` (60), `fairUseChecks` (60), `setupEvidence` (own 15-minute lease; records evidence, contacts no provider).

### 2g. Added since (2026-10-23): missed calls, lead scoring, website chat, social media

| Job | Slot | What it does | Safeguard that holds today |
| --- | --- | --- | --- |
| `missedCallRecovery` | tick | Works callers who were missed under their workspace's policy: a call-back task and a notice for the team, and a text only through the ordinary send rules | The policy is off by default, so cases are only watched and expired; the text goes out in the dispatcher run straight after and is blocked while a provider write switch is off |
| `leadScoreReassessment` | tick | Scores contacts whose details changed again, a few per workspace per run, within a daily ceiling | Rules do the scoring; a model is asked only for workspaces that switched signal extraction on |
| `phase2Retention`, `webChatRetention` | 1440 min | Delete old missed-call cases, lead-score records and website chats past their retention | Housekeeping; `webChatRetention` has never run live |
| `socialPublisher` | tick | Publishes approved social posts that are due, takes over jobs a dead worker left, and checks posts whose outcome was unknown | A real Facebook or Instagram account is posted to only while `META_SOCIAL_WRITES_ENABLED=true`: until then its jobs wait in the queue, and simulated accounts reach nothing. A suspended, archived or paused workspace's jobs wait too. **A post more than 6 hours past its scheduled time when its job is first picked up is not sent**: it fails with `missed_window` and its owner is told, so switching publishing on does not release a burst of old posts. One pass is budgeted 20 seconds |
| `socialAccountHealth` | 360 min | Asks the platform whether each connected account of an active workspace still works (read only); warns owners 7 days before a sign-in or data access runs out | Does nothing until an account is connected; stops starting checks after 20 seconds |
| `socialMetrics` | 360 min | Reads the likes, comments and shares the platform returns for posts published in the last 30 days (read only) | Does nothing until a post has been published to a connected account (test accounts are read from the simulated platform); stops starting reads after 40 seconds; an absent number stays absent |
| `socialCleanup` | 15 min | Clears the sealed Pages and tokens of sign-ins nobody finished (deletes the record a day later) and finishes deleting stored media files a person removed | Housekeeping; touches only social sign-in states and removed media |

The three social jobs with budgets can spend 80 seconds of the tick's 120 between them (20, 20 and 40) and run before the message dispatcher. With no real account connected they find nothing to do.

## 3. What the first tick would do in production today

With the facts as of 2026-10-20 (**verify**): no queued messages, email, reminders, workflow runs, campaigns, imports, switches or webhooks, and every provider write switch off, so **most jobs find nothing to do**. The ones that can act on state that already exists:

* `repliesChecked`: any AI-owned conversation whose last customer message is unanswered gets an AI reply attempt (model call and usage charge; the reply is later blocked by the switches).
* `notificationEmails`: notifications already in the app, newer than 48 hours, are emailed if `EMAIL_PROVIDER` is not `capture`.
* `escalationsOpened`, `incidentChecks`, `websiteHealth`, `fairUseChecks`, `inactivityReview`: act on existing escalations, live sites and usage.
* `setupEvidence`, `studioEntitlementSweep`, the retention jobs: housekeeping.
* `inboxAttention`: nothing, until a workspace is switched on.

## 4. Activation risks, ranked

1. **Email volume to client staff** (`notificationEmails`, `escalationsOpened`, the reminder jobs) if production's `EMAIL_PROVIDER` is not `capture`. For the inbox this is now closed by default (in-app only), but every other kind behaves as before.
2. **Order of activation for messages.** The dispatcher (`messagesDispatched`) turns a queued message into **`blocked` with the reason `provider_not_enabled`, which is final** (code: `finishBlocked`; only `queued` messages are ever picked up). So running the dispatcher while a provider write switch is still off does not leave messages waiting: it burns them, customers get no answer, and turning the switch on later does not release them (a person can use "Send again" in the inbox). The same tick also runs `repliesChecked` and `followUpsPrepared`, which make **model calls and charge usage** for each pending conversation. Therefore: keep `messagesDispatched`, `repliesChecked` and `followUpsPrepared` out of the first activation steps (section 5), and switch each provider on, supervised, before its dispatcher runs.
3. **`calendarWriteBack` and `calendarBusySync`** touch customers' real calendars as soon as any are connected. `CALENDAR_SYNC_DISABLED=true` is the off switch.
4. **No per-job switch** (section 1): the whole list starts together. This is the reason for `SCHEDULER_JOBS_ONLY`.
5. **Database load**: 53 jobs every minute or two. The inbox's share is small; the Studio rehearsal and the new tick rehearsal run the real list on synthetic data without failures, but real concurrency on hosted Postgres is unmeasured (staging).
6. A tick that overlaps the next is harmless (lease, idempotent jobs), and a stopped scheduler opens a critical incident after `SCHEDULER_STALE_MINUTES` (20).

## 5. Staged activation (needs your approval at each step)

`SCHEDULER_JOBS_ONLY` (new, default unset = all jobs) names the jobs a tick may run, comma separated; a name that does not exist makes the tick fail loudly instead of running the wrong set. Suggested order, each step on its own approval and
read-only watch of `worker_job_runs` and the health page:

1. **Housekeeping and recovery only:** `expiredReservations, approvalExpiry, bookingHolds, aiWorkRecovery, crmWorkflowRecovery, setupEvidence, studioEntitlementSweep, aqiTutorialEventRetention, aqiOperationsRetention`.
2. **The inbox** (once workspace W1 is on): add `inboxAttention, crmEventDispatch, crmWorkflowRuns`.
3. **Notices and checks:** add `notificationEmails` only after confirming `EMAIL_PROVIDER` and who would be emailed; `incidentChecks, incidentEscalations, websiteHealth, fairUseChecks`.
4. **The rest of the CRM and messaging jobs** with each provider write switch decision made separately: `messagesDispatched, repliesChecked, followUpsPrepared, appointmentReminders, retentionPrograms, crmCampaigns, crmWebhookDeliveries, the calendar jobs`, then unset `SCHEDULER_JOBS_ONLY`.
5. **Social media** (once migration 0089 is applied and a Meta app exists; see the go-live checklist in `docs/roadmap/phases-3-to-7/blockers.md`): add `socialCleanup` first, then `socialAccountHealth, socialMetrics`, and `socialPublisher` last. With `META_SOCIAL_WRITES_ENABLED` unset the publisher cannot post to a real account whatever the list says.

## 6. Evidence

* `tests/automation-studio-scheduler-rehearsal.test.ts` (Studio stream): the real endpoint, the real job list, simulated clock, two workspaces.
* `tests/unified-inbox-tick.test.ts` (this pass): the same endpoint and list; notices only where the new inbox is on, none emailed or queued for email, a queued reply blocked with no network call, repeated ticks quiet, and a "went quiet" workflow announced, dispatched and completed in the same tick.
* `tests/unified-inbox-scheduler.test.ts`: one workspace's failure does not silence the others; fair reads across workspaces; the retry catches the failed workspace up without repeating anyone.
* Not covered: a real scheduler host, real providers, hosted concurrency.
