# WB — AI Work Board and proactive tasks

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). Historical audit at commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`; current integrated source snapshot `0205b86c` and tracker follow-up `46587f3a`.

Domain summary (historical audit of branch claude/ai-growth-partner-completion at 6e4a4b7e; read-only code reading). Local follow-up evidence as of implementation commit `1f56c025` (2026-11-16): B06 now records and deduplicates failed, blocked and lost-worker notices, pauses schedules after repeated failures, and renders schedule skip reasons. Focused tests use synthetic PGlite tenants; no hosted database or provider was used.

- What exists and is real: a durable job model (`ai_work_jobs` + append-only `ai_work_events`, migrations 0077/0081) with lease claim, heartbeat, lease fencing, cancel, retry and expired-lease recovery; tenant schedules (`ai_work_schedules`, 0078/0080/0105) with IANA-timezone daily/weekday recurrence, business-hour windows and DST handling; event triggers (0079); proactive reports/briefings (0080); a Work Board (kanban + list + calendar) that renders only persisted rows and keeps future occurrences ("Planned") apart from jobs; and a deterministic chat schedule parser with a preview/"confirm schedule" flow. Handlers for all 14 capabilities are deterministic database reads (no model call), so a scheduled "report" is a rule-based review, not an AI-written summary.
- Safety posture is good: schedules and triggers accept only read-only, reviewed capabilities (`assertSchedulableCapability`, `src/server/workforce/schedules.ts:67`), every chat-created schedule is saved PAUSED, two operator switches (`WORKFORCE_SCHEDULES_ENABLED`, `WORKFORCE_TRIGGERS_ENABLED`) plus the scheduler's `SCHEDULER_ENABLED`/`CRON_SECRET` gate everything, and a job re-checks pause state, ability switches and the requester's permissions when a worker claims it.
- Recent local verification: GP-WB-03 now dispatches through the bound Partner, and GP-WB-07 runs recovered queue work in the bounded scheduler tick and prevents stale queued jobs from holding a schedule; see their evidence below. Production scheduler activation remains unverified/external.
- Biggest gaps: (1) schedule parameters beyond lead research are not preserved, and missed-occurrence/time-zone-change policy remains incomplete; (2) chat schedule intents still support only a subset of the five examples, and timed pause/resume is not implemented; (3) transient handler failures lack bounded retry/backoff and per-attempt history; (4) Growth Partner chat cannot yet read schedules/jobs, so "what is scheduled / what is running" has no grounded answer.
- Real vs simulated: tests use PGlite with the real service code, real scheduler tick route and real handlers (strong). No provider or model is involved in any of the scheduled review jobs. Lead-research jobs (the only provider-backed scheduled work) were exercised in the repo only with fixtures per the docs.

<a id="gp-wb-01"></a>
### GP-WB-01 — Durable work job lifecycle, claim/lease/fencing and honest status

- **Requirement:** Durable work job lifecycle, claim/lease/fencing and honest status (directive §13)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/jobs.ts`, `src/server/workforce/work-runner.ts`, `supabase/migrations/0077_ai_work_jobs.sql`, `supabase/migrations/0081_ai_work_job_rls_hardening.sql`
- **Test coverage:** `tests/workforce-jobs.test.ts` (claim/stage events, idempotent key 309, unknown capability blocked 340, lease recovery 382/406, "rejects completion from a worker whose expired lease was reassigned" 466, recovery-pending view 543); `tests/ai-job-gate.test.ts` (blocked at claim after pause, requester loses permission 122). These exercise the real DB path. Not covered: `heartbeatWorkJob` for non-research handlers (only `src/server/leads/research-job.ts:377` heartbeats; read-only reviews rely on the 180 s lease, which is fine for their short runtime); concurrency of two real workers racing a claim.
- **Real or simulated behavior:** Real PGlite/Postgres rows and real service code; handlers are deterministic DB reads, no model or provider.
- **Missing dependencies:** none for the code path.
- **Remaining work:** Add a two-worker claim race test; add lease renewal in runWorkJob (or per-handler heartbeats) so a slower future handler cannot lose its 180 s lease. | Skeptic adds: finishWorkJob accepts status completed with an empty result and null summary; add a guard (or handler contract test) that a completed job always carries resultSummary/result so the stated definition of done is enforced rather than assumed.
- **Verification evidence:** own: read jobs.ts, work-runner.ts, 0077 migration and the tests above. Prior recorded runs (docs/ai-growth-partner/implementation-status.md): full regression "892 test files, 13,793 tests" on 2026-11-08 and later runs; not re-run by this audit.
  - *Skeptic review: The definition of done ('recorded final result') is not enforced by the store.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A job reaches completed only from a worker with a live lease and a recorded result; stale workers cannot write; every transition has an event; baseline run green.

