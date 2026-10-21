# AI employee execution foundation and Lead Hunter activation

Status: **implemented and verified locally; migrations 0077–0080 applied to the hosted database on
2026-10-21 after a backup; application deployment and production configuration are pending; no automation
or provider run was activated.** Lead Hunter reaches a genuine 6/6 in an isolated agency workspace against the
Hermes test double, and then completes a real sandbox research job through the same persisted path the product
uses. An AI Work Board and person-triggered, read-only reviews for the Operations Manager, CRM Manager,
Sales Assistant, Appointment Setter and Performance Analyst sit on the same durable job foundation.
Tenant-scoped schedules and event triggers exist but are each disabled by two independent switches
and have not been activated. Production activation remains behind the explicit approval checkpoint at
the end of this page.

## 1. Lead Hunter configuration

- `src/lib/role-playbooks.ts` provides a complete, valid role starting point for the Lead Hunter and the other
  five roles. It fills procedural fields only; the client's ideal customer, services, operating area, prices and
  policies stay blank because the product must not invent them.
- The Configure screen shows a **Role setup check** with every role field and the company facts that are still
  needed, plus **Fill blank fields**. The action only fills blank role fields and still saves through the existing
  server-side review/apply path. It never overwrites a saved answer and never fills company facts.
- `src/server/workforce/policy.ts` adds a server-owned Lead Hunter operating standard (research procedure,
  evidence rule, qualification, public decision-maker limits, duplicates, prohibited actions, approvals,
  escalation, error recovery, collaboration and honest reporting). It is compiled after the client's
  configuration and before the immutable agency policy, so client text cannot remove it.
- `POLICY_VERSION` moved to `2026-10-21.1` so the changed compiled instructions have a real version.

The internal iAcquire business facts are now supplied and recorded in
`src/lib/internal-business-profile.ts` (business description, products/services, ideal customers and
operating area), with configurable initial prospecting defaults (industries, United States geography
and Canada only when explicitly approved). They are a fallback for the **agency workspace only**; a
confirmed saved value wins, and a client tenant never receives them. The local agency profile was
filled with the empty-only script and now reports **4/4 company facts**. Production remains **0/4**
because no production write has been authorized.

## 2. Durable AI work jobs

Migration `0077_ai_work_jobs.sql` adds:

| Table | Purpose |
| --- | --- |
| `ai_work_jobs` | Durable job, real status (`queued`, `running`, `waiting_for_approval`, `blocked`, `failed`, `cancelled`, `completed`), stage, progress, input/result, attempts, idempotency key, lease and cancellation request |
| `ai_work_events` | Append-only stage/progress/notice/error/evidence events; the only source for progress UI |

`chat_messages.work_job_id` links a chat turn to its job. `lead_research_requests.work_job_id` links the existing
request/review contract to the shared job. `leads.duplicate_matches` stores the actual matching CRM/lead records,
and `leads.public_contact` may hold only public business contact details that a cited source states.

`src/server/workforce/jobs.ts` owns creation, claims, heartbeats, stage/progress events, finish, cancel, retry,
tenant-scoped views and crash recovery. Client roles get `SELECT` under `agents.use`; every write is server-side
after an explicit authorization check. A composite foreign key prevents attaching a job to another tenant's
employee.

## 3. Real Lead Hunter research

The existing `lead_research_requests` and `leads` review queue are reused. A request now creates one durable job.
`src/server/leads/research-job.ts` executes it:

1. load the applied configuration and connection; refuse honestly if either is missing;
2. create the `agent_runs` row and pass through the shared `startAgentRun` readiness/inventory gate;
3. stream real Hermes events and persist a stage only when a tool event or server-side work happened
   (`searching`, `reviewing`, `extracting`, then `qualifying`, `checking_duplicates`, `preparing_results`,
   `completed`);
4. count only completed, non-error `web_search` and `web_extract` events;
5. validate the JSON contract, discard public contact data without a cited source, check the tenant's existing
   leads and native CRM companies for domain/name duplicates, score the evidence, and persist candidates with
   their match details;
6. update the request, notify reviewers and finish the job with the real counts and limitations.

