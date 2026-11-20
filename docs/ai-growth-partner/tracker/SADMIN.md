# SADMIN — Super Admin and internal operations

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Audit of worktree gp-completion (branch claude/ai-growth-partner-completion, HEAD 6e4a4b7e). Read-only static audit: no tests, builds or servers were run; every "test proves" statement below comes from reading the test source, and "prior recorded runs" come only from docs/ai-growth-partner/implementation-status.md.

What exists and is real: a mature agency admin area under src/app/(admin)/admin with real Postgres-backed services (queries.ts, tenants.ts, agency-registry.ts, health.ts, growth-partner-migration.ts), server actions that re-check role, client scope and permission on the server (requireAgencyOrThrow / requireAgencyOrgPermissionOrThrow / requireAgencyPermissionOrThrow + SQL functions app.user_can_access_org and app.user_has_agency_permission), a Super-Admin-only AQi Operations copilot with a deterministic planner and D70-aware read tools that already understand the growth_partner role, and a count-only migration inventory plus schedule-reconciliation preview and an identity-only migration candidate (all DB-tested). Nothing in this domain is simulated by scripted text: the admin screens read live tables. The Hermes runtime itself is outside this domain and is only ever read through recorded health columns.

Biggest gaps: (1) the admin "tenant detail" page is blind to the NEW-client Growth Partner runtime: agents, provisioning jobs, failed runs, held config reviews and all runtime controls (health check, retry setup, contain) are filtered to the six legacy role keys, and new clients get only a growth_partner row (tenants.ts:160), so those panels are empty or unreachable for them; (2) listGrowthPartners (the headline /admin/employees list) reads under the person's RLS role, where agents.use is not granted to agency roles and runtimeReadySql(credentialRevocation) reads integration_credentials (no grants), so it most likely returns nothing or errors on a real database; it is covered only by a mocked render test; (3) /admin/health shows failed-run error text, approval-failure text and client names for ALL tenants to ANY agency role, ignoring client scope and the D70 content rule; (4) no Super Admin surface for the partner's Work Board jobs/schedules, Business Brain health, capability/ability switches, or tenant-filtered audit; (5) no test enumerates admin routes/actions against the role matrix; (6) docs overstate: "runtime controls label the current profile AI Growth Partner" is true only of the label function, the page never passes the partner to the controls.

Verdict counts: 0 COMPLETE_VERIFIED (not assignable by this audit), 5 IMPLEMENTED_UNVERIFIED, 9 PARTIAL, 1 NOT_STARTED, 0 EXTERNALLY_BLOCKED (external dependencies noted inside rows; every remaining step listed is doable in the repo).

<a id="gp-sadmin-01"></a>
### GP-SADMIN-01 — View tenant Growth Partner readiness (fleet list, dashboard KPI, per-client summary)