<a id="gp-wb-02"></a>
### GP-WB-02 — Task creation and assignment (on-demand work, chat dispatch, finding-to-task)

- **Requirement:** Task creation and assignment (on-demand work, chat dispatch, finding-to-task) (directive §13)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/capability-dispatch.ts`, `src/server/workforce/finding-actions.ts`, `src/app/actions/work.ts`, `src/lib/workforce-chat-assignment.ts`, `src/server/workforce/reports.ts`
- **Test coverage:** `tests/workforce-chat-assignment.test.ts`, `tests/workforce-chat-e2e.test.ts` (routes, permission refusal 888/992), `tests/work-job-progress.test.tsx:258` (finding -> task through the real action), `tests/workforce-proactive-delivery.test.ts:256/276`. Real DB path for dispatch and task creation.
- **Real or simulated behavior:** Real: work can only be created as one of 14 fixed reviewed capabilities; a finding can become a CRM task assigned to the clicking user; opt-in task for critical reports.
- **Missing dependencies:** product decision on what a free-form AI task is.
- **Remaining work:** No free-form task entity or assignment to another member/AI employee with a due date. Add a task record (or CRM task with AI owner), a chat intent for task creation, assignment with tasks.manage check, and a board lane/filter.
- **Verification evidence:** own: code reading of the files above. Docs claim "Work Board task state" persisted (implementation-status.md line 49, restart acceptance script) which refers to job rows, not generic tasks.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A member can create a task with owner and due date via chat or board; it shows with a real status and closes only on evidence or a person.

<a id="gp-wb-03"></a>
### GP-WB-03 — Work Board Start review on Growth-Partner-only workspaces

- **Requirement:** Work Board Start review on Growth-Partner-only workspaces (directive §13)
- **Current implementation status:** COMPLETE — VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/actions/work.ts`, `src/app/(portal)/work/page.tsx`, `src/server/workforce/capability-dispatch.ts`, `src/server/admin/tenants.ts`, `src/server/workforce/service.ts`
- **Test coverage:** `tests/work-start-review-partner-only.test.ts` exercises the real action and dispatcher against PGlite. It dispatches every `workBoardAction` capability to the bound Growth Partner runtime, proves a legacy six-role tenant still uses its legacy role, and proves a paused bound Partner reports `agent_unavailable` without falling back.
- **Real or simulated behavior:** The real server action, authorization path, job creation and tenant-scoped agent lookup run against synthetic PGlite tenants. No remote worker or provider is involved in these read-only reviews.
- **Missing dependencies:** none.
- **Remaining work:** none for application dispatch; production worker activation is tracked separately in GP-WB-08.
- **Verification evidence:** `tests/work-start-review-partner-only.test.ts` passed **3/3 tests** on 2026-11-17; integrated suite also passed before W1-12. The test does not exercise a hosted worker or provider.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Start review creates a job on the Growth Partner runtime for every available capability in a client-only workspace, covered by a non-mocked test.

<a id="gp-wb-04"></a>
### GP-WB-04 — Schedule engine: creation, recurrence, time-zone-safe execution, business hours

