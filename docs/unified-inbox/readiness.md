# Unified Inbox: readiness report

Branch `feat/unified-inbox` (worktree `.data/wt-unified-inbox`, based on master `22c68c2`). Written at the end of Phase 1; see
[README.md](./README.md) for how it works and [audit.md](./audit.md) for the Phase 0 findings this closes.

> **Nothing here has been pushed, deployed or run against production. Migration 0083 has not been applied to any hosted database. No real customer
> message was sent and no live provider or model was called at any point.** Everything below is verified in an embedded Postgres (PGlite) with
> simulated providers and a simulated AI model, in an isolated local QA workspace, unless a row says otherwise.

## 1. Verdict

**Not ready for production release. Ready for a staged rollout that starts with approvals.**

The inbox, its AI controls, the new workflow triggers and step, and the migration are complete and tested to the extent a simulated environment
allows: the whole suite is green apart from failures that already exist on master (section 4), type-check and lint are clean, and every one of the
18 acceptance scenarios passes against the real server code (seventeen in tests; scenario 17, mobile, in a browser). What stops a release is what no test here can prove:

1. **No live provider has been exercised.** GoHighLevel, Twilio, Meta WhatsApp and Resend sending and delivery callbacks are verified against recording
   stand-ins only (as they were before this work). Needs credentials and the owner's approval.
2. **Migration 0083 has not been rehearsed on a production-sized copy.** Its number was moved from 0082 to 0083 because `codex/client-ai-onboarding` already has a 0082 (different table); it must still be re-checked against every branch at merge time.
3. **The production scheduler was reported OFF** (Automation Studio state, 2026-10-22). The waiting notices and "went quiet" workflows run from the
   `inboxAttention` job, so they do nothing until the scheduler runs.
4. **It must be merged with master's uncommitted AI-workforce work** (same job-list tests, same `src/server/messaging/*` neighbourhood) and re-tested. **Rehearsed twice in a scratch worktree** (the second time with the rollout work, 2026-10-22): the same three files conflict and resolve trivially, and the merged tree passes with 0 failures (296 files, 4,706 tests). The real merge still waits for the workforce stream to commit (A1).

Recommended order: merge and re-run the suite → apply 0083 to a staging copy with provider writes off → verify with provider sandbox accounts → enable the scheduler → production, each step on your approval.

## 2. Estimates

| | Estimate | Basis |
| --- | --- | --- |
| Feature completion against the directive | **about 92%** (was 90%) | Everything in phases 1A to 1F is built, plus the per-workspace rollout with Super Admin controls (this pass). Not built, as the audit marked them out of scope: Website AI chat and social channels, attachments, per-user read state, websocket push, SLA timers and assignment rules for conversations; and search that stays fast in very large workspaces (row 1H). |
| Production readiness | **about 70%** (was 65%) | Closed since the last estimate: a workspace-by-workspace exposure that cannot interrupt messaging (the largest single risk reducer), a numbering collision that would have skipped a migration silently, a scheduler weakness that let one workspace silence the rest, the merge with master's pending work re-rehearsed with zero failures, a production build, and a 30,000-conversation measurement. Still open and each needing your approval or a resource that does not exist yet: staging, live provider verification, real Hermes verification, production-copy migration rehearsal, scheduler enablement, hosted load measurement. **None of the open items is something local work can close.** |

These are judgments, not measurements. The first is the share of the directive's feature list that exists and works; the second counts the
gates in section 9 that are closed.

## 3. Implementation checklist

