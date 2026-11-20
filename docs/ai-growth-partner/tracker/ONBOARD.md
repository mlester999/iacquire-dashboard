# ONBOARD — Client onboarding journey

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). Implementation snapshot: `7f6d33f92859f0b34a1d0dfddaa7a0db17dfe178` on branch `claude/ai-growth-partner-completion`; the baseline audit below remains historical.

Focused local follow-up verification for GP-ONBOARD-16 ran on 2026-11-16. The integrated full suite passed on 2026-11-17 at source commit `b40606c8`, immediately before the tests-only W1-12 commit; no hosted database, production, live model or live provider verification was performed.

**What exists.** A new client workspace is created by an agency Super Admin (`createClientTenant`) or by the purchase flow (`provisionPurchaseIntent`), never by self-signup. Creation already writes the one `agent_instances` row (`role_key = growth_partner`, `status = setup_required`) and the one `ai_growth_partners` row, an `onboarding_responses` row, a setup instance and an owner invitation. The owner accepts the invitation, lands on `/welcome`, then answers an adaptive, server-persisted questionnaire (`src/lib/onboarding/definitions.ts`, 6 sections A-F, v3). Approval (`submitOnboarding`) writes profile/knowledge/messaging in one transaction, builds ONE Growth Partner configuration (`growthPartnerSettingsFromOnboarding`), creates and activates Business Brain v1, drafts a native calendar and lead targeting, and opens ONE provisioning request (gated on verified owner email, active org and cleared setup payment). The restricted provisioner claim/complete path, first health check, permanent-conversation creation and launch-readiness judge are all real code against the database.

**Real vs simulated.** Application journey services run against embedded PGlite; the Hermes profile itself is not created by these tests, and the worker is simulated by route callbacks or a local mock model. The synthetic regression workflow now includes `claude/ai-growth-partner-completion` in its branch filter, but no CI run for this candidate is recorded. No real model call, real provider, real customer or production database was involved in the local verification.

**Real automation vs manual steps.** Automatic once switches are on: Growth Partner row/runtime row creation, Brain v1, configuration version, provisioning request, worker claim -> profile creation on the VPS (restricted Python worker), first health check, conversation creation, launch-readiness recalculation. Manual / operator / founder: creating the client (or verifying the payment), recording/waiving the setup payment, agency review of any HELD first configuration (`decideHeldVersion`), client choosing the calendar host and approving hours, the whole VPS side (client-only gateway, secrets, gateway attestation, profile cap, worker image), setting the production switches, applying migrations 0120-0135 to the hosted database, and every provider connection. The legacy `manual_hermes_profiles` runbook job is still queued for every client and still tells agency staff to create profiles by hand.

**Biggest gaps.** (1) No Hermes profile has ever been created for a client; production activation is wholly founder/operator-gated. (2) Six Partner-only acceptance cases now sit beside the legacy cases, and a two-tenant purchase-to-conversation journey passes locally in `tests/growth-partner-onboarding-journey.test.ts`; that full-journey file is intentionally untracked and excluded from this branch, so there is no tracked CI evidence for it. (3) Onboarding silently skips the Business Brain when the submitter lacks `agents.configure`. (4) Four flow steps are only informational or absent: capability-permission review, Work Board schedules, integration connect offer, first meaningful action. (5) Tenant/payment-level idempotency has crash and concurrency holes. (6) Business voice is only tone/length/language/rules.

---

<a id="gp-onboard-01"></a>
### GP-ONBOARD-01 — Account creation, invitation acceptance and tenant creation

