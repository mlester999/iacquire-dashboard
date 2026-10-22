# Phase 2 verification

Branch `feat/phase2-lead-conversion` (from `origin/master` `447249d`). Nothing is committed, pushed, deployed or applied to a hosted database. No real customer was a recipient of anything.

## 1. What kind of evidence this is

Every claim below is tagged with how it was established. A passing test is not a real-world result, and this document does not present it as one.

| Class | Meaning |
| --- | --- |
| **Simulated** | An automated test on the embedded database (PGlite) with recorder / stub providers and a controlled clock. Proves the logic, the data rules and the screens render what the data says. Does **not** prove a carrier, a telephony vendor or a language model behaves the same way. |
| **Rehearsed** | A script on the embedded database that applies the real migration files (and their rollbacks) to populated data. Proves the SQL, not the hosted database's state. |
| **Browser (local)** | A real browser against the isolated QA application (embedded database, local sign-in, every send switch off, simulated AI provider). Proves layout, interaction and accessibility of the real pages; the data is the QA seed. |
| **Real-world** | A real call, text, model answer or conversion observed with a provider record. **None exists for Phase 2.** |

## 2. Acceptance tests (the 30 in the directive) and where each is proven

| # | Requirement | Class | Proof (test file: test) |
| --- | --- | --- | --- |
| 1 | A missed call is identified | Simulated | `missed-call-detection`: opens one case for a missed inbound call, with its class; classifies voicemail, a short hang-up and a failed connection each as its own kind; `missed-calls-pure` (classification table) |
| 2 | An answered call never triggers recovery | Simulated | `missed-call-detection`: nothing for calls that were answered, transferred or outbound; a call that turns out answered cancels its case; `missed-calls-pure` |
| 3 | A duplicate webhook creates no duplicate follow-up | Simulated | `missed-call-detection`: a redelivered end-of-call report changes nothing; `missed-call-recovery-engine`: a redelivered call report does not produce a second follow-up; two workers at once send exactly one text; `phase2-extra` |
| 4 | A delayed status event reconciles correctly | Simulated | `phase2-extra`: a late "ringing" does not undo the end, a more specific final reason reclassifies the same case; `missed-call-detection`: when one of two calls was answered after all the case stays open for the other |
| 5 | A known contact matches safely | Simulated | `missed-call-detection`: links the one contact holding the exact number and writes to their timeline and conversation |
| 6 | An unknown caller is handled safely | Simulated | `missed-call-detection`: unverified contact only when recovery is on; a withheld number is a case of its own with no way to message it; a non-E.164 number never matches; two holders match nobody |
| 7 | An ineligible or opted-out contact is suppressed | Simulated | `missed-call-recovery-engine`: no consent held (team still told), opted out even with the acknowledged basis, STOP reply is an opt-out; `missed-calls-pure` (eligibility) |
| 8 | Human takeover blocks automatic sends | Simulated | `missed-call-recovery-engine`: never texts into a conversation a person owns; a takeover after the text was queued stops it; a teammate's own text stands automation down |
| 9 | Correct Inbox / CRM activity | Simulated | `missed-call-detection` (timeline entry, conversation event); `phase2-ui` (contact page and Inbox cards, banner); Browser (local) |
| 10 | Task assignment | Simulated | `missed-call-recovery-engine`: one call-back task, one notice, owner assigned, texts nobody; `missed-call-ops`: assign refuses a stale owner version and anyone outside the workspace |
| 11 | Timezone and quiet-hours handling | Simulated | `missed-call-recovery-engine`: waits out quiet hours then sends; waits for the business to open; `phase2-extra`: a text held during the customer's quiet hours even in the business's daytime |
| 12 | Authorization | Simulated | `missed-call-ops`: refuses roles without calls, only people who can edit contacts work a case, policy only by an owner / manager from the version they saw; `lead-scoring-service`: needs a reason, a permission and a contact in the workspace; `phase2-ui` (controls hidden) |
| 13 | Provider failure is recorded | Simulated | `missed-call-recovery-engine`: the provider's write switch off blocks the text, case fails honestly, team told to call; a provider that refuses is recorded as failed, not sent |
| 14 | A booking or reply prevents a duplicate | Simulated | `missed-call-recovery-engine`: the caller's reply settles the case and nothing more is sent; a booking after the call settles it without any text; approval refused after the caller wrote back |
| 15 | An AI callback is never complete without provider evidence | Simulated | `missed-call-recovery-engine`: an AI call-back is recorded as blocked, never done (no outbound call capability exists); `phase2-ui` (checklist never offers it as working) |
| 16 | A score is explainable | Simulated | `lead-scoring-engine`: explains why in words; `phase2-ui`: what it rests on, why, what is missing, next step |
| 17 | Insufficient Data is distinct from Cold | Simulated | `lead-scoring-engine`: a sparse lead is "insufficient data" with no score, never cold; `phase2-ui` |
| 18 | Reassessment | Simulated | `lead-scoring-service`: a burst of changes collapses to one queued look; assessed once the quiet period has passed; five failed tries then stop with the reason; daily ceiling |
| 19 | A human override survives | Simulated | `lead-scoring-service`: stays in force while the engine keeps assessing underneath, never silently replaced; time-limited override steps aside by itself; `phase2-automation`: the set-priority step leaves a teammate's own priority alone |
| 20 | Business-specific criteria | Simulated | `lead-scoring-engine`: workspace thresholds, presets differ, field operators; `lead-scoring-service`: scores on a workspace-created custom field and re-queues when the rules change |
| 21 | A stale result cannot overwrite a newer one | Simulated | `lead-scoring-service`: does not let an older snapshot replace a newer one; keeps the request when something newer was asked for while the assessment ran |
| 22 | AI Employee permissions | Simulated | `phase2-automation`: limited to the roles that make sense, read-only, need the permission to see what they read; `phase2-extra`: no new tool reads or writes cases, priorities or overrides; routing assigns only a ready Appointment Setter and leaves a conversation a person owns |
| 23 | Cross-tenant access is denied | Simulated + Rehearsed | `missed-call-ops` (another workspace's case is unreachable), `lead-scoring-service` (priority only inside its workspace, workers never claim another's work), `phase2-privacy` (erasure refuses another workspace); Rehearsed: the row-level-security probe in `scripts/rehearse-phase2-migrations.mjs` |
| 24 | Premium entitlement | Simulated | `phase2-extra`: builds in the CRM screens without the plan, needs the plan in Automation Studio; `phase2-automation`: the new steps need no plan and nothing to approve |
| 25 | Core and AI schedules work without premium | Simulated | `missed-call-ops`: the recovery job is registered once in the shared registry and runs with the others; `scheduler-intervals`; `aqi-ops-registration` |
| 26 | No runaway recursion | Simulated | `phase2-automation`: a workflow reacting to a score change by asking for a re-check cannot loop; `lead-scoring-service`: asked for by events that can change a score, never by its own announcements |
| 27 | Dashboards match persisted data | Simulated | `missed-call-ops`: counts from the rows that exist, no revenue it cannot see, empty not invented; `lead-scoring-service`: counts match the contacts, AI tokens flagged as estimates; `phase2-ui` |
| 28 | Mobile, tablet, desktop | Browser (local) | See section 5 |
| 29 | Tests distinguish simulated from verified real-world | This document | Section 1 and the "not proven" list in section 6 |
| 30 | Tenant-safe scale | Simulated (indicative) | `tests/perf/phase2-scale.perf.test.ts` (opt-in); section 4 |

