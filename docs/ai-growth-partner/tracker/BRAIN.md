# BRAIN — Business Brain

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). The original audit baseline is commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`; GP-BRAIN-15 was rechecked against current source at `bb63ebb3`.

Audit of branch claude/ai-growth-partner-completion at 6e4a4b7e (read-only; no tests or builds run by me). Test-count and "passed" statements below that come from docs/ai-growth-partner/implementation-status.md are the previous team's recorded runs, not my observation.

Summary
- What exists: a real, Postgres-backed, tenant-scoped, immutable-snapshot Business Brain (migration 0120; `ai_growth_partner_versions`, one `current_version` pointer, RLS plus an immutability trigger). Brain = 11 sections / 135 declared fact slots, each fact carrying value, state (verified | client_confirmed | draft_suggestion | unknown | historical | superseded), provenance list, a clientOverride flag, and an optional audience (`internal` | `customer_safe`) in the JSON snapshot (src/lib/ai-growth-partner.ts). Deterministic generation from the submitted onboarding ledger (no LLM), company-knowledge to Brain sync with conflict handling, profile and messaging-hours sync, an owner "review and apply" activation step, and request-scoped lexical retrieval (24 facts / 8,000 chars) feeding the Partner prompt. Separate real stores exist for app memory (0130), numeric goals (0133), retained legacy profile knowledge (0134) and company-knowledge revisions with restore (0117).
- Real vs simulated: everything above is real DB code exercised by PGlite-backed Vitest tests. There is NO real-model or live-provider verification of Brain-grounded answers anywhere (the docs say so too). Onboarding writing assistance is tested only against a mocked model.
- The Brain is not the single source of truth. The same facts are held in up to four places (company_profiles + compiled prompt head, company_knowledge sections, agent_config_versions settings for tone/personality/escalation/never-promise, and the Brain) and only some directions are synchronised. Preference changes (tone, language, reply length via chat or Settings) never reach the Brain; Knowledge Center edits never reach the compiled prompt head; Brain edits never reach messaging hours or agent settings.
- 60 of 135 Brain slots (e.g. objection handling, authorized promises, refunds, lead priorities, buying signals, disqualifiers, personality, escalation behaviour) are never populated by any automatic path; only a manual one-fact-at-a-time edit can fill them.
- Versioning is forward-only: no restore/rollback of a Brain version (the 'rollback' source value exists in the schema but no code uses it), history UI shows metadata only (no content, no diff), memory and goals keep only a revision counter. Company-knowledge sections DO have full history + restore (tested).
- Conversational editing is a rigid regex grammar: 8 Brain fields ("Update Business Brain <field> to <value>"), plus separate parsers for hours, tone/length/language, numeric goals, and "Remember:/Forget:". Pricing, FAQs, brand voice text, qualification criteria, escalation rules, prohibited actions and workflow preferences cannot be changed in chat, and a chat Brain edit only creates a draft the owner must still apply in the UI.
- Biggest gaps: (1) customer replies now use confirmed customer-safe Brain facts and a stripped prompt, but the pinned runtime has not been canary-tested for profile SOUL/native-memory isolation; (2) duplicate/contradictory internal sources still reach owner-facing prompts (compiled head vs Brain); (3) Brain fact edits and chat edits skip the instruction-risk scan that profile and knowledge edits go through; (4) no Brain restore/diff; (5) no real-model verification of "no invented facts"; (6) offboarding export omits Brain versions, memory, goals and retained knowledge.

<a id="gp-brain-01"></a>
### GP-BRAIN-01 — Brain data model, immutable versioning and tenant isolation

- **Requirement:** Brain data model, immutable versioning and tenant isolation (directive §6)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0120_ai_growth_partner_foundation.sql`, `src/lib/ai-growth-partner.ts`, `src/server/ai-growth-partner/service.ts`
- **Test coverage:** tests/ai-growth-partner-foundation.test.ts (real DB): one partner per tenant (L220), runtime/version same-tenant FK and immutability trigger (L254), RLS own vs cross-tenant counts and write denial for the app role (L290), draft -> activate with stale-version conflict and member denial (L333). Schema-level rules (unknown must be null; override must be client_confirmed) at L51. Does not prove: pruning/retention, concurrent-writer races, size-limit rejection, partner-row deletion behaviour.
- **Real or simulated behavior:** Real Postgres schema (PGlite in tests), RLS, immutability trigger and service code; nothing mocked.
- **Missing dependencies:** none external.
- **Remaining work:** Define and test a retention/compaction rule for version snapshots (each sync writes a full snapshot, plus a rebased draft copy when a draft exists); race test for concurrent syncs plus fact edits; remove or wire up the vestigial persona_settings column and the uncalled saveGrowthPartnerBusinessBrainDraft; implement or drop the unused 'rollback' source (see GP-BRAIN-10). | Skeptic adds: Add: the immutability trigger is BEFORE UPDATE only (0120:77-85); there is no DELETE or TRUNCATE guard and the test (foundation.test.ts:254-285) only proves UPDATE is rejected. All Brain writes and the prompt-time reads use withSystem (RLS bypassed), so isolation in service code rests on the org_id predicates; RLS only protects the iaq_app_user path the test exercises. Add a delete/truncate guard (or an explicit statement that system-role deletion is out of scope) and a test that exercises a service-layer cross-tenant read, not only the raw RLS select.
- **Verification evidence:** Prior recorded runs (docs, implementation-status.md): full regression 903 files / 13,860 tests green, PGlite migration rehearsal through 0135. My own observation: read the migration, service code and the listed tests; I did not run anything. I confirmed the tests assert the immutability trigger and RLS behaviour through real queries, not mocks.
  - *Skeptic review: Status IMPLEMENTED_UNVERIFIED and P0 are fair and the tests are real-DB, not mocked. The definition-of-done sentence 'cannot be updated by any application role' is met only for UPDATE; deletion immutability is not enforced or tested.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One immutable ordered version history per tenant, no cross-tenant read or update by any application role, bounded and tested history growth, persona_settings either removed or genuinely used, concurrency of all writers covered by a test.

