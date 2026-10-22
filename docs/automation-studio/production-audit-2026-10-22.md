# Automation Studio: production audit, completion pass and release verdict (2026-10-22)

What this is: an evidence-based audit of the Automation Studio that was pushed to `master` and deployed on 2026-10-21, the defects it found and fixed, what is still
missing, and a go / no-go. Everything below says where its evidence comes from. Where production could not be checked without a signed-in session, a payment or an
action that needs approval, it says so instead of guessing. Nothing was pushed, deployed, migrated, switched on or sent to a customer in this pass.

## 1. What is actually deployed

| Question | Answer | Evidence |
| --- | --- | --- |
| Which commit is live? | `22c68c2a7973e1d72051f1b9dec11b072f5437d4` ("Fit the Studio demo to phones and tablets; stop If / else labels overlapping"), the head of `origin/master`. Deployment `dpl_6YkZRBBrNjytV25CPZnpkYhrUUr3`, target production, state READY, created 2026-10-21 20:49 SGT, aliased to `iacquire.online` and `www.iacquire.online`. | Vercel API deployment record (git metadata), `git fetch` |
| Does it match the source? | Yes: the deployed SHA is the head of `master` and equals the source audited here. The audit's own changes are **not** deployed. | same |
| Are migrations `0069`–`0072` applied? | **Yes**, all four, in `schema_migrations` of the hosted database (also `0077`–`0080`, which are the AI workforce's). Nothing newer exists for Studio. | read-only catalogue query, 2026-10-22 |
| Row level security? | Every table in `public` has RLS on; none without. The Studio tables have one `select` policy for the app role; writes go through the server. The app role **cannot** read `automation_connections.secret_ciphertext` (`has_column_privilege` is false), and `anon` and `authenticated` have no access to the table. | same |
| Is there Studio data in production? | **None.** 0 Studio workflows, 0 runs, 0 conversations, 0 connections, 0 usage rows, 0 maintenance plans, 3 organizations (1 active). So nothing has ever been exercised on the hosted system by a client. | same (counts only, no customer data read) |
| Is the scheduler running? | **No.** No `CRON_SECRET` and no `SCHEDULER_ENABLED` in the production environment, no `vercel.json`, `GET /api/internal/tick` answers 503, `GET /api/health` answers `{"status":"ok","database":"ok","scheduler":"never_ran"}`, and `worker_job_runs` has no scheduler row. | variable names via `vercel env ls`, public probes, read-only query |
| Is the AI model configured? | **Yes.** The platform AI connection (`integration_connections`, no org, provider `llm`) is `connected`, preset `deepseek`, model `deepseek-flash`, with a stored credential, last updated 2026-10-18. `HELP_LLM_PROVIDER=none`, so the environment fallback is off and the builder uses this connection. The same model and host were evaluated in section 4. | read-only query; non-secret environment values read from a temporary pull that was deleted |
| What Vercel plan is the project on? | **Hobby** (read from the team record, 2026-10-22). Hobby cron jobs run at most once a day, so a Vercel cron cannot drive a scheduler that must tick every minute or two: with it, a two-day wait could finish up to a day late and a reminder "in an hour" could be a day late. A per-minute cadence needs Pro, or the Supabase `pg_cron` + `pg_net` route, or an external cron (one more thing to keep secret). | Vercel API team record |
| Are dev preview pages closed in production? | Yes. `/dev/automation-studio-preview`, `/dev/setup-preview`, `/dev/operations-preview`, `/dev/integrations-preview`, `/dev/gallery-preview`, `/dev/studio-lab`, `/dev/mailbox` all answer 404; `/automation-studio` redirects to sign-in. | public GET probes |
| Production differences from local | Local QA runs a production **bundle** with the embedded database and local sign-in (the app refuses `NODE_ENV=production` without Supabase, a hosted Postgres and an encryption key), so the application's production-only guards were exercised by unit tests with `NODE_ENV` forced, not by that run. Production has Resend email on, GHL writes off, `EMAIL_PROVIDER=resend`, Supabase auth. | `scripts/automation-qa-prod.mjs` header; `vercel env pull` (names and non-secret values only) |

What could **not** be verified in production, and why: signing in as a client (no credentials may be entered, and no client has the plan), the plan lifecycle with a real payment,
the builder answering a real client from the hosted system (needs a signed-in session on an entitled workspace), and a scheduler tick (it would start every enabled job).

## 2. Feature inventory

Everything below exists in `master` (22c68c2) and is covered by the tests named in the other documents in this folder. "Verified" in the matrix in section 3 means it was *exercised* in this pass.

* **Studio Home**: large "What would you like to automate?" prompt, 17 clickable starter ideas with readiness text, **20 executable templates with a search box** (added in this pass) and category filters, "Your automations", links to Usage and Connections, a skip link to the templates (added), onboarding and empty states.
* **Auto Mode**: persistent conversation (stored per workflow), live editable React Flow canvas that replays only operations the server accepted, nodes appearing one by one, selected-node editing, resizable panes (desktop; keyboard too), Chat / Canvas switch on phones and tablets, honest errors, minimal clarification, state kept across reloads.
* **Manual Mode**: drag from the palette, drag-to-connect with validation, delete / duplicate / insert-after, settings panels for every step, conditions and branches (If / else with Yes and No), undo / redo over the operation history, version history with restore-to-draft, dry-run test with a real contact, publish, approval, switch on / off, fullscreen.
* **One engine**: Auto and Manual edit the same canonical operations; the CRM workflow engine (events, inbound signed webhook, daily and weekly schedules, waits and date waits, retries with backoff, per-step transactions, owner approval of the exact version, pauses, per-workspace fair claiming, loop limits) runs both.
* **Steps**: wait, If / else, add / remove tag, assign, task, update field, deal create / move, send message (approved templates only), review request, team notification, note, n8n, signed webhook, **HTTP request**, **Slack message**, AI employee request, end.
* **Connections** (tenant-scoped, encrypted, never shown again): HTTP API and Slack incoming webhook, confirmed test, rotate, revoke, call log, status (`unverified`, `active`, `needs attention`, `revoked`), and now an honest "Not available yet" section for Gmail, Google Sheets, Outlook and Sign in with Slack.
* **Plan**: server-side entitlement at every entry point (create, save, restore, copy, publish, approve, switch on, test, start, run, inbound webhook, builder, connections, Blueprint apply), upgrade page and locked navigation, usage page with limits, grace period, notices, pause on lapse, manual per-workflow resume, agency controls with audit.
* **AI Builder**: separate from AQi; real model; strict validation in a locked transaction; correction loop; claims guard; prompt-injection fencing; usage metering; rate limit; monthly allowance.

## 3. Evidence matrix

### Implemented and verified (exercised in this pass)

| Area | What was verified | How |
| --- | --- | --- |
| Deployed = source; migrations applied; RLS; secret column unreadable; dev pages closed | section 1 | Vercel API, read-only SQL, public probes |
| All 20 templates run end to end | each started through the scheduler's own runner, simulated clock (a 30-day wait included), every step logged and readable, outside calls only where the card says | new `tests/automation-studio-templates-run.test.ts` (20 tests) |
| Multi-tenant scheduling and idempotency through the real tick | two workspaces, real route, real job list (every job ran, none failed), repeated and overlapping ticks harmless, one Slack post per contact after its wait, lapse holds and never fails runs, core workflow untouched, resume after a verified payment | new `tests/automation-studio-scheduler-rehearsal.test.ts`; `tests/crm-fair-claiming.test.ts` |
| Entitlement enforcement | 17 server entry points (grep audit) plus the engine re-check; inbound webhook answers 409 for a lapsed plan | code audit; `tests/automation-studio-engine.test.ts` |
| SSRF and outbound safety | connection-only hosts, public-address check on every resolved address, one DNS lookup pinned to the socket (no rebinding), `https` on 443 only, no redirects followed, header and path rules, redaction, size and time limits | code audit of `lib/automation-studio/outbound.ts`, `server/security/pinned-https.ts`, `server/automation-studio/outbound.ts`; `tests/outbound-http.test.ts`, `tests/crm-automation-engine-fixes.test.ts` finding 12 |
| AI Builder with the real model, held-out | A: 90.2% first run; B: 97.7% first run after the fixes; injection and boundary scenarios 12 of 12; regression 100% on the tuned set | [ai-evaluation.md](ai-evaluation.md) |
| Real model through the real product, production bundle | 17 of 17 browser checks (nodes appear one by one, reload keeps the work, selected-step edit, an unsupported request refused in words, undo, the key never reaches the browser or the server log) | `scripts/automation-real-model-qa.mjs --production` |
| Browser QA, production bundle | 62 of 62 (Phase C suite), 68 of 68 (upgrade page), 87 of 87 (this pass: search, honest connections, no sideways scroll and no axe violation at desktop, tablet and phone, light and dark, keyboard resize, Chat / Canvas switch, reload persistence, no-plan workspace gets the upgrade page and the API refuses) | `scripts/automation-browser-qa-c.mjs`, `automation-upgrade-qa.mjs`, new `automation-browser-qa-d.mjs` |
| Plan lifecycle | grace, expiry, pause, notices, reactivation, resume; now also activation needing a verified payment | `tests/automation-studio-engine.test.ts`, `tests/maintenance.test.ts`, `tests/maintenance-admin-activation.test.tsx` |

### Implemented but unverified (needs something this pass could not do)

* A **real Slack delivery** and a **real call to an outside API** (only a local TLS server and replaced transports were exercised): needs a Slack webhook the founder controls.
* The **scheduler on the hosted database** and the Vercel cron cadence.
* A **signed-in session on production** on an entitled workspace (builder from the hosted system, plan lifecycle with a real payment). No workspace has the plan.
* **AI employee steps live**: in every run they end `skipped (blocked)` because live AI employee runs are off until each role's tool inventory is verified (Hermes). The role scoping (`requestAgentTask` takes the workspace and role) is by code reading only; the checklist's per-role permission tests are not written.
* The **agency's payment form** in a browser (covered by a component test and the service tests; the seeded QA database has no pending request).

### Partially implemented

* Schedules are **daily and weekly only** (no interval or cron-style trigger).
* **Data mapping** is placeholders filled from the contact, the business, the sender, the appointment and the review link. **A deal's value, name or stage cannot be put into a step** (`{{opportunity.value}}` is refused: found by the held-out evaluation; the placeholder catalogue is shared with customer message templates, so adding deal fields is a cross-cutting change). A step's *output* (an HTTP response, an AI answer) cannot feed a later step, and there are no variables or for-each loops.
* Slack is **incoming webhook only** (no channel picker).
* Run inspection is on the CRM run screens, not an overlay on the canvas; no minimap.
* "Test" is a dry run (a person can't yet "send a real test to myself").
* Billing is **manual**: a person records payments; since this pass activation cannot happen without that confirmation.

### Missing

Gmail, Google Sheets, Outlook / Microsoft 365 mail, Slack OAuth, recurring payment collection for the plan.

### Broken or regressed: found in this pass, all fixed (each with a test)

| # | Finding | Severity | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | A plan could be **activated by one click with no payment verification** (the activation recorded no payer, period or time) | P1 (billing integrity) | Activation now needs the person's confirmation and the period paid through, recorded with who and when and audited; the screen won't send without it | `tests/maintenance.test.ts` (2), `tests/maintenance-admin-activation.test.tsx` (2) |
| 2 | The AI builder could show a reply claiming a change that was **never made** ("Put it back…", "The workflow now starts when…"): the guard knew only a few openings | P1 (honesty) | Reports of a change in any usual form are recognised and corrected or replaced by the truth | `tests/automation-studio-builder-guards.test.ts` (16 phrasings) |
| 3 | The builder was told trigger filter **names but not their values**: "when someone withdraws marketing consent" built a trigger for any consent change or was refused, 9 of 10 runs | P1 (wrong automations) | Values generated from the validating schema; a refusal carries the schema's words | same file; held-out run |
| 4 | "Make it better." made **unrequested changes including a customer email** | P2 | Prompt rule: change nothing, ask, suggest | same; held-out run |
| 5 | After a person **turned a workflow back on**, its held runs waited up to an hour | P2 (recovery) | Held runs are looked at again immediately | `tests/automation-studio-scheduler-rehearsal.test.ts` (failed before the fix, passes after) |
| 6 | The editor's **Test button had no accessible name on a phone** (icon only) | P2 (a11y, WCAG 4.1.2) | `aria-label="Test"` | `automation-browser-qa-d.mjs` axe at phone width (failed before, passes after) |
| 7 | Ready-made automations could not be **searched** | P3 (brief) | Search box, empty state, live count | `tests/automation-studio-screens.test.tsx`, `tests/automation-studio-templates.test.ts`, browser QA |
| 8 | Nothing told a client **why Gmail / Sheets / Outlook aren't there** | P3 | "Not available yet" section: named, explained, no fake button | screens test, browser QA |
| 9 | `open-decisions.md` said migrations were **not applied** (they are) and the scheduler had no rehearsal | docs | corrected; Studio section added to the scheduler runbook | n/a |
| 10 | A time in another time zone ("9am London time") was built without telling the person it runs on the workspace's clock | P3 | Prompt rule | prompt test; held-out checks |

No P0 (data exposure, cross-tenant access, an unauthenticated route, an SSRF path or an entitlement bypass) was found. The nearest thing to one was the missing payment gate in #1.

### Blocked by external credentials or approval

* Scheduler activation (the founder's approval, the Vercel plan tier for a one-minute cron, a `CRON_SECRET`).
* Google (Gmail, Sheets) and Microsoft OAuth apps and Google's verification; a Slack app.
* A Slack test webhook for one real delivery.
* A payment provider integration (PayMongo recurring) for automatic activation and renewal.
* Live AI employee runs (Hermes tool-inventory verification, handled in the workforce workstream).

## 4. AI Builder evaluation

See [ai-evaluation.md](ai-evaluation.md), section "Held-out evaluation". Headline: held-out set A, first run on the unchanged builder, **90.2%** of scenarios (37 / 41); after fixing what it showed, a fresh set B, first run, **97.7%** (42 / 43); the regression run of the tuned set **100%** (70 / 70); 0 errors, 1 of 220 applied changes left a draft that still needed its first step (a trigger set while the message to send was still to be chosen); none left a broken one. Median whole-turn latency 2.6 to 2.8 s, p95 6 to 9 s; about 9.7 thousand input and 0.5 thousand output tokens per message; at published prices a message costs at most about $0.0036 and the 300-message monthly allowance about $1.10. The scripted stand-in model was not used as evidence of anything here.

## 5. Integration readiness

| Integration | State | What exists | What is needed |
| --- | --- | --- | --- |
| Native CRM | **Ready** | every CRM trigger and action, approved-template messages, tasks, notes, deals | nothing |
| Secure HTTP | **Ready, one live check outstanding** | tenant connections, pinned DNS, no redirects, methods, limits, idempotency key, redacted log, confirmed test | one real call to a service the founder controls |
| Inbound webhooks | **Ready** | signed private address per workflow, rate limited, plan-checked | nothing |
| Outbound signed webhooks, n8n, Zapier, Make | **Ready** (Core, not premium) | existing | nothing |
| Slack | **Ready for incoming webhooks; live check outstanding** | encrypted webhook, confirmed test, `ok` check, 403 / 404 / 410 → "needs attention" | a Slack test webhook; Slack OAuth needs a founder-owned Slack app |
| Gmail | **Not built** | nothing | Google Cloud OAuth app, Gmail scopes, Google's restricted-scope review |
| Google Sheets | **Not built** | nothing | Google OAuth app and sensitive-scope verification |
| Outlook / Microsoft 365 | **Not built** (calendar sync has OAuth plumbing) | nothing for mail | Microsoft app registration and scopes |
| Calendars | Existing (booking sync), not a Studio step | | |

## 6. Scheduler and execution evidence

Section "Automation Studio and the scheduler" of [../production-scheduler.md](../production-scheduler.md): what depends on the tick, the rehearsal, and the exact activation steps.

## 7. Subscription and usage readiness

* Server-side entitlement at every entry point (section 2); the engine re-checks while a run advances; the upgrade page and locked navigation are correct (68 / 68 browser checks); `Core` features never depend on the plan (verified by the lapse tests: the core workflow in the lapsed workspace kept running; AI employee schedules, n8n and webhooks have no plan reference).
* Pricing shown: $299 per month plus the setup fee, from the existing maintenance catalogue.
* Lapse: grace period (7 days by default, 1 to 30 per case), reminder 48 hours before it ends, expiry, workflows paused (never deleted or failed), in-progress runs held, per-workflow manual resume; **without the scheduler, expiry notices and pausing do not happen on their own** (entitlement is still time-aware at every check).
* Activation now needs a recorded payment verification. **Automatic** activation and renewal need a payment integration: missing.
* Usage metering (runs, steps, failures, retries, tests, builder messages and tokens, AI employee requests, integration calls) with provisional limits; the founder has decided they stay configurable.
* Billing audit trail: activation, payment failure, verified payment, expiry and lapse pauses are all audit-logged.

## 8. Production blockers and what the founder must do

1. **Decide the scheduler**: the project is on Vercel **Hobby**, whose cron runs at most daily, so choose Vercel Pro, or Supabase `pg_cron` + `pg_net`, or an external cron that can POST every one to two minutes, then follow the steps in `docs/production-scheduler.md`. Until then nothing in Automation Studio can wait, delay, retry or run on a schedule in production, and plan expiry notices do not go out.
2. **One live Slack test**: create a Slack incoming webhook for a channel you control and send the connection's confirmed test from a pilot workspace.
3. **A pilot workspace on the plan**: activate one real or synthetic workspace through the new payment-verified activation, then run a template end to end with the scheduler on (step 6 of the runbook).
4. **Decide the payment path** for automatic activation and renewal (PayMongo recurring, or keep it manual with a monthly checklist).
5. **Register the OAuth apps** if Gmail, Sheets or Outlook are wanted (Google Cloud project and review, Microsoft app registration, Slack app). Nothing in the code is waiting except those credentials.
6. **Decide the provisional limits** (`open-decisions.md` items 2 and 14) after the first month's real usage.
7. Hermes tool-inventory verification (workforce workstream) before AI employee steps are described to clients as live.

## 9. Verdict

**Production verdict: NO-GO today for general availability or for relying on Automation Studio with paying clients. GO for a supervised pilot (one workspace) once items 1 to 3 of section 8 are done.**

Why not today, in one line each:

* Nothing can run on its own in production: the scheduler is off, so no wait, delay, schedule, retry or Slack / HTTP call would ever happen, and plan expiry would never be noticed. This is deliberate and decided, and the activation steps and a passing rehearsal are written; it is simply not done.
* No external integration has been proven live (no real Slack delivery, no real API call), and Gmail, Google Sheets and Outlook do not exist.
* No workspace has the plan and nothing has been exercised signed-in on the hosted system, so the first real use will also be the first real test of the hosted path (model credential read from the vault, entitlement against real plan rows, approvals).
* The test suite on `master` is red for reasons outside Automation Studio (below).

Why it is close: the code, the hosted schema and security, the model, the plan gate, the 20 templates, the editor and the builder all held up under every check that could be run without touching production, and the defects found were small and are fixed.

For a **controlled pilot** (a synthetic workspace, then one friendly client): the scheduler on with the steps in `docs/production-scheduler.md`, one real Slack test, the payment-verified activation, and a signed-in smoke test of build, test, publish, approve, run.

## 10. Release gates, progress estimates and verdict detail

### Gates (final code, branch `feat/automation-studio-final` on `22c68c2`, uncommitted)

| Gate | Result |
| --- | --- |
| `npm run typecheck` (project and scripts) | exit 0 |
| `npx eslint .` (whole repository) | exit 0, 0 problems |
| `npm run build:clean` (Turbopack production build) | exit 0 (run several times as the code changed; the last on the final code) |
| Full `npx vitest run --maxWorkers=6` | **4,554 passed, 7 failed, 1 skipped (285 files)**. The 7 failures are in 6 files, none of them Automation Studio, and **the same 7 fail identically on a pristine checkout of `22c68c2`**, so none is a regression |
| New or extended tests | 63 new tests: held-out harness 17, every template run 20, scheduler rehearsal 1, activation 2 + 1, builder guards 19, screens 2, library search 1. All pass |
| Browser, production bundle, isolated database, Chromium | Phase C suite 62 / 62; upgrade page 68 / 68; release pass 87 / 87 (desktop, tablet, phone; light and dark; axe WCAG 2 A and AA; keyboard; reload persistence; no-plan workspace); **real model** 17 / 17 |
| Tenant isolation, entitlement, security | `tests/automation-studio-hardening.test.ts`, `-engine`, `-connections`, `outbound-http`, `crm-automation-engine-fixes` (finding 12: DNS pinned) all pass; no P0 found |
| Scheduler and execution | rehearsal through the real route and job list passes; fair claiming and overlap tests pass; 20 / 20 templates run |
| Subscription lifecycle | `automation-studio-engine` (lifecycle), `maintenance`, activation UI tests pass |
| Migration and rollback | `automation-studio-migrations` and `automation-studio-hardening` (0069 to 0072 roll back and apply again, refuse while data exists) pass. **The chain-wide rollback test fails on master** (below) |

The 7 failures that are **already on master** and what each means for release:

| Test | Cause | Release impact |
| --- | --- | --- |
| `crm-migrations` × 2 ("rolls back cleanly, newest first", "refuses to roll back while Native CRM data exists") | The rollback scripts for the AI workforce migrations `0077` to `0080` (applied in production) are not in `master`: dropping `app.permitted_orgs` fails because their policies still depend on it. They exist as untracked files in another checkout | **Real risk for the workforce migrations**: no committed way back. Not Studio's |
| `rls-initplan-guard` | `ai_work_jobs` and `ai_work_events` select policies call `app.has_permission` with a row's columns (a per-row cost); the fix is migration `0081` (untracked, not applied) | Performance risk at scale on the workforce tables. Not Studio's |
| `scheduler-intervals`, `aqi-ops-registration` | The expected job list predates the `aiWork*` and `aiProactive*` jobs | Stale expectations; the jobs are inert until their own switches are set |
| `aqi-answer-pipeline` | The list of pages AQi may link to now includes `/website` | Stale expectation |
| `appointments` "queues a plain reminder…" | Fails on every checkout since at least 2026-10-21 | Cause not investigated here; reminders are not Studio |

**CI is red on `master` until those are repaired.** The workforce workstream's uncommitted files in the main checkout appear to contain several of the fixes (rollbacks `0077` to `0081`, migration `0081`, updated test expectations); that was observed in `git status` and not examined.

### Progress estimates (rounded to the nearest five; the criteria and weights are a judgement, shown so they can be argued with)

**Feature completeness: about 80%** (reasonable range 75 to 85)

| Criterion | Weight | Done | Why |
| --- | --- | --- | --- |
| Describe it and watch it being built live (Auto Mode, animated canvas, real model) | 15 | 95% | real model, production bundle, 17 / 17; held-out 90% to 98% |
| Revise by chat, selected-node edits, undo | 10 | 90% | revision scenarios; Manual undo reverts the builder's edit |
| Manual editor (drag, connect, configure, branch, versions) | 10 | 90% | 62 / 62 browser checks; keyboard reaches nodes and resizes panes, but drawing a link by keyboard alone is not shown |
| Test safely | 5 | 60% | dry run only; no "send a real test to myself" |
| Publish, approve and run real workflows (engine) | 15 | 95% | rehearsal, 20 / 20 templates, fair claiming; unverified on hosted |
| Trigger variety | 8 | 70% | events, inbound webhook, daily and weekly schedules; no interval or cron |
| Data mapping, variables, loops | 5 | 25% | contact and business placeholders only; no deal fields, no step output, no loops |
| Native CRM, HTTP, webhooks, Slack webhook | 12 | 85% | all built; Slack OAuth missing |
| Gmail, Google Sheets, Outlook | 6 | 0% | not built, blocked on founder-owned apps |
| 20 executable templates | 5 | 100% | all run end to end |
| Plan, upgrade experience, usage, lifecycle | 9 | 85% | complete but manual billing |

**Production readiness: about 55%** (reasonable range 50 to 60)

| Criterion | Weight | Done | Why |
| --- | --- | --- | --- |
| Deployed code is the reviewed code; build, types, lint green | 10 | 95% | verified; test suite red only for unrelated reasons |
| Hosted schema, RLS, tenant isolation, secrets | 15 | 95% | read-only audit |
| The runtime is live and proven in production (scheduler) | 25 | 10% | off; rehearsed locally only |
| Security, entitlement and SSRF assurance | 15 | 90% | audited and tested; no P0; no external penetration test |
| AI builder in production | 10 | 70% | configured and connected, strong evaluation; no signed-in hosted call |
| Billing and activation path | 10 | 55% | verified manually, enforced; no payment integration |
| External integrations proven live | 10 | 15% | none proven live |
| Operations: health, heartbeat, runbooks, rollback | 5 | 75% | all exist; scheduler heartbeat not yet populated |

### What this pass did not do

It did not sign in to production, apply or roll back anything on the hosted database, start the scheduler, call Slack or any outside API, read or change a customer's data, push, deploy, or commit.
