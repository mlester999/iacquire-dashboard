# Unified Inbox: staged rollout plan

Companion to [readiness.md](./readiness.md) (what is proven) and [README.md](./README.md) (how it works). This is a **plan, not a record of anything
having run**: no step below that touches a hosted resource has been done, and none may be done without the approval named next to it.
It follows the conventions already in this repository: [staging-environment.md](../staging-environment.md),
[production-scheduler.md](../production-scheduler.md), [workforce-migration-and-release.md](../workforce-migration-and-release.md) and
[aqi-phase3-staging-acceptance.md](../aqi-phase3-staging-acceptance.md).

## 1. Where things stand

| Fact | Source |
| --- | --- |
| The branch is `feat/unified-inbox`, based on master `22c68c2`, unpushed. It adds one migration, `0082_unified_inbox` (additive, with a rollback). | git |
| Master's **working tree** (not committed) holds the AI-workforce work: 32 modified and 12 new source, test and migration files, including migration `0081_ai_work_job_rls_hardening` and rollbacks for `0077` to `0081`. | `git status` on master |
| Production's migration ledger was recorded through **0080** on 2026-10-21, after a backup. `0081` is not applied. The workforce **application deployment is still pending**. | `ai-employee-execution-foundation.md` |
| **No staging project exists.** Creating one costs quota or money and needs approval. | `staging-environment.md` |
| The scheduler has never run in production (`CRON_SECRET` and `SCHEDULER_ENABLED` unset as of 2026-10-20). Every provider write switch is `false`. Re-check both read-only before relying on this. | `production-scheduler.md` |
| `pg_dump`, `pg_restore`, `psql` and Docker are **not on this machine's PATH**, yet custom-format backups exist in `.data/backups/` (the latest, before 0080, is about 2 MB). Which tool took them must be confirmed before any backup step. | this machine |

## 2. What this release changes, and what stays off

| Area | On release | Stays off until a separate approval |
| --- | --- | --- |
| Database | Migration 0082: new nullable columns, seven indexes plus an optional trigram index, a lifecycle-event table, two row-local triggers, three notification kinds. No existing row changes meaning. | n/a |
| `/inbox` | **Replaced for every workspace at once** (no per-workspace flag). | A global kill switch exists: `INBOX_DISABLED=true` (decision D1, built; see README). It removes the new screen; it cannot restore the old one. |
| New API routes | `/api/inbox/*` (read-only except AI help), signed-in members only. | n/a |
| AI behaviour | Replies carry an ownership fence and respect an AI pause. Summaries and suggestions need a configured AI provider; otherwise they say so. | Any live model call beyond what is already configured. |
| Messaging | Nothing new is sent. Channel health reads honestly ("switched off in this environment"). | Every provider write switch (`GHL`, `RESEND`, `TWILIO`, `META_WHATSAPP`, `N8N_ACTIONS`) and the `WORKFORCE_*_ENABLED` switches. |
| Automation | Five conversation triggers and the "Update conversation" step appear in the workflow editor. Inert until a workspace builds a workflow. | n/a |
| Scheduler | The `inboxAttention` job is registered. It does nothing until the scheduler runs. | `SCHEDULER_ENABLED=true` (which also starts every other job). |

**Order is migrate first, then deploy.** The new code needs the new columns; the old code does not mind them. Old code against the 0082 schema was
checked by running master's whole suite (22c68c2, old code) on a database that includes 0082: **4,491 tests passed and 7 failed, the same seven tests that fail on master without 0082; no new failure.**
This covers the application's own reads and writes on an embedded database; it does not replace the staging check under real concurrency.

## 3. The stages

Each stage ends at a gate. A gate is passed only when the evidence listed is in front of you **and** you have said yes. Nothing runs ahead of its gate.

| Stage | What happens | Hosted? | Approval |
| --- | --- | --- | --- |
| 0 | Local rehearsals (done, repeatable) | No | None |
| 1 | The workforce work is committed on master, then the inbox branch is merged | No (local git only) | A1, A2 |
| 2 | Release-candidate checks on the merged tree | No | None |
| 3 | Staging: provision, rehearse 0081 and 0082, acceptance, supervised scheduler test | **Yes** | A3, A4, A5, A6 |
| 4 | Provider and model checks on staging, one at a time | **Yes** | A7 (per provider) |
| 5 | Production migration | **Yes** | A8 |
| 6 | Production deployment and first exposure | **Yes** | A9 |
| 7 | Scheduler | **Yes** | A10 |
| 8 | Provider write switches | **Yes** | A11 (per provider, existing process) |

