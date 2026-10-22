# Migration audit for the integration branch

Written 2026-10-22 for `integrate/unified-inbox-workforce`. Nothing here ran against a hosted database; every result is from embedded Postgres (PGlite) with
synthetic data. Re-run it at merge time and again on any change to a migration:

```bash
node scripts/rehearse-migration-order.mjs --refs "origin/master,codex/all-six-workforce-release,codex/client-ai-onboarding,feat/unified-inbox,integrate/unified-inbox-workforce" --report .data/migration-rehearsal.json
```

It reads no environment file, opens no network connection and exits non-zero on a failure in checks A, B, C or the new tables' part of E.

## 1. The sequence

| Number | File | Carried by | Applied in production | Depends on |
| --- | --- | --- | --- | --- |
| 0077 to 0080 | `ai_work_jobs`, `ai_work_schedules`, `ai_work_triggers`, `proactive_ai_employees` | `origin/master` | **Yes** (ledger through 0080, recorded 2026-10-21 after a backup) | each other (declared in the runner) |
| 0081 | `ai_work_job_rls_hardening` | `codex/all-six-workforce-release` (`cbbc9ee`), and so `codex/client-ai-onboarding` | No | 0077, 0080 (declared) |
| 0082 | `client_employee_provisioning` | `codex/client-ai-onboarding` (`5025d4a`) only | No | `agent_provisioning_jobs` from 0002; no other table in common with 0081 or 0083 |
| 0083 | `unified_inbox` (renamed from 0082) | `feat/unified-inbox` | No | **0065** (declared in this pass, see 3) |

On the integration branch: `origin/master` 18e6e32 (Automation Studio audit, no migrations) + `codex/client-ai-onboarding` + `feat/unified-inbox`.
**No migration number is used twice, and no number is assumed free: every local and remote ref, tag and worktree was scanned for 0083 and above on 2026-10-22, and only 0082 (client onboarding) and 0083 (this) exist.**

## 2. Results

| Check | Result |
| --- | --- |
| **A. Numbers and names across six refs** (`origin/master`, `master`, both workforce branches, the inbox branch, the integration branch) | Every number has one name and every name one content |
| **B. Order of 0082 and 0083** | Applied 0082-then-0083 and 0083-then-0082 on two fresh databases: **identical schema, 10,975 schema facts compared** (columns, constraints, indexes, policies, triggers, function bodies, RLS flags, grants). The notification allow-list is compared as a set of kinds |
| **C. Existing data through 0083 up, down, up** | 400 contacts, 400 conversations, 1,600 messages and 25 notifications, hashed before and after each step: **unchanged**; the 64 notification kinds that existed before are all kept, and the three new ones are added |
| **D. Rollbacks, newest first** | 0083 and 0082 each return the schema to exactly what it was before them. 0081 returns it except for one policy: `ai_work_events_select` keeps its corrected predicate (`j.org_id = ai_work_events.org_id`) instead of the earlier self-comparison (`j.org_id = j.org_id`). That is safer, not weaker, but it is the workforce stream's rollback and is reported to them |
| **E. Row-level security** | **Every public table in the whole chain has RLS on (0 without).** 0083 creates `conversation_events` (read-only for the application role) and `inbox_rollout` (no grants at all for `iaq_app_user`, `anon`, `authenticated` or public); 0081 and 0082 create no tables |

Also covered by the suite on the integrated tree (304 files, 4,786 tests, 0 failed): `unified-inbox-migration` (0083 up, down, up on populated data, both text forms of the
notification constraint, the refusal cases), `migration-prefixes` (unique numbers; prerequisites exist and come earlier), and the Native CRM, AQi, Automation Studio and workforce migration tests.

## 3. A hazard that is now guarded

0083 rebuilds `notifications_kind_check` from the **live** constraint plus its three kinds, so it keeps every kind that exists when it runs. But a migration that rewrites that constraint
from a **copied list** and runs afterwards drops them. 0065 is the last such migration in the chain; the workforce migrations 0077 to 0082 do not touch it. The runner now refuses
`0083_unified_inbox` before `0065_support_requests` (`MIGRATION_PREREQUISITES`, checked by `tests/migration-prefixes.test.ts`). **Any future migration that touches this constraint must
extend it from the live definition the way 0083 does.**

## 4. Compatibility with the previous inbox

* The previous inbox screen (frozen from master `22c68c2`) renders and works against the 0083 schema: `unified-inbox-switch` and `unified-inbox-rollout` load it through the real page code, and
  the browser QA used it (takeover, draft approval, escalation).
* Master's whole suite (old code) on a database that includes the final 0083: 281 files, 4,491 passed, only the 7 failures master already has.
* Old rows keep working: new columns are nullable or defaulted, `status_changed_at` stays NULL on existing messages (so the first sync poll cannot match a whole history), nothing existing is rewritten.

## 5. Procedures

**Applying** (staging first, then production, each with its own approval; see [staging-readiness.md](./staging-readiness.md)): one file at a time with the repository runner and a **staging-only** env file,
`npm run db:migrate -- --only <version>` is *not* used because it also loads production-valued `.env` files. Each file is one transaction with its ledger row, so a failure leaves nothing behind.

**Rolling back** (an emergency step, reviewed by a person, from a verified backup, newest first, application stopped or rolled back first):
1. Take or confirm a backup; record its name.
2. Run `supabase/rollbacks/<version>.down.sql` in **one transaction**. 0083's refuses while lifecycle events or conversation notifications exist, on purpose: export and remove them deliberately first.
3. **Delete the version's row from `schema_migrations`, and its number from `supabase_migrations.schema_migrations` where that exists.** A rollback file is not a migration and leaves the ledger alone;
   the runner treats a version that is still listed as applied, so without this step the migration can never be applied again. (This was found by the rehearsal: re-applying without it fails on the ledger's primary key.)
4. Verify with the queries in [rollout-plan.md](./rollout-plan.md) stage 3 step 5, then roll back the next one if needed.

For a problem in the application rather than the schema, roll the application back instead: every migration here is additive and old code ignores the new columns.

## 6. Not covered

* A **production-sized copy** (lock times, `create index` duration on large tables, the optional trigram index built inside the transaction). Needs staging.
* A hosted Postgres difference in how it prints constraint definitions (the migration and its rollback read both forms and refuse to proceed on a short read).
* Concurrency while the migration runs (it takes brief exclusive locks with `lock_timeout = 5s` and fails fast).