Cancellation writes `cancel_requested_at`, signals the in-process runner and calls Hermes `stop`; a cancellation
that arrives from another process is detected at the next safe check. Retries are explicit and bounded by
`max_attempts`; crash recovery re-queues a lost lease only while attempts remain, otherwise marks it failed with
`worker_lost`. A persistence failure marks the job failed and never claims success.

## 4. Chat and progress UI

- A Lead Hunter chat message that parses as a research assignment (`src/lib/research-intent.ts`) creates the same
  durable job. Missing target/location/quantity produces a focused question instead of a guessed assignment.
  Ordinary conversation still goes to the normal Hermes chat path.
- `WorkJobPanel` polls the permission-checked `/api/work/jobs/[id]` endpoint and renders only persisted status,
  stage, counts, elapsed time and events. It has honest queued/running/failed/cancelled/completed states, no
  invented percentage or ETA, cancel/retry controls with server checks, and a review link only when leads exist.
- Chat and the Leads workspace show the real job stage. The full panel appears for a new request and in the chat
  turn that created it.

## 5. Worker and recovery

- `scripts/workforce-worker.ts` (`npm run workforce:worker`) is the dedicated process for queued jobs. It is
  disabled unless `WORKFORCE_WORKER_ENABLED=true`; `--once` performs one bounded local batch.
- The scheduler tick now includes a fast `aiWorkRecovery` sweep every five minutes. It never runs a provider
  call inside the tick. The scheduler itself remains disabled in production, so no autonomous processing is
  switched on by this work.
- Normal requests still start immediately in the web process. If that process dies, the job remains visibly
  queued/running until the worker or recovery sweep handles it; it is never reported as completed.

## 6. Verification (local, 2026-10-21)

| Check | Result |
| --- | --- |
| `tests/workforce-role-playbooks.test.ts` | 7 passed — recommended settings, company-fact separation, compiled operating standard, no cross-role leakage |
| `tests/research-intent.test.ts` | 6 passed — canonical assignment, missing-field questions, no false positives, quantity cap |
| `tests/workforce-jobs.test.ts` | 10 passed — real stages/counts, chat-created job, duplicate detection against CRM, public contact privacy, cancellation, retry, tenant isolation, unreviewed capability refusal, member cancel refusal, idempotency, lease recovery |
| `tests/lead-hunter-activation.test.ts` | 2 passed — applied configuration + health + profile check + Super Admin acknowledgement produces **6/6 ready**, then a real sandbox research job completes with source-backed leads and a completed `lead_research` run |
| `tests/work-job-progress.test.tsx` | 7 passed — running/completed/failed/queued honest rendering, real availability, measured comparisons, finding-to-task action, no percentage, no invented progress |
| `tests/workforce-proactive-review.test.ts` | 6 passed — capability allowlists, role/permission refusal, unconfigured employee refusal, eight real findings, unchanged business records, notification, tenant-scoped work board, role-boundary block |
| `tests/work-board-ui.test.tsx` | 7 passed — persisted status/metrics, on-demand review action, capability selector, unavailable-employee explanation, activity expansion, failed review evidence |
| `tests/workforce-review-capabilities.test.ts` | 8 passed — CRM quality, pipeline, appointment and performance reviews plus real calendar availability and an idempotent finding-to-task action; business records unchanged; role and workforce-permission refusals |
| `tests/workforce-schedules.test.ts` | 5 passed — disabled by default, operator-switch gate, real due job, no duplicate while active, member/capability refusals, enable/pause/delete and audit evidence |
| `tests/workforce-triggers.test.ts` | 5 passed — paused by default, operator gate, one job per new event, no repeat, no replay on enable, refusals and audit evidence |
| `tests/lead-hunter-business-context.test.ts` | 6 passed — agency-only fallback, confirmed-value precedence, client-owned facts, empty-client ask/block, compiled-instruction isolation and research-prompt isolation |
| `tests/workforce-proactive-delivery.test.ts` | 11 passed — report publication and supervisor delivery, idempotency, severity thresholds, critical bypass, quiet-hours hold/release, tenant isolation, opt-in task creation, monitoring state and briefing dedupe |
| `tests/workforce-lead-generation.test.ts` | 3 passed — Lead Hunter-only allowlist, five persisted generation checks, saved-target recommendation, no provider run or business-record change, wrong-role refusal |
| `tests/workforce-schedule-windows.test.ts` | 5 passed — outside-hours postponement, in-hours execution, invalid windows, real scheduled research request/job and incomplete-assignment refusal |
| Existing focused regressions | `chat`, `modules`, `hermes-run-gate` (17), `hermes-activation-sequence`, `workforce-readiness`, `chat-workspace-ui` passed after the changes |

