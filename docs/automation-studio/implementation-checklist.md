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
- [ ] Agency UI to record a failed payment, a verified payment and an expiry (the services exist). *Phase 6.*
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
- [ ] HTTP request step (reuse `security/pinned-https.ts`; allowlisted hosts, secrets by reference, owner approval as an outside effect). Audited, not built: see [connector-audit.md](connector-audit.md); recommended next.
- [ ] "Send a real test to myself" distinct from the dry run.

## Phase 3: manual visual builder

- [x] Canvas technology decided and installed: `@xyflow/react` 12.12.0 (pinned). The CRM list editor stays as the Core editor.
- [x] Free positioning, drag-to-connect with validation, delete, duplicate, insert-after, palette (search and groups), zoom/pan/fit, mobile full-screen. → `src/components/automation-studio/canvas`, `tests/automation-studio-canvas.test.ts` (25 pure-layer tests); browser evidence below
- [x] Every gesture goes through `applyOperations` (draft mode); undo/redo through `history.ts`, rebuilt from the persisted trail; `add_step` can be `detached` for a drop onto empty canvas. → `tests/workflow-operations.test.ts`
- [x] Step settings reuse the CRM editor's panels (`StepPanel`, `TriggerPanel`), the test-run dialog, version history and restore-to-draft.
- [ ] Minimap; execution inspection overlay on the canvas (run history is still on the CRM run screens).

## Phase 4: AI Auto Mode

- [x] AI Automation Builder service, separate from AQi: stored conversation, streamed reply, operations validated by `parseOperations` then strict mode in a locked transaction, repair loop, plan, rate limit, monthly allowance, token counters. → `tests/automation-studio-builder.test.ts` (26 tests, scripted model)
- [x] Home screen ("What would you like to automate?"), 17 suggestions with workspace-readiness text, searchable categories; split-screen chat + live canvas that replays only operations the server accepted, resizable on desktop, tabs on a phone. → browser evidence below
- [x] Node-aware conversation (the selected step is sent with the message), failure explanations from recent run records.
- [ ] Evaluate with a real model (none is connected in this environment): operation quality, refusal rate, token cost per turn. [!] Needs the LLM connection verified in Integrations.
- [ ] The suggestions are prompts, not pre-built templates (Phase 6).

## Phase 5: integrations and AI employee nodes

- [x] Audit of existing connector infrastructure. → [connector-audit.md](connector-audit.md)
- [ ] Build the first connectors (HTTP request, then Slack incoming webhook; Google Sheets and Gmail). [!] Gmail and Sheets need a Google OAuth app and Google's scope verification, supplied by the founder.
- [~] AI employee node exists (`ai_task`); [!] live runs stay off until tool inventories are verified.
- [ ] Employee-node permission tests per role (a Receptionist-like role must not gain Lead Hunter tools through a workflow).

## Phase 6: templates and subscription experience

- [ ] 15 to 20 executable templates (5 exist), each with integration checks and a test.
- [x] Upgrade page ($299/month and the separate setup fee, what keeps working without the plan, provisional allowances, grace period, labelled example canvas, call to action to the existing Maintenance enrolment); locked sidebar entry; the route never exposes another workspace's automations. → browser evidence below, `tests/automation-studio-nav.test.tsx`
- [ ] Usage page for clients, agency lifecycle controls (record failed/verified payment), billing automation. [!] Payment provider choice.

## Phase 7: production hardening

- [ ] Browser E2E, accessibility, performance, tenant-isolation sweep on the new tables with a second workspace, hosted migration rehearsal, scheduler activation plan.

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
| 2026-10-21 | mutation checks: the old plan read in the shell query, and the old "still mounted" flag in the editor hook | the new tests fail on each, pass on the fix |
