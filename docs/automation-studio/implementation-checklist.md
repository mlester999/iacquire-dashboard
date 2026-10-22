# Automation Studio: implementation checklist

Dependency-aware. `[x]` is done **and** has evidence; `[~]` is partly done (the note says what is missing); `[ ]` is not started;
`[!]` is blocked on something outside the code. Evidence is a test file or a command that was run. Updated 2026-10-21 (foundation hardening and the first Studio screens).

Order of dependencies: **P1** audit and entitlement foundation → **P2** shared engine hardening → **P3** manual canvas → **P4** AI Auto Mode
(needs P2's operations and P3's canvas) → **P5** integrations and employee nodes (needs P2 metering, credentials) → **P6** templates and
subscription experience (needs P1 entitlement, P3, P4) → **P7** production hardening.

## Phase 1: repository audit and foundation

- [x] Inspect workflows, scheduler, CRM, AI employees, billing, security, tests. → [audit-and-gap-analysis.md](audit-and-gap-analysis.md)
- [x] Gap analysis, risk register, architecture decisions. → same document
- [x] Baseline: 5 automation test files, 135 tests green before any change.
- [x] Migration `0069_automation_studio_foundation` and its rollback; the rollback executes on a fully migrated database and refuses while Studio data exists. → `tests/crm-migrations.test.ts`, `tests/automation-studio-plan.test.ts`
- [x] Plan rules as pure code: prices, entitlement per state, grace period, lifecycle transitions, finite default limits, lapse policy text. → `src/lib/automation-studio/plan.ts`, `tests/automation-studio-plan.test.ts` (31 tests)
- [x] Server entitlement from the maintenance plan; `plan_required` error code. → `src/server/automation-studio/entitlement.ts`
- [x] Plan lifecycle states `past_due` and `expired` added without breaking the existing maintenance screens or flows. → `tests/maintenance.test.ts` (unchanged, green)
- [x] Agency UI to record a failed payment, a verified payment and an expiry, with grace period choice, an explicit "I confirmed this in our billing records" step, and what a lapse would touch. → `src/components/admin/plan-lifecycle.tsx`, `tests/automation-studio-plan-lifecycle.test.tsx`, `tests/automation-studio-operations.test.ts`; looked at (never submitted) in a real browser
- [!] Automatic payment verification (recurring PayMongo or similar). Needs the founder to choose and provide the provider account.

## Phase 2: shared workflow engine

Already present (verified, reused): immutable versions, content-hash approval, leases, idempotent effect keys, three-phase outside calls,
bounded retries and backoff, dead state, retry/skip/cancel, loop and step limits, pauses, dry runs, audit, permissions.