### Stage 0: local rehearsals (done, no approval needed)

* **0082 up, down, up on populated data, both notification-constraint text forms, and the refusal cases:** `tests/unified-inbox-migration.test.ts` (9 tests).
* **The merge with master's pending work, rehearsed in a scratch worktree** (`.data/wt-merge-rehearsal`, branch `rehearsal/workforce-pending-snapshot`, a throwaway
  copy of master's uncommitted files plus a trial merge). Result: **exactly three files conflict, four hunks**, all trivial, and the merged tree passes:
  type-check clean, **293 files, 4,654 tests passed, 0 failed**. On master (and on the inbox branch alone) the same seven tests fail; by elimination master's pending work is what fixes
  them (not run on its own), so the two streams are green together and the workforce work should land first (A1).
* **Old code on the new schema** (`.data/wt-compat-rehearsal`: master `22c68c2` plus only the 0082 migration and rollback files): 281 files, 4,491 tests passed, 7 failed,
  the same seven as master without 0082. So deploying the migration before the new code cannot break the code that is running.

The three conflicts and how they resolve:

| File | Conflict | Resolution |
| --- | --- | --- |
| `src/server/messaging/send.ts` | Same insert-parameter line: master changes `extra.sendAfter ?? new Date()` to `extra.sendAfter ?? req.now ?? new Date()`; the branch appends `fence`. | Keep both: `extra.sendAfter ?? req.now ?? new Date(), req.dedupeKey ?? null, purpose, fence`. |
| `tests/aqi-ops-registration.test.ts` | Master adds the five `ai*` jobs to the expected list and renames the test; the branch adds `inboxAttention` after `repliesChecked`. | Master's title (plus "inbox attention scan"), `inboxAttention` after `repliesChecked`, then master's five `ai*` jobs at the end. |
| `tests/scheduler-intervals.test.ts` | Master's "five-minute jobs" list gains three `ai*` jobs; the branch's gains `inboxAttention`. | `["aiProactiveBriefings", "aiProactiveHeldReports", "aiWorkRecovery", "crmWorkflowRecovery", "inboxAttention"]` (the `EXPECTED_SLOW` table merges without a conflict). |

The scratch worktree contains a copy of another stream's uncommitted work. It is for rehearsal only, must never be merged or pushed, and is deleted when this plan
is approved or dropped (section 7).

### Stage 1: land the work locally (A1, A2)

1. **A1, the workforce stream commits its pending work.** That is its owner's change to commit, not mine: 32 modified files, the new source and test files,
   `0081_ai_work_job_rls_hardening.sql` and the `0077` to `0081` rollbacks. Leave out `dist/`, `output/`, `tmp/`, `scripts/__pycache__/` and the unrelated
   operations scripts. Evidence to ask for: the suite is green on that commit.
2. **A2, merge `feat/unified-inbox` into master (a local merge commit, not pushed).** Resolve the three files as in the table above, then re-run type-check, lint and the
   whole suite. Evidence: the same result as the rehearsal (0 failures). If the workforce stream changes more before it commits, repeat the rehearsal first.

### Stage 2: release-candidate checks (local, no approval)

