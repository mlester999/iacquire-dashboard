# Performance, cost and reliability audit, 2026-10-26

Branch `integrate/phases-3-7-workforce`, worktree `.data/wt-release-candidate`, Windows 11, Node 24.12, 8 cores / 16 threads, about 6 GB of free memory when idle. **Every millisecond below was measured on the embedded Postgres the tests use (PGlite, in memory, one process).** That is a fast database with no network in front of it, so what carries over to a hosted database is the **number of statements** and **which work grows with the number of workspaces**, not the times. No hosted measurement exists: there is no staging project, no error tracking and no paging yet (`docs/staging-environment.md`).

The measurements are produced by `tests/perf/release-candidate.perf.test.ts` (excluded from the normal suite; run `CRM_PERF=1 npx vitest run tests/perf/release-candidate.perf.test.ts`; it writes `tmp/perf-release-candidate.json`) and by `scripts/measure-build.mjs`. The older scale measurements for the CRM, inbox and Phase 2 stand as they were (`docs/crm-performance.md`, `tests/perf/`).

## 1. The paths this release candidate added

| Path | Median | 95th percentile | Statements | Runs |
| --- | ---: | ---: | ---: | ---: |
| Credit note: write a draft | 7.8 ms | 12.9 ms | 9 | 12 |
| Credit note: send for approval | 9.6 ms | 12.5 ms | 11 | 12 |
| Credit note: approve and issue (number, copy of the parties, hash, invoice recomputed, reminders re-planned) | 17.1 ms | 23.1 ms | 23 | 12 |
| Purchase: the provider's signed "paid" notice to a provisioned workspace with six employees | 59.2 ms | 78.1 ms | 64 (every run) | 6 |

The statement count of the notice is the same in all six runs, so it does not depend on how many workspaces exist. Credit-note issue takes the invoice lock first and then the note, in that order in every writer (a deadlock shape that existed in the note writers was fixed on 2026-10-26; `docs/security-review-2026-10-26.md`).

## 2. The scheduler, which is where scale shows first

The scheduler registers **73 jobs** (`src/server/ops/tick.ts`). It has never run in production and is off by default. Each job was run once at 10, 40 and 160 client workspaces, after a settling pass, with every statement counted:

| Client workspaces | One pass of all 73 jobs | Statements, all jobs |
| ---: | ---: | ---: |
| 10 | 381 ms | 251 |
| 40 | 750 ms | 911 |
| 160 | 2,127 ms | 3,551 |

**71 of the 73 jobs send the same statements however many workspaces exist.** Two grow with the number of workspaces, linearly once warm:

| Job (interval) | 10 workspaces | 40 | 160 | Per workspace | Time at 160 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `fairUseChecks` (hourly) | 77 | 647 | 2,927 | about 18 statements | 1.38 s |
| `inactivityReview` (every 6 hours) | 13 | 103 | 463 | about 3 statements | 0.55 s |

`fairUseChecks` (`src/server/fairuse/service.ts`) measures **every active client, one after another, with no batch limit**, each in its own transaction. The tick has a 120-second limit (`maxDuration` on `/api/internal/tick`).

**What this means, as arithmetic and not as a measurement.** If a hosted statement costs 3 ms of round trip, about 18 statements per workspace is about 55 ms per workspace, so roughly 2,000 active client workspaces would use the whole tick on this one job; at 5 ms, roughly 1,300. At the scale the business has today (a handful of clients) it is irrelevant. **It is a known scale boundary, not a defect to fix before launch**: when the client count approaches several hundred, `fairUseChecks` should process the workspaces measured longest ago first and stop at a time budget, so the next tick resumes where it stopped. Neither job has been given that yet, and the scheduler budget for the three jobs that message customers is the founder's decision already listed in `docs/production-scheduler.md`.

## 3. Builds, the full suite, and the migration rehearsal