- **Requirement:** Schedule engine: creation, recurrence, time-zone-safe execution, business hours (directive §13)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/schedules.ts`, `src/lib/workforce-schedule-recurrence.ts`, `src/server/ops/tick.ts`, `src/app/api/internal/tick/route.ts`, `supabase/migrations/0078_ai_work_schedules.sql`, `supabase/migrations/0080_proactive_ai_employees.sql`, `supabase/migrations/0105_workforce_local_recurrence.sql`, `src/components/work/work-board.tsx`
- **Test coverage:** `tests/workforce-schedules.test.ts` (paused weekday rule + next occurrence 98; real cron tick route -> two tenants -> Work Board + Calendar 218; GP runtime 156; no duplicate while previous active 377; version-checked update 406); `tests/workforce-schedule-recurrence.test.ts` (DST spring/fall, weekday selection, invalid zone); `tests/workforce-schedule-windows.test.ts` (outside business hours postponed); `tests/ai-job-gate*.test.ts` (paused skip). Real path.
- **Real or simulated behavior:** Real: real tick route, real rows, IANA-timezone recurrence with DST tests; scheduled jobs run deterministic reviews.
- **Missing dependencies:** none.
- **Remaining work:** 1) Persist and pass per-capability schedule parameters (payload is stored only for lead_research; chat period/sinceDays are dropped; scheduled performance snapshot always uses 30-day default). 2) unique(agent_instance_id, capability) allows one schedule per capability. 3) Add a missed-occurrence/late-run policy (a missed Monday run executes on Wednesday today). 4) Raise per-tick limit (3) or loop within budget. 5) Propagate org timezone changes. 6) Fallback requester when created_by leaves.
- **Verification evidence:** own: read schedules.ts, recurrence lib, tick.ts, route, tests. Prior recorded: implementation-status.md line 213 (two-workspace disposable scheduler test) and 219-221 (restart acceptance persists only a PAUSED schedule, `pausedCronScheduleExecuted:false`).
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Weekday/weekly rules fire at the right local time across DST; parameters are stored and honoured; late/missed occurrences follow a tested policy; multiple schedules per capability where needed.

<a id="gp-wb-05"></a>
### GP-WB-05 — Creating schedules from chat: the five example intents

- **Requirement:** Creating schedules from chat: the five example intents (directive §13)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-schedule-intent.ts`, `src/server/chat/service.ts`, `supabase/migrations/0106_workforce_chat_schedule_previews.sql`
- **Test coverage:** `tests/workforce-chat-schedule-intent.test.ts` (pure parser, includes "Prepare our weekly performance report every Friday at 9 AM" for the analyst role and refusal of writes), `tests/workforce-chat-e2e.test.ts` (200, 1017, 1227, 1294, 1421, 1453: preview -> confirm -> idempotent save, cancel, conflict, timezone change, permission). Real DB path, but none of the five example sentences is tested for the growth_partner role.
- **Real or simulated behavior:** Real service path (stored preview, 'confirm schedule', version-checked save, audit) driven by a deterministic regex parser, not a model. Traced by reading: 'lead report every Monday' needs a time (stateless clarification) then maps to performance_snapshot; 'check my qualified leads every morning' is refused as unsupported; 'prepare follow-up recommendations daily' is refused by the SCHEDULED_WRITE follow-up regex; 'summarize this week's acquisition performance every Friday' is not mapped (summarize not in verb list, no weekly period); 'pause the prospecting workflow until next week' matches no pattern. Not executed.
- **Missing dependencies:** product decision on which capability "lead report" and "acquisition performance" mean.
- **Remaining work:** Make clarifications stateful; extend capabilityFor for growth_partner (qualified leads, acquisition performance) with a weekly performance period; add summarize/give me/send me to the verb whitelist and stop SCHEDULED_WRITE blocking read-only 'follow-up recommendations'; generalize pause/resume wording; add the five sentences as growth_partner tests plus DB-backed e2e for supported ones.
- **Verification evidence:** own: line-by-line trace of the parser; not executed (read-only audit). Prior docs claim chat schedule control only for lead research (implementation-status.md lines 79, 92).
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each of the five sentences yields a correct confirmed saved-paused schedule preview or a precise refusal naming what is unsupported, verified by growth_partner tests.

