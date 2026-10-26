# Integration record and staging plan, 2026-10-26

This is the document `release-plan.md` refers to and did not yet have. It records what the integration branch actually contains, the exact migration order to apply it, and the plan for a controlled staging release candidate. Everything here is local: **nothing has been pushed, deployed, applied to a hosted database, or run against a real provider.**

> **Correction, 2026-10-26 night.** This record was written before the release and its migration inventory came from a ledger that was recorded, not re-read. The hosted ledger, read on the night, had **105 rows**: 0084, 0087 to 0109 and 0113 were already applied (earlier the same day, not by this session), so only **0110, 0111 and 0112** were pending, not 27. They were applied to production, after a backup that was restored into a scratch cluster, and `master` was fast-forwarded. Sections 2 and 3.5 below describe the plan as it stood and are kept as written; the facts are in `release-record-2026-10-26.md`. The next free migration number is **0114** (0113 is master's signed demo registration).

## 1. What the branch is

| Item | Value |
| --- | --- |
| Branch | `integrate/phases-3-7-workforce` |
| Worktree | `.data/wt-release-candidate` |
| Base | `origin/master` (`22c68c2a` at the time of the integration; the branch is a strict descendant) |
| Commits since the base | **311** (`git rev-list --count master..ea9f93ad`, and more with this session's commits) |
| Diff since the base | **2,197 files, 264,267 insertions, 6,895 deletions** (`git diff --shortstat`) |
| Merges it contains | `feat/phases-3-7` into the AI Workforce candidate; the restricted Hermes client-provisioning acceptance; `origin/master` into client AI onboarding; the Unified Inbox with the AI Workforce chain and the Automation Studio audit; the AI Workforce release candidate with client onboarding |

Four lines of work were integrated here: Phases 3 to 7 (the product surface), the AI Workforce release candidate (six employees, jobs, schedules, triggers, provisioning), the client AI onboarding and Hermes provisioning work, and the Unified Inbox rollout. The integration itself is `2a987079`; everything after it is the release-candidate work recorded below.

## 2. Migration inventory (107 files, 0001 to 0112)

Each migration has a rollback in `supabase/rollbacks/` (81 files; the older ones predate the convention). Production is recorded as having **0001 to 0086 plus 0081 to 0083** applied — including `0081_ai_work_job_rls_hardening`, which production applied on 2026-10-22 with 0082 and 0083. That ledger state is **as recorded**, not re-read from the hosted database in this session, and must be confirmed with `select version from schema_migrations order by version` before any push. The combined rehearsal confirms the whole chain files-side: 107 migrations, 27 pending versions (0084 plus 0087 to 0112), every section A to F passed on embedded Postgres (359 s when this was first written; 244 s and 287 s in the two later full chains), and the schema after the last apply equals the fresh chain (23,302 facts).

**Pending on production, in order:**

| Version | Name | Note |
| --- | --- | --- |
| 0084 | restricted_hermes_provisioner | The rehearsal's dry run lists it as the first pending version (27 pending in all, 0084 plus 0087 to 0112) |
| 0087 | website_chat | |
| 0088 | lead_attribution | |
| 0089 | social_media_manager | Refuses while an account or post exists |
| 0090 | document_buckets | Two private buckets and `app.file_permission`; refuses while a file is stored in either |
| 0091 | proposals | Edited in place while unreleased (D55) |
| 0092 | esign | Hangs off proposals |
| 0093 | customer_invoices_payments | Refuses while an invoice, payment, refund, connection, receipt or reminder exists |
| 0094 | reputation_followthrough | |
| 0095 | external_reviews | |
| 0096 | staff_messages | |
| 0097 | staff_workload | |
| 0098 | requests_completion | |
| 0099 | payment_controls | |
| 0100 | demo_funnel | |
| 0101 | purchase_intents | |
| 0102 | onboarding_snapshot | |
| 0103 | purchase_checkouts | Changes a constraint 0101 created: never roll 0101 back while this is applied |
| 0104 | customer_reply_usage | Purely additive |
| 0105 | workforce_local_recurrence | Renumbered from the collided 0087 |
| 0106 | workforce_chat_schedule_previews | Renumbered from the collided 0088 |
| 0107 | workforce_chat_booking_previews | Renumbered from the collided 0089 |
| 0108 | workforce_appointment_changes | Renumbered from the collided 0090 |
| 0109 | employee_health_probe | Reads the workspace-permission function, so it goes back first in any rollback |
| 0110 | maintenance_agreements | Points at 0099's payments |
| 0111 | customer_credit_notes | Points at 0093's invoices; refuses while a credit note is issued |
| 0112 | client_content_policy | The **flagged, off-by-default** D70 switch; refuses a rollback while it is on |

**Next free number: 0113.**

The collision that mattered was **0087 to 0090**: the concurrent AI Workforce branch used those numbers for four different unapplied migrations, which are now 0105 to 0108. There was never an 0081 collision (the untracked file in the founder's main checkout is byte-identical to what `origin/master` already has and production already applied); the earlier statement in `release-plan.md` was corrected on 2026-10-26.

Order rules that actually bite: roll back in reverse; 0112 will not roll back while its switch is on; 0111 will not roll back while a credit note is issued; 0110 will not roll back while an agreement is open; 0101 must not be rolled back while 0103 is applied.

## 3. Staging plan (controlled release candidate)

There is **no hosted staging project**. What exists is an isolated QA environment on this machine (embedded Postgres, simulated providers, a real Chromium) and a documented rehearsal. The staging plan below is therefore in two parts: what can be proven locally first, and what a hosted staging environment would need.

### 3.1 Before a staging deploy (local, can be done now)

1. **Freeze the code.** One commit, tagged `rc-2026-10-26`. Everything after it is a new candidate.
2. **Gates at that exact head:** the full suite, both typechecks, ESLint, the default production build, the webpack build, and the combined migration rehearsal (`scripts/rehearse-combined-migrations.mjs`, sections A to F). Numbers go in `final-report.md`; a gate that fails stops the candidate.
3. **The rehearsal against a restored copy.** Take the production-shaped schema (`pg_dump` from the hosted database, restored into a scratch database) and apply the pending migrations one at a time with `--only`, running section F's post-checks after each. This is the only step that would prove the migrations against real production data, and it needs a dump the founder authorises.
4. **Browser pass on the new surfaces** (PayPal purchase checkout, the monthly plan through PayPal subscriptions, credit notes, the staff-access policy card), with the simulated adapters, at 375 and 1280 px in both themes.
5. **Line endings and repository hygiene:** `python -I scripts/eol-scan.py <base> WORKTREE`, and confirm no scratch file is tracked.

### 3.2 A hosted staging environment needs

* A separate Supabase project (or a database) that is **not** the production one, with the same major version as production (reported 17.11; the local rehearsal runs 18.3).
* The restore-tested dump above, and the migration ledger read back before and after.
* `APP_URL`, `APP_ENCRYPTION_KEY` (and no `_PREVIOUS` on a first deploy), the auth provider configuration, and the SMTP/capture choice.
* Every provider switch **off** and every module off; the scheduler off with `SCHEDULER_JOBS_ONLY` prepared but unused.
* One internal test workspace, created by hand, with the six employees left in "Setup required".
* Error tracking and a way to read server logs (neither exists today).

### 3.3 Rollout order once staging exists (each its own approval)

1. Migrations, one at a time, with the backup and the post-checks above.
2. The code, dormant: every switch off, the scheduler off.
3. One internal test workspace, module by module, starting with the CRM and the inbox behind their switches.
4. One real provider sandbox run per money or message path (see `docs/provider-readiness-matrix.md`).
5. One live Hermes profile for one internal employee, with the two-session memory canary.
6. Scheduler stages, beginning with the internal jobs and naming every job in `SCHEDULER_JOBS_ONLY`.
7. The first real client workspace, with a human watching every money path.

### 3.4 What changes behaviour on the first deploy (so nobody is surprised)

Everything that moves money, messages a customer or reads a client's content ships **off**. These are the things that are not off, because they are safer rules, and a person deploying should know them:

1. **`WORKFORCE_ROLE_TOOL_ENFORCEMENT` enforces by default.** A client AI employee whose Hermes profile exposes tools its role may not have (the web toolset belongs to the Lead Hunter alone) fails its connection check and cannot come online. The agency's own internal profiles are exempt. Only the exact word `report` relaxes it, for a deliberate profile migration. No client profile exists on a VPS yet, so nothing is lost on day one; a profile provisioned before the policy was enforced needs re-provisioning.
2. **`/dev/*` answers 404 in production** at the edge, before routing or session work, and each dev page also refuses to render outside development (`tests/dev-routes-production.test.ts` runs the real edge handler for every dev route).
3. **Every upload and free-text request body is read with a ceiling,** and the unauthenticated asset upload authenticates before it reads anything (`tests/upload-bodies-bounded.test.ts`).
4. **`PAYPAL_API_BASE` (the QA simulator's address) is refused in production,** for any address that is not this machine's, for the live environment and for a client id that is not the simulator's. Leave it unset.
5. **Recurring billing, the purchase checkout, the staff-access rule (D70) and every module start off.** The new money switches are `agency_billing_settings.recurring_billing_enabled` (default false), the existing online-checkout switch, and `agency_policy_switches` (no row means off).
6. **The Webpack build gives itself an 8 GB heap cap** (`scripts/build-clean.mjs`). A deployment uses the default Turbopack build and is unaffected.
7. **Disk:** a Webpack or Turbopack build writes about 2.3 GB; a host with less than that free fails at the end of the build (`ENOSPC` while writing `.tsbuildinfo`), after minutes of work.

### 3.5 The release-candidate manifest

| Item | Value |
| --- | --- |
| Tag (local only) | `rc-2026-10-26`, placed on the last commit whose gates are recorded in `final-report.md` section 5 |
| Pending migrations on a hosted database | 27: `0084` (reserved, in tree) and `0087` to `0112`; production is recorded as having `0001` to `0086` except `0084` (section 2; the ledger was not re-read from the hosted database) |
| New environment variables | `WORKFORCE_ROLE_TOOL_ENFORCEMENT` (documented in both env examples), `PAYPAL_MAINTENANCE_PLAN_ID`; QA only: `PAYPAL_API_BASE` (refused in production) |
| Browser evidence | PayPal purchase checkout and monthly subscription (`scripts/wave3-paypal-qa.mjs`), credit notes and the staff-access switch (`scripts/wave3-credit-policy-qa.mjs`), the billing, credit-note and policy screens at 375 and 1280 px in both themes (`scripts/billing-preview-qa.mjs`); all against stand-in providers on this machine |
| Not covered by anything in this manifest | a hosted database, a real provider, a live Hermes profile, the scheduler running, a human accessibility pass |

## 4. What "controlled release candidate" means here

`rc-2026-10-26` is a **local git tag** on a committed tree with all gates green at that commit. It is not a deployment, not a push, and not a promise: the tag exists so a later session can start from an exact, verified state and so a reviewer can diff against it. Pushing it, deploying it, or applying any migration remains the founder's decision.
