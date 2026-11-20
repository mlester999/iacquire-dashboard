# DEMO — Demo, sales funnel and public website

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Domain summary (read-only audit of worktree `gp-completion`, HEAD 6e4a4b7e; nothing was built, run or migrated by me; test runs cited below are from docs or from reading the test source, not from my own execution).

- What exists: a complete, DB-backed prospect-demo funnel under `src/server/demo` (request form, signed server-to-server registration door, single-use emailed link, session cookie, window/message accounting, daily platform caps, rate limits, expiry/retention jobs, erasure, agency "Prospects" screens, convert-to-client by a Super Admin only) and a full public showroom (`/demo`, `/demo/verify`, `/demo/room`, `/demo/why`) that presents ONE AI Growth Partner with six connected capabilities. Server tests run against embedded Postgres; UI tests are static-markup and jsdom.
- Real vs simulated: every showroom view (CRM pipeline, inbox + appointments, tasks and approvals, reports, Automation Studio builder) is a client-side drawing on invented data with explicit `SimTag` labels; "Approve" only flips React state. The ONLY real server activity a prospect can cause is: the verification/return email to their own address, a consultation/purchase request recorded for the agency team, and (when `aiEnabled` and a model is connected) a tool-less, workspace-less AQi chat answer from a real model call, checked by `reply-check.ts`. I verified in code that nothing in the demo can send a prospect communication to anyone else (only fetches are to `/api/public/demo/*`; `tests/demo-isolation.test.ts` and `tests/demo-showroom.test.tsx` enforce it).
- Real limits found in code (all are PROPOSALS per `src/lib/demo/settings.ts`, off by default): window 24 h (1-168), 10 AI messages (1-100), extension cap 72 h / 20 messages, 50 demo starts/day and 300 AI messages/day platform-wide, link valid 48 h, session 7 days, retention 90 days (unverified rows 7 days), 6 messages/min per prospect, 40/h per IP. The "interaction allowance" is on real-model AQi messages, not on scripted interactions; scripted tour interactions are unlimited and local.
- Biggest gaps: (1) the demo chat has not been evaluated with a real model under the current prompt (one real answer on 2026-10-27 predates the Growth Partner rewrite; the admin UI itself warns "No real language model has been tested"); (2) consent notice is draft wording for counsel, there is no privacy/terms page in this repo, and the retention scheduler was never started as of the last record; (3) the public marketing homepage/product pages/pricing site live in a separate repo (`/` here only redirects to `/login`), so they could not be audited; (4) tour progress is browser-local only, and `/get-started` hard-codes a price as a fixed "one-time $1,499".
- No row is labelled COMPLETE — VERIFIED: the orchestrator upgrades statuses after the baseline run.

<a id="gp-demo-01"></a>
### GP-DEMO-01 — Invitation-style entry: request form, emailed single-use link, signed marketing-site door