<a id="gp-wb-06"></a>
### GP-WB-06 — Pause, resume and update schedules (UI, chat, timed pause)

- **Requirement:** Pause, resume and update schedules (UI, chat, timed pause) (directive §13)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/schedules.ts`, `src/app/actions/work.ts`, `src/lib/workforce-chat-schedule-intent.ts`, `src/server/chat/service.ts`, `src/components/work/work-board.tsx`
- **Test coverage:** `tests/workforce-schedules.test.ts:457` (enable/disable/delete with audit), `tests/work-board-ui.test.tsx:203/259`, `tests/workforce-chat-e2e.test.ts:200` (lead research window update), chat parser tests for pause/resume. Real DB path for the supported cases.
- **Real or simulated behavior:** Real for UI pause/resume/edit (audited, optimistic version check) and for chat pause/resume/update of the lead_research schedule only; every new schedule is saved paused and must be enabled in the board plus the global switch.
- **Missing dependencies:** none.
- **Remaining work:** No paused_until/resume_at column: add migration, honour in runDueSchedules, show on board, auto-resume with audit. Extend chat pause/resume/update to all scheduled capabilities. Decide whether chat can enable a new schedule when the owner authorized scheduled work.
- **Verification evidence:** own: code reading; recorded in docs only for lead research.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Any scheduled capability can be paused for a period or until a date and resumed from chat or board; it auto-resumes and the board shows 'Paused until <date>'.

<a id="gp-wb-07"></a>
### GP-WB-07 — Who executes queued jobs; recovery and restart behaviour

- **Requirement:** Who executes queued jobs; recovery and restart behaviour (directive §13)
- **Current implementation status:** COMPLETE — VERIFIED
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/work-runner.ts`, `src/server/workforce/work-kick.ts`, `scripts/workforce-worker.ts`, `src/server/ops/tick.ts`, `src/server/workforce/schedules.ts`, `src/server/workforce/jobs.ts`, `src/app/api/internal/tick/route.ts`
- **Test coverage:** `tests/workforce-queued-runner.test.ts` proves the tick runs a recovered job using only `aiWorkRecovery` then `aiWorkRunQueued`, cancels stale queued work so it cannot hold a schedule, resumes a due schedule after service-local state is reset, respects the runner budget, and settles a queued cancellation request. `tests/workforce-jobs.test.ts` also proves lease fencing and recovery.
- **Real or simulated behavior:** The real scheduler registry, queue runner, schedule service and job tables run on synthetic PGlite data. The tick has a bounded `aiWorkRunQueued` runner immediately after recovery; stale queue entries are cancelled with a visible reason. A real Vercel cron invocation, hosted restart and production worker are not tested here.
- **Missing dependencies:** production scheduler/worker hosting and switches remain external under GP-WB-08.
- **Remaining work:** none for the local queue runner and schedule-recovery path. Keep hosted activation and supervised production evidence under GP-WB-08.
- **Verification evidence:** `tests/workforce-queued-runner.test.ts` passed **6/6 tests** on 2026-11-17. The schedule test models a service restart by clearing local handler state while retaining durable database rows; it does not close/reopen a file-backed database or prove a hosted restart.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** With only the Vercel tick running, scheduled or requeued jobs are executed or failed with a visible reason within bounded time; a stalled schedule is impossible; restart/recovery tests pass.

<a id="gp-wb-08"></a>
### GP-WB-08 — Production scheduler activation and switch state

