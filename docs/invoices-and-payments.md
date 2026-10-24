# Customer invoices and payments (Phase 5C and 5D)

Status as of 2026-10-24: **built and tested locally** (embedded Postgres, a simulated payment provider that lives inside the process, and a replaced HTTP layer for PayMongo and PayPal). The invoice screens, the customer's pay page, the testing checkout and the return page were used in a real browser on a local server with the simulated provider. **Nothing has run against PayMongo or PayPal, no real money has moved, and no hosted database holds any of it.** Migration `0093_customer_invoices_payments.sql` (rollback beside it) is not applied anywhere, and no workspace has the module switched on.

Some rules below were decided on 2026-10-24 as part of the review fixes of Wave 1 and are marked **[fix round]**. They were being built by other work streams while this was written. When this was last checked against the code, the closing outcomes of a dispute, disputes recorded by hand, the PayPal answer while real calls are off and `INVOICES_PUBLIC_DISABLED` were in the code, and so was the test-invoice rule (`customer_invoices.is_test`, in migration `0093`). Check each against the merged code before relying on it.

## At a glance

| Part | Built and tested here | Simulated, or never run against a real service | Needs an account or an approval |
| --- | --- | --- | --- |
| Invoices (draft, approve, issue, void, write off) | Numbering at issue, details and a content hash frozen at issue, an approval of one exact version, and a database that refuses edits to an issued invoice and totals its rows do not add up to. Money is whole minor units. The list, detail, new invoice and settings screens were used in a real browser at 375 and 1024 pixels | The issue, record-a-payment, refund and void dialogs and dark mode were not yet checked in a browser | A Super Admin switches the module on for a workspace; where invoicing sits relative to the implementation fee and the monthly plan is the founder's decision; no country's tax-invoice rule is promised |
| The customer's invoice page and "Pay online" | `/pay/<token>`, the return page that says "We are confirming your payment" until the database counts it, and the emergency stop `INVOICES_PUBLIC_DISABLED` | Used in a real browser only with the simulated provider's testing checkout | A connected live payment account and every live gate below |
| PayMongo | An adapter written from the documentation and exercised against a replaced HTTP layer with fixtures written by hand | **Never run against PayMongo.** It reports `contractVerified: false`, and the guesses most likely to be wrong are listed at the head of `providers/paymongo.ts` | The client's own PayMongo account (test, then live), its secret key and webhook secret; PHP only; `CUSTOMER_PAYMENTS_WRITES_ENABLED`; the founder's approval |
| PayPal | The same, for PayPal | **Never run against PayPal.** Whether an account supports each of the eight currencies is unverified | The client's own PayPal app (sandbox, then live), its client ID and secret and the id of the webhook for this connection; the same switches |
| Test mode and live mode | A connection is test or live; only a signed-in member runs a test payment; a live connection stays closed to customers until six gates hold | The simulated provider signs its own webhooks and reaches nothing; it is refused in production | `CUSTOMER_PAYMENTS_LIVE_ENABLED`, the owner's recorded authorization, a provider-confirmed test payment and the owner's confirmation. A test payment belongs only to a test invoice, and the database refuses any other pairing (see Test mode and live mode) |
| Verified revenue and Lead Sources | One definition in two places (a pure function and SQL) that a test runs over the same random payments and refuses any difference | Never computed on real payments | Whether payments recorded by hand count is the owner's choice, and the report says which |
| Payments and refunds by hand, disputes | Audited, shown as the person's word and never as provider-confirmed; a dispute can be opened and closed by hand, and a closing outcome never restores money on a guess | No refund is sent to any provider: refunds are made in the provider's own dashboard and recorded here | `invoices.refund`, the owner only |
| Reminders | Off until the owner authorizes the exact wording; consent, opt-outs, quiet hours, holds and credits apply; withdrawn on payment, void, write-off or dispute; never sent late | Nothing has been sent through a real email, text or WhatsApp provider by this module | The owner's authorization; counsel-approved reminder and late-fee wording; each channel's provider write switch; prepaid service credits for text and WhatsApp |
| Where the payment keys live | Sealed (AES-GCM) in a column the application role cannot read, behind one seam (`credentialVault`) | Not in Supabase Vault. Rotating `APP_ENCRYPTION_KEY` makes every stored payment key unreadable (see the known limit below) | The founder decides sealed column or Vault, and the rotation procedure |
| Scheduler | `customerPaymentReconcile`, `invoiceOverdueSweep` and `invoiceReminders`, shown through the real tick endpoint | Never run on a real host | The founder names them in a staged start, in the order the go-live checklist gives |
| Hosted database | Migration `0093_customer_invoices_payments.sql` and its rollback, rehearsed on embedded Postgres | Not applied anywhere | A backup, the rehearsal and the founder's approval to apply it |

