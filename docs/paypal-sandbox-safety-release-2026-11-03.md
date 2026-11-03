# PayPal Sandbox safety release: the candidate, its proof, its way back (2026-11-03)

Status: **released to `master` on 2026-11-03 at 09:46 UTC, and deployed to production (section 11).** It was built as three commits on the branch `feat/paypal-sandbox-completion`, cut from the review branch tip `85463296`; CI passed on `4b71e746` (those commits merged with the review tip), which is exactly the commit that was pushed. No setting was changed and no migration was needed. Sections 1 to 10 below were written before the release and are left as they were, except where a line says what has since happened.

Why it exists: PayPal Sandbox credentials are going into Vercel Production. Reading the code and PayPal's own documentation showed four ways that could go wrong, and one gap in how a connection is proved. This release closes them. It does not make PayPal "verified", and it does not offer Sandbox checkout to anyone.

## 1. What it changes

| Commit | What | Files |
| --- | --- | --- |
| `5aae52ff` | A mistyped PayPal setting disables PayPal instead of breaking every page; the setup screen lists the 16 webhook events the code handles (the monthly plan's 11 were missing) and no longer sends anyone to PayPal's webhook simulator | 10 |
| `76820551` | "Check connection" compares the webhook's ID with `PAYPAL_WEBHOOK_ID` and its events with what the site needs | 9 |
| `e0fbd94f` | Sandbox money never changes anything real on the live site (purchases, payments started in a workspace, the automatic monthly payment); the isolated route keeps working | 16 |

Whole candidate against the review tip: **25 files, +810 / -78** (code: 16 files, +233 / -64; tests: 9 files, +577 / -14), **34 new test cases, 0 migrations, 0 settings**. The exact diff is `git diff 85463296 e0fbd94f`.

### The four problems and their fixes

1. **The setup screen lacked the monthly plan's events.** `PROVIDER_GUIDE.paypal.events` now lists all 16 events the webhook handler understands, the 11 monthly ones marked "monthly plan", and a test keeps the list equal to the handler's own `case` list so it cannot drift again.
2. **The screen told the team to use PayPal's webhook simulator.** PayPal's documentation says mock events cannot be verified by `verify-webhook-signature`, which is how this site verifies a delivery, so the site would (correctly) refuse them. The screen now says a real Sandbox purchase is the test.
3. **Sandbox money was applied like live money** (section 5).
4. **A bad setting broke the whole site.** `env()` validated every setting at once, so `PAYPAL_ENVIRONMENT=Sandbox` or a space after a plan id made every page fail on the next deployment. Stray spaces and capitals are now tolerated; a value that still cannot be used is treated as not set (a mode that is not `sandbox` or `live` falls back to `sandbox`, which never moves real money), named on the Payment providers screen as "Not usable" with the reason, and never printed.

### Check connection, now meaningful

The read-only call PayPal already answers (`GET /v1/notifications/webhooks`) also carries the webhook's `id` and `event_types`. The check now passes them on when PayPal supplied them and compares: the ID of the webhook that has this site's address with `PAYPAL_WEBHOOK_ID` (matches, differs, or not compared; neither ID is ever printed) and its events (`*` means all) with the payment confirmation plus the monthly plan's eleven when `PAYPAL_MAINTENANCE_PLAN_ID` is set. A different ID or a missing event makes the outcome "webhook not registered" with the missing events named. A webhook whose events PayPal does not list is "not compared", never a pass or a failure of its own. These field names are one of the guesses a real Sandbox run must settle.

## 2. The smallest safe release

The three commits belong together. Without `5aae52ff`, a typo in a hidden PayPal setting can take every page down on the next deployment. Without `e0fbd94f`, a Sandbox payment can clear a real workspace's setup fee. `76820551` is what stops "Check connection" from saying a connection is verified when payment notices would be refused. None adds a migration, a setting, a new route or a call to PayPal that was not already made.

## 3. Relevant tests

* 34 new cases: the settings (`tests/environment-safety.test.ts`), the guide and the check (`tests/payment-provider-health.test.ts`, `tests/customer-payments-paypal.test.ts`), the screen (`tests/payment-providers-panel.test.tsx`), the live-site definition and the purchase rules (`tests/environment-safety.test.ts`, `tests/purchase-intents-rules.test.ts`), the Super Admin's buttons (`tests/purchase-intent-actions.test.tsx`), the monthly plan (`tests/maintenance-agreement.test.ts`) and the isolation on a real embedded database (`tests/sandbox-isolation.test.ts`).
* Run locally on 2026-11-03: the 77 test files that touch purchases, billing, payments, PayPal, the monthly plan, client payments and the environment: **1,023 tests passed, 0 failed**. `tsc --noEmit` and ESLint are clean; the whitespace check CI runs over the range is clean.
* CI on the Linux workflow ("Synthetic worker isolation and app checks"): it was not started while another run for the review branch was in progress, because a push touching `src/` or `tests/` cancels that run. **Since then: run [41599484016](https://github.com/mlester999/iacquire-dashboard/actions/runs/41599484016) on `4b71e746` succeeded on all three jobs**, 07:54:55 to 08:43:08 UTC (48 minutes for the full tests, type check, lint and production build; about 2 minutes each for the pinned Hermes worker job and the operator-scripts job).

## 4. Production environment preflight (read-only)

Before any deployment, read and record:

1. `vercel env ls production` (names, never values). Read at 07:32 UTC on 2026-11-03: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT` and `PAYPAL_WEBHOOK_ID` present; **`PAYPAL_MAINTENANCE_PLAN_ID` absent** (and absent from Preview and Development, which hold no variables at all).
2. The checkout switch (`agency_billing_settings.purchase_checkout_enabled`): **off** since 07:15:13 UTC, on the founder's approval.
3. The live health route and the current production deployment (the rollback target).
4. The values of Sensitive variables cannot be read back. What can be proved after a deployment: the Payment providers screen shows `PAYPAL_ENVIRONMENT`'s value in force ("now: sandbox"), what it could not use ("Not usable" with the reason), and the read-only "Check connection" shows whether the credentials are accepted and whether the webhook has the right ID and events.

## 5. Payment isolation proof

The rule: on the live site (`isLiveDeployment()`: a production build that is not a Vercel preview or development deployment), a payment made in a provider's test mode is recorded and labelled, and changes nothing real.

| Path | On the live site | Off the live site (a developer's machine, the tests, a preview) |
| --- | --- | --- |
| A purchase paid in the Sandbox | Recorded with its checkout and verified notice; reads "Sandbox payment (test)"; **no workspace, no setup fee cleared, no provisioning**, by a person, the automatic route or the sweep; can be closed as a test purchase | Goes all the way, as before |
| A payment started inside a workspace (credit top-up, setup fee, maintenance) | Never marked paid (status `mismatch` with the reason); **no credit, no clearing, no plan extended**; audited; the team is told; the billing statements, which add up paid rows, cannot count it | Applied as before |
| The automatic monthly payment | Not offered in PayPal's Sandbox; a Sandbox charge that still arrives is **never recorded or applied** (signed notice or hourly list) | Offered and applied as before |
| Client invoices | Unchanged: already isolated by design (a test invoice takes only test payments, a real invoice only live ones; revenue counts only live, verified payments) | Unchanged |

Proof in the tests: `tests/sandbox-isolation.test.ts` pays a Sandbox order and delivers a test-mode notice with the live site simulated, and asserts no organization is created, no `payments` row exists, no attempt is counted, credits are unchanged and the buyer's pages say "test"; the same payments are then made off the live site and complete. `tests/maintenance-agreement.test.ts` does the same for the monthly plan, including the hourly catch-up path.

What is **not** proved: no Sandbox payment has been made on the live site, and this code has never run against PayPal. The first controlled Sandbox test on the live site, with its own approval, is the live proof (section 8).

## 6. Rollback plan

* No migration, no setting and no data is changed by this release, so nothing has to be undone in the database.
* Vercel: `vercel rollback <the previous production deployment's URL>`, naming the exact deployment read at release time (needs its own approval). The checkout switch stays off throughout.
* Code: `git revert e0fbd94f 76820551 5aae52ff` on `master` is a plain revert of three commits.
* One thing to know before rolling back: the earlier code has the typo hazard above, so a rollback with PayPal variables present depends on `PAYPAL_ENVIRONMENT` and the plan ID having been typed exactly.

## 7. Smoke-test procedure (read-only unless stated)

1. `/api/health` answers 200 `{"status":"ok","database":"ok"}`; `/login` answers 200; `/dev` and `/dev/purchase-preview` answer 404.
2. Super Admin, Billing, Payment providers: PayPal reads "Ready for testing" (all settings set) or "Configuration incomplete" (with the missing names), never "Verified" before a check; `PAYPAL_ENVIRONMENT` shows "now: sandbox"; the webhook section lists 16 events, 11 marked "monthly plan"; no setting says "Not usable" unless one was mistyped.
3. Super Admin, Purchase intents: the Online checkout card still says Off; the invitation list loads; the test purchase's page shows the "Verify the payment" card with the sentence that matches its status.
4. Runtime logs for the first minutes of the new deployment: counted by level, no error.
5. The database is unchanged: row counts equal to the state read just before (apart from request counters), the checkout switch still `false`, no new checkout, payment or notification.
6. **Only with the founder's approval:** press "Check connection" on PayPal. Expected: the credentials are accepted; the webhook is registered with the ID in `PAYPAL_WEBHOOK_ID` and takes the payment confirmation (and the monthly plan's events if the plan ID is set). It asks PayPal a read-only question and records one audit row.

## 8. After release: the controlled Sandbox test (a separate approval, with its exact scope)

**Approved by the founder and done on 2026-11-03: section 13.** The scope that was proposed and approved: one test purchase (`PUR-ZQ2BV3Z49N`, already confirmed, never paid), the checkout switch turned on only for the test and off straight after, a PayPal Sandbox buyer account paying in the PayPal Sandbox. Expected on the live site: the order is created at PayPal Sandbox, the buyer approves, the server captures, PayPal's signed notice arrives and is verified; the purchase reads "Sandbox payment (test)"; **no workspace, no setup fee, no provisioning, no real money**; the purchase is then closed as a test. The monthly plan and client invoices are proved on the isolated route (a developer's machine with a local database, with the Sandbox credentials in a git-ignored local file), because the live site refuses Sandbox for them by design.

