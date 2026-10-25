# Phases 3 to 7: final readiness report

Written 2026-10-26 on branch `feat/phases-3-7` (worktree `.data/wt-phases-3-7`). This is a report of what was built, what was checked and how, what was **not** checked, and whether the work is ready to be switched on. It states 100% for nothing, because nothing here has met a real provider, a hosted database, a real customer or the scheduler. Every figure is traceable to a file in this folder or to a command that can be run again.

## 1. Verdict

* **GO** for: reviewing the branch, pushing it for review (an off-machine copy of 70-plus commits that exist only on this machine today), and rehearsing the migrations on a staging copy of the hosted database, **each on the founder's approval**.
* **NO-GO** for: deploying it as a live feature, applying a migration to the hosted database, starting the scheduler, switching any module on for a customer, connecting a real provider, or letting any message, payment or post leave the system. None of those has been done and none is safe to do until the open items in sections 16 and 17 are closed.
* Evidence-based completion (method in section 19): about **87% of the approved development scope is built and verified locally or better**; about **38% of what a real launch needs is done**. Both are estimates with their method written down, not measurements.

## 2. Exact state

| Item | Value |
| --- | --- |
| Branch / worktree | `feat/phases-3-7`, `C:\Users\ZEPHY\Documents\Marky Files\Programming Projects\iAcquire-dashboard\.data\wt-phases-3-7` |
| Head | `the head of `feat/phases-3-7`: a documents-only commit on top of the **gated head `dafd3373`** (every gate in section 5 ran there on a clean tree; `git log dafd3373..HEAD` shows only files under `docs/`)` (`git rev-parse HEAD`) |
| Base | `origin/master` `36bf78c` (the released Phase 2); the branch is a descendant of it |
| Local commits since the base | 74 at the gated head (`git rev-list --count 36bf78c..HEAD`), diff 1,688 files changed, 191,705 insertions, 5,405 deletions (includes the ledger and generated seeds) |
| Pushed / deployed / hosted migration applied | **None.** No push, no deploy, no migration on a hosted database, no scheduler tick, no module switched on, no real provider call, no real customer message, no payment charged, no post published |
| Working tree | Clean at the head above (generated QA data is git-ignored) |
| Migrations in this branch | 0087 to 0104 (18), each with a rollback in `supabase/rollbacks/`; next free number **0105** |
| The main checkout | Not touched. It is 31 commits behind `origin/master` and carries uncommitted AI Workforce work, including an untracked migration numbered 0081 that collides with a number already in production (see `release-plan.md`) |

## 3. What was built

* **Phase 3:** the website chat widget, its public API and kill switch, lead capture with the visitor-typed-contact consent rule, lead attribution, the Lead Sources report with verified revenue (0087, 0088).
* **Phase 4:** the social media manager: accounts, posts, durable publishing, media, drafts and the invented-claims filter, metrics, tracked links (0089, 0090).
* **Phase 5, Wave 1:** proposals with a PDF and an e-signature seam (0091, 0092), customer invoices, customer payments and verified revenue (0093), reputation surveys, review batches, external public reviews (0094, 0095), the AI cost meter and the per-workspace daily cap.
* **Wave 2:** staff messages (0096), staff workload (0097), Requests completion with change orders and surveys (0098), payment controls (0099), the prospect demo (0100), purchase intents (0101), onboarding snapshots (0102).
* **This directive (2026-10-25 and 26):** the online purchase checkout and held-purchase handling (0103), provider-verified maintenance periods, a pause that stops AI work jobs, sealed-secret key rotation and a re-seal tool, complete workspace shutdown, AI customer-reply usage and an optional cap (0104), the six-employee conformance suite, the eight-journey map, the 12px type floor and the 14px working scale, about 25 accessibility, layout and honesty defects found by sweeping the whole portal, admin and public pages, bounded public request bodies, an open redirect closed, a usage and cost document, a release plan.

## 4. Evidence by class

Classes are never merged: built, locally tested (embedded Postgres), integration-tested (real internal services, simulated providers), browser-checked (isolated QA app, simulated providers), tested with a real provider, deployed, production-verified.