## 3. Automated results

Run on 2026-10-22 from the worktree, after the last code change:

| Check | Result |
| --- | --- |
| Full test suite (`npx vitest run`) | **318 files, 4,991 passed, 1 skipped, 0 failed** (597 s). The one skip was already skipped before Phase 2. |
| Phase 2 tests (new) | 181 tests in 10 files: `missed-calls-pure` 35, `lead-scoring-engine` 21, `missed-call-detection` 17, `missed-call-recovery-engine` 27, `missed-call-ops` 15, `lead-scoring-service` 27, `phase2-automation` 14, `phase2-ui` 15, `phase2-privacy` 5, `phase2-extra` 5. Plus the opt-in scale probe. |
| Existing tests updated | `crm-migrations`, `aqi-ops-registration`, `scheduler-intervals`, `workforce-review-capabilities` (they list what exists: two migrations, three scheduler jobs, two read-only reviews). Nothing was loosened. |
| Typecheck | `tsc -p tsconfig.clean.json` and `tsc -p tsconfig.scripts.json`: 0 errors |
| Lint (`eslint .`) | 0 errors in anything Phase 2 touched. 2 warnings remain in `src/server/calendars/agent-booking.ts` and `native-availability.ts`, which this work did not change. |
| Clean build | `node scripts/build-clean.mjs --webpack` completed and wrote its build id; `/crm/calls` and `/crm/settings/lead-scoring` are in the route manifest. The build pins an embedded database and blank provider keys, so nothing hosted was contacted; its output is for checking the code, not for deploying. |
| Migration rehearsal | `scripts/rehearse-phase2-migrations.mjs`: sections A to E all ok (see `02-operations-and-rollout.md` section 5) |