## 9. The approval this needs

1. Pushing the three commits to the review branch so CI can run (about 55 minutes), once the run already in progress for the approved release has ended. *Done on 2026-11-03.*
2. When CI is green, a separate "Release to master", which deploys production. *Approved ("Release when green") and done at 09:46 UTC (section 11).*
3. Pressing "Check connection" (read-only) after that deployment. *Approved ("Press it") and done at 11:05 UTC (section 12).*
4. The controlled Sandbox test of section 8, with its own approval. *Approved ("Approve", then "Ready", then "Retry now") and done: window 1 made no payment attempt, window 2 made a Sandbox payment (13:25 to 13:31 UTC): section 13.*

## 10. What is proved against PayPal, and what is only written down (added the same day)

**Real PayPal Sandbox evidence at the time of writing: one pair of read-only calls** (a second check, with this release's code, followed at 11:05 UTC: section 12). On the founder's approval, "Check connection" was pressed once on the live site at 08:13:32 UTC, with the Production variables (the code then live: the earlier release, before this candidate). PayPal Sandbox accepted the client ID and secret (its OAuth token call) and answered the list of webhooks with one whose address is exactly `https://www.iacquire.online/api/webhooks/paypal`. One check row and one audit row were written; nothing else changed. It does **not** prove that `PAYPAL_WEBHOOK_ID` is that webhook's ID, that the webhook subscribes to the events the site needs (the code then live never compared either; this candidate does), or anything about orders, captures, signed notices or subscriptions.

**What PayPal's own specifications confirm.** The code's PayPal calls were written from documentation and tested only against hand-written stand-ins. PayPal publishes its official OpenAPI specifications (`github.com/paypal/paypal-rest-api-specifications`: Orders v2.32, Subscriptions v1.8, Webhooks Management v1.11, Payments v2.12). A script checked 78 of the assumptions the code makes about them; **77 are confirmed**:

* Orders: `POST /v2/checkout/orders` takes `intent` (`CAPTURE`), `purchase_units[]` with `custom_id`, `description` and `amount`, and `payment_source.paypal.experience_context` with `return_url`, `cancel_url`, `user_action` (`PAY_NOW`) and `shipping_preference` (`NO_SHIPPING`); it accepts `PayPal-Request-Id` (idempotency) and `Prefer`; the buyer's approval page is the `payer-action` link; `POST .../capture` exists and accepts `PayPal-Request-Id`; a capture carries `id`, `status` (`COMPLETED`), `amount`, **`custom_id`** (how a payment is tied to its checkout) and `seller_receivable_breakdown` (the fee); an order's status includes `APPROVED` and `COMPLETED`; `GET /v2/checkout/orders/{id}` exists.
* Webhooks: the list answers `webhooks[]` with `id`, `url` and `event_types[].name`; `verify-webhook-signature` takes exactly the five transmission fields, the webhook ID and the event, and answers `verification_status` (`SUCCESS`).
* Subscriptions: a plan has `status` (`ACTIVE`), `billing_cycles[]` with `tenure_type` (`REGULAR` or `TRIAL`), `frequency` (`interval_unit` `MONTH`, `interval_count`), `total_cycles` and `pricing_scheme.fixed_price`, and `payment_preferences` with `setup_fee`, `payment_failure_threshold` and `auto_bill_outstanding`; opening a subscription takes `plan_id`, `custom_id`, `start_time` and `application_context` (`return_url`, `cancel_url`, `user_action` `SUBSCRIBE_NOW`) with `PayPal-Request-Id`, and the answer has an `approve` link; a subscription has `status`, `status_update_time`, `custom_id` and `billing_info` (`next_billing_time`, `failed_payments_count`); `.../transactions` takes `start_time` and `end_time` and lists `id`, `status` (`COMPLETED`), `amount_with_breakdown` and `time`; `.../cancel` answers 204; `.../capture` exists (a way to collect a test charge).
* Payments: `POST /v2/payments/captures/{capture_id}/refund` exists.

**The one not confirmed:** the name `ORDER_ALREADY_CAPTURED`, which the code uses to read an order back when two captures race. The specification's examples do not list it, which is neither a confirmation nor a contradiction; it matters only in that rare race, and a Sandbox run can settle it by capturing one order twice.

**What no document settles, so only a Sandbox run can:** the shape of the webhook event payloads (the specifications describe the calls, not the events), in particular `BILLING.SUBSCRIPTION.*` and `PAYMENT.SALE.*`; whether the id on a monthly charge's sale notice equals the id in the transactions list (the code holds a second charge within ten days for a person rather than add a month twice); how PayPal retries and suspends after a failed charge (`payment_failure_threshold`); whether a subscription waiting for approval can be cancelled; that `PayPal-Request-Id` makes a repeated request return the same object; the fees and the currencies a given account accepts; how long PayPal retries an undelivered notice.

## 11. The release (added the same day, after it)

Like sections 14 to 17 of `docs/purchase-invitation-and-demo-release-2026-11-03.md`, this record lives on the review branch only: a documentation commit on `master` would redeploy production.

The founder approved the release with "Release when green", after being told what it carries and what it does not. Not approved and not done: pressing "Check connection" again, turning the online-checkout switch on, any setting, any migration, any PayPal call, any Sandbox checkout.

| Item | Result |
| --- | --- |
| Before | Read-only, by one script that prints a verdict (**OK** each time: 08:43, 08:56 and 09:44 UTC). CI run 41599484016 on `4b71e746`: **success, all three jobs** (section 3). `master` was `85463296`, an ancestor of the pushed commit, so a fast-forward; the code outside `docs/` equals the CI-tested commit; **25 files outside `docs/`, 0 migrations**; the whitespace check over the range was clean. The online-checkout switch was **off** (since 07:15:13 UTC). Production was deployment `iacquire-dashboard-d3mmg2z17`, and the health route answered 200 |
| Released | 2026-11-03 09:46:06 UTC (17:46 in Manila): `git push origin 4b71e746:refs/heads/master`, not forced: `85463296..4b71e746`. Git asks the founder to choose their GitHub account in a sign-in window for every push. Three earlier attempts (08:44, 08:47 and 08:58 UTC) timed out at that window unanswered, pushed nothing and deployed nothing; the fourth went through seconds after the window opened |
| Built | Vercel production deployment `dpl_FNvH1MkzXq4LRG62DqLpyJ6tCd6f` (`iacquire-dashboard-ax5w1t5wt`): created 09:46:07 UTC, **Ready after a 4 min 6 s build**, target production, and `www.iacquire.online` serves it. The previous production deployment, `iacquire-dashboard-d3mmg2z17` (`dpl_9FLiPCVwvoUJa49nXM9a6GsezXrH`), is the rollback target (section 6) |
| Live checks (read-only, 09:50 UTC) | `/api/health` answered 200 `{"status":"ok","database":"ok"}` three times (3.2 s for the first request, 0.6 s after); `/login` 200; `/dev` and `/dev/purchase-preview` 404; an invalid purchase link 200 (the "not valid" page) |
| Runtime logs | The new deployment's first minutes: 14 entries, 11 info and 3 warnings, **no error**. The warnings are the notice that already existed (section 16 of the purchase release doc recorded it for the previous release): the configured Supabase root CA file is absent from the function path and the bundled CA is used. This release changed no database or build configuration file |
| What the Super Admin sees now | Billing, Payment providers: **PayPal reads "Test verified" in "Test mode"** (the one check of 08:13 UTC, made with the earlier code, still stands); `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` and `PAYPAL_ENVIRONMENT` read "Set", with "now: sandbox"; `PAYPAL_MAINTENANCE_PLAN_ID` reads "Not set". **The webhook section lists the 16 events, the 11 monthly ones marked "monthly plan", and says a real Sandbox purchase is the test: the advice to use PayPal's simulator is gone.** PayMongo reads "Not connected" with what is missing. The Online checkout card reads **Off**. The test purchase `PUR-ZQ2BV3Z49N` still reads "Buyer confirmed" with "No online checkout was opened"; its "Record verified payment" button was not pressed |
| The database afterwards | Read-only at 09:50 UTC: the checkout switch `false` (its last audit row is the 07:15:13 switch-off); `audit_logs` 1,622, `purchase_intents` 2, `purchase_intent_checkouts` **0**, `payments` **0**, `payment_webhook_events` **0**, `email_outbox` 15, `notifications` 19: **identical to the state read before the push**. One `payment_provider_checks` row (PayPal, 08:13:32 UTC). No row in six tables holds a purchase link or token. Nothing was written by this release |
| What was not done at the time of the release | No call was made to PayPal. "Check connection" was not pressed with the new code, so the comparison of the webhook's ID and events **had not run against PayPal** (it did at 11:05 UTC: section 12). No checkout was opened and no payment exists, so the isolation of section 5 has been proved by the tests only, not yet by a Sandbox payment on the live site |

Seen and not changed: the "Online checkouts" card on a purchase's admin page says "A checkout becomes paid only when PayMongo's signed notice matches ...", although PayPal is the connected provider (`src/app/(admin)/admin/purchase-intents/[id]/page.tsx`). It should say "the provider's signed notice". It is one line, held for the next release so as not to start another 50-minute CI run for it alone.

Honest limits: the values of the four Sensitive variables were never read, by anyone here; what is known of them is what the running site shows and what PayPal answered on 2026-11-03 at 08:13 UTC (the credentials were accepted and a webhook at this site's address exists). At the time of the release, whether `PAYPAL_WEBHOOK_ID` was that webhook's ID, whether the webhook had the events the site needs, and every step from an order to a verified notice were unproved; the first two were settled by the second "Check connection" (section 12), and the rest waits for a Sandbox purchase, with the founder's approval.

## 12. The second "Check connection" (2026-11-03, 11:05 UTC): the first with this release's code

The founder approved one more press ("Press it") after being told that the check now also compares the webhook's ID and events. It was pressed once, by me, on the PayPal card of Billing, Payment providers (the card was confirmed by a screenshot first), and nothing else was pressed.

| Item | Result |
| --- | --- |
| Before | Read-only at 11:04:48 UTC: one `payment_provider_checks` row (the 08:13 UTC one), `audit_logs` 1,622, the checkout switch `false`, `purchase_intent_checkouts` 0, `payments` 0, `payment_webhook_events` 0, the health route 200 |
| What the screen said | "Connection verified", test mode, 11:05 UTC: "The provider accepted the credentials. PayPal's webhook for this address has the ID you set, and it takes every event this site needs." The header stays "Test verified" |
| What was recorded | One new `payment_provider_checks` row (PayPal, test mode, outcome `verified`, ok, webhook `registered`, proof `oauth`, **webhook ID `matches`**) at 11:05:24 UTC and one audit row `payment_provider.checked` (success, 11:05:25 UTC): `audit_logs` 1,622 to 1,623. Nothing else changed: the switch is still `false`, there is no checkout, payment or notice, the other counts are the same, and the health route still answers 200 |
| What this proves, against the real PayPal Sandbox | (1) PayPal's list of webhooks carries each webhook's `id`, and the webhook at `https://www.iacquire.online/api/webhooks/paypal` has exactly the ID stored in `PAYPAL_WEBHOOK_ID`: the ID that every signed notice is verified against is the right one. (2) The list also carries the webhook's `event_types` (the screen says the sentence above only when PayPal listed them), so the two field names the code guessed, `id` and `event_types`, are right. (3) The webhook takes the event the site requires, `PAYMENT.CAPTURE.COMPLETED`, or all events |
| What it does not prove | The check compares the **required** events only: the payment confirmation, plus the monthly plan's eleven once `PAYPAL_MAINTENANCE_PLAN_ID` is set (it is not). It does not compare the four recommended events (`PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `CUSTOMER.DISPUTE.CREATED`), so "every event this site needs" is true of the payment confirmation and says nothing about those four. It does not prove that a signed notice verifies (`verify-webhook-signature` has not run), nor orders, captures or subscriptions |

Seen and not changed: the check could compare the recommended events too and name any that are missing, so a refund or a dispute could not go unnoticed. It is a small addition, held for the next release.

## 13. The controlled Sandbox test on the live site (2026-11-03): two windows, one real Sandbox payment

The founder approved it in three steps: "Approve" (the scope of section 8: one test purchase, the online-checkout switch on only for the test and off straight after, the founder paying with their own PayPal Sandbox buyer account, no workspace, no clearance, no real money, and closing the purchase as a test afterwards), "Ready" (window 1) and "Retry now" (window 2). I pressed the switch once per window on the Purchase intents page and read production read-only; the founder paid on PayPal's Sandbox page themselves, and their Sandbox password was never seen.

| Window | Switch | Result |
| --- | --- | --- |
| 1 | On 12:03:46 UTC, off 12:23:48 UTC (the agreed 20-minute limit) | **No payment attempt.** The buyer page loaded once (12:10:33) and no Pay press reached the site. No checkout, receipt, payment or workspace was created |
| 2 | On 13:25:02 UTC, off 13:31:22 UTC (6 min 20 s) | **A Sandbox payment of US$1,499.00 was made and recorded** |

Window 2, in order (UTC):

| Time | What happened |
| --- | --- |
| 13:26:16 and 13:26:23 | The buyer reloaded the page, which now offered Pay, and pressed "Pay US$1,499.00 with PayPal". One `purchase_intent_checkouts` row was made (PayPal, test mode, US$1,499.00 charged in USD), then moved from `creating` to `pending` with PayPal's order id and its approval link: **PayPal Sandbox accepted the order request** |
| 13:30:44 to 13:30:48 | The buyer came back from PayPal's Sandbox page. This server captured the approved order with its own credentials (the return page's action). **PayPal answered `COMPLETED`, with a capture id and the fee breakdown**, and the reference, mode, amount and currency all equalled what the site had stored. The checkout became `paid` and the purchase `payment_verified` (source provider), labelled as a sandbox payment. One receipt, `ORDER.CAPTURED` (the site's own record of PayPal's answer): processed |
| 13:31:22 | The switch was turned off |
| 13:31:27 to 13:31:33 | **PayPal's own signed notice, `PAYMENT.CAPTURE.COMPLETED`, reached `/api/webhooks/paypal` (HTTP 200).** A delivery is recorded only after PayPal itself confirmed its signature (`verify-webhook-signature`), and the receipt exists: test mode, outcome `ignored`, "Already recorded as paid." The payment was counted once, through two doors |

What it did on the live site, seen with a real Sandbox payment (the isolation of section 5): **no workspace** (organizations still 4), **no `payments` row**, no setup fee cleared, no provisioning, **no email queued** (`email_outbox` still 15), and one in-app notification for the single Super Admin: "A SANDBOX purchase payment reached the live site". The admin page reads "Sandbox payment (test)", "Workspace: Never created: a sandbox payment moved no real money", and offers "Close as a test purchase" instead of "Record verified payment". The buyer's return page reads "Test payment recorded. This was a payment in the payment provider's sandbox. No real money moved, and no workspace will be created." No row in six tables holds a purchase link or token, and the health route answered 200 at every check.

**Now proved against the real PayPal Sandbox** (before this, only specifications and stand-ins): the order request and the buyer's approval link; the buyer's approval flow and return; the server-side capture with its capture id and fee; the reference, mode, amount and currency round trip; delivery of a signed notice to the live address; `verify-webhook-signature` with the stored webhook ID answering success; the repeat of a payment through its two doors counted once; and the isolation of a Sandbox payment on the live site.

**Still not proved:** refunds, reversals, disputes and denied payments (their events are not compared by "Check connection", and none has been sent); a repeated `PayPal-Request-Id` returning the same object; the name `ORDER_ALREADY_CAPTURED`; PayPal's retry of an undelivered notice; the monthly plan and client invoices (the live site refuses a Sandbox payment for them by design, so they need an isolated route; `PAYPAL_MAINTENANCE_PLAN_ID` is still absent from Vercel).

**Seen and not changed, for the next release:** (1) The admin page's "Evidence: Confirmed by the payment provider's signed notice" and its timeline line "Payment confirmed by the payment provider's signed notice" (13:30) are not exact for this payment: it was recorded from PayPal's answer to this server's capture, and the signed notice came about a minute later and was recorded as a repeat. (2) The "Online checkouts" card still names only PayMongo's signed notice (section 11). (3) The buyer's return page re-reads the status every 5 seconds for two minutes even after the payment is final; harmless and bounded.

**Not done:** closing the test purchase. The founder's approval covered it, and I filled in the close form (the reason box), but the click on "Close the purchase" was refused by the permission check of the session, and I did not work around it. **The founder then chose "Leave open"**: the purchase stays `payment_verified`, labelled "Sandbox payment (test)", so a refund or dispute notice can still be tried on it (refunding the Sandbox payment in PayPal's Sandbox dashboard needs no switch and no change here). It cannot create a workspace or clear a setup fee while it waits, and the close form I had filled in was discarded.

