# Implementation checklist

States: Not Started, In Progress, Implemented, Verified Locally (tests on embedded Postgres), Browser-QA'd (isolated QA app, simulated model), Blocked, Blocked-external (the local part is built and verified; the rest needs an account, an approval or counsel), Not built (noted or decided, no code), Needs Founder Approval, Production Verified. Nothing here is Production Verified; nothing is tested with a real provider.

## Phase 3: AI website acquisition and lead attribution

| Id | Task | State |
| --- | --- | --- |
| 3.0 | Audit Website Studio and related modules; implementation matrix | Verified Locally (read of the tree; see architecture-and-dependencies.md) |
| 3.1 | Migration 0087: web chat widget and session tables; `web_chat` channel; `website_chat` created-via; `web_chat_lead` notification kind; `app.site_chat_widget` | Verified Locally (rehearsal A-E on embedded Postgres) |
| 3.2 | Pure rules: widget configuration, origin allowlist, tokens, visitor input, qualification questions, limits | Verified Locally |
| 3.3 | Server: widget configuration service (versioned saves, key rotation, install evidence) | Verified Locally, Browser-QA'd (settings save reaches the public config) |
| 3.4 | Server: visitor session, message ingest, AI reply, delivery to the visitor | Verified Locally, Browser-QA'd (simulated model) |
| 3.5 | Server: lead capture (contact create without merging, possible-match hint, consent wording), qualification | Verified Locally, Browser-QA'd |
| 3.6 | Handoff to a person, offline and fallback states, business hours | Verified Locally; handoff Browser-QA'd; offline and fallback by test only |
| 3.7 | Public API: CORS, Origin allowlist, rate limits, body cap (`/api/public/webchat/*`) | Verified Locally; Origin, preflight, bad key and oversize body checked with curl against the QA app |
| 3.8 | Embeddable widget script (Shadow DOM, accessible, responsive, no secrets) | Verified Locally (jsdom), Browser-QA'd at 375 and 1280, light and dark, axe 0 violations after fixes |
| 3.9 | Website Studio integration (portal-served widget, site CSP, `app.site_chat_widget`) | Verified Locally; **not exercised in a browser** (the QA run used an external test origin only) |
| 3.10 | Management UI: settings, installation, health checks, knowledge, employee, history, analytics | Browser-QA'd at 375 and 1280, light and dark |
| 3.11 | Inbox and CRM display of `web_chat` conversations (channel filter, thread, customer drawer, possible-match note) | Browser-QA'd |
| 3.12 | Attribution: migration 0088, touch recording (form, chat, call, manual), first and latest touch | Verified Locally (rehearsal A-E) |
| 3.13 | Attribution report: leads, qualified, appointments, deals, deal value, cost, cost per lead, ROI gating; manual costs | Verified Locally, Browser-QA'd at 375 and 1280, light and dark |
| 3.14 | Automation Studio triggers (five) and permissions | Verified Locally (events and trigger matching); **editor UI not browser-checked for the new triggers** |
| 3.15 | Phase 2 lead scoring integration (chat leads are scored) | Verified Locally |
| 3.16 | Tests per acceptance list; tenant-isolation and abuse tests | Verified Locally (see verification-evidence.md) |
| 3.17 | Browser QA (external test origin; mobile and desktop; accessibility) | Done for the external origin; Website Studio site path not done |
| 3.18 | Typecheck, lint, clean build, migration rehearsal | Done (see verification-evidence.md) |

## Phase 4: AI social media manager