The test gateway is the repository's Hermes test double. It is not a live AI and no external research, outreach,
CRM import or production data write took place.

## 7. Production blockers and approval checkpoint

A read-only production audit was run on 2026-10-21 with `scripts/lead-hunter-readiness-audit.ts --live`. It
performs only `SELECT` queries and changed nothing. Result:

| Evidence | Production value |
| --- | --- |
| Readiness | **0/6 — Setup required**, chat unavailable |
| Applied configuration | none |
| Last health check | exists, but `last_health_ok = false` because no configuration is applied |
| Runtime inventory | 6 reviewed tools across 5 toolsets; digest recorded (the run gate still refuses without an applied configuration) |
| Saved credential | current |
| Identity check current | false |
| Super Admin acknowledgement current | false |
| Company facts (description, services, ideal customers, operating area) | **0/4 present** (approved facts exist in the repository fallback; production not written) |

1. **Migrations 0077, 0078, 0079 and 0080 are applied to the hosted database** (2026-10-21, after a custom-format
   backup). The read-only preflight reports all four applied, no prefix collisions and every expected table/column
   present. The application deployment that reads them is still pending.
2. **Lead Hunter has no applied configuration in production.** The agency workspace must save the complete
   role configuration through Configure. The approved iAcquire facts now exist in the repository and can be
   written with `scripts/apply-internal-business-profile.ts --apply`; production still needs that authorized
   write, and the configuration must then be applied and checked.
3. **Production Hermes profile activation is a guarded change.** The exact existing process must be used:
   apply configuration → health check with complete inventory → agency profile check → Super Admin Full Hermes
   Capabilities acknowledgement. No readiness score may be written directly.
4. **Do not deploy/activate automation, save production configuration, run a live research job or enable the
   worker without the remaining release approval.** Migrations are the only production write performed here.

The Hermes six-tool whitelist was not changed. No MCP, Tool Search, filesystem, database, browser or general API
access was enabled. No autonomous schedule was activated.

## 8. AI Work Board and on-demand proactivity

The AI Work Board (`/work`, linked from the AI Employees navigation) reads only persisted
`ai_work_jobs`/`ai_work_events`. It shows real status, stage, counts, latest recorded activity and
result/failure summaries, with filters for active, attention and completed work. A member sees only
work they requested; an owner or admin with `activity.view` sees the workspace queue. The board never
shows a synthetic percentage or an activity the worker did not record.

`src/lib/workforce-capabilities.ts` is the reviewed capability allowlist:

| Capability | Allowed role | Caller permission | Risk |
| --- | --- | --- | --- |
| `lead_research` | Lead Hunter | `leads.research` | read-only research; imports/outreach remain separate approvals |
| `proactive_review` | Operations Manager | `activity.view` | read-only review; no record writes, no provider calls, no schedule |
| `crm_quality_review` | CRM Manager | `contacts.view` | read-only data-quality review |
| `pipeline_review` | Sales Assistant | `sales.view` | read-only pipeline hygiene review |
| `appointment_review` | Appointment Setter | `appointments.view` | read-only booking-risk review |
| `appointment_availability` | Appointment Setter | `appointments.view` | real bookable slots; no hold, booking or provider write |
| `performance_snapshot` | Performance Analyst | `analytics.view` | measured KPIs plus only stated-threshold anomalies |

`src/server/workforce/capability-dispatch.ts` resolves the employee in the caller's own workspace,
requires `agents.use` plus the capability's permission, checks the role allowlist, refuses an
unavailable or unconfigured employee, creates the durable job and records a
`workforce.capability_dispatched` audit event. A capability without a registered handler becomes an
honest blocked job.

The Work Board offers one selector for the read-only reviews whose employee is actually available.
The Lead Hunter's research is not startable there because it needs a target, location and quantity
from the person first.