- **Requirement:** Invitation-style entry: request form, emailed single-use link, signed marketing-site door (directive §22 invitation-based entry)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/demo/public.ts`, `src/server/demo/http.ts`, `src/server/demo/registration.ts`, `src/server/demo/tokens.ts`, `src/server/demo/switch.ts`, `src/app/api/public/demo/[action]/route.ts`, `src/app/api/public/demo/register/route.ts`, `src/app/demo/page.tsx`, `src/app/demo/verify/page.tsx`, `src/components/demo/request-form.tsx`, `src/components/demo/verify-panel.tsx`, `src/lib/demo/email.ts`
- **Test coverage:** `tests/demo-register.test.ts` (embedded Postgres: one prospect per mailbox incl. plus-tags and Gmail dots, same answer whether or not the address is known, GET on the link never consumes it, only one of two simultaneous POSTs wins, 48 h link expiry, blocked domains, honeypot, no user/workspace/membership/invitation rows created), `tests/demo-http.test.ts`, `tests/demo-external-registration.test.ts` (signature, replay, skew, body bound), `tests/demo-registration-migration.test.ts`, `tests/demo-pages.test.tsx` (real page functions + static markup). They do NOT prove real email delivery, deliverability or a real browser flow.
- **Real or simulated behavior:** Real DB service and real sendEmail (template demo_link) to the prospect's own address; embedded Postgres in tests; one live production smoke recorded 2026-10-27 (docs), pre-Growth-Partner copy. Entry is request-then-confirm by emailed link, not admin-issued invitations; open to any work email while the demo is on.
- **Missing dependencies:** Production env switches `DEMO_ENABLED`, `DEMO_REGISTRATION_ENABLED`, signing secret on both projects, the separate landing repo, and the Super Admin `enabled` setting (all default off; last recorded production state: off). Note the code is "request then confirm by emailed link", NOT admin-issued invitations: any work-email holder can request while the demo is open (caps and blocked-domain list limit it). There is no invite-only/approval-queue/allow-list mode.
- **Remaining work:** Founder decision on open self-service vs invite-only mode (optional: demo_settings.invite_only + 'Invite a prospect' admin action in src/server/demo/admin.ts, settings.ts, src/lib/demo/settings.ts, new migration); re-run scripts/staging-demo-e2e.mjs --via-landing against the current build.
- **Verification evidence:** Prior recorded: docs 2026-10-27 isolated e2e 33/33 and one live smoke. Own observation: read all of the above source and test titles; did not execute.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: The directive mandates invitation-based entry. The implemented rule is open self-service: any visitor typing any work email (non-blocked domain) gets a link while the demo is on. The audit itself says there is no invite-only, approval-queue or allow-list mode, so IMPLEMENTED_UNVERIFIED overstates it. The mailbox-verification mechanics are solid (single-use hashed token, GET does not consume, unique token_hash, same answer for known/unknown address).*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Prospect can only enter via an emailed one-time link tied to a verified mailbox; chosen entry policy documented and tested; fresh isolated e2e and a controlled live smoke of the current build pass.

<a id="gp-demo-02"></a>
### GP-DEMO-02 — Limited demo access: window, daily caps, rate limits, extensions, expiry

- **Requirement:** Limited demo access: window, daily caps, rate limits, extensions, expiry (directive §22 limited demo access)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** no
- **Source files:** `src/lib/demo/rules.ts`, `src/lib/demo/settings.ts`, `src/server/demo/settings.ts`, `src/server/demo/usage.ts`, `src/server/demo/jobs.ts`, `src/server/ops/tick.ts`, `src/server/security/rate-limit.ts`, `src/server/env.ts`, `supabase/migrations/0100_demo_funnel.sql`
- **Test coverage:** `tests/demo-rules.test.ts` (window boundaries to the millisecond, 10 000-move state-machine invariant, extension caps, retention boundaries), `tests/demo-register.test.ts` (window exactly 24 h copied at confirm so later setting changes move nobody; day's places), `tests/demo-chat.test.ts` (daily budget, concurrency), `tests/demo-jobs.test.ts`, `tests/demo-retention.test.ts`, `tests/demo-migration.test.ts` (settings ranges equal DB check constraints), `tests/demo-admin.test.ts` (extend/expire/block). Real Postgres; not a production-scale or time-based soak.
- **Real or simulated behavior:** Real database accounting, clock-decided access. Real limits in code (all unconfirmed founder proposals, defaults off): window 24h (1-168), 10 AI messages (1-100), extension cap 72h and 20 messages, 50 starts/day and 300 AI messages/day platform-wide, link 48h, session 7 days, retention 90 days (unverified rows 7 days), 6 msgs/min per prospect, 40/h per IP, 6 starts/h per IP, 3 per mailbox/h.
- **Missing dependencies:** The numbers are unconfirmed founder proposals (comment at `src/lib/demo/settings.ts:4`). `demoExpiry`/`demoRetention` run only when the scheduler runs; as of 2026-10-27 the scheduler had never run (access stays correct because it is computed from timestamps, but recorded expiry and cleanup do not happen).
- **Remaining work:** Confirm or change the numbers in the settings row; get the two demo jobs (or the scheduler) approved and started and record a run; optionally add a per-prospect lifetime message ceiling covering return links.
- **Verification evidence:** Prior recorded: docs 2026-10-27 exact 86,400 s window and 11th message refused in isolation. Own: read rules, settings, usage, jobs and the test titles.
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Founder-confirmed limits stored; both jobs observed running in production with recorded results; limits shown to prospects equal limits enforced.

<a id="gp-demo-03"></a>
### GP-DEMO-03 — Interaction allowance enforcement (AQi message limit; tour interactions are unlimited and local)

- **Requirement:** Interaction allowance enforcement (AQi message limit; tour interactions are unlimited and local) (directive §22 limited scripted interaction allowance)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/demo/chat.ts`, `src/server/demo/generator.ts`, `src/lib/demo/rules.ts`, `src/components/demo/chat.tsx`, `src/components/demo/showroom/clock.tsx`
- **Test coverage:** `tests/demo-chat.test.ts` (exactly 10 of 20 simultaneous posts reserved; same `clientMessageId` 20 times counts once; replay returned after window end; empty/too-long/legacy-role refused; pending messages given back after 5 minutes; DB-level guard), `tests/demo-generator.test.ts` (exactly 10 of 12 simultaneous questions reach the model; message pressed 20 times asks model once), `tests/demo-interactive.test.tsx` (jsdom: key reuse, double press). Model is a stub in all of them.
- **Real or simulated behavior:** Real DB enforcement of a limit on AQi chat messages answered by a real model call (stubbed in tests). The directive says 'scripted' but the limit (default 10) is not on scripted interactions; those never touch the server. No scripted chat fallback exists: with no model or aiEnabled=false the chat is closed and only the tour remains.
- **Missing dependencies:** none for enforcement.
- **Remaining work:** Decide whether the directive wants a scripted (non-model) Q&A fallback for no-model or exhausted-budget cases (src/lib/demo/scripted-answers.ts used from generator.ts); otherwise record that the allowance is on AQi messages. | Skeptic adds: Add a per-prospect ceiling on given-back attempts (provider_failed, reply_blocked, input_blocked) and a test for it, or release the prospect's count but charge an attempt counter; currently a held reply returns the message to the prospect while the platform's daily unit stays spent.
- **Verification evidence:** Own: read reserve/release SQL and all test titles. Prior recorded: docs 2026-10-27 isolation proof of 10 accepted, 11th refused.
  - *Skeptic review: Enforcement of the 10-message allowance is real for answered messages, but a message whose reply is held back (or whose provider call fails) is given back to the prospect (count decremented) while the day's platform budget stays spent. A prospect who keeps provoking held replies therefore has no personal ceiling; only the 6/min per prospect, 40/h per IP and the 300/day shared budget stop them, so one visitor can drain the day's budget for everyone. The audit's 'no ceiling' note covered extensions and return links, not this path.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Allowance shown equals allowance enforced; behaviour with no model decided (closed vs scripted) and tested.

<a id="gp-demo-04"></a>
### GP-DEMO-04 — AQi demo chat grounding facts are far narrower than the showroom content and its suggested questions

