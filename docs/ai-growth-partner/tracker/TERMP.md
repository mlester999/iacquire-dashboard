# TERMP — Public and commercial terminology plus unsupported claims

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). The audit below records the historical baseline at commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`; W1-06 follow-up evidence is recorded on the completed rows.

**Historical domain summary (read-only audit of branch claude/ai-growth-partner-completion, HEAD 6e4a4b7e; nothing was run, only read).**

- There is NO marketing homepage in this repo: `src/app/page.tsx` is an auth redirect. The public surfaces are `/demo` (request page), `/demo/why`, the demo room, `/get-started`, the login showcase, the buyer `/purchase/[token]` and `/pay/[token]` pages, the widget script, emails, and the read-only feed `/api/public/services` that an external marketing site consumes.
- Code-resident public copy has been converted well: landing, demo room, purchase page, login showcase, help articles, AQi TypeScript tutorials and the purchase invitation email all speak of one AI Growth Partner with six "capability areas". Tests (demo-pages, demo-showroom, demo-prompt, purchase-room) exercise real rendering against PGlite, but only assert a few strings.
- The biggest gap is copy that lives in the DATABASE and was never rewritten: the service catalog / Managed Maintenance plan (migration 0015, 8 lines), AQi knowledge entries, suggested question and contextual tip (0047, 0061), and Setup Center default task copy (0008, 0056). These still say "AI employees", "AI Workforce", "AI Appointment Setter", "AI team". The demo pricing view and the demo AQi prompt read the plan's `included` list straight from that catalog row (`getPublicMaintenancePlan`, `src/server/catalog/service.ts:352`), so the public demo can show legacy wording; tests only use `plan.included = null`.
- ~25 customer-visible runtime strings (approval reasons, notifications, chat failure notices, export README, launch-control labels) still say "AI employee", "AI team" or "Appointment Setter". No test pins them and no test forbids them.
- `email-render.ts:61,490` still sends the demo email under the headline "See the AI team in action".
- README is stale: "dedicated six-person AI workforce", and a status block saying no live Supabase is connected.
- Unsupported claims: the influencer-platform targeting (Instagram/TikTok/YouTube/LinkedIn/X) has no source adapter (only OpenStreetMap + exact-allowlisted company sites exist, with no live acceptance); the demo FAQ promises approval for everything reaching a customer although `automationGate` allows `autonomous` mode and programs/reminders send under owner policy; several channel, 24/7 and "never paste API keys" statements outrun provider-verified evidence (provider matrix: fixtures only).
- Pricing facts ($1,499 setup, optional $299/month, usage separate) are consistent everywhere, but are hard-coded in about 10 places and the demo says "starting at" while purchase links freeze $1,499.
- No automated guard prevents legacy vocabulary or unsupported claims returning to customer-facing surfaces.
- Per the brief, no row is labelled COMPLETE_VERIFIED. The directive text was not supplied; `directiveRef` values are mapped by topic (§4 items 7, 8, 15-19, 22; §22 marketing half) and are approximate.

---

<a id="gp-termp-01"></a>
### GP-TERMP-01 — In-repo public landing, request page, Why page, login/get-started showcase

- **Requirement:** In-repo public landing, request page, Why page, login/get-started showcase (directive §4 item 7)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/demo/landing.tsx`, `src/components/demo/landing-sections.tsx`, `src/components/demo/showroom/why-content.tsx`, `src/lib/demo/showroom/content.ts`, `src/app/demo/page.tsx`, `src/app/demo/why/page.tsx`, `src/components/auth/showcase.tsx`, `src/app/(auth)/get-started/page.tsx`, `src/app/layout.tsx`, `src/app/page.tsx`
- **Test coverage:** `tests/demo-pages.test.tsx` (DB-backed render; asserts "Explore six capability areas", no "Zeng", no employee-role form field), `tests/demo-showroom.test.tsx` (partner copy, JOURNEY blurb exact string), `tests/demo-mobile-layout.test.tsx`, `tests/demo-outcomes.test.ts`. They prove rendering and a handful of strings; they do not scan the whole page for legacy vocabulary, and nothing covers `/get-started` or the login showcase.
- **Real or simulated behavior:** Real server-rendered pages reading the real demo service from the DB; static copy labelled sample. No marketing homepage exists in this repo (src/app/page.tsx is an auth redirect).
- **Missing dependencies:** none for code. The real public marketing site is external to this repo (founder decision).
- **Remaining work:** Replace hard-coded $1,499 in get-started/page.tsx:15 with SETUP_FEE_USD; add render tests for /get-started and auth showcase; record whether the external marketing site is in scope; include these pages in the terminology guard (GP-TERMP-14).
- **Verification evidence:** I read every file above. Prior recorded runs (docs/implementation-status.md, 892 files passed on codex branch) are not my observation; I did not run tests.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** All public pages name only AI Growth Partner/capability areas; a guard test scans rendered HTML of /demo, /demo/why, /demo/room views, /get-started, /login; prices come from billing constants.