| Phase | Item | Status |
| --- | --- | --- |
| 0 | Repository audit, risks, decisions | Done ([audit.md](./audit.md)) |
| 1A | Additive migration 0083 with rollback; lifecycle columns; `conversation_events`; revision and status stamps | Done; rehearsed down/up on populated data in tests |
| 1A | Ownership fence and AI pause enforced at queue and at dispatch; stale AI replies refused | Done |
| 1B | Views (10), sorts (3), keyset paging, search, bulk actions (no bulk send), select mode | Done |
| 1B | Thread: lifecycle events inline, resolve with outcome, archive, mark unread, retry with confirmation | Done |
| 1B | Responsive layout (phone, tablet, desktop), keyboard shortcuts, dark theme | Done; axe clean (section 6) |
| 1C | Assign person, choose AI employee (reply-capable roles only), pause, resume, take over, hand to teammate, handoff with notice | Done |
| 1C | AI summary and suggested reply: text only, never saved, never sent, rate and usage limited | Done |
| 1D | CRM context panel (deals, tasks, appointments, notes, calls, duplicates); create task, deal, note; lead status | Done |
| 1D | Honest channel health; web chat and phone shown as not available | Done |
| 1E | Triggers: assigned, resolved, urgent, handoff requested, went quiet; channel filters | Done |
| 1E | Workflow step "Update conversation" (resolve, reopen, priority, assign, assign to owner, pause AI); loop limit; publisher permissions | Done |
| 1E | Notifications: assigned, new unassigned inquiry, customer waiting (capped, de-duplicated); scheduler job | Done; scheduler must be enabled (section 1) |
| 1E | Core inbox without an Automation Studio plan | Done and tested |
| 1F | Tenant isolation and role tests, route tests, migration tests, acceptance walk | Done |
| 1F | Browser QA, accessibility, mobile | Done in the isolated QA workspace (section 6) |
| 1F | Production build | Passes: `npm run build:clean -- --webpack` (isolated output folder, every provider and hosted setting pinned off); type-check inside the build; the six `/api/inbox/*` routes and `/inbox` compile. The default Turbopack build could not resolve `next` from this worktree only because its `node_modules` is a junction to the main checkout; that is the worktree, not the code. |
| 1F | Performance at scale | Measured at 20% of the repo's perf dataset (about 600 conversations and 4,000 messages, `tests/perf`, embedded Postgres, 3 runs): every new read takes 9 to 25 ms (first page of a view 9 to 14, second page by cursor 23, counts for every tab 9, the change poll with counts 17); body search 80 ms, the same as the existing search (84 ms). In those plans the database read each candidate conversation's messages through the per-conversation index instead of using the trigram index `conversation_messages_body_trgm`; whether hosted Postgres ever picks the trigram index for this query shape is **unverified** (check `EXPLAIN` on staging; if it is never used, drop it from the migration, because it costs time on every message insert). **Indicative only**: in-process, no network, small data. Hosted Postgres was not measured. |
| 1G | Performance at 30,000 conversations | New opt-in probe `tests/perf/inbox-scale.perf.test.ts` (`CRM_PERF=1 npx vitest run tests/perf/inbox-scale.perf.test.ts`; one workspace with **30,000 conversations and 150,000 messages**, timestamps spread over 90 days, next to a 3,000-conversation workspace; real service functions as a member under row-level security; embedded Postgres, 5 runs, median): first page of a view **50 to 116 ms** (Priority sort 109, Needs attention 59, Assigned to AI 50, Resolved 54), second page by cursor 173, **counts for every tab 76 ms (owner) and 38 ms (sales rep)**, the **change poll 73 to 76 ms** with 100 conversations changed in the last minute (three statements), the scheduled "customer waiting" scan 31 ms (bounded writes: at most 10 notices and one summary per workspace), and **search 611 ms** (linear in the size of the workspace). Every list plan reads the workspace's conversations with a sequential scan; the cost grows with the workspace (at 2,000 conversations the same reads were 13 to 19 ms, search 51 ms). Pages are always at most 50 rows (about 31 KB). **Not measured: hosted Postgres, concurrency, the network.** At one tab polling every 5 s, 75 ms per poll is about 1.5 % of one database core per open tab; 50 people with two tabs each would be about 1.5 cores of poll work, which is the number to check under load on staging. |
| 1H | Search plan, and a change that did not work | Search combines five conditions (contact name, preview, subject, identities, message text) with `or`, so the planner reads every conversation of the workspace. **Where the time goes (measured, [performance-risks.md](./performance-risks.md)):** the trigram index for message text **is used** (1.8 ms with row-level security off), and the whole predicate costs 74 ms with it off; the other roughly 400 ms of the 611 is **row-level security on `conversation_messages`**, whose policy runs an `EXISTS` lookup for every message in the workspace before the text filter can narrow anything. A candidate policy with the same meaning (measured, not applied, needs a security review) makes an owner's message-text search 3 times faster and leaves restricted roles unchanged. **Tried and reverted (2026-10-22):** rewriting the five conditions as a `union` of five separately indexable queries made it **worse, about 2,700 ms** at 30,000 conversations, because under row-level security each branch is evaluated for every row of the workspace. Do not retry that shape without a plan from staging. Options for later: a stored search column per conversation (contact name, identities and the last messages' text, kept by trigger), or full-text search; both change the schema and need their own review. |

## 4. Test evidence

