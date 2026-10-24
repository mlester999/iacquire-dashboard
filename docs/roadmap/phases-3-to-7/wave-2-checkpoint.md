# Wave 2 checkpoint (2026-10-24, resumed session)

Starting point: branch `feat/phases-3-7` in `.data/wt-phases-3-7`, checkpoint `e3275d5` (the second usage-limit cut). The branch is 31 commits ahead of `origin/master` `36bf78c`. The work described here is committed as **`b05c69e`** (251 files, 21,348 insertions, 260 deletions); the ledger update follows it. Nothing is pushed, deployed or applied to a hosted database.

## What Wave 2 is

Wave 2 is the Phase 5/6 foundation: staff Messages and staff workload (W2-A), Requests completion (W2-B), and payment clearance, onboarding and the demo funnel (W2-C). The full plan and the migration allocation are in `phase-5-7-plan.md`.

| Stage | What it is | Migration | State in this tree |
| --- | --- | --- | --- |
| A | Staff Messages: direct, group and channel conversations, threads, search, attachments, reactions, read state, notices, permissions and screens | 0096 | Implemented; targeted tests pass; not browser-QA'd |
| B | Staff workload: engine, labels, permissions, history/alerts job, team overview, board with assignment suggestions, calendar, project health, person page and manage forms | 0097 | Implemented; targeted tests pass; **workload screens browser-QA'd at 1280/375, light/dark**; other Wave 2 screens not |
| C | Requests completion: change orders and decisions, prerequisites, scope amendments, support mentions, surveys, AI triage | 0098 | Implemented; targeted tests pass |
| D | Payment clearance, manual payments, lifecycle and entitlement boundaries | 0099 | Implemented; targeted tests pass; no real provider |
| E | Client onboarding completion: snapshot answers, employee status, media/storage step, setup payment line | 0102 | Implemented; targeted tests pass |
| F | Demo funnel: verified prospect access, guided four-step room, ten-message limit, 24-hour window, admin, retention | 0100 | Implemented; targeted tests pass |
| G | Consent-aware proposal/invoice sending and invoice from an accepted proposal | 0091 edit, 0093 edit, delivery files | Implemented; targeted tests pass; no real email provider |
| H | Purchase intents | 0101 (free) | **Not Started** — next dependent stage |

## Evidence collected in this session

* Targeted Wave 2 files: 24 files, 512 tests before the last fixes; 8 failed in `invoices-from-proposal` / `invoices-actions-delivery` and were fixed (monthly lines were being copied as one-time, idempotency was disabled, the further-invoice permission was not enforced, and the draft closed the deal). Re-run: 27/27 pass.
* Staff Messages screens/routes/stream/snapshot: 5 files, 142 tests pass after fixing the around-message window, thread-root validation, a stream-cancel test, an upload test fixture and two over-broad textbox assertions.
* Full suite, final: **607 files, 10,255 passed, 8 skipped, 0 failed** (823 s, exit 0), after the nine fixes, the workload screens, the breadcrumb label and the proposal-link test fix. Earlier runs: 10,235 passed/9 failed, then 10,243 passed/2 failed; every failure was fixed and re-run.
* `tsconfig.clean.json` and `tsconfig.scripts.json`: both clean.
* ESLint: clean (0 errors, 0 warnings).
* `tests/client-bundle-safety.test.ts` and `tests/docs-modules.test.ts`: pass.
* Clean webpack production build: **passes**, including all six `/admin/workload*` routes. The first attempt hit the default 4 GB Node heap (`FATAL ERROR: Ineffective mark-compacts near heap limit`); the successful run used `NODE_OPTIONS=--max-old-space-size=8192`. This is an environment limit, not a TypeScript or app failure.
* Combined migration rehearsal: **all sections A–F passed** over 95 migrations `0001..0102` after the 0097 RLS edit, no duplicate numbers, rollbacks for all 24 migrations from 0077, populated upgrade, reverse path and the reserved 0084.
* Browser QA of the workload screens (real Chromium through `playwright-core`, isolated QA app, embedded database, `qa.admin@example.test`): overview, my workload, board, calendar, settings and the Messages entry at **1280 and 375 px, light and dark** — all HTTP 200, no console or page errors, no horizontal document overflow, **axe 0 WCAG A/AA violations** on overview and board at both widths. The module switch was turned on through the UI; a person page opened (open work and time off present); the manage edit page opened with capacity, skills and time-off controls; a capacity save, a time-off add and remove, and an assignment through the suggestions dialog all worked. A plain agency staff account saw the own-workload view and the team-only refusal, and a client owner was redirected away with no workload content. Screenshots and the raw report are in `.data/workload-qa/` (local, gitignored). **This is workload-only; the other Wave 2 screens are not browser-QA'd.**

## Defects found and fixed while resuming

* Invoice from proposal copied monthly lines as one-time lines, which also made the saved one-time total disagree; it now copies only `one_time` lines and leaves monthly/yearly lines in the owner's list.
* The "once per version" idempotency check was disabled by a hard-coded `&& false`; a repeat now returns the existing draft, a concurrent pair makes one, and a further invoice requires `invoices.approve`.
* The draft set `closes_deal: true`, so paying it would touch the deal; it now leaves the deal alone.
* The workload notification cleanup built its SQL with `String.replace` and a replacement string containing `$'`; that truncated the UUID pattern and made the departure cleanup fail. It now builds the predicate directly, with a regression through the real job.
* The around-message snapshot excluded the message it was meant to include by one (`beforeSeq` is exclusive).
* Asking for a reply id as a thread root returned that reply as if it were a thread; a thread root must itself be a root.
* Three workload RLS policies had no direct org reference; all six now name the agency workspace and the guard recognises the workload permission helpers.

## Remaining Wave 2 work and next actions

1. Commit the checkpoint, then browser-QA the other Wave 2 screens at 375/768/1280 px, light and dark: Messages (the QA seed had it switched off), Requests change/survey flow, onboarding, demo room/admin, invoice delivery and invoice-from-proposal. The workload screens have been driven (see above).
2. Implement purchase intents (0101) after the remaining Wave 2 acceptance gates.
3. Update `README.md`, `handoff.md`, `implementation-checklist.md`, `verification-evidence.md` and `blockers.md` with the committed evidence and exact next actions.

## Approvals still owned by the founder

Push, merge, deploy, hosted migrations 0087–0102, switching the module on for the agency workspace in production, live scheduler stages, real provider credentials, and approval of every proposed workload rule number. None has been done.