- **Requirement:** AQi demo chat grounding facts are far narrower than the showroom content and its suggested questions (directive §22 demo must explain one Growth Partner, Business Brain, approvals)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/demo/prompt.ts`, `src/lib/demo/tour.ts`, `src/components/demo/showroom/workspace.tsx`, `src/lib/demo/showroom/content.ts`, `src/lib/demo/showroom/capabilities.ts`, `src/server/demo/reply-check.ts`
- **Test coverage:** `tests/demo-prompt.test.ts` now maps every AQi suggestion to required grounding facts and verifies those facts appear in `factLines`; `tests/demo-reply-check.test.ts` confirms answer filtering remains effective.
- **Real or simulated behavior:** The prompt includes approved implementation, plan, usage, FAQ, oversight, CRM, calendar, report, Business Brain and Work Board facts. Each AQi suggestion, including the two Workforce questions, has tested fact coverage. Reply checks still gate answers. No current-prompt real-model answer run has been made.
- **Missing dependencies:** None for local fact grounding. The approved real-model evaluation is separately tracked in GP-DEMO-05.
- **Remaining work:** Evaluate every suggestion with an approved real model; that acceptance is tracked separately in GP-DEMO-05 and is externally blocked until credentials/approval are available.
- **Verification evidence:** Local follow-up on 2026-11-16 passed eight focused files (189 tests), including the fact-to-suggestion regression, reply checks, rendered demo pages, mobile structure and type-scale floor. Targeted ESLint and TypeScript checks passed. The model-answer claim remains unverified.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every suggested question is answerable from grounding facts; a test enforces it; a real-model run shows grounded answers.

<a id="gp-demo-05"></a>
### GP-DEMO-05 — Real-model evaluation of the demo chat and its reply checks

- **Requirement:** Real-model evaluation of the demo chat and its reply checks (directive §22 no false capability claims in the demo)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `src/server/demo/generator.ts`, `src/server/demo/reply-check.ts`, `src/components/demo/admin/settings-form.tsx`
- **Test coverage:** `tests/demo-generator.test.ts`, `tests/demo-reply-check.test.ts`, `tests/demo-prompt.test.ts` (stub text only; they prove the nets catch seeded bad strings, not that a real model stays inside the rules).
- **Real or simulated behavior:** All tests use stubbed model text. One real model answer was recorded on 2026-10-27 with the pre-Growth-Partner prompt. The admin settings UI itself warns 'No real language model has been tested with this chat' and reply-check.ts says no real model has been evaluated.
- **Missing dependencies:** a connected LLM credential for the agency workspace, explicit approval for paid model spend, and an evaluation set.
- **Remaining work:** Write an adversarial eval set (tests/fixtures/demo-chat-eval.json) and runner (scripts/demo-chat-eval.mjs, capped by dailyMessageCap); run once on the configured model; record held-back rate, misses, cost; tune prompt and reply-check; remove the warning only after a passing run.
- **Verification evidence:** Prior recorded only (docs). Own: read the warning text and reply-check header.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Recorded real-model run on the current prompt with zero uncaught price/promise/action claims and a stored cost; evidence class real-model-verified.

<a id="gp-demo-06"></a>
### GP-DEMO-06 — Persistent demo progress (server state exists; tour progress is browser-local only)

- **Requirement:** Persistent demo progress (server state exists; tour progress is browser-local only) (directive §22 persistent demo progress)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/demo/showroom/journey.tsx`, `src/server/demo/public.ts`, `src/server/demo/chat.ts`, `src/lib/demo/room-types.ts`, `src/components/demo/showroom/views/crm.tsx`, `src/components/demo/showroom/views/inbox.tsx`
- **Test coverage:** `tests/demo-showroom.test.tsx` ("keeps the visitor's journey in this browser as step numbers only"), `tests/demo-register.test.ts` (room shows own window and conversation; same session survives), `tests/demo-pages.test.tsx`. Cross-device resume is not tested because it does not exist for tour progress.
- **Real or simulated behavior:** Server-persisted: window, messages used, transcript, consultation/purchase timestamps, 7-day session, timeline. Browser-only: 4-step tour progress in localStorage key iaq-demo-journey-v1. Not persisted: sample interactions (CRM moves, approvals, inbox approve) which are React state and reset on view change.
- **Missing dependencies:** A real-model evaluation requires approved model access and a recorded test procedure; no such run was authorized or performed in this local package.
- **Remaining work:** Persist seen steps server-side (migration: steps_seen column or step_seen event kind, extending 0100 event-kind check and src/lib/demo/events.ts; POST /api/public/demo/step in http.ts; hydrate JourneyProvider from getRoom); show progress in /admin/prospects/[id]; update notice details; keep localStorage as fallback.
- **Verification evidence:** Own: read journey.tsx and the view components.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A prospect returning on another device sees the same completed steps; Super Admin can see steps viewed; tested on Postgres.

<a id="gp-demo-07"></a>
### GP-DEMO-07 — Guided journey and capability tour: discovery, qualification, CRM updates, appointments, approvals, reporting, automation