## What it is, and what it is not

A client (a business) issues invoices to **its own customers** and can collect them online through **its own** PayMongo or PayPal account. iAcquire never holds the money, never charges a customer and never sees a card: the customer pays on the provider's page.

It is **not** iAcquire's own billing. iAcquire's charges to its clients (the setup fee, usage credits, maintenance), its PayMongo account and its finance statement are a separate system (`docs/finance-and-billing.md`, `src/server/billing/*`, the tables of migrations 0018 and 0025, the agency webhook `/api/webhooks/paymongo`). The two share nothing: customer payments live in `customer_*` tables, arrive at `/api/webhooks/customer-payments/<provider>/<connection key>`, are checked with the connection's own signing secret, and verified revenue reads only `customer_*` tables. A client's customer money never appears in `/admin/billing`, and iAcquire's billing never appears in a client's invoices.

## Where things are

| Area | Files |
| --- | --- |
| Tables, permissions, notification kinds, rollback | `supabase/migrations/0093_customer_invoices_payments.sql`, `supabase/rollbacks/0093_customer_invoices_payments.down.sql` |
| Pure rules (states, arithmetic, numbers, tokens, reminders, connection rules, payment facts, verified revenue) | `src/lib/invoices/*` |
| Invoice services (write, approve, issue, void, write off; payments and refunds by hand; reminders; overdue; close rules; disputes) | `src/server/invoices/*` |
| The one place that decides paid, refunded and disputed | `src/server/invoices/apply.ts` |
| Payment accounts, checkouts, webhooks, read-back, reconcile | `src/server/customer-payments/*`, providers in `src/server/customer-payments/providers/` |
| Staff screens | `/invoices` (list, new, detail, edit, settings), Settings > Customer payments; `src/components/invoices/*` |
| Customer screens | `/pay/<token>` (the invoice), `/pay/return/<reference>` (the page the provider sends them back to), `/api/public/invoices/*` |
| Switch on / off per workspace | Super Admin page `/admin/module-rollout` (calls `setInvoicesEnabled`) |
| Scheduler | `customerPaymentReconcile`, `invoiceOverdueSweep`, `invoiceReminders` ([production-scheduler.md](production-scheduler.md)) |
| Tests | `tests/invoices-*.test.ts(x)`, `tests/customer-payments-*.test.ts`, fixtures `tests/support/invoices.ts`, `tests/support/customer-payments.ts` |

## The invoice

`draft` -> `pending_approval` -> `issued` -> `void`. Only a draft can be edited. Issuing assigns the number from the workspace's counter inside the issuing transaction, freezes the customer's and the business's details and fixes a content hash; from then on the amounts, dates and wording cannot change (the database refuses it too). An approval is of one exact version. The number is a label, not a claim: no jurisdiction's tax-invoice numbering rule is promised, and what the owner chose as a prefix is what is printed.

Whether an invoice is paid is **never** decided where it is edited: it is decided in `src/server/invoices/apply.ts` from payment and refund rows (`unpaid`, `partially_paid`, `paid`, `disputed`), and the database refuses an invoice whose paid and refunded amounts and payment status are not what its rows add up to. Money is integers in the currency's minor unit with one rounding per line and per-currency exponents; no floating point touches an amount, and currencies are never added together or converted.

Permissions (`src/lib/permissions.ts`): view and create, owner, manager, sales rep; approve, send, record a payment received outside the product and void, owner and manager; record a refund and write off, the owner; settings and connecting the payment account, the owner. **Agency staff have none of them**: an invoice holds a customer's details and the client's finances.

An invoice with a payment cannot be voided. A card number or a key typed into free text (a note, payment instructions, the evidence of a payment) is refused. A privacy request blanks the frozen customer details of an issued invoice and keeps the invoice itself, its number, amounts and payments, because keeping them is the business's own legal question.

## Payments: only a verified provider fact or an explicit, audited human record

Nothing is marked paid on a guess.

