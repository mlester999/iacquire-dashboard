# Sales and demo funnel gap audit (2026-10-19)

Scope: the intended prospect experience — personalized demos, demo prospects tracked by Super Admin, a free consultation as the recommended CTA, direct checkout as an alternative, secure direct-purchase invitations, payment verification before activation, and automatic native CRM provisioning after a verified purchase.

This audit does **not** implement the missing funnel. It records what exists, what is partial, and the smallest dependency-ordered plan that reuses the existing authentication, billing, tenant and CRM services. Keep this work separate from the native CRM launch blockers in [native-first-release-audit.md](native-first-release-audit.md).

## Findings

| Requirement | Status | What exists | Actual gap |
| --- | --- | --- | --- |
| Personalized interactive demos | **Missing** | The real portal, CRM, Website Studio and AQi screens can be reviewed in development-only `/dev/*` previews with sample data. They explicitly return 404 in production. | No prospect-specific demo workspace, no demo data generated from a prospect's industry/answers, no expiring read-only demo link, no separation from billing/metering. |
| Demo prospects tracked by Super Admin | **Partial** | `/get-started` writes `access_requests` (company, contact, email, website, message). Super Admin sees them at `/admin/requests` and can set `new` → `contacted` → `approved`/`declined`; `reviewed_by` is recorded. | No demo link, demo status, consultation booking, notes/timeline, owner/assignment, expected value, purchase intent or conversion action. The intake is a lead list, not a demo pipeline. |
| Free consultation as the recommended CTA | **Missing** | The native booking engine, availability, appointment types and public `/book/<org>/<calendar>` pages work for **client** workspaces. | The public booking resolver only accepts `organizations.kind = 'client'`; the agency has no consultation calendar/CTA on `/get-started` or any marketing page. There is no recommended CTA, only the access-request form. |
| Direct checkout as an alternative | **Partial infrastructure, missing flow** | PayMongo hosted checkout exists for an **existing organization**: signature verification, event ledger, amount/currency/livemode checks, FX, setup-fee payment kind, `billing_accounts.setup_fee_cents`, `setup_payment_status`, invoices/receipts and admin reconciliation. | No public purchase page, no checkout action/button for the setup fee, and no checkout before a tenant exists (`payments.org_id` is `NOT NULL`). The only live UI is admin-managed billing status; no client-facing checkout at all. |
| Secure direct-purchase invitations | **Missing link** | Tokenized invitations exist: hashed tokens, expiry, single use, resend/revoke, owner membership, audit. | An invitation requires an existing organization and carries a role, not a purchase. There is no purchase-intent token, no payment-bound invite, and no way for a buyer who skips a demo to receive a secure checkout/invite without an admin first creating the tenant. |
| Payment verification before production activation | **Partial, with a control gap** | The PayMongo webhook verifies the raw-body signature, reference, amount/currency, livemode and event id before recording a payment; a paid setup fee sets `setup_payment_status = 'paid'`. Activation re-runs setup checks and requires a Super Admin review. | `activateSetup` does **not** read `billing_accounts.setup_payment_status` or `activation_status`. Payment status is displayed on the client card but does not block activation. There is no approved waiver/backfill rule for existing clients. |
| Automatic native CRM provisioning after purchase | **Partial building blocks** | `createClientTenant` creates the organization, native `crm_workspaces` row, billing/usage accounts, setup instance, owner invitation and optional native Blueprint in one flow. Native default, Blueprint application, setup jobs and idempotency keys are tested. | No purchase-triggered orchestration: no purchase record, no verified-payment event handler that calls the tenant service, no automatic industry/Blueprint choice from the purchase, and no post-payment invitation delivery. |

## Reuse map (do not build a second system)

- **Auth/invitations:** existing hashed-token invitation service (`src/server/auth/service.ts`). Add a purchase-intent binding; do not create a second token format.
- **Payments:** existing PayMongo client, `createPaymentCheckout`, webhook signature/event ledger and `payments`/`billing_accounts`. Do not add another checkout provider or a parallel ledger.
- **Tenant/CRM:** existing `createClientTenant` and `applyOnboardingBlueprint` (native default, native workspace, optional Blueprint, invitation, audit). Do not hand-create organizations.
- **Setup/provisioning:** existing setup instance, native preparation jobs and activation review. Do not duplicate provisioning jobs.
- **Consultation:** existing native calendar/availability/booking code, but the public resolver currently excludes the agency. Either point the CTA at an approved external scheduler (smallest) or explicitly extend the resolver/agency calendar (larger, needs a product decision).
- **Demo:** reuse `createClientTenant` internals/Blueprint service with an explicit `is_demo` mode, no billing account, no email delivery, no provider credentials, short expiry and cleanup. Do not expose a production demo by seeding a real client tenant.

