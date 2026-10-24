# AI employee execution foundation and Lead Hunter activation

Status: the workforce foundation and client-provisioning work are implemented locally. The 2026-10-24 read-only production ledger query found `0080`, `0081`, `0082`, `0083`, `0085` and `0086`; `0084_restricted_hermes_provisioner` is absent. Production activation remains incomplete: Zeng and Lead Hunter are 6/6; the four remaining internal employees have no applied configuration and remain unavailable. The current, authoritative snapshot is [Internal AI Workforce production preflight (2026-10-24)](internal-workforce-production-preflight-2026-10-24.md). The Hermes API still cannot attest to effective deployed SOUL instructions. No production configuration, profile, acknowledgement, worker, schedule or migration was changed by the preflight.

## 1. Lead Hunter configuration

- `src/lib/role-playbooks.ts` provides a complete, valid role starting point for the Lead Hunter and the other
  five roles. It fills procedural fields only; the client's ideal customer, services, operating area, prices and
  policies stay blank because the product must not invent them.
- The Configure screen shows a **Role setup check** with every role field and the company facts that are still
  needed, plus **Fill blank fields**. The action only fills blank role fields and still saves through the existing
  server-side review/apply path. It never overwrites a saved answer and never fills company facts.
- For a first-time internal setup, **Prepare first config** creates an unsaved role-specific draft, using the
  same safe role defaults. Unknown company details stay blank, existing configured drafts are preserved, and
  saving still goes through the guarded version/review flow.
- `src/server/workforce/policy.ts` adds a server-owned Lead Hunter operating standard (research procedure,
  evidence rule, qualification, public decision-maker limits, duplicates, prohibited actions, approvals,
  escalation, error recovery, collaboration and honest reporting). It is compiled after the client's
  configuration and before the immutable agency policy, so client text cannot remove it.
- `POLICY_VERSION` moved to `2026-10-21.1` so the changed compiled instructions have a real version.

The internal iAcquire business facts are now supplied and recorded in
`src/lib/internal-business-profile.ts` (business description, products/services, ideal customers and
operating area), with configurable initial prospecting defaults (industries, United States geography
and Canada only when explicitly approved). They are a fallback for the **agency workspace only**; a
confirmed saved value wins, and a client tenant never receives them. The local agency profile was filled with the empty-only script. The 2026-10-24 read-only production check also reports **4/4 company facts**; it did not apply any of the four missing employee configurations.

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
- Completed appointment-availability jobs show the returned slots in the workspace time zone. Appointment Setter chat can
  also prepare a short-lived preview for one exact active contact and one ISO 8601 time with a timezone offset. The preview
  checks availability without holding the slot. A separate `confirm booking` message invokes the existing booking service,
  which rechecks availability and applies employee mode, workspace booking settings and the normal approval flow. Chat
  cancellation and rescheduling remain unavailable.
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

## 6. Existing detailed verification (local, 2026-10-21)

Current focused acceptance on the isolated `codex/iacquire-workforce-completion` branch passed 13 test files (158 tests),
including the appointment handoff and persisted job progress. App and script TypeScript checks passed, ESLint passed on the changed
code, and the Next.js 16.4.2 Webpack production build completed. The default Turbopack build could not resolve dependencies
through this isolated worktree's external `node_modules` link. Production Hermes and employee activation were not part of these
local checks; see the current production preflight below.

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

The 2026-10-21 audit is superseded by the current 2026-10-24 all-six employee and live Hermes evidence, including the actual readiness, inventory, company-fact and migration state, is recorded in [the current production preflight](internal-workforce-production-preflight-2026-10-24.md). It confirms two employees at 6/6 and four at 0/6. The four recommended configurations preview complete against the saved company profile, but remain unapplied.

The production activation sequence is still guarded: apply each reviewed configuration through the existing versioned path; run profile-specific health and inventory checks; verify current profile identity; record the authorized Super Admin acknowledgement; and obtain host-side evidence for effective SOUL instructions. The existing profile IDs must be retained. Do not write readiness flags directly, start the worker, activate schedules or triggers, or run research as part of configuration setup.

The hosted application ledger includes `0081_ai_work_job_rls_hardening`, `0082_client_employee_provisioning`, `0083_unified_inbox`, `0085_missed_call_recovery` and `0086_lead_scoring`; `0084_restricted_hermes_provisioner` is absent. Local PGlite confirms 0084 applies after 0086, but it has not been applied to production. A production deployment SHA and effective SOUL attestation remain unverified, so the current application release and profile configuration cannot yet be called production-ready.

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
| `lead_generation_review` | Lead Hunter | `leads.view` | read-only coverage and backlog review |
| `proactive_review` | Operations Manager | `activity.view` | read-only review; no record writes, no provider calls, no schedule |
| `crm_quality_review` | CRM Manager | `contacts.view` | read-only data-quality review |
| `pipeline_review` | Sales Assistant | `sales.view` | read-only pipeline hygiene review |
| `pipeline_followup_drafts` | Sales Assistant | `sales.view` + `inbox.reply` | approval-required, up to five unsent neutral follow-up drafts for stale opportunities and open Sales Assistant conversations |
| `appointment_review` | Appointment Setter | `appointments.view` | read-only booking-risk review |
| `appointment_availability` | Appointment Setter | `appointments.view` | real bookable slots; no hold, booking or provider write |
| `performance_snapshot` | Performance Analyst | `analytics.view` | measured KPIs plus only stated-threshold anomalies |