Test-writing traps found along the way, kept so the next person does not repeat them: tests that mix the real clock and a simulated `now` (stamp `sent_at` yourself and pass `{ now }`); a sales rep cannot take over a conversation (use a manager); phone numbers must be unique across the whole process because a provider message id is unique across workspaces (`callerNumber()` in `tests/support/missed-calls.ts`).

## 4. Scale probe (opt-in, indicative only)

`CRM_PERF=1 PHASE2_PERF_CONTACTS=20000 PHASE2_PERF_CASES=8000 CRM_PERF_RUNS=3 npx vitest run tests/perf/phase2-scale.perf.test.ts` on embedded Postgres in memory: 20,000 contacts and 8,000 missed-call cases (two calls, two actions, three history rows each) in one workspace, next to a second workspace of noise. **These are not production latencies**; the useful signals are the plan shapes and how cost grows. Raw output: `.data/perf/phase2-scale.json`.

| Read or job | Median | Statements | Plan note |
| --- | --- | --- | --- |
| Cases: needs you, first page (owner) | 12 ms | 2 | sequential scan of the cases, small at this size |
| Cases: same list as a restricted sales rep (row-level security on) | 10 ms | 2 | same |
| One case with its calls, actions and history | 6 ms | 4 | primary-key lookup |
| Recovery dashboard, 30 / 90 days | 37 / 41 ms | 6 | scans cases and actions once per period |
| Contacts sorted by priority | 36 ms | 5 | 50 rows, 21 KB |
| Contacts: Hot only, sorted by priority | 14 ms | 5 | uses `contacts_priority_idx` |
| Lead priority dashboard | 16 ms | 4 | one pass over contacts |
| Recovery job, 20 due cases | 405 ms | 458 | about 20 statements per case; the sweep is included because the probe names a workspace |
| Scoring job, 40 queued leads | 534 ms | 973 | about 24 statements per lead |

What the probe found, and what changed: the recovery worker's safety-net sweep scanned recent inbound calls on every tick. It now runs on its own ten-minute heartbeat when the whole fleet is processed (a run for one workspace still sweeps at once) and reads through a new partial index, `crm_call_records_inbound_created_idx` (in 0085, dropped by its rollback). Lists are paged (25 rows) and the probe asserts every list and contact page stays under 400 KB.

Not measured: real network and connection-pool behaviour, a hosted database, concurrent users, or more than 20,000 contacts. The per-case and per-lead statement counts are the number to watch when the scheduler is first switched on.

## 5. Browser QA

Method: the isolated QA application (`node scripts/inbox-qa.mjs`, port 3270: embedded database, local sign-in, every provider send switch off, simulated AI provider on 3271), seeded by `scripts/run-inbox-qa-seed.mjs` then `scripts/run-phase2-qa-seed.mjs` (synthetic Harbor Home Services workspace: six missed-call cases including a withheld number, a no-consent caller, a held-back case, a drafted text and a failed follow-up; 16 scored contacts, one Hot, two set by hand). Signed in as the workspace owner through a local-only cookie bridge so no password passed through the chat. Real Chromium in the desktop app's browser pane.

