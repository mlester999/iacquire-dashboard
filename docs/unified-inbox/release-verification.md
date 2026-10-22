# Release verification: integration branch, 2026-10-22

Branch `integrate/unified-inbox-workforce` = `origin/master` (`18e6e32`) + `codex/client-ai-onboarding` (`5025d4a`, which contains `codex/all-six-workforce-release` `cbbc9ee`) + `feat/unified-inbox` (`b03f14b`) + the commits of this pass.
All results are from the final tip before the push, on the embedded database with simulated providers, unless a row says production.

## 1. Automated checks

| Check | Result |
| --- | --- |
| Type-check (`tsconfig.clean.json`) and scripts project | clean (exit 0, exit 0) |
| Lint (`eslint .`) | 0 errors, 2 warnings (unused names in the workforce calendar files, not this work) |
| **Full suite, default state** (new inbox off for workspaces the tests create, as in production) | **308 files, 4,810 tests passed, 0 failed**, 1 skipped |
| **Everything except the inbox's own tests, new inbox switched on for every workspace** (`INBOX_TEST_ROLLOUT=on`) | **293 files, 4,610 passed, 0 failed** |
| **Everything except the inbox's own tests, global switch on** (`INBOX_DISABLED=true`) | 293 files, 4,609 passed, 1 failed: `crm-blueprints-starters > real-estate-starter ... produces Smart List filters` **timed out at 30 s** while I was running production queries and a backup on the same machine. It is the first test of its family (6.2 s alone from a cold start; the other nine take about 15 ms), passes alone three times and in the other two full runs, and has nothing to do with the inbox. An earlier run of the same state at an earlier commit: 291 files, 4,599 passed, 0 failed |
| Clean production build (`scripts/build-clean.mjs --webpack`, nothing hosted reachable) | **exit 0**; routes include `/inbox`, the six `/api/inbox/*` routes and `/admin/inbox-rollout` |
| Migration rehearsal (`scripts/rehearse-migration-order.mjs`, six refs) | A numbers and names unique across refs, B order independence of 0082 and 0083 (10,975 schema facts), C data intact through 0083 up, down, up, D rollbacks, E row-level security: **all ok** |

One intermittent failure earlier in the day (`chat-workspace-ui > keeps mobile navigation...`, once in seven full runs on the inbox branch) was investigated: not reproduced in 23 isolated runs (alone, 8 concurrent, 12 under a 32-process CPU stress); the test and the component are not touched by this work.
The component closes the mobile drawer and loads the conversation in separate commits and the modal drawer keeps the page `aria-hidden` until it unmounts, so a click on "New chat" right after the message appears could race it; **unproven**, and a one-line wait for the drawer to close in the test would remove it. It belongs to the chat stream.

## 2. Browser QA (isolated embedded database, simulated data, every send switch off; the integrated build)

* New inbox (Harbor, switched on): list and open conversation at **tablet 768 px** (no horizontal overflow, **0 axe violations**, light and dark) and **phone 375 px** (0 violations).
* Previous inbox (Other Tenant, not switched on): at **tablet** and **phone**: renders as before, shows only that tenant's conversation, `/api/inbox/sync` answers 403 `not_enabled`, 0 violations.
* Earlier in the day on the inbox branch: the Super Admin page (desktop, phone, dark, with the dialog open), switching a workspace off and on with the in-flight snapshot, takeover and draft approval on the previous screen, the Viewer and Support roles.
* `/employees` in the integrated build lists all six AI employees.

## 3. Production (the only hosted change)

* **Read-only look first:** PostgreSQL 17.11; ledger through `0080` (75 rows), none of the new objects present, no Supabase CLI ledger, `pg_trgm` installed, no employee with two open provisioning jobs (the check `0082` asks for), **3 organizations, 0 contacts, 0 conversations, 0 messages, 5 notifications, nothing queued, no channel on**.
* **Backup:** `pre-inbox-0081-0083-20261022T061107.dump` (custom format, schemas `public` and `app`, 1.9 MB, `pg_restore --list` OK, 3,693 TOC entries) in the git-ignored `.data/backups`.
* **Applied one at a time** with `scripts/migrate.ts --only`, certificate verified (`certs/prod-ca-2021.crt`): `0081_ai_work_job_rls_hardening`, `0082_client_employee_provisioning`, `0083_unified_inbox`. Each succeeded on the first try.
* **After:** ledger 78 rows ending `0083`; row counts unchanged; `ai_work_*` policies present on all six tables; `0082` added 5 columns and 2 indexes; `0083` added 9 columns to `conversations`, 4 to `conversation_messages`, 8 indexes (including the trigram index), `conversation_events` and `inbox_rollout` both with row-level security, **`inbox_rollout` empty with no grants**, the three notification kinds (67 in total), and **no public table without row-level security**.
* **The new inbox is off for every workspace.** Every workspace keeps the previous inbox. The first deployment is therefore dark by construction; `INBOX_DISABLED=true` remains the global emergency switch.

## 4. Not verified, and why

Real providers (GoHighLevel, Twilio, Meta WhatsApp, Resend) and a real Hermes run (credentials and approval); the production scheduler (off; see [scheduler-impact.md](./scheduler-impact.md)); hosted performance and concurrency (no staging, skipped by decision); a production-mode browser test (the local sign-in refuses production mode); the deployed application itself (checked after the push, see the final report).