`src/server/workforce/capability-dispatch.ts` resolves the employee in the caller's own workspace,
requires `agents.use` plus the capability's permission, checks the role allowlist, refuses an
unavailable or unconfigured employee, creates the durable job and records a
`workforce.capability_dispatched` audit event. A capability without a registered handler becomes an
honest blocked job.

Employee chat also routes clear requests for reviewed native workflows through
`src/lib/workforce-chat-assignment.ts`. The route persists the assistant acknowledgement with the
exact `work_job_id`, dispatches through the same role and permission checks, then kicks only that
job ID. It never drains the shared queue or invokes Hermes for a native review. Read-only review
acknowledgements state that they do not edit CRM records, send messages, book appointments or activate
monitoring. Sales follow-up drafting is the guarded exception: it creates unsent message drafts only.
Appointment booking is a separate, narrow chat action rather than a read-only job: it requires
`contacts.view`, `appointments.view` and `appointments.book`, resolves one exact contact, checks one
exact slot, stores only a short-lived proposal, and waits for explicit confirmation before calling
`requestBooking`. The confirmer is recorded on the booking, and approval copy identifies the staff
chat request accurately instead of claiming the customer initiated it. No customer conversation is
linked to the private employee chat. Cancellation and rescheduling remain unsupported.
`src/lib/workforce-chat-guardrail.ts` still refuses clear out-of-role public prospecting, outbound
communication, unsupported booking changes, approval bypasses, destructive/import CRM actions and
unsupported Operations task assignment before Hermes submission; the refusal is persisted with a
redacted audit reason. Lead Hunter's separate assignment parser still handles research requests.

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

`pipeline_followup_drafts` is a separate Sales Assistant capability. It selects stale open
opportunities linked to an open conversation still assigned to that employee, skips conversations
with another outstanding outbound draft or queued send and conversations with a sent message newer
than the inbound, and saves one deterministic, low-pressure draft per current inbound
message. The wording uses only a simple CRM first name and does not use conversation text or infer
pipeline activity. Drafts link to their Inbox conversations and record the source opportunity; they
remain unsent until a person approves them through the normal Inbox flow, which rechecks consent,
channel, quiet hours, ownership, credits and policy. The dispatcher requires `agents.use`,
`sales.view` and `inbox.reply`; the worker rechecks those caller permissions before writing.

The performance snapshot accepts either the last 30 days or the current calendar month. Calendar
month boundaries use the workspace time zone. Comparable KPIs include the matching prior period and
return the previous value, absolute change, percentage change and trend. The UI colours a trend using
the metric's `higherIsBetter` flag, so an increase in failed runs is not shown as positive.
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

Migration `0087_workforce_local_recurrence.sql` adds an optional local-time recurrence rule. New
daily and selected-weekday rules use the workspace's IANA timezone and keep their wall-clock time
across daylight-saving changes; a repeated fall-back time uses its earlier instant, while a
nonexistent spring-forward time moves to the first valid local minute. Existing hourly/daily/weekly
interval rows keep their prior behavior. New schedules still save paused, and the migration has
not been applied to hosted production. The production ledger currently lacks `0084`, so hosted
migrations remain a separately reviewed release step.

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
`tests/workforce-schedule-recurrence.test.ts` covers weekday and daily recurrence, invalid rules,
and daylight-saving gaps and overlaps. The Kanban Work Board and Schedules & Calendar are design
proposals awaiting review; their frontend implementation remains behind that review gate.

The server-side calendar data layer returns real jobs separately from sanitized schedule
definitions, scopes jobs to the requesting member or workspace Activity permission, and only returns
schedule definitions to people who can configure them. It omits saved assignment payloads and
limits requested ranges to 62 days. `GET /api/workforce/calendar` requires authenticated workspace
context, accepts timezone-aware ISO instants and returns private no-store data. The shared recurrence
helper projects a bounded half-open date range from each saved next-run anchor; projected occurrences
remain distinct from persisted jobs. Calendar endpoint, schedule-job timestamps, sanitized schedule
data, permission and tenant scope, range boundaries and invalid ranges are covered by
`tests/workforce-calendar-route.test.ts`, `tests/workforce-calendar.test.ts` and
`tests/workforce-schedule-recurrence.test.ts`.

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
facts. Current production readiness and employee-specific blockers are listed in the 2026-10-24 preflight snapshot; the company profile is complete, while the four remaining employee configurations are not applied.

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

Use the consolidated activation checkpoint in [the 2026-10-24 production preflight](internal-workforce-production-preflight-2026-10-24.md). It covers the exact release SHA, the four reviewed configuration versions, profile checks, Super Admin acknowledgements, host-side SOUL evidence, backup and rollback, and bounded acceptance. Zeng and Lead Hunter remain unchanged. Keep `WORKFORCE_SCHEDULES_ENABLED`, `WORKFORCE_TRIGGERS_ENABLED`, `WORKFORCE_BRIEFINGS_ENABLED` and `WORKFORCE_WORKER_ENABLED` false until separate supervised activations are approved. Only after the checks and approvals pass should the four employees be described as production-ready.
