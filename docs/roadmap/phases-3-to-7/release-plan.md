# Release plan for `feat/phases-3-7`

> **Status, 2026-10-26 night:** steps 1 to 4 of section 1 and the hosted-database steps of section 4 were carried out for the **release candidate** on the founder's instruction (merge with the moved `origin/master`, gates, migrations 0110 to 0112, push). What was actually done, found and verified is in `release-record-2026-10-26.md`. The scheduler, every module, every provider switch and everything in sections 5 to 7 remain as this plan describes: off, and not started. The migration table below is the 2026-10-25 plan for 0087 to 0104; those migrations were applied to production earlier on 2026-10-26 by other work, not by this plan.

Written 2026-10-25. **Nothing here had been done when it was written.** No push, merge, deploy, hosted migration, scheduler start, module switch-on, provider call or real customer message has happened for this branch; every step below needs the founder's approval in its own right (`blockers.md` lists the approvals and who owns them). The branch is `feat/phases-3-7` in `.data/wt-phases-3-7`; the exact head and the gate results at that head are in the final report (`final-report.md`) and in the last section of `verification-evidence.md`.

The point of this file is that someone who has never seen the work can take it from "local commits" to "dormant in production" to "switched on for one workspace" without guessing. Read `handoff.md` for the QA recipe and `blockers.md` for what each provider needs.

## 1. Where the branch sits relative to the other work