- **Requirement:** Account creation, invitation acceptance and tenant creation (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/tenants.ts:130`, `src/server/auth/service.ts:432`, `src/server/auth/service.ts:580`, `src/server/auth/service.ts:668`, `src/server/purchase-intents/service.ts:628`, `src/server/purchase-intents/checkout.ts:386`, `src/lib/plan-employees.ts`, `src/app/page.tsx:12`, `src/app/(setup)/welcome/page.tsx`, `src/components/onboarding/welcome-hero.tsx`
- **Test coverage:** tests/auth.test.ts, tests/client-invitation-resend.test.ts, tests/purchase-intents.test.ts, tests/tenant-creation-idempotency.test.ts and tests/purchase-checkout.test.ts cover captured invitations, purchase provisioning, retry, replay and online automatic provisioning. tests/client-onboarding-acceptance.test.ts still substitutes the owner with createUser + addMember and clears payment directly; there is no tracked single test chaining purchase -> invitation acceptance -> /welcome -> onboarding.
- **Real or simulated behavior:** Real DB service code; email captured in tests (EMAIL_PROVIDER=capture). Signup is invitation-only and operator/purchase-led (Super Admin createClientTenant or provisionPurchaseIntent); no self-serve registration. client-onboarding-acceptance replaces owner acceptance with createUser+addMember and a synthetic payment clear.
- **Missing dependencies:** production mailer (Resend key, verified sending domain), a payment provider for the automatic variant; both founder-owned.
- **Remaining work:** Add a tracked journey test using provisionPurchaseIntent -> acceptInvitationAsNewUser -> /welcome -> saveOnboardingStep/submitOnboarding (extend client-onboarding-acceptance, do not replace); document that account creation is operator/purchase-led. A journey test currently present in the worktree remains untracked and separate and is not counted here.
- **Verification evidence:** Own: read the code paths above; confirmed `createClientTenant` ignores `enabledRoles` and always seeds one Growth Partner (schema comment :71). Recorded (docs): purchase and invitation flows released to production 2026-11-03 with live sends of one test invitation (memory/docs; not re-verified here).
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A fictional buyer's sandbox purchase creates one workspace with exactly one Growth Partner identity, the owner accepts the emailed invitation and is redirected to /welcome, proven by one automated chain test with no manual SQL.

<a id="gp-onboard-02"></a>
### GP-ONBOARD-02 — Business details, goals, target audience, services and operating locations (questionnaire sections A and B)

- **Requirement:** Business details, goals, target audience, services and operating locations (questionnaire sections A and B) (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/onboarding/definitions.ts:53`, `src/lib/onboarding/engine.ts:121`, `src/lib/onboarding/engine.ts:310`, `src/server/onboarding/service.ts:162`, `src/server/onboarding/service.ts:235`, `src/server/onboarding/website.ts`, `src/app/(setup)/onboarding/page.tsx`, `src/components/onboarding/adaptive-onboarding.tsx`, `src/lib/ai-growth-partner.ts:112`
- **Test coverage:** `tests/onboarding-v2.test.ts` (adaptive rules, validation, DB-backed persistence/resume/stale revision/role gate/tenant read isolation lines 272-348, AI-suggestion confirmation 334), `tests/onboarding-business-profile.test.ts`, `tests/onboarding-answer-drift.test.ts`, `tests/onboarding-assistance.test.ts`, `tests/onboarding-suggest-route.test.ts`, `tests/onboarding-ui.test.tsx`, `tests/client-onboarding-ui.test.tsx`. These run real code on PGlite; the LLM and website fetch are mocked, so no real-model verification. Browser QA scripts (`scripts/wave2-onboarding-qa.mjs`, `scripts/onboarding-browser-qa.mjs`) are manual harnesses, not in CI (`.github/workflows` has only the Hermes workflows).
- **Real or simulated behavior:** Real per-answer server persistence, resume, validation and prefill on PGlite. AI suggestions and website reading are suggestions only and are mocked in tests (no real LLM). Browser QA scripts are manual, not in CI.
- **Missing dependencies:** none for the form itself; real-LLM suggestions need a configured provider key (founder).
- **Remaining work:** Operating locations are free text (a.location, a.territories) and idealCustomers.locations is never mapped: add a structured service-area answer and Brain mapping; 61 of 135 Brain facts (differentiators, positioning, valueProposition, painPoints, disqualifiers...) can never be filled by onboarding: add the questions or document they are learned later; add a CI browser check for a Growth-Partner-only tenant. | Skeptic adds: Reword the Brain-coverage item to the real onboarding gaps (differentiators/positioning, valueProposition, painPoints, disqualifiers, structured service areas); the 61/135 figure is 62 by recount and mostly counts runtime/employee-behaviour facts onboarding was never meant to fill.
- **Verification evidence:** Own: read definitions, engine and service; counted unmapped Brain facts by script-free comparison of `REQUIRED_UNKNOWN_FACTS` and `CANONICAL_BRAIN_FIELDS`. Recorded (docs): full suite and wave-2 browser QA passed on earlier checkpoints (`docs/ai-growth-partner/implementation-status.md`, "Local verification"); not re-run.
  - *Skeptic review: Overstated gap: unmapped facts are largely not onboarding-domain, and some are filled by company-knowledge sync (brand_voice) or client edits.*
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A fictional tenant answers every A/B question including structured service areas and differentiators, resumes from another session, and Brain v1 shows each answer as a client_confirmed fact with provenance.

<a id="gp-onboard-03"></a>
### GP-ONBOARD-03 — Business voice (section C: tone, length, language, rules)

- **Requirement:** Business voice (section C: tone, length, language, rules) (directive §16)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/onboarding/definitions.ts:235`, `src/lib/ai-growth-partner.ts:270`, `src/server/onboarding/employee-sync.ts:189`, `src/lib/onboarding/engine.ts:503`, `src/server/ai-growth-partner/service.ts:64`, `supabase/migrations/0120_ai_growth_partner_foundation.sql`
- **Test coverage:** `tests/client-onboarding-acceptance.test.ts` (tone/rules/never-promise reach settings; a later tone change re-derives personality while a client-edited personality is preserved), `tests/onboarding-employee-sync.test.ts`, `tests/onboarding-employee-sync-settings.test.ts`, `tests/ai-growth-partner-foundation.test.ts:157`. Real code on PGlite; no test checks that a real model actually writes in the chosen voice.
- **Real or simulated behavior:** Deterministic real code: tone/length/language/company rules map into the versioned Growth Partner settings text and Brain brandCommunication facts (brandVoice via the seeded brand_voice knowledge). No LLM is used and no test proves a real model writes in that voice.
- **Missing dependencies:** none for the form; verifying voice quality needs a real model call (founder-approved spend).
- **Remaining work:** Add voice questions with real content (voice description, preferred/avoided phrases, formality, example sentences); map to brandCommunication.formality/style/terminology/topicsToAvoid/brandVoice and persona_settings; show in the review panel; extend client-onboarding-acceptance and ai-growth-partner-foundation tests.
- **Verification evidence:** Own: read mappings; `brandCommunication.formality/style/terminology/topicsToAvoid` have no source in onboarding. Recorded: none beyond docs saying tone/length/language reach versioned settings (`implementation-status.md` lines 22-23), which matches the code.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The owner can describe and sample their voice, the Brain and persona settings carry it with provenance, re-submission preserves client edits, and a real-model sample reply reflects it.

<a id="gp-onboard-04"></a>
### GP-ONBOARD-04 — Generate and version the Business Brain from onboarding

- **Requirement:** Generate and version the Business Brain from onboarding (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/ai-growth-partner.ts:321`, `src/server/ai-growth-partner/service.ts:798`, `src/server/ai-growth-partner/service.ts:658`, `src/server/ai-growth-partner/service.ts:921`, `src/server/ai-growth-partner/service.ts:1087`, `src/server/onboarding/service.ts:707`, `src/server/onboarding/submitted-brain-source.ts`, `supabase/migrations/0120_ai_growth_partner_foundation.sql`, `src/lib/permissions.ts:23`, `src/lib/onboarding/business-profile.ts`
- **Test coverage:** `tests/ai-growth-partner-foundation.test.ts` (unknowns stay empty :51; client override preserved :77; onboarding mapping :99/:157/:201; single partner per tenant :220; immutability/tenant FK :254; RLS via app role :290; retry reuses snapshot :425; migration-candidate stays draft :460; knowledge merge :507/:590), `tests/client-onboarding-acceptance.test.ts` (v1 active, source `onboarding`, exact service/pricing facts, a re-submission adds no extra version), `tests/growth-partner-business-brain-draft-review.test.tsx`, `tests/growth-partner-submitted-source.test.ts`, `tests/workforce-chat-business-brain-e2e.test.ts`. DB-backed and strong for the logic; no live model uses the Brain in any test.
- **Real or simulated behavior:** Real deterministic generation and immutable versioning (DB trigger) on PGlite; first version auto-activates, later ones stay drafts until an owner activates. No live model uses the Brain in any test.
- **Missing dependencies:** none to fix the defects below.
- **Remaining work:** Keep the explicit result check as defensive hardening; the suspected missing-permission path is unreachable for current client onboarding roles. W1-11 now tells agency staff whether onboarding activated the first Brain version, reused a snapshot, or left a draft for approval. Still open: surface a draft to the owner in outcome notes/readiness, decide provenance labels for owner-confirmed AI answers, and decide whether a Brain review step should precede first activation.
- **Verification evidence:** W1-11's real onboarding test verifies the agency notice for auto-activated v1 and a later draft awaiting approval. The six-file W1-11 run passed (112 tests); typecheck and targeted ESLint passed. The reused-snapshot notification wording is implemented but not separately asserted.
  - *Skeptic review: The claimed silent-null defect is unreachable: onboarding contexts come from client organization_memberships whose roles are OrgRole only; workspace.manage_profile and agents.configure are identical for those roles, and agents.configure is not delegable so overrides cannot revoke it.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every onboarding submit by any permitted actor yields Brain v1 (or a visible blocker) with exact provenance, a re-submission surfaces a pending draft to the owner, a test covers the staff-submitter case, and versions stay immutable and monotonic.

<a id="gp-onboard-05"></a>
### GP-ONBOARD-05 — Provision ONE Growth Partner: application-side automation (identity, configuration, request, claim, health check, conversation)

- **Requirement:** Provision ONE Growth Partner: application-side automation (identity, configuration, request, claim, health check, conversation) (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/admin/tenants.ts:160`, `src/server/workforce/service.ts:114`, `src/server/workforce/service.ts:399`, `src/server/workforce/service.ts:1311`, `src/server/workforce/provisioning.ts:250`, `src/server/workforce/hermes-provisioner.ts:125`, `src/server/workforce/first-health-check.ts`, `src/server/workforce/provisioning-watchdog.ts`, `src/server/onboarding/employee-sync.ts:262`, `src/server/setup/jobs.ts:70`, `services/hermes-provisioner/worker.py`
- **Test coverage:** `tests/client-onboarding-acceptance.test.ts` (two tenants: exactly one agent row, one identity, one `provision` job in status `requested`, `hermes_profile` null), `tests/hermes-provisioner-route-acceptance.test.ts` (real onboarding -> claim -> complete -> sync, replay, auth failures, two tenants, Growth Partner role), `tests/ai-growth-partner-fixture-acceptance.test.ts` (health check creates the canonical conversation), `tests/provisioning.test.ts`, `tests/provisioning-watchdog.test.ts`, `tests/provisioner-claim-gates.test.ts`, `tests/hermes-provisioner.test.ts`, Python `test_worker.py`. `tests/client-employee-provisioning.test.ts` and `tests/client-provisioning-chain-acceptance.test.ts` still assert the six-role queue (`AGENT_ROLE_KEYS`) and do not cover the Growth Partner role.
- **Real or simulated behavior:** Portal side is real code on PGlite; the restricted worker and Hermes gateway are simulated by route callbacks or a CI harness with a local mock model. client-employee-provisioning and client-provisioning-chain-acceptance still model six roles. Gated on verified owner email, active org, cleared setup payment, applied (not held) configuration, attested gateway and capacity ceiling.
- **Missing dependencies:** manual agency decision for any HELD first configuration (`decideHeldVersion`); payment record/waiver; everything in GP-ONBOARD-06 for a real profile.
- **Remaining work:** Port the chain-acceptance and employee-provisioning suites to a Growth-Partner-only tenant as additional cases; retire or rewrite the legacy manual_hermes_profiles job and its stale text (setup/jobs.ts) that tells staff to create profiles by hand; show held-config and waiting reasons (payment, gateway, capacity) to the owner.
- **Verification evidence:** Own: read claim SQL, requestProvisioning, health-check/conversation code and the two acceptance tests. Recorded (docs): hosted synthetic runs #87/#91 provisioned one profile per synthetic tenant on a pinned Hermes v0.22.5 image with a local mock model (`implementation-status.md` lines 31, 165-175); not re-observed; workflow dispatch is limited to branch `codex/ai-growth-partner` (`.github/workflows/hermes-client-acceptance.yml`).
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For a Growth-Partner-only fictional tenant from submit to configured, tests assert exactly one agent instance, partner row, provisioning chain, profile identity and conversation, correct gating, and recovery from a failed attempt without duplicates.

<a id="gp-onboard-06"></a>
### GP-ONBOARD-06 — Real runtime provisioning and production activation (founder/operator steps)

- **Requirement:** Real runtime provisioning and production activation (founder/operator steps) (directive §16)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P0  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `services/hermes-provisioner/DEPLOYMENT.md`, `services/hermes-provisioner/compose.client.yaml`, `services/hermes-provisioner/worker.py`, `scripts/client-provisioning-preflight.ts`, `src/server/workforce/client-provisioning-preflight.ts:451`, `src/server/env.ts:137`, `docs/client-onboarding-provisioning-milestone-status-2026-11-02.md`, `docs/client-production-release-runbook-2026-11-03.md`, `supabase/migrations/0120_ai_growth_partner_foundation.sql`, `.github/workflows/hermes-client-acceptance.yml`
- **Test coverage:** preflight is covered by `tests/client-provisioning-preflight.test.ts` on a synthetic DB (including a Growth Partner unified tenant at :324); worker by Python tests and the `hermes-business-mcp-compat` / `hermes-client-acceptance` workflows (synthetic). None of this proves the production host.
  - Missing dependencies (all outside the repo): (1) apply migrations 0120-0135 to the hosted database (needs a restore point and the founder's approval); (2) deploy the client-only gateway on the VPS (image pin, capacity measured per the host-check doc, egress), create the private files (`hermes-api-key`, `profile-model-env.json`, `provisioner-token`), run the gateway attestation so `hermes_gateways.provisioner_isolation_verified_at` is set; (3) set the provisioner env vars and `HERMES_PROVISIONER_MAX_PROFILES`; (4) a real model provider key for the profile; (5) scheduler on for `provisioningWatchdog`/`launchWatch`; (6) production mailer and a payment provider; (7) a supervised pilot with a friendly client; (8) the production container is still Hermes v0.21.5 while the acceptance candidate is v0.22.5 (`services/hermes-provisioner/DEPLOYMENT.md`).
- **Real or simulated behavior:** Nothing real has run: no Growth Partner profile has ever been created for a client on the production gateway; provisioning is dormant behind HERMES_PROVISIONER_ENABLED; scheduler off; hosted migrations 0120-0135 not applied per docs. Only synthetic preflight and CI harness runs exist.
- **Missing dependencies:** Founder/operator: apply migrations 0120-0135 to the hosted DB with a restore point; deploy the client-only gateway on the VPS; create private secrets and attest the gateway; set provisioner env vars and profile cap; real model provider key; scheduler switches; production mailer and payment provider; supervised pilot; production image is Hermes v0.21.5 vs acceptance v0.22.5; acceptance workflow dispatch is limited to branch codex/ai-growth-partner.
- **Remaining work:** Nothing completable inside the repo. After approvals: read-only preflight with --live --expect enabled, one canary profile for a synthetic tenant, then the pilot; keep docs/client-provisioning.md manual-vs-automatic split current. | Skeptic adds: Correct CI facts: hermes-client-acceptance also triggers on push to codex/hermes-gha-acceptance and runs client-onboarding-acceptance + hermes-provisioner-route-acceptance against the pinned gateway (synthetic tenants only).
- **Verification evidence:** Own: read env gating, claim eligibility and DEPLOYMENT.md. Recorded (docs): dormant production state and the "not proven" list in `docs/client-onboarding-provisioning-milestone-status-2026-11-02.md` section 3.
  - *Skeptic review: Minor factual precision on the CI evidence; status stays EXTERNALLY_BLOCKED.*
  - *Baseline: 1 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One approved pilot tenant gets exactly one real Growth Partner profile through the automatic path, passes the portal health check, opens the permanent conversation and answers one real message, with the preflight green and evidence recorded.

<a id="gp-onboard-07"></a>
### GP-ONBOARD-07 — Configure the native calendar from onboarding answers

- **Requirement:** Configure the native calendar from onboarding answers (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/onboarding/scheduling-drafts.ts:179`, `src/lib/onboarding/scheduling-drafts.ts`, `src/server/setup/launch-intents.ts:124`, `src/server/setup/launch-intents.ts:155`, `src/server/calendars/activation.ts`, `src/server/calendars/native-availability.ts`, `src/server/onboarding/connection-facts.ts`
- **Test coverage:** `tests/onboarding-scheduling-drafts.test.ts`, `tests/onboarding-scheduling-rules.test.ts`, `tests/onboarding-host-from-answers.test.ts`, `tests/launch-intents.test.ts`, `tests/launch-host-choice.test.ts`, `tests/launch-region-and-stages.test.ts`, and `tests/client-launch-acceptance.test.ts` (draft -> host -> hours -> checks -> active -> real open times in the client's time zone, no time offered twice). All DB-backed. The acceptance case uses six-role tenants, not a Growth-Partner-only one; the Growth Partner's use of the calendar is covered separately by `tests/growth-partner-capability-dispatch.test.ts`.
- **Real or simulated behavior:** Real: a draft iAcquire calendar and appointment types are created at submit; host, hours and activation are explicit client steps through the launch panel and the activation checks. The acceptance case uses six-role tenants. Never live without the client's approval (manual client step by design).
- **Missing dependencies:** Google/Microsoft busy-calendar OAuth apps are not configured in production (founder approval 14 in the milestone doc); a tenant that states a busy calendar cannot reach the "verified" state without them.
- **Remaining work:** Add a Growth-Partner-only variant of the calendar part of client-launch-acceptance; route the owner from the post-submit page to the host/hours/activate actions; test that the Growth Partner offers no times while the calendar is draft.
- **Verification evidence:** Own: read drafts, intents and fact queries. Recorded (docs): milestone doc section 7 acceptance matrix rows for hosts/availability (synthetic only).
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A fictional Growth-Partner tenant reaches an active native calendar through client-approved steps only and the partner offers only real bookable times from it.

<a id="gp-onboard-08"></a>
### GP-ONBOARD-08 — Offer available integrations

- **Requirement:** Offer available integrations (directive §16)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** yes
- **Source files:** `src/server/onboarding/connection-facts.ts:19`, `src/lib/onboarding/engine.ts:709`, `src/components/onboarding/review-panel.tsx:310`, `src/server/setup/connectors.ts`
- **Test coverage:** `tests/onboarding-connection-facts.test.ts` (DB-backed), `tests/client-onboarding-ui.test.tsx` (optional connections rendering), `tests/onboarding-v2.test.ts:210-238`. Prove facts and wording, not that any provider connection works.
- **Real or simulated behavior:** Real read of the workspace's own rows, shown as informational missing/optional connection lines in the review; there is no step that offers integrations with connect actions. Tests prove facts and wording, not that any provider connection works.
- **Missing dependencies:** Twilio/WhatsApp/SMS and email sender registration (iAcquire stores the credential and runs the provider test; channels need real accounts), Google/Microsoft calendar OAuth apps, Meta social app, payment provider keys: all founder/provider-owned.
- **Remaining work:** Add a post-submit 'Connect your tools' section from connectionFacts with deep links, permission-aware actions and what each unlocks for the partner; explain unavailable providers; reconcile the legacy 'Automation not set up' missing-connection; add tests.
- **Verification evidence:** Own: read the fact queries and review model; no connect action is rendered in the onboarding components. Recorded (docs): milestone doc section 2 item 4 says the panel is honest about channels and what waits on iAcquire (matches code).
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** After approval the owner sees every available integration with real state, a working connect link and its benefit; unavailable ones say exactly why.

<a id="gp-onboard-09"></a>
### GP-ONBOARD-09 — Review capability permissions (Allowed actions) before launch

- **Requirement:** Review capability permissions (Allowed actions) before launch (directive §16)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/onboarding/engine.ts:696`, `src/components/onboarding/review-panel.tsx:273`, `src/lib/ai-growth-partner-capability-access.ts`, `src/server/ai-growth-partner/capability-access.ts`, `src/server/workforce/abilities.ts:24`, `src/lib/employee-tool-policy.ts`, `src/components/growth-partner/control-center.tsx:466`, `src/app/(portal)/employees/[slug]/page.tsx`, `supabase/migrations/0122_growth_partner_capability_role.sql`
- **Test coverage:** `tests/ai-growth-partner-capability-access.test.ts`, `tests/growth-partner-capability-readiness-ui.test.tsx`, `tests/employee-ability-enforcement.test.ts`, `tests/growth-partner-capability-dispatch.test.ts`, `tests/growth-partner-crm-ability.test.ts` (enforcement and read-only display are DB-backed). Nothing tests an onboarding step that reviews or changes permissions because none exists.
- **Real or simulated behavior:** Enforcement and the Control Center read-only access display are real DB code; the onboarding review's permission list is hard-coded prose, not derived from the tenant's abilities. All default tools start on; approvalPreference is pinned to always; c.ai_behavior grants no permission. No client-facing editor for the Growth Partner's Allowed actions was found (employee screen resolves only the six retained slugs).
- **Missing dependencies:** none.
- **Remaining work:** Add a post-submit 'Review what your partner may do' step listing real abilities from employeeAbilities with plain-language effects and toggles that write a new config version (disabledTools) through createConfigVersion, audit the acknowledgement, replace the static permission prose with real state, add toggle->dispatch refusal->audit tests; check whether an admin-side editor already exists first.
- **Verification evidence:** Own: read the review model, capability-access derivation and abilities module. Recorded (docs): `implementation-status.md` describes the Control Center capability display and the `crm.request_update` switch (line 28); no doc claims an onboarding permission review.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The owner explicitly reviews and can change the partner's allowed actions before launch; the choice is versioned, audited and enforced by dispatch; review text is generated from saved state.

<a id="gp-onboard-10"></a>
### GP-ONBOARD-10 — Configure optional Work Board schedules during setup

- **Requirement:** Configure optional Work Board schedules during setup (directive §16)
- **Current implementation status:** NOT STARTED
- **Priority:** P2  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/schedules.ts:163`, `src/server/workforce/work-board.ts`, `src/components/growth-partner/control-center.tsx:90`
- **Test coverage:** `tests/workforce-schedules.test.ts` (schedule persistence, disabled default, operator switch, Growth Partner execution, cron tick); nothing for onboarding.
- **Real or simulated behavior:** The onboarding step does not exist. The schedule service itself (separate domain) is real and tested: schedules save disabled by default and run only when the operator switch and scheduler are on; the Control Center only links to /work and /work/calendar.
- **Missing dependencies:** the production scheduler switch (`SCHEDULER_ENABLED`, `CRON_SECRET`) is off and founder-owned; schedules can be configured but will not run until it is on.
- **Remaining work:** Add an optional, skippable post-submit step offering 2-3 suggested review schedules from goals and hours that call saveSchedule disabled behind a preview/confirm, with an honest 'not running yet' state; add DB-backed tests and extend the acceptance test.
- **Verification evidence:** Own: grep across `src/components/onboarding`, `definitions.ts`, `engine.ts` found no schedule step. Recorded (docs): `implementation-status.md` covers chat-driven schedule updates and the Work Board, not onboarding.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The owner can accept or skip suggested schedules during setup; accepted ones appear on the Work Board exactly as chosen with an honest running/not-running state.

<a id="gp-onboard-11"></a>
### GP-ONBOARD-11 — Open the permanent Growth Partner conversation

- **Requirement:** Open the permanent Growth Partner conversation (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/service.ts:1488`, `src/server/ai-growth-partner/service.ts:1234`, `src/app/(portal)/growth-partner/conversation/page.tsx`, `src/components/growth-partner/permanent-conversation.tsx`, `src/components/setup/onboarded-banner.tsx`, `src/components/onboarding/adaptive-onboarding.tsx:392`, `supabase/migrations/0121_ai_growth_partner_conversation.sql`
- **Test coverage:** `tests/ai-growth-partner-conversation.test.ts` (one shared tenant thread, RLS, retention; inserts the thread directly), `tests/ai-growth-partner-fixture-acceptance.test.ts` (conversation provisioned by the health-check path; research/CRM/report in one thread using a fixture model), `tests/growth-partner-permanent-conversation-ui.test.tsx`.
- **Real or simulated behavior:** The one thread is created by a passing health check and read through the real service on PGlite; model turns use fixtures/mocks. After approval the owner lands on /setup?onboarded=1 whose banner links to the Control Center, not the conversation.
- **Missing dependencies:** a real provisioned runtime and a real model (GP-ONBOARD-06) to prove a real reply.
- **Remaining work:** When the runtime becomes configured send an in-app notification and a prominent 'Open your AI Growth Partner conversation' action to /growth-partner/conversation; add a safe waiting state; add a test chain runHealthCheck -> conversation -> owner and member can open it -> second tenant cannot.
- **Verification evidence:** Own: read creation SQL, page and banner. Recorded (docs): fixture acceptance and hosted runs with a mock model.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The first time the partner is ready the owner is taken to or notified of the one permanent conversation and can exchange a message with a real runtime; only that tenant's members can read it.

<a id="gp-onboard-12"></a>
### GP-ONBOARD-12 — Clear readiness checklist for a Growth-Partner-only tenant

- **Requirement:** Clear readiness checklist for a Growth-Partner-only tenant (directive §16)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/launch-readiness.ts:1064`, `src/lib/launch-readiness.ts:1087`, `src/lib/launch-readiness.ts:1186`, `src/server/setup/launch-readiness.ts:555`, `src/server/setup/launch-intents.ts`, `src/server/setup/launch-sweep.ts`, `src/server/setup/launch-watch.ts`, `src/server/setup/core.ts:77`, `src/app/(portal)/setup/page.tsx`, `src/components/setup/launch-readiness-panel.tsx`
- **Test coverage:** `tests/launch-readiness.test.ts:66` (one pure test for the unified partner), `tests/setup-center.test.ts:173` (neutral wording until runtime checks pass), `tests/client-state.test.ts`. `tests/launch-readiness-server.test.ts`, `tests/launch-sweep.test.ts`, `tests/launch-watch.test.ts` and `tests/client-launch-acceptance.test.ts` never use a Growth Partner (zero matches) and exercise six-role tenants.
- **Real or simulated behavior:** Real judge over workspace rows, but for a Growth Partner it checks only Brain active, conversation present and runtime health; the per-role functional final checks and sweep use AGENT_ROLE_KEYS and ignore growth_partner, so 100% needs no capability check. Only one pure unit test covers the partner path; server-side readiness, sweep, watch and the launch acceptance suite have no Growth Partner case.
- **Missing dependencies:** none to fix; real runtime for a live pass.
- **Remaining work:** Add a Growth-Partner-only end-to-end launch test beside client-launch-acceptance; add read-only per-capability functional checks (reuse the deterministic reviews in src/server/workforce/*-review.ts) run for the partner; add checklist items for Brain draft awaiting approval, permissions reviewed, calendar verified and first action; make sweep, watch and notifications work for partner-only tenants and test them.
- **Verification evidence:** Own: read the judge and the facts reader; confirmed by grep that no server-side readiness test builds a Growth Partner tenant. Recorded (docs): the 2026-11-02 milestone doc claims "100% Ready to Launch only after every applicable technical and functional check passes"; that was proven only for six-role tenants.
  - *Skeptic review: Row marks testsExerciseRealPath=false yet evidenceClass app-functional. The Growth Partner readiness path has one pure-function test and no server-side/DB test; acceptance suites build tenants with createOrg and six roles.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For a Growth-Partner-only tenant the checklist reaches 100% only after real functional checks pass, each item names owner and next action, and DB-level tests cover the path.

<a id="gp-onboard-13"></a>
### GP-ONBOARD-13 — Guide the first meaningful action

- **Requirement:** Guide the first meaningful action (directive §16)
- **Current implementation status:** NOT STARTED
- **Priority:** P2  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/lib/aqi/tutorials.ts:243`, `src/components/growth-partner/permanent-conversation.tsx:353`, `src/components/setup/onboarded-banner.tsx`
- **Test coverage:** `tests/aqi-tutorial-engine.test.ts`, `tests/aqi-onboarding-tips.test.ts` cover the generic tour only.
- **Real or simulated behavior:** No code picks or presents a first action from the tenant's own data. Only the generic AQi welcome tour and a placeholder in the conversation composer exist.
- **Missing dependencies:** none for a deterministic first-action selector; a live partner for the action to complete for real.
- **Remaining work:** Add a pure first-action selector (for example src/lib/onboarding/first-action.ts) driven by launch facts and Brain state, surface it in the ready banner and as suggested prompts in the permanent conversation, record completion, and test it.
- **Verification evidence:** Own: grepped components and server for first-action logic; none. Recorded (docs): none claims it.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** When the partner is ready the owner sees exactly one recommended first action derived from workspace state; completing it is recorded and the prompt disappears.

<a id="gp-onboard-14"></a>
### GP-ONBOARD-14 — Retries never create duplicate Growth Partners or workspaces (idempotency)

- **Requirement:** Retries never create duplicate Growth Partners or workspaces (idempotency) (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** src/server/workforce/service.ts, src/server/ai-growth-partner/service.ts, src/server/workforce/provisioning.ts, src/server/setup/jobs.ts, src/server/purchase-intents/service.ts, src/server/purchase-intents/checkout.ts, src/server/admin/tenants.ts, supabase/migrations/0082_client_employee_provisioning.sql, supabase/migrations/0141_organization_creation_key.sql and its rollback
- **Test coverage:** tests/tenant-creation-idempotency.test.ts covers keyed workspace replay, lost in-transaction reservation rollback, purchase retry after the workspace commits, parallel purchase provisions, the transaction-lock source contract and the same-admin normalized double-submit guard. tests/purchase-checkout.test.ts overlaps automatic and manual provisioning for one provider-paid purchase. tests/client-employee-provisioning.test.ts covers failed-job requeue; tests/hermes-provisioner-route-acceptance.test.ts covers worker completion replay. PGlite serializes connections, so the parallel tests do not prove separate-backend lock contention.
- **Real or simulated behavior:** Purchase creation uses the server-keyed organizations.creation_key and a transaction-scoped advisory lock; purchase_intents.client_org_id is reserved in the same transaction as organization, Growth Partner, runtime and invitation creation. A payment failure after commit retries that same workspace. A direct admin double-submit locks by hashed admin id, normalized company name and owner email, then refuses a matching creation from the prior 120 seconds. Automatic and manual purchase provisioning share provisionPurchaseIntent. The organization creation key migration 0141 was already present from A-06; this follow-up adds no migration.
- **Missing dependencies:** none.
- **Remaining work:** A separate-backend PostgreSQL concurrency run would provide additional evidence for advisory-lock contention; the local PGlite tests explicitly cannot establish that. Full-suite and CI verification for this tree are also outstanding.
- **Verification evidence:** On 2026-11-16, tests/tenant-creation-idempotency.test.ts, tests/purchase-intents.test.ts and tests/purchase-checkout.test.ts passed: 3 files, 43 tests. Targeted ESLint and npx tsc --noEmit -p tsconfig.clean.json passed. No hosted database, provider or live payment was used.
  - *Skeptic review: Claim holds; extra nuance on where the guarantee lives.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Any retry, replay or concurrent duplicate of purchase provisioning, tenant creation, onboarding submit, health check or worker completion results in exactly one workspace, partner, runtime row, profile, conversation and invitation email, proven by tests including a crash-between-steps case.

<a id="gp-onboard-15"></a>
### GP-ONBOARD-15 — A new workspace has no access to another tenant's data (isolation)

- **Requirement:** A new workspace has no access to another tenant's data (isolation) (directive §16)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0120_ai_growth_partner_foundation.sql`, `supabase/migrations/0121_ai_growth_partner_conversation.sql`, `src/server/onboarding/service.ts`, `src/server/ai-growth-partner/service.ts`, `src/server/workforce/hermes-provisioner.ts:244`, `src/server/tenancy/context.ts`
- **Test coverage:** `tests/ai-growth-partner-foundation.test.ts:254,290` (tenant FKs, app-role RLS), `tests/onboarding-v2.test.ts:325` (another tenant sees nothing), `tests/client-onboarding-acceptance.test.ts` (compiled instructions never contain the other tenant's name), `tests/setup-center.test.ts:399-437`, `tests/ai-growth-partner-unified-context-e2e.test.ts`, `tests/hermes-provisioner-route-acceptance.test.ts` (SOUL of tenant A never contains B; wrong-profile-key and cross-tenant denial), `tests/demo-isolation.test.ts`. Recorded CI (docs) of two tenants on one real gateway: `tests/hermes-client-business-mcp-pinned-runtime.test.ts` / hosted run #91 (not re-run here).
- **Real or simulated behavior:** Real RLS and tenant-keyed queries on PGlite with Supabase schema emulation; per-tenant profile names, keys and credentials. Real-gateway two-tenant isolation exists only as recorded CI evidence in docs (hosted run #91), not re-run. Hosted-database RLS for migrations 0120-0135 has never been exercised.
- **Missing dependencies:** hosted-database verification (needs migrations applied, GP-ONBOARD-06); production Supabase RLS differs from PGlite emulation and was never exercised for these tables.
- **Remaining work:** Extend client-onboarding-acceptance with an app-role (withUser) tenant B that cannot read or write tenant A's onboarding answers, Brain versions, partner row, conversation, config versions or provisioning jobs, including a third workspace created after A is onboarded; run the preflight isolation checks against the hosted DB after approval. | Skeptic adds: Correct the evidence text: onboarding_answers read is app.can_access_org (any member), writes need workspace.manage_profile, not owner-only. Onboarding answers and Brain/partner tables already have real app-role RLS tests; the missing cross-tenant app-role checks are conversation, config versions and provisioning jobs.
- **Verification evidence:** Own: read RLS policies in 0120/0121 and the tenant-scoped queries; no cross-tenant leak found in the onboarding code. Recorded (docs): isolation proofs on a real pinned gateway with synthetic tenants (hosted run #91).
  - *Skeptic review: Isolation evidence is real and slightly stronger than described for answers/Brain, but the policy description 'owner-only' is wrong and the remaining-work list over-includes already-tested tables.*
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Automated tests with the application database role prove a new tenant's access to every Growth Partner and onboarding table is limited to its own org, and the same holds on the hosted database after migration.

<a id="gp-onboard-16"></a>
### GP-ONBOARD-16 — Journey test coverage: complete fictional tenant without manual database intervention; existing onboarding tests expanded not replaced

- **Requirement:** Journey test coverage: complete fictional tenant without manual database intervention; existing onboarding tests expanded not replaced (directive §16)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `tests/client-onboarding-acceptance.test.ts`, `tests/hermes-provisioner-route-acceptance.test.ts`, `tests/ai-growth-partner-fixture-acceptance.test.ts`, `tests/client-launch-acceptance.test.ts`, `tests/client-provisioning-chain-acceptance.test.ts`, `tests/client-employee-provisioning.test.ts`, `tests/launch-readiness-server.test.ts`, `tests/launch-sweep.test.ts`, `tests/launch-watch.test.ts`, `scripts/onboarding-browser-qa.mjs`, `.github/workflows/hermes-inference-worker.yml`, `src/app/dev/onboarding-preview/preview-inner.tsx`, `src/app/(setup)/layout.tsx`
- **Test coverage:** Six filtered Growth Partner-only cases are retained beside legacy cases in `client-employee-provisioning`, `client-launch-acceptance`, `client-provisioning-chain-acceptance`, `launch-readiness-server`, `launch-sweep` and `launch-watch`. The separate `tests/growth-partner-onboarding-journey.test.ts` adds two synthetic tenants across purchase, invitation, onboarding, provisioner callbacks, health, readiness and conversation; it is untracked and intentionally kept outside the branch. The browser harness exercises the questionnaire in its Growth Partner-only preview fixture.
- **Real or simulated behavior:** Journey services use PGlite; worker callbacks and browser-preview persistence/model suggestions are simulated. The Playwright Chromium check covers the local preview, not a signed-in app server or a hosted tenant. The branch-scoped CI job is configured but has not run for this candidate.
- **Missing dependencies:** none for the repo tests.
- **Remaining work:** The requested full journey file remains a separate untracked artifact and is not part of this branch; keep it separate unless the owner changes that instruction. Run the configured CI workflow on the candidate branch to record CI evidence. Production, provider, model and hosted-database checks remain outside this synthetic test item.
- **Verification evidence:** Six filtered Partner-only test cases passed across six files (six passed; 88 unrelated tests skipped by the filter). The separate two-tenant journey test passed one test locally and remains untracked. `npm run onboarding:qa` passed 66 local Chromium checks, including the Partner-only review and 320–1440px light/dark layouts. TypeScript, script typecheck, targeted ESLint and `git diff --check` passed. No full suite or current-HEAD CI run was performed.
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One automated journey test per fictional tenant passes with no manual DB writes; six-role and Growth Partner variants of the launch/provisioning suites both pass; a browser check of the questionnaire for a Growth-Partner-only tenant runs in CI.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "CI evidence for the audited branch: full-suite/typecheck/lint workflow does not trigger on claude/ai-growth-partner-completion", "directiveRef": "§16 acceptance (existing onboarding tests expanded; journey without manual DB intervention)", "priority": "P1", "status": "IMPLEMENTED — NOT YET VERIFIED", "remainingWork": "The branch is now in hermes-inference-worker.yml push and pull-request scope, and the Growth Partner-only browser check is a CI job. Run CI on this candidate to record results; the current working tree has not been pushed or run remotely."}
- {"title": "Owner review of Business Brain v1 before activation, and honest staff notification", "directiveRef": "§16 (generate Business Brain; Business Brain facts remain correct and versioned)", "priority": "P2", "status": "PARTIAL", "remainingWork": "v1 activates at submit with no owner Brain review (ai-growth-partner/service.ts:858-866); agency notification claims 'ready for review' unconditionally (onboarding/service.ts:721). Add a review/approve step or label v1 as auto-activated from approved answers, and make the notification reflect reused/draft/active outcome."}
- {"title": "Failed owner invitation email after tenant commit is not a retryable item on the purchase auto-provision path", "directiveRef": "§16 (accept invitation)", "priority": "P2", "status": "PARTIAL", "remainingWork": "createClientTenant returns emailDelivery after commit (admin/tenants.ts:186-190) but provisionPurchaseIntent only stores it in the result; verify a failed send surfaces on the purchase/timeline with a resend action, and test it. Not deeply traced."}
