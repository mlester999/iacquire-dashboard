# Automation Studio: implementation checklist

Dependency-aware. `[x]` is done **and** has evidence; `[~]` is partly done (the note says what is missing); `[ ]` is not started;
`[!]` is blocked on something outside the code. Evidence is a test file or a command that was run. Updated 2026-10-21.

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
- [ ] Persist the draft history and the operation log per workflow (needed so chat survives leaving and returning). *Phase 4.*
- [ ] Per-tenant fair claiming of due runs (risk R3).
- [ ] Interval and cron-style schedule triggers.
- [ ] For-each loops with an iteration cap; variables and safe data mapping between steps.
- [ ] HTTP request step (reuse `security/pinned-https.ts`; allowlisted hosts, secrets by reference, owner approval as an outside effect).
- [ ] "Send a real test to myself" distinct from the dry run.

## Phase 3: manual visual builder

- [~] Editor exists as a vertical branching list; the shared graph helpers now live in `src/lib/crm/workflow/graph.ts` (old path re-exports).
- [ ] Choose canvas technology (custom SVG vs `@xyflow/react`), then: free positioning, drag-to-connect, connection validation, zoom/pan/fit/minimap, node search and categories, mobile full-screen.
- [ ] Route every gesture through `applyOperations` (draft mode); wire undo/redo to `history.ts`.
- [ ] Node configuration panels for new kinds; execution inspection; version history and restore UI.

## Phase 4: AI Auto Mode

- [ ] AI Automation Builder service, separate from AQi (conversation store, structured output validated by `parseOperations`, strict mode, server context, budget from the `builder_*` counters).
- [ ] Welcome screen, suggestions, templates search; split-screen chat + live canvas that animates `WorkflowChange`s only after the server accepted them.
- [ ] Node-aware conversation (selected node), explain failures from run records.

## Phase 5: integrations and AI employee nodes

- [ ] Choose and build first connectors. [!] Each needs an OAuth app or API credentials supplied by the founder.
- [~] AI employee node exists (`ai_task`); [!] live runs stay off until tool inventories are verified.
- [ ] Employee-node permission tests per role (a Receptionist-like role must not gain Lead Hunter tools through a workflow).

## Phase 6: templates and subscription experience

- [ ] 15 to 20 executable templates (5 exist), each with integration checks and a test.
- [ ] Upgrade page ($299/month, honest scope, usage-cost disclosure, safe demo), locked state, usage page, agency lifecycle controls.

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
