# Phases 3 to 7: ledger

This folder is the resumable record of the Phase 3 to 7 initiative (website acquisition, social media, sales closing, client operations, launch readiness). A new session should be able to continue from these files and the git history alone.

| Item | Value |
| --- | --- |
| Branch / worktree | `feat/phases-3-7` in `.data/wt-phases-3-7` (from `origin/master` `36bf78c`, the released Phase 2). `node_modules` is a junction to the main checkout: never remove the worktree without removing the junction first. |
| Where it stands (2026-10-23) | Phases 3 and 4 built and verified locally; the six release checks done; Phases 5 to 7 audited and planned, **not built**. See `evidence-report-2026-10-23.md`. |
| Next free migration number | **0091** (0084 is reserved by `codex/client-ai-onboarding` and `codex/hermes-gha-acceptance`; 0085 and 0086 are Phase 2, applied to production; 0087 to 0090 are local only). The allocation for later modules is in `phase-5-7-plan.md`. Re-check with `scripts/rehearse-combined-migrations.mjs` (section A) before creating one. |
| Approval boundaries | No push, deploy, hosted migration, scheduler start, live provider operation, real customer message or live social publish without the founder's explicit approval. Nothing in this initiative has been pushed. |
| Evidence classes | Built, locally tested, integration-tested (embedded Postgres, real internal services, simulated providers), tested with a real provider, deployed, production-verified. Never collapsed into one status. |

Files:

* `evidence-report-2026-10-23.md`: **start here.** The state of every phase, the six release checks, code readiness versus rollout readiness, the ordered approval path, estimates with their method, open items.
* `handoff.md`: where to resume, the single next safe action, traps.
* `phase-5-7-plan.md`: what exists and what is missing for Phases 5 to 7, defects found in existing code, migration number allocation, cross-module decisions, waves, founder decisions.
* `audit/`: the eight audits (proposals and e-signature; customer invoices and payments; reputation and retention; requests and projects; staff messages and workload; onboarding, demo and billing; employees, storage and Super Admin; security, performance and launch) and the Phase 4 review's confirmed findings. Each has a recommended design.
* `implementation-checklist.md`: every phase and subphase with its state.
* `architecture-and-dependencies.md`: the audit matrix, the dependency map, the architecture chosen for Phases 3 and 4.
* `decisions.md`: decisions taken and why (D1 to D20).
* `verification-evidence.md`: exact test, typecheck, lint, build, rehearsal and browser results.
* `blockers.md`: what is blocked on external resources or approvals, and what was done instead.
* `phase-3-checkpoint.md`, `phase-4-checkpoint.md`: the checkpoint reports.
* `workflows/wave1-build.js`: the drafted Wave 1 build workflow (Workflow-tool script).

Conventions that matter when resuming:

* Edit files with the editor tools; shell heredocs and `sed` mangle backslashes (this broke a regex in `src/server/env.ts` and one on master). Re-read every regex you write.
* Do not edit a worktree while a vitest or build run is using it. Run heavy commands through `node scripts/run-locked.mjs heavy -- <command>`.
* `python -I scripts/eol-scan.py <base> WORKTREE` finds files whose line endings flipped (the Write tool can do that); `--fix` repairs them.
* Tests run on embedded Postgres (PGlite); `tests/support/messaging.ts` (`messagingOrg`), `tests/support/crm.ts` (`crmOrg`) and `tests/support/social.ts` are the fixtures. A phone number used in tests must be unique across the process. The database allows one agency workspace.
* Browser QA: `scripts/run-inbox-qa-seed.mjs`, then a phase seed, then `scripts/inbox-qa.mjs` (port 3270) in the background; sign in through a local cookie bridge so no password passes through the chat; temporary helpers go in `public/dev/` and are deleted afterwards. A throttled pane never completes React's streamed reveal: run `window.$RV(window.$RB)` first. Trust DOM measurements over screenshots.
* Money: use `src/lib/money` (integer minor units, exponent-aware). Never floats.
* Production commands (only on approval): back up with `pg_dump` (`C:\Program Files\PostgreSQL\18\bin`), `migrate.ts --dry-run`, then `--only <version>` one at a time with `ALLOW_REMOTE_DB_IN_DEV=true DATABASE_SSL_CA_FILE=<main>/certs/prod-ca-2021.crt node --env-file=<main>/.env --conditions=react-server --import tsx scripts/migrate.ts`. Section F of `scripts/rehearse-combined-migrations.mjs` prints the checks to make after each step.