- **Requirement:** Production scheduler activation and switch state (directive §13)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** no
- **Source files:** `src/app/api/internal/tick/route.ts`, `src/server/ops/tick.ts`, `.env.example`, `scripts/production-activation-preflight.ts`, `docs/production-scheduler.md`
- **Test coverage:** `tests/scheduler-job-allowlist-phases.test.ts`, `tests/scheduler-intervals.test.ts`, `tests/workforce-schedules.test.ts:58` (off by default). They prove gating, not production state.
- **Real or simulated behavior:** All switches default OFF in code and .env.example (SCHEDULER_ENABLED, WORKFORCE_SCHEDULES_ENABLED, WORKFORCE_TRIGGERS_ENABLED, WORKFORCE_BRIEFINGS_ENABLED, WORKFORCE_WORKER_ENABLED); no vercel.json/cron in repo; production values not observable from the repository; historical docs say off.
- **Missing dependencies:** founder approval to switch on; Vercel Cron or equivalent calling `/api/internal/tick`; `CRON_SECRET`; supervised first run. A separate `workforce:worker` host is optional for deployments that use the in-tick queue runner.
- **Remaining work:** Unblocked: admin health/board banner reporting real switch values and last aiWorkSchedules heartbeat age. Blocked: setting production env, creating the cron, recording a supervised run.
- **Verification evidence:** own: read env example, route, preflight script. Production state not observed.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Production cron calls the tick, switches set per approved checklist, a supervised run recorded, banner reflects real state.

<a id="gp-wb-09"></a>
### GP-WB-09 — Retry handling and cancellation

- **Requirement:** Retry handling and cancellation (directive §13)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/jobs.ts`, `src/server/workforce/work-cancel.ts`, `src/app/api/work/jobs/[id]/route.ts`, `src/components/work/job-progress.tsx`, `src/server/workforce/work-runner.ts`
- **Test coverage:** `tests/workforce-jobs.test.ts` covers cancellation, late completion fencing, retry then complete, permissions and tenant scope; `tests/workforce-queued-runner.test.ts` proves Stop can commit while a PGlite-backed read-only scan is in progress. `tests/workforce-job-route.test.ts` covers the route boundary.
- **Real or simulated behavior:** Durable Stop is persisted while shared read-only reviews and operations checks scan records, and a late success is stored as cancelled with no result summary. Lead research settles its linked request and job as cancelled. Focused coverage uses synthetic PGlite tenants; no live provider was used for the cancellation cases.
- **Missing dependencies:** none.
- **Remaining work:** Add transient-failure classification with bounded automatic retry/backoff and per-attempt history; link retries to schedule history; add cancellation coverage for each remaining handler family. The shared read-only review path now checks the persisted stop request between reads, the operations and availability handlers use safe points, and `finishWorkJob` prevents late completion from winning.
- **Verification evidence:** 2026-11-17 follow-up: `tests/workforce-queued-runner.test.ts`, `tests/workforce-jobs.test.ts`, `tests/review-denominators.test.ts`, `tests/workforce-proactive-review.test.ts` and `tests/workforce-review-capabilities.test.ts` passed **5 files / 54 tests**; the queued-runner file was rerun after making the test rely on the persisted cancellation request (**1 file / 7 tests passed**). `npm run typecheck`, targeted ESLint and `git diff --check` passed.
  - *Skeptic review (addressed in the follow-up above): a persisted Stop request now reaches shared read-only reviews between checks, operations review and calendar availability; finalization cannot overwrite it with Completed. Bounded retry/backoff and per-family cancellation coverage remain open.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Transient failures retry with backoff and recorded attempts; permanent failures stop and notify; every handler honours cancellation.

<a id="gp-wb-10"></a>
### GP-WB-10 — Failure/blocked notifications and visibility of why a schedule did not run

- **Requirement:** Failure/blocked notifications and visibility of why a schedule did not run (directive §13)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/work-runner.ts`, `src/server/workforce/jobs.ts`, `src/server/workforce/schedules.ts`, `src/components/work/work-board.tsx`, `src/server/workforce/calendar.ts`, `src/server/notifications.ts`
- **Test coverage:** `tests/workforce-proactive-delivery.test.ts` covers failed, blocked and worker-lost delivery; `tests/workforce-schedules.test.ts` covers deduplicated supervisor notification and schedule pause after three failures; `tests/workforce-schedule-copy.test.ts`, `tests/work-board-ui.test.tsx` and `tests/workforce-calendar-ui.test.tsx` cover plain-language skip reasons and display.
- **Real or simulated behavior:** The job and schedule services persist deduplicated reports/notices, pause a schedule after three consecutive scheduled failures or blocked jobs, and expose the reason to the board and calendar. This is exercised with synthetic PGlite data; hosted notification delivery is not verified.
- **Missing dependencies:** none (notification service exists).
- **Remaining work:** Verify notice visibility and schedule pause behavior in a hosted non-production environment after migration rehearsal; current code and synthetic DB tests cover the local criterion.
- **Verification evidence:** focused DB-backed delivery/schedule tests and UI-copy tests passed locally; evidence remains synthetic-only. No hosted or production verification is claimed.
  - *Historical baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Any failed/blocked/lost job produces exactly one notice to the right people; a skipped or auto-disabled schedule says why on the board.

