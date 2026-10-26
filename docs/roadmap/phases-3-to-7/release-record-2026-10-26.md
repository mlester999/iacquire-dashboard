# Release record, 2026-10-26 (night)

What happened when the release candidate was merged into `master` and its three pending migrations were applied to the production database, on the founder's instruction in chat: **"commit and push to master and do migrations if there is any"**. Nothing else was authorised and nothing else was done: no provider was contacted, no switch was turned on, the scheduler did not run, no customer was messaged and no payment was taken.

## 1. What the instruction met

Two things were different from what the release documents of the same morning said, and both were found by reading the live systems before acting, not by trusting the documents.

1. **`origin/master` had moved.** It was `b82b241b`, 144 commits that the release-candidate branch did not contain (the signed marketing registration for the demo funnel and its migration 0113, internal employee setup previews, a run-time workforce policy refresh, Hermes evidence documents, a stricter 0109 rollback). The branch could not be fast-forwarded.
2. **The production database was not at "0086 plus 0081 to 0083".** The hosted ledger, read read-only, had **105 rows**: 0084, 0087 to 0109 and 0113 were already applied (applied earlier the same day, not by this session; a backup `prod-before-0087-20261026-065132.dump` was taken at 06:51 before that). The "27 pending migrations" in `integration-2026-10-26.md` came from a ledger that was *recorded, not re-read*, and it said so; it was wrong by the time of this release. **Only 0110, 0111 and 0112 were pending.**

## 2. The merge

`git merge origin/master` picks `b23f3570` as the base, which predates the shared Phases 3 to 7 files, so both sides look like they *added* them and it reported 116 conflicts. Merged against the integration commit `2a987079` (whose content master had adopted; master differs from it by 95 files), there were **8**:

| File | Resolution | Why |
| --- | --- | --- |
| `src/server/chat/service.ts` | master's | Master dropped the Studio entitlement wording from employee chat and its own e2e test expects "to review access" |
| `src/server/db/index.ts` | both | 0110 to 0112 (this branch) and 0113 (master) |
| `src/server/workforce/provisioning.ts` | this branch's | Master's only change was line endings; this branch adds the per-role tool allowlist |
| `supabase/rollbacks/0109_employee_health_probe.down.sql` | master's | Stricter: refuses to roll back while probe history exists |
| `tests/workforce-review-capabilities.test.ts` | master's | The same calendar-month time bomb, fixed there too |
| `tests/client-onboarding-ai-acceptance.test.ts`, `tests/hermes-provisioner-route-acceptance.test.ts` | master's | Setup-fee call |
| `tests/lead-hunter-activation.test.ts` | this branch's | A comment |

