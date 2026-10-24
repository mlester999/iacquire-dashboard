# iAcquire's own billing: setup payment clearance and the manual payment ledger

This is iAcquire's billing: the one-time setup fee and the optional monthly plan that iAcquire charges its clients. It is **not** the invoices a client sends its own customers ([invoices-and-payments.md](invoices-and-payments.md)); the two share no table, no service and no money code. Provider credit top-ups and the metering ledger are in [finance-and-billing.md](finance-and-billing.md).

Status: **Phase 7, milestone M1 built and verified locally** (embedded Postgres, replaced HTTP layer, hand-written PayMongo fixtures). Nothing has been applied to a hosted database, enabled, or tried against PayMongo. Milestone M2 (one entitlement helper, renewal reminders, lapse hardening) is not part of this document yet.

Code: `src/server/billing/{clearance,after-clearing,manual,payments,payments-view}.ts`, `src/server/billing/providers/{types,paymongo}.ts`, `src/server/maintenance/payment.ts`, `src/lib/billing-clearance.ts`, `src/app/(admin)/admin/billing/actions.ts`, `src/components/admin/payments-workspace.tsx`, migration `0099_payment_controls.sql` (rollback in `supabase/rollbacks`). Tests: `tests/billing-clearance.test.ts`, `billing-manual.test.ts`, `payment-gate.test.ts`, `billing-providers.test.ts`, `billing-ui.test.tsx`, `tests/support/billing.ts`.

## The rule

