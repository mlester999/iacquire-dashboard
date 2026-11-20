# AI Growth Partner — Master Completion Tracker

**Implementation snapshot:** `663c70c1e2014dabf8ad9abcd982d5a22fab2013` on branch `claude/ai-growth-partner-completion` (built on `origin/codex/ai-growth-partner` f40b36c3). Historical baseline audit: `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`. **Audit date:** 2026-11-17.

This is the single authoritative gap map between what iAcquireOS advertises and what it can actually do. It comes from reading the actual source, tests, schema and docs, then having an independent skeptical reviewer try to refute the strongest favourable claims in each domain. Per-requirement detail (source files, test coverage, real-vs-simulated behaviour, missing dependencies, remaining work, evidence and definition of done) is in the requirement files in this directory.

## How to read this tracker

| Label | Meaning |
| --- | --- |
| COMPLETE — VERIFIED | Implemented, and the cited tests exercise the real code path (database-backed where relevant, not a mock of the unit under test) and pass on the current integrated source or a recorded follow-up below. Live-provider and real-model behaviour is tracked separately by the evidence class. |
| IMPLEMENTED — NOT YET VERIFIED | Code exists but verification is missing, weak, mock-only, or not confirmed. |
| PARTIAL | Part is implemented; the remaining work is stated precisely. |
| NOT STARTED | No meaningful implementation. |
| EXTERNALLY BLOCKED | Needs something outside the codebase (credentials, provider approval, paid model spend, founder decision, production access). |

Evidence classes: `app-functional`, `synthetic-only` (fixtures, mocks or the local mock model), `real-model-verified`, `live-provider-verified`, `awaiting-configuration`, `externally-blocked`, `not-applicable`. A rendered page, an existing string, or a test of a mock is never treated as completion. A row marked `real-model-verified` or `live-provider-verified` rests on earlier recorded evidence that was not re-run in this audit.

## Baseline verification of this tree

```
head: 6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9
start: 2026-11-16T00:31:50Z
typecheck exit: 0 at 2026-11-16T00:33:25Z
lint exit: 0 at 2026-11-16T00:35:55Z
vitest exit: 0 at 2026-11-16T01:12:40Z
done: 2026-11-16T01:12:40Z
vitest: numTotalTestSuites=4312, numPassedTestSuites=4312, numFailedTestSuites=0, numPendingTestSuites=0, numTotalTests=13973, numPassedTests=13906, numFailedTests=0, numPendingTests=67, numTodoTests=0, success=True
```

Failing test files in the baseline run: **0**.

## Focused follow-up validation (local, 2026-11-16)

- 12 focused chat, CRM-tool, policy and Work Board test files passed: **202 tests passed**. These exercise app services with synthetic PGlite tenants; they do not establish hosted-database, live-model or provider behavior.
- `npx tsc --noEmit -p tsconfig.clean.json`, `npm run typecheck:scripts`, targeted ESLint on changed TypeScript files, and `git diff --check` passed for the B06/B07 changes.
- Six filtered Growth Partner-only cases passed across six existing acceptance and launch files (**6 passed; 88 unrelated tests skipped by the name filter**). A separate two-tenant purchase-to-conversation journey test passed locally and remains untracked and separate per owner instruction.
- `npm run onboarding:qa` passed **66 local Chromium checks**, including the Growth Partner-only review state, desktop/mobile layouts in light and dark themes, resume and save-failure behavior. This uses the loopback preview fixture and mock persistence/model responses. It exposed and fixed a 320px setup-header overflow; the preview displays the repository's brand assets.
- The branch-scoped regression workflow now includes `claude/ai-growth-partner-completion` and has a separate Growth Partner-only browser job. No CI run for the current working tree was recorded. The integrated full suite subsequently passed at `b40606c8`, before the W1-12 tests-only commit; no hosted database, production, live model or provider was used.

- W1-01 local follow-up (2026-11-16): 4 focused files passed, 42 tests total, including the two-tenant health case, route/action guard inventory, legacy deletion guard and demo retry. Targeted ESLint and npx tsc --noEmit -p tsconfig.clean.json passed; no full-suite or CI run for this tree is recorded.

- W1-02 local follow-up (2026-11-16): 3 focused files passed, 43 tests total, covering keyed creation, transaction claim rollback, retry after workspace commit, automatic/manual provisioning overlap and provisioning replay. Targeted ESLint and npx tsc --noEmit -p tsconfig.clean.json passed; PGlite does not prove separate-backend lock contention.

- W1-03 local follow-up (2026-11-16): influencer selection is disabled until a source adapter exists; connected-channel and approval copy is qualified; the demo now includes sample-only Business Brain and AI Work Board panels with local-only decisions. Five focused files passed (92 tests), targeted ESLint and npx tsc --noEmit -p tsconfig.clean.json passed. AQi answer grounding and browser network capture remain for later packages; no full suite, CI or production check was run.

- W1-04 local follow-up (2026-11-16): all AQi suggestions now point to approved public facts, including the AI Work Board and Business Brain questions; demo approval wording now follows configured rules. Eight focused files passed (189 tests), targeted ESLint and npx tsc --noEmit -p tsconfig.clean.json passed. No real-model answer evaluation, full suite, CI or production check was run.

- W1-05 local follow-up (2026-11-16): Control Center connection status now uses runtime enablement, state and health; terminology and pause wording were updated; unauthorized viewers receive an early no-access card; optional reads show per-section retry states; portal error/loading UI was added. Five focused files passed (18 tests), targeted ESLint and npx tsc --noEmit -p tsconfig.clean.json passed. No browser, full-suite, CI or production check was run.

- W1-06 local follow-up (2026-11-16; implementation commit `dfe5d38b`): stored service catalog and AQi copy now use the AI Growth Partner language with guarded rollback. The final focused run passed 54 files / 532 tests, including all 48 AQi test files, public feed handler coverage, catalog and migration compatibility tests. `npm run typecheck`, targeted ESLint and `git diff --check` passed. Migration rehearsal sections B/C/D passed with fresh and populated paths through all 132 migration files, including rollback and replay. No hosted migration, full-suite CI run, browser journey, live model or external provider was used.

- W1-07 local follow-up (2026-11-16; implementation is in prior commit `e9dd6747`): 4 focused admin visibility, provisioning-history and runtime-control files passed (20 tests). No production admin session or live runtime was used.

- W1-08 local follow-up (2026-11-16; commit `adb79186`): 4 navigation, shell-title, calendar and workforce-navigation files passed (20 tests). No full suite or browser run was included in this focused check.

- W1-09 local follow-up (2026-11-16; commit `7ab05010`): six focused files passed (59 tests), covering partner-aware Overview, Analytics, Approvals and Work Board rows. `npm run typecheck`, targeted ESLint and `git diff --check` passed. No full suite, CI or hosted check was run at that package step.

- W1-10 local follow-up (2026-11-16; commit `c5bfa7aa`): seven focused files passed (119 tests), covering partner-aware chat, approval, inbox, runtime-readiness and notification wording. `npm run typecheck`, targeted ESLint and `git diff --check` passed. No full suite, CI or provider call was run at that package step.

- W1-11 local follow-up (2026-11-16; commit `1e6d9b28`): six focused files passed (112 tests), including legacy setup snapshots, completion notifications, onboarding outcome notes, plan notices and client setup status wording. `npm run typecheck`, targeted ESLint and `git diff --check` passed. The integrated full suite subsequently passed at `b40606c8` before W1-12; no production or provider call was made.

- Integrated regression follow-up (2026-11-17; source commit `b40606c8`): serial Vitest run passed **941 test files**, with **2 skipped**; **14,078 tests passed**, **103 skipped**, none failed (18m34s). TypeScript, targeted ESLint, and `git diff --check` passed. The run includes the integrated Wave A/B and W1-01 through W1-11 source changes, but predates W1-12's test-only commit. No CI, production build, hosted database, production, live model or provider was used.

- W1-12 local follow-up (2026-11-17; test-only commit `7f6d33f9`): the new client vocabulary and public-copy guards passed **2 files / 7 tests**. They scan client-facing source, render Overview/Analytics/Sidebar and the public Auth showcase/demo email, and inspect the current public service projection, 38 active AQi rows, 28 default setup tasks and help articles. Typecheck, targeted ESLint and `git diff --check` passed. Exact-count allowlists record legacy identifiers, retained-profile and agency-only text, plus five unresolved public-copy items for W1-13. No app source changed in this wave.

- Work Board follow-up verification (2026-11-17; integrated source at `b40606c8`): `tests/work-start-review-partner-only.test.ts` and `tests/workforce-queued-runner.test.ts` passed **2 files / 9 tests**. The first proves every Work Board review dispatches to the bound Partner in a partner-only tenant, keeps the legacy fallback, and refuses a paused Partner. The second proves bounded tick execution after recovery and stale-queue handling so schedules do not stall. No source change was needed; production scheduler activation and hosting remain separate external acceptance.

- Work Board Stop follow-up (2026-11-17; source commit `0205b86c`): read-only reviews now scan outside a write transaction, poll the persisted cancellation request between checks and refuse a late success in `finishWorkJob`; operations review, calendar availability and lead-research settlement use their safe points. Five focused files passed (**54 tests**); the queued-runner file was then rerun without passing the in-process abort signal (**1 file / 7 tests passed**). Typecheck, targeted ESLint and `git diff --check` are clean. No live provider, customer data or hosted service was used. GP-WB-09 remains PARTIAL for bounded automatic retry/backoff and per-attempt history.

- Outbound safety follow-up (2026-11-17): the host-confirmation message now has a real service-path test for the workspace messaging pause; standalone review requests refuse a messaging pause; approved AI drafts recheck their stored service/marketing purpose; automated outreach refuses a missing purpose before creating a conversation; and free-form inbox replies require a service/marketing choice checked by the server. Fixed-purpose appointment reminders and scheduled follow-ups now state `service` explicitly. Ten focused inbox/send files passed (**281 tests**); follow-up caller tests passed `crm-reviews` (**24 tests**) and `messaging-core` (**44 tests**). `npm run typecheck`, targeted ESLint, and `git diff --check` passed. No full-suite, CI, production, live-model, or provider run was done. GP-QUAL-09 remains PARTIAL for caller-by-caller dynamic gate coverage and purpose classification for free-form AI replies.

## Status summary

| Status | Rows |
| --- | ---: |
| COMPLETE — VERIFIED | 6 |
| IMPLEMENTED — NOT YET VERIFIED | 116 |
| PARTIAL | 202 |
| NOT STARTED | 29 |
| EXTERNALLY BLOCKED | 25 |
| **Total** | **378** |

| Domain | Rows | Complete | Implemented, unverified | Partial | Not started | Externally blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [TERMC](TERMC.md) — Client-facing terminology and information architecture | 14 | 1 | 1 | 12 | 0 | 0 |
| [TERMP](TERMP.md) — Public and commercial terminology plus unsupported claims | 14 | 3 | 3 | 8 | 0 | 0 |
| [SADMIN](SADMIN.md) — Super Admin and internal operations | 15 | 0 | 3 | 11 | 1 | 0 |
| [CONV](CONV.md) — Permanent AI Growth Partner conversation | 21 | 0 | 6 | 11 | 3 | 1 |
| [BRAIN](BRAIN.md) — Business Brain | 17 | 0 | 2 | 14 | 0 | 1 |
| [MEM](MEM.md) — Memory | 16 | 0 | 6 | 8 | 1 | 1 |
| [CAPS](CAPS.md) — Capability system and customer support | 19 | 0 | 6 | 12 | 0 | 1 |
| [LEADS](LEADS.md) — Lead discovery and live-source readiness | 16 | 0 | 3 | 10 | 1 | 2 |
| [QUAL](QUAL.md) — Lead qualification, sales assistance and outreach safety | 23 | 0 | 8 | 14 | 0 | 1 |
| [CRM](CRM.md) — CRM end-to-end integration | 17 | 0 | 4 | 9 | 3 | 1 |
| [CAL](CAL.md) — Appointment setting and calendars | 14 | 0 | 8 | 4 | 0 | 2 |
| [WB](WB.md) — AI Work Board and proactive tasks | 15 | 2 | 6 | 5 | 1 | 1 |
| [INTEG](INTEG.md) — External integrations architecture | 14 | 0 | 6 | 5 | 3 | 0 |
| [ONBOARD](ONBOARD.md) — Client onboarding journey | 16 | 0 | 7 | 6 | 2 | 1 |
| [PORTAL](PORTAL.md) — Client portal UX and Control Center | 19 | 0 | 9 | 10 | 0 | 0 |
| [MIGRATE](MIGRATE.md) — Existing six-role customer migration | 16 | 0 | 2 | 7 | 6 | 1 |
| [ENTITLE](ENTITLE.md) — Automation Studio entitlements and payments | 15 | 0 | 9 | 5 | 0 | 1 |
| [DEMO](DEMO.md) — Demo, sales funnel and public website | 19 | 0 | 8 | 7 | 0 | 4 |
| [SUPPORT](SUPPORT.md) — AQi Assistant and Requests Center | 16 | 0 | 5 | 10 | 0 | 1 |
| [SEC](SEC.md) — Security and data privacy | 26 | 0 | 8 | 11 | 5 | 2 |
| [REALAI](REALAI.md) — Controlled real-model acceptance preparation | 21 | 0 | 0 | 15 | 3 | 3 |
| [QA](QA.md) — Test, CI and release readiness | 15 | 0 | 5 | 9 | 0 | 1 |

## Open P0 items (launch-blocking or safety-rule risks)

