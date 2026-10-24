# Scheduler: what would run if it were switched on

An impact assessment for the founder's gate ("do not enable production scheduler jobs without an impact assessment and explicit approval"). Written 2026-10-22 from the code on
`integrate/unified-inbox-workforce`, the runbook [../production-scheduler.md](../production-scheduler.md) and tests. **Nothing was run against production, and the scheduler is not enabled anywhere.**
What I could not read from here (and you or I must re-read, read-only, before any approval) is marked **verify**.

## 1. Where it stands

* `POST` or `GET /api/internal/tick` exists. It needs **two** switches: `CRON_SECRET` (24+ characters, bearer token) and `SCHEDULER_ENABLED=true`. As of 2026-10-20 production had neither, `worker_job_runs` had no `tick` row (the scheduler
  has never run), no cron is configured, and every provider write switch was `false` (**verify**: re-read before relying on any of this).
* One tick runs **all 70 registered jobs in order** (45 when this was first written on 2026-10-22; section 2g covers the eight added by 2026-10-23 and section 2h the twelve Wave 1 jobs added since), each isolated (a failure in one is recorded and the rest still run), with a heartbeat per job and a tick lease so overlapping calls do nothing. Slow jobs declare `everyMinutes` and are skipped between slots.
* **There is no per-job switch.** Today "enable the scheduler" means "start all 70 jobs". Only some jobs have their own feature switch (listed below). This pass adds one (`SCHEDULER_JOBS_ONLY`, section 5) so activation can be staged job by job; it is
  unset (all jobs) unless someone sets it.

## 2. The 70 jobs, by what they can do

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

### 2h. Added since (2026-10-24): Wave 1, proposals, signing, customer invoices and payments, reputation

Twelve jobs, none of which has ever run live. Six need a Super Admin to have switched the module on for the workspace (`/admin/module-rollout`; absent means off): `proposalExpiry`, `esignSync`, `reviewRequestBatches`, `reviewSync`, `invoiceOverdueSweep` and `invoiceReminders`. Three follow only the workspace's own Reviews setting: `feedbackSla`, which is **on** by default, and `appointmentOutcomeNudge` and `renewalReminders`, which are off by default. Three read no workspace switch and work for every workspace: `proposalHousekeeping`, `reputationRetention` and `customerPaymentReconcile` (money that arrived is recorded whatever a switch says). Details: [../production-scheduler.md](../production-scheduler.md) (sections "The 12 Wave 1 jobs at a glance", "Time budget of a tick", "Wave 1 switches, emergency stops and limits", and one section per group of jobs). Two of these belong with 2a, the jobs that can message customers: `reviewRequestBatches` and `invoiceReminders`.

"Customers" says whether the job can cause a message to a customer; "Provider" whether it can call a payment, signing or review service. "In a staged start" gives the step of section 5.6 the job belongs to.