<a id="gp-wb-11"></a>
### GP-WB-11 — Execution policy: read-only auto-run, external writes behind approval

- **Requirement:** Execution policy: read-only auto-run, external writes behind approval (directive §13)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/schedules.ts`, `src/server/workforce/triggers.ts`, `src/lib/workforce-triggers.ts`, `src/server/workforce/work-runner.ts`, `src/server/workforce/abilities.ts`, `src/server/automation/job-gate.ts`, `src/lib/workforce-capabilities.ts`, `src/server/approvals/service.ts`, `src/server/workforce/capability-dispatch.ts`
- **Test coverage:** `tests/workforce-schedules.test.ts:394` (refuses non-review capabilities), `tests/workforce-chat-schedule-intent.test.ts:98`, `tests/ai-job-gate.test.ts:108/122`, `tests/ai-job-gate-pause-paths.test.ts`, `tests/workforce-review-capabilities.test.ts`, `tests/workforce-action-boundary.test.ts`. Real DB path for the gates.
- **Real or simulated behavior:** Real enforcement: schedulable/triggerable capabilities are a hard read-only allowlist; claim-time re-check of pause, ability switches and requester permissions; dispatchSystemCapabilityJob refuses non-read-only; drafts need human approval; chat refuses scheduled writes.
- **Missing dependencies:** none. Note the policy is currently a hard allowlist; "auto-run when configured and authorized" for low-risk internal work beyond reads (e.g. creating an internal CRM task) has no configuration surface.
- **Remaining work:** Add a test that enumerates WORKFORCE_CAPABILITIES and fails if a non-read-only capability becomes schedulable/triggerable; add an owner authorization surface if the product wants low-risk internal writes (e.g. internal tasks) to auto-run.
- **Verification evidence:** own: code reading. Prior recorded: docs/ai-growth-partner/implementation-status.md lines 12-13 (approval-gated booking, chat actions).
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Only read-only capabilities are schedulable (proved by an enumerating test); every write path has an approval or explicit confirmation record.

<a id="gp-wb-12"></a>
### GP-WB-12 — Duplicate-job prevention and idempotency

- **Requirement:** Duplicate-job prevention and idempotency (directive §13)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/schedules.ts`, `src/server/workforce/triggers.ts`, `src/server/leads/scheduled-research.ts`, `src/server/ops/tick.ts`, `src/server/workforce/capability-dispatch.ts`
- **Test coverage:** `tests/workforce-schedules.test.ts:127-154,218-375,377`, `tests/workforce-triggers.test.ts:71,95`, `tests/workforce-proactive-delivery.test.ts:184`, `tests/workforce-jobs.test.ts:309`. Real DB path.
- **Real or simulated behavior:** Real: schedule:<id>:<slot> and trigger:<id>:<event> idempotency keys, skip-locked due rows, previousActive guard, tick lease, unique report dedupe key.
- **Missing dependencies:** none.
- **Remaining work:** On-demand dispatch uses a random idempotency key so double clicks or two members create two jobs: add same-capability-already-active check or time-bucket key; add a two-concurrent-ticks test. | Skeptic adds: Narrow the stated gap to the Work Board Start review click (random idempotency key); chat paths are already keyed by message id. Add a test that a replayed schedule slot (createWorkJob created:false) does not append a second 'Created by schedule' event or re-kick.
- **Verification evidence:** own: code reading.
  - *Skeptic review: The audit says on-demand dispatch uses a random key; only the board path does. Chat dispatch uses message-id keys.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Concurrent ticks, double clicks and retried requests each produce exactly one job, proven by tests.

