# Proactive AI employees

Status (2026-10-24): **implemented and verified locally; the read-only production ledger check found 0080, 0081, 0082, 0083, 0085 and 0086 applied, with 0084 missing. The schedules, triggers, briefings and worker operator switches were false, so autonomous monitoring and work were not running. Two employees are at 6/6 readiness; the four employees without applied configurations remain unavailable.** See the [current internal workforce preflight](internal-workforce-production-preflight-2026-10-24.md). This page covers the proactive layer added on top of the existing AI employee execution foundation in
[AI employee execution foundation](ai-employee-execution-foundation.md).

## 1. What changed

The six employees previously performed work only when a person started it. They now have a shared proactive path:

1. A reviewed capability runs against persisted workspace records (or, for Lead Hunter research, the existing
   provider-backed research job).
2. The capability records its real findings in `ai_work_jobs` / `ai_work_events`.
3. It publishes one `ai_work_reports` row with sections that answer what happened, why it matters, what was verified,
   what action was taken, what remains blocked, what should happen next and whether a person must approve anything.
4. Each supervisor's own notification policy decides whether the report is delivered now, held for quiet hours,
   grouped into a digest, suppressed below a severity threshold or filtered off. Every outcome is recorded.
5. The report appears in the AI Work Board as an expandable card and in the employee's Activity tab. Buttons perform
   real, permission-checked actions; there are no decorative controls.

Nothing in this layer invents activity. A report is written only after a capability has completed. A "monitoring
active" label appears only when both the tenant row and the deployment operator switch are enabled.

## 2. Employee duties

| Employee | Reviewed capability | Proactive duty |
| --- | --- | --- |
| Operations Manager (Zeng) | `proactive_review` | Failed/stuck AI work, approvals waiting over a day, overdue tasks, leads awaiting review, unavailable employees, degraded integrations, stalled jobs, blocked work spanning more than one employee and incomplete contact records. |
| Lead Hunter | `lead_generation_review` | Stalled research, the human review backlog, approved leads that never reached the CRM, no authorized research in 14 days, duplicate rates above the stated 20% threshold and the next assignment against the saved target. |
| Appointment Setter | `appointment_review` | Bookings waiting for approval, manual bookings, requests stuck before confirmation and confirmed appointments with no responsible person. |
| Sales Assistant | `pipeline_review` | Stale deals, missing values or owners, passed close dates and deals with no linked customer. |
| CRM Manager | `crm_quality_review` | Missing contact details, companies with no domain, possible duplicate names, shared names that need identity checks and unverified identities. |
| Performance Analyst | `performance_snapshot` | Measured lead, contact, appointment, opportunity and AI-reliability KPIs with a prior-period comparison and only the stated anomaly thresholds. |

The static duty copy shared by the interface and the work board is in `src/lib/proactive.ts`. The executable checks
are the existing review handlers plus `src/server/workforce/lead-generation-review.ts`; no "proactive" flag grants a
role a capability it did not already have.

## 3. Report data and delivery

Migration `0080_proactive_ai_employees.sql` adds:

| Table / column | Purpose |
| --- | --- |
| `ai_work_reports` | One persisted report per completed job or briefing slot: kind, severity, sections, findings, evidence, metrics, status and action evidence. |
| `ai_work_report_deliveries` | One row per report and supervisor with the real delivery outcome (`delivered`, `held`, `digest`, `suppressed`), reason, notification id and read time. |
| `ai_work_schedules.business_hours` | Local business-hour windows, evaluated in the schedule's own time zone. |
| `ai_work_schedules.payload` | The exact owner-approved assignment for a provider-backed schedule. Lead research is the only provider-backed capability accepted today. |
| `ai_work_schedules.last_skipped_*` | Why a due schedule did not run, so the UI never implies a check happened. |

Client roles can read a report only with `activity.view`; a delivery row only for themselves. All writes are
server-side. The tables have RLS enabled and no client write grant.

Delivery policy is in `src/server/workforce/reports.ts` and the pure helpers in `src/lib/proactive.ts`:

- **Critical** reports always bypass quiet hours and the severity threshold.
- A user can choose `info`, `warning` or `critical` as the minimum. A lower-severity report is stored and visible in
  the work board, with `below_severity_threshold` recorded on the delivery.
- Quiet hours hold non-critical notifications and the scheduler releases them when the window ends. The release job
  only re-evaluates existing, already-verified reports; it never creates work.
- A daily-digest preference moves routine notifications out of the bell and into the opt-in daily briefing.
- The notification dedupe key is a hash of the capability, finding keys and the local date. Two jobs that detect the
  same condition on the same local day do not produce a second alert. The report itself remains.
- The existing notification table, preference groups and email pipeline are reused. There is no parallel
  notification centre.

## 4. Scheduled monitoring and business hours

The Work Board can save a schedule for any reviewed review/lead-generation capability, and for an explicit Lead Hunter
research assignment. Creating a schedule always saves it **paused**.

A schedule creates work only when all of these are true:

1. the schedule row is `enabled`;
2. `WORKFORCE_SCHEDULES_ENABLED=true` in the deployment;
3. the employee is enabled, configured and available;
4. the current local time is inside the saved business-hour window (when one is set).

Outside the window, `runDueSchedules` postpones the row to the next 15-minute opening and records
`outside_business_hours`. It does not create a job at midnight. Business hours are evaluated with
`Intl.DateTimeFormat` in the schedule's IANA time zone; no server-local-time assumption is made.