* `npx tsc --noEmit -p tsconfig.clean.json`: clean. `eslint` on every directory this branch touched: clean.
* Whole suite, run alone on a quiet machine, on the committed branch: **290 files, 4,621 tests passed, 7 failed, 1 skipped** (430 s). The 7 failures
  are exactly the set that already fails on master (next point). `unified-inbox-ui` (4 tests) was added after that run and was run on its own: it passes.
* `npm run typecheck:scripts` (the scripts project): clean.
* **Failures that are not from this branch.** Six files, seven tests, fail identically on master `22c68c2` (checked in a separate worktree at that commit):
  `appointments` (reminder dispatch), `aqi-answer-pipeline` (a `/website` navigation entry), `aqi-ops-registration` and `scheduler-intervals`
  (the AI workforce jobs master's working tree is adding), `crm-migrations` (two rollback tests blocked by the `ai_work_*` policies that depend on
  `app.permitted_orgs`), `rls-initplan-guard` (the same `ai_work_*` policies). The two job-list tests were updated for `inboxAttention`; the AI workforce
  jobs still make them fail until master's own edits to those tests are merged.
* New test files and their sizes: `unified-inbox-control` (33), `-list` (18), `-ai` (11), `-automation` (14), `-workflow-step` (14), `-migration` (9), `-routes` (8),
  `-sync-logic` (8), `-ui` (4), `-acceptance` (15): 134 tests. Existing suites were extended where the behaviour they cover changed (scheduler lists, fixtures, the perf harness).
* Two of those tests earned their keep during this phase: the migration rehearsal found the notification-constraint parsing bug, and the planner check behind
  `crm-performance` led to the partial sync index.

## 5. Acceptance scenarios

"Simulated" means a recording stand-in provider or a stub model; no scenario was verified live.

| # | Scenario | Evidence | How |
| --- | --- | --- | --- |
| 1 | A connected channel receives an inbound message | `unified-inbox-acceptance` 1-2 (ingest, duplicate delivery is one message) | Simulated provider webhook |
| 2 | Existing contact found, or a new one safely created | same: exact normalised identifier, a stranger gets a new contact | Simulated |
| 3 | Conversation appears in the inbox | `acceptance` 3, list tests, browser | Simulated + browser |
| 4 | A human opens it and replies | `acceptance` 4-5; control tests | Simulated provider |
| 5 | Provider acknowledges delivery status | `acceptance` 4-5: "sent" until the provider's own event, then "delivered" with its events | Simulated callbacks |
| 6 | An authorized AI employee is assigned | `acceptance` 6; the four internal roles are refused by the server | Simulated |
| 7 | The AI employee responds using permitted tools and context | `acceptance` 7; `messaging-responder` tests | **Stub model** (no model call) |
| 8 | A human takes over and no stale AI reply is sent | `acceptance` 8; fence tests in `control` (queue-time, dispatch-time, mid-generation) | Simulated |
| 9 | Transfer to another authorized team member | `acceptance` 9; browser hand-over | Simulated + browser |
| 10 | A CRM task or opportunity is linked | `acceptance` 10 (idempotent deal, events, panel) | Simulated |
| 11 | An authorized workflow reacts to an inbox event | `acceptance` 11; `unified-inbox-automation`; `-workflow-step` (resolve, assign, pause, loop limit); browser: published and turned on | CRM workflow engine, embedded DB |
| 12 | Two staff viewing the same thread get consistent updates | `acceptance` 12 (same change and revision, same thread); `sync-logic`; browser: a second tab updated in about 9 s | Simulated + browser |
| 13 | An unauthorized user cannot reach another tenant's conversation | `acceptance` 13; `unified-inbox-routes` (404 identical to "does not exist", list, sync, context, assist) | Real RLS, embedded DB |
| 14 | An unsubscribed workspace keeps the core inbox | `acceptance` 14 and the workflow tests (no plan throughout) | Real entitlement check |
| 15 | A disconnected provider produces an honest error | `acceptance` 15 (health state, plain refusal, blocked AI reply, nothing sent); browser "3 channels need attention" | Simulated |
| 16 | A failed delivery can be inspected and retried safely | `acceptance` 16; `control` (classification, one retry, unconfirmed needs acknowledgement, concurrency, opt-out still enforced) | Simulated provider |
| 17 | A mobile user can read, reply and open customer context | Browser at 375x812: thread, composer, Customer sheet, retry; no horizontal scroll; Send clear of the floating button | **Browser only** |
| 18 | An AI suggestion stays a draft until sent or approved | `acceptance` 18; `unified-inbox-ai`; browser: preview card, "AI-written, not verified" | Stub model + browser |