<a id="gp-termp-02"></a>
### GP-TERMP-02 — Demo room views, journey, FAQ and AQi demo guide grounding

- **Requirement:** Demo room views, journey, FAQ and AQi demo guide grounding (directive §4 items 7, 8; §22 marketing)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/components/demo/showroom/views/overview.tsx`, `src/components/demo/showroom/views/workforce.tsx`, `src/components/demo/showroom/views/summary.tsx`, `src/components/demo/showroom/views/inbox.tsx`, `src/components/demo/showroom/views/pricing.tsx`, `src/lib/demo/showroom/content.ts`, `src/lib/demo/tour.ts`, `src/server/demo/prompt.ts`, `src/server/demo/generator.ts`, `src/app/demo/room/page.tsx`
- **Test coverage:** `tests/demo-showroom.test.tsx`, `demo-pricing-view.test.tsx` (uses `plan: { included: null }` line 42, so the DB-sourced list is never rendered), `demo-prompt.test.ts` (asserts no "AI Lead Hunter" in grounding), `demo-interactive.test.tsx`, `demo-pages.test.tsx` (Zeng check across views at ~454), `demo-reply-check.test.ts`.
- **Real or simulated behavior:** Sample data and scripted views, labelled Sample. Demo AQi chat uses a real LLM only when configured; tests inject generators. Pricing view and prompt facts read the plan list from the DB catalog, but tests pass plan.included = null.
- **Missing dependencies:** none for the copy fixes.
- **Remaining work:** Fix catalog source (GP-TERMP-04) and test pricing view and prompt against the real seeded plan; reword FAQ content.ts:208 absolute approval claim; qualify 'every channel' lines (summary.tsx:16, inbox.tsx:45) with 'channels you connect'; confirm 'six capability areas' is acceptable public language.
- **Verification evidence:** read views and content; grep for legacy vocabulary in `src/components/demo` and `src/lib/demo` returned zero hits.
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Demo views, FAQ and AQi demo grounding from the real DB catalog contain no legacy terms; capability sentences are conditional on connection/approval or backed by built code; tests render with the real seeded row.

<a id="gp-termp-03"></a>
### GP-TERMP-03 — Pricing facts ($1,499 / $299 / usage separate) and buyer purchase, payment and proposal pages

- **Requirement:** Pricing facts ($1,499 / $299 / usage separate) and buyer purchase, payment and proposal pages (directive §4 item 8; §22)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/billing.ts`, `src/lib/purchase-intents/rules.ts`, `src/components/purchase-intents/public-purchase.tsx`, `src/components/purchase-intents/team-orbit.tsx`, `src/lib/purchase-intents/delivery.ts`, `src/lib/demo/showroom/confirm-copy.ts`, `src/components/demo/showroom/views/pricing.tsx`, `src/app/(auth)/get-started/page.tsx`, `src/server/help/articles.ts`, `src/server/help/service.ts`, `src/lib/projects.ts`, `src/lib/internal-business-profile.ts`, `src/components/purchase-intents/create-form.tsx`
- **Test coverage:** `tests/purchase-room.test.tsx` (asserts "One AI Growth Partner with six connected capabilities" line 185), `purchase-intents-rules.test.ts`, `purchase-invitation-email.test.ts`, `purchase-intents.test.ts`, `demo-pricing-view.test.tsx` (prices from billing). They do not prove that every hard-coded literal agrees.
- **Real or simulated behavior:** Real DB-backed pages; prices from billing.ts and frozen per purchase. Payment providers verified with fixtures/sandbox only per the provider matrix.
- **Missing dependencies:** founder confirmation only if the price wording changes.
- **Remaining work:** Replace hard-coded price literals (about 10 places) with billing constants or add a consistency test; decide between 'Starting at $1,499' (demo, BUY_CONFIRM) and the fixed frozen $1,499; keep usage-separate wording identical across surfaces. | Skeptic adds: Add the admin literals src/components/admin/client-detail.tsx:1118,1197 (149900 fallback) and src/components/admin/service-catalog-admin.tsx:221 to the price-consistency test allow-list or move them to billing.ts.
- **Verification evidence:** read all listed files; all literals I found equal $1,499 / $299.
  - *Skeptic review: Confirms the row. Two additional hard-coded price literals exist in admin screens that the audit did not list; all equal $1,499 or $299.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One source per price; test fails if any customer-facing literal differs; starting-at decision recorded.

