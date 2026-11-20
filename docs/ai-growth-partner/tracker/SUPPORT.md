# SUPPORT — AQi Assistant and Requests Center

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Domain summary (read-only audit of branch claude/ai-growth-partner-completion at 6e4a4b7e; code and tests were read, nothing was executed by me).

- AQi is a real, database-backed platform assistant (src/server/aqi/service.ts, 1,402 lines) with budgets, citations validation, link normalisation, feedback, attachments, tutorials and onboarding, plus a separate Super Admin Operations copilot. It has no access to tenant business data, so cross-tenant exposure surface is limited to its own conversations/attachments, which are RLS-scoped and tested.
- Support and Requests (src/server/support/*, 0065 + later migrations) and Custom Projects (src/server/projects/*) are mature, DB-backed and heavily tested (support-*, requests-*, custom-projects*, project-change-orders: roughly 200 real-path tests). The older Oct-23 audit gaps (idempotency, surveys, change orders, project notice dedupe) are now closed in code.
- Biggest gap: Growth Partner consistency. The published AQi knowledge (aqi_knowledge_entries seeded in 0047), suggested questions, contextual tips, two tutorials and the custom-project catalog copy still describe "AI employees", "AI Workforce", "Appointment Setter". Migration 0131 rewrote only three starter tutorials. None of the knowledge says anything about the Business Brain, Control Center, Work Board or goals, so AQi cannot answer Growth Partner questions from approved knowledge.
- Defects found in code: HelpWidget is never mounted so every "Talk to iAcquire Team / Ask for help / Contact iAcquire" button (setup-center, not-connected, chat-rail, chat-workspace) dispatches an event nobody listens to; the AQi launcher and walkthrough host do not mount on /growth-partner, /employees, /work, /social, /automation-studio; the Growth Partner tutorial targets a DOM id (growth-partner.conversation) that no component renders; AQI_ROUTES contains a nonexistent /billing page and omits /retention, /add-ons, /maintenance, /proposals, /invoices, /notifications.
- Not verified: no live-model evaluation of AQi answers about the Growth Partner exists; support emails, Slack alerts and SLA jobs depend on SCHEDULER_ENABLED/provider configuration that is off or capture-only. AI intake is rule-based, suggestions are not persisted (the ai_assist event is declared but never written).
- Requests Center is a menu group of five destinations, not one unified list; custom projects are a separate model and never appear in My Requests; project requests have no duplicate detection or AI intake.

<a id="gp-support-01"></a>
### GP-SUPPORT-01 — AQi permission-aware help and tenant isolation

- **Requirement:** AQi permission-aware help and tenant isolation (directive §23 permission-aware help; no cross-tenant data exposure)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/aqi/access.ts`, `src/lib/aqi/routes.ts`, `src/server/aqi/service.ts`, `src/app/api/aqi/chat/route.ts`, `src/server/aqi/attachments.ts`, `src/lib/aqi/suggestions.ts`
- **Test coverage:** tests/aqi-security.test.ts (route safety, agency vs client, permission-gated suggestions); tests/aqi.test.ts (conversation privacy: own conversations only; knowledge by role/page); tests/aqi-lifecycle.test.ts (welcome hides unauthorised page label/suggestions); tests/aqi-attachments.test.ts (cross-user reads refused); tests/aqi-knowledge-documents.test.ts (cross-tenant reads refused); tests/aqi-chat-visibility.test.ts. These are DB-backed. They do not prove: a prompt-injection resistance eval, or that a member without billing.view cannot be told billing workflow details.
- **Real or simulated behavior:** Real: server-resolved viewer, permission-filtered routes, RLS-scoped conversations and attachments; provider stream stubbed in tests.
- **Missing dependencies:** none.
- **Remaining work:** Filter retrieved knowledge by route permission, not only role (service.ts retrieveAqiKnowledge); add a two-tenant prompt/context leak test and a prompt-injection test through knowledge and attachments. | Skeptic adds: Add a two-ORGANISATION test: a user of org B cannot read org A's conversation, messages, attachments or feedback (current conversation privacy test is same-org member vs owner). Reframe the knowledge-permission item as a permission-awareness gap: retrieval reads only the global aqi_knowledge_entries table, so it is not a cross-tenant leak.
- **Verification evidence:** Own observation: read code paths and test titles listed above; did not run tests. Prior recorded (docs/aqi.md, implementation-status.md): full regression green on earlier commits; I cannot see the current baseline run.
  - *Skeptic review: Audit says the tests are DB-backed for isolation, but tests/aqi-security.test.ts is a pure unit test and the only conversation privacy test uses two members of the same org; no cross-org read is ever asserted. Code scoping (user_id + org_id predicates) looks correct, so the status stays IMPLEMENTED_UNVERIFIED.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No AQi endpoint or prompt can return another workspace's data; knowledge and links match the viewer's permissions; new two-tenant and injection tests pass in CI.

<a id="gp-support-02"></a>
### GP-SUPPORT-02 — AQi navigation assistance and page explanations (route registry integrity)

- **Requirement:** AQi navigation assistance and page explanations (route registry integrity) (directive §23 navigation assistance; page explanations)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/aqi/routes.ts`, `src/lib/aqi/navigation-links.ts`, `src/server/aqi/service.ts`, `src/lib/aqi/intent.ts`
- **Test coverage:** tests/aqi-answer-pipeline.test.ts (malformed references become verified links; unauthorised page not linked); tests/aqi-navigation-links.test.ts; tests/aqi-security.test.ts. No test compares AQI_ROUTES with the real app/ route tree, so drift is undetected.
- **Real or simulated behavior:** Real curated registry drives page context and verified links; registry itself has dead and missing entries.
- **Missing dependencies:** none.
- **Remaining work:** Remove or repoint the nonexistent /billing route (real page is /settings/billing); add /retention, /add-ons, /our-work, /maintenance, /proposals, /invoices, /notifications and settings sub-pages; raise AQI_NAVIGATION_LIMIT (40); gate /support/change on the request_changes feature; add a test comparing registry paths to real pages. | Skeptic adds: Raise priority to P1: AQi presents /billing as a verified link for any viewer with billing.view and it 404s; the real page /settings/billing has no registry entry, so AQi cannot navigate anyone to billing.
- **Verification evidence:** Own observation: confirmed no (portal)/billing directory and no /billing redirect; confirmed the listed pages exist with their permissions; read the route tests. No prior recorded run is claimed.
  - *Skeptic review: The dead /billing route is client-facing and produces a link the system labels verified; the audit's P2 understates it. Claim confirmed: no src/app/(portal)/billing and no redirect in next.config.ts.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every openable client page has a correct registry entry; no registry path 404s; AQi never links a page the viewer cannot use, including feature-gated ones; a drift test enforces it.

<a id="gp-support-03"></a>
### GP-SUPPORT-03 — AQi availability on Growth Partner pages

- **Requirement:** AQi availability on Growth Partner pages (directive §23 permission-aware help; guided walkthroughs)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/aqi/surface.ts`, `src/components/providers.tsx`, `src/lib/aqi/launcher.ts`
- **Test coverage:** tests/aqi-chat-visibility.test.ts asserts only /chat (hidden) and /overview, /crm/tasks, /admin/operations (shown). Nothing asserts /growth-partner.
- **Real or simulated behavior:** Real components, but the AQi_SURFACE regex does not match /growth-partner, /employees, /work, /social, /automation-studio, /invoices, /proposals; the walkthrough host is mounted behind the same gate.
- **Missing dependencies:** product decision whether the permanent Growth Partner conversation page should hide the launcher (a composer lift rule already exists in launcher.ts); the Control Center page should show it.
- **Remaining work:** Add the missing prefixes to AQI_SURFACE (drop the obsolete workforce), keep an explicit exclusion only where wanted, verify the walkthrough host survives navigation to /growth-partner, extend tests/aqi-chat-visibility.test.ts.
- **Verification evidence:** Own observation: read surface.ts and providers.tsx; the regex does not match /growth-partner, /employees, /work. Behaviour in a browser not observed.
  - *Skeptic review: Could not refute. Regex omits growth-partner, employees, work, social, automation-studio, invoices, proposals and GuidanceHost sits behind the same gate, so a walkthrough step routed to /growth-partner can never render its overlay (server-stored progress resumes only on the next surface page). Tests cover only four paths.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** AQi launcher and walkthrough host render on every authorised portal page except explicitly excluded composer routes, with a test per prefix.

<a id="gp-support-04"></a>
### GP-SUPPORT-04 — Guided walkthroughs and resume

- **Requirement:** Guided walkthroughs and resume (directive §23 guided walkthroughs; resume)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/aqi/tutorials.ts`, `src/server/aqi/tutorials.ts`, `src/lib/aqi/targets.ts`, `src/components/growth-partner/control-center.tsx`, `src/components/growth-partner/permanent-conversation.tsx`, `supabase/migrations/0131_ai_growth_partner_aqi_guidance.sql`, `supabase/migrations/0061_aqi_phase3_guidance.sql`
- **Test coverage:** tests/aqi-tutorial-engine.test.ts (eligibility, progress, resume, idempotent events, isolation); tests/aqi-tutorial-store.test.ts; tests/aqi-tutorial-stage.test.tsx (synthetic DOM that sets its own target attribute); tests/aqi-guide-chat.test.ts; tests/aqi-migration-0131.test.ts. None checks that a registered target id exists in the real rendered page.
- **Real or simulated behavior:** Real versioned DB tutorials with per-person progress and resume; target presence is only tested against a synthetic DOM.
- **Missing dependencies:** none.
- **Remaining work:** Render data-aqi-target for growth-partner.conversation and growth-partner.composer; add Growth Partner (Business Brain, conversation, Work Board, approvals, goals) and Requests (issue, feedback, change, project request) walkthroughs; migrate the two appointment tutorials that still name the Appointment Setter; add a real-render test that every target in every published definition exists. | Skeptic adds: Note for the fix: a missing target already degrades to a Skip step / Retry state after a timeout, so the walkthrough is not hard-stuck; the defect is that the conversation step can never highlight anything.
- **Verification evidence:** Own observation: grep shows the two growth-partner target ids defined in targets.ts and used in tutorials.ts but present nowhere in src components; 0061 text for the appointment tutorials still names Appointment Setter and no later migration touches it. Prior recorded (docs): 0131 applied/verified on synthetic data.
  - *Skeptic review: Confirmed: growth-partner.conversation and growth-partner.composer are registered and used by view-ai-employees but rendered by no component; only header and brain ids exist in control-center.tsx.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every step of every published walkthrough resolves to a real element in a rendered-page test; Growth Partner and Requests flows have walkthroughs; no walkthrough names a retired role.

<a id="gp-support-05"></a>
### GP-SUPPORT-05 — Accurate documentation answers and citations

- **Requirement:** Accurate documentation answers and citations (directive §23 accurate documentation answers; citations where supported)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/aqi/service.ts`, `supabase/migrations/0047_aqi_assistant.sql`, `supabase/migrations/0050_aqi_conversation_content.sql`, `src/server/aqi/knowledge-documents.ts`, `src/server/help/articles.ts`
- **Test coverage:** tests/aqi.test.ts (citations dropped when unmapped; knowledge by role/page; seeded answers); tests/aqi-answer-pipeline.test.ts; tests/aqi-knowledge-documents.test.ts; tests/aqi-knowledge-history.test.ts. No test or evaluation asserts that AQi answers correctly about the Growth Partner, and none checks knowledge for retired concepts.
- **Real or simulated behavior:** Real keyword retrieval of published DB knowledge and validated citation cards; no live-model evaluation of Growth Partner answers; seeded knowledge describes AI employees and has no Business Brain or Growth Partner content.
- **Missing dependencies:** a live model for an answer-quality evaluation (provider key and spend approval) is external; the knowledge content itself is not.
- **Remaining work:** Publish approved Growth Partner, Business Brain, Control Center, Work Board, approvals, goals and Requests knowledge via a guarded migration plus the Super Admin editor; add a golden-question retrieval test; fix the /billing knowledge route; later record a live-model evaluation.
- **Verification evidence:** Own observation: grep of aqi_knowledge_entries inserts finds no "Business Brain" or "Growth Partner" content in any migration; entries 0047 say "AI employees are named, role-specific assistants ... Open AI Workforce, choose an employee". Prior recorded: docs/aqi.md reports a controlled production DeepSeek probe (greeting and one link answer); not a Growth Partner evaluation.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** AQi answers a golden set of Growth Partner and Requests questions with correct grounded citations (stub-proven retrieval plus a recorded live run); no published entry contradicts the product.

<a id="gp-support-06"></a>
### GP-SUPPORT-06 — No outdated six-employee content in AQi, help and Requests copy

- **Requirement:** No outdated six-employee content in AQi, help and Requests copy (directive §23 no outdated six-employee documentation)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0047_aqi_assistant.sql`, `supabase/migrations/0061_aqi_phase3_guidance.sql`, `supabase/migrations/0015_custom_projects.sql`, `src/server/help/service.ts`, `docs/aqi.md`, `docs/support-requests.md`, `src/lib/support/lifecycle.ts`
- **Test coverage:** tests/aqi-lifecycle.test.ts:110,193,198 still asserts the old suggestion "How do I change an employee's instructions?" and the old global question, i.e. it locks in the stale content. tests/custom-projects.test.ts:103 asserts the old overlap note. Nothing guards against retired terms.
- **Real or simulated behavior:** Code strings are migrated; stored DB copy (knowledge, suggested questions, tips, catalog overlap notes, maintenance plan) and docs still use AI employees, AI Workforce and Appointment Setter; two existing tests assert the stale strings.
- **Missing dependencies:** founder/Super Admin confirmation of catalog and maintenance wording (catalog copy is founder-confirmed content).
- **Remaining work:** Guarded migration for untouched seeded rows (aqi_knowledge_entries, aqi_suggested_questions, workforce-help tip, two appointment tutorials, service_catalog.core_overlap_note, maintenance plan strings); update docs/aqi.md and docs/support-requests.md; add a retired-term guard test; fix tests that lock in old strings.
- **Verification evidence:** Own observation: grep results above; no later migration (0066, 0131, 0134) rewrites these rows; 0066 only renamed route prefixes.
  - *Skeptic review: Confirmed that stored copy is stale, but tests/aqi-lifecycle.test.ts:193 is a negative assertion (old question must be absent for a restricted viewer); only :198 and tests/custom-projects.test.ts:103 positively assert old strings. Catalog notes exist only in 0015 (no later migration touches service_catalog), so the founder-confirmed wording dependency is real.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A scan of client-visible AQi, help and catalog strings finds no retired role names or six-employee claims outside labelled previous-profile contexts; a guard test enforces it.

<a id="gp-support-07"></a>
### GP-SUPPORT-07 — AQi feedback handling and insights

- **Requirement:** AQi feedback handling and insights (directive §23 feedback handling)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/aqi/service.ts`, `src/app/api/aqi/feedback/route.ts`, `src/components/aqi/message-feedback.tsx`, `src/components/aqi/use-message-feedback.ts`, `src/server/aqi/insights.ts`
- **Test coverage:** tests/aqi.test.ts (persists, changes and clears feedback on the correct message); tests/aqi-feedback-ui.test.tsx; tests/aqi-insights.test.ts (aggregates real usage, feedback, knowledge misses; Super Admin only).
- **Real or simulated behavior:** Real stored ratings and comments feeding Super Admin Insights.
- **Missing dependencies:** none.
- **Remaining work:** Offer a human handoff on negative feedback and surface knowledge-miss items for content review. | Skeptic adds: Give staff a way to read negative-feedback comments (Super Admin Insights drill-down or a review queue) with the person's consent wording; today comments are stored but never reach any reviewer.
- **Verification evidence:** Own observation: read the service, route and test titles. No prior run claimed.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: Audit says the rating and comment feed Super Admin Insights. Only counts by page do. Comment text is deliberately excluded from analytics and no staff screen reads feedback_comment, so feedback is captured but not handled. Rating write is correctly scoped to the author.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Thumbs-down with a comment is stored, shown in Insights and offers a human handoff, with tests.

<a id="gp-support-08"></a>
### GP-SUPPORT-08 — Human handoff and help entry points

- **Requirement:** Human handoff and help entry points (directive §23 AQi support handoff; escalations)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/aqi/support.ts`, `src/components/aqi/support-request-dialog.tsx`, `src/components/help/help-widget.tsx`, `src/server/help/service.ts`, `src/app/api/help/route.ts`, `src/components/setup/setup-center.tsx`, `src/components/not-connected.tsx`, `src/components/chat/chat-rail.tsx`, `src/components/chat/chat-workspace.tsx`
- **Test coverage:** tests/support-aqi.test.ts (draft creates nothing; consent required; retry returns the same request; failure claims nothing; agency refused). tests/assistant-projects.test.ts covers the help service logic, not the widget.
- **Real or simulated behavior:** AQi-to-Support draft and consented submit are real; the legacy help widget is never mounted, so openHelp buttons dispatch an event with no listener.
- **Missing dependencies:** decision whether to retire the help widget and service or remount it.
- **Remaining work:** Route openHelp callers to the AQi launcher or support dialog (or mount the widget); retire /api/help and help_conversations or fold project status answers into AQi; add a UI test that each caller opens a visible surface. | Skeptic adds: The legacy /chat screens (chat-rail.tsx, chat-workspace.tsx) have no working help entry at all: AQi is hidden on /chat by design and the openHelp buttons there are dead. Decide the replacement help entry for those screens specifically.
- **Verification evidence:** Own observation: grep shows listener only in help-widget.tsx and no mount; callers listed above.
  - *Skeptic review: Confirmed: HelpWidget is never rendered (only its definition and openHelp imports exist) and the sole listener lives inside it. Sharper than the audit: on /chat both help surfaces are absent.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every Talk to iAcquire Team / Ask for help control opens a working surface that can create a real request; one assistant remains.

<a id="gp-support-09"></a>
### GP-SUPPORT-09 — Support requests, issues, feedback, request status and client access restrictions

- **Requirement:** Support requests, issues, feedback, request status and client access restrictions (directive §23 support requests; issues; feedback; request status; client access restrictions)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/support/service.ts`, `src/server/support/access.ts`, `src/server/support/agency.ts`, `src/server/support/surveys.ts`, `src/lib/support/lifecycle.ts`, `src/lib/permissions.ts`, `src/app/(portal)/support/page.tsx`, `src/app/(portal)/support/requests/page.tsx`, `src/components/support/request-form.tsx`
- **Test coverage:** tests/support-requests.test.ts (19: creation, forged ids across workspaces, member vs owner visibility, same rule inside the database, internal notes hidden, idempotent submit); tests/support-agency.test.ts (16: scope, assignment, priority hidden from clients, lifecycle); tests/support-lifecycle.test.ts (16, including DB transitions equal code); tests/support-attachments.test.ts, support-files.test.ts, support-surveys.test.ts, support-reply-race.test.ts, support-agency-claim.test.ts, support-survey-card.test.tsx, support-migration-0065.test.ts. Browser QA is documented in prior runs only.
- **Real or simulated behavior:** Real DB-backed service with RLS and DB transition trigger; client wording computed from stored state.
- **Missing dependencies:** none for the core flow.
- **Remaining work:** Add a Growth Partner handoff to a request if wanted; re-run current-tree signed-in browser QA; confirm retired-name category ids are acceptable internally.
- **Verification evidence:** Own observation: read service, lifecycle and test titles. Prior recorded (docs/support-requests.md, earlier audit): 34 browser checks and merge to master; scheduler never run in production.
  - *Skeptic review: Tried to refute, could not. submitRequest scopes every write by ctx.org.orgId, verifies project ownership, uses an on-conflict idempotency key with a replay check before the rate limit, and sends Slack/email after commit; detail reads strip internal rows via RLS under withUser. Status stays IMPLEMENTED_UNVERIFIED because no current-tree run is recorded.*
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** All request types can be created, tracked and answered by role with tenant isolation proven by DB-backed tests and a recorded current-tree browser run.

<a id="gp-support-10"></a>
### GP-SUPPORT-10 — Change requests and project change orders

- **Requirement:** Change requests and project change orders (directive §23 change requests)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/support/change-feature.ts`, `src/server/support/change.ts`, `src/server/support/change-form.ts`, `src/lib/support/change.ts`, `src/server/projects/change-orders.ts`, `src/app/(portal)/support/change/page.tsx`, `src/components/support/form-page.tsx`
- **Test coverage:** tests/requests-change.test.ts (22), tests/project-change-orders.test.ts (47), tests/project-change-rules.test.ts, tests/project-changes-ui.test.tsx, tests/requests-change-page.test.tsx, tests/requests-change-ui.test.tsx, tests/requests-migration-0098.test.ts. These are database-backed.
- **Real or simulated behavior:** Real DB-backed; dormant until a Super Admin enables org_features request_changes per workspace.
- **Missing dependencies:** founder decision on when the entitlement is enabled and how it relates to the setup fee and maintenance plan (comment in change-feature.ts says this is the founder's call).
- **Remaining work:** Decide whether the AI Growth Partner change category should link to Business Brain or settings; gate the AQi route on the feature flag (GP-SUPPORT-02).
- **Verification evidence:** Own observation: read feature gate and page handling when disabled; read test titles. No prior run claimed beyond docs.
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A workspace with the switch on can file, classify, quote and decide a change; with it off it sees the honest page and AQi does not list it.

<a id="gp-support-11"></a>
### GP-SUPPORT-11 — Custom project requests

- **Requirement:** Custom project requests (directive §23 custom project requests; client access restrictions)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/projects/client.ts`, `src/server/projects/agency.ts`, `src/server/projects/access.ts`, `src/server/projects/jobs.ts`, `src/components/projects/request-wizard.tsx`, `src/app/(portal)/projects/page.tsx`
- **Test coverage:** tests/custom-projects.test.ts (26: isolation, column grants, agency scope, quotes, expiry), custom-projects-idempotency.test.ts (10), custom-projects-handover.test.ts, custom-projects-defects.test.ts, custom-projects-calendar.test.ts, project-prerequisites.test.ts, project-review-overdue.test.ts, export-project-privacy.test.ts, assistant-projects.test.ts. Real path.
- **Real or simulated behavior:** Real DB-backed intake, quotes with content hash, milestones, handover; owners and admins request, only owners approve quotes.
- **Missing dependencies:** founder-confirmed catalog wording (GP-SUPPORT-06).
- **Remaining work:** Duplicate detection, AI-assisted intake, My Requests visibility and catalog copy update (GP-SUPPORT-12, 13, 14, 06); record a signed-in browser run.
- **Verification evidence:** Own observation: read client.ts intake (idempotent, rate limited, review task with due date, deduped agency notice) and test titles. Prior recorded: earlier audit says signed-in browser QA was not driven.
  - *Skeptic review: Tried to refute, could not. createProjectRequest runs under withSystem (RLS bypassed) but every statement carries ctx.org.orgId, the permission is projects.request, the idempotency key and review task are real. Kept.*
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Intake, quote, approval and handover covered by current passing tests and a signed-in browser run, with Growth Partner-consistent copy.

<a id="gp-support-12"></a>
### GP-SUPPORT-12 — Unified Requests Center view

- **Requirement:** Unified Requests Center view (directive §23 Requests Center)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/shell/sidebar.tsx`, `src/app/(portal)/support/requests/page.tsx`, `src/server/support/service.ts`, `src/server/projects/client.ts`
- **Test coverage:** none for a combined list.
- **Real or simulated behavior:** Real pages grouped in a sidebar menu; My Requests lists support tickets only, projects and maintenance requests are separate models.
- **Missing dependencies:** none.
- **Remaining work:** Read-level aggregation of support tickets, project requests, maintenance requests and change orders for clients and an agency cross-model queue, with type and status filters and tests for tenant and permission scope.
- **Verification evidence:** Own observation: no code reads more than one request model into one list.
- **Definition of done:** A client sees every kind of request in one filterable list and the agency one queue, with scope tests.

<a id="gp-support-13"></a>
### GP-SUPPORT-13 — Duplicate detection

- **Requirement:** Duplicate detection (directive §23 duplicate detection)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/support/duplicates.ts`, `src/lib/support/suggest.ts`, `src/server/support/agency.ts`, `src/components/support/request-form.tsx`, `src/server/projects/client.ts`
- **Test coverage:** tests/support-insights.test.ts (own earlier requests only; closed excluded; team suggestions never auto-merge); tests/support-agency.test.ts ('links and merges requests from the same client only'); idempotency in support-requests and custom-projects-idempotency tests.
- **Real or simulated behavior:** Real rule-based title similarity for support; none for project requests or change forms.
- **Missing dependencies:** none.
- **Remaining work:** Add similar-request suggestions to the project wizard and across models; consider moving messages on merge.
- **Verification evidence:** Own observation: confirmed no similarity call from the project wizard or createProjectRequest.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every request form surfaces likely duplicates before sending, with project and change tests.

<a id="gp-support-14"></a>
### GP-SUPPORT-14 — AI-assisted request intake

- **Requirement:** AI-assisted request intake (directive §23 AI-assisted intake)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/support/ai.ts`, `src/lib/support/suggest.ts`, `src/lib/support/lifecycle.ts`, `src/components/support/request-form.tsx`
- **Test coverage:** tests/support-ai.test.ts (12: off/not connected honest, redaction, metering, rate limit, data-not-instructions, team-only summaries; provider stubbed); tests/support-insights.test.ts.
- **Real or simulated behavior:** Classification and missing-information advice are rules; draft improvement, summary and reply drafting call the configured model (stubbed in tests); suggestions are not persisted and the ai_assist event is never written.
- **Missing dependencies:** a live model run to measure quality (provider key and spend approval).
- **Remaining work:** Persist suggestions and accept/override outcomes; add routing suggestions; add AI intake to the project wizard; store clarifying questions on the request; record a live evaluation. | Skeptic adds: Client-side improveRequestDraft passes no audit record while team-side summary/reply calls do (ai.ts:50); add one. ai_assist_enabled defaults true (0065:206): confirm the default and add a visible notice that the draft text is sent to an AI service before the first use.
- **Verification evidence:** Own observation: grep shows ai_assist is only declared; no provider call in suggestForDraft. Prior recorded (earlier audit, docs): a real provider was never called for support AI.
  - *Skeptic review: Audit says the AI help is not recorded at all; team-side AI use is audited as support.ai_assist and all use is metered. The real gaps are the missing client-side audit and the missing disclosure on the client form.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Intake suggestions are reviewable and recorded, cover projects, and a recorded live evaluation exists.

<a id="gp-support-15"></a>
### GP-SUPPORT-15 — Internal notifications, escalations and response targets

- **Requirement:** Internal notifications, escalations and response targets (directive §23 internal notifications; escalations)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/support/notify.ts`, `src/server/support/response-clock.ts`, `src/server/support/agency.ts`, `src/server/notifications.ts`, `src/server/support/jobs.ts`, `src/server/ops/tick.ts`
- **Test coverage:** tests/support-notifications.test.ts (16: modes, once per event, scope, email rules, SLA notices once), tests/support-sla.test.ts (13), tests/support-agency.test.ts (escalates once, hidden from the client), tests/project-review-overdue.test.ts, tests/custom-projects-idempotency.test.ts. DB-backed.
- **Real or simulated behavior:** Real in-app notifications with dedupe and recipient scoping; manual and time-based escalation; time-based parts run only under the scheduler.
- **Missing dependencies:** scheduler start for the time-based parts (GP-SUPPORT-16).
- **Remaining work:** No Growth Partner handoff notification path exists (see GP-SUPPORT-09); time-based delivery depends on GP-SUPPORT-16.
- **Verification evidence:** Own observation: read notify, clock and job code and test titles.
  - *Skeptic review: Tried to refute, could not. Exactly-once is enforced by database uniqueness, not by code convention: unique (event_key, recipient, channel) claim row, notifications dedupe_key, SLA keys that include the due time, and escalation conditional on escalated_at is null. In-app submit notice is synchronous and does not depend on the scheduler.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Notices fire exactly once to the right people, including time-based ones under a real scheduler.

<a id="gp-support-16"></a>
### GP-SUPPORT-16 — Scheduler, email and Slack delivery for requests

- **Requirement:** Scheduler, email and Slack delivery for requests (directive §23 internal notifications; escalations)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P2  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** no
- **Source files:** `src/app/api/internal/tick/route.ts`, `src/server/ops/tick.ts`, `src/server/support/jobs.ts`, `src/server/support/notify.ts`, `src/server/notifications.ts`, `src/server/support/service.ts`
- **Test coverage:** tests/support-notifications.test.ts covers failure honesty with stubbed delivery. No test proves real delivery.
- **Real or simulated behavior:** Code exists; delivery is capture-only or off until SCHEDULER_ENABLED, CRON_SECRET, an email sender and a Slack webhook are configured.
- **Missing dependencies:** founder approval to enable the scheduler, email provider and Slack configuration.
- **Remaining work:** After approval, enable per environment, run one controlled request end to end and record the result.
- **Verification evidence:** Own observation: read the tick route guard; no cron config file in the repo root. Prior recorded: docs state the scheduler has never run in production.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A test request produces a delivered email and alert and a response-target notice under the real scheduler, recorded.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "No working help or support entry on legacy employee-chat (/chat) screens", "directiveRef": "§23 AQi support handoff; escalations", "priority": "P1", "status": "PARTIAL", "remainingWork": "AQi launcher is excluded on /chat and the openHelp buttons in chat-rail.tsx:190,295 and chat-workspace.tsx:808 are dead, so a person on those pages has no way to reach support from the page. Add a real Get support link to /support/new or open the AQi support dialog there, with a render test."}
- {"title": "AQi negative-feedback comments have no staff review or handoff path", "directiveRef": "§23 feedback handling", "priority": "P2", "status": "PARTIAL", "remainingWork": "Comments are stored in aqi_messages.feedback_comment (service.ts:678) but never read by staff (insights.ts:183 excludes them). Add a Super Admin review list (with the person's workspace and page, no message text beyond what they chose to send) and an optional Tell the team handoff reusing the AQi support draft flow."}
- {"title": "Client AI draft help sends text to a provider with no disclosure and a default-on switch", "directiveRef": "§23 AI-assisted intake; no cross-tenant data exposure", "priority": "P2", "status": "PARTIAL", "remainingWork": "support settings ai_assist_enabled defaults true (0065:206) and the Help me say this more clearly button (request-form.tsx:456) states nothing about an external AI service; client-side use is not audited (ai.ts:79-90). Add disclosure copy, an audit entry, and confirm the production default with the founder."}
- {"title": "AQi has no tested cross-organisation read-refusal for conversations, messages and feedback", "directiveRef": "§23 no cross-tenant data exposure", "priority": "P0", "status": "IMPLEMENTED_UNVERIFIED", "remainingWork": "Add a two-org DB test where a member of org B tries getAqiConversation, rateAqiMessage, createAqiSupportTicket (loadConversation) and attachment reads against org A ids and is refused; today only same-org member-vs-owner is tested (tests/aqi.test.ts:210-221)."}