## Dependency-ordered implementation plan

### Phase 0 — decisions and approvals (no code)

1. Confirm the setup-fee price, tax/refund treatment and whether existing clients are grandfathered/waived.
2. Confirm the activation rule: `setup_payment_status` must be `paid` or `waived` before `activateSetup` can succeed; define who may grant a waiver and how it is audited.
3. Choose the consultation channel: approved external scheduler link (fastest) or agency-owned native booking calendar (requires extending the public resolver beyond client organizations).
4. Approve the demo lifecycle: who creates it, expiry, data source, whether it is read-only, and cleanup.
5. Approve a new migration for purchase intents/invitations; no production migration is authorized by this audit.

### Phase 1 — payment gate on activation (small, independent)

- Add a readiness/activation check: `setup_payment_status in ('paid','waived')`; return a clear blocker on `/admin/clients/<id>/activation` and in `activateSetup`.
- Backfill/waive existing clients explicitly; do not silently block them.
- Tests: paid activates, waived activates, `not_invoiced`/`invoiced`/`refunded` block, a Super Admin cannot bypass, audit records the decision.
- No schema migration; reuse `billing_accounts`.

### Phase 2 — purchase intent and secure invitation (needs migration)

- New `purchase_intents` (or equivalent) keyed by a hashed token: company, buyer email, industry, website, amount, currency, status (`invited`, `checkout_started`, `paid`, `expired`, `cancelled`), expiry, created_by, verified payment id, resulting org id.
- Keep `payments.org_id NOT NULL`. Recommended: keep the pre-tenant checkout fields on `purchase_intents`; after the verified payment creates the tenant, write the canonical `payments` row against the new `org_id` and link it back to the intent idempotently. The alternative — making `payments.org_id` nullable — touches every payment report, RLS policy and reconciliation query and is **not** recommended without a separate schema review.
- Invitation token is single-use, expires, is bound to the intent and cannot be used after payment reversal. Reuse the existing hashed-token and membership code.
- Admin UI: create/send a purchase invitation, see its status; buyer sees the price and terms before paying.

### Phase 3 — webhook-to-tenant provisioning

- On the verified `checkout_session.payment.paid` for a purchase intent: mark paid, then call `createClientTenant` with `crmMode: "native"`, the chosen industry/Blueprint, and an idempotency key from the intent.
- Create the owner invitation only after the tenant exists; deliver through the existing invitation mailer (`EMAIL_PROVIDER` still `capture` until approved).
- Reuse `applyOnboardingBlueprint`; do not create CRM records by hand.
- Failure handling: payment stays recorded, intent becomes `paid_pending_provision`; retry is idempotent; no duplicate tenant or invitation; audit each step.
- Activation remains blocked until the payment gate (Phase 1) and the setup checks pass.

### Phase 4 — demo workspace and prospect tracking

- Extend the prospect record (or a new `demo_prospects` table) with demo status, demo org id, consultation date, purchase intent, stage, owner and notes.
- Add an internal `createDemoWorkspace(prospect, industry)` that reuses the Blueprint/CRM services in a clearly marked `is_demo` tenant, with no billing account, no email, no credentials, no scheduler writes, and an expiry/cleanup job.
- Demo links are signed, read-only or limited, and expire. Super Admin sees the pipeline; the buyer never sees another tenant's data.
- Reuse the existing sample-data/Blueprint patterns, not a second CRM.

### Phase 5 — funnel UI

- `/get-started`: recommended **Book a free consultation** CTA, with **Buy now** as the alternative; both preserve the existing access-request fallback.
- Add attribution and the prospect record id to the request/intent; no duplicate lead store.
- Buyer-facing checkout and invitation screens reuse the existing auth/billing visual system; no new provider.

### Phase 6 — acceptance

- Test: unpaid cannot activate; paid/waived can; webhook replay cannot duplicate a tenant/invite; a buyer without a demo can pay, receive an invite, accept, complete onboarding, get a native CRM workspace/Blueprint and reach Setup Center.
- Verify tenant isolation, audit, email-delivery honesty and no provider writes. Run in hosted staging before production.

## Smallest release order

1. **Phase 1 activation payment gate** (code + tests, no migration) — closes the “payment verification before activation” control gap first.
2. **Consultation CTA** via an approved external scheduler (config/UI only) — makes the recommended path usable without new booking scope.
3. **Phase 2–3 purchase intent + verified webhook provisioning** (one additive migration) — the direct-purchase alternative.
4. **Phase 4 demo workspace/prospect pipeline** — the personalized demo experience, after the purchase path is safe.
5. **Phase 5 funnel wiring and Phase 6 staging acceptance**.

Do not start Phase 2–4 before Phase 1 and the staging schema review are approved. Existing GHL-owned workspaces, provider switching and tenant isolation are untouched by this plan.