## 14. The refund test (2026-11-03, 23:24 UTC): PayPal's signed refund notice on the live site

The founder chose it after "Leave open" ("Refund test"). It needed no switch and no change in production: the founder did the PayPal-side steps in their own PayPal Sandbox, and I only read production, read-only (the purchase's state, its receipts, and the webhook route's runtime logs), without printing an address, a token or a provider id. The checkout switch stayed off the whole time, and no environment variable, setting or deployment was touched.

| Time (UTC) | What happened |
| --- | --- |
| 13:47:39 | Baseline: checkout `paid`, purchase `payment_verified`, no hold, two receipts, `audit_logs` 1,663, notifications 20, `email_outbox` 15, organizations 4, `payments` 0 |
| 14:05:31 to 22:58:54 | A first read-only watcher waited for any change. It ended with "no change" after 8 h 53 min on the wall clock (the PC evidently slept for much of it, so the wait was not continuous). A direct read at 22:59:33 confirmed that nothing had reached the site since 13:40: no receipt, audit row, notification or email, and no request to the webhook route in the (short) log window |
| 23:02:45 | A second watcher: it also reads the webhook route's runtime logs each cycle, because a refused delivery leaves no database row |
| before 23:14 | The founder reported ticking the webhook events (the webhook's ID still matches, so it was edited, not recreated) and learned that they already had a Sandbox business account: the seller named on the PayPal receipt, a Sandbox account called "Test Store" |
| before 23:14 | In that account, "Issue a refund" answered "Something is not right. Try again later." as soon as the button was pressed, so the refund form (with its amount box) never opened. Read at 23:14:00: nothing had reached the site |
| 23:14 to 23:23 | The account's home page showed only ₱5,000.00 PHP (the starting money) and no sales or sales volume for 30 days, while Activity listed the US$1,499.00 payment as Completed. The checkout row holds PayPal's fee for the capture, US$51.27, so about US$1,447.73 should have been credited. Reading: PayPal's Sandbox listed the payment but had not put the money on the balance, so there was nothing to refund from. The founder then added a balance to the Sandbox business account (their words) and issued the refund |
| 23:24:01 | **PayPal's signed `PAYMENT.CAPTURE.REFUNDED` notice reached `/api/webhooks/paypal` and was processed.** The watcher reported the change at 23:24:04 |

What the site did (read at 23:28:51, and on the admin page afterwards):

| Item | Result |
| --- | --- |
| Receipt | One new row: PayPal, `PAYMENT.CAPTURE.REFUNDED`, test mode, outcome `processed`, "Recorded for a person to act on; nothing was created or removed." Linked to the checkout, not to a workspace payment (there is none). A delivery is recorded only after PayPal confirmed its signature, so this one passed `verify-webhook-signature` |
| Runtime log | One `POST /api/webhooks/paypal`, HTTP 200; the only line in the log is the known warning about the Supabase root CA file path, no error |
| Checkout | `paid` to `refunded` (test mode) |
| Purchase | Status stays `payment_verified`; payment hold `refunded`; one timeline event `payment_held` (system) at 23:24:01 (`purchase_intent_events` 10 to 11) |
| Audit | One row, `purchase_intent.refund_reported` (success): `audit_logs` 1,663 to 1,664 |
| Notification | One in-app notification for the single Super Admin, severity warning: "PayPal reports a refund on a purchase" (20 to 21) |
| Not changed | No email queued (`email_outbox` still 15), no workspace (organizations 4), no `payments` row (0), no setup fee cleared, no provisioning; the switch is still off; the health route answered 200 |
| The admin page | Reads "On hold. The payment provider reported a refund for this payment. Check it with the provider, then decide whether to create the workspace."; the online checkout shows "Refunded"; the timeline has "The provider reported a refund or dispute: provisioning is on hold" (23:24). "Release the hold" and "Close as a test purchase" are offered; neither was pressed |

**Now proved against the real PayPal Sandbox:** (1) a refund notice's resource carries the link that points up to the capture, and that capture's id is the one this server stored when it captured the order, so the notice finds its purchase (the parser's reading of the shape was right for this payload); (2) a second kind of PayPal event, after `PAYMENT.CAPTURE.COMPLETED`, is delivered to the live address, verified against the stored webhook ID and recorded; (3) the recommended event `PAYMENT.CAPTURE.REFUNDED` is subscribed in the webhook; (4) on the live site a refund puts the purchase on hold for a person and creates, removes and sends nothing.

**Still not proved:** how much was refunded (the site does not record it; the founder can read it in PayPal's Activity, and it is not known here whether the refund was the full amount or a part); a reversal, a dispute or a denied payment (`PAYMENT.CAPTURE.REVERSED`, `CUSTOMER.DISPUTE.CREATED`, `PAYMENT.CAPTURE.DENIED`); a refund of a purchase that already has a workspace (it takes the other path, through the workspace `payments` row); PayPal's retry of an undelivered notice; the monthly plan and client invoices (section 13).

**Seen and not changed, for the next release** (added to the three of section 13): (4) the hold hint on the admin purchase page says "Check it in PayMongo, then release the hold if the payment stands..." for a PayPal payment: the provider's name is written into the sentence (`src/app/(admin)/admin/purchase-intents/[id]/page.tsx`, line 69), as it is in the "Online checkouts" card (item 2). (5) Neither the page, the timeline, the audit row nor the notification says how much was refunded or whether PayPal's refund is complete: the handler ignores the notice's amount and status and the receipt table keeps no body, so a person has to open PayPal, and a partial refund would turn the whole checkout "Refunded". (6) The timeline line is one fixed sentence, "The provider reported a refund or dispute", although the event records which of the two it was.

**A lesson for the next Sandbox refund or dispute:** the Sandbox business account must really hold the money before PayPal's refund screen will open. Check its balance first (here the PHP-based account showed only its starting ₱5,000.00, and a balance had to be added in the developer dashboard).

**State afterwards (read 23:28 UTC):** the switch is off; `PUR-ZQ2BV3Z49N` is `payment_verified` with the hold `refunded`, labelled "Sandbox payment (test)" and still not closed; the checkout is `refunded`; no workspace, no `payments` row, no email. Whether to release the hold or close the purchase as a test is the founder's call; nothing needs either.

## 15. The small wording and refund-record fixes (built 2026-11-04; NOT released)

The founder asked for them ("Build them") after section 14 listed what the refund test showed. They are one code commit, `60a35f4b`, on the branch `feat/paypal-sandbox-completion`, on top of the docs of section 14. They are NOT on `master` and NOT in production: releasing them needs CI and the founder's own "Release to master". No migration, no setting and no environment variable, and nothing about what a refund or a dispute holds, creates, removes or sends changed.

| Where | Before | After |
| --- | --- | --- |
| Admin purchase page, the hold hint | "Check it in PayMongo, then release the hold if the payment stands..." for any provider | "Check it with PayPal" or "with PayMongo" (the provider of the checkout that carries the hold), or "with the payment provider" when that is not known |
| Admin purchase page, "Online checkouts" | "A checkout becomes paid only when PayMongo's signed notice matches..." | "...only when the payment provider's own record matches the reference, mode, currency and amount stored here: PayMongo's signed notice, or PayPal's answer to this server's own request to take the money (its signed notice follows and counts once). The buyer returning to the site proves nothing by itself." |
| Admin purchase page, "Evidence" and the timeline line for a paid purchase | "Confirmed by the payment provider's signed notice" and "Payment confirmed by the payment provider's signed notice" (not exact: PayPal's answer to this server's capture records the payment first, and the signed notice is recorded as a repeat) | "Confirmed by the payment provider (its own record, checked against this purchase)" and "Payment confirmed by the payment provider"; the timeline's footer says "the payment provider's own confirmation" |
| Billing, Payments page | "A payment is confirmed either by PayMongo's signed notice or by a Super Admin..." | "...either by the payment provider's own record (PayMongo or PayPal) or by a Super Admin..." |
| The timeline entry for a refund or dispute notice | "The provider reported a refund or dispute: provisioning is on hold" (one fixed sentence) | "PayPal reported a refund of USD 100.00: provisioning is on hold" or "PayPal reported a dispute: provisioning is on hold" (a reversal reads as a dispute). The entry keeps fixed fields only (the provider, the kind, the notice's event name and, for a refund, the amount, currency and status), never the notice's body, a refund id or a link. Entries written before, such as the test purchase's, read "The payment provider reported a refund: provisioning is on hold" |
| The in-app notification and the audit row | "PayPal reports a refund on a purchase" with no amount; the audit row had the event name only | The notification says "PayPal reports a refund of USD 1,499.00." (or "...that is still being processed", "...that could not be completed", or "sent a refund notice" when the payload named no usable status); the audit row `purchase_intent.refund_reported` carries the amount, currency and status |
| PayPal's refund status | Passed through as PayPal's own word ("COMPLETED"), which the shared sentences did not read | Mapped to the three words the handler reads (COMPLETED to succeeded, PENDING to pending, FAILED and CANCELLED to failed, anything else to none). This also makes the existing rule "a refund that did not go through is not a refund" work for PayPal capture refunds on a workspace's own payment, where it never could |

Not changed on purpose: a refund notice still turns the checkout "Refunded" and holds the purchase whatever its amount (a "partly refunded" status would need a migration; the amount is now on the timeline, so a person can tell); "Check connection" still does not compare the four recommended events (held, section 12); the buyer's return page still re-reads every 5 seconds for two minutes (harmless).

Checks run on the worktree (2026-11-04, local): `npm run typecheck` (the app and the scripts) passed; ESLint on the nine changed files is clean; the three test files this touches (rules, PayPal checkout, PayMongo checkout) pass, 66 tests; and the related set (purchase, billing, maintenance, sandbox-isolation, journeys 1 and 8, PayPal) passes, 42 files and 617 tests. New cases: the provider names and the refund, dispute and older-entry sentences, including a part refund, a pending one, a failed one and unusable amounts (rules); a part refund of US$100.00 kept on the timeline, in the notice and in the audit row with only fixed fields kept, and disputes and reversals told as disputes with no amount (PayPal); PayMongo's entry naming PayMongo; and the status mapping. CI on Linux: not run yet when this was written.

Not verified: how the admin page looks. It needs a signed-in Super Admin and the production database, and no dev server was started on purpose (the settings available here point at production), so the wording is read from the source and covered by tests of the words, not seen in a browser. After a release, one read of the test purchase's page would show it: the old timeline entry ("The payment provider reported a refund") and "Check it with PayPal" in the hold hint.
