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

Proposed, not approved: one test purchase (`PUR-ZQ2BV3Z49N`, already confirmed, never paid), the checkout switch turned on only for the test and off straight after, a PayPal Sandbox buyer account paying in the PayPal Sandbox. Expected on the live site: the order is created at PayPal Sandbox, the buyer approves, the server captures, PayPal's signed notice arrives and is verified; the purchase reads "Sandbox payment (test)"; **no workspace, no setup fee, no provisioning, no real money**; the purchase is then closed as a test. The monthly plan and client invoices are proved on the isolated route (a developer's machine with a local database, with the Sandbox credentials in a git-ignored local file), because the live site refuses Sandbox for them by design.

## 9. The approval this needs

1. Pushing the three commits to the review branch so CI can run (about 55 minutes), once the run already in progress for the approved release has ended. *Done on 2026-11-03.*
2. When CI is green, a separate "Release to master", which deploys production. *Approved ("Release when green") and done at 09:46 UTC (section 11).*
3. Pressing "Check connection" (read-only) after that deployment. *Approved ("Press it") and done at 11:05 UTC (section 12).*
4. The controlled Sandbox test of section 8, with its own approval. *Not approved, not started.*

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
