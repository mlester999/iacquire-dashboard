# ENTITLE — Automation Studio entitlements and payments

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Domain summary (read-only audit, branch claude/ai-growth-partner-completion at 6e4a4b7e; includes the PayPal wording fix 60a35f4b):

- Automation Studio entitlement is genuinely server-side. One pure rule (`entitlementFor`, src/lib/automation-studio/plan.ts:53) is applied through one reader (`readCurrentPlan`/`workspaceEntitlements`, src/server/entitlements.ts) and consumed by the shell menu, every Studio service gate, the workflow engine, the inbound-webhook door, the Blueprint writer and managed media storage. Tests run on embedded Postgres, include a source-scan that fails if another file decides an entitlement from the plan table, and prove core CRM / inbox / employees / website / booking are never gated.
- The commercial facts ($1,499 setup, $299/month optional plan, usage separate) are frozen in code (`SETUP_FEE_USD`, `MAINTENANCE_MONTHLY_USD`) and, for purchases, in database CHECK constraints (migration 0101: 149900 / 29900). The plan price a workspace pays is snapshotted on its `maintenance_subscriptions` row, but the number a NEW enrollment snapshots comes from the editable service catalog with no check against $299.
- The $299 plan is activated by a PERSON recording a verified payment (agency member or Super Admin), by a PayMongo (deferred provider) month-by-month checkout, or by a PayPal Subscription that has never run against PayPal. There is no PayPal one-off path for plan months, and selecting "maintenance" on a purchase is only recorded, never turned into a plan request.
- PayPal setup-fee checkout is the most mature payment path: real PayPal Sandbox order, server-side capture, signed webhook and refund notice were exercised on the live site on 2026-11-03 (recorded in docs/paypal-sandbox-safety-release-2026-11-03.md sections 13-14; I did not re-run anything). Sandbox money on the live site is recorded but provably applies nothing (`isLiveDeployment()` guards in payments.ts:276, purchase-intents/checkout.ts:316, maintenance/agreement.ts:205).
- Webhook handling is strong: signature verified before parsing (PayPal by asking PayPal), event-id receipt ledger with row lock, org taken only from OUR stored row, reference/mode/amount/currency must all match, refunds/disputes are reported to a person and never applied.
- Biggest gaps: (1) the Growth Partner <-> Studio hand-off is a fixed chat string, not entitlement-aware, untested, and `studioHandoffAccess` is dead code; (2) maintenance payments are PayMongo-only and the PayMongo/maintenance/top-up checkouts have no per-product enable switch; (3) `maintenance_selected` never creates a plan request; (4) every plan sweep/renewal job depends on a scheduler that has never run in production, and an active plan past its paid-through day stays entitled until a human acts; (5) PayPal Subscriptions are unverified and blocked on a founder-created sandbox plan; (6) Growth Partner/Hermes model usage is not metered into the credit ledger (usage "charged separately" only exists for messaging sends).
- Evidence caveat: no statuses here are COMPLETE — VERIFIED; the orchestrator upgrades after the baseline run. Prior recorded runs (docs) are kept separate from what I read in code.

---

<a id="gp-entitle-01"></a>
### GP-ENTITLE-01 — Commercial terms preserved: $1,499 setup, optional $299/month, usage separate