| Gate | Measured |
| --- | --- |
| Production build, Turbopack (the deployment bundler) | 196 s, 215 s, 116 s, 147 s and 119 s (the last on the merged tree), peak 4.5 to 5.9 GB of process memory, passed every time |
| Production build, Webpack | 320 to 467 s, peak 4.6 to 8.1 GB (the heap grows into the cap it is given). **At the machine's default cap it ran out of memory once (248 s in, heap at 4,050 MB) and passed once**; it is within a few percent of the default limit, so `scripts/build-clean.mjs` now gives it an 8 GB cap. Detail and every run: `docs/production-build-and-bundler.md` |
| Full test suite (`vitest run`, 120 s per-test ceiling) | 693 files, 10,962 tests, 895 s in the final chain on the merged tree (1,105 s and 887 s in the two before it, 1,352 s while another job shared the host; this host's wall time for the same tests varies by a third); cases that wait on a clock or a worker start can fail under load and pass alone, listed in `docs/roadmap/phases-3-to-7/handoff.md` |
| The eight journey files | 16 files, 48 tests, 36 s |
| Combined migration rehearsal (107 files, up, down, up, exact-schema comparison, section F) | 244 to 347 s over the chains; sections A to G (G rehearses the real 105-row production ledger with 0110 to 0112 pending); the schema after the last apply equals the fresh chain (23,336 facts on the 108-file tree) |
| Client JavaScript | 672 files, 10.98 MB raw, largest chunk 237 KB (Webpack output); a baseline, not a performance claim |

## 4. Lists do not ask one more question per row

`tests/list-statement-counts.test.ts` fixes the statement count of the invoice list, the receivables summary and the proposal list: the same number for 3 rows and for 24, and no statement may ask for more than 500 rows. The CRM, inbox and Phase 2 lists have their own scale tests (`tests/perf/`). The new credit-note list is one query for the notes and one for the names, however many notes an invoice has.

## 5. Cost: what spends money, and what the server refuses to do

The full inventory is `docs/usage-and-cost-safety.md`. The enforcement that matters for this release candidate, all server-side and none of it a screen:

* **Model calls are metered once, per workspace, in the call itself** (`src/server/llm/meter.ts`), and `tests/llm-callers-metered.test.ts` scans the source: a caller that neither meters nor is listed with a reason fails the suite.
* **A workspace gate in front of every model call** (`src/server/llm/gate.ts`): the workspace must be active, no pause may stop that kind of work, and work charged to credits needs credit. A pause by the agency or the workspace stops AI work jobs where they are requested, scheduled, triggered and claimed (`tests/ai-job-gate.test.ts`).
* **Caps that already exist:** the website chat's daily AI-reply allowance per workspace, the prospect demo's per-address and per-mailbox limits and its 10-message conversation, customer replies counted since migration 0104 with an optional monthly cap, per-user AI message rates, upload rates, Automation Studio's monthly plan limits.
* **Provider writes are off by default:** every write switch in `.env.example` is `false`, and `CUSTOMER_PAYMENTS_WRITES_ENABLED`, the e-signature switch and the social and messaging provider switches each have to be turned on by name.
* **The AI employees' tool allowlist is enforced by default** (`WORKFORCE_ROLE_TOOL_ENFORCEMENT`), so a Sales Assistant cannot be talked into a web search that costs money or leaks what it read.
* **Not capped, because the founder has not chosen a number** (listed so nobody assumes otherwise): the monthly customer-reply cap defaults to none; fair use is measured and announced, never stopped; no price is published for the plan, so **no operating-cost estimate is made here**.

## 6. Reliability: what repeats, races and outages do

* **Payments and subscriptions:** every provider event goes through one receipt ledger with a unique `(provider, event id)` key committed before it is applied and applied under a row lock; a charge for the same agreement within ten days of an applied one is recorded and held; a refund or dispute holds for a person and never extends or revokes anything. The eight journey boundary tests and the 47-case agreement suite repeat each notice and check one effect.
* **The scheduler** takes a database lease (`claimSchedulerTick`) so two overlapping ticks do not both run; every job is idempotent and a failure in one does not stop the others.
* **Provider outages:** an unreachable PayPal or PayMongo is a failure to try again with nothing charged and nothing recorded as paid (`tests/maintenance-agreement.test.ts`, `tests/purchase-paypal-checkout.test.ts`, the checkout suites).
* **Browser:** the PayPal checkout and subscription were driven in a real browser against a stand-in PayPal with replays, a forged delivery, a buyer who walks away, a failed charge, a suspension, a refund hold and a cancellation (`scripts/wave3-paypal-qa.mjs`).

## 7. Not measured, and why it matters

* **No hosted latency, no connection-pool behaviour, no cold start, no load test.** The first staging environment is the first place any of that can be measured.
* **No error tracking, alerting or paging:** a failure in production would be found by reading `/admin/system-health` and the scheduler heartbeat, by a person.
* **The Hermes gateway, the model and every payment, messaging, signing and social provider** have never been called, so their latency and failure rates are unknown.
* **Disk:** the development host ran out of disk during this audit (a Webpack build failed writing `.tsbuildinfo` with `ENOSPC`), because old build outputs from earlier QA runs occupy tens of gigabytes. That is a property of this machine, not of the product, and is recorded in the handoff because it will fail a gate again.