## 6. Browser QA (isolated QA workspace, embedded database, every send switch off, simulated AI provider)

Verified by hand in a real browser: list, tab counts and definitions; search and filters; select mode and a bulk resolve with an outcome (toast, counts,
Resolved view); thread header and controls for owner and support roles; hand-over to a teammate (the support user then sees only that conversation; the
"Nothing is assigned to you yet" wording for an empty restricted list is covered by `unified-inbox-ui`, not re-checked in the browser); Customer panel with the simulated summary; failed and unconfirmed sends with "Send again"; two tabs
staying in step; notifications; the workflow editor (new triggers listed, the new step's panel, publish and turn on with no plan); phone, tablet and
desktop widths; light and dark theme. axe-core (WCAG 2 A/AA, 2.1 A/AA, best practice) found and we fixed: contrast of "via provider" text inside tinted
bubbles and a loading skeleton with `aria-label` on a plain element; after the fixes the list and thread report no violations in light or dark.

Not done in a browser: the Viewer role (the QA pane's sign-out did not respond; the role's limits are covered by route and service tests), the
scheduler-driven notices (covered by tests; the QA server runs without the scheduler), and anything against a real provider or model.

## 7. Security and tenant-isolation findings

* **Isolation:** every read goes through row-level security as the signed-in person; a foreign, hidden or non-existent conversation all answer the same 404.
  `conversation_events` is read-only for the application role and bound to the conversation's visibility. Cross-tenant writes are refused by the composite foreign keys.
* **Found and fixed during this phase:** the notification-constraint rewrite in the migration and rollback could have allowed no notification kinds at all if the
  constraint printed in its other text form (it now reads both and refuses to proceed on a short read); the sync stamp would have matched a workspace's entire
  history on the first poll after deploy (old messages now stay NULL, the index is partial); a regex with a stray backspace character made hand-over lines read
  wrongly; opted-out customers counted as "waiting" (they no longer do); the legacy list silently changed its cap (restored).
* **Found and fixed in the release-hardening pass (2026-10-22):** (1) both attention scans ran for every workspace in one transaction, so one workspace's bad data would have rolled back everyone's notices on every
  tick; they now fall back to a workspace at a time and report the failing workspaces (4 of 6 new tests fail on the old code, e.g. the healthy workspace got no notice). (2) The scan read the 500 oldest waiting customers overall, so one large
  workspace could crowd the others out; each workspace now contributes at most the notice cap and the rows are taken a workspace at a time, and the "N customers are waiting" summary states the real total. (3) The migration number clashed
  with another branch's `0082` (see the numbering note in the README); the runner would have skipped the second file silently where a Supabase CLI ledger exists.
* **Workflow step:** cannot message a customer or resume AI replies; the publisher needs the matching inbox permission; changes carry the run's event depth; resolve is
  refused over a customer who wrote since the run started or a person who was asked to take over.
* **Open, low:** pause reasons are free text up to 120 characters in the event trail (ids and enums otherwise); they are exported with the workspace but are not redacted if a
  contact is erased on its own. Unread state is shared by everyone who can see a conversation (Phase 0 risk 4): two people opening a thread clear each other's unread mark.

## 8. Integration readiness matrix

| Integration | Built | Verified here | Live status | Needed |
| --- | --- | --- | --- | --- |
| GoHighLevel (SMS, email, WhatsApp via GHL) | Inbound, outbound, delivery events, health | Simulated provider | **Not verified live** | GHL test location, credentials, `GHL_WRITES_ENABLED` decision |
| Twilio (SMS, WhatsApp) | Same | Simulated | **Not verified live** | Account, registered sender, webhook URL, owner approval |
| Meta WhatsApp Cloud | Same, including the 24 h window and templates | Simulated | **Not verified live** | Business account, approved templates, owner approval |
| Resend (email) | Same | Simulated | **Not verified live** | Domain, API key, owner approval |
| Hermes AI employees (Sales Assistant, Appointment Setter) | Assignment, pause, fence, responder | Stub model | **Not verified live** | VPS dry run (separate gate), approval |
| AI assist (summary, suggested reply) | Via the shared `llmComplete` | Simulated provider | **Not verified live** | A configured AI provider |
| Native CRM (contacts, deals, tasks, notes, calls) | Context panel and four actions | Real services, embedded DB | Same code as production | None |
| CRM workflow engine / Automation Studio | Triggers, step, loop limit, plan boundary | Real engine, embedded DB | Same code as production; **scheduler reported OFF** | Enable the scheduler |
| Notifications | Three new kinds | Real | Same code as production | Migration 0083 |
| Website AI chat, social, phone as inbox channels | Shown as not available | n/a | **Not built** | Product decision |

## 9. Remaining issues and gates

| # | Severity | Item | Next step |
| --- | --- | --- | --- |
| 1 | **High** | No live provider or model verified (matrix above) | Credentials and approval; staging with sandbox accounts first |
| 2 | **High** | Migration 0083 unrehearsed on a production copy. Number collision with `codex/client-ai-onboarding`'s 0082 removed by renumbering (a shared prefix would be skipped silently by the runner where a Supabase CLI ledger exists) | Rehearse on a copy; re-check the number against every branch at merge |
| 3 | Medium | Production scheduler reported OFF: waiting notices and "went quiet" workflows are inert | Confirm and enable, per the Automation Studio runbook |
| 4 | Medium | Merge with master's uncommitted AI-workforce changes. **Rehearsed locally:** three files conflict (one line in `send.ts`, two job-list tests), all resolved; the merged tree passes type-check and the whole suite (293 files, 4,654 tests, 0 failed) | The workforce stream commits first, then the real merge; see [rollout-plan.md](./rollout-plan.md) |
| 5 | Medium | Seven pre-existing test failures on master | Not present in the merged tree, so by elimination fixed by master's pending workforce changes (not run on their own); needs those committed |
| 6 | Medium | Polling every 5 s per open tab (about 75 ms of database time per poll at 30,000 conversations, embedded engine); the poll's rate limit is **per process by design**, because a database-backed counter would turn every poll into a write (the shared limiter used elsewhere in the app, `consumeRateLimit`, is database-backed); no load measurement on hosted Postgres | Measure on staging under concurrent tabs; decide whether a per-instance limit is enough or a shared one is worth a write per poll |
| 6c | Medium | **Search grows with the number of messages in a workspace** (611 ms at 30,000 conversations and 150,000 messages, embedded engine): about 400 ms of it is row-level security on `conversation_messages`, not the predicate or the index (rows 1G and 1H, [performance-risks.md](./performance-risks.md)) | Check on staging. Options, none applied: a reviewed policy change (3 times faster for owners and admins), a default search without message text, or a stored search column. Not needed for workspaces of hundreds to a few thousand conversations |
| 6b | Info | **Per-workspace rollout built (local, unapplied).** Off by default; a Super Admin switches workspaces on one at a time; enforced on the server; the previous inbox is kept for every other workspace; audited; every in-flight item survives a switch-off ([workspace-rollout.md](./workspace-rollout.md)). The global switch `INBOX_DISABLED=true` remains and now returns workspaces to the previous screen. A changed variable applies on the next deployment | Decided: first deployment dark (`INBOX_DISABLED=true`), second deployment lifts the switch, then internal workspace, test clients, gradual customers (rollout plan, stage 6). Needs migration 0083 (the rollout table) and your choice of waves (D6) |
| 6c | Low | The previous inbox is kept alongside the new one for the duration of the rollout (two screens to maintain; the previous one is frozen at master `22c68c2`). A rollout change reaches other server instances within 3 s; an open tab keeps its screen until it next loads | Delete the previous screen after the last workspace has moved and held; see workspace-rollout.md section 9 |
| 7 | Low | Shared unread state; free-text pause reason in the trail | Per-user read state is a larger change; consider dropping the free text |
| 7b | Low | The Priority sort orders by a computed rank, so each list read scans the workspace's open conversations and sorts them before taking the first page. Measured: 109 ms at 30,000 conversations (embedded), 18 ms at 2,000 | Measure on staging with a realistic workspace; if needed, store the rank or index the common views |
| 8 | Low | Viewer role not exercised in a browser | Repeat when sign-out works in the QA pane |
| 9 | Info | The trigram index is built inside the migration transaction. Measured: the embedded engine uses it (1.8 ms for a message-text search with row-level security off) | Confirm on staging that hosted Postgres builds and uses it; on a large table build it `CONCURRENTLY` first (same name; the migration then finds it) |

## 10. Approvals this work is waiting on

Push the branch; apply 0083 anywhere hosted; enable any provider write switch; run any live provider or model check; enable the scheduler; deploy.
