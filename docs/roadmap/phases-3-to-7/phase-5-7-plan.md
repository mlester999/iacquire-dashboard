# Phases 5 to 7: audit result and build plan

Source: eight read-only audits run on 2026-10-23 over this tree at `9a495af` and over all 65 branches and 46 worktrees (full texts in `audit/`). "Existing" means a reviewer read the code; nothing here was run against a real provider. The Phase 4 review (82 agents) is in `audit/phase-4-review-confirmed-findings.md`.

## 1. Implementation matrix (what exists today)

| Area | State | Headline |
| --- | --- | --- |
| 5A Proposals | **Missing** | No tables, services, PDF writer or catalog on any branch. The agency-to-client quote flow (`project_quotes`, hash-bound append-only `quote_approvals`) is the pattern to copy, not to reuse. No tenant price book exists. |
| 5B E-signature | **Missing** | No provider integration anywhere. Needs a provider account (blocked-external). Local part: provider seam, simulated provider, honest "not connected", webhook handling on signed fixtures. |
| 5C Customer invoices | **Missing** | iAcquire's own billing (`src/server/billing/*`, PayMongo for credits and the setup fee) is a different financial domain and must stay separate. No exponent-aware money code existed (now `src/lib/money`). |
| 5D Customer payments | **Missing** | No client-owned PayMongo or PayPal connection, no per-tenant webhook endpoint. The Lead Sources report is ready for a verified-revenue feed (`SourceRow.verifiedRevenue` is hard-coded null, `src/server/attribution/report.ts:116`). |
| 5F Reviews | **Existing, partial** | Private half is real and tested (`crm/reviews.ts`, `/r/<token>`, feedback, funnel). Nothing for Google Business Profile or Facebook reviews, NPS/CSAT, reply drafting, batch asks. |
| 5G Retention | **Existing, partial** | Five owner-approved message programs (`src/server/retention/*`). Feedback program has no link; renewal reminders absent. |
| 6A to 6C, 6F Requests Center | **Existing, mature** | Support & Requests (0065) and Custom Projects (0015) are complete and tested. Missing: Request a Change, mentions, surveys, persisted AI triage, change-order ledger, unified My Requests. |
| 6D Staff Messages | **Missing** | Nothing on any ref. Agency permission framework and notification/realtime precedents exist. |
| 6E Workload | **Missing** | Only per-module assignees; no engine, capacity or labels. |
| 7B Six employees | **Existing, fail-closed** | Readiness is honest, but pauses are not applied to AI work jobs, readiness has seven weaker duplicate definitions, customer replies are unmetered. No client employee has a Hermes profile in production. |
| 7C Onboarding | **Existing, mostly real** | One questionnaire, hashed invitations, employees "Setup required" until a health check passes. **No payment gate on activation or provisioning.** |
| 7D Demo funnel | **Missing** | Only `/get-started` writing `access_requests`. `isDemo` is a seeded-sample flag, not a funnel. |
| 7E Billing | **Existing, manual** | PayMongo credits and signed webhook (mocks only); manual maintenance lifecycle; no PayPal; refunds and manual receipts never reach `payments`; `paid_through_on` never enforced. |
| 7F Storage, integrations | **Existing, partial** | Managed-vs-connected entitlement exists only for social media; Drive and OneDrive exist nowhere; key rotation unsupported for app-sealed secrets. |
| 7G Super Admin | **Existing, broad** | No generic feature-rollout registry, no security-events page, no provider probes. |
| 7I Performance | **Existing for CRM and Inbox only** | No harness for web chat, attribution, social; no statement timeouts on most paths; no hosted measurement (no staging). |
| 7J Security | **Strong baseline** | All 306 tables have RLS, every route has a guard. Defects are in newest code and cost controls (below). |
| 7L Launch operations | **Weakest** | No CI on any mainline ref, scheduler never run in production, preflight covers only 0077-0081, several documents stale. |

## 2. Defects found in code that already exists (fix list)