- **A provider's fact.** A payment is counted only when every fact agrees: the connection's mode is the event's mode, the reference is one issued on this connection, the provider's checkout id is the one stored for it, and the amount and currency are exactly what the attempt asked for. Anything else is kept as a row for a person to look at and counts for nothing. A webhook is trusted only by its signature (checked with that connection's own secret) and its receipt is committed before it is applied, so a failure leaves a receipt a later delivery or the reconcile job applies again. The raw body, which can carry a payer's name and email, is never kept.
- **A person's word.** The owner or a manager can record a payment received outside the product (a bank transfer, cash) with evidence, and the owner a refund handed back. It is audited, shown as the person's word, and never described as confirmed by a provider. This release sends no refund to any provider.
- **The customer's page never says "paid" because the browser says so.** Returning from the provider, a success flag in an address, an attempt that exists: none of them is a payment. The return page says "We are confirming your payment" until the database counts it, and "We have received your payment" only then.

## The business's own payment account

Only the owner connects it (`invoices.connect_payments`), after accepting recorded wording (**draft wording, not approved by counsel**), and the keys they paste go straight to a sealed column and are never echoed, logged, audited, notified or shown again.

| | PayMongo | PayPal | Simulated |
| --- | --- | --- | --- |
| Keys | secret key (`sk_test_` / `sk_live_` says the mode) and the webhook signing secret | client ID and secret, the environment (sandbox or live), and the id of the webhook created for this connection's address | none |
| Currencies | PHP only | all eight of ours (an account may not support each; unverified) | all |
| State | built from the documentation, **never run against PayMongo** | built from the documentation, **never run against PayPal** | testing only; refused in production |

`src/server/customer-payments/providers/paymongo.ts` and `paypal.ts` list, in their headers, the guesses most likely to be wrong (endpoint paths, event names, the refund and dispute shapes, the read-back). Every adapter reports `contractVerified: false` until a run against the provider's own test account is recorded. A PayMongo webhook delivery that arrives while `CUSTOMER_PAYMENTS_WRITES_ENABLED` is off still records money that arrived (its signature is checked locally). A PayPal delivery can only be checked by asking PayPal, so while the switch is off it is answered 503 with Retry-After before any call and nothing is stored: PayPal sends it again, and `customerPaymentReconcile` reads open checkouts back once the switch is on (read from the code in `src/server/customer-payments/webhooks.ts` and `reconcile.ts`; when this was written no test ran the whole sequence of a refused delivery followed by the read-back).

### How the keys are stored, and the limit

A business's payment keys can move money. They are sealed with AES-GCM under `APP_ENCRYPTION_KEY` into `customer_payment_connections.credentials`, a column the application role has no grant on, and opened only inside the server for the length of one call. They never reach a browser, a log, an audit row, a notification, an export or an AI prompt. `credentialVault` in `src/server/customer-payments/credentials.ts` is the single seam: moving them to Supabase Vault (what the audit recommends, and what migration 0010's rule says for new credentials) changes that file and the sealed column and nothing else. **That move has not been made and is a founder decision.**

**Known limit: `APP_ENCRYPTION_KEY_PREVIOUS` is not tried for these keys.** The customer's invoice link is derived from the server key and still matches while a retired key is listed in `APP_ENCRYPTION_KEY_PREVIOUS`. A sealed payment key is not: `decryptSecret` does not try the previous key, so **rotating `APP_ENCRYPTION_KEY` makes every stored payment key unreadable and each owner must paste theirs again.** It fails honestly, not silently: opening fails, the connection is marked as needing attention, and no payment is started with a key that cannot be read. Plan a rotation as: tell the owners, rotate, and have each reconnect. **The same limit holds for everything else sealed with `encryptSecret`:** signing-service keys, review-site sign-ins, social account tokens, calendar and Automation Studio connections. A rotation is therefore a platform decision, not a payments one; none of it has been rehearsed.

## Test mode and live mode

A connection is `test` or `live`. A real provider's test mode moves no money, so a customer is **never** sent to it: only a signed-in member runs a test payment. A live connection stays closed to customers until all of these hold: the connection is connected, the owner recorded their authorization, `CUSTOMER_PAYMENTS_WRITES_ENABLED=true`, `CUSTOMER_PAYMENTS_LIVE_ENABLED=true`, a payment the provider confirmed in test mode exists for this workspace and provider, and the owner has confirmed going live. Each is its own decision.

**[fix round] A test payment belongs to a test invoice.** Test-mode payments (`livemode` false) are recorded only on an invoice made on purpose as a test invoice (`customer_invoices.is_test`), and a live payment, or one recorded by hand, never sits on a test invoice. The database refuses any other pairing (`app.customer_payment_guard`, for every payment status), the service refuses it before it writes, and a provider notice that pairs them is turned away and kept as a rejected receipt, not recorded.