<a id="gp-termp-04"></a>
### GP-TERMP-04 — Service catalog, Managed Maintenance plan and public catalog feed (DB-resident legacy copy)

- **Requirement:** Service catalog, Managed Maintenance plan and public catalog feed (DB-resident legacy copy) (directive §4 items 7, 8; §22)
- **Current implementation status:** COMPLETE — VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0015_custom_projects.sql`, `supabase/migrations/0139_growth_partner_stored_copy.sql`, `supabase/rollbacks/0139_growth_partner_stored_copy.down.sql`, `scripts/rehearse-combined-migrations.mjs`, `src/server/catalog/service.ts`, `src/app/api/public/services/route.ts`, `src/lib/demo/showroom/content.ts`
- **Test coverage:** `tests/custom-projects.test.ts` exercises the signed-in marketplace and DB-backed public catalog projections; `tests/public-services-route.test.ts` calls the actual public `GET` handler and checks the returned feed; `tests/stored-copy-migration-0139.test.ts` checks untouched-row guards and rollback; `tests/crm-migrations.test.ts` and `tests/migration-prefixes.test.ts` cover nearby migration compatibility and numbering.
- **Real or simulated behavior:** Migration 0139 updates only exact seeded copies; it preserves customized text, keeps maintenance arrays in parity with the showroom fallback, and keeps core overlap notes out of the public projection. The tests and rehearsal use synthetic PGlite data but run the real service functions and public route handler. No hosted database was changed.
- **Missing dependencies:** applying migration 0139 to a hosted environment requires the owner's explicit approval. Real provider and model behavior is tracked separately.
- **Remaining work:** None for the local stored-copy implementation and verification. Hosted migration application remains approval-gated.
- **Verification evidence:** W1-06 follow-up at commit `dfe5d38b`: the final focused run passed **54 files / 532 tests**, including the route handler and all catalog/migration compatibility tests; `npm run typecheck`, targeted ESLint and `git diff --check` passed. Rehearsal sections B/C/D passed on fresh and populated paths through all 132 migration files, including the 0139 owned-row check, schema parity, reverse-order rollback and replay. The existing catalog touch trigger refreshes only `service_catalog.updated_at` while rollback restores every other prior field. No hosted migration or live provider/model call was used.
  - *Historical baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The public API and DB-backed catalog projections show the current Growth Partner maintenance copy, signed-in package notes no longer describe legacy role employees, migrated rows preserve custom edits, fresh and populated upgrades match, and guarded rollback restores the original copy.

<a id="gp-termp-05"></a>
### GP-TERMP-05 — Transactional email templates

- **Requirement:** Transactional email templates (directive §4 items 15-19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/email-render.ts`, `src/server/demo/public.ts`, `src/lib/purchase-intents/delivery.ts`, `src/server/email.ts`
- **Test coverage:** `tests/email-render.test.ts` (no legacy or partner assertions), `tests/demo-register.test.ts:90,244` (reads the outbox body only), `tests/purchase-invitation-email.test.ts`. Nothing asserts the demo email headline or preheader.
- **Real or simulated behavior:** Real renderer, captured to outbox locally; live delivery depends on email provider setup. demo_link headline 'See the AI team in action' (email-render.ts:61) and preheader (:490) still legacy; no test asserts them.
- **Missing dependencies:** none.
- **Remaining work:** Reword the two demo_link strings to AI Growth Partner; add email-render test for demo_link headline/preheader; scan all sendEmail texts in the guard test.
- **Verification evidence:** read email-render META and the two send paths.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** All templates pass forbidden-term scan; demo email headline test exists.

