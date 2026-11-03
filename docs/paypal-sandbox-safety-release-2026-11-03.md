# PayPal Sandbox safety release: the candidate, its proof, its way back (2026-11-03)

Status: **a release candidate, not released.** It exists as three commits on the branch `feat/paypal-sandbox-completion`, cut from the review branch tip `85463296`. Nothing here is on `master`, nothing is deployed, no setting is changed, and no migration is needed. Releasing it is the founder's separate decision (section 9).

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
* CI on the Linux workflow ("Synthetic worker isolation and app checks"): **not yet run for this candidate.** Pushing it to the review branch is what starts it (about 55 minutes). It is not started while another run for the review branch is in progress, because a push touching `src/` or `tests/` cancels that run.

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

1. Pushing the three commits to the review branch so CI can run (about 55 minutes), once the run already in progress for the approved release has ended.
2. When CI is green, a separate "Release to master", which deploys production.
3. Pressing "Check connection" (read-only) after that deployment.
4. The controlled Sandbox test of section 8, with its own approval.