- **Requirement:** Guided journey and capability tour: discovery, qualification, CRM updates, appointments, approvals, reporting, automation (directive §22 guided onboarding experience and required explanations)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/demo/showroom/workspace.tsx`, `src/components/demo/showroom/journey.tsx`, `src/components/demo/showroom/views/overview.tsx`, `src/components/demo/showroom/views/workforce.tsx`, `src/components/demo/showroom/views/crm.tsx`, `src/components/demo/showroom/views/inbox.tsx`, `src/components/demo/showroom/views/reports.tsx`, `src/components/demo/showroom/views/automation.tsx`, `src/components/demo/showroom/views/summary.tsx`, `src/lib/demo/showroom/content.ts`, `src/lib/demo/showroom/industry.ts`, `src/lib/ai-growth-partner.ts`
- **Test coverage:** `tests/demo-showroom.test.tsx` (six capabilities match `AI_GROWTH_PARTNER_CAPABILITIES`; copy rejects "one employee"; illustrative labels; no invented result/pressure tactics), `tests/demo-pages.test.tsx` (real `/demo/room` page against Postgres: headline, one partner, six capabilities, four steps, two requests), `tests/demo-interactive.test.tsx`, `tests/demo-pricing-view.test.tsx`, `tests/demo-mobile-layout.test.tsx`, `tests/demo-showroom-controls.test.tsx`. Static markup / jsdom and source-text guards only; layout and motion verified by `scripts/demo-responsive-qa.mjs` in a real Chromium per `docs/demo-showroom.md` (prior recorded, not re-observed).
- **Real or simulated behavior:** Entirely scripted client-side sample content on invented people and numbers, labelled Sample only / Simulated sample. No research, CRM write or send occurs. Advertised depth (lead discovery) has only been run on synthetic fixtures elsewhere; the demo labels itself illustrative.
- **Missing dependencies:** The advertised capability depth depends on other domains being real: lead discovery has so far only been run on synthetic fixtures with a mock Hermes (`docs/ai-growth-partner/acquisition-source-research.md` line 46). The demo labels itself illustrative and `SCOPE_NOTE` says tools/scope are set at implementation, so this is not a false claim today; re-check once Discovery/Work Board domains settle.
- **Remaining work:** Gaps split into GP-DEMO-08 and GP-DEMO-09; keep a regression test that capabilities named in the demo exist in the real product as other domains settle.
- **Verification evidence:** Own: read every view component and the tests' titles. Prior recorded: docs state 83/83 and 137-test demo suites passing (implementation-status.md lines 78, 266), not re-run by me.
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Prospect completes the four-step tour on phone and desktop and sees each named capability explained and labelled as sample; tests and real-browser QA pass on final copy.

<a id="gp-demo-08"></a>
### GP-DEMO-08 — AI Work Board in the demo

- **Requirement:** AI Work Board in the demo (directive §22 demo must explain the AI Work Board)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/components/demo/showroom/views/workforce.tsx`, `src/components/demo/showroom/views/work-board-sample.tsx`, `src/components/work/work-board-kanban.tsx`, `src/components/demo/showroom/workspace.tsx`
- **Test coverage:** `tests/demo-showroom.test.tsx` checks all six lane labels against the production board, sample-only/local-only behavior, capability references and the two AQi questions; `tests/demo-mobile-layout.test.tsx` checks the 375px phone layout uses a keyboard-accessible horizontal scroller and that Approve changes local state without a request.
- **Real or simulated behavior:** The Workforce view contains six invented, AI Growth Partner-attributed items using the production lane vocabulary, one for each capability, with sample evidence. Approve/Decline changes React state only and says that nothing was sent. It is a sample surface, not persisted work.
- **Missing dependencies:** AQi's answer must be grounded in its prompt facts; that contract is assigned to W1-04.
- **Remaining work:** Ground the exact Work Board question in AQi, run the browser network-capture check against the new controls, and record the desktop/mobile visual review.
- **Verification evidence:** Local 2026-11-16 focused demo tests passed; no full suite, CI or browser network capture was run.
- **Definition of done:** A sample AI Work Board is shown in the Growth Partner view, labelled sample-only, explained by AQi, tested, and mirrors the real board's vocabulary.

<a id="gp-demo-09"></a>
### GP-DEMO-09 — Business Brain explanation in the demo