Payment is evidence, not a click. The setup fee is **cleared** only by a payment a provider confirmed (PayMongo's signed notice) or that a Super Admin saw arrive and recorded with a reference, or by a **waiver** with a stated reason. One SQL function, `app.setup_payment_cleared(org)`, answers the question for every gate: paid or waived.

| Where the gate sits | What it stops until the fee is cleared |
| --- | --- |
| `requestProvisioning` | No AI employee profile is requested (the step that costs iAcquire money). The questionnaire itself is not gated. |
| `activateSetup` | A `payment_unverified` blocker, listed first, on the activation review. Marking the setup ready for review is not blocked: payment is not a setup task. |
| `maintenanceEligibility`, `applyVerifiedPayment` (activate) | The optional plan cannot be requested or started. A plan already running is untouched. |
| `deriveEmployeeReadiness` | A card that is not yet working reads "Setup required: Your AI team starts after your setup payment is confirmed". |

**Never gated by payment or by a lapse:** core CRM, the inbox, the six employees' chat, the website, booking, social text posts, and anything already running. `tests/payment-gate.test.ts` proves it two ways: a scan that lists every file allowed to ask the clearance question (a new caller fails the test), and a representative operation in CRM, booking and social with the fee refunded and the plan expired.

A **full refund** of the payment that cleared the fee sets the status to `refunded`: nothing new is provisioned and a new plan cannot start, but the activated setup, the provisioning requests and the running employees are left exactly as they are. A fresh payment or a waiver clears it again.

## What a Super Admin can do (`billing.agency_manage`, Super Admin only)

* **Record a payment received outside a provider** (`recordManualPayment`): kind (setup fee, maintenance, custom project, domain, other), exact US-dollar amount, how it arrived, the bank reference or receipt number, the day it arrived, and what they checked. The payment row, the status it changes and the AI employees' provisioning requests commit together. The same reference never makes two payments (a repeat returns the first record; a different workspace, kind or amount is refused). A setup-fee payment must equal the agreed fee; anything else is a waiver. A maintenance payment names the period it covers and goes through the same transition (`applyVerifiedPayment`) as an agency member's verification, so the plan and the money record agree; if the plan's rules refuse, the payment is rolled back with the refusal.
* **Waive the setup fee** (`waiveSetupFee`) with a reason of 10 to 500 characters. Saved with who and when; **the client is told the fee was waived, not why**. An open setup checkout is cancelled so nobody can pay after the waiver.
* **Record a refund** (`recordRefundAction`) that was already made with the provider or by hand. It records; it does not send money.

The billing form on the client's page no longer types a status in: `updateBilling` may only toggle "not invoiced" and "invoiced" (neither clears anything), and cannot mark activation "active" while the fee is not cleared. The database enforces the same: "paid" needs a verified setup payment of the same workspace, "waived" needs a reason, a manual payment needs its evidence and cannot have it edited afterwards, one setup checkout can be open at a time.

Screens: the **Payments** tab on `/admin/billing` (every payment, who proved it, clients still waiting, record and refund controls) and the **Billing** tab on a client (where the fee stands, waiver details, that client's payments, the same controls, then the invoice and terms form). Everything is labelled for what it is: "Recorded by hand: Bank transfer" is a person's record; "PayMongo, confirmed by its signed notice" is a provider's. No text says a payment was detected unless PayMongo's signature was verified.

## Provider adapters

`PaymentProviderAdapter` (`providers/types.ts`): `notReady()`, `expectedLivemode()`, `verify(raw body, headers)` and `parse(raw body)` to one `NormalizedPaymentEvent`. The shared handler (`handleProviderWebhook` in `payments.ts`) never reads a provider's payload: the organisation always comes from OUR stored payment row; the reference, amount, currency and mode must all agree; the event-id ledger (now keyed by provider and event id) makes retries harmless. PayMongo is the first adapter and wraps the functions in `paymongo.ts` unchanged, so `tests/billing.test.ts` passes untouched. **PayPal does not exist**: `tests/billing-providers.test.ts` drives the handler with a fake second adapter only to prove the rules do not depend on PayMongo's payload. Settling PayPal's event names and verification belongs to milestone M6 and needs an account.

A setup-fee payment confirmed after the fee was already paid or waived is recorded (the money arrived), changes neither the status nor the requests, and raises a reconciliation alert so a person decides whether to refund it.

## Existing clients (founder decision 1, open)

Recommended default, built as one named statement in `0099_payment_controls.sql` ("DATA STEP 2") and lifted out of the file by a test: every workspace whose setup is **already activated** and whose fee is not paid, waived or refunded becomes `waived` with the recorded reason **"Activated before the payment gate"** (`ACTIVATED_BEFORE_GATE_REASON`). A workspace still in setup is not touched and needs a payment or a waiver. A fee marked "paid" by hand before payments were recorded stays "paid" and is shown as having no payment record. The rollback leaves the backfilled status alone (it is valid before 0099 too).

## Notifications and privacy

New kinds: `billing_setup_payment_required` (agency and owner, once per workspace, when onboarding is done and only the payment is missing), `billing_setup_cleared`, `billing_refund_recorded`, and `billing_renewal_due` (reserved for M2). The waiver reason, who waived, the bank reference, the checking note and the verifier are readable only by agency code: the application role has no grant on those columns, the client export omits them, and the activity timeline shows an action name, not its metadata. Audit entries record who and what, and keep the bank reference on the payment row only.

## Proposals the founder must confirm

1. Existing clients: waive those already activated (built) versus require payment or grandfather by date.
2. Whether a waiver reason may ever be shown to the client (today: never).
3. Whether a full refund after provisioning should pause the client's AI team (today: it does not).
4. The sanity limits on a recorded payment: at most US$100,000.00, dated no more than a day ahead or two years back. A typo guard, not a policy.
5. Setup-fee price, tax and refund treatment, terms and refund wording: counsel and the founder.

## Not verified

* Nothing was seen in a browser. The screens were designed for 375 px (44 px targets, 16 px fields, labelled fields, `role="alert"` for refusals) and rendered in a test DOM only.
* PayMongo's signature, payload and refund contract is from its documentation as read on 2026-10-14; it has never run against a PayMongo account.
* The backfill is tested as a statement on fixtures and the migration is rehearsed on embedded Postgres; it has not run against production's real rows (reported as 3 organisations, 1 active).
* Not built here: an owner "Pay setup fee" button (M5), PayPal (M6), expiring stale pending checkouts, refund and dispute events from PayMongo (M2).