- **Requirement:** View tenant Growth Partner readiness (fleet list, dashboard KPI, per-client summary) (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/queries.ts`, `src/server/workforce/agency-registry.ts`, `src/lib/employee-runtime.ts`, `src/app/(admin)/admin/page.tsx`, `src/app/(admin)/admin/employees/page.tsx`, `src/app/(admin)/admin/employees/clients/page.tsx`, `src/components/admin/growth-partner-manager.tsx`, `src/components/admin/client-workforces-manager.tsx`, `supabase/migrations/0120_ai_growth_partner_foundation.sql`, `supabase/migrations/0006_reference_data.sql`
- **Test coverage:** tests/agency-team-permissions.test.ts "removes denied workforce and support data from the admin dashboard" (DB-backed: partner runtime counts, assigned-only scope, permission denial) proves the dashboard KPI. tests/agency-hermes-workforce.test.ts 279-299 proves listClientWorkforceSummaries scope and refusal. tests/client-workforces-manager.test.tsx renders the grid from fixtures. tests/growth-partner-admin-priority.test.tsx MOCKS listGrowthPartners and only checks section order and copy. NOTHING runs listGrowthPartners against a database.
- **Real or simulated behavior:** Real DB reads of recorded health columns. getAdminOverview and listClientWorkforceSummaries are DB-tested; listGrowthPartners (the /admin/employees grid) is real SQL but is only covered by a mocked render test and, by static analysis, runs under the person's RLS role where agents.use is not granted to agency roles and where runtimeReadySql(credentialRevocation) reads integration_credentials (no grants), so it most likely returns no rows or errors.
- **Missing dependencies:** none external.
- **Remaining work:** Rewrite listGrowthPartners (queries.ts 544-590) to check agency.workforce.view then read with withSystem filtered by app.user_can_access_org; add a two-tenant DB test (assigned staff sees only A, revoked credential not 'configured', denied permission refused); share one status helper instead of three CASE copies; show an error state instead of a 500. | Skeptic adds: The failure is likely a hard 'permission denied', not an empty grid: integration_credentials has no grant for iaq_app_user, and Postgres checks privileges at executor start even for an unevaluated CASE branch. /admin/employees puts the call in Promise.all with no catch, so the whole page can throw. Add a DB test running listGrowthPartners as a real agency user. Also reconcile the KPI (runtimeReadySql without credentialRevocation) with the grid and card (with it).
- **Verification evidence:** Own observation (static): read RLS policy ai_growth_partners_select, role_permissions seed (agents.use false for agency roles), withUser sets role iaq_app_user (src/server/db/index.ts 272-292), integration_credentials has no grants for iaq_app_user (0002_workforce.sql 397). The in-code comment at queries.ts 478 already states partner identity is readable only to clients with agents.use under RLS. Not run. Prior recorded runs: docs line 41 and 65 report focused render tests only.
  - *Skeptic review: The auditor's PARTIAL stands. Static reading shows a likely crash of the headline page, not merely missing rows. Credit omitted: the per-tenant agency setup page (getAgencyLaunchChecklist, growthPartnerRow) is a real readiness view for the partner, covering bound, brain active, runtime ready, health failed, provisioning failed and paused. This is inferred from code and was not run.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Super Admin and an assigned staff member each open /admin/employees and see exactly their authorized clients' partners with status, brain version, runs and failures, proven by a DB test; the dashboard KPI and the grid agree on the same data.

<a id="gp-sadmin-02"></a>
### GP-SADMIN-02 — View the provisioned Growth Partner identity (per-client card)

- **Requirement:** View the provisioned Growth Partner identity (per-client card) (directive §18)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/queries.ts`, `src/components/admin/client-detail.tsx`, `src/app/(admin)/admin/clients/[id]/page.tsx`, `src/server/workforce/service.ts`, `src/server/admin/tenants.ts`
- **Test coverage:** tests/growth-partner-migration-inventory.test.ts and tests/client-content-policy.test.ts call getTenantDetail with a partner present, but no test asserts the returned growthPartner object (status derivation, binding, version labels). tests/client-onboarding-acceptance.test.ts proves creation of exactly one identity and runtime for a new client (DB-backed) but not the admin view.
- **Real or simulated behavior:** Real. getTenantDetail reads ai_growth_partners joined to the bound growth_partner agent_instances row via withSystem after an explicit client-scope and workforce.view check. No test asserts the returned growthPartner object.
- **Missing dependencies:** none.
- **Remaining work:** Add DB test asserting detail.growthPartner for new, configured, paused, migration_required and revoked-credential cases; show gateway, credential state, tool inventory digest/count/expiry, runtime id and persona on the card; add a Check connection control.
- **Verification evidence:** Own observation: read the query and card; the card is read-only, shows runtime status, hermes profile, Business Brain version label, 30-day runs/failures, last conversation timestamp, and the "status only, does not open the conversation" privacy statement. Prior recorded runs: docs line 67 (focused UI/DB tests 16/16, recorded by prior team, not re-run).
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The card shows binding, gateway, credential state, inventory freshness and brain version; a DB test pins every status branch; a staff member with workforce.view sees it and one without does not.

<a id="gp-sadmin-03"></a>
### GP-SADMIN-03 — Review Business Brain configuration health

- **Requirement:** Review Business Brain configuration health (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/queries.ts`, `src/components/admin/client-detail.tsx`, `src/components/admin/growth-partner-manager.tsx`, `src/server/setup/launch-readiness.ts`, `src/lib/launch-readiness.ts`, `src/server/ai-growth-partner/service.ts`, `supabase/migrations/0120_ai_growth_partner_foundation.sql`, `supabase/migrations/0130_ai_growth_partner_memory.sql`, `supabase/migrations/0133_ai_growth_partner_goals.sql`, `supabase/migrations/0134_ai_growth_partner_legacy_knowledge.sql`
- **Test coverage:** tests/growth-partner-migration-inventory.test.ts (counts, no content leak, DB-backed); tests/launch-readiness.test.ts 70-80 (pure derivation); tests/client-onboarding-acceptance.test.ts 120-215 (DB: activated version, one version per onboarding). No test of any admin Business Brain health view because none exists.
- **Real or simulated behavior:** Only a version label (Active vN / Draft vN / Not prepared) and Super Admin-only knowledge-source counts are real; there is no health analysis of the Business Brain and no admin test because no such view exists.
- **Missing dependencies:** none external.
- **Remaining work:** Add src/server/admin/growth-partner-brain-health.ts returning counts only (fact verification states, active vs latest vs draft age, pending legacy-knowledge reviews, memory and goal counts, last change source/actor); show on the client Workforce tab and fleet grid; mask text via clientContentAccess; decide whether Super Admin may edit drafts (source 'agency_edit' is allowed by the 0120 constraint but no code writes it).
- **Verification evidence:** Own observation (static): grep for "agency_edit" and ai_growth_partner.* in src/app/(admin) and src/components/admin finds nothing beyond the version label.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For any authorized client a Super Admin sees, without reading content, whether the Business Brain is active, current, complete enough to serve and free of unreviewed imports; counts match DB rows in a test; content is withheld when D70 requires a support session.

<a id="gp-sadmin-04"></a>
### GP-SADMIN-04 — Inspect tool and capability availability

- **Requirement:** Inspect tool and capability availability (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/tool-policies.ts`, `src/components/admin/hermes-tool-policies.tsx`, `src/app/(admin)/admin/employees/policies/page.tsx`, `src/lib/employee-runtime.ts`, `src/server/ai-growth-partner/capability-access.ts`, `src/lib/ai-growth-partner-capability-access.ts`, `src/server/workforce/abilities.ts`, `src/lib/workforce-capabilities.ts`
- **Test coverage:** tests/hermes-tool-policies.test.ts, tests/hermes-tool-policies-ui.test.ts, tests/hermes-tool-inventory.test.ts, tests/employee-tool-policy.test.ts cover the policy machinery for the six roles; none mention growth_partner. tests/aqi-ops-tools.test.ts 109-116 proves workforce.status reports the partner runtime. tests/ai-growth-partner-capability-access.test.ts proves the CLIENT derivation only.
- **Real or simulated behavior:** Real recorded tool-inventory attestation and policy data; the partner's capability availability derivation exists only for the client viewer (requires agents.use) and the policy role matrix lists retained roles only. Live tool catalog needs the Hermes gateway (external).
- **Missing dependencies:** live proof of the real tool catalog needs the pinned Hermes gateway (external; outside this audit).
- **Remaining work:** Add the partner to the policy role matrix and fix AGENT_BY_KEY[roleKey] indexing in hermes-tool-policies.tsx; add an admin tenant-scoped read of the partner's ability switches and derived capability availability with blocking reasons; show inventory digest/count/expiry on the partner card; add tests with a partner fixture.
- **Verification evidence:** Own observation: read tool-policies.ts, the policies page, capability-access.ts. Prior recorded runs: not relied on.
  - *Skeptic review: Slightly pessimistic. The policy view already returns client growth_partner rows and labels them with workforceIdentityLabel. The AGENT_BY_KEY[roleKey] index at line 197 is only in the internal-agency section, so no live throw. The real gaps are the capability availability view and the role matrix. PARTIAL stands.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Super Admin sees which of the partner's six capability domains can run now and why not, plus tool inventory freshness, with tenant-scoped tests and no content exposure.

<a id="gp-sadmin-05"></a>
### GP-SADMIN-05 — View schedules and Work Board execution status for the Growth Partner

- **Requirement:** View schedules and Work Board execution status for the Growth Partner (directive §18)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/growth-partner-migration.ts`, `src/server/workforce/work-board.ts`, `src/server/workforce/schedules.ts`, `src/server/workforce/jobs.ts`, `src/server/aqi/ops/tools/workforce.ts`, `src/components/work/work-board.tsx`
- **Test coverage:** tests/growth-partner-schedule-migration.test.ts proves the legacy preview (DB). No test for a partner schedule or work-board admin read.
- **Real or simulated behavior:** No admin read of the partner's ai_work_schedules or ai_work_jobs exists. The only admin read is the legacy-profile reconciliation preview (real, DB-tested) restricted to the six legacy roles; AQi Operations even states that the platform stores no schedules, which is stale.
- **Missing dependencies:** none.
- **Remaining work:** Add src/server/admin/growth-partner-work.ts with tenant-scoped (agencyCanAccessOrg + workforce.view) reads of schedules, job status counts, oldest open and last failure code for the partner runtime; add a Work and schedules card on the client Workforce tab and an AQi Operations read tool; fix the stale note at src/server/aqi/ops/tools/workforce.ts:166; mask titles under D70; two-tenant DB tests.
- **Verification evidence:** Own observation: grep of src/app/(admin), src/components/admin, src/server/aqi/ops for ai_work_jobs/ai_work_schedules finds only the migration-preview file and a count query.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Super Admin sees per-client partner schedules and Work Board status including stuck or failed items without opening client content, proven by a two-tenant DB test.

<a id="gp-sadmin-06"></a>
### GP-SADMIN-06 — Review failed actions

- **Requirement:** Review failed actions (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/queries.ts`, `src/components/admin/client-detail.tsx`, `src/server/aqi/ops/tools/workforce.ts`, `src/server/admin/health.ts`, `src/app/(admin)/admin/health/page.tsx`
- **Test coverage:** tests/client-content-policy.test.ts proves failed-run text is hidden without a session (getTenantDetail, DB). tests/aqi-ops-tools.test.ts covers the ops tools. tests/provisioning-ops.test.ts covers health counts. No test that a partner's failed run appears on the tenant page, and none for failed work jobs or failed approval executions on a per-tenant screen.
- **Real or simulated behavior:** Real DB reads in three places: the tenant page lists failed runs for the six legacy roles only (new clients have only a growth_partner row, so nothing shows), AQi Operations workforce.runs covers the partner and is D70-gated, and /admin/health lists failures across all tenants unscoped.
- **Missing dependencies:** none.
- **Remaining work:** Drop the AGENT_ROLE_KEYS filter at queries.ts:378 so partner failures show; add failed ai_work_jobs and failed approval executions with code-only detail and D70 masking to the tenant page; link a failure to tool executions (code, tool, duration only); add DB tests with a partner-only tenant.
- **Verification evidence:** Own observation: confirmed new clients have only the growth_partner agent row (tenants.ts:160), so today their failed runs never show on the client page. Prior recorded runs: none relied on.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A failed partner run, failed work job and failed approval execution each appear on the correct client page and the fleet failure view, with content masked unless permitted, proven by DB tests.

<a id="gp-sadmin-07"></a>
### GP-SADMIN-07 — Inspect audit records

- **Requirement:** Inspect audit records (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(admin)/admin/audit/page.tsx`, `src/server/admin/queries.ts`, `src/components/admin/operations-workspaces.tsx`, `src/lib/activity.ts`
- **Test coverage:** none for listAuditLog or AuditWorkspace (grep of tests). RLS read of audit as Super Admin is covered indirectly in tests/client-content-policy.test.ts 251.
- **Real or simulated behavior:** Real audit_logs reads, Super Admin only (page guard plus RLS). Loads the latest 300 rows and filters client-side; listAuditLog accepts orgId but the page never uses it; no tests for listAuditLog or AuditWorkspace.
- **Missing dependencies:** none.
- **Remaining work:** Server-side filters (client, action prefix such as ai_growth_partner., actor, result, date range) with keyset pagination; per-client Activity tab using listAuditLog({orgId}); readable labels for ai_growth_partner.* actions in src/lib/activity.ts; metadata redaction check; audited CSV export; tests.
- **Verification evidence:** Own observation: read page, query, component. Not run.
  - *Skeptic review: Partly pessimistic. Write-time redaction already exists (sanitizeAuditMetadata, applied in recordAudit); the gap is a missing test and the raw metadata display. PARTIAL P2 stands.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Super Admin can find all events for one tenant and one action family over any date range without a 300-row ceiling; scope and redaction proven by tests.

<a id="gp-sadmin-08"></a>
### GP-SADMIN-08 — Manage integrations within authorized scopes

- **Requirement:** Manage integrations within authorized scopes (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/integrations/manager.ts`, `src/components/admin/integration-wizard.tsx`, `src/app/(admin)/admin/clients/[id]/integrations/page.tsx`, `src/app/(admin)/admin/integrations/page.tsx`, `src/app/(admin)/admin/actions.ts`, `src/app/api/admin/integrations/route.ts`
- **Test coverage:** tests/integration-health-permissions.test.ts (manager vs staff scope, DB), tests/client-integrations.test.ts, tests/integrations-security.test.ts, tests/integrations-api.test.ts. None covers mapping a growth_partner runtime.
- **Real or simulated behavior:** Real permission-checked integration manager with encrypted credential storage; provider verification calls are live-provider and not exercised here. The per-client Hermes mapping accepts only the six legacy role keys (z.enum(AGENT_ROLE_KEYS), wizard selector), so the Growth Partner runtime cannot be mapped manually; server actions connectHermesAction and healthCheckAction accept any agent id but no UI passes the partner.
- **Missing dependencies:** the provisioner worker and Hermes gateway are external for automatic partner provisioning; a manual map path is unblocked.
- **Remaining work:** Allow growth_partner in integrationSaveSchema and the wizard (partner first), keep dedicated-profile and reserved-profile guards; add partner Check connection on its card; DB tests for partner mapping and staff scope refusal.
- **Verification evidence:** Own observation: read manager.ts and wizard; confirmed connectHermesAction and healthCheckAction accept any agent id server-side but no UI passes the partner's id.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** An authorized admin maps and checks the partner runtime from the UI without touching legacy roles; scope and secret-handling tests pass.

<a id="gp-sadmin-09"></a>
### GP-SADMIN-09 — View tenant migration readiness (legacy tenants to Growth Partner)

- **Requirement:** View tenant migration readiness (legacy tenants to Growth Partner) (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/growth-partner-migration.ts`, `src/app/(admin)/admin/migration-actions.ts`, `src/server/admin/queries.ts`, `src/components/admin/client-detail.tsx`, `docs/ai-growth-partner/migration-strategy.md`
- **Test coverage:** tests/growth-partner-migration-inventory.test.ts (DB: every count, other-tenant data excluded, no content leak, staff gets null), tests/growth-partner-migration-candidate.test.ts (DB: idempotent, tenant-scoped, preserves legacy rows, refusals), tests/growth-partner-schedule-migration.test.ts (DB), tests/growth-partner-migration-action.test.ts (service mocked; proves both authorization calls precede the service). Strong real-path coverage for what exists. No UI test of the client-detail card.
- **Real or simulated behavior:** Real DB: count-only inventory, schedule reconciliation preview and one identity-only candidate write; no runtime binding, knowledge import or cutover exists. Actions are Super Admin plus workforce.manage and client-scoped; the action test mocks the service but the three service tests are DB-backed.
- **Missing dependencies:** owner choices and a runtime/gateway for later stages are external; not needed for this view.
- **Remaining work:** Add a computed go/no-go with named blockers (open work, open approvals, held reviews, unrevoked credentials, brain not active, runtime not verified) on the card and fleet grid; add a client-detail render test for the card and its two actions; do not build bind/import/cutover without founder approval.
- **Verification evidence:** Own observation: read the service, actions and card. Prior recorded runs: docs lines 113-136 and 205-206 report 6/6 DB and authorization tests; not re-run by this audit.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: The auditor's own text says the card is counts only with no computed readiness verdict, and the definition of done requires a go/no-go with blockers. The inventory and the reversible candidate step are real and DB-tested, but the migration readiness view itself is not delivered.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For each legacy client a Super Admin sees a computed readiness verdict with exact blockers and can run the reversible first step; derivation is tested.

<a id="gp-sadmin-10"></a>
### GP-SADMIN-10 — Review approval queues where authorized

- **Requirement:** Review approval queues where authorized (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/reviews.ts`, `src/server/admin/queries.ts`, `src/components/admin/client-detail.tsx`, `src/app/(admin)/admin/actions.ts`, `src/server/aqi/ops/tools/workforce.ts`, `src/server/workforce/service.ts`
- **Test coverage:** tests/held-notes-documents.test.ts, tests/config-review-hardening.test.ts, tests/config-review-recovery.test.ts, tests/config-review-notifications.test.ts (DB: held-review decisions, scoping, D70), tests/aqi-ops-tools.test.ts (approvals). No test with a growth_partner config version in pending_agency_review.
- **Real or simulated behavior:** Real. Agency holds on configuration and knowledge are decided in the client Reviews tab (DB-tested) but listHeldConfigReviewsForOrg filters to the six legacy roles, so a held growth_partner configuration is counted on the dashboard yet cannot be listed or decided; client approval requests are visible only through AQi Operations workforce.approvals (read-only, Super Admin, D70-aware).
- **Missing dependencies:** none.
- **Remaining work:** Include growth_partner in listHeldConfigReviewsForOrg and give buildHeldConfigReview a WorkforceRoleKey instead of the operations_manager fallback; DB test for a held partner configuration (listed, decidable by a manager, hidden from unassigned staff); add a read-only per-client approvals-waiting list with D70 masking. | Skeptic adds: A brand-new client's initial partner config may land in pending_agency_review (the onboarding acceptance test tolerates it), where it is counted on the dashboard but cannot be listed or decided. Prioritise adding growth_partner to listHeldConfigReviewsForOrg and a DB test for that first-run path.
- **Verification evidence:** Own observation: traced HELD_SELECT and the AGENT_ROLE_KEYS filter; confirmed classifyConfigChange accepts WorkforceRoleKey so partner holds can occur.
  - *Skeptic review: Status PARTIAL is right but the break is on the first-run path, not an edge case.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every pending agency hold for the partner is listed and decidable by an authorized reviewer; the dashboard count equals the reviewable items; tests prove it.

<a id="gp-sadmin-11"></a>
### GP-SADMIN-11 — Diagnose onboarding issues and control the Growth Partner runtime

- **Requirement:** Diagnose onboarding issues and control the Growth Partner runtime (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(admin)/admin/clients/[id]/setup/page.tsx`, `src/server/setup/snapshots.ts`, `src/server/setup/launch-readiness.ts`, `src/lib/launch-readiness.ts`, `src/app/(admin)/admin/clients/[id]/provisioning/page.tsx`, `src/server/admin/queries.ts`, `src/components/admin/client-detail.tsx`, `src/app/(admin)/admin/clients/[id]/page.tsx`, `src/components/admin/runtime-controls.tsx`, `src/app/(admin)/admin/provisioning-actions.ts`, `src/app/(admin)/admin/actions.ts`, `src/server/workforce/provisioning.ts`, `src/server/admin/tenants.ts`
- **Test coverage:** tests/agency-launch-visibility.test.ts, tests/setup-center.test.ts, tests/client-onboarding-acceptance.test.ts (DB: one partner, one brain, one provisioning request), tests/admin-provisioning-history.test.ts (DB: history for legacy employees only), tests/runtime-controls-actions.test.ts and tests/runtime-controls-ui.test.tsx (actions DB-backed; the UI test feeds fixtures). None builds the controls from a partner-only tenant through the real page.
- **Real or simulated behavior:** Real DB state: the agency setup page and launch checklist (with Growth Partner brain/runtime/conversation items) and the runtime-control server actions are real and DB-tested, but the tenant page builds agents, provisioning history, failed runs and RuntimeControlsData.profiles only from the six legacy roles while new clients get only a growth_partner row, so the partner's provisioning attempts, health check, retry and containment are unreachable from the UI. Live provisioning is executed by an external restricted worker behind deployment flags.
- **Missing dependencies:** live provisioning needs the restricted worker, Hermes gateway and flags (external, off by default); the admin visibility and control wiring do not.
- **Remaining work:** Remove the AGENT_ROLE_KEYS filters at queries.ts 237, 326/329 and 378 and pass partner rows into RuntimeControlsData.profiles; show partner provisioning attempt history with normalised failure codes; add a Health check button on the partner card; add a page-level DB test for a partner-only client with a failed provisioning job asserting the controls.
- **Verification evidence:** Own observation: read tenants.ts:160 (new clients get only growth_partner), queries.ts filters, clients/[id]/page.tsx. Prior recorded runs: docs line 66 (14/14 runtime-controls UI tests) refer to fixture-fed UI, not this wiring.
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For a new client with a failed partner setup the Super Admin sees the failure code and attempt history, can retry or check the connection from the UI, flag-off controls show disabled reasons, and a page-level DB test passes.

<a id="gp-sadmin-12"></a>
### GP-SADMIN-12 — Obsolete customer-facing six-employee controls removed; necessary legacy-administration views retained

- **Requirement:** Obsolete customer-facing six-employee controls removed; necessary legacy-administration views retained (directive §18)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/employees/page.tsx`, `src/app/(portal)/employees/[slug]/page.tsx`, `src/app/(chat)/chat/[slug]/page.tsx`, `src/components/shell/sidebar.tsx`, `src/components/admin/admin-shell.tsx`, `src/components/admin/workforce-manager.tsx`, `src/components/admin/client-detail.tsx`, `src/lib/agents.ts`, `src/server/admin/tenants.ts`
- **Test coverage:** tests/overview-growth-partner-navigation.test.tsx (one render case), tests/growth-partner-admin-priority.test.tsx (MOCKED data; checks section order and copy), tests/runtime-controls-ui.test.tsx (fixtures). No end-to-end test that a new-client user can reach no six-role route and that a legacy tenant still can reach its records.
- **Real or simulated behavior:** Real redirect and relabel logic: new clients are redirected from /employees and /chat/[slug] to the Growth Partner, the sidebar shows Previous role profiles only when a legacy profile is enabled, admin views are relabelled and retained. Tests are mocked or fixture-fed; listTenants still counts agents across all role rows.
- **Missing dependencies:** none.
- **Remaining work:** Add a route test matrix (new client, legacy with enabled profiles, legacy with none) for /employees, /employees/[slug], /chat/[slug]; count the partner separately from legacy profiles in listTenants (tenants.ts 280-290); correct the overstated runtime-controls claim in implementation-status.md line 66.
- **Verification evidence:** Own observation: read each file listed. Not run.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No client-facing route or nav entry offers the six-role workflow on a unified workspace; legacy admin and archive views stay reachable; the route matrix test passes.

<a id="gp-sadmin-13"></a>
### GP-SADMIN-13 — No admin action ever deletes historical six-role records

- **Requirement:** No admin action ever deletes historical six-role records (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/tenants.ts`, `src/server/workforce/provisioning.ts`, `src/app/(admin)/admin/provisioning-actions.ts`, `src/server/admin/growth-partner-migration.ts`, `src/server/offboarding/service.ts`, `src/server/workforce/schedules.ts`, `supabase/migrations/0002_workforce.sql`
- **Test coverage:** tests/legacy-record-deletion-guard.test.ts scans src and scripts for legacy-table deletion and truncation, requires reasoned allowlist entries, and checks the executeDeletion gates. It does not change the purge behavior or establish a database trigger.
- **Real or simulated behavior:** Real. The application DB role has SELECT only on agent_instances and agent_runs; admin actions only update, contain or insert; the single deleting path is the guarded whole-tenant offboarding purge (switch, retention, billing, export, typed name). No guard test or DB trigger prevents a future delete.
- **Missing dependencies:** none.
- **Remaining work:** Record the founder decision on whether whole-workspace offboarding may delete six-role history. Optional database triggers and broader retention controls remain a separate policy decision; keep the current guarded purge unchanged until then.
- **Verification evidence:** The focused local run on 2026-11-16 passed the new source guard as part of 4 files and 42 tests. The test protects future source changes; it does not prove hosted-database grants or trigger behavior.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: A Super Admin UI action can delete six-role records. executeDeletionAction calls executeDeletion, which deletes every tenant table not in PURGE_RETAINS, and the agent and chat tables are not retained. The iaq.purge trigger guard exists only for finance, proposal and e-sign tables. The auditor's own definition of done is unmet.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A test proves no admin or server path except the guarded purge can delete legacy records; the purge policy is documented.

<a id="gp-sadmin-14"></a>
### GP-SADMIN-14 — Super Admin and internal role boundaries enforced server-side

- **Requirement:** Super Admin and internal role boundaries enforced server-side (directive §18)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/tenancy/context.ts`, `src/server/admin/authorizer.ts`, `src/components/admin/admin-shell.tsx`, `src/app/(admin)/admin/actions.ts`, `src/app/(admin)/admin/migration-actions.ts`, `src/app/(admin)/admin/provisioning-actions.ts`, `src/app/api/admin`, `src/app/api/aqi/ops`, `src/server/aqi/ops/scope.ts`, `src/server/admin/queries.ts`, `supabase/migrations/0038_agency_team_and_hermes_policies.sql`, `supabase/migrations/0060_rls_initplan.sql`, `supabase/migrations/0112_client_content_policy.sql`
- **Test coverage:** The existing permission, content-policy, tenant-isolation and action tests remain. tests/admin-route-guard-inventory.test.ts now enumerates admin pages, API routes and server-action files, verifies a guard or reasoned service exception, checks explicit permission/service contracts, and requires fresh Super Admin sessions for the admin actions in actions.ts.
- **Real or simulated behavior:** Server-side authorization is enforced. Usage, Billing and Support Settings now check their specific view permissions at page entry; client details and maintenance retain tenant-scoped service guards. Super Admin actions in actions.ts resolve a fresh authenticated user and verify the current Super Admin role. The inventory is source-level evidence, not a hosted role-matrix run.
- **Missing dependencies:** none.
- **Remaining work:** Run the full suite and CI for the current tree. The source inventory does not replace feature-level database tests or verify hosted authorization configuration.
- **Verification evidence:** On 2026-11-16, the focused W1-01 run passed 4 files and 42 tests; npx tsc --noEmit -p tsconfig.clean.json and targeted ESLint passed. The source inventory ran locally; no CI run or hosted database test was recorded.
  - *Skeptic review: Status stands. Remaining-work item (c) is weak: the built-in auth reads platform_role from the DB on each request, so only the Supabase path relies on a token. The hard-coded IncidentsPanel canManage is UI only, and the incident services re-check client scope. All 18 admin action files have guards or guarded wrappers. No false favourable claim found.*
  - *Baseline: 8 of 8 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** CI fails on any admin page, action or route lacking a recognised server guard; destructive Super Admin actions use fresh authorization.

<a id="gp-sadmin-15"></a>
### GP-SADMIN-15 — No admin context exposes another tenant's confidential data

- **Requirement:** No admin context exposes another tenant's confidential data (directive §18)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/health.ts`, `src/app/(admin)/admin/health/page.tsx`, `src/server/admin/client-content-policy.ts`, `src/server/admin/queries.ts`, `src/server/aqi/ops/tools/workforce.ts`
- **Test coverage:** tests/admin-health-scoping.test.ts exercises two client tenants with assigned staff and Super Admin viewers, including content-session withholding. Existing client-content-policy and tenant-isolation coverage remains. Other system-role admin reads still need review.
- **Real or simulated behavior:** getSystemHealth(viewer) now scopes tenant rows and names by live organization access and withholds error text unless the viewer meets the content-session policy; no-viewer callers receive no tenant error rows. Global summary counts remain aggregate. The focused two-tenant test passed locally.
- **Missing dependencies:** whether assigned staff need a support session for failed-run text is the founder's open D70 decision; the tenant-scope fix does not depend on it.
- **Remaining work:** Audit other admin withSystem reads for tenant scope and content-session requirements. This package covered the health diagnostic history; it did not claim every admin context has been audited.
- **Verification evidence:** tests/admin-health-scoping.test.ts passed in the focused local run on 2026-11-16. Hosted RLS behavior was not exercised.
  - *Skeptic review: Confirmed and not pessimistic. getSystemHealth has no viewer and lists run error text, approval execution detail and client names for every tenant to any agency role, while the page claims 'sensitive content is excluded'. The AQi Operations tool masks the same error text under D70 and this page does not.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A staff user assigned to one client sees only that client's failures on every admin screen; Super Admin sees tenant text only as the D70 policy allows; tests prove both.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Written policy and DB-level guard for deletion of six-role history by the offboarding purge", "directiveRef": "§18 (no admin action deletes historical six-role records)", "priority": "P0", "status": "PARTIAL", "remainingWork": "Founder decision on whether the purge may remove six-role records. Add iaq.purge BEFORE DELETE triggers on agent_instances, agent_runs, agent_config_versions and chat tables, and add a source-scan test."}
- {"title": "Offboarding delete action cannot pass the runtime-profile acknowledgement", "directiveRef": "§18 (legacy administration views remain usable)", "priority": "P2", "status": "PARTIAL", "remainingWork": "executeDeletionAction (commercial-actions.ts:32) never supplies acknowledgeRuntimeProfiles, so executeDeletion (service.ts:466-472) always refuses for a client with any mapped Hermes profile. Add the field to the panel, or document that profiles must be contained first, and test it."}
- {"title": "Admin pause, resume, contain and check-connection controls for the Growth Partner runtime", "directiveRef": "§18 (diagnose onboarding issues; manage integrations within scopes)", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "Controls are built from legacy-only profiles (clients/[id]/page.tsx:43-44) and the partner card has no action buttons. Pass the partner runtime row to RuntimeControls and add Check connection and containment on the partner card, with a page-level test."}
- {"title": "Consistent D70 and tenant-scope policy across all admin error-text surfaces", "directiveRef": "§18 (no admin context exposes another tenant's confidential data)", "priority": "P0", "status": "PARTIAL", "remainingWork": "Tenant detail and the AQi tool mask error text under D70; /admin/health does not. Route all three through one content-policy helper and add a regression test that enumerates the surfaces."}
- {"title": "Admin screen for the Growth Partner's autonomy and ability switches", "directiveRef": "§18 (inspect tool and capability availability)", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "Add a tenant-scoped, workforce.view-gated read that reuses the capability derivation with an agency viewer, showing available, blocked or awaiting-approval with reasons. Today the derivation only serves clients holding agents.use."}