A scheduled Lead Hunter research row carries the exact prompt saved by the owner. When it fires, the tick creates a
real `lead_research_requests` row and a linked `ai_work_jobs` row through `src/server/leads/scheduled-research.ts`,
then wakes the existing worker. It revalidates the assignment, respects the existing research rate limit and uses the
existing run gate, provider timeout, cancellation, recovery and evidence path. It does **not** send outreach.

The scheduler tick never executes provider work itself. It creates durable jobs; the worker claims them with a lease.
Recovery, cancellation and retry remain the existing shared job paths.

## 5. Daily and weekly briefings

`runProactiveBriefings` produces an opt-in briefing for an owner or admin after their chosen local hour:

- **Daily activity briefing**: reports from the last 24 hours plus pending approvals, failed/blocked jobs, overdue
  tasks and leads awaiting review.
- **Weekly performance summary**: the last seven days plus the latest completed Performance snapshot's measured
  metrics. It never invents a target or benchmark.

The report is keyed per person and local date, so overlapping ticks cannot duplicate it. A quiet day with no reports,
approvals, failures or overdue work creates no notification. Briefings are held by quiet hours like any other
non-critical report.

This job is gated by `WORKFORCE_BRIEFINGS_ENABLED`, which is absent/false by default. Registering the job does not
start a briefing.

## 6. Safe actions and approval boundaries

The proactive layer can take exactly one business action on its own, and only after an owner opts in:

- **Critical follow-up task.** When an owner enables "Create a follow-up task for critical reports" in Settings →
  Notifications, a critical report creates one ordinary internal CRM task for that owner. The task is linked to the
  report, is idempotent per report, assigns the owner, emits `task.created`, records
  `workforce.proactive_task_created` and is visible in CRM Tasks. It never messages a customer.

Everything else remains a human action:

- A person can create a follow-up task from any completed finding; the action requires `tasks.manage` and is
  idempotent.
- A report can recommend a research assignment, CRM cleanup or pipeline next step, but it cannot execute an external
  or high-impact action. Those continue through the Approval Center and the existing executors.
- Appointment confirmation, calendar writes, lead import, outreach, campaign sends and configuration changes were not
  relaxed by this work.
- The review capabilities continue to write no customer record. The only writes are the report/delivery ledger, the
  opt-in internal task, and the work job's own events.

## 7. Interface

- `ProactiveWatch` (`src/components/work/proactive-reports.tsx`) is reused on the AI Work Board and renders:
  monitoring state, all six employee duties, expandable report cards, severity and delivery state, measured metrics,
  findings, evidence links, acknowledgement and the real follow-up-task action.
- An employee's **Activity** tab shows that employee's proactive duty, whether a recurring row is actually active,
  and its recent verified reports. It links to the full Work Board.
- Settings → Notifications adds proactive on/off, minimum severity, delivery mode, quiet hours, daily briefing,
  weekly summary, briefing hour and the opt-in critical-task action.
- The Work Board's schedule panel explains both deployment switches, supports business hours and accepts the
  Lead Hunter research assignment. It does not activate anything; saving is always paused.

The UI never displays a percentage, ETA or "monitoring" claim that is not backed by a row or completed report. When no
monitoring is configured it says so explicitly.

## 8. Verification (local, 2026-10-21)

| Check | Result |
| --- | --- |
| `tests/workforce-proactive-delivery.test.ts` | 11 passed — report publication, supervisor delivery, idempotency, severity threshold, critical bypass, quiet hours hold/release, tenant isolation, acknowledgement refusal, opt-in task creation and default-off, monitoring state, daily briefing dedupe and operator gate. |
| `tests/workforce-lead-generation.test.ts` | 3 passed — Lead Hunter-only allowlist, all five persisted checks, real saved target/next assignment, no provider run, no business record change, wrong-role refusal. |
| `tests/workforce-schedule-windows.test.ts` | 5 passed — outside-hours postponement, in-hours execution, invalid windows, real scheduled research request/job, incomplete assignment refusal. |
| `tests/work-board-ui.test.tsx` | 9 passed — honest active/not-configured states, report card evidence, acknowledgement action, existing status/metrics and schedule/trigger gates. |
| Existing focused suites | `workforce-proactive-review`, `workforce-review-capabilities`, `workforce-schedules` passed unchanged (47 tests across the seven focused files). |
| `npm run typecheck` | passed. |

The focused tests use isolated PGlite and fictional data. No external provider, CRM write, outreach, production
migration or scheduler activation was performed.

## 9. Activation checkpoint

Before any proactive monitoring is described as production-live, all of the following need explicit authorization:

1. The 2026-10-24 preflight found `0080`, `0081`, `0082`, `0083`, `0085` and `0086` in the hosted application ledger; `0084_restricted_hermes_provisioner` is absent. The exact running application SHA is still unverified.
2. Production has **4/4 company facts** and Lead Hunter is configured at 6/6 readiness. The remaining four internal employees have no applied configurations and remain unavailable; this is the active employee blocker.
3. Enable a single schedule or event trigger in a supervised window. Keep `WORKFORCE_SCHEDULES_ENABLED`,
   `WORKFORCE_TRIGGERS_ENABLED` and `WORKFORCE_BRIEFINGS_ENABLED` false until each activation is approved.
4. Start the dedicated worker only when queued jobs are authorized to run.
5. Verify one completed report end to end: job events, report card, notification delivery status, acknowledgement and
   any approved follow-up task. Check that a repeated tick does not duplicate the alert.
6. Enable daily/weekly briefings only after the scheduler and the user opt-in are verified.

Until then the product must say **prepared, not active** — as the Work Board does.
