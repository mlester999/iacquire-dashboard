# Purchase invitations, payment-provider setup and the phone-ready demo: release candidate (2026-11-03)

This is one coordinated fix for the three problems found in the live purchase and demo experience (the founder's three screenshots), built on the existing application, not beside it. It is a **release candidate**: it is on the review branch `integration/hermes-bridge-final`, it is **not on `master`, not deployed, and migration 0119 has not been applied to any hosted database**. Nothing in this work enabled real payments, read or changed a production credential, sent an email to a real customer, or created a client workspace.

The journey it makes work and honest, end to end: **Demo → request (consultation or purchase) → Super Admin invites → invitation emailed automatically (or handed over with the honest reason) → buyer opens the secure link and confirms → pays at a verified provider → the provider's signed notice verifies the payment → only then the client workspace, onboarding and AI Employee provisioning.** Every arrow before "verified payment" is a request or a record; none of them creates a workspace or marks anything paid.

## 1. What was wrong, and what changed

| What was seen | Cause | What changed | Where |
| --- | --- | --- | --- |
| Purchase intents: "Online checkout is ON" while PayMongo and PayPal both read "Not ready" | The switch stored a flag and nothing else. "Not ready" gave no reasons and no instructions, and Billing, Purchase intents and the buyer's Pay button each worked it out differently | One server-derived health for each provider, in six words: **Not connected, Configuration incomplete, Ready for testing, Test verified, Live approval required, Ready for live payments**. A new Billing tab, **Payment providers**, shows each provider's state and mode, every setting by its exact name as *Set* or *Missing* (never its value), the webhook address and events, where to add them in Vercel, and **Check connection** (a real, read-only call to the provider). The checkout switch cannot be turned on while no provider is ready, and reads **"On, but blocked"** if it was on and the last provider stops being ready. Purchase intents, Billing, Rates and the buyer's Pay button read the same health | `src/lib/payment-providers/readiness.ts`, `src/server/billing/provider-health.ts`, `provider-checks.ts`, `src/components/admin/payment-providers-panel.tsx`, `src/components/purchase-intents/checkout-switch.tsx` |
| A new invitation showed only a link to share by hand, and the Invitations list still said 0 | Creating an invitation returned a link and no more: there was no email path and no record of how the link reached the buyer, and the list was drawn by the server and not updated until a reload | Creating an invitation **emails the buyer by default** (a box, ticked, in plain words, with a confirmation naming the address first), through the existing Resend path, from the server only. A **delivery record** says what really happened: Pending, **Sent to the email provider** (never "delivered" because a provider accepted it), Delivered / Bounced / Failed (only from the provider's own signed notice or refusal), or **Manual sharing required** with the reason. The list, the counter and the creation answer update **at once**, with no refresh. "Send again with a new link" and "New link for hand sharing" are safe to press twice, limited, audited and Super Admin only. The link is never stored | `src/server/purchase-intents/invitations.ts`, `delivery-events.ts`, `email-check.ts`, `src/components/purchase-intents/*`, `src/server/email*.ts` |
| `/demo/room` broken on phones: the six AI Employees collided, a floating AQi button sat on text and buttons, the header forced a sideways scroll at 320 px | The hub was one ellipse squeezed onto every width; the AQi launcher floated over the page; the open chat was a fixed panel that ignored a phone's keyboard; the fold button of the rail was clipped by 12 px at every desktop width | The hub is a grid of cards on narrow widths and the ellipse where there is room (one set of six real buttons either way). One **bottom dock bar** below 1024 px holds the consultation action and the AQi launcher, and the page keeps the room it needs plus the device's safe area. AQi is a **modal sheet** on a phone (focus, Escape, scroll lock, keyboard-aware, the question box always in view) and a non-modal corner panel on a tablet. The wording matches the action: **"Request a consultation"** unless a real scheduling page is set; **"Request my purchase link"** | `src/components/demo/showroom/*`, `src/components/demo/chat.tsx`, `src/lib/demo/outcomes.ts`; details in `docs/demo-showroom.md` |

Also changed because the three problems met there: the buyer's page (`/purchase/<link>`) shows the link's expiry in the **buyer's** time zone, the same text as the email; a demo prospect's page lists the invitations made from it ("Asked for a purchase link"), through the invitation's own timeline (no schema change); the team's notification for a purchase request says it is a request.

## 2. What did not change

* The agreed prices (US$1,499 setup, optional US$299/month) and the package entitlements. The database still refuses any other figure.
* **Real-money payments stay off.** Nothing here switches online checkout on, sets a provider key, confirms the live-payments review or creates a live checkout. A live key now needs the agency's payment and tax review **and** a passing connection check for the same configuration; until both, buyers are not offered a Pay button.
* No production credential, environment variable or setting was read or changed. No email was sent to anyone: every email test uses a stand-in provider.
* The purchase link is still a bearer secret of which only a hash is stored; the confirm, payment-verification and workspace-creation rules are unchanged (`docs/purchase-intents.md`).

## 3. The release candidate

| | |
| --- | --- |
| Branch | `integration/hermes-bridge-final` (the review branch). Base `d1162e3d`, the tip it started from: a fast-forward. Two commits: `2cc81c4c` (the change: 85 files, +6,413 / -509) and `de3dec84` (one blank line removed from a test file, because CI's entry check refuses it). **The commit CI tested and passed is `de3dec84`**; anything after it is documentation only |
| Live master | `bb1193b4` (production deployment `iacquire-dashboard-o7slvm1qi`, read from the 2026-11-02 release record). The release candidate is a descendant of it, so releasing is a **fast-forward** of `master` |
| Schema change | **One migration, 0119**, additive, with a rollback and a rehearsal (section 4). Nothing else |
| New settings | None are required to deploy. Email and the providers need the settings in section 5 to do anything |

## 4. Migration 0119, `purchase_invitation_delivery`

* **Adds** `purchase_intent_deliveries` (one row per attempt to put a link in a buyer's hands, with its status, reason, recipient, provider, the provider's message id, a unique idempotency key per agency, and the link's expiry) and `payment_provider_checks` (the result of each "Check connection", append-only, holding a hash of the non-secret shape of the configuration and no key). Both have row-level security, are written only by trusted server code, and the application role can only read them, scoped to the one agency workspace. It also allows one more timeline entry kind, `invitation_email`.
* **Rollback** `supabase/rollbacks/0119_purchase_invitation_delivery.down.sql` **refuses while any delivery, provider check or invitation-email timeline entry exists** (dropping them would erase what was really sent). It runs before the 0101 rollback.
* **Rehearsed on embedded Postgres** (`scripts/rehearse-combined-migrations.mjs`, no hosted database touched):
  * New **section H**, "the production ledger as it is now (112 rows, 0119 pending)": the dry run lists exactly 0119; applied alone after a backup, **3,952 earlier rows in 382 tables unchanged**, 2 new tables with row-level security, empty, select-only for the application role, no public table without row-level security, the schema equals the fresh chain (23,594 facts), the Supabase-CLI-ledger case records itself by number, and restoring the backup returns the ledger to 112 rows ending `0118_audit_logs_purge_detach` with the 127 schema facts 0119 added gone again. **Passed.**
  * The whole history, sections A to H, **all passed** (430 s): the 112 files apply in order on an empty database with every number used once and a rollback for each of the 41 migrations from 0077; each migration applied one at a time on a populated database leaves every earlier row unchanged; the schema after every step equals the fresh chain (23,580 facts); every rollback newest first, then forward again, ends on the same schema; the earlier hosted-procedure sections F and G (ledgers of 80 and 108 rows) now carry 0119 as well.
  * **0119's own rollback**, with the rehearsal's dataset given a delivery the provider accepted, an invitation-email timeline entry and a provider check (B, C and D were re-run after adding them, 190 s, all passed): on that database the rollback **refuses** ("purchase invitation deliveries exist. Export them deliberately first."); after the clean-up an operator would do first, it runs and returns the schema to exactly the one recorded before 0119 (23,454 facts) with all 8,059 earlier rows unchanged; applied forward again it matches the fresh chain.
* **The code tolerates the tables being absent on its read paths** (`to_regclass`), so a deploy that reaches production before the migration shows no delivery information instead of failing. Creating an invitation writes the delivery row, so **the order is still migration first, then code.**

## 5. Settings the founder must make (names only; none is set by this release)

Email, so invitations are emailed:

| Setting (Vercel, Production) | Value | Why |
| --- | --- | --- |
| `EMAIL_PROVIDER` | `resend` | Anything else (the default `capture`) stores messages and sends none; the form then says so and hands over the link |
| `RESEND_API_KEY` | A Resend API key. A **Full access** key lets "Check email setup" read the domain and the webhook; a sending-only key sends fine but the check will say it could not be checked | Sending |
| `EMAIL_FROM` | An address on a domain **verified in Resend**, for example `iAcquire <no-reply@iacquire.online>` | A placeholder or unverified domain is refused by the provider, and the form says so |
| `RESEND_WEBHOOK_SECRET`, and a Resend webhook to `https://www.iacquire.online/api/webhooks/resend` with `email.delivered`, `email.bounced`, `email.complained` (and `email.failed`, `email.suppressed`) | The signing secret Resend shows for that webhook | Without it an accepted invitation stays at "Sent to the email provider" for good. That is the honest answer, not a fault |

Payments, only when the founder decides to accept online payments (each is its own approval; the Payment providers tab names each one and shows Set or Missing): `PAYMONGO_SECRET_KEY` (start with a `sk_test_` key), `PAYMONGO_WEBHOOK_SECRET`, optionally `PAYMONGO_PAYMENT_METHODS`, the USD to PHP rate and its source under Billing, Rates & payments; `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENVIRONMENT=sandbox` first. The webhooks are `/api/webhooks/paymongo` (event `checkout_session.payment.paid`) and `/api/webhooks/paypal` (event `PAYMENT.CAPTURE.COMPLETED`). Live keys additionally need the live-payments review confirmed in Billing.

## 6. Release order (a proposal: none of it is approved or done)

Each step is a separate approval of the founder's, as on 2026-11-02 (`docs/client-production-release-runbook-2026-11-03.md`, sections 3 and 13).

1. **Restore point.** The previous dump (`...\20261102T122432Z\`) predates 0115 to 0118 and anything written since (including the purchase intent made on 2026-11-02). Take a fresh verified one before the migration (Supabase Free has no managed backups).
2. **Apply 0119 alone**, with the runner's own `--only 0119_purchase_invitation_delivery`, after its dry run says exactly that one is pending, with the same lock gate and post-checks used for 0115 to 0118. 0119 takes a brief lock only to add two empty tables and to replace one check constraint on `purchase_intent_events`, a small table whose few rows are checked against the new constraint.
3. **Fast-forward `master`** to the release commit (the one with a green CI run) and let Vercel build the production deployment. Check `/api/health` and the set of static assets on `/login` change.
4. **Smoke** (read-only, no side effects): the Billing page opens and the Payment providers tab reads "Not connected" for both providers; Purchase intents opens and, if the switch was left on with no provider, reads "On, but blocked"; `/demo/room` on a phone-width window.
5. **Set the email settings** (section 5), redeploy, press **Check email setup**: it must say every item passed before the next step.
6. **Make one invitation to an address the founder owns** (not a customer), leave the box ticked, confirm. Expect "Sent to the email provider", then, within seconds with the webhook set, "Delivered". Open the email on a phone and follow the link. Then press **Send again with a new link** and see that the first link stopped working.
7. **Providers and real money**: separate approvals, in the order PayMongo test keys, Check connection, a test purchase with PayMongo's test card, PayPal sandbox; live keys and the live review only when the founder says so.

## 7. Rollback

* **The application:** `vercel rollback` to the deployment that serves production now, `iacquire-dashboard-o7slvm1qi` (built from `bb1193b4`), read again before use because it moves with every release. The migration is additive, so the old code runs on the new schema with no data change.
* **The migration:** only after the code is rolled back (the new code writes the delivery table). Run `0119_purchase_invitation_delivery.down.sql`; it refuses if any delivery, provider check or invitation-email entry exists, because those are the record of what was sent. If one exists, export it first or leave 0119 in place: leaving it is harmless.
* **Last resort:** the restore point of step 1. Anything written after it is lost, which is why the rollbacks come first.
* **Switches:** nothing in this release turns a switch on, so nothing needs turning off. An invitation already emailed cannot be un-emailed; **Send again with a new link** makes the earlier link stop working at once.

## 8. What was verified, and what was not

**Static checks** (on the final tree). `tsc --noEmit` on the whole project including its tests, and on the scripts: no errors. ESLint on all 79 changed or new source files: no problems.

**Automated tests** (embedded Postgres and jsdom; stand-in providers; nothing leaves the machine). **139 new tests in 10 new files**: `purchase-invitation-delivery` (17: creation, the single email, every status, the link absent from every table, idempotency, resend and rotation limits, permissions), `purchase-invitation-notices` (14: the provider's signed delivered / bounced / failed notices, replay, tampering, out of order), `purchase-invitation-origin` (5: a demo request creates nothing, the prospect link both ways, who may read it), `purchase-invitation-email` (11), `purchase-invitation-delivery-migration` (7), `purchase-email-setup` (13), `payment-provider-health` (19), `purchase-invitation-ui` (20), `payment-providers-panel` (19) and `demo-mobile-layout` (14); and updated tests where the behaviour is meant to differ (the live gate in `billing`, the rollback chain, the demo's wording). On the final tree the focused sets (the demo, its guards, purchase, payment-provider, billing and Resend suites) pass: **45 files, 822 tests**. An earlier broader run also passed: 67 files, 873 tests (purchase, billing, maintenance, the payment gate, the purchase-to-client journey, migration numbering, tenant isolation, email, messaging, customer payments). The **full suite** ran in CI on the pushed commit and passed (section 11). A full run on this machine (855 files, 13,591 tests passed) had one failure: a chat test that stops a running reply after a fixed wait (`tests/chat.test.ts`, "stops a running response") lost its race while seven test workers shared the machine; it passed alone three times, passed in CI, and nothing in this change touches chat.

**Browser measurement** (headless Chromium through `scripts/demo-responsive-qa.mjs`, against the development server's sample-data pages; light and dark; widths 320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280 and 1440, and landscape phones and tablets). Every family was run at every width; a family touched by a later fix was run again after it. **No scenario had a failure** in its last run (the first six rows ran before the last edits to the open chat panel, which do not change the closed pages they measure, and the final pass below re-ran every demo view at 390 and 1280 px):

| Family | Scenarios |
| --- | --- |
| The nine demo views, portrait, both themes | 198 |
| Landscape phones and tablets | 35 |
| AQi open (a sheet on a phone, a panel from 640 px): portrait, plus a regression run | 66 + 11 |
| AQi open, landscape (the question box must be inside the panel) | 42 |
| The two confirmation dialogs (consultation, purchase request) | 44 + 22 |
| Window ended, AI off, messages used up, request already sent | 33 + 22 + 11 + 22 |
| A very long business name | 88 |
| The folded rail | 18 |
| The invitation list and form | 22 |
| The 20 Super Admin payment states (the providers, the checkout switch, the invitation answers, the list, empty, email not set up) | 440 (the first sweep found one thing, fixed and run again) |
| The buyer's purchase page: 10 states (invited, no maintenance plan, a very long name, ready to pay, retry, hand payment, expired, verified, invalid link, rate limited) and a landscape run | 154 + 7 |

The checks fail a scenario on: sideways scroll or anything past the viewport, text over text, text a box clips, a target under 24 px, a fixed layer covering something that matters (at the top and at the end of the page), a hub that is not six separate named buttons, a dialog or sheet that leaves the screen or loses focus, the open AQi panel covering the consultation action, and a question box that is not visible inside the panel. A last pass ran the same checks plus **axe-core (WCAG 2.2 A and AA rules)** on every demo view, AQi open, both dialogs, the folded rail, all 20 admin payment states and all 12 buyer states, at 390 and 1280 px in both themes: **182 scenarios, no violation of any impact**. It found one first (the demo's home link at desktop widths did not contain its visible words in its name: fixed).

**What this pass found and fixed in the product** (in addition to the three problems above): the AQi question box was pushed below the fold of the panel on a short phone and on a phone on its side (the starter questions now live in the scrolling message area, the intro folds away while the keyboard is up, and a short screen gets a tighter layout and a shorter prompt); the invitation form's checkboxes were squeezed to 13 px wide; the invitation list truncated the buyer's address at 320 px; the buyer's page showed the link's expiry in the server's time zone; the demo's home link name did not contain its visible words.

## 9. What is not claimed

* **Nothing has been run against a real PayMongo, PayPal or Resend account.** The provider calls are built from each provider's own documentation (PayMongo's `GET /v1/payments` and `GET /v1/webhooks`, PayPal's token and webhook list through the existing adapter, Resend's domains and webhooks) and tested against stand-in answers. The **first real "Check connection" and "Check email setup" are the acceptance test**: if a provider answers differently from its documentation, the check says it could not confirm, never that it passed.
* Resend's real delivery and bounce notices were never seen; the webhook handling is tested with notices signed the way Svix signs them.
* The phone layout was measured in headless Chromium at the listed widths, not on a real device; the on-screen keyboard was simulated, not real. Safari, Firefox and a screen reader were not tried (axe-core finds only part of what a person using a screen reader meets).
* A purchase request from the demo still needs a person: nothing invites, emails or provisions by itself. Automatic workspace creation after a verified payment is the existing, separately switched feature and is not enabled here.
* PayMongo does not re-send a missed notice and no read-back sweep of PayMongo checkouts exists: a notice that never arrives leaves the purchase unpaid until a Super Admin records the payment by hand (a known gap, unchanged).

## 10. Decisions and approvals only the founder can give

1. The three approvals of section 6, steps 1 to 3, in that order, each on its own.
2. Whether `RESEND_API_KEY` should be a Full access key (so the setup check can prove the domain) or a sending-only key (least privilege; the check then says it could not be checked).
3. Whether a Resend webhook may point at production (needed for "Delivered" and "Bounced").
4. Which payment provider to open first, and when; the USD to PHP rate and its source; the live-payments review (legal and tax) before any real money.
5. A real scheduling page for consultations, if there is one: until then the button says "Request a consultation".

## 11. CI result of the release candidate

The repository's Linux workflow, "Synthetic worker isolation and app checks", on `de3dec84`: **success**, three jobs, all green ([run 41508107794](https://github.com/mlester999/iacquire-dashboard/actions/runs/41508107794)).

| Job | Result | Time |
| --- | --- | --- |
| Full tests, TypeScript, lint (offline) and production build: the entry check that the candidate contains the approved changes and has no whitespace error since the approved master, then the whole test suite, the type check and lint with the network disabled, then the production build | success | 47.1 min |
| Build pinned Hermes worker and run synthetic checks | success | 1.9 min |
| Client runtime operator scripts, overlays and preflight | success | 1.4 min |

* Vercel's preview build (`next build`) of both pushed commits succeeded.
* The first run, on `2cc81c4c` ([run 41507512323](https://github.com/mlester999/iacquire-dashboard/actions/runs/41507512323)), failed in its first job at the entry check, in 11 seconds and before any test ran: that check applies git's default whitespace rules to everything added since the approved master, and one test file ended with a blank line. `de3dec84` removes it. The other two jobs passed on that run too.
* The exact test counts on Linux are in the job log, which needs a GitHub sign-in to read; the repository's own comparison (`.github/scripts/known-failures.mjs`, whose list of known failures is empty) is what the job passed.
* Nothing was merged, deployed or applied by this: `master` is still `bb1193b4`, production still runs it, and migration 0119 exists only in the repository.