The CRM, pipeline, appointment and performance reviews share
`src/server/workforce/read-only-review.ts`. Each reads only that workspace's persisted records, writes
stage/evidence events, finishes with findings, examples, evidence links and recommended actions, and
notifies the owner/admin. The performance snapshot also returns measured KPIs with a period,
definition and source; its only anomaly thresholds are stated in the finding text. None of these
reviews changes a record, contacts a provider or creates a schedule.

`appointment_availability` reuses the existing native booking availability service
(`nativeAvailability`) rather than a second slot algorithm. It returns the real bookable start/end
times and time zone, or the exact reason the calendar cannot offer slots. It never holds a slot,
creates a booking or writes to an external calendar.

The performance snapshot also measures the immediately preceding 30-day period for comparable KPIs
and returns the previous value, absolute change, percentage change and trend. The UI colours a trend
using the metric's `higherIsBetter` flag, so an increase in failed runs is not shown as positive.
Pending/open/upcoming counts remain current-state values with no comparison.

The on-demand Operations Manager review (`src/server/workforce/proactive-review.ts`) reads nine
persisted signals: failed runs, approvals pending over a day, overdue tasks, leads waiting for
review, employees needing attention, degraded integrations, failed/blocked AI jobs, blocked work
spanning more than one employee, and recent contacts with no email or phone. Each finding records
its count, examples, evidence link and recommended next action. It does not change a business record,
create an approval on the employee's behalf, contact a provider or create a recurring schedule. A
person starts it from the Work Board.

## 9. Scheduled reviews (implemented, not activated)

Migration `0078_ai_work_schedules.sql` adds tenant-scoped `ai_work_schedules`: one reviewed,
read-only capability per employee, a cadence (hourly/daily/weekly), a next-run time, last-run time
and last job. The Work Board can save a schedule (always paused first), enable or pause it, and
delete it; every change is audited.

A schedule can only create work when **both** switches are on:

1. the schedule row is `enabled`;
2. the operator has set `WORKFORCE_SCHEDULES_ENABLED=true`.

The scheduler tick calls `runDueSchedules`. It creates a durable `ai_work_jobs` row, records a
notice event, updates the next run and wakes the worker. It never runs provider work inside the
tick. If the previous scheduled job is still active, the run is skipped rather than duplicated.
The operator switch is absent/false in production, so **no schedule is active**.

`tests/workforce-schedules.test.ts` covers: disabled by default, no run without the operator
switch, a real due job created only when both switches are on, no duplicate while a prior job is
active, member refusal, non-review capability refusal, enable/pause/delete and audit evidence.

## 10. Event-driven triggers (implemented, not activated)

Migration `0079_ai_work_triggers.sql` adds `ai_work_triggers`. Only these reviewed exceptional
events are accepted:

| Event | Capability |
| --- | --- |
| `appointment.cancelled` | Appointment review |
| `appointment.no_show` | Appointment review |
| `opportunity.lost` | Pipeline review |

A trigger only creates a job when **both** the row is enabled and
`WORKFORCE_TRIGGERS_ENABLED=true`. The scheduler tick reads the next matching `crm_events` row past
the trigger's `last_event_id`, creates one durable job with an idempotency key based on the trigger
and event, advances the cursor and wakes the worker. It never runs provider work inside the tick.

Enabling a trigger resets its cursor to the current latest event, so events that occurred while it
was disabled are not replayed. If the employee is unavailable, the event is skipped and the cursor
advances rather than creating a job that cannot run. The Work Board has a paused-by-default Event
triggers panel with enable/pause/delete, the operator gate and audit evidence.

`tests/workforce-triggers.test.ts` covers: paused by default, operator switch, one job per new
event, no repeat, no replay when enabled, member/unknown-event/unavailable-employee refusals, and
enable/pause/delete audit evidence.