* The branch was cut from `origin/master` `36bf78c` (the released Phase 2) and is a descendant of it. When this was written `origin/master` still pointed at `36bf78c`; **fetch and check again before anything else**. If it has moved, merge it into the branch in a clean worktree, re-run the gates (section 3) and the migration rehearsal, and only then continue.
* The founder's **main checkout is not a safe place to merge.** Its local `master` is `22c68c2a`, 31 commits *behind* `origin/master`, and its working tree carries uncommitted AI Workforce work (changes to `capability-dispatch.ts`, `jobs.ts`, `work-runner.ts`, `schedules.ts`, `triggers.ts`, `chat/service.ts`, `leads/service.ts` and others, plus untracked files such as `supabase/migrations/0081_ai_work_job_rls_hardening.sql`). The branch also edits several of those files (job pause gate, `leads/service.ts`), so a merge there would mix two people's unfinished changes.
* **CORRECTION (2026-10-26, integration branch `integrate/phases-3-7-workforce`): there is no 0081 collision.** The untracked `0081_ai_work_job_rls_hardening.sql` in the main checkout is byte-identical (blob `a4a9131`) to the file already committed on `origin/master` (commit `cbbc9ee`), and production applied it on 2026-10-22 with 0082 and 0083 (the Unified Inbox is `0083_unified_inbox`, not 0081). The earlier statement here was wrong. The real collision was `0087` to `0090`: the concurrent AI Workforce branch (`codex/iacquire-workforce-completion`) used those numbers for four different, unapplied files; they were renumbered to `0105` to `0108` on the integration branch. See `integration-2026-10-26.md`.
* `node_modules` in the main checkout was found half-deleted on 2026-10-25 and has not been repaired from here (`npm install` there is the founder's call). This worktree has its own copy.

**Recommended path, each step on approval:**

1. In a *clean* worktree: `git fetch origin`, confirm the base (`git merge-base origin/master feat/phases-3-7`), merge `origin/master` if it moved, resolve, re-run the gates.
2. Push `feat/phases-3-7` to the remote (this also gives the 60-plus local commits an off-machine copy, which they do not have today).
3. Open one pull request. Review by area (the commit log is grouped by module; the checkpoints name the files). A reviewer should start with `src/server/purchase-intents/`, `src/server/billing/payments.ts`, `src/server/customer-payments/` and the migrations, because they handle money.
4. Merge only after the hosted-database steps below have a date, because the code expects the new tables (an application that runs ahead of its migrations fails on the first query that touches them; the new screens are behind module switches but the shared code paths are not).

## 2. What the release contains

Eighteen migrations, 0087 to 0104, each with a rollback in `supabase/rollbacks/`:

| # | Migration | Adds |
| --- | --- | --- |
| 0087 | website_chat | Public website chat sessions and messages |
| 0088 | lead_attribution | Lead touches and attribution |
| 0089 | social_media_manager | Social accounts, posts, media, metrics (private `social-media` bucket) |
| 0090 | document_buckets | Storage buckets for proposals and signed documents |
| 0091 | proposals | Proposals, links, one-time codes |
| 0092 | esign | E-signature requests and events |
| 0093 | customer_invoices_payments | Client invoices, customer payments, verified revenue |
| 0094 | reputation_followthrough | Review requests, surveys, batches |
| 0095 | external_reviews | Public reviews read from Google and Facebook |
| 0096 | staff_messages | Staff messaging |
| 0097 | staff_workload | Workload engine data |
| 0098 | requests_completion | Change orders, surveys, issue reports on Requests |
| 0099 | payment_controls | Payment gates and lifecycle |
| 0100 | demo_funnel | Prospect demo |
| 0101 | purchase_intents | Purchase intents (hashed link, frozen price, events) |
| 0102 | onboarding_snapshot | Frozen onboarding answers |
| 0103 | purchase_checkouts | Online checkout per purchase, payment hold, the evidence rule |
| 0104 | customer_reply_usage | `customer_reply` usage kind and the optional monthly reply cap |
| 0105 | workforce_local_recurrence | AI employee schedules' local recurrence (renumbered from the collided 0087) |
| 0106 | workforce_chat_schedule_previews | Chat schedule previews (from 0088) |
| 0107 | workforce_chat_booking_previews | Chat booking previews (from 0089) |
| 0108 | workforce_appointment_changes | Approved appointment changes (from 0090) |
| 0109 | employee_health_probe | The probe log; rolled back first because it reads the workspace-permission function |
| 0110 | maintenance_agreements | PayPal subscription agreements and verified charges |
| 0111 | customer_credit_notes | Credit notes on customer invoices; refuses a rollback while one is issued |
| 0112 | client_content_policy | The **flagged, off-by-default** D70 staff-access switch; refuses a rollback while it is on |

Migrations 0087 to 0102 were rehearsed as a set (up, down, up, with data seeded per migration and an exact-schema comparison after each rollback); 0103 and 0104 were added to the same rehearsal afterwards (`scripts/rehearse-combined-migrations.mjs`, sections A to F; the last pass covered 98 files). The rehearsal runs on embedded PostgreSQL 18.3; production is reported as 17.11. **No migration has run on a hosted database.**

Behaviour that ships with the code whatever the switches say: the job pause gate (a paused workspace or employee stops its AI work jobs), sealed-secret key rotation (`APP_ENCRYPTION_KEY_PREVIOUS` and `npm run secrets:reseal`), the complete workspace shutdown (calendars, Automation Studio connections, API keys, webhooks), the AI reply usage meter, the 12px type floor, the payment gate on activation.

## 3. Gates before any push

Run at the exact head to be pushed, through `node scripts/run-locked.mjs` (a second heavy job in the same worktree corrupts the first):

1. Full suite: `node scripts/run-locked.mjs test -- node node_modules/vitest/vitest.mjs run --reporter=dot` (a slow host needs the 120 s per-test ceiling already set in `vitest.config.ts`). A worker-start timeout can mark the run failed while every test passes: rerun the file, then the suite.
2. `tsc -p tsconfig.clean.json --noEmit` and `tsc -p tsconfig.scripts.json --noEmit`.
3. `eslint .`
4. Clean build: `node scripts/build-clean.mjs` (the default Turbopack build a deployment uses) **and** `node scripts/build-clean.mjs --webpack`. Both pass at this head; the webpack failure recorded until 2026-10-26 was a compile error from a `node:crypto` import in a client component, fixed in `b2bff4c3`, and is not a memory problem. Measurements: `docs/production-build-and-bundler.md`.
5. `node scripts/rehearse-combined-migrations.mjs` (all sections).
6. The browser journeys: `scripts/wave2-purchase-checkout-qa.mjs`, `scripts/wave2-maintenance-payment-qa.mjs`, the page sweep (`scripts/wave2-page-sweep.mjs`) for portal and admin at 375, 390, 768, 1280 and 1440 px in light and dark, with the simulated PayMongo (`scripts/paymongo-sim.mjs`).
7. `python -I scripts/eol-scan.py <base> WORKTREE` (line endings).

## 4. Hosted database steps (one migration at a time)

Never use the unfiltered runner or a prefix-only Supabase push. For each of 0087 to 0104, in order:

1. A fresh custom-format `pg_dump` taken the same day, listed with `pg_restore --list`, and one restore into a scratch database proven at least once before the first migration (the 2026-10-19 backups were inspected but never test-restored).
2. `scripts/migrate.ts --dry-run`, read the plan, then `--only <version>` with the exact filename:
   `ALLOW_REMOTE_DB_IN_DEV=true DATABASE_SSL_CA_FILE=<main>/certs/prod-ca-2021.crt node --env-file=<main>/.env --conditions=react-server --import tsx scripts/migrate.ts --only <version>`.
3. The post-checks printed by section F of `scripts/rehearse-combined-migrations.mjs` (tables, row-level security on, policies present, constraint definitions).
4. Stop and look before the next one.

Order notes that matter: **0103 changes a constraint that 0101 created**, so 0101 must not be rolled back while 0103 is applied (the rollback refuses, and says why); roll back in reverse order. 0104 is purely additive. 0091, 0093, 0094 and 0095 were edited in place while unreleased (decision D55), so a database that applied an older draft needs a rebuild, not a patch; no hosted database applied any draft.

## 5. Environment (all default to OFF in `.env.example`)

Nothing needs to be set for the code to run dormant. Each of these is its own approval, and a switch that is not named here must not be set:

* Emergency stops (default false; true stops the public surface for every workspace at once): `WEBCHAT_PUBLIC_DISABLED`, `PROPOSALS_PUBLIC_DISABLED`, `INVOICES_PUBLIC_DISABLED`, `REVIEWS_PUBLIC_DISABLED`, `DEMO_PUBLIC_DISABLED`.
* Permissions and write switches (default false): `CUSTOMER_PAYMENTS_WRITES_ENABLED`, `CUSTOMER_PAYMENTS_LIVE_ENABLED`, `ESIGN_WRITES_ENABLED`, `META_SOCIAL_WRITES_ENABLED`, `GOOGLE_BUSINESS_API_APPROVED`, `GOOGLE_BUSINESS_REPLIES_ENABLED`, `META_REVIEWS_ENABLED`, `META_REVIEWS_REPLIES_ENABLED`, `DEMO_ENABLED`.
* Credentials, absent until a provider account exists: `META_SOCIAL_APP_ID/SECRET`, `GOOGLE_BUSINESS_CLIENT_ID/SECRET`, the PandaDoc key and webhook secret, the client-payment provider keys (stored per workspace, sealed).
* Limits with proposed defaults the founder must confirm: `SOCIAL_MEDIA_STORAGE_MB` (2048), `WEBCHAT_DAILY_AI_REPLIES` (500), the optional per-plan `monthly_customer_replies` cap (null = no cap).
* `PAYMONGO_API_BASE` is refused in production, off loopback, and with any key that is not the simulator's. It must stay unset in production.
* A key rotation, if one is ever done, is: set `APP_ENCRYPTION_KEY_PREVIOUS` to the old key and `APP_ENCRYPTION_KEY` to the new one, deploy, run `npm run secrets:reseal`, confirm it reports zero rows still under the old key, then remove the old key.

## 6. After deploy: dormant, then one switch at a time

1. Deploy with every switch off. Open `/admin/module-rollout`: every module is off for every workspace. Smoke-test that the existing product behaves as before (sign in, CRM, Inbox, AI employees, billing page).
2. Scheduler: leave it off. When approved, set `CRON_SECRET`, then `SCHEDULER_JOBS_ONLY` to the first stage **before** `SCHEDULER_ENABLED=true` (unset runs every registered job; see `docs/production-scheduler.md`). Stage order: internal housekeeping first (`aiWorkRecovery`, `crmWorkflowRecovery`, `inboxAttention`, the retention jobs), then jobs that call providers after their sandbox run, then the customer-messaging jobs (`invoiceReminders`, `reviewRequestBatches`) last, then `customerPaymentReconcile` by name. The purchase-intent and maintenance-period sweeps run inside `maintenanceRenewalSweep`. Watch `worker_job_runs` for the named jobs only. The tick budget (195 s of worst-case provider waits against a 120 s ceiling) still needs a decision.
3. Switch a module on for **one internal test workspace** through `/admin/module-rollout`, run its smoke test (below), and only then another.
4. Providers last, each against its sandbox before its live switch: PayMongo test keys and webhook secret (client payments and the agency checkout), PandaDoc sandbox, Meta app review, Google Business Profile access, a language-model key with an evaluation, an email provider. A journey is "verified with the provider" only after its sandbox run; today none is.

## 7. Smoke tests (a non-production workspace, by hand)

* Purchase: create a purchase intent, open the public link in a private window, confirm, pay with the provider's test card, see the workspace appear with six employees in "Setup required"; replay the provider's notice and confirm nothing duplicates.
* Maintenance: pay one period, confirm paid-through moves from the paid-through day; let the plan lapse in a test workspace and confirm core CRM and core schedules keep working while Studio workflows pause.
* Sales closing: proposal to e-signature to invoice to a paid invoice to verified revenue on Lead Sources.
* Public surfaces under their kill switches (set true, reload, set false).
* Pause one AI employee, confirm its job stops and its customer reply does not send.
* Each at 390 px and 1280 px, light and dark, with a viewer, a staff member, an owner and the Super Admin.

## 8. Rollback

* **Code:** redeploy the previous build. The new tables stay; the old code does not read them.
* **A module:** turn its switch off for the workspace (nothing is deleted), or set its emergency stop.
* **Money in flight:** a provider's refund or dispute is *reported, never applied*; a held purchase can be released or closed by a Super Admin. Nothing is reversed automatically.
* **Schema:** roll back in reverse order with the files in `supabase/rollbacks/`. Those that could destroy data (for example 0101 while checkouts exist, 0103 while a cancelled purchase has a payment reference or a hold was released) refuse and say what they found; export or remove that data deliberately, or restore the pre-migration backup.
* **Scheduler:** unset `SCHEDULER_ENABLED` or remove the job from `SCHEDULER_JOBS_ONLY`; queued customer messages that were not yet sent stay queued, so check the queues before turning it on again.

## 9. Monitoring in the first week

* Application logs for `22P02`, `42P01`, `42501` (a missing table, a type mismatch, a policy refusal) in the first hour of each migration.
* `worker_job_runs`: recent start, failure count, `last_error`, per named job.
* Provider webhooks: events recorded versus events rejected (bad signature), replays ignored.
* Purchase intents stuck in `payment_verified` (provisioning failed) or with a hold; renewal reminders sent; AI cost and reply usage per workspace against the cap.
* Error tracking, paging and a staging project **do not exist** (a recorded blocker), so this list is manual until the founder decides.

## 10. What the founder decides before each step

The list is in `handoff.md` ("Approvals the founder still owns") and `blockers.md`. In short: push and merge; each hosted migration; scheduler stages; which modules for which workspaces; each environment switch; each provider account; counsel wording for proposals, payments, reviews and retention; the proposed numbers (link life, limits, caps, retention); whether the plan renews by a charge the provider makes itself (not built: only a checkout per period exists).