- **Requirement:** Commercial terms preserved: $1,499 setup, optional $299/month, usage separate (directive §20, §21)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/billing.ts:7`, `src/lib/automation-studio/plan.ts:9`, `src/lib/purchase-intents/rules.ts`, `supabase/migrations/0101_purchase_intents.sql:20`, `supabase/migrations/0015_custom_projects.sql:804`, `src/server/maintenance/service.ts:201`, `src/server/maintenance/service.ts:230`, `src/server/catalog/service.ts:125`, `src/server/billing/ledger.ts`, `src/server/llm/meter.ts`
- **Test coverage:** tests/automation-studio-plan.test.ts ("quotes the approved commercial terms from one place"); tests/purchase-intents-migration.test.ts and tests/purchase-intents.test.ts (frozen price, DB refuses another figure); tests/billing-plan-controls.test.ts, tests/maintenance-provider-payment.test.ts ("takes the amount from the plan whatever the months are"); tests/billing-lifecycle.test.ts. They prove amounts come from the stored row and not from a request. They do NOT prove the catalog price a new enrollment copies equals $299, and nothing tests that a Super Admin catalog edit cannot change what a new enrollment is charged.
- **Real or simulated behavior:** Constants and DB CHECK constraints are real (purchase intents freeze 149900/29900). A workspace plan price is copied from the editable service catalog at enrollment with no check against $299. The credit ledger is real but only meters provider messaging sends; Growth Partner/Hermes model usage is not metered.
- **Missing dependencies:** Founder decision on whether the catalog may ever differ from $299 and whether Growth Partner/Hermes model usage is charged (today it is not metered at all: no match for the meter/ledger in src/server/hermes, chat, workforce, ai-growth-partner).
- **Remaining work:** Guard requestMaintenanceEnrollment (src/server/maintenance/service.ts:201) against a catalog price other than MAINTENANCE_MONTHLY_USD and audit it; add a test; decide and wire or disclaim Growth Partner usage metering via src/server/billing/ledger.ts; confirm provisional fair-use limits with the founder.
- **Verification evidence:** Read code and migrations above. Docs claim (billing-and-entitlements.md, purchase-intents.md) that the price is frozen at purchase: true for purchase intents (DB CHECK); only partly true for plan enrollment (frozen after enrollment, but chosen from an editable catalog). No run by me.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No purchase or enrollment path can record a price other than $1,499/$299 without an audited Super Admin override; tests prove it; copy about usage matches what the ledger actually charges.

<a id="gp-entitle-02"></a>
### GP-ENTITLE-02 — Entitlement decision and server-side enforcement, including tenant isolation of Studio data

- **Requirement:** Entitlement decision and server-side enforcement, including tenant isolation of Studio data (directive §20)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/automation-studio/plan.ts:53`, `src/lib/entitlements.ts`, `src/server/entitlements.ts:28`, `src/server/automation-studio/entitlement.ts:20`, `src/server/crm/workflows/definitions.ts:392`, `src/server/crm/workflows/definitions.ts:587`, `src/server/crm/workflows/definitions.ts:770`, `src/server/crm/workflows/runs.ts:294`, `src/server/crm/workflows/runs.ts:364`, `src/server/crm/workflows/runner.ts:214`, `src/server/crm/workflows/inbound.ts:154`, `src/server/automation-studio/builder/service.ts:170`, `src/server/automation-studio/connections.ts:120`, `src/server/crm/blueprints/native-io/write.ts:76`, `src/app/actions/automation-studio.ts`, `supabase/migrations/0071_automation_studio_plan_lookup.sql`
- **Test coverage:** tests/entitlements-matrix.test.ts (all plan states agree across helper, gate, shell, media policy; source scans that no other code reads the plan table and that every plan question sits on a premium path, with a negative control; core modules still work for lapsed/never-planned workspaces); tests/entitlements-rules.test.ts; tests/automation-studio-engine.test.ts ("building in Automation Studio needs the plan, on the server", "refuses every way of changing or starting a premium workflow once the plan lapses, but never reading, pausing or archiving", "answers an inbound webhook for a lapsed premium workflow with 409", "keeps one workspace's lapse away from another's"); tests/automation-studio-hardening.test.ts ("tenant isolation of the new tables", migration rollback checks, Blueprint gate); tests/automation-studio-builder.test.ts:392 (another workspace's workflow does not exist for you); tests/automation-studio-connections.test.ts:268; tests/storage-entitlement.test.ts; tests/payment-gate.test.ts. These prove the gates and isolation on real Postgres. Not proven: RLS does not protect `crm_workflows` writes for Studio (services use `withSystem` with explicit `org_id` predicates), so isolation of workflow mutations rests on application predicates plus the tests above; no test drives the HTTP route/server action with a cross-tenant id for every Studio action.
- **Real or simulated behavior:** Real server gates on embedded Postgres; no mocks of the unit under test. Workflow mutations are isolated by explicit org_id predicates via withSystem (RLS covers only the new Studio tables, select-only).
- **Missing dependencies:** none external.
- **Remaining work:** Add a parameterised cross-tenant test over every exported Studio service/action; consider an RLS/trigger backstop refusing origin='studio' publishes for un-entitled workspaces; remove or use studioHandoffAccess. | Skeptic adds: Document and test the exact premium boundary: only origin 'studio', http_request and slack_message steps need the plan; ai_task and send_message in a crm-origin workflow do not (derivePremiumFeatures). Add a test that pins this list so a new premium step kind cannot be added without a gate.
- **Verification evidence:** Read all call sites and the test titles above. Prior recorded runs: docs/automation-studio/production-audit-2026-10-22.md and billing-and-entitlements.md say migrations 0069-0072 are applied to production and the Studio matrix passes; I did not run tests or touch production.
  - *Skeptic review: Enforcement is real and server-side, but its scope is narrower than the row implies.*
  - *Baseline: 8 of 8 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every Studio entry point is proven to refuse an un-entitled or foreign-workspace request, a failing test exists if a new premium path omits the gate, and the baseline run is green.

<a id="gp-entitle-03"></a>
### GP-ENTITLE-03 — Locked preview and upgrade experience for workspaces without the plan

- **Requirement:** Locked preview and upgrade experience for workspaces without the plan (directive §20)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/automation-studio/views.tsx:53`, `src/components/automation-studio/views.tsx:112`, `src/components/automation-studio/upgrade-page.tsx`, `src/components/automation-studio/upgrade-visuals.tsx`, `src/server/queries/shell.ts`, `src/app/(portal)/automation-studio/page.tsx`
- **Test coverage:** tests/automation-studio-upgrade-page.test.tsx (price stated once, setup separate, provisional allowances, what keeps working, CTA to Maintenance, non-owners told why, example is labelled, script accepted by the real workflow spec, reduced-motion behaviour); tests/automation-studio-nav.test.tsx (lock icon and spoken reason); tests/automation-studio-screens.test.tsx. These are render/jsdom tests; they prove wording and behaviour, not a browser pass.
- **Real or simulated behavior:** Server-rendered decision from the real entitlement; the animated example is a scripted DOM/SVG demonstration, labelled as an example, by design.
- **Missing dependencies:** none.
- **Remaining work:** Signed-in browser QA at 375 and 1024 px for the locked home, read-only workflow page and lapse notice; re-read Studio copy for one-Growth-Partner language.
- **Verification evidence:** Read views.tsx, plan.ts copy and test titles. Prior recorded browser QA is in docs/automation-studio/studio-ui-and-builder.md and memory notes; not re-observed.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A client without the plan sees the locked preview with the true price and what keeps working, cannot reach editing controls, and every CTA leads to the real request/payment flow, verified in a browser on phone and desktop.

<a id="gp-entitle-04"></a>
### GP-ENTITLE-04 — Studio authoring-to-run lifecycle: draft, test, approve, activate, retry, logs

- **Requirement:** Studio authoring-to-run lifecycle: draft, test, approve, activate, retry, logs (directive §20)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** no
- **Source files:** `src/server/automation-studio/studio.ts`, `src/server/crm/workflows/definitions.ts`, `src/server/crm/workflows/approvals.ts`, `src/server/crm/workflows/runs.ts:280`, `src/server/crm/workflows/runner.ts`, `src/server/crm/workflows/executors.ts:739`, `src/server/automation-studio/usage.ts`, `src/server/automation-studio/connections.ts`, `src/server/automation-studio/outbound.ts`, `src/app/actions/automation-studio.ts`
- **Test coverage:** tests/automation-studio-engine.test.ts (premium run counted, run held when plan lapses then finished after a person re-enables, fair-use limits, grace/lapse/reactivation, scheduler job registered); tests/automation-studio-hardening.test.ts ("usage metering of failures and retries" counts retryable failure and retry once each); tests/automation-studio-templates-run.test.ts, automation-studio-templates.test.ts, automation-studio-starters.test.ts; tests/automation-studio-connections.test.ts (approval per version, outbound limits, calls logged); tests/automation-studio-operations.test.ts; tests/automation-studio-scheduler-rehearsal.test.ts (controlled rehearsal); tests/crm-webhooks.test.ts. Real-path where database-backed; outbound HTTP tests use a replaced network layer.
- **Real or simulated behavior:** Real engine and Postgres in tests; test runs are dry-run simulations that send nothing; outbound HTTP tests use a replaced network layer; the production scheduler has never run.
- **Missing dependencies:** Production scheduler has never run (docs/automation-studio/open-decisions.md item 9: no `CRON_SECRET`/`SCHEDULER_ENABLED`; `/api/health` says `scheduler: never_ran`). Founder approval to start the scheduler. Slack OAuth / Gmail / Sheets connectors need founder-registered apps (items 8, 13).
- **Remaining work:** Staged scheduler activation in a preview deployment with a recorded end-to-end run; confirm client-visible run logs in the signed-in UI; founder confirmation of provisional limits.
- **Verification evidence:** Read engine and tests. Prior recorded: docs/automation-studio/production-audit-2026-10-22.md (hosted DB has 0 workflows/runs; migrations applied), scheduler rehearsal test; the engine has never run a scheduled job in production.
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** In an isolated deployment with the scheduler on, a premium workflow goes draft, test, owner approval, switched on, a real triggered run with a retried failed step logged, lapse pauses it, reactivation needs a person, all visible and audited.

<a id="gp-entitle-05"></a>
### GP-ENTITLE-05 — AI Automation Builder against a real model

- **Requirement:** AI Automation Builder against a real model (directive §20)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** real-model-verified  |  **Unblocked now:** no
- **Source files:** `src/server/automation-studio/builder/service.ts:170`, `src/server/automation-studio/builder/prompt.ts`, `src/server/automation-studio/builder/guard.ts`, `src/server/automation-studio/builder/claims.ts`, `src/app/api/automation-studio/[id]/chat/route.ts`, `scripts/run-builder-eval.mjs`, `tests/support/builder-eval.ts`, `src/lib/crm/workflow/spec.ts:461`
- **Test coverage:** tests/automation-studio-builder.test.ts, tests/automation-studio-builder-guards.test.ts (injection, endpoint refusal, claims), tests/automation-studio-canvas.test.ts, tests/automation-studio-editor-hook.test.tsx. These use a scripted model, so they prove plumbing and guards, not model quality.
- **Real or simulated behavior:** Production path calls the workspace's real OpenAI-compatible model; vitest uses a scripted model (plumbing and guards only). The recorded real-model evaluation (DeepSeek, 2026-10-21, 102/105 scenarios) is from docs and was not re-run by me.
- **Missing dependencies:** A configured model key for any fresh evaluation (paid model spend; founder approval). No live model call was made by me.
- **Remaining work:** Re-run scripts/run-builder-eval.mjs on the model/prompt used after the Growth Partner conversion; decide whether new client workspaces offer only growth_partner in ai_task/send_message (spec.ts:461,534) and update prompt employeeCatalog and validation accordingly.
- **Verification evidence:** Read code. Prior recorded run (docs/automation-studio/ai-evaluation.md, 2026-10-21): 35 scenarios x 3 repeats, 102/105 scenarios and 114/117 turns passed with a real DeepSeek model, median 3.0 s, p95 6.2 s; kept separate from my own observation (none).
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
  - *The evidence class rests on EARLIER RECORDED evidence (see 'Real or simulated'); it was not re-run in this audit and may predate the Growth Partner conversion.*
- **Definition of done:** A fresh real-model evaluation on the current prompt passes at or above the recorded rate with Growth Partner wording, and a refusal scenario proves the builder never builds a payment or charge step.

<a id="gp-entitle-06"></a>
### GP-ENTITLE-06 — Growth Partner integration respects workflow permissions and the plan

- **Requirement:** Growth Partner integration respects workflow permissions and the plan (directive §20)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/chat/service.ts:2824`, `src/lib/workforce-chat-routing.ts:7`, `src/server/automation-studio/entitlement.ts:29`, `src/server/crm/workflows/executors.ts:739`, `src/server/crm/workflows/permissions.ts`, `src/lib/ai-growth-partner-capability-access.ts`, `src/server/ai-growth-partner/capability-access.ts`, `src/lib/crm/workflow/spec.ts:739`
- **Test coverage:** tests/workforce-chat-routing.test.ts (the detector only); tests/employee-chat-quality.test.ts:105; tests/automation-studio-engine.test.ts and automation-studio-templates-run.test.ts for `ai_task` on a lapsed plan. There is NO test that exercises the chat hand-off message for the three states (no `workflows.view`, no plan, no `workflows.manage`), nothing grepped for "Building automations belongs" in tests, and no test that the Growth Partner conversation never claims to have built/activated a workflow.
- **Real or simulated behavior:** The chat hand-off is a fixed string selected by workflows.view / org kind / workflows.manage; it never checks the plan (studioHandoffAccess has zero callers). The Growth Partner cannot create or activate workflows. Workflow ai_task steps re-check agent state, mode and owner approval for real.
- **Missing dependencies:** none external; needs the Growth Partner copy decisions from the product-conversion workstream.
- **Remaining work:** Call studioHandoffAccess in src/server/chat/service.ts:2824 and make the reply truthful when the plan is missing; add tests for all hand-off states; decide on a read-only Studio capability; decide whether ai_task/send_message should accept only growth_partner for new client workspaces.
- **Verification evidence:** Read service.ts:2824-2836, entitlement.ts:29, spec.ts; `studioHandoffAccess` found only at its definition (grep across src and tests). The comment in entitlement.ts:24-28 claiming chat uses it is NOT backed by code (doc claim noted in the JSON result).
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Asking the Growth Partner to build an automation gives a permission- and plan-correct answer in every state, never creates a workflow or sends email; tests prove each state; Studio ai_task steps work with the Growth Partner and respect its mode and approval.

<a id="gp-entitle-07"></a>
### GP-ENTITLE-07 — $299 plan activation, renewal, lapse and reactivation

- **Requirement:** $299 plan activation, renewal, lapse and reactivation (directive §20, §21)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** no
- **Source files:** `src/server/maintenance/service.ts:201`, `src/server/maintenance/service.ts:436`, `src/server/maintenance/payment.ts`, `src/server/maintenance/lapse.ts`, `src/server/maintenance/renewal.ts`, `src/server/automation-studio/lifecycle.ts:42`, `src/server/automation-studio/lifecycle.ts:99`, `src/lib/automation-studio/plan.ts:103`, `src/lib/automation-studio/plan.ts:111`
- **Test coverage:** tests/automation-studio-engine.test.ts "the plan's lifecycle" (grace, pause, reactivation, agency-only access, workspace separation); tests/maintenance.test.ts; tests/billing-lifecycle.test.ts; tests/billing-renewal.test.ts; tests/billing-plan-controls.test.ts; tests/maintenance-admin-activation.test.tsx; tests/automation-studio-plan-lifecycle.test.tsx; tests/payment-gate.test.ts ("the maintenance plan waits for the setup payment too"); tests/requests-maintenance.test.ts. Real Postgres; no provider.
- **Real or simulated behavior:** Real service code and DB transitions; 'verified payment' is a person's attestation or a provider-confirmed event; sweeps and renewal jobs have never run in production (scheduler off, auto_past_due off); an active plan past its paid-through day stays entitled until a person acts.
- **Missing dependencies:** Production scheduler never run (renewal job `maintenanceRenewalSweep`, `studioEntitlementSweep` have never run outside tests; `agency_billing_settings.auto_past_due` is off by default). Founder policy decision (documented by design): an `active` plan whose paid-through day has passed stays entitled until a person records a failure or auto past-due is on and the scheduler runs (src/lib/entitlements.ts comment; entitlements-matrix test names it).
- **Remaining work:** Staged scheduler rehearsal of maintenanceRenewalSweep and studioEntitlementSweep in a preview environment; decide auto_past_due; verify the 'paid period ended' alert in /admin/maintenance.
- **Verification evidence:** Read lifecycle.ts, payment.ts, plan.ts. Prior recorded: docs/billing-and-entitlements.md says built and locally verified, jobs never ran in production.
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A paying $299 client gets Studio when the first verified payment applies, loses it at the exact end of the disclosed grace period with workflows paused, regains it on a verified payment with each workflow re-enabled by a person, and the sweep runs on schedule in production with recorded evidence.

<a id="gp-entitle-08"></a>
### GP-ENTITLE-08 — Purchase 'maintenance selected' never becomes a plan request

- **Requirement:** Purchase 'maintenance selected' never becomes a plan request (directive §20, §21)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/purchase-intents/service.ts:40`, `src/server/purchase-intents/service.ts:446`, `src/server/purchase-intents/service.ts:628`, `src/server/maintenance/service.ts:201`, `docs/purchase-intents.md`
- **Test coverage:** tests/purchase-intents.test.ts, tests/purchase-checkout.test.ts (provisioning); no test asserts what happens to a client who selected maintenance, which matches the code.
- **Real or simulated behavior:** Real code; the selection is stored, shown in emails and timeline, and otherwise ignored at provisioning (documented as by design).
- **Missing dependencies:** Founder decision on the desired journey (docs say "a recurring-billing decision and a provider account"). The terms acceptance must remain an explicit owner action.
- **Remaining work:** After provisioning, if maintenance_selected, show the owner a prominent start-plan card leading to /maintenance (requestMaintenanceEnrollment with acceptTerms) and notify the agency; never auto-create a billable subscription; add tests.
- **Verification evidence:** Read service.ts and purchase-intents.md; grep shows `maintenanceSelected` is read only for display/delivery/timeline (service.ts, invitations.ts, create-form, workspace, public-purchase, delivery.ts).
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A buyer who ticked the $299 plan is led through owner-accepted enrollment and activation without anyone remembering to do it by hand; a buyer who did not sees only the optional upgrade page.

<a id="gp-entitle-09"></a>
### GP-ENTITLE-09 — PayPal checkout for the $1,499 setup purchase

- **Requirement:** PayPal checkout for the $1,499 setup purchase (directive §21)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** no
- **Source files:** `src/server/purchase-intents/checkout.ts:74`, `src/server/purchase-intents/checkout.ts:198`, `src/server/purchase-intents/checkout.ts:276`, `src/server/purchase-intents/checkout.ts:385`, `src/server/purchase-intents/checkout.ts:436`, `src/server/billing/providers/paypal.ts`, `src/server/purchase-intents/availability.ts`, `src/server/purchase-intents/service.ts:628`, `src/app/api/webhooks/paypal/route.ts`
- **Test coverage:** tests/purchase-paypal-checkout.test.ts (readiness; order opened for the frozen US$ fee with our reference; no second order; capture only counts when PayPal says COMPLETED; idempotent return/reload; a reference of another buyer cannot move anything; amount/currency mismatch held; forged notice refused before reading; replay is a duplicate; refund/dispute/duplicate reported; lost return page and lost notice recovered by the sweep); tests/purchase-checkout.test.ts (same rules for the other provider, auto-provision permission checks, holds and releases); tests/sandbox-isolation.test.ts; tests/purchase-room.test.tsx; tests/paypal-simulator-guard.test.ts. Real Postgres, stand-in PayPal.
- **Real or simulated behavior:** Real code; tests use a replaced HTTP layer standing in for PayPal. Prior recorded (docs, not re-run by me): a real PayPal Sandbox order, server capture, signed notice and refund notice on the live site on 2026-11-03, with nothing applied because sandbox money is isolated on the live site.
- **Missing dependencies:** PayPal Sandbox evidence for denied payments, reversals, disputes, a repeated `PayPal-Request-Id` returning the same order, and the name `ORDER_ALREADY_CAPTURED` is still not proven (docs section 13). A Live-mode PayPal business account plus the payment/tax review is the founder's, and live remains intentionally off.
- **Remaining work:** Prove the full buyer, payment, workspace, setup-fee-cleared, Growth Partner provisioning chain once in a preview deployment using sandbox money (isLiveDeployment() false there); each remaining Sandbox scenario needs its own approval.
- **Verification evidence:** Read checkout.ts and PayPal adapter. Prior recorded runs (docs/paypal-sandbox-safety-release-2026-11-03.md sections 10-14, memory notes): real Sandbox payment US$1,499.00 captured and counted once through the capture response and the signed notice (2026-11-03 13:25-13:31 UTC), refund notice processed (23:24 UTC), nothing applied on the live site; PayPal specs confirmed 77 of 78 call assumptions. I did not call PayPal.
  - *Skeptic review: live-provider-verified overstates it. The recorded real Sandbox run (docs only) covered order, capture, signed notice and refund on the live site, where isLiveDeployment() forces record-only. The provisioning chain after a verified payment has never run against a real PayPal order.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A sandbox buyer pays in a preview deployment and a workspace with a cleared setup fee and one Growth Partner provisioning request appears exactly once; the same payment on the live site only records a labelled test purchase; every PayPal event type handled has been seen once from the real Sandbox.

<a id="gp-entitle-10"></a>
### GP-ENTITLE-10 — Webhook signature, receipt ledger, idempotency, audit and retry safety

- **Requirement:** Webhook signature, receipt ledger, idempotency, audit and retry safety (directive §21)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/billing/payments.ts:186`, `src/server/billing/payments.ts:203`, `src/server/billing/payments.ts:251`, `src/server/billing/payments.ts:371`, `src/server/billing/payments.ts:419`, `src/server/billing/payments.ts:475`, `src/app/api/webhooks/paypal/route.ts`, `src/app/api/webhooks/paymongo/route.ts`, `src/server/billing/providers/types.ts`, `src/server/billing/provider-health.ts`, `src/server/customer-payments/reconcile.ts`
- **Test coverage:** tests/billing.test.ts, tests/billing-providers.test.ts ("a second provider is one more adapter": same matching rules, adapter not ready, unverifiable delivery, unreadable payload), tests/billing-reported-events.test.ts, tests/billing-routes.test.ts, tests/purchase-paypal-checkout.test.ts, tests/purchase-checkout.test.ts, tests/payment-gate.test.ts ("a signed PayMongo payment for the setup fee": wrong amount/forged signature/foreign reference do not clear), tests/maintenance-provider-payment.test.ts ("is applied once"). Real Postgres; hand-written provider fixtures.
- **Real or simulated behavior:** Real shared handler on Postgres; provider payloads are hand-written fixtures. Signature verification: PayMongo HMAC; PayPal by asking PayPal. PayMongo has never run. Prior recorded live Sandbox events (docs) accepted a signed capture notice and a signed refund notice.
- **Missing dependencies:** Real Sandbox examples of denied, reversed and disputed PayPal events; "Check connection" still does not compare the four recommended events (docs section 12/15). PayMongo has never been run (deferred by founder).
- **Remaining work:** Add a test that a processing error in recordAndApply leaves no receipt row and the PayPal route returns 5xx; extend Check connection (src/server/billing/provider-health.ts) to compare the four recommended events; optional audit visibility for repeated signature failures. | Skeptic adds: Add a test that a PayPal webhook id from the other environment does not verify, because the adapter takes livemode from config, not from the event, so the event-mode versus signature-mode check cannot fail for PayPal. Also confirm withSystem runs recordAndApply in one rolling-back transaction before relying on the retry claim.
- **Verification evidence:** Read payments.ts, paypal route, adapter. Prior recorded: live Sandbox signed `PAYMENT.CAPTURE.COMPLETED` accepted (200) and recorded as a repeat; signed refund notice processed (docs section 14).
  - *Skeptic review: The mode-agreement guard is tautological for PayPal; safety rests on PAYPAL_WEBHOOK_ID being environment-bound.*
  - *Baseline: 8 of 8 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every provider event is applied exactly once, ignored with a recorded reason, or retried safely; a forged or replayed event changes nothing; the transactional-retry path is tested.

<a id="gp-entitle-11"></a>
### GP-ENTITLE-11 — No accidental live charging; clear sandbox vs production distinction

- **Requirement:** No accidental live charging; clear sandbox vs production distinction (directive §21)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/env.ts:117`, `src/server/env.ts:361`, `src/server/env.ts:430`, `src/server/billing/providers/paypal.ts`, `src/server/purchase-intents/availability.ts:44`, `src/server/purchase-intents/service.ts:732`, `src/server/maintenance/agreement-service.ts:43`, `src/server/maintenance/agreement-read.ts:91`, `src/server/customer-payments/switches.ts`, `src/server/billing/payments.ts:68`, `src/server/maintenance/service.ts:230`
- **Test coverage:** tests/environment-safety.test.ts, tests/sandbox-isolation.test.ts, tests/paypal-simulator-guard.test.ts, tests/purchase-paypal-checkout.test.ts ("keeps test and live apart"), tests/maintenance-agreement.test.ts (sandbox charge on the live site recorded but not applied), tests/customer-payments-production.test.ts, tests/customer-payments-test-checkout.test.ts. Prove the guards in tests; nothing proves absence of a live key in the real Vercel environment (read-only production preflight recorded in the PayPal safety doc section 4, not re-observed by me).
- **Real or simulated behavior:** Real switches and env guards (PAYPAL_ENVIRONMENT defaults to sandbox; live needs the payment/tax review plus a passed connection check on these exact credentials; simulator refused in production). The plan, setup-fee and credit top-up checkouts (createPaymentCheckout, PayMongo) have no per-product enable switch; only the purchase checkout and recurring billing do.
- **Missing dependencies:** Founder confirmation that no PayMongo live keys are set in production. Founder decision on whether the maintenance/setup-fee/credit-top-up PayMongo checkout needs its own switch.
- **Remaining work:** Add a default-off agency switch (migration plus audited Super Admin toggle) required by createPaymentCheckout for kinds maintenance, setup_fee and credit_topup; add a plain-words test/live readiness line on /admin/billing; tests proving refusal with the switch off even when keys and review exist.
- **Verification evidence:** Read the files above. Prior recorded production facts (docs/paypal-sandbox-safety-release-2026-11-03.md): checkout switch OFF, PayPal Production variables present with sandbox environment, no plan id, live site refuses Sandbox payments for plan/client invoices by design.
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No path can charge real money without a per-product Super Admin switch, the live-review confirmation, a passed connection check on the same credentials and a live PayPal environment; every admin and buyer screen says Sandbox/test or Live truthfully.

<a id="gp-entitle-12"></a>
### GP-ENTITLE-12 — Maintenance plan online payment is PayMongo-only (PayPal-first not met)

- **Requirement:** Maintenance plan online payment is PayMongo-only (PayPal-first not met) (directive §21)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/maintenance/service.ts:230`, `src/server/billing/payments.ts:68`, `src/server/billing/payments.ts:332`, `src/lib/billing-renewal.ts`, `src/server/billing/providers/paypal.ts`, `src/server/purchase-intents/checkout.ts`, `src/components/projects/maintenance-panel.tsx`
- **Test coverage:** tests/maintenance-provider-payment.test.ts (opens a checkout for the plan's own price and months; amount from the plan; activation gates; renew/reactivate; replay applied once; wrong amount mismatch; cancelled plan keeps money recorded; refund reported never removes). All PayMongo-shaped fixtures.
- **Real or simulated behavior:** Month-based plan payment, duplicate protection and applyMaintenancePeriod are real code; the only provider is PayMongo (deferred, never run). No PayPal one-off order path exists for plan months.
- **Missing dependencies:** PayPal Sandbox needs an isolated route because the live site refuses a Sandbox payment for plans (by design); a preview deployment with sandbox money is the isolated place.
- **Remaining work:** Add a PayPal checkout kind for plan months (payments row kind maintenance, USD, no FX) using openPaypalOrder/completePaypalOrder and recordAndApply with the same sandbox-on-live rule; offer PayPal first on /maintenance when providerReadiness('paypal') is available; add a PayPal twin of tests/maintenance-provider-payment.test.ts.
- **Verification evidence:** Read service.ts:230-248 and payments.ts:68-175; grep shows `paypal` appears in payments.ts only as a display name.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** An owner can pay 1-12 months of the $299 plan by PayPal; the plan extends only on PayPal's verified capture, once, with audit; PayMongo remains available but second.

<a id="gp-entitle-13"></a>
### GP-ENTITLE-13 — PayPal automatic monthly payment (Subscriptions) for the $299 plan

- **Requirement:** PayPal automatic monthly payment (Subscriptions) for the $299 plan (directive §21)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** no
- **Source files:** `src/server/maintenance/agreement.ts`, `src/server/maintenance/agreement-service.ts`, `src/server/maintenance/agreement-read.ts:91`, `src/server/billing/providers/paypal-subscriptions.ts`, `src/server/billing/providers/paypal.ts`, `src/lib/maintenance-agreement.ts`, `supabase/migrations/0110_maintenance_agreements.sql`, `docs/recurring-maintenance-billing.md`
- **Test coverage:** tests/maintenance-agreement.test.ts (a requested plan stays requested after approval; only a completed charge extends; wrong amount is a mismatch; one charge once; held on refund/dispute; sandbox charge on live applies nothing), tests/maintenance-agreement-rules.test.ts, tests/maintenance-agreement-ui.test.tsx, tests/maintenance-agreements-migration.test.ts. Real Postgres; stand-in PayPal.
- **Real or simulated behavior:** Fully built and tested against a hand-written PayPal stand-in; never run against PayPal. recurring_billing_enabled is off and PAYPAL_MAINTENANCE_PLAN_ID is absent from Vercel.
- **Missing dependencies:** The founder must create the billing plan in PayPal Sandbox (monthly, total_cycles 0, fixed US$299.00, no trial/setup fee, failure threshold 3, auto bill outstanding) and subscribe the webhook to the BILLING.SUBSCRIPTION.* and PAYMENT.SALE.* events; set `PAYPAL_MAINTENANCE_PLAN_ID` in a non-production environment; an isolated (preview) route, because the live site refuses sandbox subscriptions.
- **Remaining work:** After unblocking: run the 'What is not verified' rehearsal in docs/recurring-maintenance-billing.md and correct any event-shape guesses in normalizePaypalWebhook and paypal-subscriptions.ts.
- **Verification evidence:** Read recurring-maintenance-billing.md and agreement.ts guards. Prior recorded: docs/paypal-sandbox-safety-release-2026-11-03.md section 10 says subscription call shapes were checked against PayPal's OpenAPI spec (the plan, subscription and transactions calls) but no event payload or subscription has ever been created in PayPal.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A sandbox subscription is approved, charged once by PAYMENT.SALE.COMPLETED, extends the plan exactly one period, survives replay, handles a failed charge into the disclosed grace period and cancels at PayPal first, all audited.

<a id="gp-entitle-14"></a>
### GP-ENTITLE-14 — Clients' own invoices and payments (customer-payments)

- **Requirement:** Clients' own invoices and payments (customer-payments) (directive §21)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** synthetic-only  |  **Unblocked now:** no
- **Source files:** `src/server/customer-payments/webhooks.ts`, `src/server/customer-payments/connections.ts`, `src/server/customer-payments/credentials.ts`, `src/server/customer-payments/attempts.ts`, `src/server/customer-payments/events.ts`, `src/server/customer-payments/reconcile.ts`, `src/server/customer-payments/switches.ts`, `src/server/customer-payments/providers/paypal.ts`, `src/server/customer-payments/providers/simulated.ts`, `src/app/api/webhooks/customer-payments/[provider]/[key]/route.ts`
- **Test coverage:** tests/customer-payments-webhooks.test.ts, -attempts, -connections, -health, -paypal, -providers, -production, -reconcile, -route, -rules, -scheduler, -test-checkout, tests/invoices-public-gate.test.ts. Embedded Postgres plus stand-ins.
- **Real or simulated behavior:** Real tenant-owned connections with encrypted credentials and per-connection signing; providers exercised over a replaced HTTP layer and a simulated provider that never exists in production; never run against a real provider; module and live switches default off.
- **Missing dependencies:** A tenant with a real provider account and Sandbox credentials, the founder's approval to turn the module on for a workspace, and PayPal/PayMongo Sandbox runs.
- **Remaining work:** Sandbox-prove one tenant PayPal connection end to end in a preview deployment; keep it out of the Growth Partner path.
- **Verification evidence:** Read webhooks.ts. Prior recorded: docs/invoices-and-payments.md status "built and tested locally... Nothing has run against PayMongo or PayPal".
  - *Baseline: 13 of 13 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A workspace owner connects their own PayPal Sandbox account and a test customer invoice is paid and reconciled, touching only that workspace's data.

<a id="gp-entitle-15"></a>
### GP-ENTITLE-15 — Billing and plan state never block unrelated Growth Partner work; no payment during testing

- **Requirement:** Billing and plan state never block unrelated Growth Partner work; no payment during testing (directive §20, §21)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/billing/clearance.ts`, `src/server/billing/after-clearing.ts`, `src/server/workforce/provisioning.ts`, `src/server/setup/customer-facing-gate.ts`, `src/server/crm/workflows/runs.ts:280`, `src/lib/crm/workflow/spec.ts:255`, `src/server/automation-studio/builder/prompt.ts:117`
- **Test coverage:** tests/payment-gate.test.ts ("core modules are never gated by payment or a lapse": exact allow-list of files that may ask the clearance question, a scan that core modules never read the plan, and a representative operation in each core module with the fee refunded and the plan expired); tests/entitlements-matrix.test.ts (core works for lapsed/never-planned workspaces); tests/customer-facing-gate.test.ts; tests/launch-automation-gate.test.ts; tests/billing-clearance.test.ts. The core-module list in payment-gate.test.ts:377 does not include src/server/ai-growth-partner, hermes, workforce or agents, so those directories are not covered by the scan (my grep found no offenders).
- **Real or simulated behavior:** Real code; clearance gates only provisioning, activation, the optional plan and (behind an off-by-default flag) switching on customer-facing activity. Studio test runs are dry-run simulations; no Studio step takes money. The payment-gate scan does not cover src/server/ai-growth-partner, hermes, workforce or agents (my grep found no offenders there).
- **Missing dependencies:** none.
- **Remaining work:** Add ai-growth-partner, hermes, workforce (except provisioning.ts), agents and knowledge to the core-module list at tests/payment-gate.test.ts:377; add a real test that a Growth Partner chat turn succeeds for a workspace with an unpaid or refunded setup fee and no plan. | Skeptic adds: Also extend the core-module scan regex in tests/payment-gate.test.ts (~line 376) to match workspaceEntitlements, readCurrentPlan, isSetupPaymentCleared and assertSetupPaymentCleared; today it matches only studioEntitlement, assertStudioEntitled, entitlementFor, maintenance_subscriptions, setup_payment and billing_accounts.
- **Verification evidence:** Read payment-gate.test.ts:318-413 and grepped the Growth Partner directories. Doc claims in billing-and-entitlements.md ("never gated") are backed by the scan plus these representative tests.
  - *Skeptic review: The scan can pass while a core module imports the plan or clearance helpers by their camel-case names; the exact-allow-list test covers clearance only.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Tests fail if Growth Partner chat, memory, knowledge, schedules or CRM tools read plan, fee or credit state, and a Growth Partner turn is proven to run in every billing state.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Sandbox money must be isolated from production data on Vercel preview deployments", "directiveRef": "§21", "priority": "P0", "status": "NOT_STARTED", "remainingWork": "isLiveDeployment() is false for Vercel preview/development (src/server/env.ts:430-435), so sandbox payments there clear setup fees, create workspaces and extend plans. Before any preview rehearsal (rows 09, 12, 13, 14), verify preview env vars are scoped away from the production DATABASE_URL and production PayPal webhook, or require an isolated database; add a boot-time refusal when a non-live deployment points at the production database."}
- {"title": "Growth Partner provisioning is gated by setup-fee clearance: confirm as an explicit rule", "directiveRef": "§20, §21", "priority": "P1", "status": "PARTIAL", "remainingWork": "requestProvisioning and the employees pages hold Growth Partner availability until app.setup_payment_cleared (src/server/workforce/provisioning.ts; src/app/actions/workforce.ts:202). Get a founder decision that this gate is intended, state it in client copy, and ensure no other Growth Partner capability (chat, memory, knowledge) reads fee state."}
- {"title": "Document the plan-free workflow boundary", "directiveRef": "§20", "priority": "P2", "status": "PARTIAL", "remainingWork": "Only studio-origin workflows and http_request / slack_message steps are premium; ai_task and send_message run without the plan in CRM workflows. State this in upgrade-page copy and pin it with a test."}
