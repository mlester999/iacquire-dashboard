# MIGRATE — Existing six-role customer migration

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Domain summary (audit of worktree gp-completion, HEAD 6e4a4b7e, read-only; no tests were run by me):

- Directive §19 asks for a tenant migration of legacy six-role customers to the single AI Growth Partner. Four mechanisms exist and are real database-backed code: (1) a Super Admin per-tenant count inventory, (2) a read-only schedule reconciliation preview, (3) an idempotent "prepare inactive identity candidate" action (`ai_growth_partners.status = 'migration_required'`, no runtime), and (4) an owner/admin reviewed copy of approved legacy notes and released documents into `ai_growth_partner_legacy_knowledge` (migration 0134), which feeds the Partner prompt only after explicit approval. Business Brain drafts from onboarding and company knowledge also respect the `migration_required` state (stay draft until explicit activation).
- Everything after those first steps is missing: no readiness verdict, no persisted migration report, no runtime binding or provisioning path for an existing tenant (the only creator of a Partner runtime is new-client creation at `src/server/admin/tenants.ts:160`), no way to ever leave `migration_required` (no code transitions it), no schedule cutover, no conversation link or summary, no cutover action, no rollback or candidate-discard action, no dry run, no end-to-end synthetic tenant migration test, and no fleet-wide list of legacy tenants.
- The docs are accurate about the three headline mechanisms, but they understate the knowledge-review feature (0134 is not described in migration-strategy.md) and the implementation overstates a few things (see "Doc claims" in the final row). Several UI strings imply history stays available to clients, yet no client screen reads legacy conversation messages and `/chat/[slug]` redirects every client workspace to the Partner thread (`src/app/(chat)/chat/[slug]/page.tsx:22`), which cannot exist for an unmigrated tenant.
- Strongest evidence: real-path PGlite tests for inventory, candidate preparation, schedule preview and legacy knowledge (tests/growth-partner-migration-inventory.test.ts, growth-partner-migration-candidate.test.ts, growth-partner-schedule-migration.test.ts, ai-growth-partner-legacy-knowledge.test.ts, ai-growth-partner-unified-context-e2e.test.ts). Server-action tests (growth-partner-migration-action.test.ts) and the legacy knowledge panel test mock the services and only prove authorization wiring and UI behaviour.
- Biggest gaps: no cutover/rollback/runtime-binding code at all (P0/P1), legacy tenants already lose their six-role chat UI before any migration (P0), and the client provisioning preflight classifies the transitional state (six profiles plus a candidate row, or six plus a Partner runtime) as an unsupported mixed model (P1).
- Schema migrations (`npm run rehearse:migrations`, scripts/rehearse-combined-migrations.mjs) are a different thing: they rehearse SQL apply/rollback in PGlite and have no tenant-migration semantics. Prior recorded runs are in implementation-status.md (docs only; I did not run them).

<a id="gp-migrate-01"></a>
### GP-MIGRATE-01 — Fleet inventory of legacy tenants and migration state per tenant