| Sev | Defect | Where | Planned in |
| --- | --- | --- | --- |
| high | **Setup payment is never checked** before activation or AI-employee provisioning (an unmerged automated provisioner would claim unpaid clients) | `setup/agency.ts:482`, `workforce/provisioning.ts:143` | W2-C |
| high | **Client data export includes staff-only `internal_notes`** of project requests and quotes | `offboarding/export.ts:117,190` | W0 sweep |
| high | Website-chat AI replies and social AI drafts are **never metered or capped**; cost exposure is bounded only by per-address limits | `webchat/generator.ts`, `llm/client.ts:51` | W3 hardening |
| high | Visitor-typed contact details are recorded as consented although unverified; a workflow or staff can message a third party | `webchat/visitor.ts:373` | W3 hardening |
| high | Offboarding shutdown leaves calendar tokens, social tokens, Studio secrets and API keys live; AI work jobs, schedules and lead research ignore pauses and suspension | `offboarding/service.ts:218`, `workforce/capability-dispatch.ts:56` | W3 hardening (social part in Phase 4 fixes) |
| high | `META_GRAPH_VERSION` regex lost its backslashes; the documented value crashes `env()` | `env.ts:107` | Phase 4 fixes |
| high | `redactContact` leaves private feedback comments; contact merge leaves feedback behind and names three tables that do not exist | `messaging/contacts.ts:235,241` | W1-C |
| medium | Retention non-customer search has a mangled regex and fails at runtime | `retention/service.ts:238` | W1-C |
| medium | A stale quote can be accepted after a project was cancelled or held, reviving it | `projects/client.ts:382` | W0 sweep |
| medium | Manual setup payment ("paid") needs no amount, method, evidence or reason; refunds and manual receipts never reach the money table | `admin/tenants.ts:370`, `billing/payments.ts` | W2-C |
| medium | `paid_through_on` is stored and shown but never enforced; two sources of truth for entitlement | `automation-studio/plan.ts:60`, `social/media.ts:37` | W2-C |
| medium | `decryptSecret` ignores `APP_ENCRYPTION_KEY_PREVIOUS`: rotating the key orphans every sealed secret | `security/crypto.ts:72` | W3 hardening |
| medium | `withUser`, `withSystem`, `withServiceRole` have no statement timeout; pool of 4 shared with public endpoints | `db/index.ts:286` | W3 hardening |
| medium | Low feedback does not stop retention messages or raise an inbox escalation; rating-less complaints create nothing | `crm/reviews.ts:1006` | W1-C |
| medium | Agency payments webhook cannot persist an `error` outcome, so its alarms are unreachable | `billing/payments.ts:136` | W3 hardening |
| medium | Price-grounding guard accepts an invented price that is a substring of an approved one | `webchat/generator.ts:60` | Phase 4 fixes (AA) |
| medium | `app.permitted_orgs` lets assigned staff read approvals, activity and leads without an audited session | `0042`, `0060` | W3 hardening |
| medium | Onboarding re-submission silently reverts later Settings edits (two writers) | `onboarding/service.ts:640` | W2-C |
| medium | No CI on any mainline ref; Vercel deploys master on push | repo | W3 hardening |

Lower-severity items are in the audit files, each with a file and line.

## 3. Migration number plan

Numbers up to **0089** are used on this branch. Check with `node scripts/rehearse-phase4-migrations.mjs` (section A) before creating one: other branches may take a number. Allocation:

| Number | Owner | Content |
| --- | --- | --- |
| 0090 | lead | `proposal-documents` and `staff-message-files` buckets and the `app.file_permission` rule (one migration, so later migrations never re-create the function) |
| 0091 to 0092 | W1-A | proposals; e-signature |
| 0093 | W1-B | customer invoices and payments |
| 0094 to 0095 | W1-C | reputation follow-through and surveys; external reviews |
| 0096 to 0097 | W2-A | staff messages; staff workload |
| 0098 | W2-B | requests completion (change requests, mentions, surveys, triage record) |
| 0099 to 0103 | W2-C, W3 | payment clearance and manual payment records; demo funnel prospects; purchase intents; hardening (timeouts, indexes) |

Rules every migration follows (see 0089): additive; workspace-keyed with composite `(id, org_id)` foreign keys; RLS on; the application role gets SELECT only through `app.permitted_orgs(<view permission>)`; nothing for anon, authenticated, public or the published-site role; secret columns never granted; notification kinds extended by reading the live constraint; a rollback that refuses while data exists; a rehearsal on embedded Postgres.

## 4. Cross-module decisions