- [x] Premium capabilities derived and frozen per version (`premium_features`); workflow `origin`. → `derivePremiumFeatures`, `tests/automation-studio-plan.test.ts`
- [x] Entitlement enforced at create, save, publish, copy, restore, turn on, ask for approval, approve-and-activate, test, manual start. → `tests/automation-studio-engine.test.ts` (31 tests)
- [x] Engine refuses new premium runs and holds in-progress ones (never fails them) while the plan is inactive; CRM workflows unaffected. → same
- [x] Inbound webhook for a lapsed premium workflow answers 409 before it can create a contact. → same
- [x] Usage counters (runs, steps, failures, retries, tests, employee requests, integration calls, builder messages/tokens, cost) per workspace per month. → `src/server/automation-studio/usage.ts`
- [x] Fair-use limits: monthly runs/steps, runs in progress, workflows switched on; finite defaults; per-workspace overrides; warn at a threshold; hard stop or warn-only; refused runs recorded with the reason; owners told once a month. → same tests
- [x] Lapse handling: sweeper pauses only plan workflows, marks them, tells owners once, leaves CRM workflows, AI employees and pauses untouched; reactivation never switches anything on by itself. → same tests
- [x] Version rollback as a new draft (never rewrites a published version, never revives a retired webhook address). → `restoreVersionAsDraft`
- [x] Structured operations (9) with draft and strict modes, change sets, per-operation summaries, all-or-nothing batches. → `src/lib/crm/workflow/operations.ts`, `tests/workflow-operations.test.ts` (56 tests)
- [x] Position changes provably do not change the content hash or execution order. → same
- [x] Undo/redo history over operations, refusing to undo over work it did not make. → `src/lib/crm/workflow/history.ts`
- [x] Persist the draft history and the operation log per workflow, so chat and undo survive leaving and returning. → migration `0070`, `tests/automation-studio-hardening.test.ts` (rollback, refusal, isolation, cascade)
- [x] Per-tenant fair claiming of due runs (risk R3): round-robin by workspace, `for update skip locked`. → `tests/crm-fair-claiming.test.ts`
- [x] Scheduler: atomic claim per job and per-job intervals integrated from the AQi branch (`withinInterval` removed); the production scheduler stays off until the controlled end-to-end run. → `tests/scheduler-intervals.test.ts`, `docs/production-scheduler.md`
- [x] Grace period is configurable (`STUDIO_PAYMENT_GRACE_DAYS`, 1 to 30, default 7; per case by the agency member), with a reminder 48 hours before it ends. → `tests/automation-studio-engine.test.ts`
- [ ] Interval and cron-style schedule triggers.
- [ ] For-each loops with an iteration cap; variables and safe data mapping between steps.
- [x] HTTP request step on tenant-scoped connections (pinned DNS, no redirects, method/content/size/time limits, redaction, idempotency, unknown outcomes never retried blindly, quotas and concurrency limits, test mode). → [connections-and-outbound.md](connections-and-outbound.md), `tests/outbound-http.test.ts`, `tests/automation-studio-connections.test.ts`, migration `0072`
- [ ] "Send a real test to myself" distinct from the dry run.

## Phase 3: manual visual builder

- [x] Canvas technology decided and installed: `@xyflow/react` 12.12.0 (pinned). The CRM list editor stays as the Core editor.
- [x] Free positioning, drag-to-connect with validation, delete, duplicate, insert-after, palette (search and groups), zoom/pan/fit, mobile full-screen. → `src/components/automation-studio/canvas`, `tests/automation-studio-canvas.test.ts` (25 pure-layer tests); browser evidence below
- [x] Every gesture goes through `applyOperations` (draft mode); undo/redo through `history.ts`, rebuilt from the persisted trail; `add_step` can be `detached` for a drop onto empty canvas. → `tests/workflow-operations.test.ts`
- [x] Step settings reuse the CRM editor's panels (`StepPanel`, `TriggerPanel`), the test-run dialog, version history and restore-to-draft.
- [ ] Minimap; execution inspection overlay on the canvas (run history is still on the CRM run screens).

## Phase 4: AI Auto Mode

- [x] AI Automation Builder service, separate from AQi: stored conversation, streamed reply, operations validated by `parseOperations` then strict mode in a locked transaction, repair loop, plan, rate limit, monthly allowance, token counters. → `tests/automation-studio-builder.test.ts` (26 tests, scripted model)
- [x] Home screen ("What would you like to automate?"), 17 suggestions with workspace-readiness text, searchable categories, **searchable ready-made automations**, a skip link past "Your automations"; split-screen chat + live canvas that replays only operations the server accepted, resizable on desktop, tabs on a phone. → browser evidence below
- [x] Node-aware conversation (the selected step is sent with the message), failure explanations from recent run records.
- [x] Evaluated with a real model (DeepSeek `deepseek-flash`): see [ai-evaluation.md](ai-evaluation.md).
- [x] 20 executable templates now exist next to the 19 prompt starters. → [templates.md](templates.md)

## Phase 5: integrations and AI employee nodes