| Id | Task | State |
| --- | --- | --- |
| 4.0 | Audit: nothing social existed (no tables, no Meta code, OAuth only for calendars) | Verified Locally (read of the tree) |
| 4.1 | Migration 0089: ten tables, six `social.*` permissions, `social-media` bucket and file rule, five notification kinds, RLS select-only, credentials column ungranted | Verified Locally (`scripts/rehearse-phase4-migrations.mjs` A-E ok on embedded Postgres) |
| 4.2 | Pure rules: platform limits, approval and scheduling rules, post state machine, media policy, calendar grids, image-size parsing | Verified Locally |
| 4.3 | Providers: adapter interface, simulated platform, Meta Graph adapter | Verified Locally (Meta adapter against a replaced HTTP layer only); **no real provider** |
| 4.4 | Accounts: Facebook login flow, Page chooser, health, revoke, disconnect, deauthorize and data-deletion callbacks | Verified Locally; not connectable until a Meta app exists (blocker) |
| 4.5 | Posts and approvals: drafts, version-bound approval, request changes, reject, duplicate, cancel, retry, resolve unknown outcome | Verified Locally, Browser-QA'd (approve, edit voids approval, schedule, disconnect fails scheduled posts honestly, read-only role) |
| 4.6 | Durable publisher: leased, resumable, idempotent jobs, reconciliation of lost answers, notifications | Verified Locally. The adversarial review found a crash-replay double-post (#1, critical) and workspace-gate gaps; both fixed with tests that fail without the fix (44 failures against the pre-fix source) |
| 4.7 | AI help: ideas and captions from approved knowledge, claim filter, always a draft | Verified Locally (simulated model), Browser-QA'd; **no real model evaluated** |
| 4.8 | Media library: managed bucket, entitlement policy, per-platform validation, storage cap | Verified Locally, Browser-QA'd (page); Drive and OneDrive blocked-external |
| 4.9 | Analytics: published posts, returned engagement only, leads by tracking code, per-campaign rollup | Verified Locally (end-to-end through the real form path); per-campaign table and "Not tracked" added |
| 4.10 | Automation Studio: three triggers (published, failed, approval requested); Performance Analyst read-only social review | Verified Locally; **editor UI not browser-checked** |
| 4.11 | Screens: calendar (month, week, list, client time zone), composer with live checks and preview, approvals, post page, accounts, media, analytics, settings | Browser-QA'd at 375 and 1280, light and dark, owner / read-only / agency staff, after the fixes |
| 4.12 | Scheduler jobs `socialPublisher`, `socialAccountHealth`, `socialMetrics` (+ sign-in-state purge) | Verified Locally (injected clocks); never run live |
| 4.13 | Adversarial review: 8 risk lenses, 82 agents, every finding verified by independent skeptics | Done: 66 confirmed (about 40 distinct), 3 refuted |
| 4.14 | Review fixes (four file-disjoint implementers, then integration) | Verified Locally (see verification-evidence.md) |
| 4.15 | Full gates: suite, typecheck, lint, clean build, rehearsal re-run, browser re-check | Done (see verification-evidence.md and phase-4-checkpoint.md) |
| 4.16 | Inbox for social inquiries (4H), Drive/OneDrive media, reach/impressions | Blocked (external accounts and permissions; see blockers.md) |

## Phase 5: sales closing and customer retention

Wave 1 (proposals and e-signature, customer invoices and payments, reputation and retention, AI cost control and consent) is built and verified locally at `2e192a1`; Waves 2 and 3 are not built (a partial, ungated Wave 2 work-in-progress commit, `cca6605`, is on the branch and is counted nowhere in this file). "Browser-QA'd" below means the lead's pass of 2026-10-24 (375 and 1024/1280 px, isolated app, simulated providers); the screens it did not reach are named in each row. Nothing is applied to a hosted database, switched on for a workspace, or run against a real provider. Report: `phase-5-wave1-checkpoint.md`.

| Subphase | Overall state |
| --- | --- |
| 5A Proposals (0091) | Verified Locally; Browser-QA'd except the editor interactions and the AI draft button. Sending by email or text: Not built in Wave 1 |
| 5B E-signature (0092) | Verified Locally and Browser-QA'd against the in-process stand-in. The PandaDoc adapter: Blocked-external. Withdraw call, certificate, master account: Not built |
| 5C Customer invoices (0093) | Verified Locally; Browser-QA'd except the issue, record-payment, refund and void dialogs and the print layout. Credit notes, sending an invoice through the consent chain, invoice from an accepted proposal: Not built |
| 5D Customer payments and verified revenue | Verified Locally; Browser-QA'd against the simulated provider (Lead Sources revenue not driven). PayMongo and PayPal adapters: Blocked-external |
| 5E Setup payment gate and clearance | Not Started in Wave 1 (Wave 2 stage P1 is partial and ungated) |
| 5F Reputation (0094, 0095) | Verified Locally; Browser-QA'd except the survey page, the request dialog and batch approval. Google and Facebook adapters: Blocked-external |
| 5G Retention | Verified Locally. Birthdays, anniversaries and customer-facing renewal notices: Not built |
| Cross-cutting (cost meter, kill switches, consent rule, module rollout page, jobs, documents) | Verified Locally; the rollout page Browser-QA'd; hosted rollout Needs Founder Approval |

### 5A Proposals (migration 0091)

| Id | Task | State |
| --- | --- | --- |
| 5A.1 | Migration 0091: 14 tables, 8 permissions, 9 notification kinds, rollback | Verified Locally (combined rehearsal A to F) |
| 5A.2 | Rules and services: frozen versions, version-bound approval, two-person option, money, append-only history and decisions | Verified Locally |
| 5A.3 | Price book, tax rates, templates with owner-approved versions | Verified Locally; Browser-QA'd (price book, templates) |
| 5A.4 | Staff screens: list, new, workspace (edit, preview, versions, activity, delivery), approvals, templates, price book, settings | Browser-QA'd (list, detail, approvals, templates, price book, settings); **editor interactions (add a line, save, conflict) not browser-checked** |
| 5A.5 | AI drafting from the price book and approved knowledge, every sentence checked | Verified Locally (stub model); **the AI draft button not browser-checked; no real model evaluated** |
| 5A.6 | PDF writer (own, no dependency), stored on send with its sha256 | Verified Locally (structure; text read back with `pdftotext`); no recorded visual check of a PDF |
| 5A.7 | Customer page `/proposal/<token>`, emailed one-time code, three honest levels of "seen", accept, decline, request changes | Verified Locally; Browser-QA'd (every state and the whole code, confirm, accept flow); the code email went through the capture provider only |
| 5A.8 | CRM effects, seven `proposal.*` Studio triggers, contact and deal tabs, jobs `proposalExpiry` and `proposalHousekeeping`, export, erasure, offboarding | Verified Locally; the Studio editor for the triggers not browser-checked; jobs never run live |
| 5A.9 | Send a proposal by email or text through the consent chain | **Not built in Wave 1** (the team copies the link; needs counsel's first-delivery wording). Wave 2 stage M1 started it: partial and ungated in `cca6605` (a `proposal_deliveries` table added to 0091, the message scope `delivery`) |
| 5A.10 | Counsel-approved acknowledgement wording; retention of accepted proposals; agency read of the tables (D24) | **Needs Founder Approval** / counsel (`blockers.md`) |

### 5B E-signature (migration 0092)

| Id | Task | State |
| --- | --- | --- |
| 5B.1 | Migration 0092: 3 tables, `proposals.connect`, guards, rollback | Verified Locally |
| 5B.2 | Provider seam, in-process stand-in (refused in production), request lifecycle (one live request per version, intent before the call, lost answers checked and never repeated), signed webhook, apply rules, signed-copy storage, job `esignSync` | Verified Locally |
| 5B.3 | Signature tab, connection card, customer-page signing states | Verified Locally; Browser-QA'd (Signature tab through to a signed state with the stand-in) |
| 5B.4 | PandaDoc adapter | **Blocked-external** (written from memory, replaced HTTP layer only; needs a sandbox account and a re-read of the API) |
| 5B.5 | PandaDoc withdraw call and completion certificate; a platform-run master account | **Not built** (no remembered call; certificate not fetched; master account is a decision, D38) |

### 5C Customer invoices (migration 0093)

| Id | Task | State |
| --- | --- | --- |
| 5C.1 | Migration 0093: 10 tables, 9 permissions, 8 notification kinds, the `billing` message scope, guards that keep paid and status equal to the rows, rollback | Verified Locally |
| 5C.2 | Draft, approve and issue, void, write-off, numbering at issue, frozen content, hand-recorded payments and refunds (with evidence), eight currencies | Verified Locally; Browser-QA'd (list, detail, new, settings); **issue, record-payment, refund and void dialogs not browser-checked** |
| 5C.3 | Customer invoice page `/pay/<token>` with its print layout | Verified Locally; Browser-QA'd (with the simulated provider); **print layout not browser-checked** |
| 5C.4 | Reminders through the consent chain with the owner's exact-wording authorization; overdue sweep; receivables review by the Performance Analyst | Verified Locally (recording stand-ins); settings page Browser-QA'd; nothing sent through a real provider |
| 5C.5 | Test invoices (owner-only, `TEST-` numbers, kept out of the books) | Verified Locally; Browser-QA'd |
| 5C.6 | Create an invoice from an accepted proposal | **Not built** (prefill from a deal or contact works; `source_type` and `source_id` are never written) |
| 5C.7 | Send an issued invoice to the customer through the consent chain | **Not built** (the team copies the link; only reminders are sent) |
| 5C.8 | Credit notes | **Not built** (needs a founder and counsel decision) |
| 5C.9 | Reminder, authorization and tax-invoice wording; retention of invoice records | **Needs Founder Approval** / counsel |

### 5D Customer payments and verified revenue

| Id | Task | State |
| --- | --- | --- |
| 5D.1 | Provider seam, owner-only connection with sealed keys, one-open-checkout, per-tenant webhook route (receipt, apply, mark error), job `customerPaymentReconcile`, six go-live gates | Verified Locally |
| 5D.2 | Settings > Customer payments (connect, replace keys, check, pause, going live) | Verified Locally; Browser-QA'd (the settings page as a whole; which of the connect, replace-keys, check, pause and going-live actions were driven is not recorded) |
| 5D.3 | Return page and the testing checkout (development only) | Verified Locally; Browser-QA'd in the first pass only (before the fix wave); not named in the second pass |
| 5D.4 | Refunds and disputes: refund events from both providers, dispute events from PayPal and the simulated provider only (the PayMongo adapter reads none), closing outcomes (won, lost as a chargeback, unknown), the owner's by-hand open and close, refund pairing | Verified Locally; Browser-QA'd (dispute dialog, a lost dispute becomes a chargeback); record-payment and refund dialogs not browser-checked |
| 5D.5 | Verified revenue in the Lead Sources report (live, provider-confirmed, net of refunds and tax, per currency, as-of) | Verified Locally (SQL against rules over random payments); Lead Sources not in the recorded browser list |
| 5D.6 | PayMongo adapter; PayPal adapter | **Blocked-external** (fixtures and a replaced HTTP layer only; `contractVerified: false`; need test keys and a sandbox app) |
| 5D.7 | A scheduled capture of approved PayPal orders; a refund sent to a provider from the product | **Not built** (decisions; refunds are made in the provider's dashboard and recorded) |
| 5D.8 | Credential store decision (sealed column or Vault); key rotation | **Needs Founder Approval** |

### 5E Setup payment gate and clearance

| Id | Task | State |
| --- | --- | --- |
| 5E.1 | Setup payment checked before activation or AI-employee provisioning; manual payment evidence; refunds and manual receipts reaching `payments` (the plan's W2-C) | Not Started in Wave 1 (Wave 2 stage P1 started it: partial and ungated in `cca6605`, migration 0099) |

### 5F Reputation (migrations 0094 and 0095)

| Id | Task | State |
| --- | --- | --- |
| 5F.1 | Migrations 0094 (3 tables and alters, 3 permissions, 6 notification kinds) and 0095 (5 tables), rollbacks | Verified Locally |
| 5F.2 | Immediate fixes and follow-through for low feedback (task, notice, escalation, program stop, SLA reminder), settings, R8 hold | Verified Locally; Reviews tabs Browser-QA'd |
| 5F.3 | Surveys (CSAT, NPS), the Satisfaction tab with sample gates, survey forms, the retention feedback-link step, two Studio triggers | Verified Locally; **the `/r/<token>` page with the 11-button scale not browser-checked** |
| 5F.4 | Review request batches (owner approval bound to a hash, pace, drift handling, job `reviewRequestBatches`) | Verified Locally; Batches tab seen; **request dialog and batch approval not browser-checked** |
| 5F.5 | Public review mirror and replies (approval by version and hash, intent before the call, lost answers never resent, jobs `reviewSync` and `reputationRetention`) | Verified Locally; Browser-QA'd (reply drawer through posting on the simulated site) |
| 5F.6 | Google Business Profile and Facebook review adapters | **Blocked-external** (replaced HTTP layers and a simulated site only; need Google API approval and verification, Meta app review) |
| 5F.7 | AI reply assist | Verified Locally (stub); no browser; no real model |
| 5F.8 | Performance Analyst `reputation_review` capability (read only) | Verified Locally |
| 5F.9 | Counsel wording for replies, word lists, thank-you sentence, bulk asks | **Needs Founder Approval** / counsel |

### 5G Retention

| Id | Task | State |
| --- | --- | --- |
| 5G.1 | Retention non-customer search, contact merge reference list and erasure fixes; a person's hold honoured by every automatic review ask and reminder | Verified Locally |
| 5G.2 | Internal renewal reminders (a task and a notice; off by default) and the daily appointment-outcome nudge | Verified Locally |
| 5G.3 | Birthdays and anniversaries; customer-facing renewal notices | **Not built** (no date-of-birth field; a renewal notice to a customer needs a contact link and legal review) |

### Cross-cutting (delivered in Wave 1)

| Id | Task | State |
| --- | --- | --- |
| 5X.1 | AI cost meter (`src/server/llm/meter.ts`), every `llmComplete` caller metered or exempt with a reason, source-scan test | Verified Locally; zero cost until an `llm` rate is published; the gate-before-the-call is narrower than D29 says it should be |
| 5X.2 | Website chat kill switch (`WEBCHAT_PUBLIC_DISABLED`) and daily AI reply cap (`WEBCHAT_DAILY_AI_REPLIES`, 500 proposed) | Verified Locally; widget under the switch and the cap not browser-checked |
| 5X.3 | Consent rule for visitor-typed contact details (`typed_by_visitor` on the identity, staff confirmation, proven inbound) | Verified Locally; Inbox confirm form not browser-checked |
| 5X.4 | Super Admin Module rollout page `/admin/module-rollout` and the six workspace switches | Verified Locally; Browser-QA'd |
| 5X.5 | Public-page emergency stops: `PROPOSALS_PUBLIC_DISABLED`, `INVOICES_PUBLIC_DISABLED`, `REVIEWS_PUBLIC_DISABLED` | Verified Locally |
| 5X.6 | Permissions, export, offboarding, erasure and contact-merge handling for every new table | Verified Locally |
| 5X.7 | Twelve scheduler jobs registered and dormant, with time budgets | Verified Locally (injected clocks, real tick endpoint); never run live; worst-case budget 195 s against 120 s unmeasured |
| 5X.8 | Module documents and the scheduler document, with drift tests | Done (`docs/proposals.md`, `esignature.md`, `invoices-and-payments.md`, `voice-and-reviews.md`, `production-scheduler.md`) |
| 5X.9 | Adversarial review: 10 lenses and a coverage mapper, 114 agents, each finding sent to two skeptics (three for a high) | Done, but verification incomplete: 43 confirmed (5 high, 22 medium, 16 low, none critical), 6 not confirmed. Seven skeptics failed on a session limit: two confirmed findings rest on one verdict, and two of the six "refuted" claims were never tested (paced batches and workspace slots; closure cancel notices) |
| 5X.10 | Fix wave: six chains and an integrator, decisions D21 to D31 and D32 | Verified Locally: 42 reported fixed and #12 reported "partly" by its chain, the missing piece then applied by the integrator (see checkpoint section 9); Q6, Q7 and test-invoice rule 8 were also reported "partly" |
| 5X.11 | Gates: suite, typechecks, lint, clean build, rehearsal, line endings | Run at the first integrated tree (`759333b`: full suite 481 files, 7,823 passed, 1 skipped, exit 0; the clean build first failed on `node:crypto`, fixed in `8840d8d`, and the full suite was not re-run on that intermediate tree) and at the fixed tree (committed as `97609b2`: full suite 520 files, 8,362 passed, 1 skipped, exit 1 because one slow test timed out, since made faster and passing alone; typechecks, eslint, build, rehearsal and line endings clean). No full-suite run exists for `97609b2` as committed or for the head `2e192a1` (see `verification-evidence.md`) |
| 5X.12 | Browser QA | Partly done (see the rows above and `phase-5-wave1-checkpoint.md` section 6); four defects found only in the browser were fixed with guards |
| 5X.13 | Hosted migrations 0087 to 0095, deploy, scheduler stages, switching any module on, any provider run | **Needs Founder Approval** (`blockers.md`); none done |

## Phase 6: requests center, internal messages and client operations

| Id | Task | State |
| --- | --- | --- |
| 6.x | Audit of the requests center; internal staff messages (missing); workload; collaboration | Not Started (audited and designed; Wave 1 delivered nothing here. Partial, ungated Wave 2 work on staff messages (0096) and request fixes sits in the commit `cca6605` and is not counted) |

## Phase 7: system-wide integration and launch readiness

Wave 1 delivered four pieces that the plan placed in the Phase 7 hardening wave. They are listed here with their state; the rest of Phase 7 is Not Started. Partial, ungated Wave 2 work on payment clearance (0099) and the demo funnel (0100) sits in the commit `cca6605` and is not counted.

| Id | Task | State |
| --- | --- | --- |
| 7.x | Integration audit, employee verification, onboarding, demo funnel (absent from this tree), billing, storage, super admin, scenarios, performance, security, UX, launch operations | Not Started |
| 7.W1.1 | AI cost metering of every `llmComplete` caller (not the streaming AQi and builder paths or the Hermes reply path), and the public website chat's daily cap and kill switch (the plan's W3 hardening) | Verified Locally (= 5X.1, 5X.2); zero cost until an `llm` rate is published; gates before the call are narrower than D29's first text |
| 7.W1.2 | Consent rule for visitor-typed contact details (the plan's W3 hardening) | Verified Locally (= 5X.3); covers the website chat only |
| 7.W1.3 | Kill switches on the public pages (proposals, invoices, reviews, website chat) | Verified Locally (= 5X.2, 5X.5); none run with the switch on in a deployed environment |
| 7.W1.4 | Super Admin page to switch modules on per workspace (the plan's 7G gap, for the six Wave 1 modules only) | Verified Locally; Browser-QA'd (= 5X.4); not a generic registry for every dormant feature |
| 7.W1.5 | Key rotation (`decryptSecret` does not read `APP_ENCRYPTION_KEY_PREVIOUS`), a default statement timeout (`withUser` takes one only if a caller passes it; the default is none), CI (no `.github/workflows` in the tree) | Not Started (the rotation limit is documented in `docs/invoices-and-payments.md` and `blockers.md`, not changed) |

## Release checks (before the final GO / NO-GO report)

| Id | Task | State |
| --- | --- | --- |
| R.1 | Scheduler job allowlist is explicit and fails closed | Verified Locally, two defects fixed |
| R.2 | Inbox search optimization preserves tenant isolation | Verified Locally, one defect fixed; performance follow-ups recorded |
| R.3 | All-workspaces rollout test is isolated and touches no production setting | Verified Locally, two defects fixed |
| R.4 | AI Workforce and Inbox commits and the dirty master tree are preserved | Verified (forensic, read-only); the Phase 3 and 4 commits are not pushed |
| R.5 | Combined migration rehearsal over 0001 to 0090 incl. 0081 to 0083 | Verified Locally (embedded Postgres 18.3) |
| R.6 | Report separates code readiness from rollout readiness | Done: `evidence-report-2026-10-23.md` |
| R.7 | Export leak of staff-only project notes; stale-quote revival | Verified Locally, fixed with tests |
| R.8 | Migration 0090, the shared document buckets | Verified Locally |