<a id="gp-termp-06"></a>
### GP-TERMP-06 — Notifications and runtime-generated customer-visible strings

- **Requirement:** Notifications and runtime-generated customer-visible strings (directive §4 items 15-19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/send.ts`, `src/server/messaging/web-chat-send.ts`, `src/server/messaging/ingest.ts`, `src/server/messaging/attention.ts`, `src/server/chat/service.ts`, `src/server/workforce/proactive-review.ts`, `src/server/workforce/provisioning.ts`, `src/server/offboarding/export.ts`, `src/server/setup/launch-readiness.ts`, `src/lib/missed-calls/state.ts`, `src/lib/permissions.ts`, `src/server/calendars/schedule.ts`, `src/server/messaging/inbox-list.ts`, `src/server/leads/research-job.ts`, `src/server/leads/research-contract.ts`, `src/lib/crm/blueprints/requirements.ts`, `src/lib/notification-groups.ts`
- **Test coverage:** W1-10 adds `tests/growth-partner-client-wording.test.ts` for partner-specific chat failures, approval messages, readiness and inbox notices; Work Board e2e wording assertions were updated. Export, automation-gate and CRM API strings remain without wording assertions.
- **Real or simulated behavior:** Real strings produced when the code path runs. The roughly 25-hit count is from the pre-W1-10 audit and has not been recalculated; W1-10 made the covered Growth Partner branches conditional and added focused assertions. Notification group labels are already converted.
- **Missing dependencies:** none.
- **Remaining work:** W1-10 fixed the Growth Partner branches for approval, chat, inbox and runtime-generated notices. Continue the sweep for offboarding export text, automation gates, CRM agent-tool errors and other builders; retain previous-role-profile wording only for retained-profile paths. | Skeptic adds: Recheck the stale `src/server/demo/admin.ts` comment during the remaining sweep.
- **Verification evidence:** Seven focused files passed (119 tests), including the new partner wording tests. Typecheck, targeted ESLint and `git diff --check` passed. The broad source scan remains for W1-12 and later waves.
  - *Skeptic review at baseline: Confirms the row and reachability claim: ingest and inbox-context select growth_partner agents, so send.ts:487 and ingest.ts:253 fire for Growth Partner clients. W1-10 later added assertions for the revised partner branches.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No customer-facing string reachable by a Growth Partner workspace contains a forbidden term; retained-profile paths say previous role profile.

<a id="gp-termp-07"></a>
### GP-TERMP-07 — Setup Center and onboarding default template copy

- **Requirement:** Setup Center and onboarding default template copy (directive §4 items 15-19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0008_setup_center.sql`, `supabase/migrations/0013_setup_experience.sql`, `supabase/migrations/0056_crm_setup_native.sql`, `supabase/migrations/0124_growth_partner_setup_copy.sql`, `src/lib/setup-copy.ts`, `src/server/setup/templates.ts`, `src/server/setup/snapshots.ts`
- **Test coverage:** `tests/growth-partner-setup-wording.test.ts` checks the exact 0056 calendar sentence, the seeded 0008 company-info sentence, and the legacy completion notice translation. `tests/setup-center.test.ts` verifies legacy completion notification copy while confirming the stored snapshot remains unchanged; custom template rows are not covered.
- **Real or simulated behavior:** Real DB template rows plus presentation translation. W1-11 added the calendar mapping; the business-info mapping was already present and is now pinned by a regression test. No migration is needed for this presentation-only fix.
- **Missing dependencies:** none for the shim; full default-task and custom-template coverage remains.
- **Remaining work:** Test every default task as rendered for a Growth Partner workspace, plus custom task behavior; the broad forbidden-term scan is part of W1-12.
- **Verification evidence:** W1-11's six focused files passed (112 tests); typecheck, targeted ESLint and `git diff --check` passed. No stored setup snapshot was rewritten.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Growth Partner client Setup Center shows no legacy term for any default task.

<a id="gp-termp-08"></a>
### GP-TERMP-08 — Help center articles, help assistant prompt and tooltips

- **Requirement:** Help center articles, help assistant prompt and tooltips (directive §4 items 15-19)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/help/articles.ts`, `src/server/help/service.ts`, `src/lib/employee-field-guidance.ts`, `src/app/(portal)/appointments/page.tsx`, `src/app/(portal)/sales/page.tsx`
- **Test coverage:** no tests for article text; `tests/onboarding-status-wording.test.ts:29` only checks one title.
- **Real or simulated behavior:** Static articles plus optional LLM answer (needs LLM key, not verified live). Articles are mostly converted but stale: appointments/sales describe GoHighLevel-only views, integrations says clients never paste API keys. No article text tests.
- **Missing dependencies:** none.
- **Remaining work:** Rewrite appointments, sales, retention, integrations articles for native-first CRM/calendars; correct API-key sentence; add test for forbidden terms and link validity. | Skeptic adds: Treat the 'never need to paste API keys' sentence as CLAIM_CONDITIONAL: the client integrations page says the same, and the only counter-example is the optional Automation Studio connection form. Add a qualifier for Automation Studio connections. The native-first appointments and sales article rewrite is confirmed as needed.
- **Verification evidence:** read all 20+ articles.
  - *Skeptic review: Integrations page itself says no API keys to share; the contradiction exists only for the separate Automation Studio connections panel. The appointments article mismatch with the native-first redirect is confirmed.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Article tests pass and no statement contradicts the portal for native-first workspaces.

<a id="gp-termp-09"></a>
### GP-TERMP-09 — AQi guidance content in the database (knowledge entries, suggested question, tips)

- **Requirement:** AQi guidance content in the database (knowledge entries, suggested question, tips) (directive §4 items 15-19)
- **Current implementation status:** COMPLETE — VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0047_aqi_assistant.sql`, `supabase/migrations/0061_aqi_phase3_guidance.sql`, `supabase/migrations/0066_rename_workforce_routes.sql`, `supabase/migrations/0131_ai_growth_partner_aqi_guidance.sql`, `supabase/migrations/0139_growth_partner_stored_copy.sql`, `supabase/rollbacks/0139_growth_partner_stored_copy.down.sql`, `src/server/aqi/service.ts`, `src/lib/aqi/routes.ts`
- **Test coverage:** all `tests/aqi*.test.ts` files passed; `tests/stored-copy-migration-0139.test.ts` checks the stored copy, valid `AQI_ROUTES`, review metadata, actual retrieval and rollback; `tests/migration-0138-rollback.test.ts` protects the adjacent preview-data rollback.
- **Real or simulated behavior:** The migration preserves existing titles and IDs, archives obsolete role guidance, adds published AI Growth Partner, Business Brain, AI Work Board and Approvals entries with review metadata, fixes suggested routes and retains stable tip/tutorial identifiers. Tests call the real AQi retrieval service over a synthetic database; no model generation or production migration was performed.
- **Missing dependencies:** applying migration 0139 to a hosted environment requires the owner's explicit approval. Real-model answer quality remains an external acceptance item.
- **Remaining work:** None for local stored guidance and retrieval. Hosted migration application and real-model acceptance remain separate.
- **Verification evidence:** W1-06 follow-up at commit `dfe5d38b`: the final focused run passed **54 files / 532 tests**, including all 48 AQi test files. `npm run typecheck`, targeted ESLint and `git diff --check` passed. Rehearsal sections B/C/D passed on fresh and populated databases through all 132 migration files; rollback checks confirmed customized rows survive and only the 0139-owned IDs are removed. No live model or hosted database was used.
  - *Historical baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The real AQi retrieval function finds Growth Partner, conversation and Business Brain guidance, does not return archived employee guidance for those requests, every published route matches `AQI_ROUTES`, and guarded rollback preserves existing IDs and custom text.

<a id="gp-termp-10"></a>
### GP-TERMP-10 — README and documentation

- **Requirement:** README and documentation (directive §4 items 15-19)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `README.md`, `docs/onboarding.md`, `docs/billing-and-entitlements.md`, `docs/aqi.md`, `docs/custom-projects.md`, `docs/client-pilot-package-2026-11-01.md`, `docs/ai-growth-partner/implementation-status.md`
- **Test coverage:** none.
- **Real or simulated behavior:** Documentation only. README says 'dedicated six-person AI workforce' and that no live Supabase/Hermes is connected; route map and migration range stale. docs/ai-growth-partner/* is current; other engineering docs are AGENCY_INTERNAL_OK.
- **Missing dependencies:** none (the true production status should come from the founder/ops record).
- **Remaining work:** Rewrite README header, status and route map for the Growth Partner product; note retained legacy profiles; link current status docs; flag customer-facing docs for rewording.
- **Verification evidence:** read README and grep counts across docs.
- **Definition of done:** README accurately states the product and links the status docs.

<a id="gp-termp-11"></a>
### GP-TERMP-11 — Widget and website web chat copy

- **Requirement:** Widget and website web chat copy (directive §4 items 15-19)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/webchat/widget-script.ts`, `src/app/widget/chat.js/route.ts`, `src/server/webchat/generator.ts`, `src/server/webchat/reply-check.ts`, `src/server/webchat/amounts.ts`, `src/lib/webchat/identity.ts`, `src/server/messaging/web-chat-send.ts`
- **Test coverage:** `tests/webchat-widget.test.tsx`, `webchat-generator-checks.test.ts`, `webchat-ai.test.ts`, `webchat-service.test.ts`, `webchat-rules.test.ts`, `webchat-site.test.ts`: real DB/service paths for grounding and claim checks.
- **Real or simulated behavior:** Real widget and grounded generator with claim checks; tests stub the model; no live model verified. Visitor label is 'Assistant' without saying AI; staff approval reason says 'Your AI employee' (web-chat-send.ts:66).
- **Missing dependencies:** founder/legal decision on whether the visitor label should say "AI assistant".
- **Remaining work:** Decide AI-disclosure label; fix staff approval reason; add widget copy to guard test.
- **Verification evidence:** read widget-script, generator, rules, identity.
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Visitor-facing label discloses automation as decided; no legacy terms in staff-facing reasons.

<a id="gp-termp-12"></a>
### GP-TERMP-12 — Unsupported-claims register A: discovery sources, influencer platforms, channels and providers

- **Requirement:** Unsupported-claims register A: discovery sources, influencer platforms, channels and providers (directive §22 marketing)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/leads-targeting.ts`, `src/components/leads/leads-workspace.tsx`, `src/server/leads/research-contract.ts`, `src/server/leads/openstreetmap-source.ts`, `src/server/leads/company-website-source.ts`, `src/lib/ai-growth-partner.ts`, `src/components/demo/showroom/views/inbox.tsx`, `src/components/demo/showroom/views/summary.tsx`, `docs/ai-growth-partner/acquisition-source-research.md`, `docs/provider-readiness-matrix.md`
- **Test coverage:** `tests/ai-growth-partner-fixture-acceptance.test.ts` (synthetic discovery only); `tests/demo-claims.test.tsx` verifies the influencer UI is disabled with no adapters, the campaign/platform UI is backed by the adapter list, `ResearchSourceKey` contains no social sources, and connected-channel/approval copy stays qualified.
- **Real or simulated behavior:** ADVERTISED_BUT_NOT_BUILT: influencer platforms Instagram/TikTok/YouTube/LinkedIn/X have no source adapter (only OSM and exact-allowlisted company sites exist, synthetic acceptance only). CLAIM_CONDITIONAL: 'find relevant prospects' (live discovery disabled by default, not accepted live) and 'all channels in one inbox' (SMS/WhatsApp/email/voice never verified live; calendar sync polled ~10 min).
- **Missing dependencies:** live source acceptance and provider credentials are externally blocked; copy changes are not.
- **Remaining work:** Live source acceptance and provider credentials remain blocked; add a claims-to-evidence table to docs. UI copy now labels influencer research unavailable, preserves saved settings, and shows only platforms supplied by the adapter list. | Skeptic adds: The influencer platform selector is contradicted by the research prompt, which restricts sources to company websites, registries and public business pages and forbids scraping personal profiles. The current control is disabled and the regression test ties it to the adapter list; recheck if adapters are added.
- **Verification evidence:** read research-contract, leads-targeting, UI, docs. Local follow-up 2026-11-16: focused claims/showroom tests passed; adapter coverage is still zero and all discovery acceptance remains synthetic.
  - *Skeptic review: Firms up ADVERTISED_BUT_NOT_BUILT: the backend instruction and source policy both exclude social platforms while the UI offers Instagram, TikTok, YouTube, LinkedIn and X.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every advertised source or channel maps to a built adapter or carries 'not available yet'.

<a id="gp-termp-13"></a>
### GP-TERMP-13 — Unsupported-claims register B: approval/autonomy, 24/7, API keys, scheduler-dependent promises

- **Requirement:** Unsupported-claims register B: approval/autonomy, 24/7, API keys, scheduler-dependent promises (directive §22 marketing)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** yes
- **Source files:** `src/lib/demo/showroom/content.ts`, `src/server/automation/gate.ts`, `src/components/workforce/operating-controls.tsx`, `src/components/settings/messaging-settings.tsx`, `src/lib/onboarding/definitions.ts`, `src/server/help/articles.ts`, `docs/production-scheduler.md`, `src/server/demo/prompt.ts`
- **Test coverage:** `tests/demo-prompt.test.ts`, `demo-reply-check.test.ts`; automation gate tests exist elsewhere but no test links public wording to them.
- **Real or simulated behavior:** CLAIM_OVERSTATED: demo FAQ 'Anything that reaches a customer waits for the required approval' while automationGate allows autonomous mode and programs/reminders send under owner policy; 'AI can reply 24/7' and 'around the clock' before client runtime live acceptance; 'never need to paste API keys' while clients paste PandaDoc/payment keys. CLAIM_CONDITIONAL: Managed Maintenance monitoring and scheduled behaviours depend on the production scheduler recorded as not activated on 2026-10-20 (current state unconfirmed).
- **Missing dependencies:** founder decision on the exact approval promise; scheduler activation is externally gated.
- **Remaining work:** Public demo inbox, FAQ and capability copy now describe configured approval rules; the summary renders `OVERSIGHT_FOOTER`. Add a broader public-copy claim guard and list scheduler-dependent promises in an ops note; recheck channel, autonomy, 24/7 and API-key claims against their evidence. | Skeptic adds: Reclassify messaging-settings.tsx:148 and onboarding/definitions.ts:272-273 as CLAIM_CONDITIONAL (setting descriptions, low priority).
- **Verification evidence:** read gate.ts, operating-controls, onboarding definitions, docs. Local follow-ups on 2026-11-16 covered demo copy and grounding; focused demo claim/prompt tests passed. No full public-copy sweep or real-model answer check was run.
  - *Skeptic review: The 24/7 and around-the-clock lines describe what a switch or choice does, not a marketing promise. The approval promise is the default posture; autonomous mode needs the owner, explicit confirmation, a passed health check and activation. The API-key item is also weaker than stated (see GP-TERMP-08).*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No public sentence promises more than the gate and provider evidence support.

<a id="gp-termp-14"></a>
### GP-TERMP-14 — Terminology and unsupported-claims guard test

- **Requirement:** Terminology and unsupported-claims guard test (directive §4 items 7, 8, 15-19, 22)
- **Current implementation status:** COMPLETE — VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `tests/public-copy-guard.test.ts`, `tests/support/vocabulary-allowlist.ts`, public auth/demo/purchase/widget routes, `src/server/email-render.ts`, `src/server/help/articles.ts`, and the seeded public service/AQi/setup copy.
- **Test coverage:** The guard scans public route source and current copy from the public `listPublicServices()` projection, published AQi knowledge, enabled questions/tips, and default setup tasks after `currentSetupCopy`. It checks public help article text, renders the Auth showcase and demo-link email, verifies public prices use approved values from `src/lib/billing.ts`, and ratchets exceptions by file/row, term and exact count.
- **Real or simulated behavior:** Seeded catalog, AQi and setup rows are read from the local PGlite test database; the showcase and email renderer use real application components with synthetic inputs. No external provider was called.
- **Missing dependencies:** none for the guard.
- **Remaining work:** W1-13 owns five PENDING public-copy entries: the demo email's AI team headline/preheader, the hard-coded get-started and help/AQi setup fee literals, and the public Voice Receptionist live-availability/booking claim. The guard deliberately records these exact exceptions until the owning copy/catalog changes land; it does not claim the copy cleanup is complete.
- **Verification evidence:** W1-12 commit `7f6d33f9`: both guard files passed (7 tests total), scanning 16 public catalog services, 38 active AQi rows and 28 default setup tasks. Typecheck, targeted ESLint and `git diff --check` passed. The catalog test catches four unsupported Voice Receptionist booking claims in the current public projection.
- **Definition of done:** Guard passes on a clean tree and fails when a forbidden term is added to any covered surface.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Internal runtime vendor name 'Hermes' shown on client-visible portal surfaces and in AQi knowledge", "directiveRef": "§4 items 15-19", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "Replace 'Hermes' with 'AI runtime' (or equivalent) in client-visible text: components/analytics/analytics-view.tsx:286-287, components/growth-partner/memory-panel.tsx:129, components/crm/reports/sections.tsx:28 label, and the AQi Integrations knowledge entry (0047). Keep admin and retained-profile pages as AGENCY_INTERNAL_OK. Include in the terminology guard test."}
- {"title": "Unsupported-claims register does not cover the public catalog's custom-service copy (voice receptionist, website chat agent booking)", "directiveRef": "§22 marketing", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "Review the published services in supabase/migrations/0015_custom_projects.sql:689-699 (website chat agent 'books consultations', AI Voice Receptionist 'checks live availability and books') that appear in /api/public/services and the client marketplace. Voice is recorded as never verified live, so label these as quoted custom builds or availability coming_soon, and add the catalog to the claims-to-evidence table and guard test."}
