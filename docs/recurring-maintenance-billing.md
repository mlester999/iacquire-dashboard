# Automatic monthly payment for the maintenance plan (PayPal subscriptions)

Status as of 2026-10-26: **built and tested locally against a stand-in for PayPal written from PayPal's documentation. Never run against PayPal. Nothing is applied to a hosted database, no subscription has ever been opened, no money has moved, and the Super Admin's switch is off.** Migration `0110_maintenance_agreements.sql` (rollback in `supabase/rollbacks`) is not applied anywhere.

This is the *optional* fourth way to pay the US$299/month maintenance plan. The other three are unchanged: a person at iAcquire records a payment received outside the product, the owner pays 1 to 12 months online (PayMongo hosted checkout), or nothing arrives and the renewal sweep reminds. The core system, the CRM, the inbox and the AI employees are never gated by any of them, and the US$1,499 setup fee and the US$299 price are unchanged: the price is read from the plan row, never from PayPal.

## The rules

1. **An agreement grants nothing.** A PayPal subscription being `ACTIVE` means PayPal will try to collect. A period is paid **only** when PayPal reports a charge with state `completed` for the agreement, and that charge goes through `applyMaintenancePeriod` → `applyVerifiedPayment`: the same checks, dates, owner notice and audit entry as a payment recorded by hand (`actor_kind = 'system'`). `tests/maintenance-agreement.test.ts` proves a requested plan stays requested after approval and after an `ACTIVATED` notice.
2. **Only verified facts reach the plan.** A fact is either a webhook PayPal itself confirmed (`POST /v1/notifications/verify-webhook-signature`) or PayPal's own answer to a call this server made (the return read-back and the hourly reconcile). A browser contributes only the agreement's reference. Every fact goes through the same receipt ledger as every other payment (`payment_webhook_events`, keyed by provider and event id), so a replay is harmless.
3. **The charge must be what we asked for.** Amount, currency and mode must equal the agreement's (US$299.00, USD, the app's mode). A different amount, in either direction, or another currency is recorded as a `mismatch` charge (no payment is made up for it), the plan is untouched and the team is told (critical).
4. **One charge, once.** A charge is identified by its PayPal id: the signed sale notice, the hourly list of what the subscription collected and a replay are one charge (`unique (agreement, charge id)` and `unique (provider, provider payment id)`). If the sale notice and the transaction list name the same charge with different ids (a guess that is not verified, see below), the second one arrives within days of the first, and **a second charge within 10 days is recorded and held, never added**.
5. **Failed renewal.** `BILLING.SUBSCRIPTION.PAYMENT.FAILED` starts the plan's usual grace period (`STUDIO_PAYMENT_GRACE_DAYS`, 7 days) **when the period it was meant to pay has already ended** (`applyPaymentFailed`, the same words and dates as a failure a person records). While the plan is still paid through a later day nothing is taken from it: the owner is told and the renewal sweep starts the grace period once the paid-through day has passed, even with "mark past due automatically" off, because a failure PayPal reported is a fact, not a guess. A second failure never restarts or extends the grace period. When the grace period ends `studioEntitlementSweep` expires the plan and pauses **only** the Automation Studio workflows; core CRM workflows, AI employees, the inbox and the CRM are never selected.
6. **Verified reactivation.** A completed charge on a past-due or expired plan brings it back through the same transition. Paused workflows stay paused until a person turns each on (unchanged).
7. **A refund or a dispute never re-enables and never revokes.** `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED` and `CUSTOMER.DISPUTE.CREATED` are *reported* (the team is told, in PayPal's name): nothing already paid is taken away, nothing is brought back. They also **hold the agreement** (`hold = refunded | disputed`; a dispute is never downgraded to a refund). While it is held, a further charge is recorded as money received but is **not added to the plan**; the owner is told it is being reviewed. A person releases the hold, saying why (`releaseAgreementHold`, audited), and the held charges are then applied in order through the usual transition.
8. **Ended is ended.** Cancelled, expired and abandoned agreements never come back (application rule and a database trigger). News dated before news already applied is ignored; an earlier stage after a later one is ignored; a duplicate is one event. A charge that completes after a cancellation is still money and is recorded and applied like any other.
9. **Cancelling the plan cancels the subscription first.** When an owner asks to cancel, when the team confirms a cancellation, or declines a request, the subscription is cancelled **at PayPal first** and recorded as cancelled only once PayPal said so (or said it had ended). If PayPal cannot be reached the agreement stays as it is, the team is alerted (critical) and the error is shown: it is never recorded as stopped when it may not be. Stopping never changes the days already paid for.
10. **PayPal's plan must be our plan.** Before every subscription is opened the product reads PayPal's plan and refuses it unless it is `ACTIVE`, has exactly one `REGULAR` monthly cycle with no end (`total_cycles` 0), a fixed price equal to the maintenance plan's price in USD, and no setup fee or trial. The request carries no price at all. A mismatch opens nothing and tells the team which part differs.

## Manual versus automatic, in words

Every screen says which it is, using `paymentModeLabel` (`src/lib/maintenance-agreement.ts`), so the client and the team read the same sentence.

| State | Label | Mode |
| --- | --- | --- |
| No agreement, or cancelled / expired / abandoned | "Paid by hand each period" | by hand |
| Waiting for the owner's approval | "Automatic payments are waiting for your approval … still paid by hand" | by hand |
| Active | "Automatic payments are on … a period counts as paid only when PayPal confirms the charge" (with the next charge date) | automatic |
| Suspended | "Automatic payments are paused" (with the failed-charge count) | automatic |
| Held | "Automatic payments are on hold … a person reviews them before the plan is extended" | automatic |

## Switches and setup (nothing here is done yet)

* `agency_billing_settings.recurring_billing_enabled` (Admin → Maintenance): **off by default**; Super Admin only; audited. Closing it never touches an agreement already open.
* Environment: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENVIRONMENT` (as for the purchase checkout) and `PAYPAL_MAINTENANCE_PLAN_ID` (`P-…`). A live app also needs the payment/tax review confirmation (`live_payments_review_at`).
* In PayPal (the founder, in the sandbox first): create the billing plan: product type service, one `REGULAR` cycle of 1 month, `total_cycles` 0, fixed price US$299.00 USD, no trial, no setup fee, `payment_failure_threshold` 3, `auto_bill_outstanding` true. Subscribe the webhook to `BILLING.SUBSCRIPTION.ACTIVATED`, `SUSPENDED`, `CANCELLED`, `EXPIRED`, `UPDATED`, `PAYMENT.FAILED` and `PAYMENT.SALE.COMPLETED`, `REFUNDED`, `REVERSED` (plus the capture and dispute events the purchase checkout already needs).
* Scheduler: `maintenanceAgreementReconcile` (every 60 minutes) reads PayPal's own record of each open agreement (and abandoned ones for a month), applies status and any charge a lost notice never delivered, closes an approval nobody gave in 72 hours and cancels, at PayPal, one that was approved after it was closed. It calls only PayPal's read endpoints and its cancel endpoint, charges no one, and does nothing until an agreement exists. Like every job it runs only when the scheduler does and, in a staged start, only when named in `SCHEDULER_JOBS_ONLY`.

## What is not verified (settle in a PayPal sandbox before any client's money depends on it)

The header of `src/server/billing/providers/paypal-subscriptions.ts` lists seven guesses; the ones most likely to hurt are:

1. **The id of a charge.** The sale notice's `resource.id` and the transaction list's `id` are assumed to be the same id. If they differ, rule 4's ten-day guard records the second as held rather than adding a month twice, but the team would then see a held charge each month until this is settled.
2. The shape of `PAYMENT.SALE.COMPLETED` (`state: completed`, `amount.total`, `billing_agreement_id`) and which id `PAYMENT.SALE.REVERSED` and a dispute name for the sale.
3. That a subscription waiting for approval cannot be cancelled (the product closes it locally and cancels it later if it is ever approved).
4. That PayPal's retry schedule and the status of a subscription during the retries match the plan's `payment_failure_threshold`.
5. That `PayPal-Request-Id` makes opening a subscription idempotent.
6. Webhook verification by asking PayPal (shared with the purchase checkout).

**PayMongo has no recurring path here.** Its subscriptions are PHP-only and need account enablement and card vaulting that were never checked; a PayMongo plan payment stays a hosted checkout per period.

## Failure runbook

| What the team sees | What it means | What to do |
| --- | --- | --- |
| "Automatic payments are blocked: the PayPal plan doesn't match" | PayPal's plan differs from the maintenance plan (price, interval, trial, setup fee, status) | Fix the plan in PayPal or `PAYPAL_MAINTENANCE_PLAN_ID`; nothing was opened |
| "A PayPal charge did not match its agreement" | A charge of another amount or currency | Review it in PayPal; refund or contact the client; the plan was not touched |
| "A client's automatic payment failed" | PayPal could not collect | Nothing to do if the plan is still paid through; otherwise the grace period has begun and the client was told the date |
| "An automatic payment is on hold" | A refund or dispute was reported | Deal with it in PayPal, then release the hold on the client's plan card with a reason |
| "A charge arrived on a held automatic payment" | Money arrived while held (or looked like a duplicate) | Check it, then release the hold: the held charges are applied in order |
| "An automatic payment could not be cancelled at PayPal" | The cancel call failed | Cancel it in PayPal, then check the client's billing; the product still shows it on |
| "A late approval" | The buyer approved an attempt that was closed | The hourly check cancels it at PayPal; any charge it already made is still recorded |

## Tests

`tests/maintenance-agreement-rules.test.ts` (pure rules, 22) and `tests/maintenance-agreement.test.ts` (47, embedded Postgres, stand-in in `tests/support/paypal-subscriptions.ts`): availability, opening (deferral past the paid-through day, plan proof, outage, permissions, one open agreement), that an agreement grants nothing, a completed charge applying once (replay, new notice id, hourly list), mismatches, mode, ordering and revival, adoption by reference, immutable terms, the failed-renewal walk to the premium pause with the core workflow untouched and the verified reactivation, refunds and disputes holding and releasing, cancellation (PayPal first, outage, with the plan), and the hourly check.