| Area | Built | Locally tested | Browser-checked | Real provider | Deployed |
| --- | --- | --- | --- | --- | --- |
| Website chat, attribution | Yes | Yes | Yes (chat widget on an external test origin; Website Studio path no) | No | No |
| Social media manager | Yes | Yes | Yes (simulated platform) | No (Meta review pending) | No |
| Proposals, e-signature | Yes | Yes | Yes (simulated signer) | No (PandaDoc never called) | No |
| Customer invoices, payments | Yes | Yes | Yes (simulated provider) | No | No |
| Reputation, reviews | Yes | Yes | Yes (simulated site) | No | No |
| Staff messages, workload, Requests | Yes | Yes | Yes | n/a | No |
| Demo funnel | Yes | Yes | Yes | n/a (AI chat simulated) | No |
| Purchase intents and online checkout | Yes | Yes | Yes (71 checks, simulated PayMongo) | No | No |
| Maintenance period payments | Yes | Yes | Yes (20 checks, simulated PayMongo) | No | No |
| Automation Studio | Yes (earlier phase) | Yes | Yes (58 checks, earlier pass) | No (no n8n, Slack or HTTP target called) | Yes (earlier release) |
| Six AI employees | Yes | Yes (20 conformance tests) | Partly | **No** (no live Hermes profile for any client) | No |

## 5. Gates at the head

| Gate | Result | Where |
| --- | --- | --- |
| Full test suite | **634 files, 10,424 tests passed, 1 skipped, 0 failed** (848 s) | `verification-evidence.md` |
| TypeScript, both configs (`tsconfig.clean.json`, `tsconfig.scripts.json`) | Clean (exit 0 for each) | |
| ESLint, whole tree | Clean (exit 0) | |
| Production build (`next build`, the default Turbopack bundler, which a deployment uses) | Passes at the gated head: compiled in 45 s, TypeScript 65 s, every route generated | `verification-evidence.md` |
| Production build with webpack (`next build --webpack`) | **Fails: out of memory** at 3, 4 and 7 GB, also at older commits that had passed (see section 16) | |
| Combined migration rehearsal (98 files, up, down, up, exact-schema comparison, section F checks) | All sections passed (98 files, 22,920 schema facts equal the fresh chain), 190 s | `scripts/rehearse-combined-migrations.mjs` |

## 6. Test counts

634 test files; 10,424 passed, 1 skipped, 0 failed at the gated head. New in this directive: purchase checkout (27) and its migration, rules and actions tests, maintenance provider payment (11), job gate (8), sealed-secret rotation (8), customer-reply usage (8), offboarding connections, six-employee conformance (20), type-scale floor (4), table scroller focus, bounded body (13) and its route guard, safe next path (4), local day (3), list statement counts (2). Per journey: purchase 473 tests in 37 files, lead acquisition 288, missed-call recovery 108, Automation Studio 460, social 458, sales closing 1,983, support and client operations 985, subscription lifecycle 104 (`node scripts/journey-evidence.mjs`; counts by file name, not proof of quality).

## 7. Browser journeys (isolated app, simulated providers, real Chromium)

Purchase to workspace (the buyer's link, confirmation, payment on the simulated provider's page, return, held refund and dispute, release and close, automatic provisioning, replay and walk-away): 71 checks. Maintenance period payment (resume, replay, refund report, the dialog at 375 px): 20 checks. Invoice sending (an accepted and a refused send), invoice from a proposal, the Requests support, change, survey, issue-report, feedback, attachment and reopen paths, the 47-question onboarding, the demo funnel: each driven end to end earlier in this initiative and recorded in `verification-evidence.md`. Both payment runs were repeated at the end on a freshly rebuilt QA database after the UI changes: **purchase checkout 72/72, maintenance payment 20/20, console errors 0, page errors 0, 5xx 0, external requests 0.** (One earlier run showed a single React dev warning, "state update on a component that hasn't mounted yet"; two later runs on a fresh database did not repeat it and it was not reproduced by opening the same pages.)

## 8. Visual and layout review

About 1,000 page views were swept: roughly 100 portal routes and 50 admin routes at 1280, 768 and 375 px in light and 1280 and 375 px in dark, 11 public pages at the same widths, and a representative set again at 1440 and 390 px. Per view: console and page errors, requests that left the QA origin, overflow of the document, of content the shell clips and of the element that widens the page, cut-off tab strips, text clipped mid-word, axe-core serious and critical violations, and the smallest text. I read about 40 full-page screenshots. Details and the table of defects found and fixed: `docs/design-audit.md` (second pass).