- **Requirement:** Fleet inventory of legacy tenants and migration state per tenant (directive §19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/queries.ts`, `src/server/workforce/client-provisioning-preflight.ts`, `src/components/admin/client-workforces-manager.tsx`, `src/server/onboarding/service.ts`
- **Test coverage:** tests/client-provisioning-preflight.test.ts:442 (real DB: complete legacy and unified clients accepted; incomplete, mixed or unlinked flagged). Proves the finding query; does not prove a migration cohort view. Nothing tests a list of legacy tenants.
- **Real or simulated behavior:** Real DB reads. listGrowthPartners inner-joins ai_growth_partners so unmigrated legacy tenants are absent; the preflight returns capped id lists for unsupported models only.
- **Missing dependencies:** none external.
- **Remaining work:** Add a Super Admin fleet query returning every non-demo client org with a migration phase (legacy, candidate prepared, runtime bound, cut over, rolled back, unsupported) and blockers; surface it in client-workforces-manager with a filter; add a multi-tenant DB test.
- **Verification evidence:** I read the queries and the preflight SQL; the preflight finding returns ids only (capped by `FINDING_IDS`) and treats a candidate row plus six profiles as unsupported.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Super Admin sees all client tenants with migration phase and blockers in one list; a synthetic fleet test asserts each classification and tenant isolation.

<a id="gp-migrate-02"></a>
### GP-MIGRATE-02 — Per-tenant inventory of profiles, credentials, knowledge, history, schedules and assignments

- **Requirement:** Per-tenant inventory of profiles, credentials, knowledge, history, schedules and assignments (directive §19)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/queries.ts`, `src/components/admin/client-detail.tsx`
- **Test coverage:** tests/growth-partner-migration-inventory.test.ts (real PGlite: exact 29-field expectation, no private strings leak, no data changed, other tenant excluded, corrupted cross-tenant credential not counted, assigned staff sees `null`). Strong real-path test of counts. It does not prove per-role identifiers/status, health evidence, tool inventory, hosts or purchase entitlements, because the inventory does not return them.
- **Real or simulated behavior:** Real tenant-scoped SQL aggregates (29 count fields) for Super Admins; counts only, no content or credentials.
- **Missing dependencies:** none external.
- **Remaining work:** Add per-role identifier and status rows (enabled, status, profile id and host, health result, config version ids), per-provider integration status, and purchase entitlement flags, with leak and isolation tests. Not persisted anywhere. | Skeptic adds: Scope openApprovals to legacy profiles or label it org-wide; include soft-deleted/retention-blanked conversation counts so lost history is visible.
- **Verification evidence:** read the query and test; the test's expected object matches the 29-field interface. Prior recorded run (docs, not mine): inventory tests 144/144 across 9 files and a focused 1/1 rerun (implementation-status.md lines 113-118).
  - *Skeptic review: Holds (29 fields, real SQL, real test) with two precision gaps in what the counts mean.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Inventory returns per-role id/status rows plus aggregates including health evidence and entitlements, with a no-secret leak test and tenant isolation test.

<a id="gp-migrate-03"></a>
### GP-MIGRATE-03 — Per-tenant readiness report with blockers and a persisted migration report

- **Requirement:** Per-tenant readiness report with blockers and a persisted migration report (directive §19)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** none exist. Closest: `src/server/admin/growth-partner-migration.ts` (inventory is elsewhere); no table stores a migration report (migrations through 0135 contain none; `ai_growth_partner_versions.source` has a `'migration'` value from 0120 but no code writes it, grep found no insert with that source).
- **Test coverage:** none.
- **Real or simulated behavior:** Nothing exists. The inventory card states readiness is unverified; no table stores a migration report and no code writes ai_growth_partner_versions.source = 'migration'.
- **Missing dependencies:** none external; founder wording and thresholds for go/no-go.
- **Remaining work:** Create a readiness evaluator returning pass/warn/block per check, persist immutable reports in a new table (new migration with RLS and audit), add admin UI and tests; cutover and rollback must reference the stored report.
- **Verification evidence:** grep for readiness/report in src found no migration-specific code.
- **Definition of done:** A Super Admin can generate and view a stored immutable readiness report per tenant; cutover refuses without a passing, current report.

<a id="gp-migrate-04"></a>
### GP-MIGRATE-04 — Map former six-role capabilities to the Growth Partner

- **Requirement:** Map former six-role capabilities to the Growth Partner (directive §19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-capabilities.ts`, `src/server/ai-growth-partner/legacy-knowledge.ts`, `src/server/admin/growth-partner-migration.ts`, `src/lib/ai-growth-partner.ts`
- **Test coverage:** tests/growth-partner-schedule-migration.test.ts (real DB; asserts the flag for two capabilities); tests/ai-growth-partner-legacy-knowledge.test.ts:93 (labels for six roles). These prove the mapping constants, not a per-tenant mapping report. No test covers legacy per-role settings (tone, reply length, action policy, tool policy overrides, config versions) being carried or intentionally dropped.
- **Real or simulated behavior:** Static policy constants (allowedRoles, LEGACY_ROLE_CAPABILITY) and a policy-eligibility flag in the schedule preview; no per-tenant verification of tools, permissions or action switches.
- **Missing dependencies:** none external for the code; founder decision on what happens to non-read-only legacy capabilities (outreach, CRM updates, calendar writes).
- **Remaining work:** Emit a per-tenant mapping table (legacy role, capability, Partner capability, action switch, permission, tool readiness, disposition) in the readiness report; decide and document disposition of legacy config versions, persona and per-employee overrides; test with a tenant with non-default settings.
- **Verification evidence:** read the capability table and preview code; the mapping only checks policy eligibility, as the UI text itself states (`client-detail.tsx:398-400`).
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For a synthetic six-role tenant every former capability has a Partner counterpart and explicit disposition, including settings that are not carried over.

<a id="gp-migrate-05"></a>
### GP-MIGRATE-05 — Preview of schedule changes (reconciliation of old schedules and open work)

- **Requirement:** Preview of schedule changes (reconciliation of old schedules and open work) (directive §19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/growth-partner-migration.ts`, `src/app/(admin)/admin/migration-actions.ts`, `src/components/admin/client-detail.tsx`
- **Test coverage:** tests/growth-partner-schedule-migration.test.ts (real PGlite: summary counts, eligible mapping, duplicate partner schedule, open work with idempotency key, private assignment text not returned, nothing mutated, other tenant excluded, refusal for unknown/agency/inactive org); tests/growth-partner-migration-action.test.ts:74-111 (mocked service: authorization wiring only). It proves the preview reads; it does not prove a proposed after-state because none is produced.
- **Real or simulated behavior:** Real read-only DB query via trusted service; the action test mocks the service (authorization wiring only).
- **Missing dependencies:** none external.
- **Remaining work:** Preview is not a diff: add proposed Partner schedule per legacy schedule (create, merge, leave paused, needs decision) including recurrence rule and business hours; give owners a way to review assignment text; match by more than capability; correct the all-six-profiles claim or enforce it.
- **Verification evidence:** read code and both tests. Prior recorded run (docs): preview commit 5a45321b; I did not run tests.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Preview returns per-schedule proposed actions and conflicts, owner can review assignments, and a test asserts the diff without mutating data.

<a id="gp-migrate-06"></a>
### GP-MIGRATE-06 — Reversible identity-preparation action and duplicate-Partner prevention

- **Requirement:** Reversible identity-preparation action and duplicate-Partner prevention (directive §19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/growth-partner-migration.ts`, `src/app/(admin)/admin/migration-actions.ts`, `src/components/admin/client-detail.tsx`, `supabase/migrations/0120_ai_growth_partner_foundation.sql`, `supabase/migrations/0121_ai_growth_partner_conversation.sql`, `supabase/migrations/0002_workforce.sql`
- **Test coverage:** tests/growth-partner-migration-candidate.test.ts (real PGlite: creates exactly one inactive row, retry idempotent, profiles/schedules/jobs/approvals unchanged, no version/conversation/runtime, audit metadata, other tenant untouched, refuses incomplete set, agency org, suspended org, orphan runtime, existing setup, unknown tenant); tests/ai-growth-partner-foundation.test.ts:220 (single partner per tenant, independent role records); tests/growth-partner-migration-action.test.ts:24-72 (mocked service; checks both authorization calls and UUID validation). Missing: concurrency race, `is_demo` orgs (not excluded in code), and the status never leaving `migration_required` (see GP-MIGRATE-14).
- **Real or simulated behavior:** Real audited DB write behind super_admin plus agency.workforce.manage; DB unique constraints (org_id, runtime id, org+role) enforce one Partner per tenant.
- **Missing dependencies:** none external.
- **Remaining work:** Add concurrency test, decide demo-org handling (not excluded in code), record approver metadata beyond the audit row; the candidate can never be discarded or advanced (see 14 and 15). | Skeptic adds: Make launch-readiness, reports, setup/core and preflight treat status migration_required (no runtime) as legacy-model; add tests that prepare a candidate and then read launch readiness, briefing title and preflight; compute audit metadata flags instead of literals; remove 'reversible' wording until a discard action exists.
- **Verification evidence:** read the service, action, migration SQL and tests. Prior recorded run (docs): 6/6 tests across two files (implementation-status.md line 136); not mine.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: The action does what it inserts, and duplicate prevention is real, but it is presented as inert and reversible. Other readers treat any ai_growth_partners row as the unified model, so preparing a candidate changes a live legacy tenant's client-visible launch readiness, briefing titles and provisioning preflight. No discard path exists, so 'reversible' is unbacked.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Concurrent-call test passes, demo behaviour decided and tested, approval metadata recorded.

<a id="gp-migrate-07"></a>
### GP-MIGRATE-07 — Reviewed import of retained notes and documents into Partner knowledge (snapshot queue)

- **Requirement:** Reviewed import of retained notes and documents into Partner knowledge (snapshot queue) (directive §19)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/legacy-knowledge.ts`, `supabase/migrations/0134_ai_growth_partner_legacy_knowledge.sql`, `supabase/rollbacks/0134_ai_growth_partner_legacy_knowledge.down.sql`, `src/server/workforce/knowledge.ts`, `src/app/actions/ai-growth-partner.ts`, `src/components/growth-partner/legacy-knowledge-review.tsx`, `src/components/growth-partner/control-center.tsx`
- **Test coverage:** tests/ai-growth-partner-legacy-knowledge.test.ts (real PGlite: lists and previews only released, risk-free tenant sources; imports note and document snapshots idempotently; legacy rows untouched; pending and rejected snapshots absent from the real `employeeKnowledgeContext` block, approved present; member denied, cross-tenant and stale sources refused; audit has no source text); tests/ai-growth-partner-unified-context-e2e.test.ts:127-140 (real prompt composition); tests/growth-partner-legacy-knowledge-review.test.tsx (jsdom, server actions mocked: UI flow only). Limits not tested: truncation behaviour, the 24-item prompt cap, and no test that a `migration_required` candidate can import.
- **Real or simulated behavior:** Real DB services and real prompt-context assembly; the UI test mocks server actions. Snapshots are owner/admin self-service; sources are never modified.
- **Missing dependencies:** none external.
- **Remaining work:** Add Super Admin and owner import preview showing included, truncated (3000-char document cut), skipped and capped (24 approved snapshots in prompt) items; test migration_required candidates and the cap; surface cross-role conflicts. | Skeptic adds: Approved snapshots only enter a prompt for the bound Partner runtime (knowledge.ts:117-121), so for a migrating candidate they cannot take effect until runtime binding exists; add a test using a prepared candidate rather than a bound-runtime partner. The review panel is only visible after an admin prepares the candidate (page.tsx:59-61).
- **Verification evidence:** read all functions, migration and tests. Prior recorded run (docs): focused 11/11 and full regression 897 files (implementation-status.md lines 150-152); not mine.
  - *Skeptic review: Status stands (real DB path, real prompt assembly), but the end-to-end claim for a migrating tenant is unreachable and untested with a prepared candidate.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Admin and owner see an exact import preview and the cap and truncation are tested.

<a id="gp-migrate-08"></a>
### GP-MIGRATE-08 — Business Brain import from retained notes and company knowledge for a migrating tenant

- **Requirement:** Business Brain import from retained notes and company knowledge for a migrating tenant (directive §19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts`, `supabase/migrations/0120_ai_growth_partner_foundation.sql`
- **Test coverage:** tests/ai-growth-partner-foundation.test.ts:460 (real DB: onboarding snapshot on a `migration_required` partner stays a draft, retry reuses it, explicit activation works, status stays `migration_required`), `:507`, `:590` (company knowledge assembly and sync). Nothing covers importing retained employee notes into Brain facts, because that code does not exist.
- **Real or simulated behavior:** Onboarding and company-knowledge Brain drafts are real DB code (deterministic mapping, drafts for migration_required, explicit activation). Retained employee notes never become structured Brain facts; the 'migration' version source is never written.
- **Missing dependencies:** none external for deterministic mapping; any model-assisted extraction would need paid model spend and is not required.
- **Remaining work:** Build a mapper from approved employee notes (and approved snapshots) to draft Brain facts with provenance and conflict display, reviewed via the existing draft UI; add admin-side preview and tests.
- **Verification evidence:** read the service paths and the foundation tests; a grep for writes of source `'migration'` returned none.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A synthetic tenant with notes across six roles yields a reviewable Brain draft with per-fact sources, conflicts shown, and no fact activated without owner action.

<a id="gp-migrate-09"></a>
### GP-MIGRATE-09 — Legacy memory handling (app-side memory preview and import decision)

- **Requirement:** Legacy memory handling (app-side memory preview and import decision) (directive §19)
- **Current implementation status:** NOT STARTED
- **Priority:** P2  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/memory.ts`, `supabase/migrations/0130_ai_growth_partner_memory.sql`
- **Test coverage:** tests/ai-growth-partner-memory.test.ts covers Partner memory only (no migration path).
- **Real or simulated behavior:** Nothing for migration: Partner memory CRUD exists, but no code previews or imports legacy profile memory; Hermes-native memory carry-over is unverified.
- **Missing dependencies:** Hermes-native memory carry-over needs a real pinned runtime (see GP-MIGRATE-11, externally blocked); the app-side decision needs founder input.
- **Remaining work:** Decide what legacy memory exists in the app database, whether any is imported as reviewed Partner memories, show this in the migration preview, and state explicitly that Hermes-native memory is not migrated; add tests for any import path.
- **Verification evidence:** grep for memory in the migration files found nothing; docs record `hermesMemoryVerified: false` in the restart acceptance (docs only).
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The report lists which memory sources are imported, reviewed or discarded, with tests for any import.

<a id="gp-migrate-10"></a>
### GP-MIGRATE-10 — Runtime binding path for an existing tenant (create or attach growth_partner profile row and link to the candidate)

- **Requirement:** Runtime binding path for an existing tenant (create or attach growth_partner profile row and link to the candidate) (directive §19)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/service.ts`, `src/server/admin/tenants.ts`, `src/server/workforce/provisioning.ts`, `supabase/migrations/0121_ai_growth_partner_conversation.sql`
- **Test coverage:** tests/growth-partner-schedule-migration.test.ts and tests/growth-partner-migration-inventory.test.ts call `ensureGrowthPartnerRuntime` on a legacy fixture org to simulate a bound runtime; tests/ai-growth-partner-foundation.test.ts:254 covers DB binding integrity. No test covers binding a runtime to a prepared candidate.
- **Real or simulated behavior:** Nothing for legacy tenants. ensureGrowthPartnerRuntime uses on conflict do nothing so it never links an existing unbound candidate; its only caller is new-client creation (tenants.ts:160).
- **Missing dependencies:** none for the code; live provisioning is GP-MIGRATE-11.
- **Remaining work:** Add an audited Super Admin service that creates a disabled tenant-specific growth_partner agent_instances row, links it to the candidate in one locked transaction, creates a provisioning request, refuses reuse of legacy profile, credential or gateway bindings, and defines the status transition from migration_required; test double call and cross-tenant refusal.
- **Verification evidence:** grep for `runtime_agent_instance_id =` writes found none outside tests and the new-client path.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A prepared candidate can be bound to a new disabled runtime through an audited action with the six legacy rows untouched and constraints holding.

<a id="gp-migrate-11"></a>
### GP-MIGRATE-11 — Real tenant-isolated Hermes profile, health, tool-inventory and tenant-boundary checks for a legacy tenant

- **Requirement:** Real tenant-isolated Hermes profile, health, tool-inventory and tenant-boundary checks for a legacy tenant (directive §19)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `src/server/workforce/provisioning.ts`, `src/server/workforce/service.ts`, `src/server/workforce/client-provisioning-preflight.ts`
- **Test coverage:** the pinned-runtime two-client proof and fixture acceptance (tests/ai-growth-partner-fixture-acceptance.test.ts) use synthetic fixtures for new-model tenants; none for a migrated tenant.
- **Real or simulated behavior:** Not performed for any migrating tenant; existing provisioning and health code is real but exercised with synthetic fixtures for new-model tenants.
- **Missing dependencies:** VPS/Hermes gateway access and credentials, a customer or founder-approved staging tenant, and explicit written approval naming tenant, profiles and environment (migration-strategy.md "Release and approval boundary").
- **Remaining work:** After GP-MIGRATE-10, provision a disposable staging tenant and record real health, tool-inventory and tenant-boundary evidence; do not touch production profiles without approval.
- **Verification evidence:** docs say no live tenant was migrated (implementation-status.md line 128); I found no live evidence in the repository.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Recorded real-gateway evidence (health ok, toolset check, refused cross-tenant read) for one disposable migrated tenant.

<a id="gp-migrate-12"></a>
### GP-MIGRATE-12 — Preserve and link historical conversations, audit history and assignments

- **Requirement:** Preserve and link historical conversations, audit history and assignments (directive §19)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/growth-partner-migration.ts`, `supabase/migrations/0121_ai_growth_partner_conversation.sql`, `src/app/(chat)/chat/[slug]/page.tsx`, `src/app/(portal)/growth-partner/conversation/page.tsx`, `src/components/growth-partner/permanent-conversation.tsx`, `src/server/ai-growth-partner/service.ts`, `src/server/chat/service.ts`, `src/components/workforce/employee-summary.tsx`
- **Test coverage:** tests/growth-partner-migration-candidate.test.ts and the inventory test prove rows are unchanged and counted; tests/client-legacy-chat-redirect.test.ts proves the redirect, with services mocked; tests/ai-growth-partner-conversation.test.ts:10 covers the Partner thread. Nothing proves a client can read legacy history after the redirect, and nothing tests a historical link or summary.
- **Real or simulated behavior:** Preservation by non-destruction is real and tested for the candidate step only. No link table or summary exists; growth_partner_id FK ties to the Partner runtime so legacy conversations cannot be tagged. Every client workspace is redirected from /chat/[slug] to the Partner thread, which shows 'still being set up' for tenants without a runtime.
- **Missing dependencies:** owner decision on link versus reviewed summary (strategy step 5 says do not concatenate six chats).
- **Remaining work:** Stop redirecting legacy tenants until a Partner runtime is bound or add a read-only previous-conversations viewer; add a tenant-scoped historical link table with owner-approved summaries and source ids; ensure retention and delete cannot purge conversations of a tenant in migration; add tests for conversations, jobs and audit rows across cutover and rollback. | Skeptic adds: Any read-only archive viewer must not call listConversations/getConversation via the retention path: applyRetentionIfDue (chat/service.ts:2306) triggers applyRetention, which blanks message content and soft-deletes legacy conversations when chatRetentionDays is set (:2367-2384). Exempt tenants in migration or add a retention-free read. Also fix stale 'history remains available' copy (permanent-conversation.tsx:300, employee-summary.tsx:55).
- **Verification evidence:** I read the redirect, the Partner thread query, the empty state and the 0121 FK. I did not run the app.
  - *Skeptic review: P0 confirmed: client orgs are redirected before any legacy chat loads, and no client screen reads legacy messages. The auditor's suggested remedy would reintroduce a destructive retention side effect.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A legacy tenant keeps access to previous conversations at every phase, an optional reviewed summary links to sources, and a test shows all six histories, jobs and audit rows intact after cutover and rollback.

<a id="gp-migrate-13"></a>
### GP-MIGRATE-13 — Dry run and validation of the expected end state

- **Requirement:** Dry run and validation of the expected end state (directive §19)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/client-provisioning-preflight.ts`, `scripts/rehearse-combined-migrations.mjs`
- **Test coverage:** no test runs a synthetic legacy tenant through the whole path (inventory, candidate, knowledge, runtime, schedules, cutover, validation, rollback). The preflight test has no `migration_required` case. Prior docs claim schema rehearsals passed through 0135 (not mine).
- **Real or simulated behavior:** No tenant-migration dry run or validator. Schema rehearsal (PGlite) is separate. The preflight reports six legacy rows plus a candidate or a Partner runtime as an unsupported mixed model.
- **Missing dependencies:** none external for a synthetic dry run.
- **Remaining work:** Implement dryRun returning intended writes without performing them; a validation evaluator (one active Partner, one authorized runtime, no duplicate schedules or jobs, six histories intact, no cross-tenant reads); teach the preflight a migration-phase model; add a PGlite end-to-end synthetic tenant test.
- **Verification evidence:** grep for dry run in migration code found nothing; I read the preflight SQL.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Dry-run output matches actual cutover writes on a synthetic tenant and the validator passes after cutover and after rollback.

<a id="gp-migrate-14"></a>
### GP-MIGRATE-14 — Approved cutover action (identity activation, schedule cutover, in-flight work handling)

- **Requirement:** Approved cutover action (identity activation, schedule cutover, in-flight work handling) (directive §19)
- **Current implementation status:** NOT STARTED
- **Priority:** P0  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts`, `src/server/workforce/schedules.ts`, `src/server/workforce/service.ts`
- **Test coverage:** none.
- **Real or simulated behavior:** Nothing exists. No code moves a partner out of migration_required (state is passed through at service.ts:536); Brain activation leaves status unchanged. Only building blocks exist (saveSchedule, setScheduleEnabled, runDueSchedules behind the operator switch).
- **Missing dependencies:** owner approval step per tenant; founder approval before any production cutover; operator schedule switch stays off by default.
- **Remaining work:** Implement an audited cutover service and owner approval record: check stored readiness report, pause old schedules, resolve in-flight jobs and equivalent idempotency keys, create or enable Partner schedules from approved mappings without enabling outreach, change partner status, disable legacy profiles without deleting, record the pre-cutover snapshot; add UI and DB tests including in-flight jobs and duplicate-schedule guards.
- **Verification evidence:** grep for cutover in src found only the CRM provider switch (unrelated; src/app/actions/crm-provider-switch.ts and its wizard). I read the schedule runner.
- **Definition of done:** A synthetic tenant is cut over by one audited, owner-approved action with no duplicate schedules and no lost jobs; dry run matches the writes.

<a id="gp-migrate-15"></a>
### GP-MIGRATE-15 — Rollback and recovery (discard candidate, post-cutover restore)

- **Requirement:** Rollback and recovery (discard candidate, post-cutover restore) (directive §19)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `docs/ai-growth-partner/migration-strategy.md`, `supabase/rollbacks/0134_ai_growth_partner_legacy_knowledge.down.sql`
- **Test coverage:** none for tenant rollback. Schema rollback of 0134 is covered by the rehearsal script (docs claim only).
- **Real or simulated behavior:** Prose only. Even a prepared candidate cannot be discarded: no application delete or reset path exists for ai_growth_partners. The 0134 down script is a schema rollback that refuses once snapshots exist.
- **Missing dependencies:** founder decision on which states are recoverable.
- **Remaining work:** Add a discard-candidate action for unbound unused candidates and a post-cutover rollback that pauses Partner schedules and runtime, waits for in-flight jobs, restores the recorded legacy schedule and enabled state, appends rollback audit events and never restores revoked credentials; test both and that six histories are unchanged.
- **Verification evidence:** grep for Growth Partner rollback or retire code in src found none (only the unrelated CRM provider switch uses those words); schema down-scripts live in supabase/rollbacks.
- **Definition of done:** A cut-over synthetic tenant can be rolled back to its recorded legacy state with history intact and audit appended; an unbound candidate can be discarded.

<a id="gp-migrate-16"></a>
### GP-MIGRATE-16 — Documentation of non-reversible operations and accuracy of migration claims

- **Requirement:** Documentation of non-reversible operations and accuracy of migration claims (directive §19)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `docs/ai-growth-partner/migration-strategy.md`, `src/components/admin/client-detail.tsx`, `src/components/growth-partner/control-center.tsx`, `src/components/workforce/employee-summary.tsx`
- **Test coverage:** none (documentation). Doc claims not backed by code are listed in the structured result.
- **Real or simulated behavior:** Documentation and UI copy only; the strategy has rollback and retire sections but no reversibility table and does not describe the 0134 knowledge review.
- **Missing dependencies:** none.
- **Remaining work:** Add an operations-by-reversibility table, describe the knowledge review and its limits, correct the all-six-profiles preview claim and the history-availability copy, and keep a checklist test.
- **Verification evidence:** I read migration-strategy.md in full and the UI strings.
- **Definition of done:** Docs and UI state which operations exist, which are reversible and which are not, and match the code.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Candidate isolation: an unbound migration_required row must not change launch readiness, briefing labels, setup wording or provisioning preflight for a still-legacy tenant", "directiveRef": "§19 (do not modify real production customer profiles without approval; preserve existing service)", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "Gate the Partner branch in readLaunchFacts, reports identity, ensureSetupInstance and the preflight model check on a bound runtime (or on status), and add DB tests that prepare a candidate and assert the tenant's launch card, briefing title and preflight are unchanged."}
- {"title": "Legacy conversation retention/delete protection while a tenant is migrating", "directiveRef": "§19 (do not destroy history; preserve historical conversations)", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "Skip applyRetention (message blanking and soft-delete) and legacy delete for tenants with a candidate or runtime-bound Partner until the rollback window closes; test that content and rows survive."}
- {"title": "Production guard and recorded approval for migration actions (operator switch, demo-org exclusion, approver/date/reason)", "directiveRef": "§19 (approved cutover action; never modify production without explicit approval)", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "Add an operator switch defaulting off for the prepare/cutover actions, exclude is_demo orgs, and persist an approval record (who, when, why, tenant) checked by the service, not only an audit row."}