How a test invoice is made and what it is kept out of:

- **Made on purpose, by the owner only** (`invoices.connect_payments`). The invoice form offers a "this is a test invoice" box only while a payment account in test mode is connected, and only to the owner; the connection card's "Start a test invoice" link opens the form with it ticked. The mark is chosen on a draft and fixed once the invoice leaves draft (the database refuses to change it). A test invoice never closes a deal.
- **Its own numbers.** A test invoice takes `TEST-0001`, `TEST-0002` and so on from its own counter (`customer_invoice_settings.next_test_number`), so the business's real sequence has no gap for a test.
- **Marked everywhere.** A TEST badge in the list and on the invoice, a "Test invoice" title on the customer's page with the banner "This is a test invoice: nothing is owed and no money moves" (and a "Test · nothing is owed" label that also prints), and timeline and notice lines that say it was a test.
- **Paid only as a test.** A test invoice is paid through a payment account in test mode and a real invoice through a live one, never the other way round; "Pay as a test" and the testing checkout exist only for a test invoice. No payment, refund or dispute can be recorded on a test invoice by hand.
- **Kept out of the books.** A test invoice is not in what is owed, overdue or received, is never reminded about (the database drops a reminder row for one, and the job plans none), is not verified revenue, never closes or reopens a deal, starts no automation, and is not read by the Performance Analyst's receivables review. The invoice list has a separate "Test invoices" list.
- **Voided or deleted freely.** A test invoice can be voided even when it has test payments, and the owner can delete one with its test payments, checkouts and timeline lines (audited as `invoice.test_deleted`). **A caution:** a provider-confirmed test payment is what lets the owner go live, so deleting the only test invoice after the keys were swapped for live ones removes that proof; the dialog says so and offers void, which keeps the payment.
- **A consequence in development.** The simulated provider is always in test mode, so it can take a test invoice only; a real invoice in development shows "pay another way" until a live account is connected.

## Refunds and disputes

Refunds are made in the provider's own dashboard and recorded here (or reported by the provider's webhook); a refund the provider reported and one a person recorded for the same payment and amount within a few days are taken to be one refund and counted once.

**[fix round] A closed dispute never restores a payment as received money on a guess.** The closing event carries an outcome: *won* (the seller's favour, or withdrawn by the buyer) restores the payment; *lost* (the buyer's favour, or paid out) first records a refund of the disputed amount with the source `chargeback`, after which the payment and the invoice follow what the rows add up to; *unknown or missing* keeps the payment disputed, notifies the owner and managers ("payment needs review") and shows it on the invoice. Closing a dispute writes a line on the invoice's history saying which way it went and notifies the owner. A reversal that is never followed by a resolution event (PayPal) and a PayMongo dispute can be handled by the owner by hand: open a dispute, or close one as won or lost with the amount, on a payment the provider confirmed (`invoices.refund`), audited, with a notice and a history line.

## Verified revenue

Used by the Lead Sources report (`src/lib/invoices/revenue.ts` states it; `src/server/invoices/revenue.ts` applies the same rules in SQL, and a test runs both over the same random payments and refuses any difference). A payment is verified revenue when, and only when:

