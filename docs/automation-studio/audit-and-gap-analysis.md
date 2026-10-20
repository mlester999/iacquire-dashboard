# Automation Studio: repository audit and gap analysis

Phase 1 of the Automation Studio initiative. Audited on 2026-10-21 against `master` at `1382d6f` (plus the uncommitted changes listed in
[implementation-checklist.md](implementation-checklist.md)). Everything below was read from the code or run; nothing was assumed from the
brief. Nothing was deployed, no hosted database was touched, and no message, payment or webhook was sent.

## Headline findings

1. **The workflow engine already exists and is good.** The native CRM workflow engine (migration `0032`, `src/server/crm/workflows/*`,
   `src/lib/crm/workflow/spec.ts`) has immutable versions bound to a content hash, owner approval of exactly that content, leased runs with
   `for update skip locked`, per-step transactions, idempotent effect keys, a three-phase pattern for outside calls, bounded retries with
   backoff, a dead state, loop and step limits, pauses, dry runs and audit. Automation Studio is built **on** it, not beside it
   (the brief's "do not duplicate the CRM workflow system"). One canonical model: `crm_workflows.draft` and `crm_workflow_versions`.
2. **There was no entitlement, metering or quota anywhere in the workflow path.** Any member with `workflows.manage` could build and run
   anything; the only brake was a per-workflow hourly run limit. The $299 plan existed only as a manual agency-activated subscription
   (`maintenance_subscriptions`) with no link to workflows. This is the gap Phase 1 closes.
3. **The $299 plan has no payment automation.** Activation is an agency member's decision, "nothing is billed by this portal"
   (`src/server/maintenance/service.ts`), and a recurring PayMongo checkout is not built (`docs/build-progress.md`, row 18). "Verified
   payment" can therefore only mean *an agency member verified it*. This is a blocker for fully automatic lifecycle handling.
4. **Nothing in the engine runs in production yet.** The scheduler is prepared but not activated (`docs/production-scheduler.md`): no
   `CRON_SECRET`, no `SCHEDULER_ENABLED`, no tick has ever run. Workflow runs, schedules and the new plan sweeper all depend on it.
5. **A known scheduler defect would starve slow jobs.** `withinInterval` jobs run once and then never again (`runJob` records the skipped
   `0` as a success). The fix exists on the unmerged branch `worktree-aqi-operations` (user decision of 2026-10-20: keep that fix). The new
   plan sweeper deliberately does not use `withinInterval`, so it works either way.
6. **The editor is not a node-graph canvas yet.** It is a vertical branching list (`graph.ts` `layoutCanvas`) with add / remove / move; no
   free positioning, connection editing, zoom, pan or minimap, and no graph library is installed.
7. **There is no AI builder, conversation store or structured-output path.** `llmComplete` is plain text with no tool or JSON mode.
8. **Few connectors exist.** Messaging (Resend email, Twilio SMS, Meta WhatsApp), calendars (Google, Microsoft, CalDAV), signed webhooks,
   n8n and the CRM itself. There is no Gmail/Outlook mail, Sheets, Slack or Stripe connector and no generic HTTP-request step.
9. **Live AI employee runs are switched off by design** until each employee's complete tool inventory is verified
   (`agentLiveRunsVerified`, `requestAgentTask`). The `ai_task` node exists and is permission-safe, but it will report "blocked" in
   production until that external verification is done.

## Map of existing automation-related modules

| Area | Where | What it does | Decision |
| --- | --- | --- | --- |
| Definition contract | `src/lib/crm/workflow/spec.ts` | 29 trigger types (26 events + schedule, inbound webhook, manual), 17 step kinds each with a zod config, validator, effects, content hash | **Reuse; extend.** Canonical model. Added premium features. |
| Definitions & versions | `src/server/crm/workflows/definitions.ts` | Create, save with revision check, publish (validate, freeze, derive effects), owner approval, on/off/archive, clone, built-in templates | **Reuse.** Added entitlement gates, origin, restore-as-draft. |
| Runner | `.../runner.ts` | Lease and claim, step transaction, waits, approvals, retries, recovery, schedules | **Reuse.** Added plan hold and metering. |
| Run services | `.../runs.ts`, `triggers.ts`, `inbound.ts`, `executors.ts` | Run history, dry runs, manual start, cancel/retry/skip, dispatcher, signed inbound URL, one executor per step | **Reuse.** Plan and quota checks added at the three places a run starts. |
| Permissions | `.../permissions.ts` | A workflow can never do more than the people who publish and switch it on | **Reuse unchanged.** |
| Gates | `src/server/automation/gate.ts` | Workspace and agency pauses; AI employee mode and readiness | **Reuse.** Premium lapse deliberately does not use these (see decisions). |
| Scheduler | `src/server/ops/tick.ts`, `jobs.ts`, `/api/internal/tick` | Single-flight tick over `JOBS` | **Reuse.** One job added (`studioEntitlementSweep`). |
| Plan | `src/server/maintenance/service.ts`, `maintenance_subscriptions` (0015) | Opt-in $299 plan, agency activation, monthly request allowance | **Reuse as the entitlement source.** Added past_due / expired. |
| Money | `src/lib/billing.ts`, `src/server/billing/*` | Micro-dollar ledger, credits, markup, PayMongo for credits | **Reuse for cost vocabulary.** `automation_execution` unit exists but nothing emits it. |
| Usage / fair use | `src/server/usage.ts`, `src/server/fairuse/service.ts` | Monthly AI-message limits, storage policy | **Separate.** Studio gets its own counters so core usage limits are not entangled. |
| AI employees | `src/lib/agents.ts`, `src/server/crm/agent-tools/*`, `src/server/integrations/hermes/*` | Six fixed roles on Hermes; scoped CRM tools; run records | **Reuse via `ai_task`.** Role set is fixed (see risks). |
| LLM | `src/server/llm/client.ts` | One agency-wide connection (integration `llm`), env fallback, streaming | **Reuse the transport.** Needs a structured-output wrapper for the builder. |
| AQi | `src/server/aqi/*` (1,479-line `service.ts`) | Navigation and help assistant with its own conversations and cost controls | **Keep separate.** The AI Automation Builder is a different service. |
| Outbound safety | `src/server/crm/webhooks.ts`, `security/pinned-https.ts` | SSRF guard with address pinning, signed delivery | **Reuse for an HTTP-request step.** |
| n8n | `src/server/integrations/n8n*.ts` | Agency-global n8n with per-workspace verified mappings | **Reuse unchanged** (external automations stay available without the plan). |
| Editor UI | `src/components/crm/workflows/*` | List, editor, panels, runs, test run, versions | **Reuse as the base of Manual Mode.** |

## Gap analysis against the brief

Status: **Have** (exists and was verified), **Partial**, **Missing**, **Added** (built in this pass, tested), **Blocked** (needs something outside the code).

| Requirement | Status | Evidence / note |
| --- | --- | --- |
| Canonical versioned workflow definition | Have | `crm_workflows` draft + immutable `crm_workflow_versions`, content hash excludes editor layout |
| One model for Auto and Manual, no lossy conversion | Have | Both will edit the same draft; operations layer below is the only mutation path |
| Event / scheduled / inbound-webhook / manual triggers | Have, Partial | Schedules are daily/weekly at a time only; no interval or cron expression |
| Delays and waits | Have | duration, until time of day, until a date |
| Conditions and branching | Have | if/else on contact or deal, reply check |
| Safe loops with iteration limits | Partial | Loops back through a wait only (25 visits per step, 200 steps per run); no for-each over a list |
| Idempotent execution | Have | effect keys, one run per workflow and event, `Idempotency-Key` on inbound |
| Durable state, bounded retries, backoff, dead state | Have | 1, 2, 4, 8 minutes, 5 attempts, `dead`; retry and skip controls |
| Loop prevention | Have | event depth limit and visit limits |
| Cancellation | Have | per run, and archiving cancels live runs |
| Concurrency controls | Partial | Added a per-workspace cap on plan runs in progress; **no per-tenant fair claiming** (risk R3) |
| Run logs and observability | Have, Partial | step rows with results and the activity page; no metrics dashboard |
| Tenant-scoped permissions | Have | `org_id` on every row, RLS, `assertMayRunDefinition` |
| Usage metering and quotas | **Added** | `automation_studio_usage` counters, `automation_studio_limits`, `admitStudioRun` |
| Version-aware execution, safe publishing | Have | runs pinned to a version; publish validates against the workspace |
| Existing published workflows stable while drafting | Have | draft is separate from the published version |
| Dry runs, simulation vs real integration test | Have, Partial | savepoint-rolled-back dry run; no "send a real test to myself" yet |
| Version history and rollback | **Added** (server) | `restoreVersionAsDraft`; undo/redo stack in `history.ts`; no UI |
| Structured, validated workflow operations | **Added** | `operations.ts`, 9 operations, draft and strict modes, change set |
| Variables and safe data mapping between steps | Missing | steps expose no outputs; only merge tokens from the contact |
| HTTP request / generic API node | Missing | only registered signed webhooks and n8n |
| Gmail, Outlook mail, Sheets, Slack, Stripe | Missing | needs OAuth apps and credentials (blocked on the founder) |
| AI Employee nodes | Have | `ai_task`; live runs gated off pending tool-inventory verification (**Blocked** externally) |
| Entitlement enforced on the server | **Added** | `assertStudioEntitled` at create, save, publish, copy, restore, turn on, test, start; engine hold and refusal |
| Lifecycle: failed payment, expiry, reactivation | **Added** (backend) | `lifecycle.ts`; agency-confirmed; no payment-provider automation (**Blocked**), no agency buttons yet |
| Pause premium on lapse, keep core cron and external automations | **Added** | sweeper pauses only versions with premium features; tested against AI employees and pauses |
| Locked/upgrade experience, usage page | Missing | data layer ready, no UI |
| Visual canvas (drag, connect, zoom, pan, minimap) | Missing | current editor is a vertical branching list |
| Auto mode: welcome screen, chat, live canvas | Missing | Phase 4 |
| AI Automation Builder service | Missing | Phase 4; needs structured output, conversation store, budget |
| 15 to 20 launch templates | Partial | 5 built-in CRM templates today |
| Integration setup checks per template | Missing | |

## Production risks and architectural conflicts

| ID | Risk | Severity | Status |
| --- | --- | --- | --- |
| R1 | Scheduler not activated in production, so no workflow run, schedule or plan sweep happens there | High for launch | Open. Needs `CRON_SECRET` + `SCHEDULER_ENABLED` and the user's approval. |
| R2 | `withinInterval` starves slow jobs (`crmWorkflowRecovery`, `fairUseChecks`, …) | High once R1 is lifted | Fix exists on `worktree-aqi-operations`, not merged. Sweeper avoids the helper. |
| R3 | `claimRuns` orders by due time across all tenants, so one tenant's backlog delays everyone's at 25 runs per tick | Medium | Open. Bounded today by the hourly limit per workflow and, for plan runs, the live-run cap. Designed fix: rank by `row_number() over (partition by org_id …)` before locking, with an `(org_id, next_run_at)` partial index. Not changed here because it alters the hot claim path without a measured problem. |
| R4 | Live AI employee runs are off until tool inventory is verified | Medium | External. Surfaced honestly by `ai_task` (blocked, nothing asked). |
| R5 | Plan activation and payment are manual | Medium | By design until recurring billing exists. Documented in the upgrade copy. |
| R6 | Migration `0069` is not applied to any hosted database; `0068` is reserved by the unmerged AQi Operations branch | Info | The runner tracks versions as a set, so the gap is harmless. Apply `0069` before deploying this code. |
| R7 | Notification kinds are a CHECK constraint that each migration rewrites in full, so adding a kind can silently drop another branch's | Medium | Avoided: only existing kinds (`maintenance_update`, `usage_limit_approaching`) are used. |
| R8 | The word "Studio" already means Website Studio (routes, `studio:*` scripts, tests) | Low | Use `Automation Studio` / `automation-studio` everywhere; do not reuse `studio` as a bare name. In code, `origin = 'studio'` means Automation Studio and is documented as such. |
| R9 | The brief names "AI Lead Qualifier" and "AI Receptionist", which are not roles | Low | The six real roles are `operations_manager`, `lead_hunter`, `appointment_setter`, `sales_assistant`, `crm_manager`, `performance_analyst`. Templates must use those. |
| R10 | One agency-wide LLM connection pays for every workspace's builder use | Medium | Builder messages and tokens are metered per workspace (`builder_*` counters); a per-workspace cap and cost estimate are needed before Phase 4 ships. |
| R11 | No graph library; a custom SVG canvas or a new dependency (`@xyflow/react`) must be chosen | Decision | Phase 3. |
| R12 | A scheduled run refused for the plan or a limit is not retried when the quota resets | Low | Intentional and recorded as a cancelled run with the reason (same as the hourly limit). |

## Architecture decisions made in this pass

1. **Premium is derived, not guessed.** A workflow is tied to the plan by `crm_workflows.origin = 'studio'` and by
   `crm_workflow_versions.premium_features` (frozen with the version, like `effects`). Everything built before, and everything built in the
   CRM screens, is `origin = 'crm'` with no premium features, so **the contracted CRM is never touched by the plan's lifecycle**.
2. **Server enforcement at every door.** Create, save, publish, copy, restore, turn on, ask-for-approval, approve-and-activate, test, manual
   start, inbound webhook, event start, schedule start, and every step the runner advances. Reading, pausing and archiving never need the plan.
3. **A lapse pauses; it never deletes or fails.** Active plan workflows become `paused` with `entitlement_paused_at` set; runs in progress
   wait; a person must validate and turn each on again. A person's own pause is never confused with a plan pause.
4. **Limits are always numbers.** Platform defaults are finite and provisional; the agency can set a workspace's own; "hard stop" can be
   turned off to warn only. New runs are refused and recorded; runs in progress finish within the engine's own step limit.
5. **One mutation language.** `operations.ts` is the only way a definition changes. The AI can only emit those JSON operations; strict mode
   refuses any batch that introduces a validation error or chooses a webhook address; nothing in the language can reach an approval.
6. **Position is not content.** Dragging a node changes `ui` only, which is excluded from the content hash, so it can never change what
   runs, force a new version, or invalidate an owner's approval.

## What was and was not verified

Verified by running code: the 135 existing automation tests before and after; 118 new tests (31 plan/schema/entitlement, 31 engine/limits/
lifecycle, 56 operations/history); the full suite at the end (3,484 passed, 1 failed, see below); a mutation check that disabling the mid-run plan hold fails the right test; typecheck and lint of every
touched file; the migration and its rollback on a fully migrated in-memory PostgreSQL (PGlite). The one failing test in the full suite,
`tests/workforce-navigation.test.tsx` ("Chat with" shortcut), fails identically on a pristine checkout of `HEAD` and is unrelated. **Not verified:** any behaviour on the hosted
Supabase database, any browser behaviour (no UI was built), the scheduler in production, any real LLM, payment or connector call.