| Screen | 375 px | 768 px | Desktop (1280 / 1440) |
| --- | --- | --- | --- |
| Calls, Missed-call recovery tab | no horizontal scroll, 0 axe violations | same | same, light and dark |
| Missed-call case drawer (approve, pause, escalate, close) | full-width sheet, 0 violations | not separately | 0 violations, light and dark |
| Recovery settings and readiness list | 0 violations; every checkbox row is 44 px or taller and labelled | 0 violations | 0 violations, light and dark |
| Contact page (missed-call banner, Lead priority card) | 0 violations | 0 violations | 0 violations, light and dark |
| Settings, Lead scoring | 0 violations | 0 violations | 0 violations, light and dark |
| Inbox list and open conversation, Customer details (Missed call and Lead priority cards) | 375 px wide after the fix below | 0 violations | 0 violations |
| Contacts: sort by Lead priority, optional Priority column | not run | not run | works; Hot first, then Warm by score (44, 44, 41, 41, 40) |
| Workflow editor: new triggers and steps | not run | not run | Missed call (with its kind filter), Follow-up allowed / failed, Missed caller wrote back, Missed call settled, Lead became hot, Lead label changed, Lead qualified enough to score; steps Re-check lead priority, Set lead priority, Check missed-call follow-up (in the CRM editor, no plan needed) |

Contrast: axe could not decide about 100 text/background pairs per page (translucent surfaces), so a script computed the ratio for every visible text node with backgrounds composited. 0 failing on the five Phase 2 screens in light and dark, apart from the disabled "Save settings" button (inactive controls are exempt). Console: no errors. One real interaction: approving the drafted text for a case with every send switch off recorded "Drafted text approved by Olivia Owner" and showed the text as **Queued**, never as sent.

Found and fixed in this pass: (1) the recovery banner printed a checklist label written as the good state ("The platform's sending switch is on.") beside a detail saying it was off; it now reads "Not yet: ..." (regression test added); (2) several inline links and the "Set the priority yourself" button were 17 to 20 px tall on a phone and are now 44 px there; (3) the readiness icons carried a label but no image role; (4) **a Phase 1 Inbox bug found on the way**: the filter-tab row on a phone is a scroll container that was not positioned, so a screen-reader-only span inside it sat outside the clip and widened the page to 477 px on a 375 px phone; the container is now `relative`.

Found and not fixed (outside Phase 2): the Inbox unread-count badge is white on the brand blue (3.49:1) in dark mode, below 4.5:1. It is a shared Phase 1 token.

Not browser-tested: the agency (support-session) variant of the CRM routes, the Inbox on a phone with the Customer details sheet open, and the contacts list on a phone.

## 6. Not proven, and why

1. **No real call, text, model answer or conversion.** No provider was contacted and no real person was a recipient. Every provider interaction is a recorder or a stub; the call tests feed normalized call events (the shape the existing Vapi and Retell adapters produce), not a captured live call.
2. **Telephony coverage.** Only Vapi and Retell assistants feed the detector (and calls a person logs). A plain business line (Twilio Voice, GoHighLevel call webhooks) has no adapter in the platform, so its missed calls are not seen. This needs the provider's webhook contract and a credential.
3. **AI call-back.** Not executable: no outbound-call credential or provider contract exists. The step is recorded as `blocked: no_outbound_call_capability` and the screens never show it as working.
4. **Carrier delivery.** A text is shown as sent only when the message row says so; what a carrier does afterwards (filtering, A2P registration, opt-out keywords the carrier itself handles) is unobserved.
5. **Language model quality.** The extraction path is proven with a stub that returns well-formed and hostile answers. Its accuracy on real customer messages, and its cost per workspace, are unknown. No held-out evaluation was possible without a provider key.
6. **Scheduler.** Never run against a real database. Idempotence, leases, fairness and the heartbeat are tested; the first live run's statement counts (section 4) are what to watch.
7. **Hosted database.** Migrations 0085 and 0086 were rehearsed on embedded Postgres only. The hosted database's own state (extensions, roles, existing rows, the live notification-kind constraint) is unverified until the dry run described in `02-operations-and-rollout.md`.
8. **Legal.** Whether a given business may text a caller who only phoned it depends on country and state; the product enforces consent, opt-out, quiet hours and business hours but does not decide lawfulness.
9. **Scale.** Indicative only (section 4).
10. **Browser coverage** gaps listed in section 5.