Results after the fixes: no axe serious or critical violation on any swept view, no document that scrolls sideways, no text under 12px, no cut-off tab strip at desktop widths; the remaining console messages were the dev server's own recompile noise (`text/plain` chunk answers, connection resets). At 1440 and 390 px (12 portal routes, 8 admin routes, 4 public pages, light and dark; 96 views) there were no flags and no console, page or server errors.

## 9. Accessibility

axe-core WCAG 2 A and AA: clean on every swept view after fixes. Fixed in this pass: white-on-primary contrast in the dark theme (3.48:1, 33 places), a label whose accessible name did not contain its visible text (WCAG 2.5.3), a count chip at 4.35:1, an invalid `dl` child, 31 sideways-scrolling tables a keyboard could not reach (now a guard test), 20 reduced-motion hydration mismatches. **Not done:** a screen-reader pass (NVDA, VoiceOver) by a person, keyboard-only walk-throughs of every journey, zoom to 400%, high-contrast mode.

## 10. Security review

Reviewed and fixed: every public request body is now read with a ceiling as it arrives (23 routes, a guard test); an open redirect on the sign-in page (a backslash in `next=`) closed with one shared check and 20 bypass shapes tested; the leads export quotes a lone carriage return; the AI Employee Tools screen no longer claims tools are live; the Blueprint checklist no longer says an employee "passed its connection check" without one. Confirmed already sound by reading: signature verification uses constant-time compares in 19 places and no secret is compared with `===`; CSV exports neutralise formulas; outbound HTTP goes through a pinned-HTTPS guard; the sign-in action's own redirect check was already strict. **Not covered:** a penetration test, dependency audit, uploads behind a session (they read the whole body before checking size; session and per-file limits stand in front of them), and the open policy question D70 (see section 16).

## 11. Payments and purchase intents

Frozen price snapshot; hashed expiring bearer link with rotation; the provider's **signed** notice is the only route to "paid"; replay, duplicate and late-payment handling; mismatch, wrong mode and test/live isolation; refunds and disputes are *reported, never applied*, and a held purchase waits for a Super Admin who can release it after checking the provider or close it; automatic provisioning re-reads the inviter's permissions at that moment and leaves six employees in "Setup required"; a plan payment is one checkout per period, and a charge the provider makes by itself (a true subscription) and PayPal are **not built**. All of it ran only against a local stand-in written from documentation (`scripts/paymongo-sim.mjs`, refused outside loopback and with any key but its own); PayMongo's real payload shapes are unverified.

## 12. Provider verification matrix

| Provider | Built against | Ever called for real | Needs |
| --- | --- | --- | --- |
| PayMongo (agency checkout, top-ups, client payments) | Documentation and a simulator | No | Test keys, webhook secret, sandbox run |
| PayPal (client payments) | Documentation and fixtures | No | Sandbox app and webhook id |
| PandaDoc (e-signature) | Documentation and a replaced HTTP layer | No | Sandbox account and key |
| Meta (social, reviews, WhatsApp) | A simulated platform | No | App review, business verification |
| Google Business Profile | A simulated review site | No | API approval, OAuth verification |
| Twilio, Resend, GoHighLevel, Vapi, Retell | Existing adapters and fixtures | Earlier phases only | Write switches stay off |
| Hermes (AI employee runtime) | A mock | No client profile ever | Provisioning, a live evaluation |
| A language model (replies, drafts) | Simulated generators | No | A key and an evaluation |

## 13. AI employee readiness

See `docs/ai-employee-readiness-matrix.md`. Short form: six roles with distinct fixed agency profile ids and per-workspace client names; 12 deterministic read-only capabilities run for their own roles and finish with a stated result; the 65 role-and-capability pairs not allowed are refused; a purchase-created workspace has all six in "Setup required" and none can chat or take work. **Simulated profile is not production-ready:** no live Hermes profile has ever answered for a client; "ready" still means connection, configuration and tool inventory verified, not that the role has a calendar, a pipeline or an approved knowledge base; health is not probed on a schedule; the per-role tool allowlist and one shared readiness definition are not built.

## 14. The eight journeys

`docs/journey-verification.md` maps each journey (purchase to client; lead acquisition; missed-call recovery; Automation Studio; social acquisition; sales closing; support and client operations; subscription lifecycle) to its test files, tests, browser evidence and gaps. No journey has run against a real provider, and the scheduler has never run, so every scheduled stage is verified only through injected clocks.