<a id="gp-brain-02"></a>
### GP-BRAIN-02 — Core business facts: identity, description, industry, products/services, target customers, locations, pricing, FAQs, approved policies

- **Requirement:** Core business facts: identity, description, industry, products/services, target customers, locations, pricing, FAQs, approved policies (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/ai-growth-partner.ts`, `src/server/ai-growth-partner/service.ts`, `src/lib/knowledge-sections.ts`, `src/server/workforce/compiler.ts`, `src/server/workforce/service.ts`, `src/server/onboarding/employee-sync.ts`
- **Test coverage:** tests/ai-growth-partner-foundation.test.ts L157 (mapping), L507 (approved knowledge into onboarding drafts, held/risky excluded, conflict object), L590 (knowledge sync into active+draft, conflict not shown to prompt); tests/onboarding-employee-sync-settings.test.ts L87, L128 (profile edit into active Brain; instruction-like text kept as draft); tests/knowledge-revisions.test.ts. All DB-backed. Not covered: a knowledge/profile conflict where the profile text is also in the compiled prompt head (the tests use orgs with no company_profiles description, so the head is empty).
- **Real or simulated behavior:** Real DB-backed storage; deterministic mapping with no model. Facts live in three overlapping real stores (company_profiles + compiled prompt head, company_knowledge, Brain) synced only one way.
- **Missing dependencies:** none external.
- **Remaining work:** Choose one authoritative store per fact; stop the compiled Partner prompt head carrying profile facts (compiler.ts L165-172) or recompile it from the active Brain; trigger head/Brain refresh from Knowledge Center edits; structured locations and pricing; add a DB-backed test with a populated company_profiles row proving a disputed or superseded value never reaches the prompt.
- **Verification evidence:** Prior recorded: docs "Approved company knowledge and Business Brain synchronization (2026-11-08)" and "Settings > Business profile edits ... refresh the Growth Partner" claims with green runs. My observation: read the compiler, run-instruction assembly and sync code; concluded the profile head and Brain are parallel sources. This is from code reading; I did not execute a prompt build with a non-empty profile.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each listed fact group has exactly one authoritative record; every editing surface updates it and derived copies in the same request; a built Partner prompt for a tenant with populated profile, knowledge conflict and active Brain contains each fact at most once and never a disputed or superseded value.

<a id="gp-brain-03"></a>
### GP-BRAIN-03 — Working hours, calendar preferences, lead preferences and sales-qualification criteria

- **Requirement:** Working hours, calendar preferences, lead preferences and sales-qualification criteria (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts`, `src/server/messaging/inbox.ts`, `src/lib/ai-growth-partner.ts`, `src/server/leads/service.ts`, `src/server/onboarding/lead-targeting-draft.ts`, `src/server/onboarding/scheduling-drafts.ts`, `src/components/growth-partner/brain-fact-editor.tsx`
- **Test coverage:** tests/messaging-settings-sync.test.ts L178 (hours into active Brain, draft rebased, tenant isolated), tests/workforce-chat-business-brain-e2e.test.ts L147 (hours through permanent chat), tests/onboarding-scheduling-drafts.test.ts, tests/onboarding-lead-targeting.test.ts. DB-backed. No test that a Brain edit of operatingHours or appointment facts affects enforcement (it does not).
- **Real or simulated behavior:** Real. Operational settings tables enforce behaviour; the Brain holds one-way descriptive mirrors (Messaging hours -> Brain only).
- **Missing dependencies:** none external.
- **Remaining work:** Make mirrored Brain facts read-only (or route edits to the owning service) so an operatingHours/appointment edit in the Brain editor cannot diverge from enforcement; define precedence between company_knowledge business_hours and messaging hours and surface it; decide whether lead preferences, calendar preferences and qualification criteria are mirrored (read-only, sourced with integration/crm/calendar provenance) or the unused slots dropped; verify which qualification criteria lead scoring actually reads.
- **Verification evidence:** Prior recorded: docs 2026-11-07 "Chat-controlled Messaging hours and Business Brain synchronization" (97/97 focused). My observation: read the sync function and the editor; confirmed the editor can edit any slot, including mirrored ones.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each operational preference has one owner; the Brain shows a labelled read-only mirror or is the owner; editing from any surface changes what is enforced and the prompt copy together, proven by tests.

<a id="gp-brain-04"></a>
### GP-BRAIN-04 — Brand voice, communication style, personality, escalation rules, prohibited actions, authorized workflows

- **Requirement:** Brand voice, communication style, personality, escalation rules, prohibited actions, authorized workflows (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/agent-settings.ts`, `src/server/workforce/compiler.ts`, `src/lib/ai-growth-partner.ts`, `src/lib/workforce-chat-preferences-intent.ts`, `src/server/chat/service.ts`, `src/server/settings/service.ts`, `src/server/ai-growth-partner/capability-access.ts`, `src/server/workforce/service.ts`
- **Test coverage:** tests/workforce-chat-e2e.test.ts (persistent preferences via chat, per docs L318); tests/onboarding-employee-sync-settings.test.ts L145 (client-written personality kept); tests/growth-partner-capability-dispatch.test.ts and tests/ai-growth-partner-capability-access.test.ts (ability switches). Not covered: any test that tone/language changed in chat or Settings is reflected in (or reconciled with) Brain `brandCommunication.tone`, or that two conflicting values cannot appear in one prompt.
- **Real or simulated behavior:** Real. Two parallel real stores: Brain slots and the Partner's agent_config_versions settings; only the settings drive the compiled prompt head and are changed by chat/Settings preferences.
- **Missing dependencies:** none external.
- **Remaining work:** Reconcile duplicate stores (tone/language/reply length/never-promise/escalation/company rules exist in both Brain and agent settings; preference edits never reach the Brain); map or remove 12 never-populated slots (employeeBehavior.*, brandCommunication.formality/style/terminology/topicsToAvoid); add a bounded always-retrieved rules group (prohibited promises, communication boundaries, escalation, required approvals, hand-off rules); define workflow preferences vs server-side ability enforcement. | Skeptic adds: Re-scope item (3): the onboarding/Settings-derived hard rules (company rules, never-promise, ask-a-human-when, escalation contact) are compiled into the stored prompt head unconditionally (compiler.ts:176-179), so they ARE always in the Partner prompt and in customer-reply prompts. The real exposure is narrower: a rule edited only in the Brain (prohibitedPromises, escalationRequirements etc.) is retrieved only on a lexical match (ai-growth-partner.ts:148-155, 210-216) and can contradict the always-present head copy. Fix by reconciling the copies, not only by adding an always-retrieved group.
- **Verification evidence:** Prior recorded: docs L98/L99/L318 describe chat-controlled preferences with green focused runs. My observation: confirmed by grep that only four callers of syncGrowthPartnerBusinessBrain* exist (knowledge service, approvals service, messaging inbox, onboarding employee-sync profile path) and none is invoked from updateAiPreferences; confirmed the retrieval always-list contains only six identity facts.
  - *Skeptic review: The audit says hard rules are 'not guaranteed to be in the prompt'. That overstates it for the settings-owned copy. The duplicate-store finding itself stands.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Tone, language, length, personality, escalation and never-promise exist once as authoritative values; every edit surface updates the authoritative store and the derived prompt copy in the same request; hard rules always reach the Partner and customer-reply prompts; DB-backed test proves a chat tone change leaves no contradictory Brain or prompt statement.

<a id="gp-brain-05"></a>
### GP-BRAIN-05 — Business goals

- **Requirement:** Business goals (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0133_ai_growth_partner_goals.sql`, `src/server/ai-growth-partner/goals.ts`, `src/lib/ai-growth-partner-goals.ts`, `src/lib/workforce-chat-goal-intent.ts`, `src/components/growth-partner/goals-panel.tsx`, `src/lib/ai-growth-partner.ts`
- **Test coverage:** tests/ai-growth-partner-goals.test.ts (L36 optimistic revisions, audit, member denial; L89 tenant-only counting and permission-gated progress), tests/growth-partner-goals-panel.test.tsx, tests/workforce-chat-goal-intent.test.ts, goals appear in prompt in tests/ai-growth-partner-unified-context-e2e.test.ts L148. DB-backed.
- **Real or simulated behavior:** Real DB goals measured against real lead/appointment/CRM counts; Brain goal slots are descriptive copies that nothing keeps in sync.
- **Missing dependencies:** none external.
- **Remaining work:** Pick the goals table as owner and populate or remove Brain employeeGoals slots; add change history (only a revision counter and new-value audit exist); decide scope beyond four metrics and weekly/monthly cadence; chat support for free-text priorities.
- **Verification evidence:** Prior recorded: docs L98 (chat goals and prompt context). My observation: read goals.ts and the migration; tests assert DB behaviour.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One owner per goal type; panel, chat and onboarding all write it; prior targets are retrievable; the prompt shows exactly the enabled goals; test proves change then honoured on next prompt.

<a id="gp-brain-06"></a>
### GP-BRAIN-06 — User corrections and preferences (app memory)

- **Requirement:** User corrections and preferences (app memory) (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0130_ai_growth_partner_memory.sql`, `src/server/ai-growth-partner/memory.ts`, `src/lib/ai-growth-partner-memory.ts`, `src/server/chat/service.ts`, `src/components/growth-partner/memory-panel.tsx`
- **Test coverage:** tests/ai-growth-partner-memory.test.ts (L42 grammar, L55 tenant-scoped notes, duplicate prevention, revisions, metadata-only audit), tests/growth-partner-memory-panel.test.tsx, tests/ai-growth-partner-fixture-acceptance.test.ts L377 (chat commands), tests/ai-growth-partner-unified-context-e2e.test.ts L59 (cross-tenant marker never appears). DB-backed.
- **Real or simulated behavior:** Real DB memory with deterministic Remember:/Forget: commands; not Hermes-native memory.
- **Missing dependencies:** none external.
- **Remaining work:** Corrections that contradict a Brain fact are ignored (memory header says it never overrides verified records): add a correction-to-Brain-draft flow or contradiction notice; chat Remember always creates working_context which is retrieved only on token overlap: allow choosing preference kind and always include a bounded set of preferences; add history/tombstones (update overwrites, delete is hard); allow non-exact Forget.
- **Verification evidence:** Prior recorded: docs (app memory increments; fixture acceptance 43/43 focused). My observation: read memory.ts fully; confirmed header text and kind handling.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A correction or preference saved once is retrievable when relevant, wins over or visibly supersedes a conflicting fact with owner approval, is auditable and recoverable after edit/delete; DB-backed tests prove each.

<a id="gp-brain-07"></a>
### GP-BRAIN-07 — Documents, employee notes and retained legacy knowledge outside the Brain

- **Requirement:** Documents, employee notes and retained legacy knowledge outside the Brain (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/knowledge/service.ts`, `src/server/knowledge/extract.ts`, `src/server/workforce/knowledge.ts`, `src/server/ai-growth-partner/legacy-knowledge.ts`, `src/server/workforce/service.ts`, `supabase/migrations/0134_ai_growth_partner_legacy_knowledge.sql`
- **Test coverage:** tests/ai-growth-partner-legacy-knowledge.test.ts (tenant-scoped import, pending/rejected stay out, cross-tenant/stale refused, audit has no text), tests/aqi-knowledge-documents.test.ts, tests/held-notes-documents.test.ts; unified-context test asserts pending/rejected markers absent. DB-backed.
- **Real or simulated behavior:** Real DB and private storage; real extraction code; no model.
- **Missing dependencies:** none external.
- **Remaining work:** Released documents (8 x 3,000 chars) and the Partner runtime's employee notes enter the prompt raw with no provenance, no conflict detection against the Brain and no version; either extract draft_suggestion Brain facts from documents (provenance 'knowledge_document' is declared but never written) or label them unreviewed reference; add document supersession/versioning; add chunked retrieval; legacy snapshot import copies only 3,000 chars.
- **Verification evidence:** Prior recorded: docs 2026-11-08 (legacy import review) with full-suite green. My observation: read employeeKnowledgeContext and confirmed documents/notes are appended raw for the Partner; confirmed 'knowledge_document' provenance is never written (grep).
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every knowledge source reaching the Partner prompt carries provenance and review state; supersession is explicit; a test shows an outdated or unapproved document cannot be retrieved.

<a id="gp-brain-08"></a>
### GP-BRAIN-08 — Automatic initial Brain generation at onboarding without fabricating facts

- **Requirement:** Automatic initial Brain generation at onboarding without fabricating facts (directive §6)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/ai-growth-partner.ts`, `src/server/ai-growth-partner/service.ts`, `src/server/onboarding/service.ts`, `src/server/onboarding/submitted-brain-source.ts`, `src/lib/onboarding/assistance.ts`, `src/server/onboarding/website.ts`, `src/app/actions/ai-growth-partner.ts`
- **Test coverage:** tests/ai-growth-partner-foundation.test.ts L99, L157, L201, L425, L460 (unknowns preserved, draft-suggestions, idempotent retry, migration stays draft); tests/growth-partner-submitted-source.test.ts; tests/client-onboarding-acceptance.test.ts L66 (one Partner + one Brain + one provisioning request per client); tests/onboarding-assistance.test.ts (mock-model: rejects invented services/detail via quote-grounding; L97 knowledge precedence); tests/onboarding-pipeline.test.ts. Generation is covered with real DB; AI assist is covered with a mocked provider only.
- **Real or simulated behavior:** Brain generation is real deterministic code over saved answers (no LLM). Upstream onboarding writing assistant and website analysis are real code tested only against a mocked model and fixtures.
- **Missing dependencies:** real model provider run for onboarding assistance (see GP-BRAIN-17).
- **Remaining work:** Fix state mislabelling: AI/website-sourced answers to non-sensitive questions are stored client_confirmed (only 14 of 81 questions set needsConfirmation); persist evidence URL per website-derived answer (evidenceUrl always null); add suggestion-only importers if CRM/calendar/website facts are to seed the Brain; map, add questions for, or drop the 60 never-populated slots; explicit UI when no Partner row exists; test that a normal re-submit cannot replace an activated Brain. | Skeptic adds: (a) Soften the state-mislabelling finding: submission is gated by a mandatory f.review approval that is withdrawn whenever any answer changes (engine.ts:318; onboarding/service.ts:285-286), and sensitive AI/website answers already require explicit confirmation (service.ts:273), so the owner reviews every answer before the Brain is built; the residual defect is the label (client_confirmed for AI-sourced non-sensitive answers, ai-growth-partner.ts:331-333, provenance still says draft_suggestion/website) rather than an unreviewed fact. (b) New defect: draftGrowthPartnerBusinessBrainFromOnboarding returns null without error when the submitter lacks agents.configure (service.ts:806), but onboarding still tells the agency 'The Business Brain is ready for review' whenever a Partner row exists (onboarding/service.ts:721). Agency staff may complete setup (workspace.manage_profile includes STAFF, permissions.ts:23) but agents.configure is owner/admin only (permissions.ts:27), so a staff-assisted submission can announce a Brain that was never generated. Add a test and make the notification depend on the returned value.
- **Verification evidence:** Prior recorded: docs "Request-scoped Business Brain retrieval" and onboarding contact-facts entries with green focused runs; hosted CI pinned-Hermes gate is synthetic. My observation: traced the function, confirmed the state mapping and the null evidenceUrl, counted unmapped slots with a read-only script over the source text.
  - *Skeptic review: Status IMPLEMENTED_UNVERIFIED stays, but one finding is overweighted and a real silent-failure path was missed.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Submitting onboarding yields a Brain whose every non-unknown fact is owner-typed/confirmed or visibly a suggestion; website/AI-derived values keep evidence URLs and are not retrievable as confirmed until confirmed; missing information stays unknown; DB-backed test covers non-sensitive AI-suggested answers.

<a id="gp-brain-09"></a>
### GP-BRAIN-09 — Fact provenance and confirmation state (confirmed vs suggested vs unknown)

- **Requirement:** Fact provenance and confirmation state (confirmed vs suggested vs unknown) (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/ai-growth-partner.ts`, `src/server/ai-growth-partner/service.ts`, `src/components/growth-partner/control-center.tsx`, `src/components/growth-partner/brain-fact-editor.tsx`
- **Test coverage:** tests/ai-growth-partner-foundation.test.ts L51 (schema invariants), L122 (draft_suggestion never retrieved), L507/L590 (company_knowledge provenance sourceId `company_knowledge:<section>@<version>`), tests/onboarding-employee-sync-settings.test.ts L111-119. DB-backed except the schema unit tests. No UI test asserts which provenance entry is shown.
- **Real or simulated behavior:** Real schema enforcement and UI; weak semantics in places (first-provenance display, conflict objects, unwritten source types).
- **Missing dependencies:** none external.
- **Remaining work:** Show the latest provenance entry not provenance[0] (control-center.tsx L243); implement or remove never-written sources (knowledge_document, integration, crm, calendar); record the edit channel on the fact; dedicated conflict-resolution control (current object-valued conflict facts render as flattened text and need a blank-then-retype two-step); one-step confirm for draft_suggestion and historical facts; explain verified vs client_confirmed.
- **Verification evidence:** Prior recorded: docs describe visible provenance. My observation: read the component line 243 and schema; verified object-valued edit path in saveGrowthPartnerBusinessBrainFactDraft L604-616.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every fact shows latest source, channel, evidence link and state; suggestions, conflicts and historical facts each have a one-step resolution; unknown stays null; tests cover latest-provenance display and conflict resolution.

<a id="gp-brain-10"></a>
### GP-BRAIN-10 — Versioning, audit history, recovery and portability of the Brain

- **Requirement:** Versioning, audit history, recovery and portability of the Brain (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts`, `src/components/growth-partner/control-center.tsx`, `src/components/growth-partner/brain-draft-review.tsx`, `src/server/knowledge/service.ts`, `supabase/migrations/0117_company_knowledge_revisions.sql`, `src/server/offboarding/export.ts`
- **Test coverage:** tests/ai-growth-partner-foundation.test.ts L396-411 (activation audit; older version refused by design), tests/knowledge-revisions.test.ts (every save a revision, baseline, flagged edit held, restore as new version, tenant isolation of history, offboarding export of revisions) and tests/knowledge-history-ui.test.tsx, tests/aqi-knowledge-history.test.ts. DB-backed. No test for Brain restore (nothing to test).
- **Real or simulated behavior:** Real audit rows and snapshots. Knowledge revisions + restore are fully real; Brain has no restore.
- **Missing dependencies:** none external.
- **Remaining work:** Add 'restore version N as new draft' (service, action, UI; 'rollback' source already allowed by migration 0120); version viewer and field-level diff (activate dialog shows no diff); changed-field summaries in source_metadata/audit; history for memory and goals; add Brain versions, memories, goals and legacy-knowledge snapshots to the offboarding export with a test.
- **Verification evidence:** Prior recorded: docs "Business Brain review and activation increment (2026-11-07)" (96/96 focused) and knowledge history entries. My observation: read the activation guard and the history component; grep confirms 'rollback' is never used in src.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** An owner can view, compare, restore (as a reviewed draft) and apply any past Brain version; audit rows describe changed facts; export contains every Brain-related table; tests cover restore, diff and export.

<a id="gp-brain-11"></a>
### GP-BRAIN-11 — Editing through direct settings surfaces (Brain editor, Settings profile, Knowledge Center, Messaging)

- **Requirement:** Editing through direct settings surfaces (Brain editor, Settings profile, Knowledge Center, Messaging) (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/brain-fact-editor.tsx`, `src/app/actions/ai-growth-partner.ts`, `src/server/ai-growth-partner/service.ts`, `src/server/knowledge/service.ts`, `src/server/onboarding/profile-sync.ts`, `src/server/onboarding/employee-sync.ts`, `src/server/messaging/inbox.ts`
- **Test coverage:** tests/knowledge-revisions.test.ts, tests/onboarding-employee-sync-settings.test.ts L87/L128, tests/messaging-settings-sync.test.ts L178, tests/growth-partner-business-brain-draft-review.test.tsx, tests/ai-growth-partner-foundation.test.ts L333. DB-backed. Not covered: instruction-like text through the Brain editor (no test and no code path rejects it).
- **Real or simulated behavior:** Real server actions and services with DB-backed tests.
- **Missing dependencies:** none external.
- **Remaining work:** Run the instruction-risk scan on Brain fact edits (saveGrowthPartnerBusinessBrainFactDraft has none, unlike knowledge/profile/memory) and route flagged text to agency review; show per-surface effect timing at edit time; typed editors for hours, lists and key/value facts instead of raw text/JSON; discard-draft and batching of multiple fact edits into one version; first-class qualification-criteria and workflow-preference editors; agency-side Brain edit path.
- **Verification evidence:** Prior recorded: docs sections on Settings->Brain sync and reviewed activation (green focused and full runs). My observation: read saveGrowthPartnerBusinessBrainFactDraft end to end and confirmed no scan; read handlers for the other surfaces.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every directive-listed editable group has a typed direct editor; all editors apply the same risk gate and state when the change takes effect; drafts can be discarded or batched; DB-backed tests prove instruction-like text through every surface is not applied without review.

<a id="gp-brain-12"></a>
### GP-BRAIN-12 — Editing through conversation (permanent Partner chat)

- **Requirement:** Editing through conversation (permanent Partner chat) (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-business-brain-intent.ts`, `src/server/chat/service.ts`, `src/lib/workforce-chat-preferences-intent.ts`, `src/lib/workforce-chat-goal-intent.ts`, `src/lib/workforce-chat-messaging-hours-intent.ts`, `src/lib/ai-growth-partner-memory.ts`
- **Test coverage:** tests/workforce-chat-business-brain-intent.test.ts (grammar), tests/workforce-chat-business-brain-e2e.test.ts L79 (owner edit saved as audited draft, inactive, idempotent repeat, member denied, no Hermes run) and L147 (hours), tests/workforce-chat-goal-intent.test.ts, tests/workforce-chat-e2e.test.ts (preferences, goals; per docs). DB-backed with a mock Hermes server. Not covered: natural phrasing, multi-fact requests, corrections of pricing/FAQ/brand voice/escalation/prohibited actions/qualification criteria/workflow preferences via chat.
- **Real or simulated behavior:** Real deterministic regex handlers with real DB writes; a mock Hermes server only proves no run is started. No model interprets edits.
- **Missing dependencies:** none to extend the deterministic grammar; an LLM "propose an edit" step would need a model but should still end in a confirm-before-save card, not a silent write.
- **Remaining work:** Only 8 Brain fields plus hours, tone/length/language, numeric goals and Remember/Forget are chat-editable (grammar requires the literal 'Business Brain'); add typed handlers for pricing, FAQs, brand voice, qualification criteria, escalation, prohibited actions, workflow preferences, personality; add a propose-then-confirm card for natural-language requests (model proposes, UI confirms, existing service writes); offer 'Apply now' so chat edits can complete without visiting Partner Controls; fix clarification text (omits service areas); add missing chatActionAllowed check; same risk scan as GP-BRAIN-11. | Skeptic adds: Add: the chat handler REPLACES the whole fact with the single sent value (array facts become one line; service.ts saveGrowthPartnerBusinessBrainFactDraft:600-616 + chat handler 943-1000) and the reply states only the new label and draft number, never the previous value, so the owner has no before/after in the thread (directive: predictable effect). Include the prior value in the reply and ask for confirmation before saving.
- **Verification evidence:** Prior recorded: docs L98 (chat-authored Brain drafts; parser + DB tests 5/5; full regression green). My observation: read the parser and handler, read the e2e test, counted FIELDS.
  - *Skeptic review: Audit finding stands (CLARIFICATION at workforce-chat-business-brain-intent.ts:12 indeed omits service areas although FIELDS has them). The replace-not-append and no-before-value behaviour is an additional gap.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A client can request any directive-listed change in everyday wording, sees an exact before/after confirmation, approves it in the thread, and the same audited, versioned, risk-gated write used by Settings is applied; DB-backed test per group proves stored, audited and honoured in the next prompt.

<a id="gp-brain-13"></a>
### GP-BRAIN-13 — Predictable effect timing and propagation consistency

- **Requirement:** Predictable effect timing and propagation consistency (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts`, `src/server/workforce/service.ts`, `src/server/knowledge/service.ts`, `src/components/growth-partner/brain-draft-review.tsx`, `src/server/chat/service.ts`
- **Test coverage:** tests/ai-growth-partner-unified-context-e2e.test.ts L142-160 (draft absent before activation, present after), tests/workforce-chat-business-brain-e2e.test.ts L106 (draft not in instructions), tests/knowledge-revisions.test.ts (held vs applied in next run's instructions). DB-backed. Not covered: failure between the knowledge commit and the Brain sync; compiled-head staleness.
- **Real or simulated behavior:** Real code; timing statements are produced by services that re-read stored state after save.
- **Missing dependencies:** none external.
- **Remaining work:** State the effect rule per surface at edit time (draft+apply vs immediate vs after agency review); make knowledge->Brain sync atomic or reconcilable (knowledge commit and Brain sync are separate transactions with no retry); stop the stored compiled head lagging the Brain; document in-flight runs keep prior instructions; fault-injection test for partial failure.
- **Verification evidence:** Prior recorded: docs list activation timing in L74. My observation: read the transaction structure of writeKnowledgeText (two separate transactions).
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every edit path states when it takes effect; the Brain cannot be left permanently behind knowledge after a partial failure (fault-injection test); a test proves each surface's change lands on the next run build.

<a id="gp-brain-14"></a>
### GP-BRAIN-14 — Retrieval correctness: no cross-tenant confusion, no invented facts, no outdated or unapproved content, preferences honoured

- **Requirement:** Retrieval correctness: no cross-tenant confusion, no invented facts, no outdated or unapproved content, preferences honoured (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/ai-growth-partner.ts`, `src/server/workforce/service.ts`, `src/server/workforce/knowledge.ts`, `src/server/ai-growth-partner/memory.ts`, `src/server/webchat/generator.ts`, `src/server/workforce/compiler.ts`
- **Test coverage:** tests/ai-growth-partner-foundation.test.ts L122 (pricing question retrieves pricing, not cancellation; draft_suggestion excluded; no query returns only identity), tests/ai-growth-partner-unified-context-e2e.test.ts L59 (active Brain + goals + memory + approved legacy knowledge; pending/rejected/raw-knowledge/cross-tenant markers absent; unlinked runtime refused L169), tests/ai-growth-partner-legacy-knowledge.test.ts L142. DB-backed, prompt-assembly level only.
- **Real or simulated behavior:** Real deterministic lexical retrieval (keyword/topic scoring, 24 facts / 8,000 chars; no embeddings, no model). Tenant isolation by SQL org_id predicates plus RLS.
- **Missing dependencies:** real model for the "does not invent" outcome (GP-BRAIN-17).
- **Remaining work:** Remove duplicate sources from one prompt (compiled head vs Brain vs raw documents/notes vs memory) with a populated-profile test; always include hard rules; mark and avoid silent truncation (1,200-char per-fact cut, silent drop after 8,000 chars); retrieval eval set with recall threshold and paraphrase handling; two-tenant conflicting-value test on buildRunInstructions; align website-chat widget knowledge (reads company_knowledge only) with Brain facts or document the split. | Skeptic adds: Add: (i) retrieval is keyed only on the current message. Both the customer path (responder.ts:136 passes ctx.customerMessage, not history) and chat build the query from one message, so a follow-up such as 'and how much for that?' retrieves identity facts only and the Brain's pricing fact is absent from the prompt (ai-growth-partner.ts:210-216: relevant list is empty when no terms match). Include recent turns in the query or add a bounded always-on set per channel. (ii) Test caveat: the unified-context e2e test seeds its Brain through saveGrowthPartnerBusinessBrainDraft (unified-context-e2e.test.ts:40), a function no production caller uses, and its only cross-tenant assertion is a memory marker (line 143), which matches the audit; add a Brain-vs-Brain two-tenant conflicting-value case.
- **Verification evidence:** Prior recorded: docs "Request-scoped Business Brain retrieval (2026-11-11)" (58/58 and 83/83 focused, local synthetic only, "no real-model call"). My observation: read the retrieval, scoring, truncation and assembly code and the tests; I did not execute them.
  - *Skeptic review: Row is correct as PARTIAL/synthetic-only; two retrieval correctness gaps (history-blind query, test seeded via a test-only function) were missed.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For a tenant with populated profile, knowledge, documents, memory and Brain, the built prompt contains each fact once, never unapproved/superseded/other-tenant data, always the hard rules, marks any truncation; a 30+ query eval set meets a stated recall threshold in CI.

<a id="gp-brain-15"></a>
### GP-BRAIN-15 — Private-context leakage control (internal facts vs customer-facing replies)

- **Requirement:** Private-context leakage control (internal facts vs customer-facing replies) (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/responder.ts`, `src/server/workforce/service.ts`, `src/lib/ai-growth-partner.ts`, `src/server/webchat/generator.ts`
- **Test coverage:** `tests/brain-customer-audience.test.ts` covers audience defaults and prompt-head filtering. `tests/workforce-chat-business-brain-e2e.test.ts` exercises the real reply builder and mock Hermes run with internal Brain, compiled-profile and company-knowledge canaries; it checks no-tools scope, absent native-memory session scope, public Brain grounding, and fail-closed behavior when Hermes cannot verify the scope. `tests/messaging-responder.test.ts` retains non-Growth-Partner claim-net coverage.
- **Real or simulated behavior:** App-side audience separation is implemented: confirmed Brain facts in default customer-safe slots (or explicitly marked customer-safe) are the only Brain facts in a Growth Partner customer prompt; compiled role/context/preferences/tool labels are removed except fixed tone/length/language; app goals, saved memory, retained knowledge, employee notes, reference documents and company Knowledge Center content are excluded. Customer runs omit Hermes-native memory scope and require a verified `no_tools` run. Reply claims are checked against customer-safe Brain facts only. All evidence is synthetic (PGlite plus mock Hermes); no live provider/model run was made.
- **Missing dependencies:** none for the app-side controls. Runtime-level confirmation that the pinned Hermes profile's SOUL and native-memory backend cannot reintroduce internal context remains external to this test suite.
- **Remaining work:** Keep the row PARTIAL until the pinned-runtime canary proves that a customer-originated marker is unavailable to a later customer run and the owner's internal Partner chat, while the no-tools overlay remains enforced. If the runtime injects profile-wide SOUL or native memory despite these controls, use a separate or narrowed customer profile. A real-model grounding evaluation also remains separate from this synthetic proof.
- **Verification evidence:** Commit `bb63ebb3` (`fix: isolate Growth Partner customer replies`): focused tests passed 3 files / 38 tests; `npm run typecheck`, targeted ESLint and `git diff --check` passed. The e2e uses a PGlite tenant and mock Hermes only; no live Hermes gateway, model provider, customer data or production system was used.
  - *Historical audit at 6e4a4b7e correctly found a leak in that older tree, but its no-audience/full-prompt observations are superseded by the implementation and tests above.*
- **Definition of done:** A customer-facing generation receives only customer-safe Brain facts and customer-turn context; internal goals, app memory, profile instructions, private qualifications and contacts do not enter the prompt; runtime tools and native-memory scope are unavailable; unsupported claims are blocked against the customer-safe fact source. Pinned-runtime and real-model evidence remain required before marking verified.

<a id="gp-brain-16"></a>
### GP-BRAIN-16 — Tests for knowledge update, retrieval, correction and recovery

- **Requirement:** Tests for knowledge update, retrieval, correction and recovery (directive §6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `tests/support/fixtures.ts`, `tests/support/mock-hermes.ts`
- **Test coverage:** Strong and real-path for: Brain schema/RLS/immutability/draft-activate; onboarding generation; knowledge revisions + restore + agency review; knowledge-to-Brain sync with conflicts; profile and hours sync; chat Brain/hours/goal/preference edits; memory CRUD and prompt inclusion; legacy knowledge review; unified prompt assembly with tenant markers. Weak or absent: Brain restore/diff (feature absent); preference-to-Brain reconciliation; compiled head vs Brain contradiction; instruction-like text through the Brain editor and chat; customer-facing audience exclusion; truncation behaviour; natural-language corrections; knowledge-sync partial failure; document supersession; retrieval recall measurement; real-model grounding; export of Brain data; concurrency of writers.
- **Real or simulated behavior:** Real PGlite database, deterministic synthetic fixtures, mock or fixture providers; no real model.
- **Missing dependencies:** none for the repository-only gaps.
- **Remaining work:** Add missing tests as features land: Brain restore/diff, preference-to-Brain reconciliation, compiled head vs Brain contradiction, instruction-like text via Brain editor and chat, customer-audience exclusion, truncation, natural-language corrections, knowledge-sync partial failure, document supersession, retrieval recall eval, Brain export, writer concurrency; add a property test that no sequence of edits yields two values for one fact key in the built prompt; one brain-acceptance suite across two tenants.
- **Verification evidence:** Prior recorded: docs list suite totals (903 files / 13,860 tests, green) and focused counts; the orchestrator's baseline run supersedes these. My observation: I listed and read the relevant tests but did not run them.
  - *Baseline: 8 of 8 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A CI acceptance suite runs create -> edit via each surface -> correct -> restore -> retrieve for two tenants and fails on each regression named in BRAIN.md.

<a id="gp-brain-17"></a>
### GP-BRAIN-17 — Real-model verification of Brain-grounded answers (no invented facts, no private leakage)

- **Requirement:** Real-model verification of Brain-grounded answers (no invented facts, no private leakage) (directive §6)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `src/server/workforce/service.ts`, `src/server/messaging/responder.ts`, `.github/workflows/hermes-client-acceptance.yml`
- **Test coverage:** none against a real model.
- **Real or simulated behavior:** Not verified. All existing evidence is prompt-assembly assertions and mock or synthetic-fixture providers; docs state real model-provider behaviour is untested.
- **Missing dependencies:** paid model-provider calls and approval to spend; a configured Hermes gateway with a real provider key (founder decision / credentials).
- **Remaining work:** Unblocked part: build the eval harness (fixed tenants and fact sets, adversarial prompts for unknown price, stale hours, internal threshold, instruction embedded in a fact, scoring rules) and prove it against the mock. Blocked part: run it against a real model after approval and record model id, date and results.
- **Verification evidence:** Prior recorded: docs "Hosted Hermes run #87/#89" are synthetic-fixture runs ("synthetic-fixture" provider) and explicitly state real model-provider memory/answers are untested. Nothing observed by me.
- **Definition of done:** A recorded real-model run shows answers only from retrieved facts, 'I don't know' on missing facts, no disclosure of internal facts to a customer persona, and instruction-like fact text ignored; results stored as evidence with model, date and prompts.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Brain facts have no freshness or re-confirmation cycle (stale facts stay retrievable indefinitely)", "directiveRef": "§6 retrieval guarantees: no outdated content", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "Facts carry updatedAt and provenance but retrieval (ai-growth-partner.ts:189-217) filters only by state, never by age. Add an owner-visible 'last confirmed' date, a configurable review cadence for time-sensitive facts (hours, pricing, promotions, service areas), a stale flag in the control center, and exclusion or a prompt marker for facts past their review date. Test: a fact past its review date is flagged and not asserted as current."}
- {"title": "Brain facts are retrieved from the current message only; follow-up questions lose context", "directiveRef": "§6 retrieval guarantees", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "responder.ts:136 passes only ctx.customerMessage to buildRunInstructions. Extend the retrieval query with the last N user turns (bounded) or carry facts retrieved earlier in the conversation, and add a multi-turn retrieval test ('How much for a roof inspection?' then 'and what about cancellations?' then 'and the price again')."}
- {"title": "Reply-claim grounding checks the wrong knowledge source for the Growth Partner", "directiveRef": "§6 retrieval guarantees (no invented facts), customer replies", "priority": "P1", "status": "PARTIAL", "remainingWork": "replyClaimProblems grounds replies against approved company_knowledge sections only (responder.ts:238; generator.ts:33-53) while the Partner is told to answer from the Brain. Brain-only facts cause false holds; knowledge text the Brain deliberately kept out (conflict, owner override) can still ground a claim. Ground against the same customer-safe, active-Brain fact set used to build the prompt and add both a false-hold and a false-allow test."}
- {"title": "Brain version history can still be deleted by the system role (immutability covers UPDATE only)", "directiveRef": "§6 versioning plus audit history", "priority": "P2", "status": "PARTIAL", "remainingWork": "Migration 0120 adds only a BEFORE UPDATE trigger (lines 77-85). Add a BEFORE DELETE/TRUNCATE guard that permits only the organization cascade, or document and test the retention path; add a test that a DELETE of a non-active version is rejected."}
- {"title": "Onboarding announces a ready Business Brain even when none was generated", "directiveRef": "§6 automatic initial generation without fabricating or overstating", "priority": "P2", "status": "PARTIAL", "remainingWork": "draftGrowthPartnerBusinessBrainFromOnboarding returns null when the submitter lacks agents.configure (service.ts:806), yet onboarding/service.ts:721 posts 'The Business Brain is ready for review' whenever a Partner row exists. Agency staff can submit (workspace.manage_profile) but cannot configure. Surface the real outcome (generated, reused, skipped for permission) in the notification and the client UI, and test a staff-assisted submission."}