* `npm run typecheck`, `eslint`, the whole suite, and `npm run build:clean` on the merged tree (use `-- --webpack` only if the worktree's `node_modules` is a junction).
* The isolated browser QA harness (`scripts/run-inbox-qa-seed.mjs`, `scripts/inbox-qa.mjs`) on the merged tree, with the Browser pane shown, as a smoke test of the inbox
  next to the workforce screens.
* Section 1 is as of the dates in the repository's docs. Nothing hosted is re-read until A8's precondition 4, and that read-only look at the production ledger and scheduler settings needs your OK too.

### Stage 3: staging (hosted, A3 to A6)

Staging does not exist, so the first approvals are about creating it. Everything here follows `staging-environment.md`; read it with this.

| ID | You approve | What it enables | Cost or risk | Evidence you will see |
| --- | --- | --- | --- | --- |
| **A3** | Create the `iacquire-staging` Supabase project (name, organisation, region and size per `staging-environment.md`), state Free or Pro, and who owns it | A place to rehearse | $0 on Free (uses the second and last free slot, pauses after a week idle) or about $10 a month on Pro | The project reference (never the production reference) and the plan you chose |
| **A4** | How staging gets its data: **(a)** apply the whole chain `0001` onward to an empty project and load fictional data (default); **(b)** restore a production **schema-only** dump first, so staging has production's exact hand-applied history, then load fictional data; **(c)** a full production copy | The 0081 and 0082 rehearsal | (a) none; (b) one read-only dump of production's schema; (c) **customer data in a second place, not recommended** (production's last dump is only about 2 MB, so there is little to gain) | Which option, and for (b) or (c) which tool takes and restores the dump |
| **A5** | Apply migrations to staging with the staging-only env file, and run the acceptance matrix with every write switch `false` and `EMAIL_PROVIDER=capture` | The actual rehearsal | None outside staging | The printed schema versions, the checks below |
| **A6** | A supervised scheduler test on staging only (staging `CRON_SECRET`, `SCHEDULER_ENABLED=true`, one manual tick, then off again) | Proof that `inboxAttention` runs and notifies | None outside staging | `worker_job_runs` rows, the notices it created |

Order inside stage 3, stopping at the first failure:

1. Bring staging to production's current state (through `0080`). With option (a), run the runner from a checkout of master `22c68c2`, which has migrations through `0080` only (the runner applies everything it finds, and has no "up to" setting);
   with (b), restore the schema dump and confirm the ledger lists `0080`.
2. Load data: a few workspaces, conversations in every state (AI-owned, person-owned, paused, failed, resolved, archived, an opt-out), contacts with deals and tasks.
   The QA seed in `scripts/ui-qa-inbox-seed.qa.ts` is the model; it targets the embedded database, so a hosted seed needs its own small script (to be written and reviewed first).
3. **Backup staging** (custom format), verify with `pg_restore --list`, record the TOC count.
4. Apply `0081`, then `0082`, each on its own, using the repository runner with the **staging env file only** (never `npm run db:migrate`, which also loads production-valued `.env` files):
   ```bash
   # Do not run until A5 is approved. Staging env file only.
   node --env-file-if-exists=.env.staging.local --conditions=react-server --import tsx scripts/migrate.ts --only 0081_ai_work_job_rls_hardening
   node --env-file-if-exists=.env.staging.local --conditions=react-server --import tsx scripts/migrate.ts --only 0082_unified_inbox
   ```
   Each file runs as one transaction together with its ledger row, so a failure leaves nothing behind. 0082 sets `lock_timeout = 5s`: if it fails on a lock, it changed nothing and can be retried when the system is quieter.
   Record how long each took and any lock wait.
5. **Verify** (read-only; expected values in brackets):
   ```sql
   select version from schema_migrations where version in ('0081_ai_work_job_rls_hardening', '0082_unified_inbox');   -- both
   select count(*) from information_schema.columns where table_name = 'conversations'
     and column_name in ('archived_at','archived_by','resolved_at','resolved_by','outcome','ai_paused_at','ai_paused_by','ai_pause_reason','revision');   -- 9
   select count(*) from information_schema.columns where table_name = 'conversation_messages'
     and column_name in ('status_changed_at','ownership_fence','failure_kind','retry_of');   -- 4
   select count(*) from conversation_events;                                            -- 0
   select count(*) from conversation_messages where status_changed_at is not null;       -- 0 straight after the migration (old rows stay NULL)
   select relrowsecurity from pg_class where relname = 'conversation_events';             -- true
   select privilege_type from information_schema.role_table_grants
     where table_name = 'conversation_events' and grantee = 'iaq_app_user';               -- SELECT only
   select pg_get_constraintdef(oid) from pg_constraint where conname = 'notifications_kind_check';   -- the three new kinds, and every earlier kind still listed
   select indexname from pg_indexes where indexname like 'conversation%idx' or indexname = 'conversation_messages_body_trgm';
   ```
   Also record row counts of `conversations` and `conversation_messages` before and after (equal), and the public table count (one more than before: the events table).
6. **Rehearse the rollback** on a restored copy (not the only staging copy): `0082_unified_inbox.down.sql` must refuse while events or conversation notifications exist, and must leave the notification allow-list intact when it does run. Then re-apply `0082`.
7. **Acceptance:** the matrix in `staging-environment.md`, plus the inbox scenarios in `readiness.md` section 5 run in a browser against staging (the scenarios that depend on a real provider or model stay simulated until stage 4). Include the load-related checks only staging can answer:
   * `EXPLAIN` the list, counts and sync queries on a realistic number of conversations and messages, as a member (row-level security on).
   * Whether the optional trigram index `conversation_messages_body_trgm` is **ever used** by the search. If not, remove it from the migration before production.
   * `pg_trgm` is available on the hosted project (if it is not, the migration skips the index and says so).
   * Polling load: open several tabs and watch the connection pool (the app has had pool-saturation problems before; each open tab polls every 5 s).
8. **Supervised scheduler test (A6):** one tick, confirm `inboxAttention` ran and (with a customer waiting more than 30 minutes) produced exactly one notice, a second tick produced none, then turn the scheduler off.

Stage 3 exits when: every check above passes, timings are recorded, and the rollback rehearsal worked.

### Stage 4: providers and the AI model, on staging only (A7, one provider at a time)

Everything so far is simulated. Each provider is a separate approval because it needs credentials and may send a real message to a real test destination.

| Provider | Checks to run once approved | Evidence |
| --- | --- | --- |
| GoHighLevel (SMS, email, WhatsApp via GHL) | A message from an approved test phone creates the conversation and the right contact; a reply from the inbox reaches that test phone; the delivery callback moves it to delivered; an induced failure shows the failed state and a retry sends once | Screens, provider dashboard entries, `message_delivery_events` rows |
| Twilio, Meta WhatsApp, Resend | The same, including the WhatsApp reply window and an approved template, and email bounce handling | Same |
| Hermes AI employees | The Sales Assistant answers a test inquiry within its rules; a person taking over stops it; pausing stops it; nothing stale is sent | The thread, the ownership trail. The separate Hermes VPS dry-run gate still applies |
| AI help (summary, suggested reply) | Works through the configured provider, labelled "AI-written, not verified", never saved or sent | Screens, usage rows |

Rules: one account at a time, an approved test destination only, `*_WRITES_ENABLED` switched on for that provider only for the test and off afterwards, every send logged.

### Stage 5: production migration (A8)

**A8 approves one thing: applying `0081` (if the workforce stream has not already) and `0082` to the production database, in that order, after the checks below.** It does not approve deploying code.

Preconditions, each shown to you before you say yes:

1. Stage 3 passed and its timings and `EXPLAIN` findings are recorded.
2. The merged code is committed locally and the suite is green (stage 1 and 2).
3. A fresh **custom-format backup** exists and was verified with `pg_restore --list` (the precedent in `workforce-migration-and-release.md`). The backup file name and TOC count are written down.
4. The **hosted ledger was re-read read-only** and still ends at `0080` (or `0081`), with no collision for `0082`. Compare with `schema_migrations`; do not assume from numbering.
5. A quiet moment: the migration takes brief exclusive locks on `conversations` and `conversation_messages`; with `lock_timeout` it fails fast instead of queueing. Production is small today, so the locks should be momentary.

Procedure: the repository's `--only` runner (`npm run db:migrate -- --only <version>` from the main checkout, whose `.env` points at production), one file at a time, one transaction per file, as in the
2026-10-19 and 2026-10-21 passes recorded in `workforce-migration-and-release.md`; then the verification queries above against production. Record the printed output. Do not run it from any checkout or shell
where you have not confirmed which database the environment points at.

Abort and rollback:

* Any error: the transaction rolled back; the ledger is unchanged. Investigate; do not retry blindly.
* After success the change is additive, so **the normal response to a problem is to roll the application back, not the database.** The 0082 rollback exists but refuses once any lifecycle event or conversation notification exists, on purpose; use it only for a defect in the migration itself, from the backup and with your approval.

### Stage 6: production deployment and first exposure (A9)

**A9 approves deploying the merged application.** There is no per-workspace switch; the global kill switch `INBOX_DISABLED` is built (D1) and is **off by default**, i.e. the inbox is on. Decide beforehand whether the first
deployment goes out with `INBOX_DISABLED=true` (deploy dark, then redeploy with it unset when you are ready to expose it), which separates "the code is live" from "people can see it".

1. Build the exact commit that was tested. Deploy by the existing process (a preview first if one is available).
2. Smoke checklist (UI and read-only, no sends): `/inbox` loads for the internal workspace owner; the channel bar says sending is switched off; `/api/inbox/sync` and `/api/inbox/conversations` return 200; opening a conversation works; AI help either works or says it is not set up; the workflow editor lists the new triggers and step; no console errors; no 5xx.
3. Watch for an agreed period: error rate, `/api/inbox/*` latency, database pool saturation (polling), and notification volume.
4. Fastest "off": set `INBOX_DISABLED=true` and redeploy the same build (the inbox answers "temporarily unavailable"; receiving and sending carry on). Full rollback: redeploy the previous build, which brings the old screen back.
   The schema stays either way. (Old code ignores the new columns; see the compatibility result above.) Read the kill-switch section of the README first: it removes people's screen, not the AI's ability to reply.

### Stage 7: scheduler (A10)

Separate approval, per `production-scheduler.md`: deciding the host, a 24-plus-character `CRON_SECRET`, `SCHEDULER_ENABLED=false` first, then true with one manual tick, then the recurring schedule, watching the first three ticks.
**It starts every job, not just the inbox's:** email, SMS, campaigns, workflow actions, imports and webhooks, as soon as rows exist. That is why it is its own gate. The inbox's
job only creates in-app notices and CRM events. Until it runs, "customer is waiting" notices and "went quiet" workflows do nothing.

### Stage 8: provider write switches (A11, per provider)

The existing process, one provider at a time, with a supervised first send. The inbox needs nothing special here: its channel health shows "connected" only when the sender is
verified, the channel is on and the write switch is on, so it will say honestly when a channel is not ready.

## 4. Approvals at a glance

| ID | What you approve | Needed before |
| --- | --- | --- |
| A1 | The workforce stream commits its pending work on master (including `0081` and the `0077`-`0081` rollbacks) | Merge |
| A2 | Merge `feat/unified-inbox` into master locally and resolve the three files as rehearsed | Release-candidate checks |
| A3 | Create the staging project (Free or Pro, owner) | Anything on staging |
| A4 | How staging gets its data: fresh chain (default), production schema-only, or full copy | Loading staging |
| A5 | Apply migrations to staging and run the acceptance matrix, writes off | Production migration |
| A6 | Supervised scheduler test on staging | Relying on the notices |
| A7 | Each provider or model check on staging, one at a time | Enabling any provider in production |
| A8 | Apply `0081` and `0082` to production, after backup and read-only ledger check | Deployment |
| A9 | Deploy the merged application | Exposure |
| A10 | Enable the scheduler | Notices and idle workflows |
| A11 | Each provider's write switch | Live messaging |

Nothing in this plan pushes, deploys, migrates a hosted database, enables a switch or sends a message without the matching approval.

## 5. Decisions I need from you

* **D1, a kill switch: decided and built (local commit, not pushed).** `INBOX_DISABLED=true` switches the new inbox off (page, `/api/inbox/*`, the inbox's actions and notices say it is temporarily unavailable); unset or
  false is the default and changes nothing. It cannot bring the old screen back, because the new one replaced it; only a redeploy of the previous build does that. What it does and does not touch is in the README.
  Remaining question for you (part of D4): deploy dark with it set to `true` first, or expose immediately.
* **D2, how staging gets its data (A4).** I recommend the fresh chain with fictional data; production's schema-only dump if you want the exact hand-applied history.
* **D3, backups.** Which machine and tool took the existing `.data/backups/*.dump` files, so the same one is used (it is not on this machine's PATH).
* **D4, timing.** A window for stage 5, and which workspace sees the inbox first in stage 6 (the internal agency workspace is the obvious one).
* **D5, who commits the workforce work (A1)** and when, since the merge waits on it.

## 6. Rehearsal evidence this plan rests on

| Check | Result |
| --- | --- |
| Inbox branch alone | type-check, lint, build clean; suite: 4,621 passed, 7 failed (the same 7 fail on master) |
| Master's pending work | **Inferred, not run on its own:** the inbox branch alone still fails the same seven, the merged tree fails none, so master's pending changes are what fix them |
| **Inbox branch merged onto master's pending work** | 3 conflicting files, 4 hunks, resolved; type-check clean; **293 files, 4,654 tests passed, 0 failed** |
| 0082 up, down, up, both constraint forms, refusals | `unified-inbox-migration` (9 tests) |
| Old code (master `22c68c2`) on the 0082 schema | 281 files; 4,491 passed; the same 7 fail as on master without 0082; no new failure |
| Hosted anything | **Not done** |

## 7. Clean-up of rehearsal artifacts

Local only: the worktrees `.data/wt-merge-rehearsal` and `.data/wt-compat-rehearsal` (each has a `node_modules` junction that must be removed before the worktree) and the branch
`rehearsal/workforce-pending-snapshot`. The first holds a copy of another stream's uncommitted files; delete it, and its branch, once the real merge is done or this plan is dropped.