* **Money:** `src/lib/money` (integer minor units, per-currency exponent, BigInt intermediates, per-line rounding, totals are sums of rounded lines). Proposals and invoices both use it. It is not iAcquire's own billing code.
* **PDF:** no new dependency. One small deterministic PDF writer (standard fonts, Latin text, currency shown as a code) owned by W1-A under `src/lib/pdf`. Invoices use a print page instead of a PDF.
* **Gating:** every new module is dormant until a Super Admin enables it for a workspace (`org_features`, absent means off), and public pages and webhooks have an environment kill switch. Entitlement placement (core, managed plan, or per workspace) is the founder's; engineering puts one entitlement seam in front and invents no price.
* **Permissions:** new permission names are added to `src/lib/permissions.ts`, the SQL `role_permissions` seed and the agency-team protected list in the same change; agency staff reach client finances only through the audited support session if the founder adds it.
* **Public links:** a bearer link is a credential: derived token, hash-only storage, never in message bodies, logs, audit rows, AI context or exports; `no-referrer`, `no-store`, `noindex`; per-IP rate limit checked before any token lookup.
* **AI:** every AI result is a draft; no field for prices or totals in AI output; usage is metered and charged like the Hermes path (see the hardening wave); no seventh employee; the Performance Analyst gains read-only review capabilities only.
* **Provider seams:** one adapter interface per domain with a simulated provider refused in production, sealed credentials with no column grant, an environment switch for any real write, and honest "not connected" states.
* **Finance separation:** customer invoices and payments never write to or read from iAcquire's `payments`, `payment_webhook_events`, `credit_ledger_entries`, `billing_accounts` or `agency_finance_entries`.

## 5. Waves (each followed by an adversarial review and a browser check)

| Wave | Content | Gate |
| --- | --- | --- |
| W0 | Defect sweep: export leak, stale-quote acceptance, retention search regex | tests, then with Phase 4 |
| W1 | A proposals + PDF + e-signature seam; B customer invoices, payments, verified revenue; C reputation and retention | review, QA |
| W2 | A staff messages and workload; B requests completion; C payment clearance, entitlement, onboarding gaps, demo funnel | review, QA |
| W3 | Hardening (metering, consent identity, pauses, timeouts, key rotation, kill switches, CI, documents), end-to-end scenarios, performance measurement, final report | full gates |

Checkpoint rule: every checkpoint ends with the full suite, both typechecks, lint, a clean build, the migration rehearsal on embedded Postgres, and a ledger update. Nothing is pushed or applied to a hosted database without approval.

## 6. Founder decisions collected from the audits

Grouped; each audit file lists its own in full.

* **Money and providers:** collection model for customer payments (client's own account, recommended); PayMongo and PayPal roles and the currencies clients invoice in; who opens the sandbox accounts and supplies test keys; whether iAcquire takes any fee; credential storage for money-moving keys (Supabase Vault, recommended, versus the app-sealed column used by social); per-client live go-live gate; e-signature provider (PandaDoc recommended) and per-client versus master account; recurring billing mechanism for the US$299 plan.
* **Entitlement placement (no price invented):** where proposals, e-signature, invoicing and reminders, review features, social media, web chat, lead scoring and missed-call recovery sit relative to the US$1,499 implementation and the US$299/month plan; storage allowances and lapse rules.
* **Legal and consent (counsel):** acknowledgement text for proposal acceptance (never described as an electronic signature unless a provider verified it); invoice and tax wording and numbering; retention versus erasure of signed documents and invoices; review-request and reply rules (no review gating, no incentives); web-chat consent and privacy notice; staff-message monitoring notice.
* **Policy numbers:** workload point weights and label thresholds; survey and feedback thresholds and SLAs; reminder cadence; demo window, message count, extension caps, daily AI spend; revision and warranty defaults for custom projects; grace period for past-due plans.
* **Operations:** port or rebuild the restricted Hermes provisioner (and the VPS steps); scheduler plan (Vercel plan, cadence); staging project; CI and error tracking; external penetration test; key-rotation procedure; which dormant features move under a rollout registry.
* **Existing clients when the payment gate lands:** waive, require payment, or grandfather by date.

## 7. What is not claimed

Nothing in Phases 3 to 7 has run against a real provider, a real language model, a hosted database or a real customer. Every status is "Built" or "Verified locally (embedded Postgres, simulated providers, signed fixtures)" until a row in `verification-evidence.md` says otherwise.