<a id="gp-wb-13"></a>
### GP-WB-13 — Work Board visibility: pending/completed work, execution history, approval queue, honest labels

- **Requirement:** Work Board visibility: pending/completed work, execution history, approval queue, honest labels (directive §13)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/work-board.ts`, `src/server/workforce/jobs.ts`, `src/server/workforce/calendar.ts`, `src/components/work/work-board.tsx`, `src/components/work/work-board-kanban.tsx`, `src/components/work/job-progress.tsx`, `src/components/work/workforce-calendar.tsx`, `src/app/(portal)/work/page.tsx`
- **Test coverage:** `tests/work-board-kanban.test.tsx:94/123` (persisted vs planned lanes; prepared-not-complete), `tests/work-board-ui.test.tsx:162/173`, `tests/work-job-progress.test.tsx` (stages, failed, lost lease), `tests/workforce-calendar*.test.ts(x)`, `tests/workforce-schedules.test.ts:218`. Real for server views; UI tests are component tests with fixtures.
- **Real or simulated behavior:** Real persisted reads under RLS; lanes keep future occurrences ('not jobs') separate from jobs; draft jobs read 'Ready for review'/'Approved, not yet sent' instead of Completed; UI tests are component tests with fixtures, server views are DB-backed.
- **Missing dependencies:** none.
- **Remaining work:** Waiting-for-approval lane holds only CRM import jobs: surface pending approval_requests and their execution outcomes on the board; add per-schedule run history; reword 'paused for this workspace'/'Operator switch' (global env switch) or make it per-workspace; add an explicit awaiting-connection blocked reason; browser-verify against seeded data. | Skeptic adds: Make the 'Completed today' KPI and the 'completed' filter exclude prepared-only/draft jobs (use the same evidence class as the kanban lane); make a job whose connector/source is missing finish blocked or 'awaiting connection' instead of completed (appointment-availability.ts:80-92, read-only-review.ts:271-283); align summary needsAttention with the 'attention' filter (waiting_for_approval counted differently).
- **Verification evidence:** own: read the server and UI files and the tests' titles. Prior recorded: implementation-status.md lines 64, 268-273 (Control Center reads the same summary). Not browser-verified by this audit.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: The board shows green 'Completed' for work that only prepared drafts (KPI) and for reviews whose source/connector was unavailable; the directive forbids Completed before the permitted action succeeded and requires a blocked/awaiting-connection state. The audit's claim that a missing connector simply blocks is only true for employee-level readiness.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every pending/approved/blocked/completed item including approvals and missing-connection blocks is visible with true status and reason; no item shows Completed without recorded evidence.

<a id="gp-wb-14"></a>
### GP-WB-14 — Status tracking through chat (what is scheduled, running, finished)

- **Requirement:** Status tracking through chat (what is scheduled, running, finished) (directive §13)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/live-facts.ts`, `src/server/workforce/client-prompt.ts`, `src/server/chat/service.ts`, `src/lib/workforce-chat-routing.ts`, `src/server/workforce/jobs.ts`
- **Test coverage:** none.
- **Real or simulated behavior:** Chat acknowledges a started job and confirms a schedule it just saved, but the Partner run context has no schedule/job facts and listActiveWorkJobsForAgent has no caller, so status questions are answered without grounded data.
- **Missing dependencies:** none.
- **Remaining work:** Add a deterministic chat intent for 'what is scheduled / running / did X run / failed work' answered from listSchedules/listWorkBoardJobs with viewer permissions and /work links; add a permission-scoped work-facts block to the Partner prompt; cross-tenant leakage test.
- **Verification evidence:** own: grep for readers of the jobs and schedules tables (list of files under `src` that mention `ai_work_jobs`/`ai_work_schedules` contains no prompt/fact builder).
- **Definition of done:** The Partner answers schedule/work-status questions only from persisted rows, correctly permission-scoped, and says no schedule is saved when none exists.