- **Requirement:** Business Brain explanation in the demo (directive §22 demo must explain the Business Brain)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/components/demo/showroom/views/workforce.tsx`, `src/components/demo/showroom/views/business-brain-sample.tsx`, `src/lib/ai-growth-partner.ts`
- **Test coverage:** `tests/demo-showroom.test.tsx` checks the eleven sections against `BUSINESS_BRAIN_SECTIONS`, the four fact states, both explanatory rules, and the sample label; `tests/demo-mobile-layout.test.tsx` confirms the panel is reachable in the phone Workforce view.
- **Real or simulated behavior:** The sample panel shows invented values shaped by the selected industry scenario, lists the same eleven plain-language section titles as Control Center, and demonstrates verified, client-confirmed, draft-suggestion and unknown states. It does not read the visitor's Business Brain. AQi grounding remains pending.
- **Missing dependencies:** AQi's answer must be grounded in its prompt facts; that contract is assigned to W1-04.
- **Remaining work:** Ground the exact Business Brain question in AQi and record the desktop/mobile visual review.
- **Verification evidence:** Local 2026-11-16 focused demo tests passed; no full suite, CI or real-model answer check was run.
- **Definition of done:** Prospect can see what the Business Brain contains and how facts get confirmed, labelled as sample, and AQi answers the question from grounded facts.

<a id="gp-demo-10"></a>
### GP-DEMO-10 — Simulated vs real distinction, and no demo path can send real prospect communications

- **Requirement:** Simulated vs real distinction, and no demo path can send real prospect communications (directive §22 distinguish SIMULATED from real; no mock demo sends real prospect communications)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/demo/showroom/ui.tsx`, `src/lib/demo/outcomes.ts`, `src/components/demo/showroom/views/inbox.tsx`, `src/components/demo/showroom/views/summary.tsx`, `src/components/demo/showroom/views/business-brain-sample.tsx`, `src/components/demo/showroom/views/work-board-sample.tsx`, `src/components/demo/showroom/views/crm.tsx`, `src/components/demo/showroom/views/automation.tsx`, `src/server/demo/public.ts`, `src/server/demo/notify.ts`, `src/server/demo/prompt.ts`, `src/server/demo/reply-check.ts`, `src/lib/demo/showroom/capabilities.ts`
- **Test coverage:** `tests/demo-isolation.test.ts` (import allow-list read from source; one `createClientTenant` call site; no org/tenant tables named; chat has no model/tool call), `tests/demo-showroom.test.tsx` ("sends a visitor's details nowhere but the demo's own endpoints", every `target=_blank` has `rel=noopener noreferrer`, no storage beyond journey/rail), `tests/demo-register.test.ts` (no user/workspace/membership/invitation/sign-in rows after a whole journey), `tests/demo-generator.test.ts` ("never records anything against a workspace that is not the agency's own"). These are source-text and DB-row assertions; no real browser/network capture proves zero outbound traffic.
- **Real or simulated behavior:** Verified in code: all showroom sample interactions change React state only; the only fetches/forms are to /api/public/demo/*; stranger-reachable server files cannot import tenant, messaging, workforce, hermes, CRM, booking or auth modules; the only email sent is the link to the address the prospect typed; the chat has no tools and refuses action claims. The summary view now renders `OVERSIGHT_FOOTER`. Tests are source-text and DB-row assertions, not browser network capture.
- **Missing dependencies:** none.
- **Remaining work:** Add a real-browser network-capture check to scripts/demo-responsive-qa.mjs asserting zero requests outside /api/public/demo/* while pressing every sample control; extend it to both new panels. | Skeptic adds: Extend tests/demo-isolation.test.ts so the file that actually reaches the model (src/server/demo/generator.ts) and the other stranger-reachable files (http.ts, registration.ts, prompt.ts, reply-check.ts) are in OPEN_TO_STRANGERS or a second explicit allow-list (llm/client, llm/gate, llm/meter, aqi/config, catalog/service only). Reword the 'own address' claim: the link email goes to whatever address any anonymous visitor types, not a proven-own address.
- **Verification evidence:** Own: read all demo components, grep of fetch/actions, isolation test, outbound email code. Prior recorded: docs 2026-10-27 live smoke (only the link email was sent).
  - *Skeptic review: The 'nothing can reach tenant code' guarantee is enforced for less than the audit implies. The isolation test's allow-list omits generator.ts, which imports @/server/llm/*, @/server/aqi/config, @/server/llm/gate, @/server/llm/meter and @/server/catalog/service (the TENANT_CODE regex would flag llm). generator.ts's header says the isolation test 'reads its imports', which is false for that file. The only no-tool check on the chat is a regex on chat.ts, not generator.ts. Also the audit calls the email 'the prospect's own address'; nothing proves ownership before the send, so a third party can receive the demo_link email (bounded to 3/h per mailbox, 6/h per IP). Core claim (no prospect communication beyond the link email; all sample controls local state) still holds: only three literal fetch calls exist in src/components/demo.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Browser capture shows no outbound request beyond the demo API for any interaction; every simulated surface labelled; isolation tests green.

<a id="gp-demo-11"></a>
### GP-DEMO-11 — Consultation booking and purchase calls to action

- **Requirement:** Consultation booking and purchase calls to action (directive §22 consultation booking CTA)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** no
- **Source files:** `src/server/demo/public.ts`, `src/components/demo/showroom/cta.tsx`, `src/components/demo/showroom/context.tsx`, `src/lib/demo/showroom/confirm-copy.ts`, `src/lib/demo/outcomes.ts`, `src/lib/demo/settings.ts`, `src/server/demo/admin.ts`, `src/components/demo/admin/prospect-detail.tsx`
- **Test coverage:** `tests/demo-register.test.ts` ("records each once... tells the team once without a name or address", works after the window ended), `tests/demo-pages.test.tsx` ("calls the consultation button 'Request a consultation', and never 'Book', while no scheduling page is set"; real-https link only), `tests/demo-showroom.test.tsx` (confirmations promise no payment/subscription/workspace/booking), `tests/demo-interactive.test.tsx`.
- **Real or simulated behavior:** Real recording only: a confirmed press stores a timestamp, a timeline event and a team notification; it books nothing. Button says 'Book' only when demo_settings.consultation_url is a valid https link (default null), else 'Request a consultation'. Consultation path never exercised in production (no link configured on 2026-10-27).
- **Missing dependencies:** a real scheduling destination (founder choice: the agency's native `/book/<org>/<calendar>/<type>` page or an external scheduler) set in the Super Admin settings; as of the 2026-10-27 smoke no link was configured so the consultation path was never exercised in production.
- **Remaining work:** Set consultationUrl to the agency's native booking page and run one controlled press; optionally create an agency-CRM lead/task from recordCta (must be added deliberately to the isolation allow-list); keep the 'request, not booking' wording.
- **Verification evidence:** Prior recorded: docs 2026-10-27 (buy press recorded, consultation not exercised). Own: read code and tests.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** With a configured scheduling page a prospect can request, is offered the page, books a time, and the agency sees request and booking; wording never claims a booking before one exists.

<a id="gp-demo-12"></a>
### GP-DEMO-12 — Separation of Demo/Prospects from Clients, with explicit conversion

- **Requirement:** Separation of Demo/Prospects from Clients, with explicit conversion (directive §22 separation of Demo/Prospects from Clients)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/demo/access.ts`, `src/server/demo/admin.ts`, `src/server/demo/erase.ts`, `src/app/(admin)/admin/prospects/page.tsx`, `src/app/(admin)/admin/prospects/[id]/page.tsx`, `src/app/(admin)/admin/prospects/settings/page.tsx`, `src/components/demo/admin/prospect-actions.tsx`, `supabase/migrations/0100_demo_funnel.sql`
- **Test coverage:** tests/demo-admin.test.ts covers permissions, conversion claim races, erase, block and extend. The retry case creates the workspace, forces the final conversion mark to fail, advances beyond the 15-minute claim window, and proves the retry is refused with the existing workspace ID and exactly one organization. Real Postgres in the test fixture; not hosted RLS.
- **Real or simulated behavior:** Conversion refuses a second workspace when a prior demo.convert_unrecorded audit row or converted event exists, and tells the operator to link the existing organization. Both stale conversion and purchase comments now describe the implemented Growth Partner flow accurately.
- **Missing dependencies:** none.
- **Remaining work:** Optionally add a cross-domain test that conversion provisions the Growth Partner runtime. A failed conversion mark still requires an operator to link the named existing workspace; no automatic linking or migration was added.
- **Verification evidence:** The focused local run on 2026-11-16 passed tests/demo-admin.test.ts within 4 files and 42 tests. The retry test uses a synthetic Postgres fixture and an advanced test clock; no live conversion occurred.
  - *Skeptic review: Separation is genuinely enforced server-side (every admin function re-reads permissions from the DB; manage is Super-Admin-only; demo tables have RLS and revoked grants), so the status stands. But the 'conversion is explicit and idempotent' part of the definition of done is weaker than stated: the claim only blocks for 15 minutes. If the workspace is created and the follow-up update fails, the user is told 'Do not convert again', yet after 15 minutes the claim lapses and the prospect (still not 'converted') can be converted again, creating a second workspace. The race test covers only simultaneous presses.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No prospect can reach client data and no client user can see prospect data; conversion is explicit and idempotent; tests green on Linux CI.

<a id="gp-demo-13"></a>
### GP-DEMO-13 — "Why iAcquireOS?" explanation, pricing view and FAQs

- **Requirement:** "Why iAcquireOS?" explanation, pricing view and FAQs (directive §22 Why iAcquireOS explanation; pricing and FAQ copy)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/demo/why/page.tsx`, `src/components/demo/showroom/why-content.tsx`, `src/components/demo/showroom/views/why.tsx`, `src/components/demo/showroom/views/pricing.tsx`, `src/lib/demo/showroom/content.ts`, `src/app/demo/layout.tsx`, `src/lib/billing.ts`
- **Test coverage:** `tests/demo-showroom.test.tsx` ("/demo/why ... one heading 1, states the published prices", "records nothing: no form...", no pressure tactics, no "guaranteed"), `tests/demo-pricing-view.test.tsx`, `tests/demo-pages.test.tsx` (pricing view from the one place prices live).
- **Real or simulated behavior:** Static copy; prices come from src/lib/billing.ts (1499 once, 299/month optional) and the published catalog; comparisons are qualitative (no competitor prices, hours or percentages). /demo/why is public but the demo layout marks every /demo/* page noindex.
- **Missing dependencies:** founder confirmation of the "starting price" wording and plan content.
- **Remaining work:** Decide whether /demo/why should be indexable (per-page metadata override of the noindex in src/app/demo/layout.tsx); re-confirm claims against real behaviour in other domains: approvals recorded with outcome and time, duplicate check, managed media storage within fair use. | Skeptic adds: Correct the FAQ answer 'Will the AI Growth Partner message my customers on its own? No. Anything that reaches a customer waits for the required approval' (and the matching landing caption) so it states that approval is the default and that owner-enabled automatic modes exist, or confirm those modes are out of the sold scope. Add a test tying demo approval claims to the real policy modes.
- **Verification evidence:** Own: read why-content, content.ts, pricing view and tests.
  - *Skeptic review: A claim the audit did not test is contradicted by shipped code: the product has an owner-selectable 'Send automatically' missed-call recovery mode that sends texts with no per-message approval, and an agent 'autonomous' mode that carries out low-risk work without asking each time. A flat 'No' in public sales copy (and in the one-line oversight fact given to AQi) is an unsupported absolute claim under the brief's 'unsupported claims' check. The audit's re-confirm list named three other claims but not this one.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Why page states only what the shipped product does, prices from the single source, and indexability is a deliberate decision.

<a id="gp-demo-14"></a>
### GP-DEMO-14 — Consent notice, privacy policy, retention and erasure

- **Requirement:** Consent notice, privacy policy, retention and erasure (directive §22 demo data handling (launch safety))
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P0  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `src/lib/demo/notice.ts`, `src/lib/demo/rules.ts`, `src/components/demo/request-form.tsx`, `src/server/demo/erase.ts`, `src/server/demo/jobs.ts`, `src/lib/demo/outcomes.ts`, `src/app/(auth)/layout.tsx`
- **Test coverage:** `tests/demo-retention.test.ts`, `tests/demo-jobs.test.ts`, `tests/demo-admin.test.ts` (erase). They prove the mechanics, not legal adequacy.
- **Real or simulated behavior:** Real storage of name, work email, business, industry, IP hash, UTM and conversation; retention and erasure mechanics are real and tested; legal text is draft (NOTICE_VERSION draft-2026-10); no privacy or terms page exists under src/app; self-erasure is by emailing support@iacquire.ai.
- **Missing dependencies:** counsel approval of the notice wording (docs call it "draft wording for counsel"), a published privacy policy, a decision on the marketing opt-in text, and approval to start the scheduler (retention/expiry jobs; never run as of 2026-10-27).
- **Remaining work:** Install counsel-approved text in notice.ts and bump NOTICE_VERSION; add privacy/terms pages and link them from request-form.tsx and the auth footer; optional self-service erase action in http.ts using eraseProspectInTx; run both jobs in production once and record counts. | Skeptic adds: Reconcile retention with the consent notice: either erase (or minimise) converted and blocked prospects' name, email and conversation on the notice's schedule, or change the notice to state that blocked and converted records are kept longer and why. Also state that the clock restarts on each visit.
- **Verification evidence:** Prior recorded: docs/demo-funnel.md line 60 and docs/demo-activation-acceptance.md section 11. Own: confirmed no policy page in this repo.
  - *Skeptic review: Code and notice disagree. The notice promises 'we keep your name, work email address, business name and the demo conversation for up to N days after your demo ends, then erase them'. retentionAction returns null for converted and blocked prospects, so their personal details and the stored conversation are kept indefinitely, and the anchor is the latest of created, window end and last seen, so a returning visitor extends it. Mechanics tests (tests/demo-retention.test.ts) prove the exemptions as intended behaviour but nobody checked them against the notice.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Counsel-approved notice and linked privacy policy live; retention jobs have run with recorded results; stored notice version matches shown text.

<a id="gp-demo-15"></a>
### GP-DEMO-15 — Activation and live verification of the current demo build

- **Requirement:** Activation and live verification of the current demo build (directive §22 demo operable as a sales funnel)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P0  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** no
- **Source files:** `src/server/demo/switch.ts`, `src/server/env.ts`, `scripts/staging-demo-e2e.mjs`, `scripts/staging-demo-error-matrix.mjs`, `docs/demo-activation-acceptance.md`, `docs/demo-external-registration.md`
- **Test coverage:** isolated staging scripts (not in the unit suite); unit tests as listed above.
- **Real or simulated behavior:** Nothing about the current Growth Partner build has run live. Last recorded production activity: 2026-10-27 one-address smoke test (email delivered, 1 chat message, buy press recorded), then switched off. Current production state is not observable from the repo.
- **Missing dependencies:** founder approvals for production environment changes, redeploys, one real email, a few paid model messages, and the scheduler; the separate landing repo deploy.
- **Remaining work:** After GP-DEMO-04/05/08/09 land, execute section 6 of docs/demo-activation-acceptance.md on current master with low caps (3 starts/day, 25 messages/day), record a dated results section, then stage the opening with monitoring.
- **Verification evidence:** Prior recorded (docs). None of my own.
- **Definition of done:** Recorded controlled production smoke on the current build with AI chat on, a consultation press with a real link, expiry and retention observed, then a staged opening.

<a id="gp-demo-16"></a>
### GP-DEMO-16 — Public marketing homepage, product pages and pricing site (separate repository)

- **Requirement:** Public marketing homepage, product pages and pricing site (separate repository) (directive §22 homepage, product pages, pricing, feature copy)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `src/app/page.tsx`, `src/server/demo/registration.ts`, `docs/demo-external-registration.md`, `docs/demo-activation-acceptance.md`
- **Test coverage:** this repo's `tests/demo-external-registration.test.ts` covers the receiving contract only. The docs state the landing page has 21 own tests (not seen).
- **Real or simulated behavior:** Not in this repo: src/app/page.tsx only redirects to /login, /admin or /overview. The marketing site is the separate repo mlester999/iacquire-os-landing-page (iacquire-os.vercel.app) posting to the signed register door; its copy could not be audited. Tests here cover only the receiving contract.
- **Missing dependencies:** access to that repository.
- **Remaining work:** Audit that repo's homepage, product, pricing, FAQ and feature copy against the one-Growth-Partner model (no six-employees wording, prices from src/lib/billing.ts, no result or autonomy claims) and align; add a cross-repo copy-parity checklist to docs/demo-external-registration.md.
- **Verification evidence:** Own: read `src/app/page.tsx`; searched this repo for marketing pages and found none.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Marketing site copy audited and aligned with the demo and pricing sources; registration door verified end-to-end from the production landing page.

<a id="gp-demo-17"></a>
### GP-DEMO-17 — Entry pages copy: login, get-started, invitation, no-workspace

- **Requirement:** Entry pages copy: login, get-started, invitation, no-workspace (directive §22 login and onboarding copy consistent with ONE AI Growth Partner)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(auth)/login/page.tsx`, `src/app/(auth)/get-started/page.tsx`, `src/app/(auth)/actions.ts`, `src/components/auth/forms.tsx`, `src/components/auth/showcase.tsx`, `src/app/(auth)/layout.tsx`, `src/app/(auth)/invite/[token]/page.tsx`, `src/app/(auth)/no-workspace/page.tsx`
- **Test coverage:** no test guards these pages' copy; `tests/demo-retention.test.ts` touches the access-request erasure only.
- **Real or simulated behavior:** Static copy plus one real DB write (access_requests row and agency notification). get-started hard-codes '$1,499' and states 'Setup is a one-time $1,499' as a fixed price, while the demo says 'starting price ... confirmed in writing'. No test guards these pages' copy.
- **Missing dependencies:** none.
- **Remaining work:** Import SETUP_FEE_USD in get-started/page.tsx and use the same 'starts at' wording; link /get-started to /demo; add a copy-guard test for (auth) pages (no employee wording, price from billing.ts).
- **Verification evidence:** Own: read the pages.
- **Definition of done:** All entry pages use the same product name, price source and wording as the demo, and a test fails on drift.

<a id="gp-demo-18"></a>
### GP-DEMO-18 — Public transactional pages: purchase, payment, booking

- **Requirement:** Public transactional pages: purchase, payment, booking (directive §22 pricing and onboarding copy consistency)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/purchase-intents/public-purchase.tsx`, `src/components/purchase-intents/team-orbit.tsx`, `src/app/purchase/[token]/page.tsx`, `src/app/pay/[token]/page.tsx`, `src/app/book/page.tsx`
- **Test coverage:** other domains' tests (purchase intents); not assessed by me.
- **Real or simulated behavior:** Only copy read here (real purchase and payment flow is another domain). Purchase page uses the Growth Partner and six capabilities wording and states a workspace is created only after verified payment; no employee wording found by grep.
- **Missing dependencies:** provider approvals for live payments (other domain).
- **Remaining work:** Include these pages in the copy-parity guard proposed in GP-DEMO-17. | Skeptic adds: Reference tests/purchase-room.test.tsx (already asserts 'One AI Growth Partner with six connected capabilities' on the buyer page) when building the copy-parity guard; extend it to the payment page.
- **Verification evidence:** Own: grep for employee/six wording in these paths returned only the Growth Partner phrasing.
  - *Skeptic review: The row says there are no tests. The buyer purchase page does have a copy test, so 'testFiles: []' and 'no test coverage' are inaccurate for the purchase page (payment and booking copy remain unguarded).*
- **Definition of done:** Guard test covers purchase and payment copy.

<a id="gp-demo-19"></a>
### GP-DEMO-19 — Internal docs and comments still describing the six-employee demo

- **Requirement:** Internal docs and comments still describing the six-employee demo (directive §22 consistency with ONE AI Growth Partner (internal))
- **Current implementation status:** PARTIAL
- **Priority:** P3  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `docs/demo-funnel.md`, `docs/demo-showroom.md`, `docs/demo-activation-acceptance.md`, `src/server/demo/admin.ts`, `src/server/demo/prompt.ts`
- **Test coverage:** none (docs).
- **Real or simulated behavior:** Documentation only. demo-funnel.md says the room shows what 'the six AI Employees do' and that the chat will carry 'a persona label (one of the six roles)' with no model call yet; code now makes the model call in generator.ts and chat.ts:79 rejects any role. demo-showroom.md:92 says 'six-employee hub'.
- **Missing dependencies:** none.
- **Remaining work:** Rewrite those passages and comments to the one-Growth-Partner model and current behaviour; define the 'four-step' tour as JOURNEY in content.ts.
- **Verification evidence:** Own: read the docs and code.
- **Definition of done:** No demo document or demo-code comment claims six employees or a persona-label chat.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Funnel dead-end: 'you can still ask for a consultation' stops working after the 7-day session, and no path re-opens the room", "directiveRef": "§22 consultation booking CTA; limited demo access", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "The CTA requires a live session (findSession) and a session lasts SESSION_DAYS=7; requestReturnLink refuses unless the window is still open (window default 24 h), and register-again returns the generic 'if this address can open a demo...' sentence with no email. After day 7 a prospect whose window ended has no route to the consultation button although window_ended copy promises one. Either let an ended-window prospect request a consultation-only link (no messages) or change the copy to point to the sign-up page. Evidence: src/lib/demo/rules.ts:15 (SESSION_DAYS 7), rules.ts:112 (window_ended copy), src/server/demo/public.ts:248-262 (requestReturnLink open-only), public.ts:219-226 (ended returns nothing)."}
- {"title": "Isolation guard does not cover the model-calling file or the HTTP/registration entry points", "directiveRef": "§22 no mock demo may send real prospect communications; separation of Demo/Prospects from Clients", "priority": "P1", "status": "PARTIAL", "remainingWork": "Add generator.ts, http.ts, registration.ts, prompt.ts and reply-check.ts to a strict import allow-list in tests/demo-isolation.test.ts (explicit permitted llm/aqi/catalog modules only), and add a no-tools assertion for generator.ts. Evidence: tests/demo-isolation.test.ts:19-20, src/server/demo/generator.ts:3-7."}
- {"title": "Retention behaviour contradicts the consent notice for converted and blocked prospects", "directiveRef": "§22 demo entry data handling / launch safety", "priority": "P0", "status": "PARTIAL", "remainingWork": "Align retentionAction (src/lib/demo/rules.ts:249) with the notice text (src/lib/demo/notice.ts:20-22) or amend the notice; bump NOTICE_VERSION; test the chosen rule."}
- {"title": "Public FAQ and oversight copy state an absolute 'customer messages always wait for approval' that the shipped automatic and autonomous modes contradict", "directiveRef": "§22 FAQs and feature copy free of unsupported claims", "priority": "P1", "status": "PARTIAL", "remainingWork": "Rewording is complete: the FAQ, landing caption, inbox and capability description now say actions follow configured approval rules, and the summary renders OVERSIGHT_FOOTER. The demo-claims test guards those surfaces. Remaining: link the wording directly to the policy mode list and extend the public-copy guard beyond the demo."}
- {"title": "Stale code comments after the purchase journey shipped", "directiveRef": "§22 consistency (internal)", "priority": "P3", "status": "PARTIAL", "remainingWork": "src/server/demo/public.ts:552 says 'Buying online is not built yet; pressing Buy only records that they asked', and generator.ts-era comments still describe the earlier model; update alongside GP-DEMO-19."}