## 15. Performance and cost safety

* Build: client JavaScript 12.4 MB raw over 331 files, the largest chunk 448 KB, CSS 417 KB (`.next-clean-build/static`, Turbopack).
* The invoice and proposal lists send the same number of statements with 3 rows and with 24 (`tests/list-statement-counts.test.ts`); the CRM and inbox scale measurements from earlier phases stand (`docs/crm-performance.md`, PGlite in memory, indicative only). **No hosted measurement exists**; there is no staging project, no error tracking and no paging.
* Cost: every model call is metered per workspace; a pause stops AI work jobs; the website chat has a daily allowance; customer replies are counted with an optional cap; fair use is measured with no limit shipped; every public surface has a rate limit and a kill switch. No price is published, so no operating-cost estimate is made. `docs/usage-and-cost-safety.md`.

## 16. Known issues and open defects

1. **The webpack production build runs out of memory** (3, 4 and 7 GB tried; also at commits that passed earlier). The default Turbopack build, which a deployment uses, passes. Cause not found; webpack is the QA app's dev bundler. Treat as an open investigation, not as fixed.
2. Two booking-widget labels on published client websites are 11.5px; raising them means regenerating the 50 gallery screenshots (D66).
3. **Policy open (D70):** assigned agency staff can read a client's approvals and activity without a support session.
4. Not built from the employee audit: one shared readiness definition, a scheduled Hermes health probe, a per-role tool allowlist, storage entitlement and external storage, a feature-rollout registry.
5. Not built: credit notes, birthdays, customer-facing renewal notices, a scheduled capture of approved PayPal orders, PayPal and card-on-file recurring billing for purchases.
6. Dev-only: the QA server restarts itself near 8 GB and prints chunk errors while recompiling; the disk was nearly full during QA (the build cache is cleared between batches).
7. No error tracking, staging project, CI on any mainline ref or on-call; manual monitoring only.

## 17. External dependencies and founder approvals

Everything in `blockers.md` and `handoff.md` ("Approvals the founder still owns"): push and merge; each hosted migration (one at a time, after a restore-tested backup); each scheduler stage; each module for each workspace; each environment switch; every provider account and key; counsel review of the proposal, payment, review and retention wording; the proposed numbers (link life, limits, caps, retention, the daily chat allowance); the price of any plan (none is coded); who may read approvals without a support session.

## 18. Integration and release

`release-plan.md`: the branch is a descendant of `origin/master`; merge only from a clean worktree after re-fetching; the main checkout is behind and dirty and must not be the place; the untracked `0081_ai_work_job_rls_hardening.sql` there collides with a production migration number and needs renumbering; hosted migrations are applied one at a time with `--only`; everything ships dormant behind switches that default off.

## 19. Completion estimates and their method

* **Feature scope built and verified locally or better: about 87%.** The implementation checklist has 115 rows; 82 are "Verified Locally" or "Browser-QA'd", about 10 are "Not built" (listed in section 16), 5 are blocked on an external party, 3 need a founder decision, the rest are documents. Rows were weighted by the share of the approved scope they represent, and this directive's work (checkout, trust fixes, UI pass, hardening) added to the verified side.
* **Launch readiness: about 38%.** Counting what a real launch needs: hosted migrations applied and checked (0 of 18), a provider sandbox run for each money or message path (0 of 8), a live Hermes profile (0 of 6), the scheduler started in stages (0), counsel-reviewed wording (0), staging and monitoring (none), a human accessibility pass (none), and a deployment with kill switches proven in production (none). The 38% is what remains true without any of those: the code, the tests, the rehearsal, the documentation and the switches that keep it dormant.
* Neither number is a promise. Do not read either as "close to done" for the parts that need real accounts.

## 20. What happens next

In order, each on approval: (1) push the branch so the work exists off this machine; (2) review by area (`src/server/purchase-intents`, `src/server/billing/payments.ts`, `src/server/customer-payments`, the migrations, the shared reader); (3) rehearse the migrations on a staging copy of the hosted database; (4) provider sandbox runs for PayMongo, PandaDoc and one messaging path; (5) provision and evaluate a Hermes profile for one internal workspace; (6) switch one internal test workspace on, module by module, with the scheduler off; (7) start scheduler stages as `release-plan.md` lists. The single next safe action for a session with no instruction is to investigate the webpack build memory (section 16, item 1) and keep the ledgers current.