1. the provider confirmed it (a verified event or an authenticated read of the provider's own record), not a person's word;
2. it was **live** money (test mode moves none, and the simulated provider never does);
3. it was received (succeeded, or partly or fully refunded since) and is not held out by a dispute that is still open;
4. it was received on or before the moment the report is made ("as of").

Revenue is what was **kept and earned**: the payment less the tax in it, less what was refunded (and the tax in the refund). Currencies are never added together. A payment recorded by hand is shown on its own line and counted only if the owner chose to count it, which the report says. Deal value is never called revenue and no return figure is produced from deal value. **[fix round]** A test invoice never counts.

## Reminders

Off until the owner authorizes the exact wording, days, channels and maximum; the authorization is a fingerprint of all of them, so a change, a new wording version, 90 days or the authorizer leaving the owner role puts reminders on hold. The text is fixed in code (no AI, nothing a customer typed) and carries the customer's link only at the moment of sending. Every reminder goes through the ordinary consent-gated send chain (scope `billing`): consent, opt-outs, quiet hours, a person's hold and credits all apply, and a provider write switch that is off blocks it. A payment, a void, a write-off or a dispute withdraws reminders that have not gone out, and nothing is sent more than a day late. A person's hold on automatic messages to the customer (the Retention page) withdraws that customer's reminders that are already queued (`withdrawQueuedRemindersForContact`); ones still scheduled are skipped on their day while the hold stands, and the dispatcher checks the hold once more right before it sends. A reminder is registered after the dispatcher in the scheduler's order, so it goes out on the next tick. *Read from the code while the fix round was still being merged; its tests are the invoices and messaging chains'.* Defaults offered: 3 days before, on the day, 3 days and 10 days after, at 09:00, at most four, by email; a text or WhatsApp reminder is the owner's choice and uses the business's prepaid service credits.

## Switches and stops

| Switch | Effect |
| --- | --- |
| Workspace switch `invoices` (Module rollout page) | The module exists for the workspace. Off, the screens are hidden and new work is refused; a payment that arrives for an issued invoice is still recorded |
| `CUSTOMER_PAYMENTS_WRITES_ENABLED` | Any call to a real payment provider. Off, only the simulated provider works |
| `CUSTOMER_PAYMENTS_LIVE_ENABLED` | Live money. Off, only test mode works |
| `INVOICES_PUBLIC_DISABLED` | The emergency stop: the pay page, the return page and the three public routes answer "temporarily unavailable" without reading the database. It does **not** stop a payment a provider reports to its webhook (money that arrived is still recorded), the team's own screens, or reminders already queued: a customer who follows one sees "temporarily unavailable". The other switches and what each leaves alone are in [production-scheduler.md](production-scheduler.md) |
| Provider write switches (`TWILIO_WRITES_ENABLED`, `RESEND_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED`) | Reminders leave only while the channel's switch is on |

## Go-live checklist (each step needs the founder's approval)

1. Back up, rehearse (`scripts/rehearse-combined-migrations.mjs`) and apply migration 0093 on its own. It has not been applied anywhere.
2. Counsel approves the authorization wording (`AUTHORIZATION_TEXTS` in `src/lib/invoices/connection-rules.ts`) and the reminder wording; the placement of invoicing in the plan is decided.
3. Decide where the payment keys live (the sealed column today, or Supabase Vault) and how a key rotation will be handled (the limit above).
4. A Super Admin switches **Customer invoices and payments** on for one workspace. The owner fills in the invoice settings.
5. In a staging or local environment only: `CUSTOMER_PAYMENTS_WRITES_ENABLED=true`, the owner connects a PayMongo **test** account and a PayPal **sandbox** app, and the provider's webhook is registered at the address the card shows.
6. Settle each numbered guess in the headers of `providers/paymongo.ts` and `providers/paypal.ts` against that test account, and record the result; only then can an adapter be called verified.
7. Make a test invoice, pay it as a test through each provider, and watch the receipt, the payment and the invoice follow. Try a lost webhook (the reconcile job reads it back), a refund and a dispute.
8. For a first real client: the owner replaces the keys with live ones, `CUSTOMER_PAYMENTS_LIVE_ENABLED=true`, and the owner confirms going live. Start with one small real invoice and watch it.
9. Scheduler: name `invoiceOverdueSweep` first (it sends nothing), then `customerPaymentReconcile` (it reads from the provider), then `invoiceReminders` last, after the owner has authorized the wording and each message channel is decided. Do not name the last two in `SCHEDULER_JOBS_ONLY` until the founder approves that stage.
10. Keep `INVOICES_PUBLIC_DISABLED` and the workspace switch in mind as the two ways to stop it quickly.

## What is simulated and what has never run

- **PayMongo and PayPal: never.** Their adapters have only run against a replaced HTTP layer and fixtures written by hand, not recorded from the providers.
- **The simulated provider** signs its own webhooks and reaches nothing; it does not exist in production (`NODE_ENV=production` refuses it everywhere). Its payment ids are unique per process.
- **A real customer, a real bank, a real card**: none. Browser checks were of the simulated path (invoice list, detail, new invoice, settings, the pay page, "Pay online", the testing checkout and the return page); the invoice issue, record-payment, refund and void dialogs and the dark mode of these pages were not yet checked in a browser.
- **The scheduler** has never run in production, so `customerPaymentReconcile`, `invoiceOverdueSweep` and `invoiceReminders` have never run live.

## Founder decisions this needs

Where invoicing sits relative to the implementation fee and the monthly plan; counsel-approved authorization, reminder and (if used) late-fee wording; the credential store (sealed column or Vault) and the rotation procedure; whether a client's customer data is kept after a privacy request (issued invoices are kept today); the live-payments review for each provider; and the retention of payment receipts.
