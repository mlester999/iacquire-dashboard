# Wave 2 checkpoint (2026-10-24, resumed session)

Starting point: branch `feat/phases-3-7` in `.data/wt-phases-3-7`, checkpoint `e3275d5` (the second usage-limit cut). The branch is now 34 commits ahead of `origin/master` `36bf78c`. The first Wave 2 checkpoint is **`b05c69e`** (251 files, 21,348 insertions, 260 deletions); purchase intents and their ledger update follow as **`1c48410`** (31 files, 2,079 insertions). Nothing is pushed, deployed or applied to a hosted database.

## What Wave 2 is

Wave 2 is the Phase 5/6 foundation: staff Messages and staff workload (W2-A), Requests completion (W2-B), and payment clearance, onboarding and the demo funnel (W2-C). The full plan and the migration allocation are in `phase-5-7-plan.md`.

| Stage | What it is | Migration | State in this tree |
| --- | --- | --- | --- |
| A | Staff Messages: direct, group and channel conversations, threads, search, attachments, reactions, read state, notices, permissions and screens | 0096 | Implemented; targeted tests pass; **browser-QA'd at 1280/375 px** (module switch, direct conversation, send); axe list-semantics defect fixed |
| B | Staff workload: engine, labels, permissions, history/alerts job, team overview, board with assignment suggestions, calendar, project health, person page and manage forms | 0097 | Implemented; targeted tests pass; **workload screens browser-QA'd at 1280/375, light/dark**; other Wave 2 screens not |
| C | Requests completion: change orders and decisions, prerequisites, scope amendments, support mentions, surveys, AI triage | 0098 | Implemented; targeted tests pass; **support path browser-QA'd at 1280/375 px** (submit, internal note, public reply, assign, resolve, client view); change/survey branches test-only |
| D | Payment clearance, manual payments, lifecycle and entitlement boundaries | 0099 | Implemented; targeted tests pass; no real provider |
| E | Client onboarding completion: snapshot answers, employee status, media/storage step, setup payment line | 0102 | Implemented; targeted tests pass; **browser-QA'd through questions 8–9 at 1280/375 px** (device time zone saved, Continue advanced, axe 0); the remaining 45 questions were not driven |
| F | Demo funnel: verified prospect access, guided four-step room, ten-message limit, 24-hour window, admin, retention | 0100 | Implemented; targeted tests pass; **browser-QA'd end to end at 1280/375 px** (request → captured email → one-use verify → room → simulated reply → 10-message limit); found and fixed a room crash in `LocalTime` hydration |
| G | Consent-aware proposal/invoice sending and invoice from an accepted proposal | 0091 edit, 0093 edit, delivery files | Implemented; targeted tests pass; no real email provider |
| H | Purchase intents | 0101 | **Implemented, Verified Locally** — frozen $1,499/$299 snapshot, hashed expiring public link, buyer confirmation, Super Admin verified payment, idempotent workspace creation through `createClientTenant` + `recordManualPayment`; no online checkout or provider webhook yet |

## Evidence collected in this session

* Targeted Wave 2 files: 24 files, 512 tests before the last fixes; 8 failed in `invoices-from-proposal` / `invoices-actions-delivery` and were fixed (monthly lines were being copied as one-time, idempotency was disabled, the further-invoice permission was not enforced, and the draft closed the deal). Re-run: 27/27 pass.
* Staff Messages screens/routes/stream/snapshot: 5 files, 142 tests pass after fixing the around-message window, thread-root validation, a stream-cancel test, an upload test fixture and two over-broad textbox assertions.
* Full suite before purchase intents: **607 files, 10,255 passed, 8 skipped, 0 failed** (823 s), at `b05c69e`. At the Phase 6 integration HEAD `b524d98`, with a 120 s per-test ceiling: **612 files, 10,274 passed, 8 skipped, 0 failed** (936 s, exit 0). The 120 s ceiling only gives the slow host headroom; nothing is skipped or weakened.
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

## Purchase intents (stage H, added after the first checkpoint)

`0101_purchase_intents.sql` and its rollback add a stable, hashed public link, the frozen approved price, buyer confirmation, a Super Admin's verified manual payment evidence, and one idempotent workspace creation through the existing `createClientTenant` and `recordManualPayment` services. The public page takes no card and creates no account. The internal pages are `/admin/purchase-intents` and `/admin/purchase-intents/[id]`; the public page is `/purchase/[token]`. Tests: rules, integration on embedded Postgres (including duplicate email, expiry, rotation, wrong amount, idempotent provisioning, cancellation and role refusals), migration/RLS/rollback, and the schema-wide tenant-isolation guard — 31 tests, all passing. Real-browser QA drove the whole flow at 1280/375 px: create the invitation with the raw link shown once, open it unauthenticated, confirm, record the exact $1,499 payment, create the workspace, and read the public page as complete; 0 console errors, 0 overflow, axe 0. The combined rehearsal (96 files, all sections A–F) and the clean build (all purchase routes) pass. Detail: `docs/purchase-intents.md`.

**Not built:** an online checkout for a purchase intent, automatic provisioning from a provider webhook, and automatic recurring billing for the optional $299 plan. Those need provider credentials/approval and are explicitly not claimed.

## Remaining Wave 2 work and next actions

1. Browser-QA the remaining Wave 2 screens at 375/768/1280 px, light and dark: invoice delivery, invoice-from-proposal, the Requests change/survey branches, and the remaining onboarding questions through submit.
2. Keep the purchase-intent, Messages and Requests browser QA evidence with the commit; rerun only if those pages change.
3. Extend the Phase 6 cross-module scenario (`tests/phase6-client-operations.test.ts`) to surveys; the support path is browser-verified and the project/workload/staff-channel/change-order path is covered by that test.

## Approvals still owned by the founder

Push, merge, deploy, hosted migrations 0087–0102, switching the module on for the agency workspace in production, live scheduler stages, real provider credentials, and approval of every proposed workload rule number. None has been done.