- [x] Audit of existing connector infrastructure. → [connector-audit.md](connector-audit.md)
- [x] HTTP request and Slack incoming webhook built (connections, verification by confirmed test, rotation, revocation, call log). → [connections-and-outbound.md](connections-and-outbound.md)
- [!] Slack OAuth (designed, not built), Gmail and Google Sheets: need apps and verification only the founder can start.
- [~] AI employee node exists (`ai_task`); [!] live runs stay off until tool inventories are verified.
- [ ] Employee-node permission tests per role (a Receptionist-like role must not gain Lead Hunter tools through a workflow). The step names a role and the request is made for that workspace and role only (`requestAgentTask`), by code reading; no test proves it per role, and live runs are off.

## Phase 6: templates and subscription experience

- [x] 20 executable templates, each with readiness and connection checks and 7 tests (created, real references, canvas, dry run, edits, publish/approval, switch on); two also run end to end. → [templates.md](templates.md)
- [x] Upgrade page ($299/month and the separate setup fee, what keeps working without the plan, provisional allowances, grace period, labelled example canvas, call to action to the existing Maintenance enrolment); locked sidebar entry; the route never exposes another workspace's automations. → browser evidence below, `tests/automation-studio-nav.test.tsx`
- [x] Usage page for clients (limits with real progress bars, what ran, the plan's state and grace date, plan-paused automations with review and turn-on, pause/turn-on per automation). → `src/components/automation-studio/usage-panel.tsx`, `tests/automation-studio-screens.test.tsx`
- [!] Billing automation (recurring payment collection and automatic verification). Payments are only ever recorded by a person; needs the founder to choose and provide a payment provider.

## Phase 7: production hardening

- [x] Browser E2E (Phase C: 62 checks; original: 46; real-model run: 17), accessibility (axe WCAG A/AA on the new screens, light and dark), tenant-isolation tests on the new tables, migrations 0069 to 0072 isolation and schema-drift test. → `tests/automation-studio-migrations.test.ts`
- [x] Hosted migrations `0069` to `0072` are applied and were checked read-only on 2026-10-22 (applied, RLS on every table, secret column unreadable by the app role, no Studio data yet). → [production-audit-2026-10-22.md](production-audit-2026-10-22.md)
- [x] Scheduler: controlled rehearsal through the real tick route and the real job list, two workspaces, simulated clock (`tests/automation-studio-scheduler-rehearsal.test.ts`), and the exact activation steps (`docs/production-scheduler.md`, section Automation Studio).
- [!] Scheduler activation itself: the founder's call (Vercel plan tier, `CRON_SECRET`, `SCHEDULER_ENABLED`); off in production.
- [x] Every template run end to end through the scheduler's runner (`tests/automation-studio-templates-run.test.ts`, 20 of 20).
- [x] Activation of the plan needs a recorded payment verification (who, when, the period), not a click. → `tests/maintenance.test.ts`, `tests/maintenance-admin-activation.test.tsx`
- [x] Held-out AI evaluation (two fresh sets, run once each) and the fixes it led to. → [ai-evaluation.md](ai-evaluation.md)
- [x] Browser QA at desktop, tablet and phone sizes, light and dark, axe WCAG A/AA, on the production bundle. → `scripts/automation-browser-qa-d.mjs`

## Evidence log

| Date | Command | Result |
| --- | --- | --- |
| 2026-10-21 | `npx vitest run` on the 5 automation test files, before any change | 135 passed |
| 2026-10-21 | same files plus `custom-projects`, `crm-migrations` after the changes | passed (the migrations test needed `0069` added to its rollback list) |
| 2026-10-21 | `tests/automation-studio-plan.test.ts` | 31 passed |
| 2026-10-21 | `tests/automation-studio-engine.test.ts` | 31 passed; mutation checks: with the mid-run plan hold disabled, and with the approval path's plan-marker reset removed, the right tests fail |
| 2026-10-21 | `tests/workflow-operations.test.ts` | 56 passed |
| 2026-10-21 | `npx tsc --noEmit` filtered to `src/ tests/ scripts/` | 0 errors (stale `.next-*` folders report unrelated errors) |
| 2026-10-21 | `npx eslint` on every touched file | 0 problems |
| 2026-10-21 | full `npx vitest run` | 3,484 passed, 1 failed: `workforce-navigation` "Chat with" shortcut, which fails identically on a pristine `HEAD` checkout |
| 2026-10-21 | 12 neighbouring and new files re-run on the final code | 334 passed |
| 2026-10-21 | `node scripts/automation-browser-qa.mjs` (real Chromium, isolated app, scripted model stand-in) | 46 of 46 checks: home, 17 ideas, search and category filter, build from a sentence with nodes appearing one at a time, reload keeps chat and canvas, chat edit, step selection, Manual mode add/undo/redo, history, publish (stays off), phone layout, dark theme, upgrade page, cross-workspace URL; axe-core WCAG A/AA clean on the home page, the workspace (Auto and Manual, light and dark) and the upgrade page at desktop width (phone width and the home page in dark were checked for layout only); 0 page errors, 0 console errors, 0 failed requests, 0 server errors, 0 blocked external requests. Evidence: `.data/automation-qa/report.json` and `screens/` (not committed) |
| 2026-10-21 | the same run's earlier attempts | found six real defects (listed in [studio-ui-and-builder.md](studio-ui-and-builder.md)), each fixed and covered by a test or a browser check |
| 2026-10-21 | full `npx vitest run` after the Studio screens, builder, canvas, migrations 0070 and 0071 | 3,625 passed, 1 failed (`workforce-navigation` "Chat with" shortcut, the same failure as on a pristine `HEAD`) |
| 2026-10-21 | `npm run typecheck` (project and scripts), `npx eslint src tests` and the new scripts | 0 errors, 0 problems |
| 2026-10-21 | `npm run build:clean` (Turbopack production build, clean typecheck) | exit 0; `/automation-studio`, `/automation-studio/[id]` and `/api/automation-studio/[id]/chat` are in the route list |
| 2026-10-21 (Phase C) | `node scripts/run-builder-eval.mjs --repeat 3`, DeepSeek `deepseek-flash`, 35 scenarios × 3 on the final code | 105 of 105 scenarios, 117 of 117 turns, 0 errors, 0 left invalid; median 3.2 s, p95 6.3 s per turn; 1.13 M input and 57 k output tokens. [ai-evaluation.md](ai-evaluation.md) |
| 2026-10-21 (Phase C) | `node scripts/automation-real-model-qa.mjs` (isolated app, real model, real Chromium) | 17 of 17: built from a sentence with nodes appearing one by one, saved, edited by chat on a selected step, an unsupported request refused in words with nothing changed, Manual undo reverts the builder's edit, the model key reaches no page, response or log |
| 2026-10-21 (Phase C) | `npm run typecheck`, eslint on every touched file, `npm run build:clean` | 0 errors, 0 problems, build exit 0 with `/automation-studio`, `/connections`, `/usage` and `/api/automation-studio/[id]/chat` in the route list |
| 2026-10-21 (Phase C) | full `npx vitest run` on the final code (256 files) | 4,260 passed, 1 failed: `appointments.test.ts` "queues a plain reminder…", which fails identically on a pristine checkout of the base commit 788f54d; the new `automation-builder-eval.test.ts` (16 tests) passes on its own; the 7 neighbouring Studio files re-run after the last edit: 312 passed |
| 2026-10-21 (Phase C) | `automation-browser-qa-c.mjs` and `automation-browser-qa.mjs` on the dev server, `automation-browser-qa-c.mjs` on the production build | 62/62 and 46/46 on dev; 62/62 on the production build. The original script cannot pass its model steps on a production build, correctly: the bundle refuses a loopback model ("The AI model address must be an https address. You can still build by hand."), which is the no-silent-fallback policy working |
| 2026-10-21 (Phase C) | a new layout check found a real defect | The home screen's "Usage and plan" and "Connections" links were overlapped by the main card by 16 px (`-mb-4` under Tailwind 4's `space-y`); fixed (`mb-6`, 24 px gap), the check failed on the old build and passes on the new one |
| 2026-10-21 | mutation checks: the old plan read in the shell query, and the old "still mounted" flag in the editor hook | the new tests fail on each, pass on the fix |