The full suite on the merged tree then found **four** failures, none a product defect, each two histories meeting: the work board and job-progress components used text below the 12px floor in master's version (raised to 12px); two Hermes tests still expected a plain re-check to invalidate an internal acknowledgement although master's commit `bcdbb1dd` had deliberately made the acknowledgement independent of the time of the last check (the tests now assert the new rule and keep invalidation coverage through a newly applied configuration); and `tests/migration-prefixes.test.ts` required 0110 to 0112 to be *absent* from master (they are now the merged release candidate's and it requires them present). ESLint also flagged four scratch scripts of the merge itself in the git-ignored `tmp/`, not product code; they were moved out of the tree.

## 3. Gates at the code that was released (`fa27b5bd`)

| Gate | Result |
| --- | --- |
| `tsc -p tsconfig.clean.json` / `tsconfig.scripts.json` | pass (74 s / 14 s) |
| `eslint .` | pass (149 s) |
| `vitest run` | **693 files, 10,962 tests: 10,961 passed, 1 skipped, 0 failed** (895 s) |
| Production build, Turbopack | pass (119 s, peak 5,902 MB) |
| Production build, Webpack (8 GB cap) | pass (345 s, peak 8,489 MB) |
| Combined migration rehearsal, sections A to G | pass (347 s) |

Section **G** is new (`scripts/rehearse-combined-migrations.mjs`): section F still modelled production as of 2026-10-22. G rebuilds the real 105-row ledger with the runner, populates it, takes and restores a backup, checks the dry run lists exactly 0110, 0111 and 0112, applies each with `--only` around the already-applied 0113 with the full per-step checks, and shows the backup restores the pre-state. The documents that follow the code (this file among them) were edited after that run; the tests that read documents were re-run.

## 4. The production procedure

1. **Read, not assumed.** The hosted ledger and the tables the migrations touch were read with `SELECT` only: 3 organisations, 3 users, **no invoices, payments or subscriptions**, none of the objects the three migrations create, no half-applied attempt, no other active session.
2. **Backup.** `pg_dump -Fc --no-owner` of schemas `public` and `app` from the production project, `.data/backups/pre-0110-0112-20261026T143953Z.dump` in the main checkout: 2,703,012 bytes, 5,331 entries in `pg_restore --list`, taken 2026-10-26T14:40Z over verified TLS.
3. **A proven restore.** The dump was restored into a throwaway local PostgreSQL 18 cluster (the first restore test the release plan asked for; the 2026-10-19 backups were never restored). Three errors, all benign (`public` already exists; two objects that reference Supabase's `auth` schema). Result: ledger 105 rows ending 0113, 3 organisations, 3 users, 860 audit rows, 632 role permissions, 377 public tables **all with row-level security**: equal to what production reported.
4. **The real runner on a real copy.** `scripts/migrate.ts --dry-run` against the restored copy listed exactly `0110_maintenance_agreements, 0111_customer_credit_notes, 0112_client_content_policy`; each was applied with `--only` and the ledger and the row counts read after each.
5. **0112 rewrites `app.has_permission` and `app.permitted_orgs`**, which every row-level-security policy calls. A fingerprint of the answers (every real user, all 182 existing permissions, every organisation, as the application role) was taken **before** on the restored copy, **after** on it, and on **production before and after**: all four are the same hash, `5854c8dfa624e88412473be7f62e43f062dfe99bf0e963f07e042d20124fb690` over 555 rows. The one permission 0111 adds (`invoices.credit`) is excluded from the comparison because it cannot exist before.
6. **Applied to production, in order, one at a time** (`ALLOW_REMOTE_DB_IN_DEV=true DATABASE_SSL_CA_FILE=<main>/certs/prod-ca-2021.crt node --env-file=<main>/.env --conditions=react-server --import tsx scripts/migrate.ts --only <version>`): `0110_maintenance_agreements`, `0111_customer_credit_notes`, `0112_client_content_policy`. Each exited 0 and printed `Applied now: <version>`; the ledger was 106, 107 and 108 rows after them, and a final dry run printed `Nothing pending in this scope.`
7. **Post-checks on production** (read-only, 20 checks, all passed): ledger 108 rows including 0113; every public table has row-level security; `maintenance_agreements`, `maintenance_agreement_charges`, `customer_credit_notes` and `agency_policy_switches` exist, have RLS on, are empty, and carry no write grant for the application, `anon`, `authenticated` or the site role (`customer_credit_notes`: SELECT only); the five new columns exist and `customer_invoices.balance_minor` is a generated column again; `invoices.credit` belongs to `owner` and `admin` only; **the D70 staff-access switch has no row (OFF)**; **recurring billing is OFF**; organisations, users and memberships are still 3, 3 and 3; the permission fingerprint is unchanged. `GET /api/health` answered `{"status":"ok","database":"ok","scheduler":"never_ran"}` on the code that was already deployed, with the new schema under it.

The migrations were applied **before** the push on purpose: the code expects the new tables and columns (an application that runs ahead of its migrations fails on the first query that touches them), while the code already deployed ignores them.

## 5. State after

| Item | Value |
| --- | --- |
| Production ledger | 108 rows, last `0113_demo_registration_requests`; 0110 to 0112 applied 2026-10-26 evening (+08) |
| `master` | fast-forwarded from `b82b241b` by **one squashed commit**, the one that carries this file; it has `b82b241b` as its parent, so nothing of anyone's was rewritten or dropped. Why one commit, and where the granular history is: section 8 |
| Dormant | every module off for every workspace; the D70 staff-access rule off; recurring billing off; the new payment, messaging and social provider switches off; `PAYPAL_API_BASE` unset; the scheduler has never run (`scheduler: never_ran`) |
| Real providers | none contacted |
| Customer data | none changed: the three migrations created empty tables and changed no existing row |

## 6. Way back

* **Code:** redeploy the previous production deployment in Vercel. The new tables stay; the old code does not read them.
* **Schema:** roll back in reverse with `supabase/rollbacks/0112_…`, `0111_…`, `0110_….down.sql`, each in one transaction. 0112 refuses while its switch is on, 0111 while a credit note is issued, 0110 while an agreement is open. All three are empty today, so they would run.
* **Or restore** `.data/backups/pre-0110-0112-20261026T143953Z.dump` (proven above) if a migration, not the application, were at fault. Anything written after the backup would be lost, which is why the rollbacks come first.

## 7. What this release did not do, and does not prove

* No real PayPal, PayMongo, PandaDoc, Meta or Hermes call has ever been made; the recurring-billing and credit-note code ran against stand-ins and local databases only. They are inert in production: no workspace has the feature on, and nothing has been configured.
* The scheduler has never run in production.
* The founder's D70 decision (who may read a client's approvals and activity without a support session) is still open; the enforcement is built, tested and **off**.
* A human accessibility and visual pass has not been done.
* The deployment result is in section 9, written after the deploy (a document cannot record the push that starts the deploy it describes).

## 8. How it landed on master

The first push, the full 106-commit history of the branch, was **refused by GitHub push protection (GH013)** before anything reached `master`. Three intermediate commits of the branch (`759333b1`, `03347c6d`, `97609b2c`) contain Stripe-key-shaped strings in `tests/customer-payments-connections.test.ts` and `tests/customer-payments-webhooks.test.ts` (`sk_test_AbCd…`, `sk_live_ZyXw…`, `sk_test_Rota…`). They are obviously synthetic test fixtures, and the very same lines are already on `origin/master`: both files are identical there and in the released tree. A scan of every line the release adds to `master` found only two more fixtures of the same kind (`sk_live_Zr7Q…` in the Automation Studio tests, which GitHub does not flag) and nothing else that looks like a provider key, a webhook secret, a cloud or GitHub token, a Slack token, a private key or a JWT.

The founder chose to **squash**: the release was pushed as **one commit on top of `b82b241b`**, whose tree is the released tree. The granular history was **not** pushed. It stays local, in the branch `release/master-merge-20261026` (head `ee70fe92`) and the tags `rc-2026-10-26.2` and `rc-2026-10-26`; pushing it would take the three GitHub "allow" links for the fixtures (a repository-owner decision) or a rewrite of those commits. What follows from that:

* The commit SHAs quoted in these documents (`0747ac3d`, `fa27b5bd`, `2a987079`, `ee70fe92`, and the rest) refer to the **local** history and do not exist on the remote.
* `git blame` and `git bisect` on `master` see this release as one change (about 357 files, +16,900 and -800 lines against `b82b241b`).
* The squashed tree is the tree of `ee70fe92` plus this section and the notes in `handoff.md` and `final-report.md`. Relative to the code gated at `fa27b5bd` it differs only in documents and in the line endings of `src/server/workforce/provisioning.ts` (identical content ignoring CR, rebuilt from master's own bytes so its diff against master is six lines; re-checked with `tsc` and the eight provisioning and tool-policy test files).
