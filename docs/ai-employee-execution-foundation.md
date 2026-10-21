# AI employee execution foundation and Lead Hunter activation

Status: **implemented and verified locally; migration not deployed; no production configuration, activation or
provider run was performed.** Lead Hunter reaches a genuine 6/6 in an isolated agency workspace against the
Hermes test double, and then completes a real sandbox research job through the same persisted path the product
uses. An AI Work Board and a person-triggered, read-only Operations Manager review now sit on the same durable
job foundation. Production activation remains behind the explicit approval checkpoint at the end of this page.

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

The production Lead Hunter still needs its actual field values (industry, geography, ideal customer, services)
saved in the iAcquire agency workspace. Those facts are not in the repository and must come from the business.

## 2. Durable AI work jobs

Migration `0072_ai_work_jobs.sql` adds:

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
| `tests/work-job-progress.test.tsx` | 4 passed — running/completed/failed/queued honest rendering, no percentage, no invented progress |
| `tests/workforce-proactive-review.test.ts` | 6 passed — capability allowlists, role/permission refusal, unconfigured employee refusal, eight real findings, unchanged business records, notification, tenant-scoped work board, role-boundary block |
| `tests/work-board-ui.test.tsx` | 5 passed — persisted status/metrics, on-demand review action, capability selector, unavailable-employee explanation, activity expansion, failed review evidence |
| `tests/workforce-review-capabilities.test.ts` | 6 passed — CRM quality, pipeline, appointment and performance reviews produce real findings/measured KPIs; business records unchanged; role and workforce-permission refusals |
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
| Company facts (description, services, ideal customers, operating area) | **0/4 present** |

1. **Migration 0072 is not applied to the hosted database.** Deploying/authorizing the migration is required
   before any durable job exists in production.
2. **Lead Hunter has no applied configuration in production.** The agency workspace must save the complete
   role configuration through Configure. The role-owned procedure fields are prepared; these company-owned
   facts are genuinely missing and must come from the business: business description, products/services, ideal
   customers and operating area. The employee must not invent them.
3. **Production Hermes profile activation is a guarded change.** The exact existing process must be used:
   apply configuration → health check with complete inventory → agency profile check → Super Admin Full Hermes
   Capabilities acknowledgement. No readiness score may be written directly.
4. **Do not apply migration 0072, save production configuration, run a live research job or enable the worker
   without explicit authorization.** These are the approval boundary for this slice.

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

The on-demand Operations Manager review (`src/server/workforce/proactive-review.ts`) reads eight
persisted signals: failed runs, approvals pending over a day, overdue tasks, leads waiting for
review, employees needing attention, degraded integrations, failed/blocked AI jobs and recent
contacts with no email or phone. Each finding records its count, examples, evidence link and
recommended next action. It does not change a business record, create an approval on the employee's
behalf, contact a provider or create a recurring schedule. A person starts it from the Work Board.

## 9. Exact next action after authorization

Apply migration 0072 to the hosted project, deploy the application, save the Lead Hunter configuration in the
iAcquire agency workspace, run the health check and profile check, record the Super Admin acknowledgement, then
run the read-only activation audit and one supervised research job. Only after that run should the job/evidence
UI be described as production-proven.