<a id="gp-wb-15"></a>
### GP-WB-15 — Proactive monitoring: event triggers, reports and briefings

- **Requirement:** Proactive monitoring: event triggers, reports and briefings (directive §13)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/triggers.ts`, `src/lib/workforce-triggers.ts`, `src/server/workforce/reports.ts`, `src/server/workforce/proactive-review.ts`, `src/server/workforce/read-only-review.ts`, `src/components/work/proactive-reports.tsx`, `supabase/migrations/0079_ai_work_triggers.sql`, `supabase/migrations/0080_proactive_ai_employees.sql`
- **Test coverage:** `tests/workforce-triggers.test.ts` (dedupe, current-event start, permissions), `tests/workforce-proactive-delivery.test.ts` (report dedupe, thresholds, quiet hours, tenant scope, briefing idempotency incl. Partner conversation), `tests/workforce-proactive-review.test.ts`. Real DB path.
- **Real or simulated behavior:** Real but narrow and rule-based (no model-written text): four CRM trigger events, reports with severity thresholds/quiet hours/dedupe, opt-in briefings into the Partner conversation gated by WORKFORCE_BRIEFINGS_ENABLED.
- **Missing dependencies:** whether the founder wants AI-written (model) summaries; that would need a real model run and is outside this row.
- **Remaining work:** Add reviewed lead/inbox/invoice trigger events mapped to existing read-only reviews; events are dropped (cursor advanced) when the employee is paused instead of deferred; decide on a deferral policy; any model-written summary is a separate product decision.
- **Verification evidence:** own: code reading; prior recorded runs in docs only.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A reviewed set of events produces exactly one report per event with notification policy applied, including a deferral policy for paused employees.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Event-trigger flood control: one full workspace review per CRM event with no coalescing, per-trigger rate limit or previous-job-active check", "directiveRef": "§13 (duplicate-job prevention, proactive tasks)", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "Add a per-trigger cooldown or coalesce events into one job per window (like schedules' previousActive guard); test a burst of 50 appointment.cancelled events produces a bounded number of jobs (triggers.ts:168-246)."}
- {"title": "Awaiting-connection state and approval queue as first-class Work Board items", "directiveRef": "§13 (approval queue; blocked/awaiting-connection state when a connector is missing)", "priority": "P1", "status": "PARTIAL", "remainingWork": "Reviews with a missing connector/source currently end Completed with a warning finding (appointment-availability.ts:80-92, read-only-review.ts:271-283). Add an explicit awaiting_connection block reason and board lane, and surface approval_requests (pending and execution outcome) on the board; browser-verify against seeded data."}
- {"title": "Growth-Partner-only end-to-end test of board, schedule and chat paths through the action layer", "directiveRef": "§13 (task creation, assignment, schedule creation)", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "No non-mocked test runs startReviewAction, a chat-created schedule confirm-and-enable, or the five example intents in a client workspace that has only the growth_partner runtime; add them (this would have caught GP-WB-03)."}
