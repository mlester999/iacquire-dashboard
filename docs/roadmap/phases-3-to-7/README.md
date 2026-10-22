# Phases 3 to 7: ledger

This folder is the resumable record of the Phase 3 to 7 initiative (website acquisition, social media, sales closing, client operations, launch readiness). A new session should be able to continue from these files and the git history alone.

| Item | Value |
| --- | --- |
| Branch / worktree | `feat/phases-3-7` in `.data/wt-phases-3-7` (from `origin/master` `36bf78c`, the released Phase 2). `node_modules` is a junction to the main checkout. |
| Next free migration number | **0087** (0084 is reserved by `codex/client-ai-onboarding` and `codex/hermes-gha-acceptance`; 0085 and 0086 are Phase 2, applied to production). Re-check across all refs before creating one. |
| Approval boundaries | No push, deploy, hosted migration, scheduler start, live provider operation, real customer message or live social publish without the founder's explicit approval. Nothing in this initiative has been pushed. |
| Evidence classes | Built, locally tested, integration-tested (embedded Postgres, real internal services, simulated providers), tested with a real provider, deployed, production-verified. Never collapsed into one status. |

Files:

* `implementation-checklist.md`: every phase and subphase with its state.
* `architecture-and-dependencies.md`: what exists today (the audit matrix), the dependency map, and the architecture chosen for each phase.
* `decisions.md`: decisions taken and why.
* `verification-evidence.md`: exact test, typecheck, lint, build and browser results per milestone.
* `blockers.md`: what is blocked on external resources or approvals, and what was done instead.
* `handoff.md`: where to resume, the single next safe action.

Conventions that matter when resuming (learned in Phases 1 and 2):

* Edit files with the editor tools; heredocs mangle backslashes in this shell. Write patch scripts as files if a scripted edit is needed.
* Do not edit a worktree while a vitest run is using it.
* Tests run on embedded Postgres (PGlite); `tests/support/messaging.ts` (`messagingOrg`) and `tests/support/crm.ts` (`crmOrg`) are the fixtures. A phone number used in tests must be unique across the process.
* Browser QA: `scripts/run-inbox-qa-seed.mjs`, then a phase seed, then `scripts/inbox-qa.mjs` (port 3270) in the background; sign in through a local cookie bridge so no password passes through the chat; temporary helpers go in `public/dev/` and are deleted afterwards. The pane's screenshots are scaled oddly; trust DOM measurements.
* Production commands (only on approval): back up with `pg_dump` (`C:\Program Files\PostgreSQL\18\bin`), `migrate.ts --dry-run`, then `--only <version>` one at a time with `ALLOW_REMOTE_DB_IN_DEV=true DATABASE_SSL_CA_FILE=<main>/certs/prod-ca-2021.crt node --env-file=<main>/.env --conditions=react-server --import tsx scripts/migrate.ts`.