Review notifications reuse the existing notification pipeline: per-job dedupe keys, notification
preference groups/severity filtering, and the existing non-critical email quiet-hours window
(21:00–07:00 in the recipient's time zone). Critical findings bypass quiet hours. No parallel
notification system was added.

A completed review finding can become an ordinary internal follow-up task from the Work Board
(“Create follow-up task”). The action requires `tasks.manage`, creates the task through the existing
task service (assigned to the person who clicked), records `task.created`, `workforce.finding_task_created`
audit evidence and is idempotent per job/finding. It does not send outreach or modify a customer
record, and no decorative approval button is shown for actions that have no executor.

Lead review/import approvals remain on the existing approval path; they are not replaced by this
task action.

## 11. Lead Hunter business context and tenant isolation

Lead Hunter always researches for the business that owns the employee.

- The internal `organizations.kind = 'agency'` workspace may use the approved iAcquire profile as a
  **fallback for empty fields** (`src/lib/internal-business-profile.ts`). A confirmed saved value
  always wins. The fallback includes iAcquireOS products/services, the small-service-business ideal
  customer profile, the commercial context and the configurable initial industries/geography.
- A client workspace never receives the fallback. `loadCompanyContext` returns only that tenant's
  `organizations`/`company_profiles` values; missing facts stay empty. `researchPrompt` tells the
  employee to ask instead of assuming, and the research job stops with a recorded blocker when a
  client has neither a business description nor services.
- `compileAgentConfig` adds the internal prospecting defaults only when the role is Lead Hunter, the
  workspace is the agency and no persisted target customer exists. Client targeting is limited to
  its own saved targeting and assignment.
- `researchPrompt` now begins with the owning business's name, description, services, ideal
  customers and operating area, and states that another company's profile must not be substituted.
  The internal prompt fills empty targeting with the approved industries/geography/qualification;
  the client prompt leaves them empty.
- The agency fallback is a repository constant, not a cross-tenant lookup. Research jobs, duplicate
  checks and company context are all scoped by `org_id`.

`tests/lead-hunter-business-context.test.ts` covers the agency fallback, confirmed-value
precedence, client-owned facts, empty-client refusal to assume, compiled-instruction isolation and
research-prompt isolation. Local evidence: the empty-only profile script wrote the approved internal
facts, and the readiness audit reports **4/4 company facts**, still **0/6 readiness** because no
configuration is applied, no connection check passed, no identity is current and no Super Admin
acknowledgement exists.

## 12. Proactive employee layer

The shared execution foundation now also produces verified proactive reports. All six reviewed reviews plus the new
Lead Hunter `lead_generation_review` publish an `ai_work_reports` row after they finish. A report answers what
happened, why it matters, what was verified, what action was taken, what remains blocked, what should happen next and
whether a person must approve anything.

Delivery is per supervisor: severity thresholds, quiet-hours hold/release, daily digests, deduplication by condition
and local date, and the existing notification pipeline. The only autonomous business action is an opt-in internal
follow-up task for critical reports; external and customer-facing actions still require the Approval Center. A
completed finding can also become a follow-up task through an explicit, permission-checked action.

Schedules now support local business-hour windows and can carry one exact, owner-approved Lead Hunter research
assignment. The tick creates the real `lead_research_requests` and `ai_work_jobs` rows and wakes the existing worker;
it never runs provider work itself. A separate operator switch
(`WORKFORCE_BRIEFINGS_ENABLED`, off by default) controls opt-in daily and weekly briefings.

The Work Board shows a **Proactive watch** panel with an honest monitoring state, the six duties, expandable report
cards and real acknowledgement/task actions. The employee Activity tab shows the same employee-scoped reports. When
no recurring row is enabled, both surfaces say that no monitoring is scheduled.

Full design, safety boundaries, tests and activation checkpoint: [Proactive AI employees](proactive-ai-employees.md).

## 13. Exact next action after authorization

Migrations 0077–0080 are applied. Deploy the application, apply the approved iAcquire internal profile to the
agency workspace (`scripts/apply-internal-business-profile.ts --apply` with the production authorization), save
the Lead Hunter configuration, run the health check and profile check, record the Super Admin acknowledgement,
then run the read-only activation audit and one supervised research job. Keep
`WORKFORCE_SCHEDULES_ENABLED`, `WORKFORCE_TRIGGERS_ENABLED` and `WORKFORCE_BRIEFINGS_ENABLED` false until
separate supervised activations are approved. Only after that run should the job/evidence UI be described as
production-proven.