| Job | Slot | What it does | Customers | Provider | Safeguard that holds today | In a staged start |
| --- | --- | --- | --- | --- | --- | --- |
| `proposalExpiry` | 60 min | Closes sent proposals past their valid-until date (in the workspace's own calendar), warns the owner two days ahead | No | No | Internal; only proposals-enabled workspaces that are not suspended, archived or paused | Internal (6a) |
| `proposalHousekeeping` | 1440 min | Deletes spent emailed-code challenges and sessions a day after they ended, and the outbox copy of a code email an hour after it was made | No | No | Housekeeping; reads no workspace switch | Internal (6a) |
| `esignSync` | tick | Hands queued signing requests to the client's own signing service, reads answers, fetches signed copies, withdraws what was withdrawn, checks each connection's key; 25-second budget | Indirectly: the signing service, not iAcquire, emails the signer when a request is handed over | Yes: writes only while `ESIGN_WRITES_ENABLED=true`; reads (key check, status, signed copy) for any working real connection whatever that switch says | Needs both the proposals and signing switches and a working connection; the simulated service reaches nothing and is refused in production | Provider (6b), after `ESIGN_WRITES_ENABLED` is its own decision and a sandbox test has been run |
| `feedbackSla` | 15 min | Tells the team about low private feedback nobody acknowledged in the workspace's time, once per item | No | No | Internal; never names what the customer wrote; follows the workspace's own setting, which is on by default | Internal (6a) |
| `appointmentOutcomeNudge` | 1440 min | Tells the owner how many finished appointments have no recorded outcome | No | No | Off by default per workspace; counts and announces, changes nothing | Internal (6a) |
| `reviewRequestBatches` | tick | Asks customers of an **owner-approved** review request batch at the batch's pace (at most 5 batches a tick, 200 customers looked at per batch) | Yes: it asks customers | No (only through the message providers) | Only batches the owner approved, only with the `reputation_batches` switch on; every ask goes through consent, opt-outs, cool-down, a person's hold, quiet hours and credits; the dispatcher sends it in the same tick, and a provider write switch that is off blocks it | Customers (6c). Not to be named in a staged start until the founder approves that stage |
| `reviewSync` | 60 min | Reads the public reviews of connected review sites into the mirror, and checks replies whose result was lost; 60-second budget | No | Yes: reads only, and a real Google or Facebook site is not asked while its switch is off (`GOOGLE_BUSINESS_API_APPROVED`, `META_REVIEWS_ENABLED`) | Never posts a reply | Provider (6b), after the site's switch is decided |
| `renewalReminders` | 1440 min | One internal task and notice for the team when a retention account's renewal is 30, 14 or 7 days away | No | No | Off by default per workspace; writes nothing to the customer | Internal (6a) |
| `reputationRetention` | 1440 min | Clears finished sign-in states and deletes old mirrored reviews and finished reply history in bounded batches (500 of each kind a run) | No | No | Housekeeping; reads no workspace switch; the periods are proposals for the product owner to confirm | Internal (6a) |
| `customerPaymentReconcile` | 15 min | Applies payment deliveries that were received and never finished, closes unpaid checkouts, reads open checkouts back from the provider, checks each connection's key daily; 30-second budget | No | Yes: reads only, and only while `CUSTOMER_PAYMENTS_WRITES_ENABLED=true` | The simulated provider reaches nothing; reads no workspace switch | Provider (6b). Not to be named in a staged start until the founder approves that stage |
| `invoiceOverdueSweep` | 60 min | Notes an unpaid invoice past its due date: one history line, one notice to the owner, one announcement per invoice and due date | No | No | Sends nothing to anyone | Internal (6a) |
| `invoiceReminders` | 15 min | Hands reminders that have come due to the consent-gated send chain (scope `billing`) | Yes: through the consent chain | No | Does nothing until the owner authorizes the exact wording; consent, opt-outs, quiet hours, a hold and credits apply; never sent more than a day late; registered after the dispatcher, so the message goes out on the next tick | Customers (6c). Not to be named in a staged start until the founder approves that stage |

### 2i. Added since (2026-10-24): the prospect demo

Two jobs, both internal housekeeping for the prospect demo ([../demo-funnel.md](../demo-funnel.md)). Neither messages anyone (customers: no), calls a provider (provider: no) or reads the demo switches: what prospects already have is kept in step whether the demo is open or not. Both are dormant on an installation where nobody ever asked for a demo, both have a time budget (15 and 30 seconds, one constant each in `src/server/demo/jobs.ts`), and both belong in the internal step of a staged start (6a). They are listed as bullets, not as rows of the Wave 1 table above, because they are not Wave 1 jobs.

* `demoExpiry` (every 15 minutes): records the end of demo windows that ended (access is decided from the clock whenever a prospect is read, so a late job never gives anyone time), gives back chat messages whose process died, deletes spent links and ended sessions a day after they ended, and deletes the outbox copy of each demo link email an hour after it was sent (the link is in its text). Safeguard that holds today: housekeeping, reads no switch, at most 200 prospects and 200 messages a run.
* `demoRetention` (every 1440 minutes): deletes people who never confirmed their address after 7 days, erases the details and conversation of prospects whose demo ended (or who last visited) longer ago than the retention period in the demo settings (proposal: 90 days), and drops daily counters older than a year; a converted or blocked prospect is left alone. Safeguard that holds today: erases only, reads the retention period from the settings, 200 prospects a pass within the budget.

### 2j. Added since (2026-10-24): staff Messages

One job, internal housekeeping for the agency's own team chat ([../staff-messages.md](../staff-messages.md)).

* `staffMessagesMaintenance` (every 60 minutes, a 20-second budget, one constant in `src/lib/staff-messages/limits.ts`): removes files staged in the composer and never sent after a day, finishes removing the stored files of deleted messages, takes people who are no longer on the agency team (disabled, or no longer an agency account) out of their conversations, and deletes messages older than the retention period **only if a Super Admin chose one** (none by default). Customers: no. Provider: no. Safeguard that holds today: it does nothing at all while a Super Admin has the module switched off (the default, `org_features` `staff_messages`), reads no environment switch, and works in batches of 100 within its budget. It belongs in the internal step of a staged start (6a).

### 2k. Added since (2026-10-24): maintenance plan renewals

One job, about iAcquire's own maintenance plan ([../billing-and-entitlements.md](../billing-and-entitlements.md)), not a client's invoices.

* `maintenanceRenewalSweep` (every 360 minutes, a 30-second budget, one constant in `src/lib/billing-renewal.ts`): seven days and one day before the day an active plan is paid through, the team and the client's owners get one reminder each (a notice key per plan, level and paid period); when that day has passed with no payment recorded the team is told once; and **only if a Super Admin switched "mark past due automatically" on (it is off)** a plan whose paid period ended two or more days ago is marked past due as the system, with the same disclosed grace period (`STUDIO_PAYMENT_GRACE_DAYS`, 7 days) a person's record starts. It also closes pending checkouts nobody completed for 48 hours (a payment that arrives for one later is still recorded). Customers: no message of its own (it creates in-app notices; the `notificationEmails` job emails a warning-level one, such as the one-day reminder, like any other notice when `EMAIL_PROVIDER` is not `capture`). Provider: no. Safeguard that holds today: it never pauses, expires, refunds or revokes anything, never says a payment was detected, skips suspended and archived workspaces, and works in pages of 100 within its budget. It belongs in the internal step of a staged start (6a).

### 2l. Added since (2026-10-24): custom project reviews

One job, internal, about the iAcquire team's own review tasks on custom projects ([../custom-projects.md](../custom-projects.md)).

* `projectReviewOverdue` (every 15 minutes, a 20-second budget, `PROJECT_REVIEW_OVERDUE_BUDGET_MS` in `src/server/projects/jobs.ts`): a review task (the first look at a request, a reply owed, a quote to prepare) that went past its time is announced to the team once. It tells the person the project is assigned to when they still work on that client and may see projects, and otherwise the team members who manage that client's projects; the task is then marked, so it is never announced again however long it stays open (the notice key is the task and its due time). The notice names the project and the client and repeats nothing a client wrote. Workspaces that are suspended or archived and projects that are cancelled or completed are skipped, no more than ten tasks of one workspace are taken in a pass, and it stops at its budget and leaves the rest for the next run. Customers: no. Provider: no. Safeguard that holds today: it changes no task, writes no client notice and reads no environment switch. It belongs in the internal step of a staged start (6a).

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
5. **Database load**: 70 jobs every minute or two. The inbox's share is small; the Studio rehearsal and the new tick rehearsal run the real list on synthetic data without failures, but real concurrency on hosted Postgres is unmeasured (staging).
6. A tick that overlaps the next is harmless (lease, idempotent jobs), and a stopped scheduler opens a critical incident after `SCHEDULER_STALE_MINUTES` (20).
7. **The tick's 120 seconds can be oversubscribed.** Six jobs wait on outside services under their own budgets: `reviewSync` 60 seconds, `socialPublisher` 20, `socialAccountHealth` 20, `socialMetrics` 40, `esignSync` 25 and `customerPaymentReconcile` 30, which come to 195 seconds if every one had work in the same tick. Five of them are registered before `messagesDispatched` (165 seconds), so in that worst case the dispatcher would wait for the next tick, and a tick that the host stops at 120 seconds keeps its lease for five minutes. With nothing connected each finds nothing to do and spends nothing. **Not measured**: read from the code; see [../production-scheduler.md](../production-scheduler.md), "Time budget of a tick".
8. **`ESIGN_WRITES_ENABLED` is a write switch only.** `esignSync` checks the key of any working real signing connection every six hours whatever it says (and connecting a key checks it with the service), so a connected PandaDoc account is called even with the switch off.

## 5. Staged activation (needs your approval at each step)

`SCHEDULER_JOBS_ONLY` (new, default unset = all jobs) names the jobs a tick may run, comma separated; a name that does not exist makes the tick fail loudly instead of running the wrong set. Suggested order, each step on its own approval and
read-only watch of `worker_job_runs` and the health page:

1. **Housekeeping and recovery only:** `expiredReservations, approvalExpiry, bookingHolds, aiWorkRecovery, crmWorkflowRecovery, setupEvidence, studioEntitlementSweep, aqiTutorialEventRetention, aqiOperationsRetention`.
2. **The inbox** (once workspace W1 is on): add `inboxAttention, crmEventDispatch, crmWorkflowRuns`.
3. **Notices and checks:** add `notificationEmails` only after confirming `EMAIL_PROVIDER` and who would be emailed; `incidentChecks, incidentEscalations, websiteHealth, fairUseChecks`.
4. **The rest of the CRM and messaging jobs** with each provider write switch decision made separately: `messagesDispatched, repliesChecked, followUpsPrepared, appointmentReminders, retentionPrograms, crmCampaigns, crmWebhookDeliveries, the calendar jobs`, then unset `SCHEDULER_JOBS_ONLY`.
5. **Social media** (once migration 0089 is applied and a Meta app exists; see the go-live checklist in `docs/roadmap/phases-3-to-7/blockers.md`): add `socialCleanup` first, then `socialAccountHealth, socialMetrics`, and `socialPublisher` last. With `META_SOCIAL_WRITES_ENABLED` unset the publisher cannot post to a real account whatever the list says.
6. **Wave 1** (once migrations 0091 to 0095 are applied and a Super Admin has switched a module on for a workspace; see the go-live notes in `docs/invoices-and-payments.md`, `docs/esignature.md` and `docs/voice-and-reviews.md`), in three steps of its own, each on its own approval:
   * **6a, internal:** `proposalExpiry, proposalHousekeeping, feedbackSla, appointmentOutcomeNudge, renewalReminders, reputationRetention, invoiceOverdueSweep`. They tell the team and delete what is spent; they contact nobody. (`feedbackSla` is on by default for an active workspace that has low private feedback, and `proposalHousekeeping` and `reputationRetention` work for every workspace.)
   * **6b, providers:** `reviewSync`, `esignSync` and `customerPaymentReconcile`, each only after its own environment switch is a decision and its sandbox or test-account run has happened. `customerPaymentReconcile` is not named until the founder approves that stage.
   * **6c, customers, last:** `reviewRequestBatches` and `invoiceReminders`, each after the provider write switches for its channels have been decided, and not until the founder approves that stage.

   None of the twelve is in a stage that was approved before they existed.

## 6. Evidence

* `tests/automation-studio-scheduler-rehearsal.test.ts` (Studio stream): the real endpoint, the real job list, simulated clock, two workspaces.
* `tests/unified-inbox-tick.test.ts` (this pass): the same endpoint and list; notices only where the new inbox is on, none emailed or queued for email, a queued reply blocked with no network call, repeated ticks quiet, and a "went quiet" workflow announced, dispatched and completed in the same tick.
* `tests/unified-inbox-scheduler.test.ts`: one workspace's failure does not silence the others; fair reads across workspaces; the retry catches the failed workspace up without repeating anyone.
* `tests/docs-scheduler.test.ts` (2026-10-24): this inventory names every job in the registry, the count in this document and in the runbook equals the registry's, and section 2h lists the twelve Wave 1 jobs with the slot the registry gives, whether each can message customers or reach a provider, and its step in section 5.6. The six time budgets and their sum (risk 7) are computed from the constants in the code.
* `tests/docs-modules.test.ts` (2026-10-24): every file, folder and link this document names exists, and every switch it names is a real environment variable.
* Not covered: a real scheduler host, real providers, hosted concurrency.