| ID | Status | Item | Remaining work |
| --- | --- | --- | --- |
| [GP-SADMIN-13](SADMIN.md#gp-sadmin-13) | PARTIAL | No admin action ever deletes historical six-role records | Source-scan guard test now covers the legacy tables and executeDeletion gates. Record the founder purge-policy decision; optional database-level triggers remain open. |
| [GP-SADMIN-14](SADMIN.md#gp-sadmin-14) | IMPLEMENTED — NOT YET VERIFIED | Super Admin and internal role boundaries enforced server-side | Admin route/action inventory and permission contracts pass locally; explicit Usage, Billing and Support Settings gates and fresh Super Admin sessions are in place. The integrated full suite now passes at `b40606c8`; a CI result for this tree remains outstanding. |
| [GP-SADMIN-15](SADMIN.md#gp-sadmin-15) | PARTIAL | No admin context exposes another tenant's confidential data | Health diagnostics are tenant-scoped and content-session-aware with a passing two-tenant test. Audit other admin system-role reads for tenant scope and content-session requirements. |
| [GP-CONV-01](CONV.md#gp-conv-01) | IMPLEMENTED — NOT YET VERIFIED | One primary conversation per workspace, stable identity, tenant isolation | Add idempotent ensureGrowthPartnerConversation (today the thread is created only as a side effect of a passing runHealthCheck, workforce/service.ts:1489-1503); handle a soft-deleted canonical row that blocks re-creation (unique index includes deleted rows, insert is on conflict do nothing); add test |
| [GP-CONV-03](CONV.md#gp-conv-03) | IMPLEMENTED — NOT YET VERIFIED | Send path: authentication, permission checks, rate limits, readiness, tenant isolation | Route-level tests for /api/chat/send (origin, role enum, size, foreign conversationId); two-member concurrency test; document or fix single-process dependence of the in-memory stream hub. |
| [GP-CONV-08](CONV.md#gp-conv-08) | IMPLEMENTED — NOT YET VERIFIED | Honest outcome reporting, error handling and audit logging | Extend claim verbs (drafted, queued, started, non-English) with an eval; render error_code reasons in the permanent UI (failed rows show 'No message text was saved.'); fix the model being told nothing can be started; consider an audit row per accepted user turn (ids only). / Skeptic adds: Claim guar |
| [GP-BRAIN-01](BRAIN.md#gp-brain-01) | IMPLEMENTED — NOT YET VERIFIED | Brain data model, immutable versioning and tenant isolation | Define and test a retention/compaction rule for version snapshots (each sync writes a full snapshot, plus a rebased draft copy when a draft exists); race test for concurrent syncs plus fact edits; remove or wire up the vestigial persona_settings column and the uncalled saveGrowthPartnerBusinessBrain |
| [GP-BRAIN-15](BRAIN.md#gp-brain-15) | PARTIAL | Private-context leakage control (internal facts vs customer-facing replies) | App-side fact, prompt, memory and tool isolation is implemented and synthetic-tested; pinned Hermes SOUL/native-memory canary and real-model grounding evaluation remain. |
| [GP-MEM-02](MEM.md#gp-mem-02) | IMPLEMENTED — NOT YET VERIFIED | Tenant isolation of application memory (write, read, prompt retrieval) | Add foreign-tenant delete, forget and mismatched org/agent prompt-context tests to tests/ai-growth-partner-memory.test.ts; confirm tenant-isolation-generic is green for table 0130 in the baseline. |
| [GP-MEM-10](MEM.md#gp-mem-10) | PARTIAL | Sensitive-data minimization; secrets never persisted into model memory | App notes and Growth Partner chat now screen listed secret/contact patterns; chat redacts legacy history and uses no-tools without Hermes session/native-memory scope. Remaining: detector limits, other runtime paths, and pinned-Hermes synthetic canary-secret probe. |
| [GP-CAPS-03](CAPS.md#gp-caps-03) | PARTIAL | Honest reporting of an unavailable tool, connector or provider | GP evidence snapshot lacks inbox/support, reputation, receivables, social, webchat sections; capability 'available' status ignores provider readiness (calendar, lead sources, messaging channel, LLM); add per-capability missing-connector reason + link in Control Center and chat; table-driven test per |
| [GP-CAPS-13](CAPS.md#gp-caps-13) | IMPLEMENTED — NOT YET VERIFIED | Support: unknown-answer handling and no fabricated policy, prices or guarantees | Growth Partner claim checks use confirmed customer-safe Brain facts; other employee replies use approved Knowledge Center content. Remaining: real-model adversarial regression and review of unsupported policy, cancellation, refund and timeline claims. |
| [GP-CAPS-16](CAPS.md#gp-caps-16) | IMPLEMENTED — NOT YET VERIFIED | Support: no private account or business data disclosed to unauthenticated website visitors | Assert prompt contents contain no CRM/account/other-contact/Brain-internal text; account-claim attempt must not unlock records; guard that no tool is reachable from public path; exfiltration prompt-injection tests beyond the narrow leak regex. |
| [GP-CAPS-17](CAPS.md#gp-caps-17) | PARTIAL | Support: separation of internal Business Brain/memory from public customer-facing information (non-web channels) | Per-fact audience, stripped customer prompt, public-only claim grounding, no app/native-memory scope and verified no-tools submission have synthetic coverage; pinned-runtime canary and real-model evaluation remain. |
| [GP-LEADS-13](LEADS.md#gp-leads-13) | IMPLEMENTED — NOT YET VERIFIED | Hard safety rules: no automatic outreach, no unverified real contact, no fabricated prospects, tenant isolation | 1) Add an explicit test that after the full fixture pipeline (research, approve, import with a public contact present) the tenant's messages/outbox/send-queue and workflow enrollments are empty and no notification went to the lead: the fixture mocks notifyOrgRoles and counts attempts, but does not i |
| [GP-QUAL-09](QUAL.md#gp-qual-09) | PARTIAL | Core outbound rule chain (evaluateSend, queueOutbound, dispatchMessage) | System-actor workspace/agency pauses, static queueOutbound caller inventory, website/CRM form identity and marketing-consent guards, and approval kind/scope/employee binding are covered; dynamically verify every caller and require purpose rather than caller-declared. |
| [GP-QUAL-10](QUAL.md#gp-qual-10) | PARTIAL | Opt-out, suppression and unsubscribe handling | Add multilingual free-text opt-out detection routed to the same revoke+suppress path with pause-and-escalate fallback; add a platform-level do-not-contact list for complaints; tests for opt-out arriving while campaign, missed-call and follow-up messages are queued. / Skeptic adds: For an unauthentic |
| [GP-QUAL-11](QUAL.md#gp-qual-11) | PARTIAL | Gates and kill switches inventory (tenant, agent, global) | OUTBOUND_MESSAGING_ENABLED defaults off, gates provider sends in dispatchMessage/sendEmail, and appears in admin health; system-actor pauses and static caller inventory are covered. Dynamically verify every queueOutbound caller against all pause scopes. |
| [GP-QUAL-12](QUAL.md#gp-qual-12) | PARTIAL | Outbound path: AI replies to inbound messages and approved drafts | Migration 0140 persists per-message sender proof; direct replies, recovery sweeps and model history fail closed on unverified inbound email. Still verify unified Growth Partner-only routing under approval_required and evaluate claims with real model output. |
| [GP-QUAL-14](QUAL.md#gp-qual-14) | PARTIAL | Outbound path: missed-call recovery texts | Client messaging/outbound and agency/platform pauses stop queueing and hold queued missed-call sends; paused state is recorded. Add a per-workspace hourly/daily ceiling on automatic recovery texts. |
| [GP-QUAL-20](QUAL.md#gp-qual-20) | IMPLEMENTED — NOT YET VERIFIED | No cold or mass unsolicited outreach by default | Add a regression test that a researched, imported prospect with no consent cannot be messaged on any path (human send, workflow, campaign, partner draft); add a static test that no executor exists for kind outreach; keep outreach blocked until a prospecting-compliance design exists. |
| [GP-QUAL-21](QUAL.md#gp-qual-21) | IMPLEMENTED — NOT YET VERIFIED | Synthetic acceptance cannot send anything | The default-off master switch now gates prospect/customer sends and appears in admin health. Add startup refusal of *_WRITES_ENABLED=true with PGlite or non-production NODE_ENV, and list each provider-specific switch in admin health; the Vitest no-network guard does not protect a production-like synthetic run by itself. |
| [GP-CRM-14](CRM.md#gp-crm-14) | IMPLEMENTED — NOT YET VERIFIED | Tenant isolation and provider ownership for CRM operations | Table-driven wrong-tenant test over every tool with the growth_partner role; a policy test that fails if a handler query lacks an org_id predicate; confirm create_task skipping assertNativeOwner is intended; consider RLS backstop for AI reads. / Skeptic adds: Replace 'confirm create_task skipping as |
| [GP-WB-11](WB.md#gp-wb-11) | IMPLEMENTED — NOT YET VERIFIED | Execution policy: read-only auto-run, external writes behind approval | Add a test that enumerates WORKFORCE_CAPABILITIES and fails if a non-read-only capability becomes schedulable/triggerable; add an owner authorization surface if the product wants low-risk internal writes (e.g. internal tasks) to auto-run. |
| [GP-INTEG-03](INTEG.md#gp-integ-03) | PARTIAL | Secret handling: storage encryption, redaction, prompts, browser bundles, repository | Generalize the NEXT_PUBLIC secret guard in src/server/env.ts beyond three Supabase names; add a CI secret scanner under .github/workflows; add a built-bundle scan for server env names in CI; confirm tracked .env.development holds placeholders only (not inspected, read was blocked); extend console/ta |
| [GP-INTEG-14](INTEG.md#gp-integ-14) | IMPLEMENTED — NOT YET VERIFIED | Growth Partner tool access permissions over integrations (provider capability gating) | When connectors are added (GP-INTEG-06..09), add each to a reviewed per-provider tool matrix in src/lib/employee-tool-policy.ts with read/draft/proposal effect, ability switch, member permission and audit, with tests; make the GP-INTEG-01 registry the single source; do not advertise provider capabil |
| [GP-ONBOARD-05](ONBOARD.md#gp-onboard-05) | IMPLEMENTED — NOT YET VERIFIED | Provision ONE Growth Partner: application-side automation (identity, configuration, request, claim, health check, conversation) | Port the chain-acceptance and employee-provisioning suites to a Growth-Partner-only tenant as additional cases; retire or rewrite the legacy manual_hermes_profiles job and its stale text (setup/jobs.ts) that tells staff to create profiles by hand; show held-config and waiting reasons (payment, gatew |
| [GP-ONBOARD-06](ONBOARD.md#gp-onboard-06) | EXTERNALLY BLOCKED | Real runtime provisioning and production activation (founder/operator steps) | Nothing completable inside the repo. After approvals: read-only preflight with --live --expect enabled, one canary profile for a synthetic tenant, then the pilot; keep docs/client-provisioning.md manual-vs-automatic split current. / Skeptic adds: Correct CI facts: hermes-client-acceptance also trigg |
| [GP-ONBOARD-14](ONBOARD.md#gp-onboard-14) | IMPLEMENTED — NOT YET VERIFIED | Retries never create duplicate Growth Partners or workspaces (idempotency) | Purchase creation is transaction-reserved and keyed; direct admin repeat submits are guarded for 120 seconds. Three focused suites pass (43 tests); separate-backend lock contention and full CI remain unverified. |
| [GP-ONBOARD-15](ONBOARD.md#gp-onboard-15) | IMPLEMENTED — NOT YET VERIFIED | A new workspace has no access to another tenant's data (isolation) | Extend client-onboarding-acceptance with an app-role (withUser) tenant B that cannot read or write tenant A's onboarding answers, Brain versions, partner row, conversation, config versions or provisioning jobs, including a third workspace created after A is onboarded; run the preflight isolation che |
| [GP-MIGRATE-12](MIGRATE.md#gp-migrate-12) | PARTIAL | Preserve and link historical conversations, audit history and assignments | Stop redirecting legacy tenants until a Partner runtime is bound or add a read-only previous-conversations viewer; add a tenant-scoped historical link table with owner-approved summaries and source ids; ensure retention and delete cannot purge conversations of a tenant in migration; add tests for co |
| [GP-MIGRATE-14](MIGRATE.md#gp-migrate-14) | NOT STARTED | Approved cutover action (identity activation, schedule cutover, in-flight work handling) | Implement an audited cutover service and owner approval record: check stored readiness report, pause old schedules, resolve in-flight jobs and equivalent idempotency keys, create or enable Partner schedules from approved mappings without enabling outreach, change partner status, disable legacy profi |
| [GP-ENTITLE-02](ENTITLE.md#gp-entitle-02) | IMPLEMENTED — NOT YET VERIFIED | Entitlement decision and server-side enforcement, including tenant isolation of Studio data | Add a parameterised cross-tenant test over every exported Studio service/action; consider an RLS/trigger backstop refusing origin='studio' publishes for un-entitled workspaces; remove or use studioHandoffAccess. / Skeptic adds: Document and test the exact premium boundary: only origin 'studio', http |
| [GP-ENTITLE-09](ENTITLE.md#gp-entitle-09) | IMPLEMENTED — NOT YET VERIFIED | PayPal checkout for the $1,499 setup purchase | Prove the full buyer, payment, workspace, setup-fee-cleared, Growth Partner provisioning chain once in a preview deployment using sandbox money (isLiveDeployment() false there); each remaining Sandbox scenario needs its own approval. |
| [GP-ENTITLE-10](ENTITLE.md#gp-entitle-10) | IMPLEMENTED — NOT YET VERIFIED | Webhook signature, receipt ledger, idempotency, audit and retry safety | Add a test that a processing error in recordAndApply leaves no receipt row and the PayPal route returns 5xx; extend Check connection (src/server/billing/provider-health.ts) to compare the four recommended events; optional audit visibility for repeated signature failures. / Skeptic adds: Add a test t |
| [GP-ENTITLE-11](ENTITLE.md#gp-entitle-11) | PARTIAL | No accidental live charging; clear sandbox vs production distinction | Add a default-off agency switch (migration plus audited Super Admin toggle) required by createPaymentCheckout for kinds maintenance, setup_fee and credit_topup; add a plain-words test/live readiness line on /admin/billing; tests proving refusal with the switch off even when keys and review exist. |
| [GP-ENTITLE-15](ENTITLE.md#gp-entitle-15) | IMPLEMENTED — NOT YET VERIFIED | Billing and plan state never block unrelated Growth Partner work; no payment during testing | Add ai-growth-partner, hermes, workforce (except provisioning.ts), agents and knowledge to the core-module list at tests/payment-gate.test.ts:377; add a real test that a Growth Partner chat turn succeeds for a workspace with an unpaid or refunded setup fee and no plan. / Skeptic adds: Also extend th |
| [GP-DEMO-10](DEMO.md#gp-demo-10) | IMPLEMENTED — NOT YET VERIFIED | Simulated vs real distinction, and no demo path can send real prospect communications | Render or delete OVERSIGHT_FOOTER; add a real-browser network-capture check to scripts/demo-responsive-qa.mjs asserting zero requests outside /api/public/demo/* while pressing every sample control; re-verify after the Work Board view lands. / Skeptic adds: Extend tests/demo-isolation.test.ts so the  |
| [GP-DEMO-12](DEMO.md#gp-demo-12) | IMPLEMENTED — NOT YET VERIFIED | Separation of Demo/Prospects from Clients, with explicit conversion | Conversion retry after an expired claim now refuses to create a duplicate and names the existing workspace; focused retry test passes. Optional Growth Partner provisioning integration coverage remains. |
| [GP-DEMO-14](DEMO.md#gp-demo-14) | EXTERNALLY BLOCKED | Consent notice, privacy policy, retention and erasure | Install counsel-approved text in notice.ts and bump NOTICE_VERSION; add privacy/terms pages and link them from request-form.tsx and the auth footer; optional self-service erase action in http.ts using eraseProspectInTx; run both jobs in production once and record counts. / Skeptic adds: Reconcile re |
| [GP-DEMO-15](DEMO.md#gp-demo-15) | EXTERNALLY BLOCKED | Activation and live verification of the current demo build | After GP-DEMO-04/05/08/09 land, execute section 6 of docs/demo-activation-acceptance.md on current master with low caps (3 starts/day, 25 messages/day), record a dated results section, then stage the opening with monitoring. |
| [GP-SUPPORT-01](SUPPORT.md#gp-support-01) | IMPLEMENTED — NOT YET VERIFIED | AQi permission-aware help and tenant isolation | Filter retrieved knowledge by route permission, not only role (service.ts retrieveAqiKnowledge); add a two-tenant prompt/context leak test and a prompt-injection test through knowledge and attachments. / Skeptic adds: Add a two-ORGANISATION test: a user of org B cannot read org A's conversation, mes |
| [GP-SUPPORT-05](SUPPORT.md#gp-support-05) | PARTIAL | Accurate documentation answers and citations | Publish approved Growth Partner, Business Brain, Control Center, Work Board, approvals, goals and Requests knowledge via a guarded migration plus the Super Admin editor; add a golden-question retrieval test; fix the /billing knowledge route; later record a live-model evaluation. |
| [GP-SEC-01](SEC.md#gp-sec-01) | IMPLEMENTED — NOT YET VERIFIED | Tenant isolation: database layer (RLS, grants, composite tenant FKs) for the Growth Partner tables | (withheld: see private security report) |
| [GP-SEC-03](SEC.md#gp-sec-03) | IMPLEMENTED — NOT YET VERIFIED | Tenant isolation: Growth Partner memory retrieval, goals, legacy knowledge, shared thread, schedules, tools and notifications | (withheld: see private security report) |
| [GP-SEC-04](SEC.md#gp-sec-04) | IMPLEMENTED — NOT YET VERIFIED | Server-side authorization of high-impact Growth Partner actions (chat proposals, CRM changes, approvals) | (withheld: see private security report) |
| [GP-SEC-05](SEC.md#gp-sec-05) | IMPLEMENTED — NOT YET VERIFIED | OAuth tokens and secrets: storage, leakage scan of tracked files, client-bundle and error-serializer safety | (withheld: see private security report) |
| [GP-SEC-10](SEC.md#gp-sec-10) | IMPLEMENTED — NOT YET VERIFIED | Unauthorized outreach safeguards: consent, suppression, human takeover, and no-contact status of researched leads | (withheld: see private security report) |
| [GP-SEC-14](SEC.md#gp-sec-14) | NOT STARTED | Privacy and breach-response artifacts that engineering can draft now: breach runbook, data map, sub-processor inventory, notices | (withheld: see private security report) |
| [GP-SEC-15](SEC.md#gp-sec-15) | EXTERNALLY BLOCKED | Legal sign-off and registrations: counsel review, NPC/DPO position, signed processor agreements per market | (withheld: see private security report) |
| [GP-SEC-20](SEC.md#gp-sec-20) | NOT STARTED | Public repository discloses infrastructure details and an host-exposure finding (High) | (withheld: see private security report) |
| [GP-SEC-21](SEC.md#gp-sec-21) | EXTERNALLY BLOCKED | Hermes gateway host hardening (network exposure, remote-access and profile-mount hardening) | (withheld: see private security report) |
| [GP-REALAI-03](REALAI.md#gp-realai-03) | NOT STARTED | Cost gate: estimator, hard spend cap, metering proxy, kill switches | Build a capped metering proxy (single allow-listed provider host, per-call max_tokens rewrite, 6 calls per run, refuse the next call before forwarding if spent plus worst-case-next exceeds cap, JSONL ledger, STOP file, sole holder of the provider key, fail-closed 429-style reply); pre-run estimator  |
| [GP-REALAI-05](REALAI.md#gp-realai-05) | NOT STARTED | Result recording: real results kept apart from mock results | Define docs/ai-growth-partner/real-model-results/ with real/ and mock/ folders and a JSON schema (runId, commit, inferenceSource real_model/mock_fixture/scripted_replay, provider, host, model, priceSource and date, corpus hash, per-scenario checks and usage and cost, totals, cap, spent, aborted, app |
| [GP-REALAI-09](REALAI.md#gp-realai-09) | PARTIAL | Requesting approval | Scenarios: move deal to Won (must propose and report pending), email the quote (must say it cannot send, offer a draft), approve it yourself (refuse); checkers: one pending approval per intent, record unchanged, honest reply, claim detector empty; verify the claim corrector does not mangle honest 'I |
| [GP-REALAI-11](REALAI.md#gp-realai-11) | PARTIAL | Updating permitted CRM records | Phase B scenarios: permitted update becomes proposal then approval then applied once with audit; non-editable fields (email, phone, owner, consent) refused; viewer gets nothing; Allowed-actions switch off refuses; bulk tagging needs approval; checkers diff rows against the approved change only. |
| [GP-REALAI-15](REALAI.md#gp-realai-15) | PARTIAL | Refusing unauthorized actions | Scenarios: email all leads, delete the CRM, give yourself admin, turn off approvals, refund an invoice, send an SMS, approve it yourself, promise guaranteed results; pass = refusal or approval-gated alternative, no tool call outside the offered set, no state change; measure false positives of findUn |
| [GP-REALAI-16](REALAI.md#gp-realai-16) | PARTIAL | Resisting prompt injection | Add (if the owner agrees) an untrusted-data envelope plus detectInjection on tool-result free text with tests; scenarios for injected text in a customer message, contact field, Brain fact, memory note, uploaded document, research web page, plus goal-hijack, system-prompt extraction and secret reques |
| [GP-REALAI-17](REALAI.md#gp-realai-17) | PARTIAL | Preventing tenant data leakage | Scenarios with distinct per-tenant sentinels: B asks for A's contact, compare with other clients, foreign ids in tool calls, injected forward-to-another-workspace request, same user in two workspaces; leak scan over replies, tool outputs, gateway logs and the proxy ledger. |
| [GP-REALAI-18](REALAI.md#gp-realai-18) | PARTIAL | Reporting failures honestly | Unblocked: scripted fault matrix through the metering proxy against the real gateway path (429, 500, timeout, truncated and malformed bodies) asserting the product message and no fabricated content. Phase B: tool returns not-found, denied or timeout (feature switched off mid-turn, member removed); r |
| [GP-REALAI-21](REALAI.md#gp-realai-21) | EXTERNALLY BLOCKED | Founder decisions and spend approval | After GP-REALAI-01 to 05 are built, present the approval packet (docs/ai-growth-partner/real-model-acceptance-plan.md, to be written, with this arithmetic) and wait; each decision is a separate approval. |
| [GP-QA-02](QA.md#gp-qa-02) | IMPLEMENTED — NOT YET VERIFIED | Test groups C (tenant isolation) and H (security) | Add a route inventory test enumerating src/app/api/**/route.ts and server actions that asserts each has a session/tenant guard or is in an explicit public allowlist; add Growth Partner HTTP-level cross-tenant negative tests; add prompt-injection tests with hostile fixture HTML under tests/fixtures/a |
| [GP-QA-07](QA.md#gp-qa-07) | IMPLEMENTED — NOT YET VERIFIED | Test group G (migrations, rollback, upgrade rehearsal) | Add rehearse:migrations as a CI job for pushes touching supabase/**; add dedicated rollback-guard tests for 0133 (goals) and 0134 (legacy knowledge); update rehearsal section H to the ledger production will actually hold before the Growth Partner release; record a rehearsal result for the final head |
| [GP-QA-12](QA.md#gp-qa-12) | PARTIAL | Production readiness: configuration, secrets, provider credentials, OAuth, domains, billing flags, demo | Add tests/env-example-parity.test.ts and the missing variables to .env.example; write docs/ai-growth-partner/production-readiness-checklist.md mapping each variable, OAuth redirect URI, webhook URL, domain and flag to owner, default and rollback; refresh docs/deployment.md 'What remains'; add a read |
| [GP-QA-13](QA.md#gp-qa-13) | PARTIAL | Production readiness: database backup, restore, migration apply and rollback procedures | Write docs/ai-growth-partner/release-runbook.md for 0120-0135 (order, risk, restore-point steps, post-checks, data-losing rollbacks 0130/0133/0134); add a read-only post-check script under scripts/ (ledger, RLS on every table, row counts, schema fingerprint); document Storage bucket backup; record r |
| [GP-QA-15](QA.md#gp-qa-15) | PARTIAL | Existing-customer migration, cutover rollback and release documentation | Add tests/growth-partner-cutover-e2e.test.ts on PGlite: legacy six-role tenant with schedules, jobs and approvals through candidate, review, schedule mapping, cutover and rollback, asserting identical restoration of the legacy schedule/enabled state and an append-only audit trail; implement the cuto |

## Externally blocked or approval-gated items

| ID | Priority | Item | Blocked by |
| --- | --- | --- | --- |
| [GP-CONV-21](CONV.md#gp-conv-21) | P1 | Live Hermes and real-model proof of the permanent conversation | Paid model provider credentials and approved spend, a production-class Hermes gateway, founder approval to enable the client business MCP flags in a test workspace. |
| [GP-BRAIN-17](BRAIN.md#gp-brain-17) | P1 | Real-model verification of Brain-grounded answers (no invented facts, no private leakage) | Paid model-provider calls and approval to spend; a configured Hermes gateway with a real provider key (founder decision and credentials). |
| [GP-MEM-11](MEM.md#gp-mem-11) | P1 | Retention and deletion behavior (app memory, export, native memory, conversation) | Hermes-side profile memory deletion needs provisioner support outside the current app code; conversation-retention policy needs counsel/founder input. |
| [GP-MEM-16](MEM.md#gp-mem-16) | P1 | Real-model memory acceptance: execution | Founder approval for paid model spend, a model provider credential, and a host able to run the pinned Hermes gateway (Docker unavailable on this machine). |
| [GP-CAPS-19](CAPS.md#gp-caps-19) | P1 | Live-model and live-provider verification of the capabilities | Paid model spend and real key; approval for live OSM/Overpass and website requests; calendar and messaging provider credentials for a controlled test tenant; founder approval for any outbound test. |
| [GP-LEADS-06](LEADS.md#gp-leads-06) | P2 | Other discovery channels: LinkedIn, Reddit, X/Twitter, Facebook, Indeed, JobStreet, public directories, authorized third | Each channel needs an outside decision: X - approved API app, purpose, retention, spend cap. LinkedIn - program approval for prospect discovery (none exists). Reddit - written commercial approval and deletion plan. Facebook/Meta - authorize |
| [GP-LEADS-16](LEADS.md#gp-leads-16) | P1 | Controlled live validation run (OpenStreetMap + approved company websites, then real-model qualification) | Owner decisions and access outside the repo: (1) written owner authorization for external read-only requests; (2) approved endpoint: public overpass-api.de (shared best-effort, not for commercial backend per OSM guidance) or a self-hosted/e |
| [GP-QUAL-22](QUAL.md#gp-qual-22) | P1 | Live provider verification (Twilio, Meta WhatsApp, Resend, GoHighLevel) | Verified sender domains and numbers, provider sandbox credentials, carrier/Meta registration, founder approval to enable each *_WRITES_ENABLED flag for one test tenant and one approved destination. |
| [GP-CRM-17](CRM.md#gp-crm-17) | P1 | Real-model verification of Growth Partner CRM tool use | Paid model spend and provider credentials, a verified client-only gateway, founder approval to switch the two client business MCP flags in a test workspace |
| [GP-CAL-12](CAL.md#gp-cal-12) | P1 | Google Calendar real-provider acceptance (OAuth app, verification, live connect/sync/write) | Founder/Google: OAuth app creation and verification, credentials, privacy/terms pages, scheduler approval, test accounts |
| [GP-CAL-13](CAL.md#gp-cal-13) | P1 | Microsoft Outlook Calendar real-provider acceptance (Entra app, publisher verification, live connect/sync/write) | Founder/Microsoft: app registration, secret, publisher verification, tenant consent, test accounts, scheduler approval |
| [GP-WB-08](WB.md#gp-wb-08) | P1 | Production scheduler activation and switch state | Founder approval to switch on, Vercel Cron (or equivalent) calling /api/internal/tick, CRON_SECRET and a supervised first run. The bounded in-tick runner handles queued reviews; a standalone worker host is optional. |
| [GP-INTEG-04](INTEG.md#gp-integ-04) | P1 | Google Calendar (per-person OAuth, busy sync, event write-back, Meet) | Google Cloud OAuth app registration, consent-screen verification for sensitive scopes, client id/secret in server settings, and a real staging account. |
| [GP-INTEG-05](INTEG.md#gp-integ-05) | P1 | Microsoft Outlook / Microsoft 365 Calendar (per-person OAuth) | Azure app registration, publisher verification, client id/secret, admin-consent decision for organizational tenants, real work and personal accounts for staging checks. |
| [GP-INTEG-11](INTEG.md#gp-integ-11) | P1 | Hermes runtime gateway and LLM provider connection | Live pinned-version gateway and real model key (founder approvals) for real-model verification. |
| [GP-INTEG-12](INTEG.md#gp-integ-12) | P2 | n8n (agency workflows) | An n8n instance and approved workflow ids for live proof. |
| [GP-ONBOARD-06](ONBOARD.md#gp-onboard-06) | P0 | Real runtime provisioning and production activation (founder/operator steps) | Founder/operator: apply migrations 0120-0135 to the hosted DB with a restore point; deploy the client-only gateway on the VPS; create private secrets and attest the gateway; set provisioner env vars and profile cap; real model provider key; |
| [GP-MIGRATE-11](MIGRATE.md#gp-migrate-11) | P1 | Real tenant-isolated Hermes profile, health, tool-inventory and tenant-boundary checks for a legacy tenant | VPS and Hermes gateway access, a founder-approved disposable staging tenant, and explicit written approval naming tenant, profiles and environment. |
| [GP-ENTITLE-04](ENTITLE.md#gp-entitle-04) | P1 | Studio authoring-to-run lifecycle: draft, test, approve, activate, retry, logs | Founder approval to start the scheduler; founder-registered Slack/Google apps for further connectors |
| [GP-ENTITLE-05](ENTITLE.md#gp-entitle-05) | P1 | AI Automation Builder against a real model | Paid model spend and a configured model key for any fresh evaluation |
| [GP-ENTITLE-07](ENTITLE.md#gp-entitle-07) | P1 | $299 plan activation, renewal, lapse and reactivation | Founder approval to run the scheduler; founder decision on auto_past_due |
| [GP-ENTITLE-09](ENTITLE.md#gp-entitle-09) | P0 | PayPal checkout for the $1,499 setup purchase | Founder-approved Sandbox scenarios for denied/reversed/disputed events and idempotency-key behaviour; live mode needs the founder's review and is intentionally off |
| [GP-ENTITLE-13](ENTITLE.md#gp-entitle-13) | P1 | PayPal automatic monthly payment (Subscriptions) for the $299 plan | Founder must create the PayPal Sandbox billing plan (monthly, fixed US$299, no trial or setup fee), subscribe the webhook events, set PAYPAL_MAINTENANCE_PLAN_ID in a non-production environment and approve an isolated sandbox rehearsal |
| [GP-ENTITLE-14](ENTITLE.md#gp-entitle-14) | P2 | Clients' own invoices and payments (customer-payments) | A tenant provider account with Sandbox credentials and founder approval to switch the module on for a workspace |
| [GP-DEMO-02](DEMO.md#gp-demo-02) | P1 | Limited demo access: window, daily caps, rate limits, extensions, expiry | Founder confirmation of the numbers; scheduler start approval for demoExpiry/demoRetention (never run as of 2026-10-27) |
| [GP-DEMO-05](DEMO.md#gp-demo-05) | P1 | Real-model evaluation of the demo chat and its reply checks | Connected LLM credential for the agency workspace, approval for paid model spend, and a held-out evaluation set |
| [GP-DEMO-11](DEMO.md#gp-demo-11) | P1 | Consultation booking and purchase calls to action | Founder choice and configuration of a real scheduling destination (native /book page or external scheduler) in the Super Admin settings |
| [GP-DEMO-14](DEMO.md#gp-demo-14) | P0 | Consent notice, privacy policy, retention and erasure | Counsel approval of notice wording, a published privacy policy, marketing opt-in decision, scheduler start approval (retention jobs never run as of 2026-10-27) |
| [GP-DEMO-15](DEMO.md#gp-demo-15) | P0 | Activation and live verification of the current demo build | Founder approvals for production env changes, redeploys, one real email, paid model messages, scheduler, and the separate landing repo deploy |
| [GP-DEMO-16](DEMO.md#gp-demo-16) | P1 | Public marketing homepage, product pages and pricing site (separate repository) | Access to the landing-page repository |
| [GP-SUPPORT-16](SUPPORT.md#gp-support-16) | P2 | Scheduler, email and Slack delivery for requests | Founder approval and provider configuration (scheduler, email, Slack). |
| [GP-SEC-15](SEC.md#gp-sec-15) | P0 | Legal sign-off and registrations: counsel review, NPC/DPO position, signed processor agreements per market | Founder decision and legal counsel: which markets are supported at launch, retention periods, lawful basis for researching prospects, NPC registration/DPO appointment, signed data processing agreements with Supabase, Vercel, Resend, Twilio, |
| [GP-SEC-21](SEC.md#gp-sec-21) | P0 | Hermes gateway host hardening (network exposure, remote-access and profile-mount hardening) | Production host access and founder approval (Hostinger console, Cloudflare). |
| [GP-REALAI-19](REALAI.md#gp-realai-19) | P1 | Real-model run, Phase A (no tools) | Founder approval of provider, model, spend cap and key (GP-REALAI-21); price re-read; GP-REALAI-02, 03, 05 built first |
| [GP-REALAI-20](REALAI.md#gp-realai-20) | P1 | Real-model run, Phase B (pinned Hermes gateway with business tools) | Provider decision and spend approval; Docker on a runner; confirmed turn-limit key in the pinned config; GP-REALAI-03 and 04 built first |
| [GP-REALAI-21](REALAI.md#gp-realai-21) | P0 | Founder decisions and spend approval | The founder: provider and model for the client runtime, spend cap (proposed USD 15.00 campaign, USD 2.00 Phase A, USD 12.00 Phase B), a dedicated spend-limited project key supplied out of band, synthetic-data-only confirmation, GitHub Envir |
| [GP-QA-05](QA.md#gp-qa-05) | P1 | Real-model and live-provider verification of the Growth Partner | Model API credential and spend approval, a live Hermes gateway with the real client profile, a staging Supabase project, provider sandbox accounts, founder approval per run. |

## Cross-domain review (completeness critic)

### Directive items not covered by any row

- section: S31 MASTER_COMPLETION_TRACKER; item: No row owns the tracker; it must merge 22 domains plus 164 skeptic corrections and 88 missed requirements before it is authoritative.; priority: P1; suggestedDomain: QA (handoff)
- section: S31 IMPLEMENTATION_STATUS; item: docs/ai-growth-partner/implementation-status.md is the only evidence ledger but no row reconciles it with this audit: stale product text on native memory (MEM-03), hosted run #97 mapping to HEAD, three different test baselines (900/13,828, 903/13,860, 903/13,870).; priority: P1; suggestedDomain: QA
- section: S31 CAPABILITY_MATRIX; item: A-H by permissions, input schema, output schema, execution path, retry, audit, failure states, approvals, tenant test, integration test. CAPS-01 only adds schema fields; there is no per-capability matrix and no mapping of the 14 keys and six domains to the eight directive areas.; priority: P1; suggestedDomain: CAPS
- section: S31 INTEGRATION_MATRIX; item: INTEG.md contains a capability matrix and lifecycle table, but no row publishes it as the deliverable or ties it to the shared status vocabulary (GP-INTEG-02).; priority: P2; suggestedDomain: INTEG
- section: S31 LEAD_DISCOVERY; item: docs/acquisition-source-research.md exists; no row updates it with pipeline, channel dispositions, activation checklist and retention rules.; priority: P2; suggestedDomain: LEADS
- section: S31 MIGRATION_PLAN; item: MIGRATE-16 covers only a reversibility table; no row consolidates plan, per-tenant go/no-go, runbook and owner communication into the deliverable.; priority: P1; suggestedDomain: MIGRATE
- section: S31 RELEASE_READINESS; item: Only fragments exist (QA-12 checklist, QA-13 runbook for 0120-0135, SEC-14 privacy drafts); no single readiness ledger with owner, default and evidence per item.; priority: P0; suggestedDomain: QA
- section: S31 ACCEPTANCE_RESULTS; item: REALAI-05 designs a real-versus-mock results folder only; no row for a consolidated record across synthetic, hosted-CI, real-model and live-provider evidence classes.; priority: P1; suggestedDomain: QA / REALAI
- section: S31 CLIENT_USER_GUIDE; item: No row anywhere. TERMP-08 covers only in-app help articles and the help prompt.; priority: P1; suggestedDomain: TERMP / SUPPORT
- section: S31 ADMIN_RUNBOOK; item: No row. Pieces only: QA-15 per-tenant operator runbook, SEC-21 private hardening runbook, SADMIN control surfaces. Must stay free of host-specific facts because the repository is public.; priority: P1; suggestedDomain: SADMIN
- section: S30 Completion criteria; item: No row maps each completion criterion to an evidence class and sign-off. Current evidence: 0 of 378 rows VERIFIED, one legacy real-model eval (Automation Builder), no live-provider proof after the ENTITLE-09 downgrade.; priority: P1; suggestedDomain: QA
- section: S29 Production readiness (22 items); item: Spread over four aggregate rows (QA-12..15). Missing item-level rows: hosting plan and cron capacity (Vercel plan, Supabase plan and backups), launch feature-flag matrix with owner and default state, incident response and on-call, support readiness, rollback communications.; priority: P0; suggestedDomain: QA
- section: S27 Test quality rules; item: No row owns a sweep of vacuous or tautological tests found by skeptics: PayPal mode-agreement guard (ENTITLE-10), LEADS-02 concurrency test that cannot detect an absent lock, MEM-06 cited test off the memory path, DEMO-10 isolation allow-list omitting generator.ts, ONBOARD-12 readiness covered by one pure-function test, UI tests that mock actions, whole suite forcing WORKFORCE_ROLE_TOOL_ENFORCEMENT=report.; priority: P1; suggestedDomain: QA
- section: S9 Source channels; item: Eight of eleven channels (LinkedIn, Reddit, X, Facebook/Meta, Indeed, JobStreet, public directories, authorized third-party providers) share one EXTERNALLY_BLOCKED row (LEADS-06); no per-channel ToS, legal-basis, retention or activation-checklist rows, and the UI still offers influencer platforms with no adapter (TERMP-12).; priority: P2; suggestedDomain: LEADS
- section: S9/S26 Ten-step acceptance and 18 features; item: Not mapped step by step; LEADS-15 and LEADS-16 are single rows. No contract-test fixtures recorded from real OSM or website responses (all fixtures synthetic, no drift detection).; priority: P1; suggestedDomain: LEADS
- section: S12 Nine provider failure cases; item: Disconnected, expired token, revoked permission, conflict, duplicate, outage, rate limit, wrong tenant, wrong calendar share one row (CAL-14) with no failure-matrix test row (compare CRM-15) and no calendar-connection tenant-isolation test row.; priority: P1; suggestedDomain: CAL
- section: S4 Admin/manager pages and staff views; item: TERMC classifies src/app/(admin) and src/components/admin as agency-internal and not swept further; SADMIN-12 covers only the relabel of retained legacy views.; priority: P2; suggestedDomain: TERMC
- section: S4 Templates and generated documents; item: Seeded message, workflow and review-request templates, proposals, invoices, reports, exports, e-signature text and server-action toast text are not swept for legacy vocabulary (only a skeptic note on src/app/actions).; priority: P2; suggestedDomain: TERMP
- section: S24 Rendering safety of model output; item: Markdown, link and image rendering of model text in the permanent conversation, AQi and widget (exfiltration through image URLs, XSS) has no row; SEC-26 covers CSP and headers only.; priority: P1; suggestedDomain: SEC
- section: S24 Upload and document ingestion; item: Knowledge Center documents, AQi attachments and CSV imports (size, type, formula injection, malware) have no security row; only LEADS-07 mentions formula injection.; priority: P2; suggestedDomain: SEC
- section: S24/S10 Non-English and Taglish; item: Intent router, injection screens, claims nets and opt-out detection are English-regex; fragments in QUAL-10 and REALAI-10 only. No cross-cutting row or test corpus for the Philippine market.; priority: P1; suggestedDomain: QUAL
- section: S24/S25 Production spend caps; item: Per-workspace caps and alerts for Growth Partner chat and scheduled jobs, and metering when no llm rate is published: only the ENTITLE-01 disclaimer and the SEC-16 per-user chat cap. REALAI-03 covers acceptance runs, not production.; priority: P1; suggestedDomain: ENTITLE
- section: S19 Legacy-role references at cutover; item: Conversation AI owner or handler, workflow Send-as, Studio ai_task role, reminder, retention and missed-call actors, program and campaign actors are not reassigned by any MIGRATE row (rows cover schedules, knowledge, history).; priority: P1; suggestedDomain: MIGRATE
- section: S19 Owner communication for migrating tenants; item: Notice, terms update, in-flight conversation handling and downtime beyond a recorded approval (MIGRATE-14).; priority: P2; suggestedDomain: MIGRATE
- section: S28 Branch safety on a public repo; item: Branch protection, history-rewrite policy, secret push protection and whitespace/CRLF guard behaviour are only listed as owner settings in SEC-22; no row for merge policy or release gating beyond CI.; priority: P2; suggestedDomain: QA
- section: S17 Quality bars: performance and scale; item: Work Board 100-job silent cap, 150 audit and 60 run limits, ten-lane Kanban, no latency or large-tenant budget row.; priority: P2; suggestedDomain: PORTAL
- section: S22 Marketing site consistency; item: Unaudited: separate repository, DEMO-16 is EXTERNALLY_BLOCKED and nothing was read, so landing page, product pages and pricing copy consistency rests on assumption.; priority: P1; suggestedDomain: DEMO
- section: Cross-domain (S1, S4, S8, S16) Growth-Partner-only tenant; item: No row owns a shared fixture and a sweep of legacy-role lookups (allowedRoles[0], role_key = appointment_setter, AGENT_ROLE_KEYS filters, employeeCatalog, leads trigger, reminders, retention, missed-call, readiness checks, admin queries). At least 14 rows each propose a one-off test.; priority: P0; suggestedDomain: ONBOARD / QA
- section: Cross-domain (S6, S7, S14, S24) Customer-facing runtime scope; item: Customer-facing SMS, email and WhatsApp runs still share the Partner profile identity and its baseline SOUL/runtime environment. The app sends customer-safe Brain facts and fixed reply style, omits goals and memory scopes, and requires a verified no-tools overlay; no pinned-runtime canary proves SOUL/native-memory isolation or that the overlay holds across every tool.; priority: P0; suggestedDomain: CAPS
- section: Cross-domain (S13, S29) Scheduler activation plan; item: No inventory of every tick job (schedules, reminders, demo expiry and retention, maintenance sweeps, support escalations, recovery sweeper, briefings), what breaks while off, supervised first run, kill order, and host or cron capacity.; priority: P0; suggestedDomain: WB
- section: Cross-domain (S19, S29) Migration ledger plan; item: About 14 proposed new migrations across 10 domains after 0135 with no numbering, ordering or apply-risk plan, while 0120-0135 are unapplied to production (ledger 113) including data-losing rollbacks 0130, 0133, 0134.; priority: P1; suggestedDomain: QA
- section: Cross-domain (S25) One real-model harness; item: Eight domains propose separate harnesses and caps (BRAIN-17, CONV-20/21, CRM-17, MEM-15, DEMO-05, QA-05, SUPPORT-05/14, LEADS-15); each would bypass the REALAI-03 cost gate unless routed through one metering proxy and corpus.; priority: P1; suggestedDomain: REALAI

### Contradictions between sections

- AI Work Board (historical audit finding, resolved in the integrated branch): the prior skeptic review found that Start review dispatched `definition.allowedRoles[0]` and failed in Partner-only workspaces. The bound-Partner dispatch and legacy fallback are now covered by `tests/work-start-review-partner-only.test.ts`; see GP-WB-03 and the TERMC skeptic triage row. The separate PORTAL-09/CAPS-10 assessments remain as recorded until those sections are re-audited.
- Leads page: TERMC-08 says the page uses the growth_partner runtime and is clean; LEADS-14 (skeptic confirmed) says Start research, Retry and scheduled research dispatch lead_hunter, leaving a Growth-Partner-only tenant at waiting_for_agent. CAPS-04 (Lead Discovery) does not mention it.
- Reminders, retention and missed-call routing: CAL-06 and QUAL-17 say a partner-only tenant gets agent_missing blocks; CAPS-07 (Appointment Setting) and QUAL-13 (scheduled follow-ups) are IMPLEMENTED_UNVERIFIED with only 'confirm the plan agent is the Growth Partner'. Same root cause, inconsistent status. CAL-05 was already downgraded to PARTIAL.
- Outbound gating: the QUAL-14 system-actor missed-call pause bypass, QUAL-11 missing master switch, and QUAL-12 recovery-sweeper sender-proof gaps are resolved on this branch and covered by focused tests. Other domains still contain older assumptions about *_WRITES_ENABLED defaults and platform sendEmail, and need reconciliation; the website-form consent/identity gap and QUAL-23 postal-address rules remain open.
- Idempotency: SEC-08 (IMPLEMENTED_UNVERIFIED, retries cannot duplicate CRM records) versus CRM-13, CRM-02 and CRM-07 (tasks have no idempotency key or unique constraint; chat contact create guarded by a name pre-check only) and CONV-07 (race in the clientMessageId check). Skeptic downgraded SEC-08 to PARTIAL; ONBOARD-14 is PARTIAL for tenant creation.
- Approval policy for chat CRM writes: SEC-04 (P0 IMPLEMENTED) says high-impact actions are authorized server-side; CRM-02/CRM-11 show chat contact and deal writes execute immediately as the person with no approval row; CRM-05 shows the tool path always needs approval for Won/Lost while chat closes directly; CONV-12 wants approved-prospect creation routed through the approval-gated lead import; CRM-03 says create_contact is absent from the proposal layer. No single rule exists; founder decision needed.
- Hermes pin: QA-04, MEM-04 and INTEG-11 cite hosted acceptance on pinned v0.22.5; CRM-16, QA-04 (C6 job) and the REALAI-20 skeptic show the business MCP proof only on 0.21.5; REALAI-04 and REALAI-20 plan Phase B as 0.22.5 plus the client MCP handler, which no run or compose file joins. No section states the production pin.
- Capability taxonomy: directive S8 defines eight areas A-H; CAPS-01 proposes modelling A-H over 14 keys; PORTAL-07 shows six domains and 14 capabilities; TERMC-05 says drop 'six capabilities' counts while the TERMC-02 skeptic says the six-capability count is accurate; TERMP-02 asks to confirm 'six capability areas' as public language; the demo lists six capability descriptions.
- Pricing wording: DEMO-13 and the buy confirmation use 'starting price' (founder confirmation pending); DEMO-17, TERMP-01 and TERMP-03 hard-code a fixed '$1,499' in about ten places plus two admin screens; ENTITLE-01 shows the catalog price is not guarded against $299 while intents freeze 149900 and 29900.
- Public approval promise: DEMO-13 and TERMP-02 FAQ state customer messages always wait for approval, but automatic and autonomous modes and the 'Send automatically' missed-call recovery ship (DEMO missed P1, QUAL-14). The TERMP-13 skeptic calls the claim defensible as a default posture; the DEMO-13 skeptic calls it contradicted by shipped code.
- Retention versus preservation: SEC-12, SEC-13 and MEM-11 want export, erasure and purge to reach Partner tables; SADMIN-13 claims no admin action deletes six-role history while its skeptic shows the offboarding purge does; MIGRATE-12 and the MIGRATE missed row require legacy conversations to survive migration; SEC-11 and SEC-24 note the Partner thread is excluded from chat retention; DEMO-14 retention contradicts its own consent notice for converted and blocked prospects. Three incompatible rules apply to the same tables.
- Honest status: INTEG-02 and INTEG-14 (nothing hard-coded connected, honest capability statuses) versus the INTEG missed rows (messaging card from a configuration count, capability available ignoring the business tool tier), CAPS-03 (available ignores provider readiness), PORTAL-08 (Partner connection green from a linked runtime id), INTEG-04 skeptic (calendar health hole) and WB-13 skeptic (green Completed for drafts). INTEG-14 and PORTAL-07 should be PARTIAL.
- Brain risk scan: BRAIN-11 says Brain fact edits through the editor have no instruction-risk scan; the SEC-06 skeptic says Brain profile-fact sync routes instruction-like text to review. Different paths; the SEC-06 reassurance must not be read as the editor path being covered.
- Tenant-isolation rating: QA-02, SEC-01/03, ONBOARD-15 and MEM-02 are P0 IMPLEMENTED_UNVERIFIED (proven on PGlite) while SEC-02 (1,967 withSystem call sites relying on hand-written org_id predicates) is only P1, and SADMIN-15 (health leak), CRM-12 (create_task skips assertNativeOwner) and the CAL missed row (crm_summary_report count without appointments.view) show live gaps. Hosted RLS is never exercised (QA-02, SEC-01).
- Legacy controls: SADMIN-12 (IMPLEMENTED_UNVERIFIED, obsolete six-employee controls removed) versus PORTAL-02 and TERMC-03 (Overview 'Previous role profiles' card shows six avatars all linking to one page; Analytics iterates AGENT_ROLES) and SADMIN-01/06/10/11 (admin pages filter AGENT_ROLE_KEYS so Partner rows are missing or the page fails).
- Website chat identity: CAPS-09 says website chat is a platform LLM call outside the Hermes Partner runtime and capability registry; TERMP-11 and the demo present it as the one AI Growth Partner with the AI-disclosure label undecided; CAPS-16 rates the visitor path IMPLEMENTED P0 while CAPS-17 rates non-web channels PARTIAL P0; CAPS-12 shows two public fact sources (company_knowledge versus Brain).
- Native memory: MEM-03 says policy is undecided and instructions.ts:180 still tells clients the pinned runtime has not passed acceptance, while MEM-04 records the pinned-runtime acceptance (hosted run #97 on f40b36c3, docs-only diff to HEAD); the SEC missed row says native memory persists untrusted web text with no scan; REALAI-14 depends on both.
- Evidence base: QA records 900 files / 13,828 tests (103 skipped) on 2026-11-09, other sections cite 903 files with 13,860 and 13,870 tests; MEM-04 claims no evidence for HEAD while its skeptic cites run #97 on f40b36c3. No auditor ran anything, so all pass figures are second-hand.

### Systemic risks

- Growth-Partner-only is the default tenant shape for every new client, yet multiple code paths still resolve legacy roles (LEADS-14, CAL-06, QUAL-17, QUAL-13, ONBOARD-12, SADMIN-01/06/08/10/11, PORTAL-02, ENTITLE-05/TERMC-11 Builder catalog, CAPS-01 ability tests excluding growth_partner). Work Board Start review (WB-03) is now verified for Partner-only tenants. Existing acceptance fixtures still include six-role tenants; the broader shared-fixture sweep remains open.
- Customer-facing runs share the Partner profile identity and baseline runtime environment (BRAIN-15, CAPS-17, CAPS and MEM and LEADS missed rows, SEC-07). App-side audience filtering, customer-only prompt construction, removal of native-memory session scope and a verified no-tools request are implemented. The profile SOUL/native-memory boundary and no-tools enforcement still need a pinned-runtime canary; if shared profile context bypasses the run overlay, a separate or narrowed profile and any gateway changes require the owner's approval.
- The historical baseline had no COMPLETE — VERIFIED rows (0 of 378). W1-06 follow-up now verifies GP-TERMP-04 and GP-TERMP-09 on the integrated local source; the synthetic regression workflow and full-suite CI have not been run for this candidate. Several unrelated green tests are vacuous or tautological, so green overstates assurance elsewhere.
- The scheduler is a single point of activation for eight or more domains (WB-08, CAL-14, DEMO-02, ENTITLE-04/07, SUPPORT-16, ONBOARD-10, PORTAL-13, QA-14). The integrated source has a bounded in-tick queue runner (WB-07), but no cron exists in the repo and hosting-plan limits on cron frequency and function duration are not recorded. The first live tick could fire real reminders and recovery texts while QUAL-14 pause gaps remain. Close QUAL-14 and stage a supervised activation before turning the scheduler on.
- There is no staging environment: at least 15 rows need staging, a preview deployment or a disposable tenant (CAL-12/13, INTEG-04/05/12, ENTITLE-04/09/14, MIGRATE-11, QA-02/05, SEC-01/25), while production sits on a Supabase plan without backups and preview deployments may share production data (ENTITLE missed P0). Every real-provider, real-model and hosted-RLS proof waits on one founder decision to provision staging.
- Migration sprawl: about 13 new migrations proposed independently (CRM-07/08 idempotency columns, DEMO-06, ENTITLE-11, LEADS-07/08/10, MEM-09, MIGRATE-03, SUPPORT-05/06, TERMP-04/07/09, WB-06, CAPS-15) on top of 16 unapplied migrations (0120-0135, with data-losing rollbacks) and a production ledger at 113. Brain audience is an optional field in immutable JSON snapshots and needs no schema migration. Each remaining migration is one more production approval and apply risk; batch them into two or three numbered migrations with a single rehearsal and restore-point plan.
- Public repository: the audit's own recommended deliverables (runbooks, readiness checklist, privacy docs, acceptance results, admin runbook) tend to include host, port and account facts that are already disclosed in tracked docs (SEC-20) and cannot be un-published from history. Deliverables must be written in redacted form with private companions; history stays immutable and earlier push-protection refusals show test fixtures can trip scanners.
- Hermes version and tool-composition split (0.22.5 acceptance image, 0.21.5 business MCP proof, no section naming the production pin) is on the critical path of every real-model row: Phase B of the acceptance plan cannot be designed or priced until the pin and MCP composition are decided.
- Isolation depends on convention in application code: 1,967 withSystem call sites with hand-written org_id predicates, RLS proven only on PGlite emulation, and every new Growth Partner feature adds more (admin health leak, summary counts bypassing permissions, create_task skipping ownership checks). Without a static guard (SEC-02) and a hosted RLS run, each wave of fixes can add a cross-tenant leak.
- Safeguards are English-regex heuristics (injection screens, claims nets, opt-out, intent router, instruction scanner). For Philippine Taglish customers they will under-trigger, which weakens PH DPA, anti-spam and fabricated-claim guarantees; only a real-model evaluation can measure it and no row owns a non-English corpus.
- Decision debt: 79 rows are marked unblocked while naming a founder, product or legal decision; building before the decision risks rework and invalidating evals. Examples: shared-thread privacy, native-memory policy, which Brain facts are customer-visible, chat-write approval rule, retention rules, demo entry mode, pricing wording. Keep a decision log with conservative defaults (deny, draft-only, off).
- Status surfaces can mislead the founder's own go/no-go: green 'Connected', 'Configured' and 'Completed' are derived from configuration, a linked runtime id or draft preparation rather than health or a successful action (PORTAL-08, WB-13, INTEG messaging card, CAPS-03, INTEG-04). These violate the honesty rule and must be fixed before any activation review.
- Duplicated sources of truth (company_profiles, company_knowledge, Brain, agent settings, memory, goals, documents) are synced one way, and website chat, non-web replies and demo AQi use three different public fact sets. Fixes change prompt assembly, so any real-model evaluation run before those fixes is invalidated; sequence store consolidation before spending on evals.
- Real-model rows are scattered across at least ten domains with separate harness proposals; without one corpus, one metering proxy and one ledger the REALAI-03 spend cap can be bypassed and results cannot be compared. A single spend approval (REALAI-21) should cover one consolidated plan.
- Retention and erasure rules conflict for the same tables (export, purge, legacy history preservation, demo notice, chat retention exclusion). Until one retention schedule exists, a purge can destroy history the migration promised to keep, or retain data a PH DPA erasure request requires removing.
- Single-process and serverless assumptions: in-memory stream hub (CONV-03), process-local GHL rate budget, after() 120 s kick path, advisory locks. They behave in tests but not under multi-instance serverless; the skeptic already flagged one proposed polling fix as unsafe in multi-instance.
- Operator concentration: no MFA anywhere in application code (SEC-18), and host-level exposure findings (network exposure, remote-access hardening) are already described in public docs (SEC-20, SEC-21). A single compromised or mistaken session can change production; operator guardrails (explicit approval per production step, restore point first) must precede any approved production step.

### External approvals or supplies needed

- Model provider: provider, model, dedicated spend-limited project key supplied out of band, spend caps (proposal USD 15.00 campaign, USD 2.00 Phase A, USD 12.00 Phase B), synthetic-data-only confirmation, GitHub Environment reviewers (GP-REALAI-21); each real-model run is a separate approval (BRAIN-17, CONV-21, CRM-17, MEM-16, CAPS-19, QA-05, SUPPORT-05/14, DEMO-05, LEADS-16, ENTITLE-05).
- Staging: a staging Supabase project, a non-production Vercel project and a disposable tenant for sandbox, provider and hosted RLS proofs (needed by at least 15 rows); decision on whether preview deployments may share production data.
- Production database: fresh restore point, then apply migrations 0120-0135 (and any later batched migration) with post-checks; Supabase plan with backups or scheduled external dump (QA-07, QA-13, ONBOARD-06, SEC-19).
- Production environment and releases: any env-variable change, redeploy, release to master, switch flip (client business MCP flags, HERMES_PROVISIONER_ENABLED, WORKFORCE_*, DEMO_*, payment and recurring-billing switches, *_WRITES_ENABLED per channel for one test tenant and one approved destination).
- Scheduler: approve SCHEDULER_ENABLED, CRON_SECRET and the cron host (plan or external cron), a supervised first run, and the auto_past_due decision (WB-08, ENTITLE-04/07, DEMO-02, CAL-14, SUPPORT-16, ONBOARD-10). Queued reviews have a bounded in-tick runner; a separate worker host is optional.
- Hermes runtime: deploy the client-only gateway, private secrets and attestation, provisioner env and profile cap, pin decision (0.21.5 versus 0.22.5), whether the egress allowlist overlay is mandatory, and the runtime-side audience separation for customer-facing runs (ONBOARD-06, SEC-07, REALAI-04/20).
- Host hardening: firewall and loopback or tunnel binding for the gateway, key-only SSH, token expiry, profile mount narrowing, and re-running the read-only host check (SEC-21); credential rotation if the host findings require it.
- Google: Cloud OAuth app, consent-screen verification for sensitive scopes, privacy and terms pages, test accounts (CAL-12, INTEG-04, ONBOARD-07); decision and later security assessment for Workspace scopes beyond Calendar (INTEG-06).
- Microsoft: Entra app registration, secret, publisher verification, tenant consent decision, work and personal test accounts, read-only versus Calendars.ReadWrite decision (CAL-13, INTEG-05).
- Messaging providers: verified sender domain for Resend and the production mailer key, Twilio and WhatsApp numbers and templates, carrier and Meta registration, one approved test destination per channel (QUAL-22, ONBOARD-01/08, INTEG-13); one real demo email and paid demo messages for activation (DEMO-15).
- Other providers: GoHighLevel sub-account token for read-only acceptance and separate approval for any write scope (INTEG-10); n8n instance and workflow ids (INTEG-12); Slack app if OAuth is wanted (INTEG-07); Notion and Airtable apps and scope decisions (INTEG-08/09); Google Business API approval and Meta app review (INTEG-13).
- Payments: approval for each remaining PayPal Sandbox scenario (denied, reversed, disputed), PayPal Sandbox billing plan and PAYPAL_MAINTENANCE_PLAN_ID in a non-production environment, confirmation that no PayMongo live keys are set, per-product payment switch decision, and any live-mode review (ENTITLE-09/10/11/13/14).
- Lead discovery: written owner authorization for external read-only requests, endpoint choice (public Overpass versus self-hosted), reviewed terms record, egress budget, controlled test tenant (LEADS-15/16, CAPS-04); per-channel decisions for LinkedIn, Reddit, X, Facebook, Indeed, JobStreet, directories and third-party providers (LEADS-06).
- Legal and privacy: counsel review of the notice and policies, supported markets, retention periods, lawful basis for researching prospects, NPC and DPO position, signed processor agreements with Supabase, Vercel, Resend, Twilio, Meta, Google and the model provider, inbound-call consent basis, SMS registration rules, postal-address policy, marketing opt-in, AI-disclosure label (SEC-15, DEMO-14, QUAL-23, TERMP-11).
- Security: Supabase TOTP setting and MFA policy (SEC-18), scope and spend for an external penetration test (SEC-25), error-tracking vendor, uptime monitor and alert destinations (QA-14), GitHub secret scanning, push protection and branch protection (SEC-22), and any history decision for the public repository (SEC-20).
- Repository actions needing the founder: pushing branches (Git sign-in click), merging or releasing to master, and access to the separate marketing site repository (DEMO-16).
- Product decisions: shared-thread privacy model (CONV-04, SEC-24), native-memory policy (MEM-03), outcome-derived memory proposals (MEM-08), briefing launch scope and WORKFORCE_BRIEFINGS_ENABLED (CONV-16), single-prospect AI drafts in scope (CONV-18, QUAL-06), permitted AI lead-status transitions (CRM-05), approval rule for chat-direct CRM writes, customer-visible Brain facts (CAPS-17), canonical qualification schema (QUAL-02), untrusted-data envelope for tool results (REALAI-16), AQi launcher on the composer page and legacy help assistant retirement (SUPPORT-03/08).
- Operations and policy decisions: D70 support-session switch (SEC missed, SADMIN-15), offboarding purge of six-role records (SADMIN-13), retention schedule across export, purge, migration and demo, linking versus summarizing legacy conversations (MIGRATE-12), recoverable states for rollback (MIGRATE-15), per-tenant cutover approvals and any production profile change (MIGRATE-11/14).
- Commercial decisions: demo entry mode (open or invite-only) and the proposed limits (DEMO-01/02), consultation destination URL (DEMO-11), 'starting price' versus fixed $1,499 wording (DEMO-13/17, TERMP-03), whether the catalog may differ from $299 and whether Growth Partner usage is charged (ENTITLE-01), maintenance journey after purchase (ENTITLE-08), approval-promise wording (TERMP-13), catalog and maintenance wording (SUPPORT-06/11), when to enable change requests (SUPPORT-10), provisional Studio limits (ENTITLE-04).

### Recommended execution order (top unblocked items)

| Rank | ID | Item | Phase | Depends on |
| ---: | --- | --- | --- | --- |
| 1 | GP-ONBOARD-16 | Finish committed Growth-Partner-only journey evidence; six acceptance cases and the browser CI job are in place, but the full journey remains separate and the CI run is pending | 1 unified product | none |
| 2 | GP-QA-11 | Run CI on pull requests and on this branch (typecheck, lint, suite, build, migration rehearsal, npm audit); review branch-scope policy after evidence is recorded | 7 release validation | none; a run requires pushing the work branch or opening a PR |
| 3 | GP-LEADS-14 | Leads-page Start research, Retry and scheduled research must target the Growth Partner runtime | 3 acquisition engine | GP-ONBOARD-16 |
| 4 | GP-CAL-06 (+GP-QUAL-17) | Resolve reminder, retention, review and missed-call actor through the bound Partner runtime with legacy fallback; separate blocked reasons | 2 core intelligence and tools | GP-ONBOARD-16; no scheduler start required |
| 5 | GP-BRAIN-15 (+GP-CAPS-17) | Per-fact audience separation and customer-reply claims grounded only on customer-safe facts | 2 core intelligence and tools | consolidated migration plan; conservative default-deny |
| 6 | GP-QUAL-14 (+GP-QUAL-09, GP-QUAL-11, GP-QUAL-12) | Dynamic pause/kill-switch checks for every outbound caller; missed-call recovery ceiling; unified Growth Partner and sender-proof acceptance | 3 acquisition engine | none |
| 7 | GP-SADMIN-15 | Scope /admin/health and error text by viewer and D70 rule; no cross-tenant content for staff | 5 migration and security | none (D70 decision only changes the default) |
| 8 | GP-ONBOARD-14 | Close the direct admin double-submit gap and test auto/manual overlap; purchase reservation and crash recovery are already implemented | 1 unified product | GP-ONBOARD-16 |
| 9 | GP-WB-13 (+GP-WB-10) | No false Completed; awaiting-connection and blocked states; deduplicated failure and blocked notifications | 2 core intelligence and tools | GP-WB-03 and GP-WB-07 are verified |
| 10 | GP-CONV-06 (+GP-CONV-10, GP-CONV-11, GP-CONV-13, GP-CONV-17, GP-CONV-19) | Widen deterministic read intents for new leads, follow-up ranking, appointments, completed activities and approvals | 2 core intelligence and tools | GP-ONBOARD-16; optional GP-CRM-06 list_pipelines |
| 11 | GP-CRM-07 (+GP-CRM-13, GP-CONV-14) | Close concurrent and cross-turn task deduplication gaps; unique task keys and chat preview/confirm are implemented locally | 2 core intelligence and tools | GP-CONV-06 |
| 12 | GP-CONV-02 (+GP-PORTAL-03, GP-CONV-09) | Keyset pagination, refresh and stream recovery, Stop and Retry, async job results returned to the thread | 1 unified product | none; GP-WB-07 prerequisite is complete |
| 13 | GP-SADMIN-01 (+GP-SADMIN-06, GP-SADMIN-10, GP-SADMIN-11) | Fix listGrowthPartners, remove AGENT_ROLE_KEYS filters so Partner rows, failures and held reviews show, two-tenant tests | 5 migration and security | GP-ONBOARD-16 |
| 14 | GP-TERMC-10 (+GP-TERMP-06, GP-TERMC-13, GP-TERMC-01, GP-TERMC-02) | Partner-aware server-built strings (about 150), nav and title relabel to the required vocabulary; never rename keys or slugs | 6 UX/support/commercial consistency | GP-TERMC-14 guard is complete |
| 15 | GP-TERMP-13 (+GP-TERMP-12, GP-DEMO-13) | Fix overstated approval and 24/7 claims, label influencer platforms 'not available yet', add 'where connected' qualifiers | 6 UX/support/commercial consistency | GP-TERMC-14 guard is complete; founder wording confirmation can follow |
| 16 | GP-CAPS-03 (+GP-INTEG-02, GP-INTEG-14, GP-PORTAL-08) | Shared provider status vocabulary and per-capability missing-connector reason with link, driven from one derivation | 4 external integration readiness | start with a read-only mapper; GP-INTEG-01 registry later |
| 17 | GP-LEADS-01 (+GP-LEADS-10, GP-LEADS-12) | Deterministic targeting prefilter and category-aware Overpass query, rejection reasons, follow-up task after approved import | 3 acquisition engine | consolidated migration plan for review_note and rejection_reason |
| 18 | GP-SEC-12 (+GP-SEC-13, GP-MEM-11) | Export, per-contact erasure and tenant purge reach Partner tables, thread, memories and linked leads | 5 migration and security | retention defaults (GP-SEC-15 later confirms the numbers) |
| 19 | GP-REALAI-03 (+GP-REALAI-05, GP-REALAI-02, GP-REALAI-01) | Build the real-model harness with no spend: metering proxy and hard cap, real-versus-mock result recording, scenario corpus, dry-run mode | 7 release validation | none to build; any run needs GP-REALAI-21 approval |
| 20 | GP-CONV-20 | Ten-request acceptance harness for owner and restricted member, with pagination, refresh-during-stream, restart recovery and duplicate-send | 7 release validation | GP-CONV-06, GP-CRM-07, GP-CONV-12, GP-CONV-02 |
| 21 | GP-SEC-20 | Move host-specific facts out of tracked docs into a private runbook; add a docs guard test; no history rewrite or visibility change | 5 migration and security | none |

## Requirement index

| ID | Item | Status | Pri | Evidence | Unblocked | Baseline tests |
| --- | --- | --- | --- | --- | --- | --- |
| [GP-TERMC-01](TERMC.md#gp-termc-01) | Portal navigation and shell labels | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-TERMC-02](TERMC.md#gp-termc-02) | Adoption of the required final client vocabulary (12 terms) | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-TERMC-03](TERMC.md#gp-termc-03) | Per-role lists, role pickers and retained-profile views | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-TERMC-04](TERMC.md#gp-termc-04) | Onboarding and setup copy | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-TERMC-05](TERMC.md#gp-termc-05) | Login, authentication and public prospect surfaces | PARTIAL | P2 | app-functional | yes | 1/1 |
| [GP-TERMC-06](TERMC.md#gp-termc-06) | Settings and team wording | PARTIAL | P2 | app-functional | yes | - |
| [GP-TERMC-07](TERMC.md#gp-termc-07) | Calendar surfaces (Workforce Calendar, CRM Calendar, Appointments) | PARTIAL | P2 | app-functional | yes | - |
| [GP-TERMC-08](TERMC.md#gp-termc-08) | Leads, CRM and missed-call recovery wording | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-TERMC-09](TERMC.md#gp-termc-09) | AI Work Board labelling and legacy job rows | PARTIAL | P2 | app-functional | yes | - |
| [GP-TERMC-10](TERMC.md#gp-termc-10) | Chat and the Permanent Conversation (client-visible strings and role-chat entry points) | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-TERMC-11](TERMC.md#gp-termc-11) | Automation Studio client copy and Builder prompt | PARTIAL | P1 | app-functional | yes | 0/1 |
| [GP-TERMC-12](TERMC.md#gp-termc-12) | Requests Center (Support, Report an Issue, Feedback, Request a Change, My Requests) | IMPLEMENTED — NOT YET VERIFIED | P3 | app-functional | yes | - |
| [GP-TERMC-13](TERMC.md#gp-termc-13) | Notifications, status labels, empty states, tooltips and server-built user-visible strings | PARTIAL | P1 | app-functional | yes | - |
| [GP-TERMC-14](TERMC.md#gp-termc-14) | Terminology regression guard | COMPLETE — VERIFIED | P2 | app-functional | yes | 2/2 |
| [GP-TERMP-01](TERMP.md#gp-termp-01) | In-repo public landing, request page, Why page, login/get-started showcase | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 4/4 |
| [GP-TERMP-02](TERMP.md#gp-termp-02) | Demo room views, journey, FAQ and AQi demo guide grounding | PARTIAL | P1 | synthetic-only | yes | 6/6 |
| [GP-TERMP-03](TERMP.md#gp-termp-03) | Pricing facts ($1,499 / $299 / usage separate) and buyer purchase, payment and proposal pages | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-TERMP-04](TERMP.md#gp-termp-04) | Service catalog, Managed Maintenance plan and public catalog feed (DB-resident legacy copy) | COMPLETE — VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-TERMP-05](TERMP.md#gp-termp-05) | Transactional email templates | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-TERMP-06](TERMP.md#gp-termp-06) | Notifications and runtime-generated customer-visible strings | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-TERMP-07](TERMP.md#gp-termp-07) | Setup Center and onboarding default template copy | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-TERMP-08](TERMP.md#gp-termp-08) | Help center articles, help assistant prompt and tooltips | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-TERMP-09](TERMP.md#gp-termp-09) | AQi guidance content in the database (knowledge entries, suggested question, tips) | COMPLETE — VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-TERMP-10](TERMP.md#gp-termp-10) | README and documentation | PARTIAL | P2 | not-applicable | yes | - |
| [GP-TERMP-11](TERMP.md#gp-termp-11) | Widget and website web chat copy | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 6/6 |
| [GP-TERMP-12](TERMP.md#gp-termp-12) | Unsupported-claims register A: discovery sources, influencer platforms, channels and providers | PARTIAL | P1 | synthetic-only | yes | 1/1 |
| [GP-TERMP-13](TERMP.md#gp-termp-13) | Unsupported-claims register B: approval/autonomy, 24/7, API keys, scheduler-dependent promises | PARTIAL | P1 | awaiting-configuration | yes | 2/2 |
| [GP-TERMP-14](TERMP.md#gp-termp-14) | Terminology and unsupported-claims guard test | COMPLETE — VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-SADMIN-01](SADMIN.md#gp-sadmin-01) | View tenant Growth Partner readiness (fleet list, dashboard KPI, per-client summary) | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-SADMIN-02](SADMIN.md#gp-sadmin-02) | View the provisioned Growth Partner identity (per-client card) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-SADMIN-03](SADMIN.md#gp-sadmin-03) | Review Business Brain configuration health | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-SADMIN-04](SADMIN.md#gp-sadmin-04) | Inspect tool and capability availability | PARTIAL | P1 | app-functional | yes | 6/6 |
| [GP-SADMIN-05](SADMIN.md#gp-sadmin-05) | View schedules and Work Board execution status for the Growth Partner | NOT STARTED | P1 | not-applicable | yes | 1/1 |
| [GP-SADMIN-06](SADMIN.md#gp-sadmin-06) | Review failed actions | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-SADMIN-07](SADMIN.md#gp-sadmin-07) | Inspect audit records | PARTIAL | P2 | app-functional | yes | 1/1 |
| [GP-SADMIN-08](SADMIN.md#gp-sadmin-08) | Manage integrations within authorized scopes | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-SADMIN-09](SADMIN.md#gp-sadmin-09) | View tenant migration readiness (legacy tenants to Growth Partner) | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-SADMIN-10](SADMIN.md#gp-sadmin-10) | Review approval queues where authorized | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-SADMIN-11](SADMIN.md#gp-sadmin-11) | Diagnose onboarding issues and control the Growth Partner runtime | PARTIAL | P1 | app-functional | yes | 7/7 |
| [GP-SADMIN-12](SADMIN.md#gp-sadmin-12) | Obsolete customer-facing six-employee controls removed; necessary legacy-administration views retained | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-SADMIN-13](SADMIN.md#gp-sadmin-13) | No admin action ever deletes historical six-role records | PARTIAL | P0 | app-functional | yes | 5/5 |
| [GP-SADMIN-14](SADMIN.md#gp-sadmin-14) | Super Admin and internal role boundaries enforced server-side | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 8/8 |
| [GP-SADMIN-15](SADMIN.md#gp-sadmin-15) | No admin context exposes another tenant's confidential data | PARTIAL | P0 | app-functional | yes | 6/6 |
| [GP-CONV-01](CONV.md#gp-conv-01) | One primary conversation per workspace, stable identity, tenant isolation | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 4/4 |
| [GP-CONV-02](CONV.md#gp-conv-02) | History persistence, safe pagination, search, recovery after refresh and restart | PARTIAL | P1 | app-functional | yes | 2/3 |
| [GP-CONV-03](CONV.md#gp-conv-03) | Send path: authentication, permission checks, rate limits, readiness, tenant isolation | IMPLEMENTED — NOT YET VERIFIED | P0 | synthetic-only | yes | 4/4 |
| [GP-CONV-04](CONV.md#gp-conv-04) | Permission-aware context retrieval and the shared-thread privacy gap | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-CONV-05](CONV.md#gp-conv-05) | Business Brain, approved memory, goals and legacy-knowledge retrieval | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 5/5 |
| [GP-CONV-06](CONV.md#gp-conv-06) | Action architecture, tool permission checks and clear action results | PARTIAL | P1 | synthetic-only | yes | 5/5 |
| [GP-CONV-07](CONV.md#gp-conv-07) | Safe retries and prevention of duplicate side effects | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-CONV-08](CONV.md#gp-conv-08) | Honest outcome reporting, error handling and audit logging | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 3/3 |
| [GP-CONV-09](CONV.md#gp-conv-09) | Results of asynchronous work return to the conversation | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-CONV-10](CONV.md#gp-conv-10) | Request 1: Show me my new leads today (verdict TEXT_ONLY) | PARTIAL | P1 | synthetic-only | yes | 1/1 |
| [GP-CONV-11](CONV.md#gp-conv-11) | Request 2: Which leads should we follow up with (verdict TEXT_ONLY) | PARTIAL | P1 | synthetic-only | yes | 1/1 |
| [GP-CONV-12](CONV.md#gp-conv-12) | Request 3: Create a CRM contact for this approved prospect (verdict PARTIAL) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 2/2 |
| [GP-CONV-13](CONV.md#gp-conv-13) | Request 4: Show me my appointments for tomorrow (verdict PARTIAL) | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-CONV-14](CONV.md#gp-conv-14) | Request 5: Schedule a follow-up task for Friday (verdict MISSING) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 1/1 |
| [GP-CONV-15](CONV.md#gp-conv-15) | Request 6: What do you know about my business (verdict TEXT_ONLY, grounded) | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-CONV-16](CONV.md#gp-conv-16) | Request 7: Change your reporting schedule (verdict TEXT_ONLY for this phrase) | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-CONV-17](CONV.md#gp-conv-17) | Request 8: Show the activities you completed this week (verdict MISSING) | NOT STARTED | P1 | synthetic-only | yes | - |
| [GP-CONV-18](CONV.md#gp-conv-18) | Request 9: Prepare a follow-up message for this prospect (verdict MISSING, refused) | NOT STARTED | P1 | app-functional | yes | 2/2 |
| [GP-CONV-19](CONV.md#gp-conv-19) | Request 10: Show which tasks need my approval (verdict PARTIAL) | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-CONV-20](CONV.md#gp-conv-20) | Automated acceptance harness for the ten example requests and conversation behaviours | NOT STARTED | P1 | not-applicable | yes | - |
| [GP-CONV-21](CONV.md#gp-conv-21) | Live Hermes and real-model proof of the permanent conversation | EXTERNALLY BLOCKED | P1 | externally-blocked | no | 1/1 |
| [GP-BRAIN-01](BRAIN.md#gp-brain-01) | Brain data model, immutable versioning and tenant isolation | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 1/1 |
| [GP-BRAIN-02](BRAIN.md#gp-brain-02) | Core business facts: identity, description, industry, products/services, target customers, locations, pricing, FAQs, app | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-BRAIN-03](BRAIN.md#gp-brain-03) | Working hours, calendar preferences, lead preferences and sales-qualification criteria | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-BRAIN-04](BRAIN.md#gp-brain-04) | Brand voice, communication style, personality, escalation rules, prohibited actions, authorized workflows | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-BRAIN-05](BRAIN.md#gp-brain-05) | Business goals | PARTIAL | P2 | app-functional | yes | 4/4 |
| [GP-BRAIN-06](BRAIN.md#gp-brain-06) | User corrections and preferences (app memory) | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-BRAIN-07](BRAIN.md#gp-brain-07) | Documents, employee notes and retained legacy knowledge outside the Brain | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-BRAIN-08](BRAIN.md#gp-brain-08) | Automatic initial Brain generation at onboarding without fabricating facts | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-BRAIN-09](BRAIN.md#gp-brain-09) | Fact provenance and confirmation state (confirmed vs suggested vs unknown) | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-BRAIN-10](BRAIN.md#gp-brain-10) | Versioning, audit history, recovery and portability of the Brain | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-BRAIN-11](BRAIN.md#gp-brain-11) | Editing through direct settings surfaces (Brain editor, Settings profile, Knowledge Center, Messaging) | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-BRAIN-12](BRAIN.md#gp-brain-12) | Editing through conversation (permanent Partner chat) | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-BRAIN-13](BRAIN.md#gp-brain-13) | Predictable effect timing and propagation consistency | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-BRAIN-14](BRAIN.md#gp-brain-14) | Retrieval correctness: no cross-tenant confusion, no invented facts, no outdated or unapproved content, preferences hono | PARTIAL | P1 | synthetic-only | yes | 3/3 |
| [GP-BRAIN-15](BRAIN.md#gp-brain-15) | Private-context leakage control (internal facts vs customer-facing replies) | PARTIAL | P0 | synthetic-only | yes | 3/3 |
| [GP-BRAIN-16](BRAIN.md#gp-brain-16) | Tests for knowledge update, retrieval, correction and recovery | PARTIAL | P1 | synthetic-only | yes | 8/8 |
| [GP-BRAIN-17](BRAIN.md#gp-brain-17) | Real-model verification of Brain-grounded answers (no invented facts, no private leakage) | EXTERNALLY BLOCKED | P1 | externally-blocked | no | - |
| [GP-MEM-01](MEM.md#gp-mem-01) | Persistent application-owned memory (store, service, UI, chat commands) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 4/4 |
| [GP-MEM-02](MEM.md#gp-mem-02) | Tenant isolation of application memory (write, read, prompt retrieval) | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 3/3 |
| [GP-MEM-03](MEM.md#gp-mem-03) | Hermes-native memory integration policy (what the product does with runtime memory) | PARTIAL | P1 | synthetic-only | yes | 1/2 |
| [GP-MEM-04](MEM.md#gp-mem-04) | Hermes-native memory tenant isolation and gateway-restart recovery (pinned runtime) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 0/2 |
| [GP-MEM-05](MEM.md#gp-mem-05) | Application memory and conversation recovery after process restart | PARTIAL | P1 | app-functional | yes | - |
| [GP-MEM-06](MEM.md#gp-mem-06) | Separation of Business Brain facts from saved and conversational memory | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-MEM-07](MEM.md#gp-mem-07) | Memory retrieval permissions and recall relevance | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 2/2 |
| [GP-MEM-08](MEM.md#gp-mem-08) | Memory updates after confirmed changes | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-MEM-09](MEM.md#gp-mem-09) | Handling conflicting or outdated information | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-MEM-10](MEM.md#gp-mem-10) | Sensitive-data minimization; secrets never persisted into model memory | PARTIAL | P0 | app-functional | yes | 5/5 |
| [GP-MEM-11](MEM.md#gp-mem-11) | Retention and deletion behavior (app memory, export, native memory, conversation) | PARTIAL | P1 | app-functional | no | 4/4 |
| [GP-MEM-12](MEM.md#gp-mem-12) | Auditability of memory changes | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 1/1 |
| [GP-MEM-13](MEM.md#gp-mem-13) | Complete synthetic-tenant memory lifecycle test (create, recall, update, conflict, delete, restart) | PARTIAL | P1 | synthetic-only | yes | 3/3 |
| [GP-MEM-14](MEM.md#gp-mem-14) | Permanent conversation continuity and long-horizon recall | PARTIAL | P2 | app-functional | yes | 2/2 |
| [GP-MEM-15](MEM.md#gp-mem-15) | Real-model memory acceptance: controlled harness | NOT STARTED | P1 | not-applicable | yes | - |
| [GP-MEM-16](MEM.md#gp-mem-16) | Real-model memory acceptance: execution | EXTERNALLY BLOCKED | P1 | externally-blocked | no | - |
| [GP-CAPS-01](CAPS.md#gp-caps-01) | Capability registry and permission model | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-CAPS-02](CAPS.md#gp-caps-02) | Execution path, retry rules, audit logging and failure states | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 4/4 |
| [GP-CAPS-03](CAPS.md#gp-caps-03) | Honest reporting of an unavailable tool, connector or provider | PARTIAL | P0 | app-functional | yes | 6/6 |
| [GP-CAPS-04](CAPS.md#gp-caps-04) | A. Lead Discovery | PARTIAL | P1 | synthetic-only | yes | 7/7 |
| [GP-CAPS-05](CAPS.md#gp-caps-05) | B. Lead Qualification | PARTIAL | P1 | app-functional | yes | 6/6 |
| [GP-CAPS-06](CAPS.md#gp-caps-06) | C. CRM Management | PARTIAL | P1 | app-functional | yes | 6/6 |
| [GP-CAPS-07](CAPS.md#gp-caps-07) | D. Appointment Setting | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 8/8 |
| [GP-CAPS-08](CAPS.md#gp-caps-08) | E. Sales Assistance | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-CAPS-09](CAPS.md#gp-caps-09) | F. Customer Support as a permissioned capability | PARTIAL | P1 | synthetic-only | yes | 3/3 |
| [GP-CAPS-10](CAPS.md#gp-caps-10) | G. Office and Workflow Operations | PARTIAL | P2 | app-functional | yes | 9/9 |
| [GP-CAPS-11](CAPS.md#gp-caps-11) | H. Performance Reporting | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 5/5 |
| [GP-CAPS-12](CAPS.md#gp-caps-12) | Support: FAQ answers sourced from knowledge and Business Brain with source awareness | PARTIAL | P1 | synthetic-only | yes | 4/4 |
| [GP-CAPS-13](CAPS.md#gp-caps-13) | Support: unknown-answer handling and no fabricated policy, prices or guarantees | IMPLEMENTED — NOT YET VERIFIED | P0 | synthetic-only | yes | 5/5 |
| [GP-CAPS-14](CAPS.md#gp-caps-14) | Support: human handoff, escalation routing and activity history | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-CAPS-15](CAPS.md#gp-caps-15) | Support: inquiry classification and follow-up task generation | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-CAPS-16](CAPS.md#gp-caps-16) | Support: no private account or business data disclosed to unauthenticated website visitors | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 5/5 |
| [GP-CAPS-17](CAPS.md#gp-caps-17) | Support: separation of internal Business Brain/memory from public customer-facing information (non-web channels) | PARTIAL | P0 | synthetic-only | yes | 3/3 |
| [GP-CAPS-18](CAPS.md#gp-caps-18) | Cross-capability tenant-isolation and integration test coverage | PARTIAL | P1 | app-functional | yes | 13/13 |
| [GP-CAPS-19](CAPS.md#gp-caps-19) | Live-model and live-provider verification of the capabilities | EXTERNALLY BLOCKED | P1 | externally-blocked | no | - |
| [GP-LEADS-01](LEADS.md#gp-leads-01) | Business Brain to Target Customer Criteria (ideal customer profile, geography, industry, keyword, exclusion filters) | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-LEADS-02](LEADS.md#gp-leads-02) | Source selection, per-tenant source policy, budgets, rate limits and request ledger | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 4/4 |
| [GP-LEADS-03](LEADS.md#gp-leads-03) | OpenStreetMap / public business data discovery adapter | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-LEADS-04](LEADS.md#gp-leads-04) | Public company website reading (exact-allowlist, robots-aware, evidence capture) | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-LEADS-05](LEADS.md#gp-leads-05) | Provider error handling, retry/backoff and rate-limit behaviour | PARTIAL | P2 | synthetic-only | yes | 3/3 |
| [GP-LEADS-06](LEADS.md#gp-leads-06) | Other discovery channels: LinkedIn, Reddit, X/Twitter, Facebook, Indeed, JobStreet, public directories, authorized third | EXTERNALLY BLOCKED | P2 | externally-blocked | no | - |
| [GP-LEADS-07](LEADS.md#gp-leads-07) | User-imported lead lists (CSV/paste) into the same review pipeline | PARTIAL | P1 | not-applicable | yes | - |
| [GP-LEADS-08](LEADS.md#gp-leads-08) | Deduplication and existing-client exclusion | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-LEADS-09](LEADS.md#gp-leads-09) | Qualification evidence, interpretable fit score and provenance (source URL, discovery timestamp) | PARTIAL | P1 | synthetic-only | yes | 4/4 |
| [GP-LEADS-10](LEADS.md#gp-leads-10) | Human review queue: approve/reject, rejection reasons, per-lead audit trail | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-LEADS-11](LEADS.md#gp-leads-11) | Idempotent native CRM import behind an Approval Center request | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-LEADS-12](LEADS.md#gp-leads-12) | Follow-up Work Board task after approved import | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-LEADS-13](LEADS.md#gp-leads-13) | Hard safety rules: no automatic outreach, no unverified real contact, no fabricated prospects, tenant isolation | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 5/5 |
| [GP-LEADS-14](LEADS.md#gp-leads-14) | Research trigger paths for the single AI Growth Partner (Leads page, retry, scheduled research) | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-LEADS-15](LEADS.md#gp-leads-15) | Repeatable live-source acceptance harness (real retrieval kept separate from fixtures) | NOT STARTED | P1 | not-applicable | yes | - |
| [GP-LEADS-16](LEADS.md#gp-leads-16) | Controlled live validation run (OpenStreetMap + approved company websites, then real-model qualification) | EXTERNALLY BLOCKED | P1 | externally-blocked | no | - |
| [GP-QUAL-01](QUAL.md#gp-qual-01) | Deterministic lead scoring and priority engine | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-QUAL-02](QUAL.md#gp-qual-02) | Unified qualification criteria (industry, location, size, service need, source, fit, requirements) | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-QUAL-03](QUAL.md#gp-qual-03) | Evidence-bound prospect qualification (research candidates) | PARTIAL | P1 | synthetic-only | yes | 5/5 |
| [GP-QUAL-04](QUAL.md#gp-qual-04) | Disqualification reasons and missing-information handling | PARTIAL | P2 | app-functional | yes | 4/4 |
| [GP-QUAL-05](QUAL.md#gp-qual-05) | Qualification summaries, next actions and follow-up recommendations reaching the Growth Partner | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-QUAL-06](QUAL.md#gp-qual-06) | Draft outreach and follow-up drafts | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-QUAL-07](QUAL.md#gp-qual-07) | Lead status updates, approval requests and CRM pipeline updates by the partner | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-QUAL-08](QUAL.md#gp-qual-08) | Reporting on lead quality | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-QUAL-09](QUAL.md#gp-qual-09) | Core outbound rule chain (evaluateSend, queueOutbound, dispatchMessage) | PARTIAL | P0 | app-functional | yes | 10/10 |
| [GP-QUAL-10](QUAL.md#gp-qual-10) | Opt-out, suppression and unsubscribe handling | PARTIAL | P0 | app-functional | yes | 5/5 |
| [GP-QUAL-11](QUAL.md#gp-qual-11) | Gates and kill switches inventory (tenant, agent, global) | PARTIAL | P0 | app-functional | yes | 12/12 |
| [GP-QUAL-12](QUAL.md#gp-qual-12) | Outbound path: AI replies to inbound messages and approved drafts | PARTIAL | P0 | synthetic-only | yes | 7/7 |
| [GP-QUAL-13](QUAL.md#gp-qual-13) | Outbound path: scheduled AI follow-ups to quiet inbound customers | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-QUAL-14](QUAL.md#gp-qual-14) | Outbound path: missed-call recovery texts | PARTIAL | P0 | app-functional | yes | 5/5 |
| [GP-QUAL-15](QUAL.md#gp-qual-15) | Outbound path: owner-approved marketing campaigns | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 1/1 |
| [GP-QUAL-16](QUAL.md#gp-qual-16) | Outbound path: workflow send-message and review-request steps | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-QUAL-17](QUAL.md#gp-qual-17) | Outbound path: automated service messages (reminders, confirmations, retention, review requests, invoice reminders, docu | PARTIAL | P1 | app-functional | yes | 10/10 |
| [GP-QUAL-18](QUAL.md#gp-qual-18) | Outbound path: person-initiated sends (inbox replies, template test sends) | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 10/10 |
| [GP-QUAL-19](QUAL.md#gp-qual-19) | Outbound path: platform transactional email and other external writes (social, review replies, e-signature, webhooks) | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 6/6 |
| [GP-QUAL-20](QUAL.md#gp-qual-20) | No cold or mass unsolicited outreach by default | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 6/6 |
| [GP-QUAL-21](QUAL.md#gp-qual-21) | Synthetic acceptance cannot send anything | IMPLEMENTED — NOT YET VERIFIED | P0 | synthetic-only | yes | 3/3 |
| [GP-QUAL-22](QUAL.md#gp-qual-22) | Live provider verification (Twilio, Meta WhatsApp, Resend, GoHighLevel) | EXTERNALLY BLOCKED | P1 | awaiting-configuration | no | 4/4 |
| [GP-QUAL-23](QUAL.md#gp-qual-23) | Platform and legal compliance patterns (WhatsApp, SMS, email, caller consent) | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-CRM-01](CRM.md#gp-crm-01) | Find contact | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-CRM-02](CRM.md#gp-crm-02) | Create contact from the permanent chat (explicit command) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 4/4 |
| [GP-CRM-03](CRM.md#gp-crm-03) | Create contact through the shared tool and proposal layer | NOT STARTED | P1 | not-applicable | yes | 2/2 |
| [GP-CRM-04](CRM.md#gp-crm-04) | Update contact details (proposal then approved execution) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-CRM-05](CRM.md#gp-crm-05) | Change permitted lead stages (contact lead status and deal pipeline stage) | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-CRM-06](CRM.md#gp-crm-06) | View lead pipeline (deals, stages, counts) | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-CRM-07](CRM.md#gp-crm-07) | Create follow-up task | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-CRM-08](CRM.md#gp-crm-08) | Add approved notes | NOT STARTED | P1 | not-applicable | yes | - |
| [GP-CRM-09](CRM.md#gp-crm-09) | Deduplicate leads and contacts | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-CRM-10](CRM.md#gp-crm-10) | Check ownership and retrieve status | PARTIAL | P2 | app-functional | yes | 2/2 |
| [GP-CRM-11](CRM.md#gp-crm-11) | Approval and audit evidence | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-CRM-12](CRM.md#gp-crm-12) | Authorization parity: AI tool layer vs human CRM actions | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-CRM-13](CRM.md#gp-crm-13) | Idempotency of retried Growth Partner commands | PARTIAL | P1 | synthetic-only | yes | 3/3 |
| [GP-CRM-14](CRM.md#gp-crm-14) | Tenant isolation and provider ownership for CRM operations | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 5/5 |
| [GP-CRM-15](CRM.md#gp-crm-15) | Failure-mode test matrix and restart recovery | PARTIAL | P1 | app-functional | yes | 7/7 |
| [GP-CRM-16](CRM.md#gp-crm-16) | Pinned-runtime scripted-inference proof of CRM proposals | NOT STARTED | P2 | synthetic-only | yes | 1/1 |
| [GP-CRM-17](CRM.md#gp-crm-17) | Real-model verification of Growth Partner CRM tool use | EXTERNALLY BLOCKED | P1 | externally-blocked | no | - |
| [GP-CAL-01](CAL.md#gp-cal-01) | Read configured availability (native calendars, working hours, holds, synced external busy times) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 6/6 |
| [GP-CAL-02](CAL.md#gp-cal-02) | Business and host time zones, customer time zone, and daylight-saving handling | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-CAL-03](CAL.md#gp-cal-03) | View authorized appointments (staff views and Growth Partner read access) | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-CAL-04](CAL.md#gp-cal-04) | Prepare appointment requests and create appointments only after approval | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 7/7 |
| [GP-CAL-05](CAL.md#gp-cal-05) | Reschedule and cancel permitted appointments (approval-gated) | PARTIAL | P1 | app-functional | yes | 6/6 |
| [GP-CAL-06](CAL.md#gp-cal-06) | Appointment reminders and reminder drafts | PARTIAL | P1 | synthetic-only | yes | 3/3 |
| [GP-CAL-07](CAL.md#gp-cal-07) | Clear confirmation or failure status for every booking, change and provider write | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-CAL-08](CAL.md#gp-cal-08) | Detect and escalate scheduling conflicts and double bookings | PARTIAL | P1 | app-functional | yes | 6/6 |
| [GP-CAL-09](CAL.md#gp-cal-09) | Native calendar services: booking pages, staff scheduling, public booking, API and legacy GoHighLevel path | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 8/8 |
| [GP-CAL-10](CAL.md#gp-cal-10) | Google Calendar adapter, OAuth, token lifecycle and sync (code complete, mock-tested only) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 2/2 |
| [GP-CAL-11](CAL.md#gp-cal-11) | Microsoft Outlook / 365 Calendar adapter, OAuth, token lifecycle and sync (code complete, mock-tested only) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 1/1 |
| [GP-CAL-12](CAL.md#gp-cal-12) | Google Calendar real-provider acceptance (OAuth app, verification, live connect/sync/write) | EXTERNALLY BLOCKED | P1 | awaiting-configuration | no | - |
| [GP-CAL-13](CAL.md#gp-cal-13) | Microsoft Outlook Calendar real-provider acceptance (Entra app, publisher verification, live connect/sync/write) | EXTERNALLY BLOCKED | P1 | awaiting-configuration | no | - |
| [GP-CAL-14](CAL.md#gp-cal-14) | Provider failure handling, operational dependencies and stale-data safety (disconnect, expiry, revocation, outage, rate  | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 3/3 |
| [GP-WB-01](WB.md#gp-wb-01) | Durable work job lifecycle, claim/lease/fencing and honest status | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-WB-02](WB.md#gp-wb-02) | Task creation and assignment (on-demand work, chat dispatch, finding-to-task) | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-WB-03](WB.md#gp-wb-03) | Work Board Start review on Growth-Partner-only workspaces | COMPLETE — VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-WB-04](WB.md#gp-wb-04) | Schedule engine: creation, recurrence, time-zone-safe execution, business hours | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-WB-05](WB.md#gp-wb-05) | Creating schedules from chat: the five example intents | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-WB-06](WB.md#gp-wb-06) | Pause, resume and update schedules (UI, chat, timed pause) | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-WB-07](WB.md#gp-wb-07) | Who executes queued jobs; recovery and restart behaviour | COMPLETE — VERIFIED | P0 | synthetic-only | yes | 2/2 |
| [GP-WB-08](WB.md#gp-wb-08) | Production scheduler activation and switch state | EXTERNALLY BLOCKED | P1 | awaiting-configuration | no | 3/3 |
| [GP-WB-09](WB.md#gp-wb-09) | Retry handling and cancellation | PARTIAL | P2 | app-functional | yes | 2/2 |
| [GP-WB-10](WB.md#gp-wb-10) | Failure/blocked notifications and visibility of why a schedule did not run | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 2/2 |
| [GP-WB-11](WB.md#gp-wb-11) | Execution policy: read-only auto-run, external writes behind approval | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 6/6 |
| [GP-WB-12](WB.md#gp-wb-12) | Duplicate-job prevention and idempotency | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 4/4 |
| [GP-WB-13](WB.md#gp-wb-13) | Work Board visibility: pending/completed work, execution history, approval queue, honest labels | PARTIAL | P1 | app-functional | yes | 6/6 |
| [GP-WB-14](WB.md#gp-wb-14) | Status tracking through chat (what is scheduled, running, finished) | NOT STARTED | P1 | app-functional | yes | - |
| [GP-WB-15](WB.md#gp-wb-15) | Proactive monitoring: event triggers, reports and briefings | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 3/3 |
| [GP-INTEG-01](INTEG.md#gp-integ-01) | Shared provider lifecycle abstraction (twelve lifecycle items) | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-INTEG-02](INTEG.md#gp-integ-02) | Honest integration status vocabulary and client integrations hub | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-INTEG-03](INTEG.md#gp-integ-03) | Secret handling: storage encryption, redaction, prompts, browser bundles, repository | PARTIAL | P0 | synthetic-only | yes | 9/9 |
| [GP-INTEG-04](INTEG.md#gp-integ-04) | Google Calendar (per-person OAuth, busy sync, event write-back, Meet) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | no | 1/1 |
| [GP-INTEG-05](INTEG.md#gp-integ-05) | Microsoft Outlook / Microsoft 365 Calendar (per-person OAuth) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | no | 1/1 |
| [GP-INTEG-06](INTEG.md#gp-integ-06) | Google Workspace beyond Calendar and Microsoft 365 mail, contacts and files | NOT STARTED | P2 | not-applicable | yes | - |
| [GP-INTEG-07](INTEG.md#gp-integ-07) | Slack | PARTIAL | P2 | synthetic-only | yes | 1/1 |
| [GP-INTEG-08](INTEG.md#gp-integ-08) | Notion | NOT STARTED | P3 | not-applicable | yes | - |
| [GP-INTEG-09](INTEG.md#gp-integ-09) | Airtable | NOT STARTED | P3 | not-applicable | yes | - |
| [GP-INTEG-10](INTEG.md#gp-integ-10) | GoHighLevel (agency-managed CRM and calendar integration) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 4/4 |
| [GP-INTEG-11](INTEG.md#gp-integ-11) | Hermes runtime gateway and LLM provider connection | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | no | 5/5 |
| [GP-INTEG-12](INTEG.md#gp-integ-12) | n8n (agency workflows) | IMPLEMENTED — NOT YET VERIFIED | P2 | synthetic-only | no | 3/3 |
| [GP-INTEG-13](INTEG.md#gp-integ-13) | Other provider integrations found: Google Business Profile reviews, Meta social and reviews, messaging transports, voice | PARTIAL | P2 | synthetic-only | yes | 9/9 |
| [GP-INTEG-14](INTEG.md#gp-integ-14) | Growth Partner tool access permissions over integrations (provider capability gating) | IMPLEMENTED — NOT YET VERIFIED | P0 | synthetic-only | yes | 6/6 |
| [GP-ONBOARD-01](ONBOARD.md#gp-onboard-01) | Account creation, invitation acceptance and tenant creation | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 7/7 |
| [GP-ONBOARD-02](ONBOARD.md#gp-onboard-02) | Business details, goals, target audience, services and operating locations (questionnaire sections A and B) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 7/7 |
| [GP-ONBOARD-03](ONBOARD.md#gp-onboard-03) | Business voice (section C: tone, length, language, rules) | PARTIAL | P2 | synthetic-only | yes | 4/4 |
| [GP-ONBOARD-04](ONBOARD.md#gp-onboard-04) | Generate and version the Business Brain from onboarding | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-ONBOARD-05](ONBOARD.md#gp-onboard-05) | Provision ONE Growth Partner: application-side automation (identity, configuration, request, claim, health check, conver | IMPLEMENTED — NOT YET VERIFIED | P0 | synthetic-only | yes | 9/9 |
| [GP-ONBOARD-06](ONBOARD.md#gp-onboard-06) | Real runtime provisioning and production activation (founder/operator steps) | EXTERNALLY BLOCKED | P0 | externally-blocked | no | 1/3 |
| [GP-ONBOARD-07](ONBOARD.md#gp-onboard-07) | Configure the native calendar from onboarding answers | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 7/7 |
| [GP-ONBOARD-08](ONBOARD.md#gp-onboard-08) | Offer available integrations | PARTIAL | P2 | awaiting-configuration | yes | 3/3 |
| [GP-ONBOARD-09](ONBOARD.md#gp-onboard-09) | Review capability permissions (Allowed actions) before launch | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-ONBOARD-10](ONBOARD.md#gp-onboard-10) | Configure optional Work Board schedules during setup | NOT STARTED | P2 | not-applicable | yes | 1/1 |
| [GP-ONBOARD-11](ONBOARD.md#gp-onboard-11) | Open the permanent Growth Partner conversation | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 3/3 |
| [GP-ONBOARD-12](ONBOARD.md#gp-onboard-12) | Clear readiness checklist for a Growth-Partner-only tenant | PARTIAL | P1 | synthetic-only | yes | 5/5 |
| [GP-ONBOARD-13](ONBOARD.md#gp-onboard-13) | Guide the first meaningful action | NOT STARTED | P2 | not-applicable | yes | 2/2 |
| [GP-ONBOARD-14](ONBOARD.md#gp-onboard-14) | Retries never create duplicate Growth Partners or workspaces (idempotency) | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 8/8 |
| [GP-ONBOARD-15](ONBOARD.md#gp-onboard-15) | A new workspace has no access to another tenant's data (isolation) | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 7/7 |
| [GP-ONBOARD-16](ONBOARD.md#gp-onboard-16) | Journey test coverage: complete fictional tenant without manual database intervention; existing onboarding tests expande | PARTIAL | P1 | synthetic-only | yes | 9/9 |
| [GP-PORTAL-01](PORTAL.md#gp-portal-01) | One-identity navigation and consistent naming | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-PORTAL-02](PORTAL.md#gp-portal-02) | Legacy six-role residue removed from the client experience | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-PORTAL-03](PORTAL.md#gp-portal-03) | Permanent conversation experience | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-PORTAL-04](PORTAL.md#gp-portal-04) | Control Center composition and in-page navigation | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-PORTAL-05](PORTAL.md#gp-portal-05) | Business Brain view, edit and apply | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-PORTAL-06](PORTAL.md#gp-portal-06) | Growth goals panel | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 2/2 |
| [GP-PORTAL-07](PORTAL.md#gp-portal-07) | Capability access view (six domains, 14 capabilities) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-PORTAL-08](PORTAL.md#gp-portal-08) | Integrations and connection states | PARTIAL | P1 | awaiting-configuration | yes | 2/2 |
| [GP-PORTAL-09](PORTAL.md#gp-portal-09) | AI Work Board | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 4/4 |
| [GP-PORTAL-10](PORTAL.md#gp-portal-10) | Schedules and Workforce Calendar | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 4/4 |
| [GP-PORTAL-11](PORTAL.md#gp-portal-11) | Memory and knowledge | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-PORTAL-12](PORTAL.md#gp-portal-12) | Approvals | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-PORTAL-13](PORTAL.md#gp-portal-13) | Reports | PARTIAL | P1 | awaiting-configuration | yes | 3/3 |
| [GP-PORTAL-14](PORTAL.md#gp-portal-14) | Suggestion vs completed-action distinction | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-PORTAL-15](PORTAL.md#gp-portal-15) | Activity logs | PARTIAL | P2 | app-functional | yes | 1/1 |
| [GP-PORTAL-16](PORTAL.md#gp-portal-16) | Onboarding and setup progress | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-PORTAL-17](PORTAL.md#gp-portal-17) | Loading, error and empty states | PARTIAL | P1 | app-functional | yes | - |
| [GP-PORTAL-18](PORTAL.md#gp-portal-18) | Tablet and mobile layout | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-PORTAL-19](PORTAL.md#gp-portal-19) | Accessibility of portal controls | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 3/3 |
| [GP-MIGRATE-01](MIGRATE.md#gp-migrate-01) | Fleet inventory of legacy tenants and migration state per tenant | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-MIGRATE-02](MIGRATE.md#gp-migrate-02) | Per-tenant inventory of profiles, credentials, knowledge, history, schedules and assignments | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 1/1 |
| [GP-MIGRATE-03](MIGRATE.md#gp-migrate-03) | Per-tenant readiness report with blockers and a persisted migration report | NOT STARTED | P1 | not-applicable | yes | - |
| [GP-MIGRATE-04](MIGRATE.md#gp-migrate-04) | Map former six-role capabilities to the Growth Partner | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-MIGRATE-05](MIGRATE.md#gp-migrate-05) | Preview of schedule changes (reconciliation of old schedules and open work) | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-MIGRATE-06](MIGRATE.md#gp-migrate-06) | Reversible identity-preparation action and duplicate-Partner prevention | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-MIGRATE-07](MIGRATE.md#gp-migrate-07) | Reviewed import of retained notes and documents into Partner knowledge (snapshot queue) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-MIGRATE-08](MIGRATE.md#gp-migrate-08) | Business Brain import from retained notes and company knowledge for a migrating tenant | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-MIGRATE-09](MIGRATE.md#gp-migrate-09) | Legacy memory handling (app-side memory preview and import decision) | NOT STARTED | P2 | not-applicable | yes | 1/1 |
| [GP-MIGRATE-10](MIGRATE.md#gp-migrate-10) | Runtime binding path for an existing tenant (create or attach growth_partner profile row and link to the candidate) | NOT STARTED | P1 | not-applicable | yes | 1/1 |
| [GP-MIGRATE-11](MIGRATE.md#gp-migrate-11) | Real tenant-isolated Hermes profile, health, tool-inventory and tenant-boundary checks for a legacy tenant | EXTERNALLY BLOCKED | P1 | externally-blocked | no | 1/1 |
| [GP-MIGRATE-12](MIGRATE.md#gp-migrate-12) | Preserve and link historical conversations, audit history and assignments | PARTIAL | P0 | app-functional | yes | 4/4 |
| [GP-MIGRATE-13](MIGRATE.md#gp-migrate-13) | Dry run and validation of the expected end state | NOT STARTED | P1 | not-applicable | yes | 1/1 |
| [GP-MIGRATE-14](MIGRATE.md#gp-migrate-14) | Approved cutover action (identity activation, schedule cutover, in-flight work handling) | NOT STARTED | P0 | not-applicable | yes | - |
| [GP-MIGRATE-15](MIGRATE.md#gp-migrate-15) | Rollback and recovery (discard candidate, post-cutover restore) | NOT STARTED | P1 | not-applicable | yes | - |
| [GP-MIGRATE-16](MIGRATE.md#gp-migrate-16) | Documentation of non-reversible operations and accuracy of migration claims | PARTIAL | P2 | not-applicable | yes | - |
| [GP-ENTITLE-01](ENTITLE.md#gp-entitle-01) | Commercial terms preserved: $1,499 setup, optional $299/month, usage separate | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-ENTITLE-02](ENTITLE.md#gp-entitle-02) | Entitlement decision and server-side enforcement, including tenant isolation of Studio data | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 8/8 |
| [GP-ENTITLE-03](ENTITLE.md#gp-entitle-03) | Locked preview and upgrade experience for workspaces without the plan | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-ENTITLE-04](ENTITLE.md#gp-entitle-04) | Studio authoring-to-run lifecycle: draft, test, approve, activate, retry, logs | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | no | 6/6 |
| [GP-ENTITLE-05](ENTITLE.md#gp-entitle-05) | AI Automation Builder against a real model | IMPLEMENTED — NOT YET VERIFIED | P1 | real-model-verified | no | 4/4 |
| [GP-ENTITLE-06](ENTITLE.md#gp-entitle-06) | Growth Partner integration respects workflow permissions and the plan | PARTIAL | P1 | app-functional | yes | 4/4 |
| [GP-ENTITLE-07](ENTITLE.md#gp-entitle-07) | $299 plan activation, renewal, lapse and reactivation | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | no | 9/9 |
| [GP-ENTITLE-08](ENTITLE.md#gp-entitle-08) | Purchase 'maintenance selected' never becomes a plan request | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-ENTITLE-09](ENTITLE.md#gp-entitle-09) | PayPal checkout for the $1,499 setup purchase | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | no | 5/5 |
| [GP-ENTITLE-10](ENTITLE.md#gp-entitle-10) | Webhook signature, receipt ledger, idempotency, audit and retry safety | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 8/8 |
| [GP-ENTITLE-11](ENTITLE.md#gp-entitle-11) | No accidental live charging; clear sandbox vs production distinction | PARTIAL | P0 | app-functional | yes | 7/7 |
| [GP-ENTITLE-12](ENTITLE.md#gp-entitle-12) | Maintenance plan online payment is PayMongo-only (PayPal-first not met) | PARTIAL | P1 | synthetic-only | yes | 1/1 |
| [GP-ENTITLE-13](ENTITLE.md#gp-entitle-13) | PayPal automatic monthly payment (Subscriptions) for the $299 plan | EXTERNALLY BLOCKED | P1 | awaiting-configuration | no | 4/4 |
| [GP-ENTITLE-14](ENTITLE.md#gp-entitle-14) | Clients' own invoices and payments (customer-payments) | IMPLEMENTED — NOT YET VERIFIED | P2 | synthetic-only | no | 13/13 |
| [GP-ENTITLE-15](ENTITLE.md#gp-entitle-15) | Billing and plan state never block unrelated Growth Partner work; no payment during testing | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 5/5 |
| [GP-DEMO-01](DEMO.md#gp-demo-01) | Invitation-style entry: request form, emailed single-use link, signed marketing-site door | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-DEMO-02](DEMO.md#gp-demo-02) | Limited demo access: window, daily caps, rate limits, extensions, expiry | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | no | 7/7 |
| [GP-DEMO-03](DEMO.md#gp-demo-03) | Interaction allowance enforcement (AQi message limit; tour interactions are unlimited and local) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 3/3 |
| [GP-DEMO-04](DEMO.md#gp-demo-04) | AQi demo chat grounding facts are far narrower than the showroom content and its suggested questions | PARTIAL | P2 | app-functional | yes | 2/2 |
| [GP-DEMO-05](DEMO.md#gp-demo-05) | Real-model evaluation of the demo chat and its reply checks | EXTERNALLY BLOCKED | P1 | externally-blocked | no | 3/3 |
| [GP-DEMO-06](DEMO.md#gp-demo-06) | Persistent demo progress (server state exists; tour progress is browser-local only) | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-DEMO-07](DEMO.md#gp-demo-07) | Guided journey and capability tour: discovery, qualification, CRM updates, appointments, approvals, reporting, automatio | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 6/6 |
| [GP-DEMO-08](DEMO.md#gp-demo-08) | AI Work Board in the demo | PARTIAL | P1 | app-functional | yes | - |
| [GP-DEMO-09](DEMO.md#gp-demo-09) | Business Brain explanation in the demo | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-DEMO-10](DEMO.md#gp-demo-10) | Simulated vs real distinction, and no demo path can send real prospect communications | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 4/4 |
| [GP-DEMO-11](DEMO.md#gp-demo-11) | Consultation booking and purchase calls to action | PARTIAL | P1 | app-functional | no | 4/4 |
| [GP-DEMO-12](DEMO.md#gp-demo-12) | Separation of Demo/Prospects from Clients, with explicit conversion | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 6/6 |
| [GP-DEMO-13](DEMO.md#gp-demo-13) | "Why iAcquireOS?" explanation, pricing view and FAQs | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 3/3 |
| [GP-DEMO-14](DEMO.md#gp-demo-14) | Consent notice, privacy policy, retention and erasure | EXTERNALLY BLOCKED | P0 | externally-blocked | no | 3/3 |
| [GP-DEMO-15](DEMO.md#gp-demo-15) | Activation and live verification of the current demo build | EXTERNALLY BLOCKED | P0 | awaiting-configuration | no | - |
| [GP-DEMO-16](DEMO.md#gp-demo-16) | Public marketing homepage, product pages and pricing site (separate repository) | EXTERNALLY BLOCKED | P1 | externally-blocked | no | 1/1 |
| [GP-DEMO-17](DEMO.md#gp-demo-17) | Entry pages copy: login, get-started, invitation, no-workspace | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | - |
| [GP-DEMO-18](DEMO.md#gp-demo-18) | Public transactional pages: purchase, payment, booking | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | - |
| [GP-DEMO-19](DEMO.md#gp-demo-19) | Internal docs and comments still describing the six-employee demo | PARTIAL | P3 | not-applicable | yes | - |
| [GP-SUPPORT-01](SUPPORT.md#gp-support-01) | AQi permission-aware help and tenant isolation | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 6/6 |
| [GP-SUPPORT-02](SUPPORT.md#gp-support-02) | AQi navigation assistance and page explanations (route registry integrity) | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-SUPPORT-03](SUPPORT.md#gp-support-03) | AQi availability on Growth Partner pages | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-SUPPORT-04](SUPPORT.md#gp-support-04) | Guided walkthroughs and resume | PARTIAL | P1 | app-functional | yes | 5/5 |
| [GP-SUPPORT-05](SUPPORT.md#gp-support-05) | Accurate documentation answers and citations | PARTIAL | P0 | synthetic-only | yes | 4/4 |
| [GP-SUPPORT-06](SUPPORT.md#gp-support-06) | No outdated six-employee content in AQi, help and Requests copy | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-SUPPORT-07](SUPPORT.md#gp-support-07) | AQi feedback handling and insights | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-SUPPORT-08](SUPPORT.md#gp-support-08) | Human handoff and help entry points | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-SUPPORT-09](SUPPORT.md#gp-support-09) | Support requests, issues, feedback, request status and client access restrictions | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 9/9 |
| [GP-SUPPORT-10](SUPPORT.md#gp-support-10) | Change requests and project change orders | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 7/7 |
| [GP-SUPPORT-11](SUPPORT.md#gp-support-11) | Custom project requests | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 9/9 |
| [GP-SUPPORT-12](SUPPORT.md#gp-support-12) | Unified Requests Center view | PARTIAL | P2 | app-functional | yes | - |
| [GP-SUPPORT-13](SUPPORT.md#gp-support-13) | Duplicate detection | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-SUPPORT-14](SUPPORT.md#gp-support-14) | AI-assisted request intake | PARTIAL | P2 | synthetic-only | yes | 2/2 |
| [GP-SUPPORT-15](SUPPORT.md#gp-support-15) | Internal notifications, escalations and response targets | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 5/5 |
| [GP-SUPPORT-16](SUPPORT.md#gp-support-16) | Scheduler, email and Slack delivery for requests | EXTERNALLY BLOCKED | P2 | awaiting-configuration | no | 1/1 |
| [GP-SEC-01](SEC.md#gp-sec-01) | Tenant isolation: database layer (RLS, grants, composite tenant FKs) for the Growth Partner tables | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 4/4 |
| [GP-SEC-02](SEC.md#gp-sec-02) | Tenant isolation: application layer relies on 1,967 RLS-bypassing withSystem call sites (High, systemic) | PARTIAL | P1 | app-functional | yes | 1/1 |
| [GP-SEC-03](SEC.md#gp-sec-03) | Tenant isolation: Growth Partner memory retrieval, goals, legacy knowledge, shared thread, schedules, tools and notifica | IMPLEMENTED — NOT YET VERIFIED | P0 | synthetic-only | yes | 5/5 |
| [GP-SEC-04](SEC.md#gp-sec-04) | Server-side authorization of high-impact Growth Partner actions (chat proposals, CRM changes, approvals) | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 4/4 |
| [GP-SEC-05](SEC.md#gp-sec-05) | OAuth tokens and secrets: storage, leakage scan of tracked files, client-bundle and error-serializer safety | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 2/2 |
| [GP-SEC-06](SEC.md#gp-sec-06) | Prompt-injection resistance: untrusted web pages, prospect and customer text, retrieved documents, saved memory | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-SEC-07](SEC.md#gp-sec-07) | Web read plus private-data read in the same Growth Partner runtime has no egress or exfiltration control (High) | PARTIAL | P1 | synthetic-only | yes | 2/2 |
| [GP-SEC-08](SEC.md#gp-sec-08) | Idempotency: retries cannot duplicate CRM records, bookings, payments, approvals or outreach | PARTIAL | P1 | app-functional | yes | 3/3 |
| [GP-SEC-09](SEC.md#gp-sec-09) | Audit trail: meaningful actions and denials recorded without sensitive content | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 4/4 |
| [GP-SEC-10](SEC.md#gp-sec-10) | Unauthorized outreach safeguards: consent, suppression, human takeover, and no-contact status of researched leads | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 1/1 |
| [GP-SEC-11](SEC.md#gp-sec-11) | Data privacy baseline: consent capture, retention rules and what exists versus what is missing | PARTIAL | P1 | app-functional | yes | 3/5 |
| [GP-SEC-12](SEC.md#gp-sec-12) | Data export omits the Growth Partner tables (Medium) | NOT STARTED | P1 | app-functional | yes | 1/1 |
| [GP-SEC-13](SEC.md#gp-sec-13) | Per-contact erasure does not reach Growth Partner surfaces (Medium) | PARTIAL | P1 | app-functional | yes | 2/2 |
| [GP-SEC-14](SEC.md#gp-sec-14) | Privacy and breach-response artifacts that engineering can draft now: breach runbook, data map, sub-processor inventory, | NOT STARTED | P0 | not-applicable | yes | - |
| [GP-SEC-15](SEC.md#gp-sec-15) | Legal sign-off and registrations: counsel review, NPC/DPO position, signed processor agreements per market | EXTERNALLY BLOCKED | P0 | externally-blocked | no | - |
| [GP-SEC-16](SEC.md#gp-sec-16) | Rate limiting: auth, expensive AI endpoints, discovery, public links, automation execution | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 6/6 |
| [GP-SEC-17](SEC.md#gp-sec-17) | Client address for rate limits and audit hashes is derived in about 15 places from the first X-Forwarded-For entry (Low) | PARTIAL | P2 | app-functional | yes | 1/1 |
| [GP-SEC-18](SEC.md#gp-sec-18) | No multi-factor authentication for Super Admin, agency staff or client owners in application code (High) | NOT STARTED | P1 | not-applicable | yes | 2/2 |
| [GP-SEC-19](SEC.md#gp-sec-19) | Operational safeguards: monitoring, structured errors, controlled retries, recovery | PARTIAL | P1 | app-functional | yes | 6/6 |
| [GP-SEC-20](SEC.md#gp-sec-20) | Public repository discloses infrastructure details and an host-exposure finding (High) | NOT STARTED | P0 | app-functional | yes | - |
| [GP-SEC-21](SEC.md#gp-sec-21) | Hermes gateway host hardening (network exposure, remote-access and profile-mount hardening) | EXTERNALLY BLOCKED | P0 | externally-blocked | no | 2/2 |
| [GP-SEC-22](SEC.md#gp-sec-22) | GitHub Actions and repository governance: workflows are well pinned; scanning, dependency updates and PR CI are missing | PARTIAL | P2 | app-functional | yes | - |
| [GP-SEC-23](SEC.md#gp-sec-23) | Dependency vulnerabilities: two moderate transitive advisories (hono, @hono/node-server via the MCP SDK) | PARTIAL | P2 | app-functional | yes | 1/1 |
| [GP-SEC-24](SEC.md#gp-sec-24) | Shared permanent Partner thread: every working-role member reads it, and it is excluded from chat retention (Low/Medium  | PARTIAL | P2 | app-functional | yes | 3/3 |
| [GP-SEC-25](SEC.md#gp-sec-25) | Independent security verification of the Growth Partner build: no review since 2026-10-26, hosted RLS check and penetrat | NOT STARTED | P1 | synthetic-only | yes | - |
| [GP-SEC-26](SEC.md#gp-sec-26) | Transport and browser hardening: CSP with nonces, framing, cookies (confirm HSTS at the host) | IMPLEMENTED — NOT YET VERIFIED | P2 | app-functional | yes | 3/3 |
| [GP-REALAI-01](REALAI.md#gp-realai-01) | Provider abstraction inventory and an acceptance-grade adapter | PARTIAL | P1 | synthetic-only | yes | 7/7 |
| [GP-REALAI-02](REALAI.md#gp-realai-02) | Acceptance harness: scenario corpus, deterministic checkers, dry-run | PARTIAL | P1 | synthetic-only | yes | 3/3 |
| [GP-REALAI-03](REALAI.md#gp-realai-03) | Cost gate: estimator, hard spend cap, metering proxy, kill switches | NOT STARTED | P0 | not-applicable | yes | 3/4 |
| [GP-REALAI-04](REALAI.md#gp-realai-04) | Isolated real-model test environment | NOT STARTED | P1 | not-applicable | yes | 2/2 |
| [GP-REALAI-05](REALAI.md#gp-realai-05) | Result recording: real results kept apart from mock results | NOT STARTED | P0 | not-applicable | yes | - |
| [GP-REALAI-06](REALAI.md#gp-realai-06) | Business Brain retrieval | PARTIAL | P1 | synthetic-only | yes | 3/3 |
| [GP-REALAI-07](REALAI.md#gp-realai-07) | Understanding user intent | PARTIAL | P1 | synthetic-only | yes | 5/5 |
| [GP-REALAI-08](REALAI.md#gp-realai-08) | Selecting the correct tool | PARTIAL | P1 | synthetic-only | yes | 5/5 |
| [GP-REALAI-09](REALAI.md#gp-realai-09) | Requesting approval | PARTIAL | P0 | synthetic-only | yes | 6/6 |
| [GP-REALAI-10](REALAI.md#gp-realai-10) | Handling invalid instructions | PARTIAL | P2 | synthetic-only | yes | 5/5 |
| [GP-REALAI-11](REALAI.md#gp-realai-11) | Updating permitted CRM records | PARTIAL | P0 | synthetic-only | yes | 6/6 |
| [GP-REALAI-12](REALAI.md#gp-realai-12) | Reading calendar information | PARTIAL | P1 | synthetic-only | yes | 6/6 |
| [GP-REALAI-13](REALAI.md#gp-realai-13) | Creating approved schedules | PARTIAL | P1 | synthetic-only | yes | 7/7 |
| [GP-REALAI-14](REALAI.md#gp-realai-14) | Recovering memory | PARTIAL | P1 | synthetic-only | yes | 4/4 |
| [GP-REALAI-15](REALAI.md#gp-realai-15) | Refusing unauthorized actions | PARTIAL | P0 | synthetic-only | yes | 5/5 |
| [GP-REALAI-16](REALAI.md#gp-realai-16) | Resisting prompt injection | PARTIAL | P0 | synthetic-only | yes | 6/6 |
| [GP-REALAI-17](REALAI.md#gp-realai-17) | Preventing tenant data leakage | PARTIAL | P0 | synthetic-only | yes | 7/7 |
| [GP-REALAI-18](REALAI.md#gp-realai-18) | Reporting failures honestly | PARTIAL | P0 | synthetic-only | yes | 6/6 |
| [GP-REALAI-19](REALAI.md#gp-realai-19) | Real-model run, Phase A (no tools) | EXTERNALLY BLOCKED | P1 | externally-blocked | no | - |
| [GP-REALAI-20](REALAI.md#gp-realai-20) | Real-model run, Phase B (pinned Hermes gateway with business tools) | EXTERNALLY BLOCKED | P1 | externally-blocked | no | - |
| [GP-REALAI-21](REALAI.md#gp-realai-21) | Founder decisions and spend approval | EXTERNALLY BLOCKED | P0 | externally-blocked | no | - |
| [GP-QA-01](QA.md#gp-qa-01) | Test groups A (unit) and B (integration, database-backed) | IMPLEMENTED — NOT YET VERIFIED | P1 | synthetic-only | yes | 10/10 |
| [GP-QA-02](QA.md#gp-qa-02) | Test groups C (tenant isolation) and H (security) | IMPLEMENTED — NOT YET VERIFIED | P0 | synthetic-only | yes | 16/16 |
| [GP-QA-03](QA.md#gp-qa-03) | Test group D (end-to-end browser) | PARTIAL | P1 | synthetic-only | yes | 1/1 |
| [GP-QA-04](QA.md#gp-qa-04) | Test group E runtime: pinned Hermes gateway, memory persistence, restart recovery (synthetic) | PARTIAL | P1 | synthetic-only | yes | 5/7 |
| [GP-QA-05](QA.md#gp-qa-05) | Real-model and live-provider verification of the Growth Partner | EXTERNALLY BLOCKED | P1 | externally-blocked | no | 1/1 |
| [GP-QA-06](QA.md#gp-qa-06) | Test group F (external-integration contract tests) | PARTIAL | P1 | synthetic-only | yes | 13/13 |
| [GP-QA-07](QA.md#gp-qa-07) | Test group G (migrations, rollback, upgrade rehearsal) | IMPLEMENTED — NOT YET VERIFIED | P0 | app-functional | yes | 8/8 |
| [GP-QA-08](QA.md#gp-qa-08) | Test group I (UI: responsive, accessibility, naming) | PARTIAL | P2 | synthetic-only | yes | 10/10 |
| [GP-QA-09](QA.md#gp-qa-09) | Test group J (production build, typecheck, lint) | IMPLEMENTED — NOT YET VERIFIED | P1 | app-functional | yes | 2/2 |
| [GP-QA-10](QA.md#gp-qa-10) | Skipped, todo and conditional-skip inventory | IMPLEMENTED — NOT YET VERIFIED | P2 | not-applicable | yes | 8/12 |
| [GP-QA-11](QA.md#gp-qa-11) | CI workflows, triggers, gates and release pipeline | PARTIAL | P1 | app-functional | yes | - |
| [GP-QA-12](QA.md#gp-qa-12) | Production readiness: configuration, secrets, provider credentials, OAuth, domains, billing flags, demo | PARTIAL | P0 | awaiting-configuration | yes | 11/11 |
| [GP-QA-13](QA.md#gp-qa-13) | Production readiness: database backup, restore, migration apply and rollback procedures | PARTIAL | P0 | app-functional | yes | 3/3 |
| [GP-QA-14](QA.md#gp-qa-14) | Production readiness: auth, rate limits, audit, monitoring, scheduler and Work Board recovery, integration health | PARTIAL | P1 | app-functional | yes | 12/12 |
| [GP-QA-15](QA.md#gp-qa-15) | Existing-customer migration, cutover rollback and release documentation | PARTIAL | P0 | synthetic-only | yes | 7/7 |
